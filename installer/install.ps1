#Requires -Version 5.1
<#
.SYNOPSIS
  VCNP Vibe-Office one-click installer (Windows PowerShell).

.DESCRIPTION
  Installs the shared "office" scaffold into a TARGET project folder,
  registers the `vcnp-office` MCP server (absolute path to THIS kit's
  mcp/vcnp-office-mcp/src/server.js, PINNED via VCNP_OFFICE_WORKSPACE so the
  target's own office/ is used even when the kit sits inside/near the
  target — see the workspace-pinning note below) in the target's
  `.mcp.json`, and copies the "brain" files the roles actually need to run
  standalone in the target: `.roomodes.json`/`.roomodes` (RooCode custom
  modes), `core/` (constitution, protocol, charters — referenced by both
  Roo and Claude Code), `skills/`, `adapters/`, and the Claude Code adapter
  (`.claude/agents/vcnp/`, `.claude/commands/vcnp/`, `.claude/commands/office.md`).

  Guarantees:
    - Never overwrites existing office/ files (only fills what is missing) —
      that's per-project DATA (the ledger, tasks, memory bank).
    - The brain files above ARE overwritten on every run — they are kit
      CODE, not project data, and should stay in sync with the kit version
      you're installing from. If you've hand-edited a charter in a target,
      re-running the installer will replace your edit.
    - Preserves every existing entry in `.mcp.json` (read -> parse -> add -> write).
    - Refuses to touch a `.mcp.json` that is not valid JSON.

  Workspace pinning (fixes a real bug found in testing): the MCP server
  locates its workspace by walking up from its own file location looking
  for an `office/` folder, THEN falling back to cwd — so if the kit sits
  inside (or near) the target, it can silently resolve to the KIT's own
  office/ instead of the target's. Setting `VCNP_OFFICE_WORKSPACE` in the
  registered server's env removes that ambiguity entirely.

.PARAMETER Target
  Target project folder. Default: current directory.

.EXAMPLE
  .\installer\install.ps1 -Target D:\my-project
#>

