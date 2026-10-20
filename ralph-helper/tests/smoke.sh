#!/usr/bin/env bash
# TC-114 (success) / TC-115 (failure, then resume): drives ralph-helper headless on a
# toy python repo and asserts the git and state results. Costs real model calls.
# usage: smoke.sh success|failure [parent-dir]    env: SMOKE_MODEL, SMOKE_BUDGET (USD, default 10)
set -euo pipefail

MODE="${1:?usage: smoke.sh success|failure [parent-dir]}"
PLUGIN="$(cd "$(dirname "$0")/.." && pwd)"
PARENT="${2:-$(mktemp -d)}"
WORK="$PARENT/calc-$MODE"
rm -rf "$WORK" && mkdir -p "$WORK/tests" && cd "$WORK"

fail() { echo "(fail) $MODE: $*"; exit 1; }
ok() { echo "(pass) $MODE: $*"; }
state() { python3 -c "import json,sys; s=json.load(open('logs/calc/ralph-helper.json')); print(eval(sys.argv[1]))" "$1"; }
# User settings stay out (no personal hooks or plugins); the plugin comes from this checkout.
ralph() {
  claude -p --plugin-dir "$PLUGIN" --setting-sources project --permission-mode bypassPermissions \
    --max-budget-usd "${SMOKE_BUDGET:-10}" ${SMOKE_MODEL:+--model "$SMOKE_MODEL"} "$1" \
    < /dev/null > "$PARENT/calc-$MODE.$2.log" 2>&1 || true
  echo "ran $1 (log: $PARENT/calc-$MODE.$2.log)"
}

git init -q -b main
echo '"""Tiny calculator built by the smoke plan."""' > calc.py
touch tests/__init__.py
if [ "$MODE" = failure ]; then
  cat > tests/test_guard.py <<'EOF'
import unittest


class TestGuard(unittest.TestCase):
    def test_guard(self):
        self.fail("guard: stays red until a human fixes it")
EOF
  cat > calc.md <<'EOF'
# Calc

Tests use the standard library: `python3 -m unittest -v`.

### Do not modify
- tests/test_guard.py

## Phase 1: add
Add `add(a, b)` to calc.py, returning a + b. Estimate: 1

### Tests
- TestAdd.test_add in tests/test_add.py: add(2, 3) == 5

### Done When
- `python3 -m unittest -v` exits 0
EOF
else
  cat > calc.md <<'EOF'
# Calc

Tests use the standard library: `python3 -m unittest -v`.

## Phase 1: add
Add `add(a, b)` to calc.py, returning a + b. Estimate: 2

### Tests
- TestAdd.test_add in tests/test_add.py: add(2, 3) == 5

### Done When
- `python3 -m unittest -v` exits 0

## Phase 2: mul
Add `mul(a, b)` to calc.py, returning a * b. Estimate: 2

### Tests
- TestMul.test_mul in tests/test_mul.py: mul(2, 3) == 6

### Done When
- `python3 -m unittest -v` exits 0, add's test still passes
EOF
fi
git add -A && git -c user.name=smoke -c user.email=smoke@example.invalid commit -qm init
export GIT_AUTHOR_NAME=smoke GIT_AUTHOR_EMAIL=smoke@example.invalid GIT_COMMITTER_NAME=smoke GIT_COMMITTER_EMAIL=smoke@example.invalid

ralph "/ralph-helper:go calc.md --yes" go
[ -f logs/calc/ralph-helper.json ] || fail "no state file"
[ "$(git branch --show-current)" = ralph/calc ] || fail "branch is $(git branch --show-current)"
[ -z "$(git status --porcelain)" ] || fail "tree not clean: $(git status --porcelain | head -3)"
[ -z "$(git ls-files logs)" ] || fail "logs/ is tracked"
[ -z "$(git log --all --name-only --format= | grep -E '__pycache__|\.pyc$')" ] || fail "a commit holds __pycache__/*.pyc"
ok "state file, branch ralph/calc, clean tree, logs/ untracked, no cache files committed"

if [ "$MODE" = success ]; then
  [ "$(git log --format=%s main..HEAD | grep -c '^ralph-helper(calc): phase')" = 2 ] || fail "phase commits: $(git log --oneline main..HEAD)"
  git rev-parse -q --verify refs/tags/ralph-helper/calc/phase-1 >/dev/null || fail "no tag phase-1"
  git rev-parse -q --verify refs/tags/ralph-helper/calc/phase-2 >/dev/null || fail "no tag phase-2"
  ok "2 phase commits, tags phase-1 and phase-2"
  [ "$(state "s['status']")" = done ] || fail "run status $(state "s['status']")"
  [ "$(state "all(p['status']=='done' and p['test_exit']==0 and (p['test_count'] or 0)>0 for p in s['phases'])")" = True ] \
    || fail "phases: $(state "[(p['status'],p['test_exit'],p['test_count']) for p in s['phases']]")"
  ok "state done, every phase test_exit 0 and test_count > 0"
  [ "$(python3 -c "import json; print(len(json.load(open('logs/calc/learnings.json'))['entries']))")" = 2 ] || fail "learnings.json entries"
  ok "learnings.json valid with 2 entries"
else
  [ "$(state "s['phases'][0]['status']")" = failed ] || fail "phase 1 status $(state "s['phases'][0]['status']")"
  [ "$(state "s['phases'][0]['attempts']")" = 3 ] || fail "attempts $(state "s['phases'][0]['attempts']")"
  git stash list | grep -q "ralph-helper calc phase 1 failed attempt" || fail "no stash: $(git stash list)"
  [ "$(git rev-parse HEAD)" = "$(state "s['phases'][0]['start_sha']")" ] || fail "HEAD is not start_sha"
  python3 -c "import json; e=json.load(open('logs/calc/learnings.json'))['entries']; assert any(x['outcome']=='failure' for x in e)" \
    || fail "no failure entry in learnings.json"
  ok "phase 1 failed after 3 attempts, attempt stashed, HEAD at start_sha, failure learned"

  sed -i.bak 's/self.fail(.*/self.assertTrue(True)/' tests/test_guard.py && rm tests/test_guard.py.bak
  git commit -qam "fix guard"
  ralph "/ralph-helper:resume calc.md" resume
  [ "$(state "s['phases'][0]['status']")" = done ] || fail "after resume phase 1 is $(state "s['phases'][0]['status']")"
  [ "$(state "s['status']")" = done ] || fail "after resume run status $(state "s['status']")"
  [ -z "$(git status --porcelain)" ] || fail "tree not clean after resume"
  ok "resume reran phase 1 to done"
fi
echo "smoke $MODE: all pass ($WORK)"
