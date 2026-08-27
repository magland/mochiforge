#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:?usage: create-example.sh <root-dir>}"

if [ -e "$ROOT" ]; then
  echo "error: $ROOT already exists; remove it first" >&2
  exit 1
fi

mkdir -p "$ROOT"
ROOT="$(cd "$ROOT" && pwd)"

# Where a collection keeps its repositories, and everything they keep beside
# them. See docs/vault.md for the layout this follows.
repos_dir() {
  echo "$ROOT/collections/$1/repos"
}

new_workdir() {
  local tmp
  tmp="$(mktemp -d)"
  git -C "$tmp" init -q -b main
  git -C "$tmp" config user.name "Example Author"
  git -C "$tmp" config user.email "author@example.org"
  echo "$tmp"
}

publish() {
  local tmp="$1" collection="$2" name="$3" desc="$4" dir
  dir="$(repos_dir "$collection")"
  mkdir -p "$dir"
  git clone --bare -q "$tmp" "$dir/$name.git"
  echo "$desc" > "$dir/$name.git/description"
  rm -rf "$tmp"
}

# ---- alice/hello-numerics ----

T="$(new_workdir)"
cat > "$T/README.md" <<'EOF'
# hello-numerics

A small collection of numerical routines used as example content.

## Usage

```python
from src.compute import mean
print(mean([1, 2, 3]))
```

See [the notes](docs/notes.md) for background.
EOF
mkdir -p "$T/src" "$T/docs"
cat > "$T/src/compute.py" <<'EOF'
"""Basic numerical routines."""


def mean(xs):
    if len(xs) == 0:
        raise ValueError("mean of empty sequence")
    return sum(xs) / len(xs)


def variance(xs):
    m = mean(xs)
    return sum((x - m) ** 2 for x in xs) / len(xs)
EOF
cat > "$T/docs/notes.md" <<'EOF'
# Notes

These routines are intentionally simple. They exist to give the file browser something to display.
EOF
git -C "$T" add -A
git -C "$T" commit -q -m "Initial commit with mean and variance"

cat > "$T/src/util.py" <<'EOF'
def clamp(x, lo, hi):
    return max(lo, min(hi, x))
EOF
git -C "$T" add -A
git -C "$T" commit -q -m "Add clamp utility"
git -C "$T" tag v0.1.0

cat >> "$T/src/compute.py" <<'EOF'


def stddev(xs):
    return variance(xs) ** 0.5
EOF
git -C "$T" add -A
git -C "$T" commit -q -m "Add stddev" -m "Computed as the square root of the population variance. This commit also demonstrates a multi-line commit message body."

git -C "$T" checkout -q -b dev
cat > "$T/src/experimental.py" <<'EOF'
def median(xs):
    ys = sorted(xs)
    n = len(ys)
    if n == 0:
        raise ValueError("median of empty sequence")
    mid = n // 2
    if n % 2 == 1:
        return ys[mid]
    return (ys[mid - 1] + ys[mid]) / 2
EOF
git -C "$T" add -A
git -C "$T" commit -q -m "Experimental median implementation"
git -C "$T" checkout -q main

cat > "$T/Makefile" <<'EOF'
test:
	python -m pytest
EOF
git -C "$T" add -A
git -C "$T" commit -q -m "Add Makefile"
mkdir -p "$T/.github/workflows"
cat > "$T/.github/workflows/ci.yml" <<'EOF'
name: CI
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      note:
        description: Something to print in the log
        default: hello from the dispatch form
env:
  PROJECT: hello-numerics
jobs:
  check:
    runs-on: ubuntu-latest
    outputs:
      files: ${{ steps.count.outputs.files }}
    steps:
      - name: Describe the checkout
        run: |
          echo "$PROJECT at ${GITHUB_SHA:0:8} on $GITHUB_REF_NAME"
          echo "event: $GITHUB_EVENT_NAME"
      - name: Count the sources
        id: count
        run: echo "files=$(ls src/*.py | wc -l)" >> "$GITHUB_OUTPUT"
      - name: Say what was dispatched
        if: github.event_name == 'workflow_dispatch'
        run: echo "${{ inputs.note }}"
  report:
    needs: check
    runs-on: ubuntu-latest
    strategy:
      matrix:
        style: [short, long]
    steps:
      - name: Report
        run: |
          echo "style=${{ matrix.style }}"
          echo "the check job found ${{ needs.check.outputs.files }} python files"
EOF
git -C "$T" add -A
git -C "$T" commit -q -m "Add a CI workflow"

git -C "$T" tag v0.2.0

publish "$T" alice hello-numerics "Small numerical routines (example repository)"

# ---- alice/webapp ----

T="$(new_workdir)"
cat > "$T/README.md" <<'EOF'
# webapp

A tiny static web page, used to exercise HTML, CSS, and TypeScript highlighting.
EOF
cat > "$T/index.html" <<'EOF'
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>webapp</title>
    <link rel="stylesheet" href="styles.css">
  </head>
  <body>
    <h1>Hello</h1>
    <script src="main.js"></script>
  </body>
</html>
EOF
cat > "$T/styles.css" <<'EOF'
body {
  font-family: sans-serif;
  margin: 2rem;
}
EOF
git -C "$T" add -A
git -C "$T" commit -q -m "Initial page"

cat > "$T/main.ts" <<'EOF'
interface Greeting {
  who: string;
}

function greet(g: Greeting): string {
  return `Hello, ${g.who}`;
}

console.log(greet({ who: "world" }));
EOF
git -C "$T" add -A
git -C "$T" commit -q -m "Add TypeScript entry point"

