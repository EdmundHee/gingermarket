#!/usr/bin/env bash
# TC-109..113: scripts/vault-dir.sh. One function per row; prints "(pass) name" or exits 1.
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/vault-dir.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

expect() { # name, actual, expected
  if [ "$2" = "$3" ]; then echo "(pass) $1"; else echo "(fail) $1: got '$2', want '$3'"; exit 1; fi
}

groups_match_case_insensitive() {
  local v="$TMP/g"; mkdir -p "$v/_tools" "$v/syph"
  echo '{"projects": {"syph": {"group": "product", "repo": ["/R/Api"]}}}' > "$v/_tools/groups.json"
  expect groups_match_case_insensitive "$("$SCRIPT" "$v" /r/api 2>/dev/null)" "$v/syph"
}

basename_fallback() {
  local v="$TMP/b"; mkdir -p "$v/api"
  expect basename_fallback "$("$SCRIPT" "$v" /r/api 2>/dev/null)" "$v/api"
}

missing_folder_prints_nothing() {
  local v="$TMP/m"; mkdir -p "$v/_tools"; touch "$v/_tools/new_project.sh"
  local err; err="$("$SCRIPT" "$v" /r/api 2>&1 >/dev/null)"
  expect missing_folder_prints_nothing "$("$SCRIPT" "$v" /r/api 2>/dev/null)" ""
  case "$err" in *_tools/new_project.sh*) ;; *) echo "(fail) missing_folder_prints_nothing: hint '$err'"; exit 1 ;; esac
}

empty_notesdir_is_no_vault() {
  [ -z "$("$SCRIPT" '${user_config.notesDir}' /r/api 2>&1)" ] || { echo "(fail) empty_notesdir_is_no_vault: unset placeholder"; exit 1; }
  expect empty_notesdir_is_no_vault "$("$SCRIPT" "" /r/api 2>&1)" ""
}

glob_chars_match_literally() {
  local v="$TMP/x"; mkdir -p "$v/app1"
  expect glob_chars_match_literally "$("$SCRIPT" "$v" '/r/app*' 2>/dev/null)" ""
}

groups_match_case_insensitive
basename_fallback
missing_folder_prints_nothing
empty_notesdir_is_no_vault
glob_chars_match_literally
echo "5 pass"