param(
    [string]$Target = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'

# Make Persian output readable in modern terminals (best effort).
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Fail([string]$En, [string]$Fa) {
    Write-Host ''
    Write-Host "ERROR: $En" -ForegroundColor Red
    Write-Host ([char]0x062E + [char]0x0637 + [char]0x0627 + ": $Fa") -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------- locate kit
$KitRoot      = Split-Path -Parent $PSScriptRoot
$ServerJs     = Join-Path $KitRoot 'mcp/vcnp-office-mcp/src/server.js'
$TemplateHtml = Join-Path $KitRoot 'templates/dashboard.html'

if (-not (Test-Path -LiteralPath $ServerJs)) {
    Fail "kit file missing: $ServerJs" "فایل کیت پیدا نشد: $ServerJs"
}
if (-not (Test-Path -LiteralPath $TemplateHtml)) {
    Fail "kit file missing: $TemplateHtml" "فایل کیت پیدا نشد: $TemplateHtml"
}

Write-Host ''
Write-Host '=== VCNP Vibe-Office installer | نصاب وی‌سی‌ان‌پی ===' -ForegroundColor Cyan
Write-Host "kit source : $KitRoot"

# ------------------------------------------------------------- resolve target
if (-not [IO.Path]::IsPathRooted($Target)) {
    $Target = Join-Path (Get-Location).Path $Target
}
$Target = [IO.Path]::GetFullPath($Target)

if (-not (Test-Path -LiteralPath $Target -PathType Container)) {
    Fail "target folder not found: $Target" "پوشهٔ مقصد پیدا نشد: $Target"
}
Write-Host "target     : $Target"

# --------------------------------------------------------- 1) Node.js >= 20
$nodeVersion = ''
try { $nodeVersion = "$(& node --version 2>$null)" } catch { $nodeVersion = '' }
$nodeMajor = 0
if ($nodeVersion -match '^v(\d+)\.') { $nodeMajor = [int]$Matches[1] }

if ($nodeMajor -lt 20) {
    Write-Host ''
    Write-Host 'Node.js version 20 or newer is required, but it was not found on this machine.' -ForegroundColor Yellow
    Write-Host 'Please install Node.js LTS from https://nodejs.org , reopen the terminal, and run this installer again.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host 'برای اجرای این کیت به Node.js نسخهٔ ۲۰ یا جدیدتر نیاز است، اما روی این سیستم پیدا نشد.' -ForegroundColor Yellow
    Write-Host 'لطفاً ابتدا نسخهٔ LTS را از https://nodejs.org نصب کنید، ترمینال را بسته و دوباره باز کنید، سپس نصاب را دوباره اجرا کنید.' -ForegroundColor Yellow
    exit 1
}
Write-Host "[1/6] Node.js $nodeVersion OK"

# ------------------------------------------- 2) office/ scaffold (fill gaps)
$Office = Join-Path $Target 'office'
New-Item -ItemType Directory -Force -Path (Join-Path $Office 'memory-bank') | Out-Null

function Write-IfMissing([string]$Path, [string]$Content) {
    if (Test-Path -LiteralPath $Path) {
        Write-Host "  = kept existing : $Path"
        return
    }
    [IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "  + created       : $Path"
}

Write-Host '[2/6] Creating office/ scaffold (missing files only — nothing is overwritten):'

$stateJson = @'
{
  "schema_version": "1.0",
  "project": {
    "name": "",
    "goal": "",
    "overall_progress": 0
  },
  "tasks": []
}
'@

Write-IfMissing (Join-Path $Office 'state.json') ($stateJson + "`n")

$boardMd = @'
# VCNP Office Board

> Human-readable kanban mirror of [`office/state.json`](state.json) — derived from the append-only event ledger [`office/events.log.jsonl`](events.log.jsonl), the single source of truth (plan §6). Regenerated by `report_generate`; works even if MCP is offline.

## Todo

_(empty)_

## Doing

_(empty)_

## Awaiting Orchestrator

_(empty)_

## Review

_(empty)_

## Blocked

_(empty)_

## Done

_(empty)_
'@

Write-IfMissing (Join-Path $Office 'BOARD.md') ($boardMd + "`n")

# Append-only ledger — SOURCE OF TRUTH. Must start byte-empty (no BOM).
Write-IfMissing (Join-Path $Office 'events.log.jsonl') ''

$mbHeaders = @{
    'activeContext.md'  = '# Active Context — current focus, open questions, next steps (Librarian-owned)'
    'decisionLog.md'    = '# Decision Log — key decisions with rationale and trade-offs (Librarian-owned)'
    'productContext.md' = '# Product Context — high-level project goals, features, and overall architecture (Librarian-owned)'
    'progress.md'       = "# Progress — what works, what's left, status timeline (Librarian-owned)"
}
foreach ($k in $mbHeaders.Keys) {
    Write-IfMissing (Join-Path (Join-Path $Office 'memory-bank') $k) ($mbHeaders[$k] + "`n")
}

# --------------------------------------------------- 3) copy the "brain"
# Kit CODE, not project data — always overwritten so the target stays in
# sync with the kit version you're installing from (see .DESCRIPTION).
Write-Host '[3/6] Copying role definitions (RooCode modes, charters, skills, Claude Code adapter):'

function Copy-KitDir([string]$RelPath) {
    $src = Join-Path $KitRoot $RelPath
    if (-not (Test-Path -LiteralPath $src)) { return }
    $dst = Join-Path $Target $RelPath
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
    Write-Host "  + synced        : $RelPath"
}

foreach ($f in @('.roomodes.json', '.roomodes')) {
    $src = Join-Path $KitRoot $f
    if (Test-Path -LiteralPath $src) {
        Copy-Item -LiteralPath $src -Destination (Join-Path $Target $f) -Force
        Write-Host "  + synced        : $f"
    }
}
Copy-KitDir 'core'
Copy-KitDir 'skills'
Copy-KitDir 'adapters'
Copy-KitDir '.claude/agents/vcnp'
Copy-KitDir '.claude/commands/vcnp'

# Claude Code only auto-discovers skills under .claude/skills/, not the
# root skills/ folder Roo reads — mirror the 7 VCNP skills there too, with
# their core/ links bumped one level deeper (real gap found in testing:
# without this, Claude Code sessions never see them as invocable skills).
$VcnpSkillNames = @('core-board-ops', 'core-constitution', 'core-protocol', 'deploy-server', 'security-basics', 'smart-resources', 'web-design')
foreach ($s in $VcnpSkillNames) {
    $src = Join-Path $KitRoot "skills/$s"
    if (-not (Test-Path -LiteralPath $src)) { continue }
    $dst = Join-Path $Target ".claude/skills/$s"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
    $skillMd = Join-Path $dst 'SKILL.md'
    if (Test-Path -LiteralPath $skillMd) {
        (Get-Content -LiteralPath $skillMd -Raw) -replace '\.\./\.\./core', '../../../core' |
            Set-Content -LiteralPath $skillMd -NoNewline
    }
    Write-Host "  + synced        : .claude/skills/$s"
}
$officeCmd = Join-Path $KitRoot '.claude/commands/office.md'
if (Test-Path -LiteralPath $officeCmd) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Target '.claude/commands') | Out-Null
    Copy-Item -LiteralPath $officeCmd -Destination (Join-Path $Target '.claude/commands/office.md') -Force
    Write-Host '  + synced        : .claude/commands/office.md'
}

# --------------------------------------------------- 4) register MCP server
Write-Host '[4/6] Registering `vcnp-office` MCP server in .mcp.json:'

$McpJson   = Join-Path $Target '.mcp.json'
$serverAbs = ([IO.Path]::GetFullPath($ServerJs)) -replace '\\', '/'
$targetAbs = ($Target) -replace '\\', '/'

# read -> JSON parse -> add -> write ; aborts on invalid existing JSON (byte-safe for other entries)
# NOTE: single quotes only inside the JS — PowerShell 5.1 mangles double
# quotes when forwarding arguments to native executables.
$mergeScript = @'
const fs = require('fs');
const file = process.argv[1];
const server = process.argv[2];
const workspace = process.argv[3];
let cfg = {};
if (fs.existsSync(file)) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { console.error('cannot read .mcp.json: ' + e.message); process.exit(2); }
  try { cfg = JSON.parse(raw); }
  catch (e) { console.error('existing .mcp.json is not valid JSON - aborting to avoid data loss: ' + e.message); process.exit(2); }
}
if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object' || Array.isArray(cfg.mcpServers)) cfg.mcpServers = {};
// VCNP_OFFICE_WORKSPACE is PINNED, not left to directory-walk guessing: if the
// kit sits inside/near the target (a very normal layout), the server's
// walk-up-then-cwd fallback can silently resolve to the KIT's own office/
// instead of the target's — a real bug found in testing. Pinning removes
// the ambiguity for good.
cfg.mcpServers['vcnp-office'] = { command: 'node', args: [server], env: { VCNP_OFFICE_WORKSPACE: workspace } };
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
console.log('OK');
'@

