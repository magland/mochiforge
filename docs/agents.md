# Mochi Forge for an agent

Short enough to paste into a context window. If you know `gh`, most of this will be guesses you would have made anyway. The command and the package are spelled `mochi`, the short form of the name.

## Authenticating

No keyring, no writable home directory, and nothing to configure:

```bash
export MOCHI_HOST=https://vault.example.com
export MOCHI_TOKEN="$(cat /run/secrets/mochi)"
mochi whoami --json
```

`--host` and `--token` override the environment for a single command; `--token-stdin` reads the token from stdin so it appears in neither argv nor shell history. A token is the same credential git uses as a Basic-auth password, so `git clone https://<user>:<token>@vault.example.com/<collection>/<repo>` works with no further setup.

## Naming a repository

A repository is `<collection>/<repo>`. Which one a command means is resolved in this order:

1. the positional argument, or `--repo <collection>/<repo>`
2. `MOCHI_REPO`
3. the git remote in the current directory that points at the vault, preferring `origin`

So inside a clone you can leave it out. A remote for another host is not an answer.

## Output and exit codes

Every read takes `--json`, which puts one JSON value on stdout and every diagnostic on stderr. A comma-separated field list keeps only those fields: `--json=number,title,state`, or `--json number,title` when it names more than one. On failure `--json` still gives `{"error": "..."}`, on stderr.

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Generic failure |
| 2 | Usage error: unknown command, unknown flag, missing argument |
| 3 | No token, or the vault rejected it |
| 4 | Not found |
| 5 | Conflict: it already exists, or someone got there first, or it will not apply |

Branch on 4 and 5. They are the two that answer the questions worth retrying on.

## The commands

`mochi commands --json` dumps the whole command set as data, which is more reliable than this list.

```
repo      list view create fork edit rename delete clone
branch    list create delete
tag       list create delete
file      list view write delete
commit    list view
diff      <base>...<head>
search    <query>
collab    list add remove   roles on a repository: read, write, admin
issue     list view create edit comment close reopen
pr        list view create diff comment merge checks close reopen export
release   list view create edit delete
workflow  list run
run       list view watch cancel rerun download exec-command
job       run               execute a run's manual jobs here, from a minted command
user      add grant list view delete token list token revoke
runner    add run list wake remove
config    view set
collection add list rename delete owner add owner remove
backup    <dir>             pull a whole vault onto this machine; list verify prune
api       <path>            any route, for anything without a typed command
```

Everything destructive takes `--yes` and refuses without it. Nothing prompts.

Bodies come from `--body`, `--body-file <path>`, or `--body-file -` for stdin. Prefer a file: an issue body is frequently longer than a shell argument should be.

## Reading and writing a file safely

`file write` on a branch that has moved since you read it will overwrite whatever arrived meanwhile, unless you say what you saw:

```bash
sha="$(mochi file view config.json --json=commit | jq -r .commit)"
# work out the new content
mochi file write config.json --expected-sha "$sha" --body-file new.json
```

That exits 5 if the branch moved. Several files as one commit is one call:

```bash
mochi api repos/demo/proj/commits -X POST --field branch=main \
  --raw-field message='Change three things' --input files.json
```

A commit made this way is a push as far as workflows are concerned, so it triggers the same runs a `git push` would.

## Proposing a change

```bash
mochi branch create fix-thing
mochi file write src/thing.ts --branch fix-thing --body-file patched.ts
mochi pr create --base main --head fix-thing --title 'Fix the thing'
mochi api repos/demo/proj/pulls/7/merge     # would it apply? ask before merging
mochi pr merge 7 --squash --delete-branch
```

The mergeability read is worth making first. A merge that does not apply exits 5 and names the conflicting paths.

## Watching a workflow

```bash
mochi workflow run .github/workflows/test.yml --field target=all
mochi run watch 42 --exit-status
mochi run view 42 --log          # the failed job's log, last 200 lines
mochi run view 42 --log --tail 0 # all of it
```

A vault with no runner registered queues its runs and never finishes them, so a watch there reaches its timeout; `mochi runner list --json` says whether a runner is connected, what it is holding, and which jobs are waiting for one, which is the answer when a run has not started rather than not finished. `run view --log` picks the failed job, or the only job, and asks when neither applies.

One kind of queued job is waiting for a person rather than for a runner, and starting a runner would not help it: a job whose `runs-on` names the reserved label `manual` waits until somebody pastes a command on the machine that should execute it. `runner list --json` marks it, carrying `"manual": true` on that entry in `queued`, and `mochi run exec-command <n>` mints the command. Hand that command to the user rather than running it: the process it starts shows every step and executes nothing until a person agrees, which is the point of the mode, and `--yes` skips exactly that. See [Manual jobs](workflows.md#manual-jobs-run-by-pasting-a-command).

Note that `actions/checkout` with a `repository:` names a repository in this vault, not on github.com. A workflow copied from GitHub that checks out a second repository has to clone it with git instead.

## The API directly

Under `/api`, bearer token only, JSON in and out. Session cookies never authorize an API call and a bearer token never authorizes an HTML form post. Reading a public repository takes any valid token; a private one takes a role on it, and without one answers the same 404 an absent repository does. Writing takes the write role; renaming, deleting, visibility, and collaborators take the admin role, which collection owners and site admins hold implicitly; users, runners, and vault settings take a site admin. See [The JSON API](api.md) for every route.

`mochi api <path>` is the escape hatch and takes the path with or without the leading slash and with or without the `api/` prefix. `--field k=v` builds a JSON body coercing `true`, `false`, `null`, and integers; `--raw-field` keeps strings; `--input <file>` sends a file or stdin. Only the path is used from a full URL, so a token is never sent to a host you did not configure.

## What Mochi Forge does not have

The most useful part of this document. Do not go looking for these; they are not hidden, they do not exist.

- **No reactions,** on anything.
- **No review threads, no approvals, no requested reviewers, no suggested changes.** A pull request has a body and comments, and that is all.
- **No assignees, no milestones, no projects, no labels on pull requests.** Issues have labels and repositories have topics (`repo edit --topic`, lowercase-and-hyphens, narrowing `repo list --topic` and the listings); nothing else carries either.
- **No notifications, no watching, no stars, no forks graph.** Forking copies a repository and records its parent; nothing subscribes to anything.
- **No webhooks and no outbound HTTP of any kind.** Nothing in the vault calls anything.
- **No check suites and no commit statuses.** `pr checks` reports the workflow runs whose commit is the pull request's head, which is the nearest thing there is, and that is all it means.
- **No release assets.** A release's downloads are the source archives; there is nothing to upload.
- **No search across repositories.** Search is literal, within one repository, at one ref.
- **No pagination protocol.** `--limit` and the server's own caps are what there is. A vault's collections are small.
- **No secrets for workflows** yet. A job for a private repository carries an ephemeral read token for its own clone and nothing else, so a workflow cannot push or call the vault's API as itself.
- **No `actions/cache`, no Docker actions, no `container:` jobs, no service containers.**
- **No organizations, no teams.** A user owns the collection named after them; collections list owners, repositories list collaborators with roles (read, write, admin), a repository may be private, and site admins hold everything. That is the whole model.
- **No `mochi restore`.** `mochi backup <dir>` makes a copy whose `<dir>/current` is itself a vault, so restoring is `mochi serve <dir>/current` or copying that directory onto a host. Nothing reconciles a backup against a running vault.

Where a capability is missing, the honest workaround is usually git itself: clone, push, and let the vault notice.
