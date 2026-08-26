# VCNP Vibe-Office Kit

**VCNP Vibe-Office** is a multi-agent "virtual office" kit for agentic coding: a CEO-style orchestrator mode runs a company of AI roles (planner, orchestrator, executor, QA, security, resource-controller, librarian, devops) over a **shared office state** — an append-only event ledger that is the single source of truth, with derived mirrors (board, live signals, dashboard) rebuilt from it. It ships as Roo modes + skills + a zero-dependency MCP server, and proves itself with an end-to-end demo.

> ## 🇮🇷 راهنمای مبتدیان — از اینجا شروع کنید
>
> **اگر تازه‌کار هستید، مستقیم بروید سراغ راهنمای فارسی:
> 👉 [RAHNAMA-FA.md](RAHNAMA-FA.md) — «راهنمای فارسی وی‌سی‌ان‌پی»**
>
> This Persian-first beginner manual is the **primary starting point** of the kit:
> quick start, one-command installers (`installer/install.ps1` / `install.sh`),
> first project walkthrough with the CEO mode, the 9 roles at a glance, the
> Living Wall dashboard, troubleshooting and FAQ. The rest of this README is the
> developer-facing reference.

---

## 📁 Folder Map | نقشهٔ پوشه‌ها

| Path | Purpose |
|---|---|
| `core/` | Constitution, protocol (envelope spec), 9 role charters |
| `.roomodes.json` | The 9 VCNP modes wired for RooCode (`vcnp-ceo`, `vcnp-planner`, …) |
| `skills/` | 7 skills: core trio (constitution / protocol / board-ops) + web-design, deploy-server, security-basics, smart-resources |
| `mcp/vcnp-office-mcp/` | MCP server (13 tools): board CRUD, compaction gate, cost-truth ledger/telemetry, model router, async `llm_batch`, reports |
| `office/` | ⭐ Shared state: `events.log.jsonl` (source of truth), `state.json`, `BOARD.md`, `office-live.json`, `dashboard-data.js`, `dashboard.html`, memory bank |
| `office/live/` | Live style switcher (`index.html?style=pixel\|studio`), the ported studio renderer (`studio.html`), and shared browser modules (`assets/vcnp-normalize.js`, `vcnp-store-client.js`, `studio-renderer.js`) |
| `templates/dashboard.html`, `templates/dashboard-pixel.html` | Wall MVP source templates (data path points one level up; the pixel template also carries the live SSE bootstrap) |
| `demo/` | Golden-path demo (`run-golden-path.js`) + built site in `demo/site/`; live-office end-to-end demo (`run-live-office.js`) |
| `plans/vcnp-vibe-office-plan.md` | The blueprint (phases §14, wall §6.3–6.4) |
| `adapters/roo/rules/` | Adapter rules |

## 🚀 How to Start | شروع

1. Open this folder in **VS Code + RooCode**.
2. Switch to the **`vcnp-ceo` mode** (mode selector at the bottom of the chat). The CEO charter bootstraps the office: it reads `office/BOARD.md`, consults the constitution (`core/constitution.md`) and protocol (`core/protocol.md`), then plans/dispatches work through the other `vcnp-*` modes.
3. Talk to it like a CEO: describe the goal; tasks appear on the board.

## 🔌 MCP Server & Tests | سرور و تست‌ها

```bash
cd mcp/vcnp-office-mcp
npm start        # node src/server.js — JSON-RPC 2.0 over stdio
npm test         # node test/smoke.js — end-to-end smoke test (22 checks)
```

Registered as `vcnp-office` in [.mcp.json](../.mcp.json); Node ≥ 20, **zero npm dependencies**. All writes stay inside `office/`.

## 🖥️ Dashboard (Wall MVP) | داشبورد

Open **[`office/dashboard.html`](../office/dashboard.html)** directly in any browser (double-click works — no server needed): project header with overall progress, kanban columns (Todo / Doing / Awaiting Orchestrator / Review / Blocked / Done), per-role signal chips, last-events feed. Persian-first RTL labels with English subtitles.

Refresh its data by regenerating reports — via the `report_generate` MCP tool, or:

```bash
node -e "require('./mcp/vcnp-office-mcp/src/tools/report').generate()"
```

