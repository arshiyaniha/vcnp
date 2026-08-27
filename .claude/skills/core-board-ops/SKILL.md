---
name: core-board-ops
description: Board operations for the Orchestrator and Resource Controller. Use when reading or updating office/state.json, appending ledger events, draining the awaiting_orchestrator queue, regenerating BOARD.md, or acknowledging compaction at task boundaries.
---

# VCNP Board Operations

Law: [`core/constitution.md`](../../../core/constitution.md) Art. 3 · Spec: [`core/protocol.md`](../../../core/protocol.md)

## Ledger-first write procedure
1. APPEND the event to `office/events.log.jsonl` FIRST — the ledger is the only source of truth; nothing else is written until the append succeeds.
2. Guard appends with the exclusive-create lock `office/.lock` (create-with-O_EXCL semantics); delete it after. If the lock exists, back off and retry — never corrupt the log.
3. Stamp every event with a fresh UUID `event_id` (duplicate deliveries dedupe on it) and a `schema_version`.
4. REBUILD `office/state.json` from the FULL ledger into a temp file, then ATOMICALLY rename it over the old file. NEVER write state in place — readers always see a consistent snapshot.
5. Regenerate `office/BOARD.md` from the rebuilt state at report time.

Event line shape:

```json
{"event_id":"<uuid4>","ts":"<iso8601>","schema_version":"1.0","actor":"<role>","action":"<verb>","task_id":"T-NNN"}
```

## Drain the awaiting_orchestrator queue
1. Run event-driven `board_read`; collect every task with status `awaiting_orchestrator`.
2. For each: read its Result Report, apply gate outcomes (QA ∧ Security ∧ CI), update the task via `task_update`, then dispatch follow-ups per the Planner's dependency graph.
3. Respect the parallelism bound: dispatch dependency-free tasks to every open executor session — `min(dependency-free tasks, open executor sessions)`.
4. Accept results ONLY through the written queue — never session-to-session.

## BOARD.md regeneration rules
- BOARD.md is a DERIVED kanban mirror — regenerate it from state; never treat hand edits as truth.
- Reconcile against BOARD.md at session start; if it disagrees with the ledger, THE LEDGER WINS — rebuild from it.
- Keep it human-readable: columns, task ids, owners, statuses, blockers, next actions.

## compaction_ack at task boundaries
1. At each task boundary, compare session utilization against the ≥60% threshold.
2. If above: perform the Librarian hand-off (Memory Bank files actually updated), THEN call MCP `compaction_ack(session_id, util_after)` — the deterministic writer validates and appends atomically. Never satisfy the gate with a promise.
3. Treat `compaction_done` as valid ONLY if it is the LATEST util-related event for that session.
4. Mid-task above 75%: notify only — advisory unless an adapter hook exists. Starvation is impossible: the ack tool is always callable.
