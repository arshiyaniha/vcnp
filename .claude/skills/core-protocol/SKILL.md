---
name: core-protocol
description: VCNP handoff envelope rules. Use whenever composing, sending, validating, or receiving work between office roles - building a Task Brief, writing a Result Report, setting board status, or wiring envelope validation.
---

# VCNP Handoff Protocol

Normative source: [`core/protocol.md`](../../../core/protocol.md). Machine contract: [`references/envelope-schema.json`](references/envelope-schema.json).

## Build a Task Brief (Orchestrator → Executor)
1. Fill every required field exactly per this schema example:

```json
{
  "task_id": "T-007",
  "title": "Build pricing page",
  "task_class": "C2",
  "context_refs": ["docs/PRD.md#pricing", "assets/design-system.md"],
  "acceptance_criteria": ["3 tiers rendered", "mobile responsive", "Lighthouse > 90"],
  "budget_tokens": 60000,
  "priority": "high",
  "definition_of_done": "QA approved + board updated"
}
```

2. Constrain enums: `task_class` ∈ `C0|C1|C2|C3|C4`; `priority` ∈ `low|medium|high|critical`.
3. Put workspace-relative paths (+ anchors) in `context_refs`; it MAY be `[]`. Workers receive ONLY the brief + referenced files — task-scoped context.
4. Write ≥1 TESTABLE item in `acceptance_criteria` — QA judges against exactly these, nothing else.
5. Set `budget_tokens` > 0. Dispatch via `new_task` subtask / `task_assign`.

## Write a Result Report (Executor → Orchestrator)
1. Fill every required field exactly per this schema example:

```json
{
  "task_id": "T-007",
  "status": "done",
  "progress_percent": 100,
  "artifacts": ["src/pages/pricing.tsx"],
  "blockers": [],
  "notes_for_qa": "Test at 375px width"
}
```

2. Use `status` ∈ `done|blocked|needs_input`; keep `blockers` empty when `done`, concrete when `blocked`/`needs_input`.
3. Match `task_id` to the originating brief; list produced/changed paths (workspace-relative) in `artifacts`; `notes_for_qa` may be `""`.

## Envelope contract warnings
- **NO token fields — EVER.** Agents cannot count their own consumption; self-reported numbers are estimates, never facts. Real usage is recorded exclusively by the MCP server from authoritative sources (`provider_usage`, `ide_export`).
- Begin every state file and envelope with `schema_version` so future format changes MIGRATE instead of breaking.
- Give every ledger event a unique UUID `event_id` — retries from parallel processes must never double-count.
- VALIDATE against the JSON Schema BEFORE accepting (`task_create` / `task_update`); reject invalid envelopes with a precise error message.

## Async queue rule — no hidden bottleneck
- NEVER hand results session-to-session.
- On finish, write the Result Report to the board with status **`awaiting_orchestrator`**.
- The Orchestrator drains this WRITTEN QUEUE on its own rhythm (event-driven `board_read`). Three executors finishing simultaneously simply enqueue — nobody waits on anyone's attention.

## Speculative parallelism bound
- Dispatch dependency-free tasks to EVERY AVAILABLE executor instance:

```
runtime parallelism = min(dependency-free tasks, open executor sessions)
```

- One IDE window means one session; the written queue serializes the rest without breaking anything. The 10× throughput claim belongs to `llm_batch`, not chat sessions.