This rewrites `office/BOARD.md`, `office/office-live.json` and `office/dashboard-data.js` (a single-line `window.VCNP_DATA = {...}` assignment — that's what makes `file://` work without fetch/CORS).

## ✨ Demo: the Golden Path | دموی مسیر طلایی

```bash
node demo/run-golden-path.js
```

Runs the full pipeline through the store engine — board init → 3 task briefs → executor result reports → simulated QA passes → queue drain to Done — printing a beginner-friendly trace of every office action. The built output lives at [`demo/site/index.html`](../demo/site/index.html).

## 🔴 Live Office — SSE server, chat, تلفنخانه | دفتر زنده

The live office (design: [`plans/live-office-plan.md`](../plans/live-office-plan.md)) adds a real-time layer on top of the same append-only ledger — nothing here changes `state.json`'s fold semantics; chat/meetings/phone are query-time projections.

```bash
cd mcp/vcnp-office-mcp
npm run live     # node src/live-server.js — binds 127.0.0.1:7788 (env VCNP_OFFICE_PORT to override)
```

* Open **`office/live/index.html?style=pixel`** or **`?style=studio`** in a browser (works both via `file://` and through the live server) to pick between the pixel dashboard and the ported isometric studio renderer — the choice persists in `localStorage` and is deep-linkable via `?style=`.
* Both styles read the SAME composed payload (`GET /api/data`, or pushed live via `GET /api/stream` SSE) through the shared `office/live/assets/vcnp-normalize.js` module — no per-style data scraping. With the server off, both fall back to the static `office/dashboard-data.js` snapshot and show an honest offline indicator.
* **Chat** (Scenario A "honest queue"): type a message to a role in the UI, or `POST /api/message`, or `node tools/phone-drop.js --text "..."` from the CLI — all three append a `message_posted` ledger event through the identical write path. A real `vcnp-ceo`/`vcnp-orchestrator` session drains it via the `inbox_list`/`inbox_reply` MCP tools. Nothing is answered automatically — an unanswered message shows «در انتظار نشست» (awaiting session), never a simulated reply.
* **تلفنخانه (Telephone exchange)**: click «☎ تماس با مدیر» in the browser (requires `http://localhost:7788` — mic access is blocked on `file://`) to record and send a voice note, or drop one from the CLI: `node tools/phone-drop.js --audio path\to\note.webm [--transcript "..."]`. Both paths write `office/phone/<stamp>.webm` + a sidecar JSON and append the same paired `phone_call_received` + `message_posted` events.
* **End-to-end proof**: `node demo/run-live-office.js` boots the server on an ephemeral port, posts a web message, drops a phone-exchange text note via the CLI, watches both arrive over its own SSE connection, and confirms the mirrors were regenerated — exits 0 only if every step is verified live (no simulated output).

---

# نسخهٔ فارسی

**VCNP وایب-آفیس** یک کیت «دفتر مجازی» چندعاملی برای کدنویسی عامل‌محور است: حالت مدیرعامل (`vcnp-ceo`) شرکتی از نقش‌های هوش مصنوعی را اداره می‌کند — برنامه‌ریز، ارکستراتور، مجری، تضمین کیفیت، امنیت، کنترل منابع، کتابدار و دواپس — روی یک **حالت مشترک**: دفتر رویداد فقط-الحاق که تنها منبع حقیقت است و آینه‌های مشتق‌شده (تخته، سیگنال‌های زنده، داشبورد) از آن بازسازی می‌شوند.

## نقشهٔ پوشه‌ها

| مسیر | کاربرد |
|---|---|
| `core/` | قانون اساسی، پروتکل (قرارداد پاکت)، ۹ منشور نقش |
| `.roomodes.json` | ۹ حالت VCNP برای RooCode |
| `skills/` | ۷ مهارت: سه‌گانهٔ هسته + طراحی وب، استقرار، امنیت، منابع هوشمند |
| `mcp/vcnp-office-mcp/` | سرور MCP با ۱۳ ابزار؛ بدون هیچ وابستگی npm |
| `office/` | ⭐ حالت مشترک: دفتر رویداد، تخته، سیگنال‌ها، داشبورد، بانک حافظه |
| `demo/` | دموی مسیر طلایی: اسکریپت + سایت ساخته‌شده در `demo/site/` |

## شروع سریع

۱. پوشه را در **VS Code + RooCode** باز کنید. ۲. به حالت **`vcnp-ceo`** سوییچ کنید؛ مدیرعامل دفتر را راه می‌اندازد و کارها را به سایر حالت‌ها می‌سپارد. ۳. هدف خود را بگویید؛ تسک‌ها روی تخته ظاهر می‌شوند.

## اجرای سرور و تست‌ها

```bash
cd mcp/vcnp-office-mcp
npm start     # اجرای سرور MCP روی stdio
npm test      # تست دود انتها-به-انتها (۲۲ بررسی)
```

## داشبورد (دیوار)

فایل **`office/dashboard.html`** را مستقیم در مرورگر باز کنید (بدون نیاز به سرور): نام و هدف پروژه با درصد پیشرفت کلی، ستون‌های کانبان (انجام نشده / در حال انجام / در انتظار ارکستراتور / بازبینی / مسدود / انجام شده)، چیپ وضعیت هر نقش و فهرست آخرین رویدادها. برچسب‌ها فارسی‌محور با زیرنویس انگلیسی و چیدمان راست‌به‌چپ.

برای به‌روزرسانی داده‌ها، ابزار `report_generate` را صدا بزنید یا:

```bash
node -e "require('./mcp/vcnp-office-mcp/src/tools/report').generate()"
```

این دستور `office/BOARD.md`، `office/office-live.json` و `office/dashboard-data.js` را از نو می‌سازد (تک‌خط `window.VCNP_DATA = {...}` — همان چیزی که باز شدن از `file://` را بدون fetch/CORS ممکن می‌کند).

## دموی مسیر طلایی

```bash
node demo/run-golden-path.js
```

کل خط لوله را با موتور ذخیره‌سازی اجرا می‌کند — مقداردهی تخته ← ۳ بریف تسک ← گزارش مجری ← تأیید شبیه‌سازی‌شدهٔ QA ← تخلیهٔ صف تا «انجام شده» — و ردپای گام‌به‌گام هر اقدام دفتر را چاپ می‌کند. خروجی ساخته‌شده: `demo/site/index.html`.

## دفتر زنده — سرور SSE، گفتگو، تلفنخانه

جزئیات کامل و راهنمای گام‌به‌گام تلفنخانه در [RAHNAMA-FA.md](RAHNAMA-FA.md#-تلفنخانه) آمده است. خلاصه:

```bash
cd mcp/vcnp-office-mcp
npm run live     # اجرای سرور زنده روی 127.0.0.1:7788
```

فایل `office/live/index.html?style=pixel` یا `?style=studio` را باز کنید تا بین دو سبک نمایش سوییچ کنید؛ هر دو از یک دادهٔ زنده (SSE) تغذیه می‌شوند و با خاموش‌بودن سرور به‌طور صادقانه به حالت آفلاین برمی‌گردند.
