#!/usr/bin/env bash
#
# VCNP Vibe-Office uninstaller (Linux / macOS / Git-Bash).
#
# Removes the `vcnp-office` entry from the target project's `.mcp.json`
# (all other entries are preserved). The `office/` folder — your project's
# shared memory — is KEPT unless you pass --delete-office explicitly.
#
# Usage: bash installer/uninstall.sh [--delete-office] [TARGET_DIR]
#        (default target: current directory)

set -u

fail() { # fail EN FA
  printf '\nERROR: %s\n\xe2\x9c\x98 \xd8\xae\xd8\xb7\xd8\xa7: %s\n' "$1" "$2" >&2
  exit 1
}

usage() {
  echo 'Usage: bash installer/uninstall.sh [--delete-office] [TARGET_DIR]'
  echo '       --delete-office  ALSO delete the office/ folder (destructive).'
}

TARGET=''
DEL_OFFICE=0
for a in "$@"; do
  case "$a" in
    --delete-office) DEL_OFFICE=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) fail "unknown option: $a (see --help)" "گزینهٔ ناشناخته: $a" ;;
    *) if [ -z "$TARGET" ]; then TARGET="$a"; fi ;;
  esac
done

DEFAULT_PWD="$(pwd)"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) DEFAULT_PWD="$(cygpath -m "$DEFAULT_PWD" 2>/dev/null || printf '%s' "$DEFAULT_PWD")" ;;
esac
[ -n "$TARGET" ] || TARGET="$DEFAULT_PWD"
case "$TARGET" in
  /*|[A-Za-z]:/*|[A-Za-z]:\\*) ;;
  *) TARGET="$DEFAULT_PWD/$TARGET" ;;
esac

[ -d "$TARGET" ] || fail "target folder not found: $TARGET" "پوشهٔ مقصد پیدا نشد: $TARGET"

echo ''
echo '=== VCNP Vibe-Office uninstaller | حذف نصب وی‌سی‌ان‌پی ==='
echo "target : $TARGET"

# ------------------------------------------------------------- Node.js check
if ! command -v node >/dev/null 2>&1; then
  echo ''
  echo 'Node.js is required to safely edit .mcp.json, but it was not found.'
  echo 'Install Node.js from https://nodejs.org and run the uninstaller again.'
  echo ''
  echo 'برای ویرایش امنِ ‎.mcp.json به Node.js نیاز است، اما پیدا نشد.'
  echo 'ابتدا Node.js را از https://nodejs.org نصب کنید و حذف‌کننده را دوباره اجرا کنید.'
  exit 1
fi

# ------------------------------------------------- remove vcnp-office entry
MCP_JSON="$TARGET/.mcp.json"

# read -> JSON parse -> delete key -> write ; aborts on invalid existing JSON
REMOVE_JS='const fs = require("fs"); const file = process.argv[1]; if (!fs.existsSync(file)) { console.log("NOFILE"); process.exit(0); } let cfg; try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.error("existing .mcp.json is not valid JSON - aborting to avoid data loss: " + e.message); process.exit(2); } let had = false; if (cfg.mcpServers && typeof cfg.mcpServers === "object" && !Array.isArray(cfg.mcpServers) && Object.prototype.hasOwnProperty.call(cfg.mcpServers, "vcnp-office")) { delete cfg.mcpServers["vcnp-office"]; had = true; } fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n"); console.log(had ? "REMOVED" : "ABSENT");'

OUT="$(node -e "$REMOVE_JS" "$MCP_JSON" 2>&1)" || \
  fail "could not update $MCP_JSON — $OUT" "به‌روزرسانی ‎.mcp.json ممکن نشد — $OUT"

case "$OUT" in
  NOFILE)  echo '  = no .mcp.json found — nothing was registered there.' ;;
  REMOVED) echo "  - removed \`vcnp-office\` entry from : $MCP_JSON" ;;
  ABSENT)  echo '  = no `vcnp-office` entry found (already clean).' ;;
  *)       fail "unexpected result: $OUT" "نتیجهٔ غیرمنتظره: $OUT" ;;
esac

# ------------------------------------------------------- office/ data policy
OFFICE="$TARGET/office"
if [ "$DEL_OFFICE" = "1" ]; then
  if [ -e "$OFFICE" ]; then
    rm -rf "$OFFICE"
    echo "  - deleted office/ (shared state removed): $OFFICE"
  else
    echo '  = office/ not found — nothing to delete.'
  fi
else
  echo ''
  echo 'office/ KEPT — your project memory (ledger, board, memory bank) is untouched.'
  echo 'پوشهٔ office/ حفظ شد — حافظهٔ پروژه دست‌نخورده است. برای حذف کامل، پرچم --delete-office را اضافه کنید.'
fi
echo 'Done.'
