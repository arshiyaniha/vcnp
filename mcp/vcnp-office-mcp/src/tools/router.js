'use strict';

/*
 * route_model — Resource Controller routing policy (plan §7/§8).
 *
 * ONE auditable rule: pick the CHEAPEST model whose quality_tier >= the
 * task-class quality bar. C0/C1 -> tier >= 1, C2 -> tier >= 2, C3 -> tier >= 3,
 * C4 -> the largest-context model (capacity-dominant), tiebreak cheapest.
 *
 * Reads office/models.json when present, else built-in defaults. Escalation /
 * de-escalation counters are derived from QA verdicts in telemetry.jsonl,
 * counted PER model+class PAIR (never across classes).
 */

const store = require('../store');

/** Quality bar per task class (routing matrix, plan §8). */
const CLASS_BAR = { C0: 1, C1: 1, C2: 2, C3: 3 };

const blendedPrice = (m) => (Number(m.in_price) || 0) + (Number(m.out_price) || 0);

/**
 * Pick the model for a class from a catalog.models array.
 * Exported for reuse by llm_batch (full-control layer, plan §7).
 */
function pickModelForClass(models, taskClass) {
  if (!Array.isArray(models) || models.length === 0) return null;
  if (taskClass === 'C4') {
    // Capacity-dominant: largest context window wins; tiebreak cheapest.
    return [...models].sort((a, b) => (b.ctx || 0) - (a.ctx || 0) || blendedPrice(a) - blendedPrice(b))[0];
  }
  const bar = CLASS_BAR[taskClass];
  if (bar === undefined) return null;
  const candidates = models.filter((m) => (Number(m.quality_tier) || 1) >= bar);
  if (!candidates.length) return null;
  candidates.sort((a, b) => blendedPrice(a) - blendedPrice(b) || (b.ctx || 0) - (a.ctx || 0));
  return candidates[0];
}

/**
 * QA verdict aggregates per model+class pair from telemetry.jsonl.
 * Only entries carrying outcome approved|rejected AND a task_class count.
 */
function verdictCounters() {
  const pairs = new Map();
  for (const l of store.readTelemetry()) {
    if ((l.outcome !== 'approved' && l.outcome !== 'rejected') || !l.model || !l.task_class) continue;
    const key = `${l.model}|${l.task_class}`;
    let p = pairs.get(key);
    if (!p) {
      p = { model: l.model, task_class: l.task_class, verdicts: [] };
      pairs.set(key, p);
    }
    p.verdicts.push(l.outcome);
  }
  const out = [];
  for (const p of pairs.values()) {
    const last20 = p.verdicts.slice(-20); // per-pair window, never across classes
    const approvals = last20.filter((v) => v === 'approved').length;
    const rejections = last20.length - approvals;
    out.push({
      model: p.model,
      task_class: p.task_class,
      verdicts_in_window: last20.length,
      approvals,
      rejections,
      approval_rate: last20.length ? Math.round((approvals / last20.length) * 1000) / 10 : null,
      escalation_recommended: rejections >= 2, // ladder: rejects x2 -> reassign higher tier
      deescalation_candidate: last20.length >= 5 && approvals / last20.length >= 0.95,
      note: 'advisory counters only; autonomous flips additionally require the anti-oscillation cooldown (plan §8)',
    });
  }
  return out;
}

async function routeModel(args) {
  const { task_class } = args;
  if (!store.TASK_CLASSES.includes(task_class)) {
    return { ok: false, error: `'task_class' must be one of ${store.TASK_CLASSES.join('|')}` };
  }
  const catalog = store.loadCatalog();
  const selected = pickModelForClass(catalog.models, task_class);
  if (!selected) {
    return {
      ok: false,
      error: `no model in the catalog satisfies the quality bar for class ${task_class}`,
      catalog_source: catalog.source,
    };
  }
  const rationale =
    task_class === 'C4'
      ? 'C4 is capacity-dominant: largest context window, cheapest on ties'
      : `cheapest model with quality_tier >= ${CLASS_BAR[task_class]} (bar for ${task_class})`;
  return {
    ok: true,
    task_class,
    quality_bar_tier: task_class === 'C4' ? 'largest-ctx' : CLASS_BAR[task_class],
    selected_model: {
      id: selected.id,
      provider: selected.provider || null,
      model_ref: selected.model_ref || selected.id,
      quality_tier: selected.quality_tier || 1,
      ctx: selected.ctx || null,
      in_price: selected.in_price ?? null,
      out_price: selected.out_price ?? null,
    },
    rationale,
    catalog_source: catalog.source,
    escalation_deescalation_counters: verdictCounters(),
    advisory_note:
      'route_model ADVISES mode selection (dynamic layer) — it cannot change the calling session\'s model; ' +
      'escalation means REASSIGNING the task to a stronger mode (plan §7)',
  };
}

const defs = [
  {
    name: 'route_model',
    description:
      'Ask the Resource Controller policy which model fits a task class: cheapest model whose quality_tier ' +
      'meets the class bar (C0/C1->1, C2->2, C3->3, C4->largest ctx). Uses office/models.json when present, ' +
      'else built-in defaults. Includes escalation/de-escalation counters derived from telemetry QA verdicts ' +
      'per model+class pair.',
    inputSchema: {
      type: 'object',
      properties: { task_class: { enum: store.TASK_CLASSES } },
      required: ['task_class'],
    },
    handler: async (args) => routeModel(args),
    format: (r) => {
      const m = r.selected_model;
      const lines = [
        `${r.task_class} -> ${m.id} (tier ${m.quality_tier}, ctx ${m.ctx ?? '?'}, $${m.in_price}/$${m.out_price} per 1M in/out)`,
        `Rationale: ${r.rationale} | catalog: ${r.catalog_source}`,
      ];
      for (const c of r.escalation_deescalation_counters) {
        lines.push(
          `Verdicts ${c.model}+${c.task_class}: ${c.approvals}/${c.verdicts_in_window} approved (${c.approval_rate}%)` +
            `${c.escalation_recommended ? ' [ESCALATION recommended]' : ''}${c.deescalation_candidate ? ' [de-escalation candidate]' : ''}`
        );
      }
      return lines.join('\n');
    },
  },
];

module.exports = { defs, pickModelForClass, CLASS_BAR, verdictCounters };
