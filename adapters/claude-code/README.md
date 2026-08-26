# Claude Code Desktop adapter

Mirrors [`adapters/roo/`](../roo/) for a different editor. Roo Code exposes the 9 VCNP
roles as custom modes (`.roomodes.json`) plus always-on rule files
(`adapters/roo/rules/*.md`). Claude Code Desktop has no mode picker, so the same
roles are exposed through Claude Code's own mechanisms instead — the files live
outside this folder because Claude Code only discovers them from fixed paths:

| What | Where |
|---|---|
| Subagents (one per role) | [`.claude/agents/vcnp/*.md`](../../.claude/agents/vcnp/) — spawn via the Agent tool, `subagent_type: "vcnp-<role>"` |
| Slash commands (one per role) | [`.claude/commands/vcnp/*.md`](../../.claude/commands/vcnp/) — `/vcnp:ceo`, `/vcnp:planner`, … adopt a role for the rest of the current conversation |
| Always-on office rules | Same files as Roo: [`adapters/roo/rules/10-office-presence.md`](../roo/rules/10-office-presence.md) and [`20-inbox-duty.md`](../roo/rules/20-inbox-duty.md) — referenced directly from every Claude Code agent/command file rather than duplicated, since the duty is MCP tool calls, not editor-specific behavior |
| MCP server registration | [`.mcp.json`](../../.mcp.json) at the repo root — read identically by RooCode and Claude Code Desktop, zero changes needed |

There is nothing to install here beyond what already exists at those paths — this
README exists so the coverage principle from the live-office plan (§3.3: charter +
Roo adapter + Cursor/AGENTS.md coverage) has a fourth, documented leg for Claude
Code, without a fourth copy of the actual rule text.

## Regenerating the subagents/commands from the charters

The 9 files under `.claude/agents/vcnp/` and 9 under `.claude/commands/vcnp/` are
derived from [`core/charters/*.md`](../../core/charters/) and `.roomodes.json`'s
`groups` (tool scope). If a charter's **Core Duty**, **Never Does**, **Reports To**,
or **Permissions** changes, update the corresponding files by hand — there is no
committed generator script in this repo (one was used once, ad hoc, to bootstrap
these files consistently; regenerating by hand for a single-role edit is simpler
than maintaining a build step for something that changes rarely).
