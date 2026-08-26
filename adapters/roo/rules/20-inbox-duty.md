# Rule: Inbox Duty — check messages at start and after milestones (PROTOCOL)

> خلاصه فارسی: هر نقش در شروع نشست، پس از هر milestone و پیش از پایان نشست باید صندوق
> ورودی خود را بررسی کند؛ ابزارهای inbox در فاز بعدی اضافه می‌شوند و تا آن زمان این
> بخش یک پروتکل رزرو‌شده است — هیچ پاسخی شبیه‌سازی نمی‌شود.

Messages typed by the user become `message_posted` ledger events addressed to a role
(`to_role`). Answering them is a DUTY of the addressed role — the office never
simulates typing or answers, and the dashboard honestly shows «در انتظار نشست /
awaiting session» while you have unread messages.

## 1. When to check (three checkpoints)

1. At SESSION START — immediately after logging `session_lifecycle` `phase:"start"`.
2. After EVERY MILESTONE — task completion, qa verdict, published plan/artifact.
3. Before SESSION END — leave the inbox empty or explicitly handed over.

## 2. How to check (tools arrive in a later phase)

The dedicated tools below are part of the live-office plan §3 and will appear in
`tools/list` in a later phase. This rule RESERVES the duty now so behavior is
identical the day they ship:

| Step | Tool | Notes |
|---|---|---|
| Count | `inbox_count { role?: "<your-role>" }` | cheap checkpoint probe |
| List | `inbox_list { role?: "<your-role>" }` | oldest-first pending messages |
| Reply | `inbox_reply { reply_to: "<event_id>", text: "..." }` | ONE answer per message |

## 3. Answer discipline

- **First answer wins**: a second `inbox_reply` for the same message is rejected —
  never retry or double-answer.
- Plain, non-technical language for user-facing answers (CEO duty); operational
  answers routed to `orchestrator` stay precise and short.
- Never fabricate a reply, never mark messages answered without the tool call.
- After draining, log the duty like any real work:
  `event_log { actor: "<your-role>", action: "work_logged",
               detail: { action_summary: "drained N inbox message(s)" } }`.

## 4. Until the tools exist

If `inbox_count` / `inbox_list` / `inbox_reply` are NOT yet in `tools/list`, skip the
mechanical step silently — do NOT emulate it with `event_log` and do NOT pretend
messages were read. The duty activates automatically once the tools register.
