# Deploy Checklists — per recipe

Pick ONE checklist per deployment. Ask the ≤3 questions from [`SKILL.md`](../SKILL.md) first.

## Recipe A — Static site → global CDN
Fits: landing pages, portfolios · Tools: any static host + CI upload

1. Build the site (`npm run build` or equivalent); verify the output folder locally.
2. Confirm no secrets in the bundle; run the Security gate (scan + audit).
3. Choose a host (Cloudflare Pages / Netlify / S3+CloudFront / GitHub Pages).
4. Connect the domain if provided: DNS records + automatic HTTPS.
5. Wire CI upload on tag push (`vX.Y.Z`) — build once, upload the artifact.
6. Set cache headers: hashed assets immutable; `index.html` no-cache.
7. Smoke-test the production URL; hook uptime ping + error monitoring into the dashboard feed.
8. Tag the release; append the deploy event to `office/events.log.jsonl`.

**Rollback:** redeploy the previous tag (CI re-uploads the previous artifact).

## Recipe B — Node app → VPS
Fits: dynamic sites, APIs · Tools: SSH + process manager + Nginx + SSL

1. Provision a VPS (Ubuntu LTS); create a non-root deploy user; enable a firewall allowing only 22/80/443.
2. Install Node.js 20+; clone the repo at the release tag.
3. Install a process manager (PM2 or systemd unit); `npm ci --omit=dev`; build; start the app on a localhost port.
4. Configure Nginx as a reverse proxy → localhost port; enable gzip; cache static assets.
5. Provision SSL via certbot (Let's Encrypt); force HTTPS redirect; verify auto-renewal.
6. Add deploy credentials to CI as scoped secrets with minimal permissions.
7. Add a health-check endpoint + uptime ping; wire error monitoring into the dashboard feed.
8. Run smoke tests on the production URL; tag the release; log the deploy event.

**Rollback:** `git checkout vX.Y.(Z-1)` → rebuild → restart the process manager (one rehearsed command).

## Recipe C — Node app → PaaS
Fits: zero-ops preference · Tools: platform CLI + CI plugin

1. Choose a platform (Render / Railway / Fly.io / Heroku-compatible); install its CLI.
2. Define the start command + env vars by `.env` NAMES (values live only in platform secrets).
3. Connect the repo; auto-deploy on tag push; set the health-check path.
4. Attach the managed domain; use platform-managed TLS.
5. Scale to the smallest viable instance; review the platform cost estimate.
6. First deploy to a staging instance → smoke tests → promote to production.
7. Hook platform logs/metrics into monitoring; log the deploy event in the ledger.

**Rollback:** redeploy the previous tag via platform CLI/CI (one command).

## Universal post-deploy (all recipes)
- Verify: URL loads, health check green, monitoring receiving events.
- Record: deploy event appended to `office/events.log.jsonl` (tag, commit, recipe).
- NEVER deploy without QA ∧ Security ∧ CI gates; production ALWAYS requires a real Security pass.