& node -e $mergeScript $McpJson $serverAbs $targetAbs
if ($LASTEXITCODE -ne 0) {
    Fail "could not update $McpJson (see message above)" "به‌روزرسانی ‎.mcp.json ممکن نشد (پیام بالا را ببینید)"
}
if (Test-Path -LiteralPath $McpJson) {
    Write-Host "  + merged 'vcnp-office' (absolute server path) into : $McpJson"
}

# ------------------------------------- 4) dashboard fallback + honest notes
Write-Host '[5/6] Dashboard fallback:'
$dashDst = Join-Path $Office 'dashboard.html'
if (Test-Path -LiteralPath $dashDst) {
    Write-Host "  = kept existing : $dashDst"
} else {
    Copy-Item -LiteralPath $TemplateHtml -Destination $dashDst
    Write-Host "  + copied template fallback : $dashDst"
}

Write-Host ''
Write-Host 'این سرور عمداً هیچ پرچم خط فرمانی ندارد، اما همین حالا آن را برایتان روشن می‌کنیم'
Write-Host '(مرحلهٔ بعد) تا office/dashboard-data.js را خودش تازه نگه دارد.'
Write-Host ''

# --------------------- 6) start the live server + open the studio view now
# The user should not have to do ANYTHING manual after this script: no
# separate `npm run live`, no report_generate, no double-clicking a file.
Write-Host '[6/6] Starting the live office server and opening the studio view:'
$Port = 7788
$env:VCNP_OFFICE_WORKSPACE = $targetAbs
$env:VCNP_OFFICE_PORT = "$Port"
$LiveServerJs = Join-Path $KitRoot 'mcp/vcnp-office-mcp/src/live-server.js'
$alreadyUp = $false
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2
    if ($health.ok) { $alreadyUp = $true }
} catch { $alreadyUp = $false }

if ($alreadyUp) {
    Write-Host "  = already running on 127.0.0.1:$Port — not starting a second instance"
} else {
    Start-Process -FilePath 'node' -ArgumentList "`"$LiveServerJs`"" -WindowStyle Hidden | Out-Null
    $tries = 0
    do {
        Start-Sleep -Milliseconds 500
        $tries++
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2
            if ($health.ok) { $alreadyUp = $true }
        } catch { $alreadyUp = $false }
    } while (-not $alreadyUp -and $tries -lt 20)
    if ($alreadyUp) {
        Write-Host "  + live server started and healthy on 127.0.0.1:$Port"
    } else {
        Write-Host '  ! live server did not report healthy in time — start it manually with `npm run live` in mcp/vcnp-office-mcp' -ForegroundColor Yellow
    }
}

$StudioUrl = "http://127.0.0.1:$Port/live/studio.html"
if ($alreadyUp) {
    try { Start-Process $StudioUrl | Out-Null; Write-Host "  + opened in your default browser : $StudioUrl" }
    catch { Write-Host "  ! could not auto-open a browser — open this URL yourself: $StudioUrl" -ForegroundColor Yellow }
}

Write-Host ''
Write-Host '=== NEXT STEPS | گام‌های بعدی ===' -ForegroundColor Green
Write-Host "1. The live office is already open at $StudioUrl — nothing else to run."
Write-Host '2. Talk to any role: in Claude Code Desktop type `/vcnp:ceo` (or any `/vcnp:<role>`),'
Write-Host '   or in VS Code + RooCode switch to the `vcnp-ceo` mode. Describe your goal in plain'
Write-Host '   language — the CEO plans and dispatches the work, and it appears live in the browser'
Write-Host '   within seconds (no refresh, no report_generate).'
Write-Host '3. Later, reopen the live office anytime with the `/office` command (Claude Code) —'
Write-Host '   it reuses the already-running server instead of starting a second one.'
Write-Host 'Done. موفق باشید!' -ForegroundColor Green
