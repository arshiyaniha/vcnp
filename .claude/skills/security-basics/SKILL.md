---
name: security-basics
description: Security review and gate procedures. Use for security reviews, secret scanning, dependency audits, OWASP-top-10 checks, destructive-command approvals, merge/deploy security gates, and approval provenance records.
---

# Security Basics — Checklists a Non-Techie Can Trust

Gate duty: NO merge or deploy passes without your verdict. Law: constitution Art. 9 · plan §11.

## OWASP Top-10 basics (plain language)
Check every user-facing change:
1. **Injection** — user input never becomes code or SQL; parameterized queries only.
2. **Broken authentication** — rate-limit logins; hash passwords; expire sessions.
3. **Sensitive data exposure** — HTTPS everywhere; no secrets, cards, or tokens in logs or URLs.
4. **Broken access control** — server-side permission checks on EVERY endpoint; never trust IDs from the client.
5. **Security misconfiguration** — debug off in prod; default credentials changed; errors never leak stack traces.
6. **Vulnerable dependencies** — audits clean (see below).
7. **XSS** — escape output; never render raw HTML from users; set a CSP header.
8. **Unsafe deserialization / uploads** — validate type + size; never execute uploaded content.
9. **Outdated components** — pin versions; check advisories on every upgrade.
10. **Logging & monitoring** — log auth failures and admin actions; wire alerts.

## Secret scanning — TWO points, defense in depth
1. Pre-commit hook (gitleaks-style) installed day one — a secret must never even ENTER a commit.
2. CI gate scan on every push/PR — the second net.
3. Secrets live ONLY in `.env` (gitignored from day one); configs reference env variable NAMES, never values.
4. Found a secret? Rotate it immediately, purge it from history, then close the leak path.

## Dependency audits
- JavaScript: `npm audit --production` (or `pnpm audit` / `yarn audit`) — fix or triage every high/critical.
- Python: `pip-audit` · Rust: `cargo audit`.
- Pin versions; re-run on every lockfile change; record the verdict in the gate.

## Destructive-command guard — explicit USER approval required for:
`rm` / `rm -rf` · `del` / `rmdir /s` · `format` · DB `DROP` / `TRUNCATE` · `git push --force` · writes outside the workspace · reading `.env`.
These are ALSO hard-blocked by pre-tool-use hooks — never bypass a hook; route the request to the user.

## Approval provenance — four-eyes record
Every approval MUST record WHO approved (role + session), WHEN (ISO timestamp), and AGAINST WHICH artifact/diff hash. An approval without provenance is VOID — redo it.

## Gate liveness & waivers
- Security session unresponsive (2 pings / 30 minutes)? Escalate to the CEO: spawn a fresh Security session OR sign a TEMPORARY waiver — NON-production merges only.
- Production deploys ALWAYS require a real Security pass. No exceptions.
