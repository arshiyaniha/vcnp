# VCNP Handoff Envelope Specification

> **Status:** NORMATIVE · **Schema version:** 1.0 · **Scope:** all inter-employee work in the VCNP vibe-office
> Source of truth: [`plans/vcnp-vibe-office-plan.md`](../plans/vcnp-vibe-office-plan.md) §5 · Law: [`core/constitution.md`](constitution.md)

All inter-employee work moves in standard envelopes (markdown + JSON). There are exactly two envelope types:

| Envelope | Direction | Vehicle |
|---|---|---|
| **Task Brief** | Orchestrator → Executor | `new_task` subtask / `task_assign` |
| **Result Report** | Executor → Orchestrator | written to the board with status `awaiting_orchestrator` |

Every envelope event appends to the event ledger [`office/events.log.jsonl`](../office/events.log.jsonl) — the append-only SOURCE OF TRUTH and audit trail: who did what, when, at what cost.

---

## 1. Task Brief (Orchestrator → Executor)

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

### Field contract

| Field | Type | Required | Constraints |
|---|---|---|---|
| `task_id` | string | ✔ | unique; `T-NNN` convention recommended |
| `title` | string | ✔ | short, human-readable |
| `task_class` | enum | ✔ | `C0` spike · `C1` trivial · `C2` standard · `C3` complex · `C4` wide-context (routing matrix, plan §8) |
| `context_refs` | string[] | ✔ | workspace-relative paths + anchors; MAY be `[]`; workers receive ONLY the brief + referenced files (task-scoped context) |
| `acceptance_criteria` | string[] | ✔ | ≥ 1 item; testable statements — QA judges against exactly these |
| `budget_tokens` | integer | ✔ | > 0; see cap honesty (§5) |
| `priority` | enum | ✔ | `low` \| `medium` \| `high` \| `critical` |
| `definition_of_done` | string | ✔ | explicit done condition (e.g., "QA approved + board updated") |

---

## 2. Result Report (Executor → Orchestrator)

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

### Field contract

| Field | Type | Required | Constraints |
|---|---|---|---|
| `task_id` | string | ✔ | must match the originating brief |
| `status` | enum | ✔ | `done` \| `blocked` \| `needs_input` |
| `progress_percent` | integer | ✔ | 0–100 |
| `artifacts` | string[] | ✔ | produced/changed paths (workspace-relative) |
| `blockers` | string[] | ✔ | empty when `done`; concrete when `blocked`/`needs_input` |
| `notes_for_qa` | string | ✔ | may be `""` |

**NO token fields — ever.** Agents cannot count their own consumption; self-reported numbers are estimates, never facts. Real usage is recorded exclusively by the MCP server (`ledger_log` / telemetry) from authoritative sources (`provider_usage`, `ide_export`). Budget enforcement uses ONLY those sources.

---

## 3. Async Queue Rule — no hidden bottleneck

- Executors **NEVER** hand results session-to-session.
- A finished task is written to the board with status **`awaiting_orchestrator`**.
- The Orchestrator drains this WRITTEN QUEUE on its own rhythm (event-driven `board_read`).
- Three executors finishing simultaneously simply enqueue — nobody waits on anyone's attention.

## 4. Speculative Parallelism Bound

Because the Planner ships a dependency graph, the Orchestrator dispatches dependency-free tasks to EVERY AVAILABLE executor instance:

```
runtime parallelism = min(dependency-free tasks, open executor sessions)
```

One IDE window means one session; the written queue serializes the rest without breaking anything. The 10× throughput claim belongs to `llm_batch`, not chat sessions.

## 5. Cap Honesty (hard vs advisory)

Token caps are HARD only where MCP controls the call (`llm_batch`) and at task-boundary gates checked against authoritative `ide_export` data. Inside a live IDE session they are ADVISORY, labeled «estimated cap». We do not pretend otherwise.

## 6. Contract Enforcement

The Handoff Envelope is not a convention — it is a JSON Schema. The MCP server VALIDATES every `task_create` / `task_update` against the schema BEFORE accepting; an invalid envelope is rejected with a precise error message. This is the difference between a system that works in demos and one that still works at task #50.

## 7. Event Identity & Versioning

- Every ledger event carries a unique `event_id` (UUID) — retries from parallel stdio processes can never double-count, and ledger replay is safe.
- Every state file and envelope begins with `schema_version`, so future format changes MIGRATE instead of breaking old projects.
