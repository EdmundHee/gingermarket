#!/usr/bin/env bash
# Prints the project's vault folder, or nothing when there is none.
# usage: vault-dir.sh <notesDir> [repo-root]
# Project = <notesDir>/_tools/groups.json projects.<name>.repo[] match (case-insensitive),
# else the repo root's basename. The folder must already exist: never created here.
# Plain string compares only, so glob characters in a repo name match literally.
set -euo pipefail

notes="${1:-}"
repo="${2:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# Empty, or the unsubstituted placeholder of an unset plugin option: no vault.
case "$notes" in '' | '${user_config.'*) exit 0 ;; esac

python3 - "$notes" "$repo" <<'PY'
import json, os, sys

notes, repo = (os.path.expanduser(a.rstrip('/')) for a in sys.argv[1:3])
name = None
try:
    with open(os.path.join(notes, '_tools', 'groups.json')) as f:
        projects = json.load(f).get('projects', {})
    # ponytail: case-insensitive, as macOS paths are; two such repos on a case-sensitive volume would collide
    name = next((n for n, p in projects.items()
                 if any(r.rstrip('/').lower() == repo.lower() for r in p.get('repo', []))), None)
except (OSError, ValueError, AttributeError):
    pass
# ponytail: basename fallback lets two unregistered repos with one name share a folder; register them in groups.json
name = name or os.path.basename(repo)
folder = os.path.join(notes, name)
if os.path.isdir(folder):
    print(folder)
else:
    tool = os.path.join(notes, '_tools', 'new_project.sh')
    hint = f' Create it with {tool}.' if os.path.exists(tool) else ''
    print(f'vault-dir: no folder {folder} for this repo; vault memory skipped.{hint}', file=sys.stderr)
PY
