'use strict';

/*
 * llm_batch — async bulk AI job system (plan §7 spec table).
 *
 * - llm_batch_submit(jobs[], model_class): creates office/batches/<batch_id>/jobs.json,
 *   returns the batch_id INSTANTLY; nobody blocks.
 * - A background worker processes jobs in the SAME server process:
 *     * ONLY if office/models.json defines a reachable OpenAI-compatible provider
 *       (its base_url env var set AND its key env var set / not required) does it
 *       call /chat/completions per job — 3 retries with exponential backoff;
 *       failures are quarantined to failed.jsonl (a batch never blocks the pipeline).
 *     * Semantic cache key = sha256(model + parameters + system prompt + input)
 *       (NEVER input alone — plan §10 item 10), checked under office/batches/.cache/.
 *     * Otherwise every job fails honestly with "no provider configured".
 * - Completion appends a batch_done ledger event; usage is logged to telemetry
 *   with source: provider_usage (the only budget-enforceable source).
 *
 * HONEST LIMIT: the worker lives inside this MCP server process — batches die
 * with the process. Documented in README.md.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('../store');
const { pickModelForClass } = require('./router');

const MAX_JOBS = 500;

function sanitizeId(s) {
  return String(s).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

/** Resolve the OpenAI-compatible endpoint for a model, or explain why it is unreachable. */
function resolveEndpoint(catalog, model) {
  const prov = (catalog.providers || []).find((p) => p.id === model.provider);
  if (!prov) {
    return { ok: false, reason: `no provider configured: provider '${model.provider}' is not defined in the catalog` };
  }
  const base = prov.base_url_env ? process.env[prov.base_url_env] : null;
  if (!base) {
    return { ok: false, reason: `no provider configured: environment variable ${prov.base_url_env} is not set` };
  }
  if (prov.key_env && !process.env[prov.key_env]) {
    return { ok: false, reason: `no provider configured: environment variable ${prov.key_env} is not set` };
  }
  return { ok: true, base, key: prov.key_env ? process.env[prov.key_env] : null };
}

function cacheKeyFor(modelRef, params, system, input) {
  // Semantic cache key: model + parameters + system prompt + input (plan §10 item 10).
  return crypto.createHash('sha256').update([modelRef, JSON.stringify(params || {}), system || '', input].join('\u241f')).digest('hex');
}

