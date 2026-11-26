#!/usr/bin/env bash
# Fails when a change to what the extension loads arrives without a higher
# version. Copy details reports this version, so it must identify the build.
#   scripts/check-version-bump.sh <base-commit> [head-commit]
set -euo pipefail
base=$1
head=${2:-HEAD}
manifest=Bouncer/manifest.base.json

# Everything under Bouncer/ ships except tests, docs and development tooling.
changed=$(git diff --name-only "$base...$head" -- Bouncer \
  ':!Bouncer/tests' ':!Bouncer/*.md' ':!Bouncer/.gitignore' ':!Bouncer/.nvmrc' \
  ':!Bouncer/package.json' ':!Bouncer/package-lock.json' ':!Bouncer/eslint.config.mjs' \
  ':!Bouncer/tsconfig.json' ':!Bouncer/tsconfig.test.json' ':!Bouncer/vitest.config.js')
if [ -z "$changed" ]; then
  echo "No extension files changed, so no version bump is needed."
  exit 0
fi

version_at() {
  git show "$1:$manifest" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).version)'
}
old=$(version_at "$base")
new=$(version_at "$head")
if [ "$old" != "$new" ] && [ "$(printf '%s\n%s\n' "$old" "$new" | sort -V | tail -n 1)" = "$new" ]; then
  echo "Extension files changed and the version went from $old to $new."
  exit 0
fi
echo "These extension files changed, but the version in $manifest did not go up ($old to $new):"
printf '  %s\n' $changed
echo "Raise the version in $manifest, Bouncer/package.json and Bouncer/package-lock.json:"
echo "major for a change that needs new setup or drops saved data, minor for new behaviour, patch for a fix."
exit 1
