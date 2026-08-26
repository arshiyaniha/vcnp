# Rule: Office Presence — log real work in the ledger (ALL roles)

> خلاصه فارسی: هر نقش باید شروع و پایان نشست و هر واحد کار واقعی را از طریق MCP دفتر ثبت کند؛
> `task_update` کانال رسمیِ وضعیت می‌ماند و هیچ‌کس دفتر یا آینه‌ها را دستی ویرایش نمی‌کند.

Every VCNP role (`ceo`, `planner`, `orchestrator`, `executor`, `qa`, `security`, `rc`,
`librarian`, `devops`) makes its presence REAL in the append-only office ledger
([`office/events.log.jsonl`](../../../office/events.log.jsonl)) through the
**vcnp-office-mcp** MCP server. The mirrors (`BOARD.md`, `office-live.json`,
`dashboard-data.js`) regenerate automatically after every successful append —
**never edit the ledger or mirrors by hand.**

## 1. Session start — mandatory

Your FIRST MCP call of every session logs that you are present:

```
event_log { "actor": "<your-role>", "action": "session_lifecycle",
            "detail": { "phase": "start", "session_id": "<short-unique-id>" } }
```

## 2. During the session — one event per meaningful unit of real work

Each time you finish a meaningful unit (a file written, a review completed, a plan
published, a decision made):

```
event_log { "actor": "<your-role>", "action": "work_logged",
            "detail": { "task_id": "T-NNN",
                        "action_summary": "<what was actually done, <=300 chars>",
                        "artifact_refs": ["<workspace-relative/path>"] } }
```

- `artifact_refs` MUST be real workspace-relative paths (no `..`, nothing fabricated).
- A unit with no artifact may omit `artifact_refs`; it may never invent them.

## 3. Task status stays on the board

Board status changes go ONLY through the dedicated board tools — never encoded
inside `work_logged`:

| Purpose | Tool |
|---|---|
| Create task | `task_create` |
| Report progress / status / artifacts | `task_update` |
| Assign to a role's session | `task_assign` |

## 4. Session end — mandatory

Your LAST MCP call of every session:

```
event_log { "actor": "<your-role>", "action": "session_lifecycle",
            "detail": { "phase": "end", "session_id": "<same-id-as-start>" } }
```

## 5. Honesty rules

- Log what ACTUALLY happened; never pre-log planned work as done.
- Dedicated wrapper tools (`work_log`, `meeting_start`, `meeting_end`) arrive in a
  later phase of the live-office plan. Until they appear in `tools/list`, use
  `event_log` with the exact action names shown above — nothing else changes.
- If the MCP server is unreachable, say so and continue without faking events.
