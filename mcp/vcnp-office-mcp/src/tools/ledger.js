'use strict';

/*
 * Ledger tools — plan §6.2: ledger_log / event_log / telemetry_read.
 *
 * Cost-truth policy (plan §8): agents CANNOT count their own tokens. Every
 * telemetry line carries a `source`:
 *   - provider_usage : authoritative (llm_batch API responses) — budget-enforceable
 *   - ide_export     : authoritative (IDE/provider usage imports) — budget-enforceable
 *   - estimated      : agent self-report — recorded but FLAGGED, never enforced
 * ledger_log enforces source ∈ provider_usage|ide_export|estimated and flags
 * 'estimated' honestly in the result text.
 */

const crypto = require('crypto');
const store = require('../store');

async function ledgerLog(args) {
  const { role, task_id, tokens_used, source } = args;
  const reasons = [];
  if (typeof role !== 'string' || !role.trim()) reasons.push("'role' must be a non-empty string");
  if (!Number.isInteger(tokens_used) || tokens_used <= 0) {
    reasons.push("'tokens_used' must be an integer > 0");
  }
  if (!store.LEDGER_SOURCES.includes(source)) {
    reasons.push(`'source' must be one of ${store.LEDGER_SOURCES.join('|')} (cost-truth policy, plan §8)`);
  }
  if (args.latency_ms !== undefined && !Number.isFinite(args.latency_ms)) {
    reasons.push("'latency_ms' must be a number when provided");
  }
  if (reasons.length) return { ok: false, error: 'invalid ledger_log input', reasons };

  const flagged = source === 'estimated';
  return store.withLock(async () => {
    const r = await store.appendEventLocked({
      actor: role,
      action: 'ledger_entry',
      task_id: task_id || null,
      tokens_used,
      source,
      model: args.model || null,
      latency_ms: args.latency_ms ?? null,
      outcome: args.outcome || null,
      task_class: args.task_class || null,
    });
    if (r.duplicate) return { ok: true, duplicate: true, event_id: r.event_id };
    store.appendTelemetryLine({
      event_id: r.event.event_id,
      ts: r.event.ts,
      role,
      task_id: task_id || null,
      model: args.model || null,
      tokens_in: null,
      tokens_out: null,
      tokens_total: tokens_used,
      latency_ms: args.latency_ms ?? null,
      source,
      outcome: args.outcome || null,
      task_class: args.task_class || null,
    });
    return {
      ok: true,
      event_id: r.event.event_id,
      source,
      flagged_estimated: flagged,
      note: flagged
        ? 'source=estimated — recorded but FLAGGED («تخمینی»); budget enforcement honors ONLY provider_usage and ide_export'
        : 'authoritative source — counts toward budget enforcement',
    };
  });
}

async function eventLog(args) {
  const { actor, action, detail } = args;
  const reasons = [];
  if (typeof actor !== 'string' || !actor.trim()) reasons.push("'actor' must be a non-empty string");
  if (typeof action !== 'string' || !action.trim()) reasons.push("'action' must be a non-empty string");
  if (reasons.length) return { ok: false, error: 'invalid event_log input', reasons };
  const fields = { actor, action };
  if (detail !== undefined) {
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) Object.assign(fields, detail);
    else fields.detail = detail;
  }
  const r = await store.appendEvent(fields);
  return { ok: true, event_id: r.event.event_id, duplicate: r.duplicate };
}

