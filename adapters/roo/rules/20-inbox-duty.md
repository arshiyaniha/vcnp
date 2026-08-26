# Rule: Inbox Duty — check messages at start and after milestones (PROTOCOL)

> خلاصه فارسی: هر نقش در شروع نشست، پس از هر milestone و پیش از پایان نشست باید صندوق
> ورودی خود را با ابزارهای `inbox_count` / `inbox_list` / `inbox_reply` بررسی و پاسخ دهد؛
> اولین پاسخ برنده است و هیچ پاسخی شبیه‌سازی نمی‌شود.

Messages typed by the user become `message_posted` ledger events addressed to a role
(`to_role`). Answering them is a DUTY of the addressed role — the office never
simulates typing or answers, and the dashboard honestly shows «در انتظار نشست /
awaiting session» while you have unread messages.

**The tools are LIVE since Phase 3** (`mcp/vcnp-office-mcp/src/tools/inbox.js`,
registered in `tools/list`; same projections power `GET /api/inbox` on the live
server). This is no longer a reserved protocol — run it mechanically every session.

## 1. When to check (three checkpoints)

1. At SESSION START — immediately after logging `session_lifecycle` `phase:"start"`.
2. After EVERY MILESTONE — task completion, qa verdict, published plan/artifact.
3. Before SESSION END — leave the inbox empty or explicitly handed over.

## 2. How to check (real tools, registered in tools/list)

| Step | Tool | Notes |
|---|---|---|
| Count | `inbox_count { role?: "<your-role>" }` | cheap checkpoint probe |
| List | `inbox_list { role?: "<your-role>", limit? }` | oldest-first pending messages with `event_id`, `message_id`, `text` |
| Reply | `inbox_reply { reply_to: "<event_id>", text: "...", as_role?: "<role>" }` | ONE answer per message; appends `message_answered` |

If `inbox_count > 0` for your role you MUST drain via `inbox_list` + `inbox_reply`
in the same session — CEO answers in plain, non-technical language; operational
questions routed to `orchestrator` get precise, short answers.

## 3. Answer discipline

- **First answer wins**: a second `inbox_reply` for the same `reply_to` is REJECTED
  ("already answered by …") under the office lock — never retry or double-answer.
- `reply_to` is the `event_id` of the source `message_posted` (copy it from
  `inbox_list` output), not the `m-NNNN` display id.
- Never fabricate a reply, never mark messages answered without the tool call.
- After draining, log the duty like any real work:
  `event_log { actor: "<your-role>", action: "work_logged",
               detail: { action_summary: "drained N inbox message(s)" } }`.

## 4. If the server predates Phase 3

On an older install where `inbox_count` / `inbox_list` / `inbox_reply` are missing
from `tools/list`, skip the mechanical step silently — do NOT emulate it with
`event_log` and do NOT pretend messages were read. Upgrade the MCP package; the
duty activates automatically once the tools register.
