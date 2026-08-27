---
description: Open the live VCNP office (studio view) in the browser, starting the live server if it isn't already running
---

Open the real-time VCNP office for this project. Do NOT open the static `office/dashboard.html` file directly and do NOT run `report_generate` for this — that only produces a point-in-time snapshot. The user wants what's happening RIGHT NOW (a phone call, a new message, a task hand-off) to appear live within seconds, which only the live server + SSE stream provides.

Steps:

1. Check whether a live server is already up: `curl -s http://127.0.0.1:7788/healthz` (or the port in `VCNP_OFFICE_PORT` if the user has set one). If it answers with `{"ok":true,...}`, it's already running — do NOT start a second instance (the user explicitly does not want multiple office servers/dashboards running at once). Skip to step 3.
2. If it's not reachable, start it in the background from `mcp/vcnp-office-mcp`: `npm run live` (this runs `node src/live-server.js`, binds `127.0.0.1:7788` only, and keeps running — launch it as a background process, not a blocking foreground command). Wait a second or two, then confirm with the same health check before continuing.
3. Open `http://127.0.0.1:7788/live/studio.html` in the default browser. On Windows: `cmd //c start "" "http://127.0.0.1:7788/live/studio.html"`. On macOS: `open "http://127.0.0.1:7788/live/studio.html"`. On Linux: `xdg-open "http://127.0.0.1:7788/live/studio.html"`.
4. Tell the user it's open and that it updates live over SSE — a call landing in تلفنخانه, a new chat message, or a task hand-off shows up within a few seconds, no refresh needed. If they instead see the offline/آفلاین badge, the page loaded before the server came up fully — refreshing once fixes it.

Do not suggest the pixel dashboard or `office/dashboard.html` as an alternative unless the user asks for it — the studio view is the primary, complete office view for this project.
