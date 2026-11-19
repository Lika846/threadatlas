#!/usr/bin/env bash
# PostToolUse (Edit|Write): lint the edited file and typecheck the project.
# Reads the hook payload on stdin. Exit 0 = fine or not applicable; exit 2 = problems, reported
# on stderr (Claude Code shows them to the model). Never touches the database or network.
set -u
root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
file="$(jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null)"
[ -n "$file" ] || exit 0
case "$file" in
  "$root"/node_modules/* | "$root"/.next/* | "$root"/src/generated/* | "$root"/playwright-report/* | "$root"/test-results/*) exit 0 ;;
  "$root"/*.ts | "$root"/*.tsx | "$root"/*.mts | "$root"/*.cts | "$root"/*.js | "$root"/*.mjs | "$root"/*.cjs) ;;
  *) exit 0 ;;
esac
[ -f "$file" ] || exit 0
cd "$root" || exit 0
run() { if command -v fnm >/dev/null 2>&1; then fnm exec --using=24 -- "$@"; else "$@"; fi; }

status=0
lint_out="$(run npx --no-install eslint --max-warnings=0 "$file" 2>&1)" || status=1
tsc_out="$(run npx --no-install tsc --noEmit -p . 2>&1)" || status=1
[ "$status" -eq 0 ] && exit 0
{
  echo "Quality check failed after editing ${file#"$root"/}:"
  [ -n "$lint_out" ] && { echo "--- eslint ---"; printf '%s\n' "$lint_out" | tail -n 40; }
  printf '%s\n' "$tsc_out" | grep -q . && { echo "--- tsc --noEmit ---"; printf '%s\n' "$tsc_out" | tail -n 40; }
} >&2
exit 2
