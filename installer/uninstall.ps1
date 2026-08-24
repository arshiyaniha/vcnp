#Requires -Version 5.1
<#
.SYNOPSIS
  VCNP Vibe-Office uninstaller (Windows PowerShell).

.DESCRIPTION
  Removes the `vcnp-office` entry from the target project's `.mcp.json`
  (all other entries are preserved). The `office/` folder — your project's
  shared memory — is KEPT unless you pass -DeleteOffice explicitly.

.PARAMETER Target
  Target project folder. Default: current directory.

.PARAMETER DeleteOffice
  ALSO delete the target's office/ folder (destructive — shared state is lost).

.EXAMPLE
  .\installer\uninstall.ps1 -Target D:\my-project
  .\installer\uninstall.ps1 -Target D:\my-project -DeleteOffice
#>

param(
    [string]$Target = (Get-Location).Path,
    [switch]$DeleteOffice
)

$ErrorActionPreference = 'Stop'

# Make Persian output readable in modern terminals (best effort).
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Fail([string]$En, [string]$Fa) {
    Write-Host ''
    Write-Host "ERROR: $En" -ForegroundColor Red
    Write-Host "خطا: $Fa" -ForegroundColor Red
    exit 1
}

# ------------------------------------------------------------- resolve target
if (-not [IO.Path]::IsPathRooted($Target)) {
    $Target = Join-Path (Get-Location).Path $Target
}
$Target = [IO.Path]::GetFullPath($Target)

if (-not (Test-Path -LiteralPath $Target -PathType Container)) {
    Fail "target folder not found: $Target" "پوشهٔ مقصد پیدا نشد: $Target"
}

Write-Host ''
Write-Host '=== VCNP Vibe-Office uninstaller | حذف نصب وی‌سی‌ان‌پی ===' -ForegroundColor Cyan
Write-Host "target : $Target"

# ------------------------------------------------------------- Node.js check
$nodeVersion = ''
try { $nodeVersion = "$(& node --version 2>$null)" } catch { $nodeVersion = '' }
if ($nodeVersion -notmatch '^v\d+\.') {
    Write-Host ''
    Write-Host 'Node.js is required to safely edit .mcp.json, but it was not found.' -ForegroundColor Yellow
    Write-Host 'Install Node.js from https://nodejs.org and run the uninstaller again.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host 'برای ویرایش امنِ ‎.mcp.json به Node.js نیاز است، اما پیدا نشد.' -ForegroundColor Yellow
    Write-Host 'ابتدا Node.js را از https://nodejs.org نصب کنید و حذف‌کننده را دوباره اجرا کنید.' -ForegroundColor Yellow
    exit 1
}

# ------------------------------------------------- remove vcnp-office entry
$McpJson = Join-Path $Target '.mcp.json'

# read -> JSON parse -> delete key -> write ; aborts on invalid existing JSON
# NOTE: single quotes only inside the JS — PowerShell 5.1 mangles double
# quotes when forwarding arguments to native executables.
$removeScript = @'
const fs = require('fs');
const file = process.argv[1];
if (!fs.existsSync(file)) { console.log('NOFILE'); process.exit(0); }
let cfg;
try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) { console.error('existing .mcp.json is not valid JSON - aborting to avoid data loss: ' + e.message); process.exit(2); }
let had = false;
if (cfg.mcpServers && typeof cfg.mcpServers === 'object' && !Array.isArray(cfg.mcpServers) &&
    Object.prototype.hasOwnProperty.call(cfg.mcpServers, 'vcnp-office')) {
  delete cfg.mcpServers['vcnp-office'];
  had = true;
}
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
console.log(had ? 'REMOVED' : 'ABSENT');
'@

$out = ''
$out = & node -e $removeScript $McpJson
if ($LASTEXITCODE -ne 0) {
    Fail "could not update $McpJson (see message above)" "به‌روزرسانی ‎.mcp.json ممکن نشد (پیام بالا را ببینید)"
}

switch ($out) {
    'NOFILE'  { Write-Host '  = no .mcp.json found — nothing was registered there.' }
    'REMOVED' { Write-Host "  - removed 'vcnp-office' entry from : $McpJson" }
    'ABSENT'  { Write-Host "  = no 'vcnp-office' entry found (already clean)." }
    default   { Fail "unexpected result: $out" "نتیجهٔ غیرمنتظره: $out" }
}

# ------------------------------------------------------- office/ data policy
$Office = Join-Path $Target 'office'
if ($DeleteOffice) {
    if (Test-Path -LiteralPath $Office) {
        Remove-Item -LiteralPath $Office -Recurse -Force
        Write-Host "  - deleted office/ (shared state removed): $Office"
    } else {
        Write-Host "  = office/ not found — nothing to delete."
    }
} else {
    Write-Host ''
    Write-Host 'office/ KEPT — your project memory (ledger, board, memory bank) is untouched.' -ForegroundColor Green
    Write-Host 'پوشهٔ office/ حفظ شد — حافظهٔ پروژه دست‌نخورده است. برای حذف کامل، پرچم -DeleteOffice را اضافه کنید.'
}
Write-Host 'Done.' -ForegroundColor Green
