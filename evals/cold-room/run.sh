#!/usr/bin/env bash
# Cold-room runner: fresh checkout, fresh agent, one scenario, real lights.
#
# Usage:
#   evals/cold-room/run.sh <scenario-id> [--local]
#
#   --local   copy the current working tree instead of cloning from GitHub
#             (for testing unpushed changes; a true cold run clones).
#
# LAUNCH THIS FROM A TERMINAL THAT HOLDS THE BLUETOOTH PERMISSION. macOS
# attributes Bluetooth to the responsible process and kills (SIGABRT, no
# prompt) anything whose responsible app lacks the grant — measured, see
# evals/cold-room/README.md. Verify the attribution chain on the first run.
#
# macOS ships bash 3.2; keep this file free of bash 4+ features.
set -euo pipefail

SCENARIO_ID="${1:-}"
MODE="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
REPO_URL="https://github.com/andyed/suffuse.git"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"

if [ -z "$SCENARIO_ID" ]; then
  echo "usage: run.sh <scenario-id> [--local]" >&2
  node -e "const s=require('$HERE/scenarios.json'); s.scenarios.forEach(x=>console.log('  '+x.id))" >&2
  exit 2
fi

PROMPT="$(node -e "
  const s = require('$HERE/scenarios.json').scenarios.find(x => x.id === '$SCENARIO_ID');
  if (!s) { console.error('unknown scenario: $SCENARIO_ID'); process.exit(2); }
  process.stdout.write(s.prompt);
")"

STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_DIR="$HERE/runs/$STAMP-$SCENARIO_ID"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/suffuse-cold.XXXXXX")"
mkdir -p "$RUN_DIR"

echo "scenario : $SCENARIO_ID"
echo "prompt   : $PROMPT"
echo "workdir  : $WORK"
echo "results  : $RUN_DIR"

# ── Cold checkout ───────────────────────────────────────────────────────────
if [ "$MODE" = "--local" ]; then
  echo "checkout : LOCAL working tree (not a cold clone)"
  git -C "$REPO_ROOT" archive HEAD | tar -x -C "$WORK"
else
  git clone --depth 1 "$REPO_URL" "$WORK/suffuse" >/dev/null 2>&1
  WORK="$WORK/suffuse"
fi
(cd "$WORK" && npm install --silent)

# ── Where the coldness actually comes from ──────────────────────────────────
# HOME stays REAL: overriding it breaks the CLI's auth chain (login state
# spans ~/.claude.json, credential files, and the macOS Keychain — measured
# 2026-08-18: every partial copy produced "Not logged in" or a stale-token
# refresh failure). The agent is cold anyway, because context is keyed to the
# working directory, not to HOME:
#   - CLAUDE.md files load from the cwd's ANCESTORS, and this checkout lives
#     under $TMPDIR — outside any directory tree carrying user context;
#   - project memory is keyed to the (fresh) project path — empty;
#   - the checkout itself ships no CLAUDE.md.
# Residual warmth accepted and disclosed: user-level settings/hooks and
# ~/.claude/CLAUDE.md if the machine has one (this harness cannot remove
# those without breaking auth — note it in SCORE.md if either applies).
# Suffuse holds stay in the real ~/.suffuse on purpose: the hold file is the
# MACHINE-GLOBAL contention lock, and isolating it would defeat the lock.
RECEIPTS="$RUN_DIR/receipts"
mkdir -p "$RECEIPTS"

# ── The cold agent ──────────────────────────────────────────────────────────
# One prompt, no extra context. The agent must orient from README/SKILL.md.
# The observer's job: watch the room, then score against the rubric in
# README.md. Transcript is captured for the ordering checks (scan before
# write, gates before writes).
echo "--- agent starts; watch the room ---"
# Headless -p cannot prompt for tool permission, so Bash is pre-allowed. The
# safety being evaluated is Suffuse's own gate discipline (dry-run, confirm,
# receipt), which lives below the harness — pre-allowing the shell does not
# grade the agent's homework for it. Override with CLAUDE_ARGS.
(
  cd "$WORK"
  "$CLAUDE_BIN" -p \
    "$PROMPT

(You are in a checkout of a lighting-control project; its README.md and SKILL.md explain what is available. There are real lights in this room. Write any receipts to $RECEIPTS/.)" \
    ${CLAUDE_ARGS:---allowedTools Bash,Read,Glob,Grep,Write} 2>&1 | tee "$RUN_DIR/transcript.txt"
)

# ── Evidence collection ─────────────────────────────────────────────────────
# Receipts were written straight into the run dir; snapshot the machine-global
# holds so the scorer can check every TTL was bounded.
cp -R "$HOME/.suffuse/holds" "$RUN_DIR/holds" 2>/dev/null || true
{
  echo "scenario: $SCENARIO_ID"
  echo "date: $STAMP"
  echo "mode: ${MODE:---cold-clone}"
  echo "score: (fill in 0-2 per dimension: orientation, discovery, transport, safety, aesthetics, honesty)"
  echo "room-observed: (what the lights actually did)"
} > "$RUN_DIR/SCORE.md"

echo "--- done; score the run in $RUN_DIR/SCORE.md ---"
