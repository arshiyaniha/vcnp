# VCNP Office Board

> Human-readable kanban mirror of [`office/state.json`](state.json) — derived from the append-only event ledger [`office/events.log.jsonl`](events.log.jsonl), the single source of truth (plan §6). Works even if MCP is offline; sessions reconcile against this board on start.

## Todo
<!-- Newly created tasks awaiting dispatch by the Orchestrator -->

## Doing
<!-- Task briefs currently assigned to an executor session -->

## Awaiting Orchestrator
<!-- Written queue: finished tasks with status awaiting_orchestrator, drained by the Orchestrator on its own rhythm -->

## Review
<!-- Diffs submitted to QA / Security gates -->

## Blocked
<!-- Tasks waiting on user input, decisions, or unblocking -->

## Done
<!-- QA-approved tasks; milestone-ready work -->

- [x] **P0+P1 complete** — repository scaffolded per plan §13; envelope spec [`core/protocol.md`](../core/protocol.md) + constitution [`core/constitution.md`](../core/constitution.md) written; 9 role charters in [`core/charters/`](../core/charters/) wired into [`.roomodes.json`](../.roomodes.json). Project bootstrapped 2026-08-24.
- [x] **P2+P3 complete** — all 7 skills installed under [`skills/`](../skills/): core trio (`core-constitution`, `core-protocol` + envelope JSON Schema, `core-board-ops`) + capability skills (`web-design` + design-system starter CSS, `deploy-server` + per-recipe checklists, `security-basics`, `smart-resources`). Ledger event `phases_p2_p3_complete` appended 2026-08-24.
- [x] **P4 complete** — MCP server [`mcp/vcnp-office-mcp/`](../mcp/vcnp-office-mcp/) implemented: 13 tools (board CRUD with envelope-schema validation, compaction-freshness assignment gate, cost-truth ledger/telemetry, model router, async `llm_batch` with semantic cache, reports, compaction ack); Node ≥20, ZERO npm dependencies; registered as `vcnp-office` in [`.mcp.json`](../.mcp.json); smoke test **22/22 PASS** (`npm test`). Ledger event `phase_p4_complete` appended 2026-08-24.
