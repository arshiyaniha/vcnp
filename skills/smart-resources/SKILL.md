---
name: smart-resources
description: Model routing and budget decisions. Use when choosing a model or tier for a task, escalating or de-escalating after QA verdicts, enforcing token budgets, offloading bulk work to llm_batch, or applying the cost circuit breaker.
---

# Smart Resources — Routing Playbook

Policy owner: Resource Controller. Sources: plan §8 (routing) · §10 (economy).

## Routing matrix C0–C4 (Planner sets per task; RC enforces)

| Task Class | Examples | Default Tier | Rationale |
|---|---|---|---|
| **C0 Spike** | time-boxed approach discovery BEFORE C3/C4 — hard cap ~5k tokens, NO deliverable; only output = written decision in the Memory Bank | Economy / local | Prevents burning premium budget on the wrong path |
| **C1 Trivial** | boilerplate, formatting, renames, translations | Economy / local | Cost-dominant |
| **C2 Standard** | components, clear-spec bugfixes, content | Standard | Balanced |
| **C3 Complex** | architecture, gnarly debugging, security review | Premium | Quality-dominant |
| **C4 Wide-context** | repo-wide analysis, big refactors | Large-context model | Capacity-dominant |

**C1 fast-path:** trivial tasks skip the full cycle — the CEO dispatches directly to an executor on local/economy with a tiny hard budget cap and an automated check.

## ONE selection rule
Pick the CHEAPEST model whose expected quality ≥ the task's quality bar — an auditable constrained minimum.
- `value(model) = expected_quality / (cost_per_task × latency_penalty)` — RANKING ONLY (dashboard leaderboard), NEVER for decisions.
- Cold-start quality: Bayesian-smoothed approval rate seeded by `quality_tier`: `q̂ = (approvals + a) / (approvals + rejections + a + b)` — the first 20 tasks ride priors, not randomness.
- Local-first draft, premium-verify: for suitable C3 tasks, draft on economy/local and spend premium tokens ONLY on review/refinement.

## Escalation ladder (REASSIGN — never swap a live session's model)
- QA rejects ×2 on a task → the Orchestrator REASSIGNS it to a higher-tier MODE.
- Rejects ×3 → mandatory premium-mode review.
- Log every bump as a lesson in the Memory Bank.

## De-escalation (wired, anti-oscillation)
- Aggregate QA verdicts PER model+class PAIR from `office/telemetry.jsonl` — never across classes (a C1 star does not become a C3 qualifier).
- At ≥95% approval across the last 20 verdicts of that pair → apply the downgrade AUTONOMOUSLY, log a `tier_downgrade` event, notify the CEO (may veto; revert = one git commit).
- After ANY tier flip: a cooldown of ≥5 verdicts at the new tier passes before another flip. The normal ladder still catches bad downgrades (2 rejects → back up).

## Cost-truth policy
- Agents CANNOT count their own tokens. Every telemetry line carries a `source` field:
  - `provider_usage` — authoritative, from llm_batch API responses; the only per-call budget enforcer.
  - `ide_export` — authoritative for session spend.
  - `estimated` — agent self-report; display SEPARATELY, labeled «تخمینی»; NEVER enforce budgets on it.
- Budget enforcement uses ONLY `provider_usage` / `ide_export`. Without the tag, telemetry is decoration, not instrumentation.

## llm_batch async jobs
- `llm_batch.submit(jobs[], model_class)` returns a `batch_id` INSTANTLY — NOBODY blocks.
- Results land in `office/batches/<batch_id>/` as files + a `batch_done` ledger event; the Orchestrator picks it up on its next `board_read`.
- Retries: 3 attempts per item with exponential backoff; failures quarantined to `failed.jsonl` — a batch NEVER blocks the pipeline.
- Multiple batches allowed; a global `max_concurrent` cap protects provider rate limits.
- Cost accumulates per batch from provider `usage` fields, logged with `source: provider_usage`.
- Semantic cache key = hash(**model + parameters + system prompt + input**) — NEVER input alone, or a different model silently returns another model's cached answer.

## Cost circuit breaker
- Maintain an absolute spend ceiling per session AND per milestone.
- At 80% consumed → log `budget_warning`.
- At 100% consumed → work HALTS; escalate to the CEO.
- Any overspend beyond a task budget requires RC approval BEFORE continuing.
