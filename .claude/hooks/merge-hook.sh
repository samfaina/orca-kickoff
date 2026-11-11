#!/bin/sh
# Claude Code PreToolUse hook, added by the setup-ship-tickets skill.
#
# Approves a plain `gh pr merge` of a PR that belongs to this repo, so
# Merge approval `auto` can merge in auto mode. Asks a human about an External
# PR: one whose head branch lives in another repo, or that belongs to another
# repo. Also asks about any other form of `gh pr merge`, and when gh fails.
#
# It only ever adds an approval. If it can't run, nothing approves the merge and
# Claude Code's usual permission checks decide.
#
# Needs sh, sed and gh. Decisions go to stdout as JSON, and it always exits 0.

export GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1

decide() {
  # $1 is allow or ask. The reason comes partly from gh, so keep it to one line
  # with no character that JSON would need escaped.
  reason=$(printf '%s' "$2" | tr '\r\n\t"\\' '     ' | cut -c1-400)
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"%s","permissionDecisionReason":"%s"}}\n' "$1" "$reason"
  exit 0
}

# The command as JSON holds it, escapes included. A key can't match inside
# another string, since the quotes in a string are escaped.
input=$(cat)
command=$(printf '%s' "$input" | sed -nE 's/.*"command"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p')

# Without quoted text, a commit message that names the command isn't a merge.
unquoted=$(printf '%s' "$command" | sed -E 's/\\"/"/g; s/"[^"]*"//g; s/'"'"'[^'"'"']*'"'"'//g')
if ! printf '%s' "$unquoted" | grep -Eq '(^|[^[:alnum:]_.-])gh(\.exe)?[[:space:]]+pr[[:space:]]+merge([^[:alnum:]_-]|$)'; then
  exit 0
fi

not_plain="This is not the plain command the ship-tickets loop runs, gh pr merge [selector] [-R repo] --merge|--squash|--rebase, so no automatic approval applies. Check what it does before you approve it."

# Only these characters: no shell syntax, comments, globs, quotes or escapes.
case $command in
  *[!A-Za-z0-9._/:=\ -]*) decide ask "$not_plain" ;;
esac

set -f
# shellcheck disable=SC2086 # Splitting into words is the point.
set -- $command
set +f

[ "$1 $2 $3" = 'gh pr merge' ] || decide ask "$not_plain"
shift 3

selector='' repo='' method=''
while [ $# -gt 0 ]; do
  case $1 in
    --merge | --squash | --rebase)
      [ -z "$method" ] || decide ask "$not_plain"
      method=$1
      ;;
    -R | --repo)
      [ -z "$repo" ] && [ $# -ge 2 ] || decide ask "$not_plain"
      case $2 in -* | '') decide ask "$not_plain" ;; esac
      repo=$2
      shift
      ;;
    --repo=?*)
      [ -z "$repo" ] || decide ask "$not_plain"
      repo=${1#--repo=}
      ;;
    -*) decide ask "$not_plain" ;;
    *)
      [ -z "$selector" ] || decide ask "$not_plain"
      selector=$1
      ;;
  esac
  shift
done
[ -n "$method" ] || decide ask "$not_plain"

# The same lookup gh pr merge does, from the same directory, so both find the
# same PR. Prints "<isCrossRepository> <url>".
view_pr() {
  gh pr view ${selector:+"$selector"} ${repo:+--repo "$repo"} --json isCrossRepository,url \
    --jq '(.isCrossRepository | tostring) + " " + .url' </dev/null 2>&1 | tr -d '\r'
}

pr=$(view_pr)
case $pr in
  'true '* | 'false '*) ;;
  *)
    sleep 2
    pr=$(view_pr)
    ;;
esac
case $pr in
  'true '* | 'false '*) ;;
  *) decide ask "Could not check whether this PR is external, so it needs your approval. gh said: $pr" ;;
esac
cross=${pr%% *}
url=${pr#* }

# The repo that holds this hook, whatever the session's directory or GH_REPO.
project=$(
  unset GH_REPO
  cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null && gh repo view --json url --jq .url </dev/null 2>&1 | tr -d '\r'
)
case $project in
  https://* | http://*) ;;
  *) decide ask "Could not tell which repo this hook belongs to, so this PR needs your approval. gh said: $project" ;;
esac

if [ "$cross" = true ]; then
  decide ask "External PR: the head branch of $url lives in another repo. Merge it only after a human has reviewed it."
fi
if [ "${url%/pull/*}" != "$project" ]; then
  decide ask "External PR: $url does not belong to $project. Merge it only after a human has reviewed it."
fi

decide allow "$url belongs to $project and its head branch does too."
