#!/usr/bin/env bash
# Stop: when there are uncommitted code changes, run typecheck, lint and unit tests before
# Claude finishes. On failure it blocks once with the output (Claude must fix or explain); it
# never blocks twice in a row (stop_hook_active), so it cannot loop. Unit tests only: no
# database, browser, model or network.
set -u
root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$root" || exit 0
input="$(cat)"
[ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null)" = "true" ] && exit 0

changed="$(git status --porcelain --untracked-files=all 2>/dev/null | cut -c4- | grep -E '\.(ts|tsx|mts|cts|js|mjs|cjs|json|prisma)$|^\.claude/hooks/' | grep -vE '^(docs/spikes/.*/results/|test-results/|playwright-report/)' || true)"
[ -n "$changed" ] || exit 0

run() { if command -v fnm >/dev/null 2>&1; then fnm exec --using=24 -- "$@"; else "$@"; fi; }
failed=""
report=""
step() {
  local name="$1"; shift
  local out
  if ! out="$(run "$@" 2>&1)"; then
    failed="${failed:+$failed, }$name"
    report="$report"$'\n'"--- $name ---"$'\n'"$(printf '%s\n' "$out" | grep -v '^\s*$' | tail -n 30)"
  fi
}
step "typecheck" npm run --silent typecheck
step "lint" npm run --silent lint
step "unit tests" npx --no-install vitest run --project unit

if [ -z "$failed" ]; then
  jq -n --arg m "Stop verification passed (typecheck, lint, unit tests) for $(printf '%s\n' "$changed" | wc -l | tr -d ' ') changed file(s)." '{systemMessage: $m}'
  exit 0
fi
jq -n --arg r "Stop verification failed: $failed. Fix the problems or explain why they remain.$report" '{decision: "block", reason: $r}'
exit 0
