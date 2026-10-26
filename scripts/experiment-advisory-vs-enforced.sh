#!/bin/sh
# Real Claude Code comparison: advisory (unmanaged) vs plugin-enforced vs managed `optimizer run`.
# Uses your normal Claude Code setup (CLAUDE.md, skills, plugins, global hooks). Run it yourself:
#   sh scripts/experiment-advisory-vs-enforced.sh
# It installs this checkout's build globally (revert with: npm install -g @optimizer-layer/runtime@latest
# @optimizer-layer/agent-adapter@latest @optimizer-layer/mcp@latest), creates three throwaway fixtures in a
# temporary directory, approves a check for two of them, and spends real Claude quota (three short tasks).
set -eu

NODE_BIN=${NODE_BIN:-/Users/m129/.nvm/versions/node/v24.18.0/bin}
export PATH="$NODE_BIN:$PATH"
REPO=$(cd "$(dirname "$0")/.." && pwd -P)
MAX_TURNS=${MAX_TURNS:-40}
PERMISSIONS="--permission-mode acceptEdits --allowedTools Bash"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/optimizer-experiment-XXXXXX")
WORK=$(cd "$WORK" && pwd -P)
PROMPT='parseCount should stop turning invalid input into 0. Accept only non-negative safe integers and strings of decimal digits; throw a RangeError for everything else.'

echo "== build and install this checkout ($REPO)"
(cd "$REPO" && npm run build >/dev/null && rm -rf "$WORK/pkgs" && mkdir -p "$WORK/pkgs" \
  && npm pack ./dist/npm/runtime ./dist/npm/adapter ./dist/npm/mcp --pack-destination "$WORK/pkgs" >/dev/null)
npm install -g "$WORK"/pkgs/*.tgz >/dev/null 2>&1
optimizer --help | head -1

cp "$REPO/examples/vertical-slice/acceptance.mjs" "$WORK/acceptance.mjs"
printf '%s\n' "$PROMPT" > "$WORK/prompt.txt"
for name in advisory plugin managed; do
  cp -R "$REPO/examples/vertical-slice/fixture" "$WORK/$name"
  (cd "$WORK/$name" && git init -q && git add -A && git -c user.email=x@x -c user.name=x commit -qm fixture)
done
# Advisory: tracked but no approved check, i.e. the previous advisory-only behaviour.
# Plugin and managed: the user-approved check makes them managed projects.
# You run this script, so it enables the fixtures directly as operator code (the CLI would ask for an
# approval phrase when not attached to a terminal).
for name in plugin managed; do
  node --input-type=module -e "
    import { enableProject } from '$REPO/packages/runtime/src/project.ts';
    console.log(JSON.stringify(enableProject('$WORK/$name', { commands: ['node $WORK/acceptance.mjs $WORK/$name'], timeoutMs: 30000, yes: false })));
  "
done

run_plain() { # name
  cd "$WORK/$1"
  start=$(date +%s)
  # shellcheck disable=SC2086
  claude -p "$PROMPT" --output-format json --max-turns "$MAX_TURNS" $PERMISSIONS > "$WORK/$1.claude.json" 2> "$WORK/$1.claude.err" || true
  echo $(( $(date +%s) - start )) > "$WORK/$1.seconds"
}

echo "== A advisory"; run_plain advisory
echo "== B plugin (enforced through your global hooks)"; run_plain plugin
echo "== C managed (optimizer run)"
start=$(date +%s)
# shellcheck disable=SC2086
optimizer run --project "$WORK/managed" --prompt-file "$WORK/prompt.txt" --max-turns "$MAX_TURNS" --timeout-ms 900000 \
  --claude-args="$PERMISSIONS" > "$WORK/managed.run.json" 2> "$WORK/managed.run.err" || true
echo $(( $(date +%s) - start )) > "$WORK/managed.seconds"

echo "== report"
node "$REPO/scripts/experiment-report.mjs" "$WORK" | tee "$WORK/report.json"
echo "Raw files: $WORK"
