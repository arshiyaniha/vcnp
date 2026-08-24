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
| `templates/dashboard.html` | Wall MVP source template (data path points one level up) |
| `demo/` | Golden-path demo: `run-golden-path.js` script + built site in `demo/site/` |
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