async function callChatCompletions(ep, model, job) {
  const url = ep.base.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: model.model_ref || model.id,
    messages: [
      ...(job.system ? [{ role: 'system', content: job.system }] : []),
      { role: 'user', content: job.input },
    ],
    ...(job.params || {}),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ep.key ? { authorization: `Bearer ${ep.key}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return {
    result: (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) ?? null,
    usage: data.usage
      ? { tokens_in: data.usage.prompt_tokens ?? null, tokens_out: data.usage.completion_tokens ?? null }
      : null,
  };
}

async function processJob(job, doc, model, ep, failedPath) {
  const cacheFile = path.join(store.CACHE_DIR, cacheKeyFor(model.model_ref || model.id, job.params, job.system, job.input) + '.json');
  try {
    if (fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      job.status = 'done';
      job.result = cached.result;
      job.usage = cached.usage || null;
      job.from_cache = true;
      return;
    }
  } catch (_) { /* corrupt cache entry -> treat as miss */ }

  const started = Date.now();
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { result, usage } = await callChatCompletions(ep, model, job);
      const latencyMs = Date.now() - started;
      try {
        fs.writeFileSync(cacheFile, JSON.stringify({
          key: path.basename(cacheFile, '.json'), model: model.id, ts: new Date().toISOString(),
          params: job.params || {}, system: job.system || '', input: job.input, result, usage,
        }));
      } catch (_) { /* cache write failure must not fail the job */ }
      job.status = 'done';
      job.result = result;
      job.usage = usage;
      job.latency_ms = latencyMs;
      if (usage && (usage.tokens_in != null || usage.tokens_out != null)) {
        store.appendTelemetryLine({
          event_id: crypto.randomUUID(),
          ts: new Date().toISOString(),
          role: 'llm_batch',
          task_id: `${doc.batch_id}/${job.job_id}`,
          model: model.id,
          tokens_in: usage.tokens_in,
          tokens_out: usage.tokens_out,
          tokens_total: (usage.tokens_in || 0) + (usage.tokens_out || 0),
          latency_ms: latencyMs,
          source: 'provider_usage',
          outcome: null,
          task_class: doc.model_class,
        });
      }
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        // exponential backoff: 250ms, 500ms (+ jitter)
        await new Promise((r) => setTimeout(r, 250 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 100)));
      }
    }
  }
  job.status = 'failed';
  job.error = String((lastErr && lastErr.message) || lastErr);
  try {
    fs.appendFileSync(failedPath, JSON.stringify({ ts: new Date().toISOString(), job_id: job.job_id, error: job.error, attempts: 3 }) + '\n');
  } catch (_) { /* quarantine write best-effort */ }
}

async function runBatch(doc, dir, catalog) {
  store.ensureSubdirs();
  const failedPath = path.join(dir, 'failed.jsonl');
  const model = catalog.models.find((m) => m.id === doc.model) || {};
  const ep = resolveEndpoint(catalog, model);

  if (!ep.ok) {
    // Honest no-provider path: every job fails with the precise reason.
    for (const j of doc.jobs) {
      j.status = 'failed';
      j.error = ep.reason;
    }
    try {
      fs.writeFileSync(failedPath, doc.jobs.map((j) => JSON.stringify({ ts: new Date().toISOString(), job_id: j.job_id, error: j.error, attempts: 0 })).join('\n') + '\n');
    } catch (_) { /* best effort */ }
    doc.status = 'failed';
    doc.completed_ts = new Date().toISOString();
    saveDoc(dir, doc);
    await store.appendEvent({
      actor: 'rc', action: 'batch_done', batch_id: doc.batch_id, status: 'failed',
      reason: 'no_provider_configured', detail: ep.reason,
      jobs_total: doc.jobs.length, jobs_done: 0, jobs_failed: doc.jobs.length, model: doc.model,
    });
    return;
  }

  const maxConcurrent = Math.max(1, Number(catalog.max_concurrent) || 2);
  let idx = 0;
  const worker = async () => {
    while (idx < doc.jobs.length) {
      const job = doc.jobs[idx++];
      await processJob(job, doc, model, ep, failedPath);
    }
  };
  await Promise.all(Array.from({ length: Math.min(maxConcurrent, doc.jobs.length) }, worker));

  const done = doc.jobs.filter((j) => j.status === 'done').length;
  const failed = doc.jobs.length - done;
  doc.status = done === doc.jobs.length ? 'complete' : done > 0 ? 'partial' : 'failed';
  doc.completed_ts = new Date().toISOString();
  saveDoc(dir, doc);
  await store.appendEvent({
    actor: 'rc', action: 'batch_done', batch_id: doc.batch_id, status: doc.status,
    jobs_total: doc.jobs.length, jobs_done: done, jobs_failed: failed, model: doc.model,
  });
}

function saveDoc(dir, doc) {
  fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify(doc, null, 2) + '\n');
}

async function submit(args) {
  const { jobs, model_class } = args;
  const reasons = [];
  if (!Array.isArray(jobs) || jobs.length < 1) reasons.push("'jobs' must be an array with at least 1 job");
  if (Array.isArray(jobs) && jobs.length > MAX_JOBS) reasons.push(`'jobs' is capped at ${MAX_JOBS} per batch`);
  if (!store.TASK_CLASSES.includes(model_class)) reasons.push(`'model_class' must be one of ${store.TASK_CLASSES.join('|')}`);
  if (reasons.length) return { ok: false, error: 'invalid llm_batch_submit input', reasons };

  const normalized = [];
  jobs.forEach((j, i) => {
    const obj = typeof j === 'string' ? { input: j } : j || {};
    const jobId = sanitizeId(obj.job_id) || 'j' + (i + 1);
    if (typeof obj.input !== 'string' || !obj.input.trim()) {
      reasons.push(`jobs[${i}] ('${jobId}') must carry a non-empty string 'input'`);
      return;
    }
    if (obj.system !== undefined && typeof obj.system !== 'string') {
      reasons.push(`jobs[${i}] ('${jobId}') 'system' must be a string when provided`);
      return;
    }
    if (obj.params !== undefined && (!(obj.params instanceof Object) || Array.isArray(obj.params))) {
      reasons.push(`jobs[${i}] ('${jobId}') 'params' must be an object when provided`);
      return;
    }
    normalized.push({ job_id: jobId, system: obj.system || '', input: obj.input, params: obj.params || {}, status: 'pending' });
  });
  if (reasons.length) return { ok: false, error: 'invalid jobs payload', reasons };

  const catalog = store.loadCatalog();
  const selected = pickModelForClass(catalog.models, model_class);
  if (!selected) {
    return { ok: false, error: `no model in the catalog satisfies class ${model_class}`, catalog_source: catalog.source };
  }

  store.ensureSubdirs();
  const batchId = 'B-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const dir = path.join(store.BATCHES_DIR, batchId);
  fs.mkdirSync(dir, { recursive: true });
  const doc = {
    schema_version: store.SCHEMA_VERSION,
    batch_id: batchId,
    model_class,
    model: selected.id,
    status: 'pending',
    created_ts: new Date().toISOString(),
    jobs: normalized,
  };
  saveDoc(dir, doc);

  // Fire-and-forget worker: submit NEVER blocks on network I/O.
  setTimeout(() => {
    runBatch(doc, dir, catalog).catch((err) => {
      process.stderr.write(`[vcnp-office-mcp] batch ${batchId} worker crashed: ${err && err.message}\n`);
    });
  }, 0);

  return {
    ok: true,
    batch_id: batchId,
    model: selected.id,
    model_class,
    jobs: normalized.length,
    status: 'pending',
    note: 'async — poll llm_batch_status(batch_id); completion appends a batch_done ledger event',
  };
}

function status(args) {
  const { batch_id } = args;
  if (typeof batch_id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(batch_id)) {
    return { ok: false, error: "'batch_id' must be the alphanumeric id returned by llm_batch_submit" };
  }
  const dir = path.join(store.BATCHES_DIR, batch_id);
  const jobsPath = path.join(dir, 'jobs.json');
  if (!fs.existsSync(jobsPath)) {
    return { ok: false, error: `unknown batch_id '${batch_id}' — nothing under office/batches/${batch_id}/` };
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
  } catch (err) {
    return { ok: false, error: `jobs.json for '${batch_id}' is unreadable: ${err.message}` };
  }
  let failedLines = [];
  const failedPath = path.join(dir, 'failed.jsonl');
  if (fs.existsSync(failedPath)) {
    failedLines = fs.readFileSync(failedPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch (_) { return { error: l }; }
    });
  }
  return {
    ok: true,
    batch_id: doc.batch_id,
    status: doc.status,
    model: doc.model,
    model_class: doc.model_class,
    created_ts: doc.created_ts,
    completed_ts: doc.completed_ts || null,
    jobs_total: doc.jobs.length,
    jobs_done: doc.jobs.filter((j) => j.status === 'done').length,
    jobs_failed: doc.jobs.filter((j) => j.status === 'failed').length,
    failures: failedLines.map((f) => ({ job_id: f.job_id, error: f.error })),
    jobs: doc.jobs.map((j) => ({
      job_id: j.job_id, status: j.status, from_cache: !!j.from_cache,
      error: j.error || undefined, result_preview: typeof j.result === 'string' ? j.result.slice(0, 120) : undefined,
    })),
  };
}

const defs = [
  {
    name: 'llm_batch_submit',
    description:
      'Submit bulk AI jobs asynchronously (plan §7). Creates office/batches/<batch_id>/jobs.json and returns ' +
      'the batch_id INSTANTLY. A background worker calls the configured OpenAI-compatible provider per job ' +
      '(3 retries, exponential backoff, semantic cache sha256(model+params+system+input)); without a reachable ' +
      'provider every job fails honestly with "no provider configured". Completion appends batch_done.',
    inputSchema: {
      type: 'object',
      properties: {
        jobs: {
          type: 'array',
          minItems: 1,
          items: {
            type: ['object', 'string'],
            properties: {
              job_id: { type: 'string' },
              system: { type: 'string' },
              input: { type: 'string' },
              params: { type: 'object' },
            },
          },
        },
        model_class: { enum: store.TASK_CLASSES },
      },
      required: ['jobs', 'model_class'],
    },
    handler: async (args) => submit(args),
    format: (r) =>
      `Batch ${r.batch_id} submitted (${r.jobs} jobs -> ${r.model}, class ${r.model_class}) — status: pending. ` +
      'Poll llm_batch_status; completion appends batch_done to the ledger.',
  },
  {
    name: 'llm_batch_status',
    description: 'Report the status of a submitted batch: per-job states, failure reasons from failed.jsonl, cache hits.',
    inputSchema: {
      type: 'object',
      properties: { batch_id: { type: 'string' } },
      required: ['batch_id'],
    },
    handler: async (args) => status(args),
    format: (r) => {
      const lines = [
        `Batch ${r.batch_id}: ${r.status} — done ${r.jobs_done}/${r.jobs_total}, failed ${r.jobs_failed}` +
          `${r.completed_ts ? `, completed ${r.completed_ts}` : ''}`,
      ];
      for (const f of r.failures) lines.push(`FAILED ${f.job_id}: ${f.error}`);
      for (const j of r.jobs) {
        if (j.status !== 'done' || j.from_cache) {
          lines.push(`${j.job_id}: ${j.status}${j.from_cache ? ' (cache hit)' : ''}`);
        }
      }
      return lines.join('\n');
    },
  },
];

module.exports = { defs };
