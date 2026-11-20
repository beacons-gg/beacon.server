#!/usr/bin/env bash
# The tag of the release about to be cut (.github/workflows/release.yml).
#
#   git ls-remote --tags origin | sed -n 's#.*refs/tags/##p' | scripts/next-release-tag.sh [<tag>]
#
# Every Beacon repository versions its releases `v<major>.<minor>.<patch>` (a copy of one script;
# the repositories share no tooling). With no argument: the next patch after the highest release
# already cut, or `v0.1.0` for a repository with none yet. Dated tags (`v0.0.0-<yymmdd>-<n>`) from
# before this scheme are ignored. With an argument: that tag, once it is checked to be a version
# (`v1.2.3`, or a prerelease `v1.2.3-rc.1`), not to exist already, and to be newer than the highest
# release, so a minor or a major is cut by naming it.
#
# The existing tags come on stdin, one per line, so the workflow decides where they come from (the
# remote: a runner's checkout holds none) and this can be run by hand against any list.
set -euo pipefail

requested=${1:-}
existing=$(cat)

# The releases cut so far: plain versions only, highest last. A prerelease or a dated tag is not one.
releases=$(grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' <<<"$existing" | sort -V || true)
highest=$(tail -n 1 <<<"$releases")

if [ -z "$requested" ]; then
  if [ -z "$highest" ]; then
    echo "v0.1.0"
  else
    IFS=. read -r major minor patch <<<"${highest#v}"
    echo "v$major.$minor.$((patch + 1))"
  fi
  exit 0
fi

if ! [[ "$requested" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-(rc|alpha|beta)\.[0-9]+)?$ ]]; then
  echo "\"$requested\" is not a release tag: expected v<major>.<minor>.<patch>, optionally -rc.<n>, -alpha.<n> or -beta.<n>" >&2
  exit 2
fi
if grep -qxF -- "$requested" <<<"$existing"; then
  echo "the tag $requested already exists: a release is cut once" >&2
  exit 2
fi
# Newer than the highest release: a prerelease of a version counts as before that version.
base=${requested%%-*}
if [ -n "$highest" ] && [ "$(printf '%s\n%s\n' "$highest" "$base" | sort -V | tail -n 1)" != "$base" ] \
  || [ "$base" = "$highest" ]; then
  echo "$requested is not newer than $highest, the highest release already cut" >&2
  exit 2
fi
echo "$requested"
