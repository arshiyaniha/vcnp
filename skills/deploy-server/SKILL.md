---
name: deploy-server
description: Deployment and hosting playbook. Use for any deploy, hosting, server, domain, SSL, or CI/CD task - choosing between static-CDN, VPS, and PaaS recipes, following the Git protocol, and rolling back safely.
---

# Deploy Server — Recipes & Git Protocol

Per-recipe step lists: [`references/deploy-checklists.md`](references/deploy-checklists.md)

## Pick a recipe — ask ≤3 plain questions
Ask the user in plain language (maximum three): 1) Do you have a domain name? 2) What is the budget — free/cheap or a monthly server? 3) How much traffic, and does it need a backend?

| Answers point to | Recipe | Fits | Tools |
|---|---|---|---|
| Static output, free/cheap, no backend | **Static site → global CDN** | landing pages, portfolios | any static host + CI upload |
| Node backend, full control, low cost | **Node app → VPS** | dynamic sites, APIs | SSH + process manager + Nginx + SSL |
| Node backend, zero-ops preference | **Node app → PaaS** | teams avoiding ops | platform CLI + CI plugin |

Execute ONLY the matching checklist in `references/deploy-checklists.md`. Post-deploy: hook uptime ping + error monitoring into the dashboard event feed.

## Git protocol reminders
- Branches: `main` = production · `develop` = integration · `feature/T-007-pricing-page` per task.
- Commits: conventional format referencing the task id — `feat(pricing): add tier cards [T-007]`.
- Merge ONLY after ALL THREE gates: **QA approved ∧ Security passed ∧ CI green**.
- Releases: tagged `vX.Y.Z`.

## Rollback
- Rollback = redeploy the PREVIOUS TAG — one command, rehearsed before the first deploy.
- If a post-deploy health check fails: roll back FIRST, diagnose SECOND.

## Pipeline order (GitHub Actions default, adaptable)
push/PR → unit + lint + build → security scan + audit → deploy to staging → smoke tests → CEO approval → deploy to production → health check → auto-rollback on failure.