function telemetryRead() {
  const lines = store.readTelemetry();
  const catalog = store.loadCatalog();
  const prices = new Map(catalog.models.map((m) => [m.id, m]));

  const agg = {
    calls: lines.length,
    tokens_total: 0,
    est_cost_usd: 0,
    cost_approx_lines: 0,
    unpriced_tokens: 0,
    by_source: {},
    by_role: {},
    by_model: {},
  };
  for (const s of store.LEDGER_SOURCES) agg.by_source[s] = { calls: 0, tokens: 0 };

  for (const l of lines) {
    const tok = Number(l.tokens_total) || (Number(l.tokens_in) || 0) + (Number(l.tokens_out) || 0);
    agg.tokens_total += tok;
    const src = store.LEDGER_SOURCES.includes(l.source) ? l.source : 'estimated';
    agg.by_source[src].calls += 1;
    agg.by_source[src].tokens += tok;

    const role = l.role || 'unknown';
    if (!agg.by_role[role]) agg.by_role[role] = { calls: 0, tokens: 0 };
    agg.by_role[role].calls += 1;
    agg.by_role[role].tokens += tok;

    if (!l.model) continue;
    let m = agg.by_model[l.model];
    if (!m) {
      m = agg.by_model[l.model] = {
        calls: 0, tokens: 0, est_cost_usd: 0, avg_latency_ms: null,
        latencies: [], approvals: 0, rejections: 0, by_class: {},
      };
    }
    m.calls += 1;
    m.tokens += tok;
    if (typeof l.latency_ms === 'number') m.latencies.push(l.latency_ms);
    if (l.outcome === 'approved') m.approvals += 1;
    if (l.outcome === 'rejected') m.rejections += 1;
    if (l.task_class) {
      const c = m.by_class[l.task_class] || (m.by_class[l.task_class] = { calls: 0, approvals: 0, rejections: 0 });
      c.calls += 1;
      if (l.outcome === 'approved') c.approvals += 1;
      if (l.outcome === 'rejected') c.rejections += 1;
    }
    const price = prices.get(l.model);
    if (price) {
      let cost;
      if (l.tokens_in != null || l.tokens_out != null) {
        cost = ((l.tokens_in || 0) / 1e6) * price.in_price + ((l.tokens_out || 0) / 1e6) * price.out_price;
      } else {
        // No in/out split recorded — midpoint heuristic, flagged approximate.
        cost = (tok * ((price.in_price + price.out_price) / 2)) / 1e6;
        agg.cost_approx_lines += 1;
      }
      m.est_cost_usd += cost;
      agg.est_cost_usd += cost;
    } else {
      agg.unpriced_tokens += tok;
    }
  }

  for (const m of Object.values(agg.by_model)) {
    if (m.latencies.length) {
      m.avg_latency_ms = Math.round(m.latencies.reduce((a, b) => a + b, 0) / m.latencies.length);
    }
    delete m.latencies;
    m.est_cost_usd = Math.round(m.est_cost_usd * 1e6) / 1e6;
  }
  agg.est_cost_usd = Math.round(agg.est_cost_usd * 1e6) / 1e6;

  return {
    ok: true,
    catalog_source: catalog.source,
    ...agg,
    budget_authoritative_tokens: agg.by_source.provider_usage.tokens + agg.by_source.ide_export.tokens,
    note:
      'est cost for lines without an in/out token split uses the midpoint of in/out price — APPROXIMATE («تخمینی»). ' +
      'Budget enforcement counts ONLY provider_usage + ide_export sources (plan §8 cost-truth).',
  };
}

const defs = [
  {
    name: 'ledger_log',
    description:
      'Record real token usage per role per task. source MUST be provider_usage|ide_export|estimated; ' +
      "'estimated' is recorded but flagged and never used for budget enforcement (cost-truth, plan §8). " +
      'Writes both a ledger event and an office/telemetry.jsonl line.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string' },
        task_id: { type: 'string' },
        tokens_used: { type: 'integer', exclusiveMinimum: 0 },
        source: { enum: store.LEDGER_SOURCES },
        model: { type: 'string' },
        latency_ms: { type: 'number' },
        outcome: { enum: ['approved', 'rejected', null] },
        task_class: { enum: [...store.TASK_CLASSES, null] },
      },
      required: ['role', 'task_id', 'tokens_used', 'source'],
    },
    handler: async (args) => ledgerLog(args),
    format: (r) =>
      `Ledger entry ${r.event_id} recorded (source: ${r.source})${r.flagged_estimated ? ' — FLAGGED «تخمینی»' : ''}`,
  },
  {
    name: 'event_log',
    description:
      'Append a generic audit event to the ledger (actor + action + optional detail object merged into the event).',
    inputSchema: {
      type: 'object',
      properties: {
        actor: { type: 'string' },
        action: { type: 'string' },
        detail: { type: 'object' },
      },
      required: ['actor', 'action'],
    },
    handler: async (args) => eventLog(args),
    format: (r) => `Event ${r.action} appended (${r.event_id})${r.duplicate ? ' — DUPLICATE skipped' : ''}`,
  },
  {
    name: 'telemetry_read',
    description:
      'Aggregate office/telemetry.jsonl: per-role and per-model totals of tokens, estimated cost (price table ' +
      'from office/models.json), average latency, approval/rejection counts, per-source authoritative vs estimated split.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => telemetryRead(),
    format: (r) => {
      const lines = [
        `Telemetry: ${r.calls} calls, ${r.tokens_total} tokens total (catalog: ${r.catalog_source})`,
        `By source: provider_usage=${r.by_source.provider_usage.tokens}, ide_export=${r.by_source.ide_export.tokens}, estimated=${r.by_source.estimated.tokens} (flagged «تخمینی»)`,
        `Budget-authoritative tokens: ${r.budget_authoritative_tokens} | est cost: $${r.est_cost_usd}` +
          (r.unpriced_tokens ? ` | unpriced tokens: ${r.unpriced_tokens}` : ''),
      ];
      for (const [role, v] of Object.entries(r.by_role)) lines.push(`Role ${role}: ${v.calls} calls, ${v.tokens} tokens`);
      for (const [model, v] of Object.entries(r.by_model)) {
        lines.push(
          `Model ${model}: ${v.calls} calls, ${v.tokens} tokens, $${v.est_cost_usd}, avg ${v.avg_latency_ms ?? '-'}ms, ` +
            `QA approved ${v.approvals}/rejected ${v.rejections}`
        );
      }
      return lines.join('\n');
    },
  },
];

module.exports = { defs, telemetryRead };