publish "$T" alice webapp "A tiny static web page (example repository)"

mkdir -p "$(repos_dir alice)/webapp.site"
cat > "$(repos_dir alice)/webapp.site/index.html" <<'EOF'
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>webapp site</title>
    <link rel="stylesheet" href="styles.css">
  </head>
  <body>
    <h1>webapp</h1>
    <p>This site is served from the <code>alice/webapp.site</code> directory, next to the bare repository.</p>
    <p><a href="about.html">About</a></p>
  </body>
</html>
EOF
cat > "$(repos_dir alice)/webapp.site/styles.css" <<'EOF'
body { font-family: sans-serif; margin: 3rem auto; max-width: 40rem; padding: 0 1rem; }
h1 { color: #2a6f97; }
EOF
cat > "$(repos_dir alice)/webapp.site/about.html" <<'EOF'
<!doctype html>
<html>
  <head><meta charset="utf-8"><title>About</title><link rel="stylesheet" href="styles.css"></head>
  <body><h1>About</h1><p>A minimal example site.</p><p><a href="./">Home</a></p></body>
</html>
EOF
cat > "$(repos_dir alice)/webapp.site/404.html" <<'EOF'
<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Not found</title><link rel="stylesheet" href="styles.css"></head>
  <body><h1>404</h1><p>No such page here.</p><p><a href="./">Home</a></p></body>
</html>
EOF
# Sites are opt-in per repository: the directory alone publishes nothing until
# the site is enabled in <repo>.git/site.json.
cat > "$(repos_dir alice)/webapp.git/site.json" <<'EOF'
{
  "enabled": true,
  "source": "copy",
  "label": ""
}
EOF

# ---- bob/notes ----

T="$(new_workdir)"
cat > "$T/README.md" <<'EOF'
# notes

Plain markdown notes, nothing else.
EOF
cat > "$T/2026-01-ideas.md" <<'EOF'
# Ideas

- A filesystem-backed git host
- Static sites built from a branch
EOF
git -C "$T" add -A
git -C "$T" commit -q -m "Start notes"
cat > "$T/2026-02-followup.md" <<'EOF'
# Follow-up

The directory layout is root/collections/collection/repos/repo.git. No database is
involved.
EOF
git -C "$T" add -A
git -C "$T" commit -q -m "Add follow-up note"

publish "$T" bob notes "Markdown notes (example repository)"

# ---- bob/empty ----

mkdir -p "$(repos_dir bob)"
git init -q --bare -b main "$(repos_dir bob)/empty.git"
echo "An empty repository for testing" > "$(repos_dir bob)/empty.git/description"

# ---- issues on alice/hello-numerics ----

# Issues are files, so the example vault seeds them the same way it seeds
# repositories: by writing the directories out.

issue() {
  local repo="$1" n="$2" state="$3" title="$4" author="$5" label="$6" body="$7" dir
  dir="$(repos_dir "${repo%%/*}")/${repo#*/}.issues"
  mkdir -p "$dir/$n/comments"
  cat > "$dir/$n/issue.md" <<EOF
---
title: $title
state: $state
author: $author
created: 2026-02-11T09:14:00.000Z
updated: 2026-02-12T16:02:00.000Z
labels:
  - $label
---
$body
EOF
}

issue alice/hello-numerics 1 open "variance() divides by zero for a single sample" author bug \
"Calling \`variance([1])\` raises \`ZeroDivisionError\` instead of returning 0 or raising
something the caller can read.

\`\`\`python
>>> from src.compute import variance
>>> variance([1])
ZeroDivisionError: division by zero
\`\`\`

The guard in \`mean()\` is the shape this wants."

cat > "$(repos_dir alice)/hello-numerics.issues/1/comments/1.md" <<'EOF'
---
author: dev
created: 2026-02-12T16:02:00.000Z
---
Agreed. Sample variance of one sample is undefined, so raising `ValueError`
with a sentence in it seems better than returning zero.
EOF

issue alice/hello-numerics 2 closed "Document the Makefile targets" dev documentation \
"The README shows the Python usage but never says that \`make test\` exists."
sed -i 's/^state: closed$/state: closed\nclosedBy: author\nclosedAt: 2026-02-13T11:20:00.000Z/' \
  "$(repos_dir alice)/hello-numerics.issues/2/issue.md"

# ---- vault.json with two users (fixed tokens, example vault only) ----

# 'dev' is a site admin and owns the vault. 'reader' can read everything
# public and write nothing, which is what half of the authorization checks
# need: a token that is perfectly valid and still not allowed to do the thing
# being asked.
DEV_TOKEN="mochi_example_dev_token"
DEV_HASH="$(printf %s "$DEV_TOKEN" | sha256sum | cut -d' ' -f1)"
READER_TOKEN="mochi_example_reader_token"
READER_HASH="$(printf %s "$READER_TOKEN" | sha256sum | cut -d' ' -f1)"
cat > "$ROOT/vault.json" <<EOF
{
  "version": 2,
  "users": {
    "dev": {
      "tokens": [{ "hash": "$DEV_HASH", "id": "exampledev" }],
      "siteAdmin": true
    },
    "reader": {
      "tokens": [{ "hash": "$READER_HASH", "id": "examplerdr" }]
    }
  }
}
EOF

echo "Example content created under $ROOT"
echo ""
echo "Sign in on the web (or push) as user 'dev' with token: $DEV_TOKEN"
echo "A read-only user is there too: 'reader' with token: $READER_TOKEN"
echo "These fixed tokens are for the example vault only."
