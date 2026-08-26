# The command line

The `mochi` command, how it is configured, how pushing is authorized, and the API underneath it.

Installing the package globally puts a `mochi` command on your PATH:

```bash
npm install -g @magland/mochi    # then: mochi --help
```

From a checkout, everything is available as `node dist/index.js <command>` after `npm run build`, or link the checkout to get the command while keeping your edits live:

```bash
npm run build
npm link          # then: mochi --help
```

Use `npm unlink -g @magland/mochi` to remove either one. Note that with a version manager such as fnm or nvm the link belongs to the active Node version, so switching versions hides it until you link again.

`mochi serve` is the only command that touches the vault directory (set it positionally or with `MOCHI_VAULT`). Every other command talks to a running server, so it works the same whether the vault is on your machine or across the network. Say which vault and with which token once, by logging in:

```bash
mochi login http://127.0.0.1:3000    # asks for the token, without echo
mochi whoami
mochi user list
mochi collection add mycollection
mochi import https://github.com/owner/repo mycollection
```

`mochi login` is the way to configure the CLI for a person at a keyboard: no token to re-supply per command, and nothing to set in the environment. The vault URL is remembered in `~/.config/mochi/login.json` (mode 0600) and the token goes to git's own credential store, which is where git needs it anyway for pushing, so a token is kept in one place rather than two (see [Not typing the token every time](#not-typing-the-token-every-time)). `mochi logout` undoes both.

Once logged in, `mochi web` opens the vault in the browser already signed in: it asks the vault for a one-time link (printed too, for machines without a browser), which lands on a page that names the account and signs in on a click. The link works once and expires after two minutes; `mochi web /alice/myrepo` says where to land. The browser session it starts is bound to the same token the CLI holds, so revoking that token signs the browser out as well.

A caller in a container is in a different position: it has no keyring, may have no writable home directory, and gets its secrets as environment variables. So `MOCHI_HOST` and `MOCHI_TOKEN` are honoured by every command that talks to a vault, and `--token-stdin` reads a token from stdin so that it appears in neither argv nor shell history. Precedence for both the host and the token is the same: the option, then the environment, then what `mochi login` left behind.

```bash
export MOCHI_HOST=https://vault.example.com
export MOCHI_TOKEN="$(cat /run/secrets/mochi)"
mochi whoami --json
```

(`mochi runner run` reads `MOCHI_RUNNER_TOKEN` as well, since a runner holds a token that is not any user's.)

`mochi deploy fly <app>` is the exception to the division above in one respect: it drives flyctl rather than a vault, since at the moment it runs there is no vault yet. It creates a vault on Fly.io, or deploys an update to an existing one, and on a new one it mints the owner token locally and prints it once the server has confirmed it, together with how to sign in on the web and the `mochi login` line that stores it for the CLI and git (see [Deploying a vault](deploying.md)). The deploy itself stores nothing: logging in stays a separate, deliberate step.

`mochi deploy fly runner <app>` is the one command that drives both at once: it registers a runner with the vault you are logged in to, and then creates the Fly app that will run it. The runner it deploys stops when it has been idle, and the vault starts it again when a job is waiting, which is the arrangement described in [Workflows](workflows.md#a-runner-that-stops-when-it-is-idle).

Note that login is a client-side arrangement only: it calls the server once to check who the token belongs to, and writes nothing but local files. `mochi runner run` is the one command that reads a configuration of its own, since a runner holds a token that is not any user's: it is a long-running process that takes workflow jobs from a vault and executes them locally in Docker (see [Workflows](workflows.md)).

`--host <url>` and `--token <t>` override the login per command, which is how you reach a second vault without logging out of the first. By default the server binds 127.0.0.1. Use `--host 0.0.0.0` on `serve` to expose it on the network; note that this exposes read access to every repository in the vault, and that tokens then travel over plain HTTP unless you put TLS in front. The first line of the `description` file inside a bare repository is shown in listings, as with classic git hosting.

## Finding your way around

Help is per command rather than one dump of all of them, which keeps any single piece of it short enough to read:

```bash
mochi --help              # command groups, and the commands that stand alone
mochi user --help         # the commands in one group
mochi user add --help     # one command's arguments and options
mochi commands --json     # every command, argument, and option, as data
```

`mochi commands --json` is the whole registry, which is enough to discover the surface without reading any of this.

### Output and exit codes

Every command that reads something takes `--json`, which puts a single JSON value on stdout and sends every diagnostic to stderr, so `mochi issue list --json | <parser>` never has to filter anything out. A comma-separated field list keeps only those fields, as `gh` does: write it attached, `--json=number,title`, or detached when it names more than one field, `--json number,title`. A name that is not a field of the response is an error naming the ones that are.

Failures are also JSON when `--json` was asked for: `{"error": "..."}` on stderr, and a non-zero exit.

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Generic failure, including a 4xx or 5xx from the vault with no code of its own |
| 2 | Usage error: unknown command, unknown flag, missing argument |
| 3 | Authentication failure: no token, or the vault rejected it (HTTP 401) |
| 4 | Not found: the vault answered 404 for the addressed resource |
| 5 | Conflict: the vault answered 409, or the operation was refused because of state |

4 and 5 are the two worth branching on, since "does this exist" and "did someone else get there first" are the questions a retrying caller asks.

## The commands

### Working on a repository

The repository commands read and write a repository over the API, so they need no clone:

```bash
mochi repo list                        # every repository in the vault
mochi repo view demo/proj
mochi branch list --repo demo/proj
mochi file list --repo demo/proj       # one directory
mochi file list --all                  # every path in the tree
mochi file list --commits              # with the last commit per entry
mochi file view README.md
mochi file view logo.png --raw         # the bytes, unchanged
mochi commit list --limit 10
mochi commit list --path src/index.ts  # only commits touching a path
mochi commit view <sha> --patch
mochi diff main...topic
mochi diff main...topic --stat         # names and counts, not the patch
mochi search 'needle'
```

`file list --commits` costs one `git log` per entry, so it is worth asking for only when the answer is wanted; `--all` walks the whole tree and takes `--limit`. `file view --raw` writes the bytes with no metadata and no base64, which is what a binary wants.

Which repository a command is about is resolved in this order: the positional argument or `--repo <collection>/<repo>`, then `MOCHI_REPO`, then the git remote in the current directory that points at the vault you are logged in to, preferring `origin`. A remote for some other host is not an answer, so a clone of a GitHub repository is never read as naming something here. Failing all three, the command says so and names all three.

### Changing a repository

```bash
mochi repo create mycollection/thing --description 'A thing' --readme
mochi repo edit --description 'A better thing'
mochi repo edit --topic webgpu --topic numbl   # replace the topics with these
mochi repo edit --add-topic mri                # keep the rest and add one
mochi repo edit --remove-topic numbl           # keep the rest and drop one
mochi repo list --topic webgpu                 # only repositories carrying a topic
mochi repo edit --upstream https://github.com/owner/repo   # record what mochi sync and pr export use
mochi repo fork demo/proj myfork
mochi repo rename demo/proj newname --collection othercollection
mochi repo delete demo/old --yes
mochi repo clone demo/proj

mochi branch create topic              # from the default branch, or from a named one
mochi branch create topic main
mochi branch delete topic --yes
mochi tag list
mochi tag create v1.0.0 main
mochi tag delete v1.0.0 --yes

mochi file write notes.md --message 'Add notes' < notes.md
mochi file delete notes.md --yes
```

Everything destructive takes `--yes` and refuses without it, rather than prompting: a prompt is no use to a caller that is not a person, and a command that prompts is a command that hangs in a container.

A topic is lowercase letters, digits, and hyphens (`webgpu`, `spike-sorting`), and a repository carries at most 20 of them; anything else is refused rather than rewritten, with the refusal naming the lowercase form when that is the fix. `--topic` and `--clear-topics` name the whole set, so they stand alone; `--add-topic` and `--remove-topic` read the repository first and may be combined. `mochi api topics` lists every topic in use with its count.

`mochi file write` reads the content from `--body`, from `--body-file`, or from stdin when neither is given, so a generated file can be piped straight in. Given `--expected-sha`, a branch that has moved since is a conflict (exit 5) rather than a silent overwrite, which is exactly what a caller that reads, thinks, and then writes wants:

```bash
sha="$(mochi file view config.json --json=commit | jq -r .commit)"
# ... work out the new content ...
mochi file write config.json --expected-sha "$sha" --body-file new.json
```

Several files as one commit is a single call, since three files changed as one logical edit should be one commit and not three:

```bash
mochi api repos/demo/proj/commits -X POST --input change.json
```

A commit made this way is a push as far as workflows are concerned, so it triggers the same runs a `git push` would.

`--branch` commits on an existing branch and `--new-branch` creates one and commits there, which is the first half of the branch-then-pull-request path in a single call:

```bash
mochi file write notes.md --new-branch topic --message 'Add notes' --body-file notes.md
mochi pr create --base main --head topic --title 'Add notes'
```

### Issues and pull requests

```bash
mochi issue list --state all
mochi issue view 12 --comments
mochi issue create --title 'It broke' --body-file report.md --label bug
mochi issue edit 12 --add-label urgent
mochi issue comment 12 --body-file -        # from stdin
mochi issue close 12
mochi issue reopen 12

mochi pr list
mochi pr view 4 --comments
mochi pr create --base main --head topic --title 'Add a thing'
mochi pr diff 4
mochi pr comment 4 --body 'Looks right to me'
mochi pr merge 4 --squash --delete-branch
mochi pr checks 4
mochi pr close 4
mochi pr reopen 4
```

`--body-file` exists alongside `--body` on every command that takes a body, and `-` reads stdin: an issue body is frequently longer than a shell argument should be. Asking for both is an error rather than a precedence question.

Two things are worth knowing about merging. Whether a merge would apply can be asked without merging anything, which is the read to make first:

```bash
mochi api repos/demo/proj/pulls/4/merge
```

And a merge that does not apply exits 5 and names the conflicting paths, so a caller can tell "it does not apply" from "it went wrong".

`mochi pr checks` deserves its own note: Mochi Forge has no equivalent of a check suite or a commit status, so there is nothing behind that command but the workflow runs whose commit is the pull request's head. That is what it reports, and that is all it means.

### Workflows and their runs

```bash
mochi workflow list                        # workflows at a ref, and the inputs each takes
mochi workflow run .github/workflows/build.yml --field greeting=hello
mochi run list --status completed
mochi run view 12                          # the run and its jobs
mochi run view 12 --log                    # and the failed job's log
mochi run watch 12 --exit-status
mochi run cancel 12
mochi run rerun 12
mochi run download 12 --dir artifacts
```

A job log comes back as its last 200 lines by default. That is not a convenience: a log can be large, and handing the whole of one to a caller that is diagnosing a failure wastes its attention on the part that succeeded. `--tail 0` asks for all of it, and the response says whether it kept only the end and whether the server capped the log as it was written, which are different things.

`run view --log` without `--job` picks the failed job, or the only job. When neither applies it asks rather than guessing. The table it prints is job-level; the step states come back under `--json`, which is where a caller asking "which step failed" should look. `run watch --log` prints the log when the run finishes, and `workflow run --ref` dispatches against a ref other than the default branch.

`mochi run watch` polls until the run finishes and then reports how it went; `--exit-status` makes a failed run a non-zero exit, which is what a script wants. It polls rather than streams because the engine has no event channel and the vault reads its state off disk per request, so a five-second poll against a local process costs nothing and needs no protocol. Note that a vault with no runner registered queues its runs and waits, so a watch there will reach its timeout; `mochi runner list` says whether one is connected and what is queued. A poll that cannot reach the vault at all is not treated as an answer about the run: the watch says so once, keeps polling, and says when the vault answers again, because a restart or a dropped connection is not a reason to abandon a run that is still going. The `--timeout`, which is the caller's actual patience, still ends it, and reports the unreachability if that is what is still true.

### Releases, users, and settings

```bash
mochi release list
mochi release view v1.0.0
mochi release create v1.0.0 --title 'First cut' --notes-file NOTES.md
mochi release edit v1.0.0 --latest          # clear the prerelease flag
mochi release delete v1.0.0 --yes

mochi user view alice
mochi user token list alice
mochi user token revoke alice <token-id> --yes
mochi user delete alice --yes
mochi collection rename mycollection newname
mochi collection delete emptyone --yes

mochi config view
mochi config set --theme slate --ci-runs 50
mochi config set --ci-days 30 --ci-artifact-mb 100
mochi config set --sites-host vault-sites.example.org
mochi config set --egress-gb-per-day 50
```

A release hangs on a tag that already exists: notes for a tag nobody can check out are notes about nothing, so `mochi tag create` comes first. Creating and editing are the same call underneath, since a release is keyed by its tag, which takes a whole class of "already exists, retry as an edit" logic out of a caller. Deleting a release deletes its notes and leaves the tag; the two are separate operations.

There is no `release upload`. A release's downloads are the archive routes, so there is nothing to upload and no asset endpoints exist.

`mochi collection rename` moves everything the collection holds: the repositories, their issues, pull requests, releases, sites, run histories, and LFS objects. It is one directory rename, so it costs the same on a collection of a hundred gigabytes as on an empty one. There is no `--yes`, since a rename that was a mistake is undone by renaming back; what it takes is ownership of the collection, and the owners travel with it. The old address is redirected to the new one, so links and existing clones keep working until something else is created under that name; see [The old address](vault.md#the-old-address). One thing does not move with it: token scopes naming the old collection cover nothing afterwards and have to be granted again under the new name. `mochi repo rename` is the same operation one level down, and can move a repository to another collection with `--collection`, which additionally takes permission to create in the destination.

Tokens are named by an id rather than by their hash, and neither a token nor its hash is ever returned: only a SHA-256 hash is stored, so there is nothing to return. An id, a creation time, and any scope of its own is what a listing gives, which is what revocation takes. Revoking the token you are using is allowed and reported rather than refused; locking yourself out is your business, and `vault.json` remains hand-editable.

`mochi config set` reaches the theme, the CI retention settings, the hostname repository sites are served from, and the daily cap on outgoing bytes. Those are the settings the server consults per request, so a change is in effect on the next one; `--sites-host ''` clears it, putting sites back on the vault's own hostname under the sandbox, and a value that is not a plausible hostname is refused rather than stored (see [A domain of your own](deploying.md#a-domain-of-your-own)). This is the reason there is a command at all: a vault's settings should not need a shell on the machine holding its disk.

`--egress-gb-per-day` caps the bytes the vault may send in one UTC day, 20 GB by default and `0` for no cap. Past it, ordinary requests are refused with `503` until the next UTC midnight, while the administration pages and signing in keep working so the cap can be raised from the vault itself. `mochi api /api/egress` shows what has gone out today, per repository, which is the same breakdown `/admin/egress` draws. See [Outgoing bytes](deploying.md#outgoing-bytes).

`network.trustProxy` and the rest of the `limits` block are not reachable here. They are read once when the server starts, since they hold live counters that cannot be rebuilt per request, so a command that changed them would report a change the running server had not made. Edit `config.json` in the vault and restart.

### Backing up a vault

```bash
mochi backup ~/backups/myvault              # incremental sync over HTTP
mochi backup ~/backups/myvault --snapshot   # ...then snapshot, then prune
mochi backup list ~/backups/myvault
mochi backup verify ~/backups/myvault
mochi backup prune ~/backups/myvault
```

A vault is a directory, so a copy of one is a directory too, and `mochi backup` pulls it over HTTP: no shell on the server, no flyctl, no rsync at the far end. The backup directory is itself a vault, so restoring is `mochi serve ~/backups/myvault/current`. Repositories come across as mirrors and a repository nothing was pushed to is skipped without a request; everything else is compared by size and modification time and fetched only where it differs. The token needs to belong to a site admin, since the copy includes `vault.json`.

The vault URL, the exclusions, and the retention policy are recorded in the backup directory, so after the first run a cron entry is the command and a directory. [Backing up a vault](backup.md) has the options, the snapshot and hardlink rules, and an honest account of what a backup does not promise.

### Reaching any route: `mochi api`

`mochi api` sends a request to any route of the JSON API and prints what comes back, so a capability with no typed command of its own is still one line away:

```bash
mochi api whoami
mochi api collections -X POST --field name=mycollection
mochi api collections/mycollection
```

The path may be written with or without a leading slash and with or without the `api/` prefix, so `whoami` and `/api/whoami` name the same route. `--field k=v` builds a JSON body, coercing `true`, `false`, `null`, and whole numbers; `--raw-field k=v` keeps the value a string; `--input <file>` sends a file as the body, or stdin for `-`. The method defaults to GET, or POST when a body is given, and `-X` overrides it. The response body is printed verbatim on stdout; a non-2xx status prints it on stderr instead and exits with the code from the table above.

`--include` (`-i`) prints the status and content type as well. Note that it prints them on **stderr**, not stdout, so that `mochi api ... -i | jq` still sees only the body; redirect stderr if you want them together.

Only the path is taken from the argument. A full URL is accepted, but its host is ignored in favour of the one you are logged in to, so a token is never sent somewhere you did not configure.

## Pushing

The first token comes from the server's first start (the printed owner token). With that you can create users on the web (Admin, in the header) or over the API:

```bash
mochi user add jeremy
```

This creates the user in `<vault>/vault.json` on the server and prints the token once; only its SHA-256 hash is stored. Then push with the username and the token as the password:

```bash
git push http://127.0.0.1:3000/mycollection/myrepo main
# git prompts: username 'jeremy', password '<token>'
```

Pushing to a repository that does not exist yet creates it, provided you may create there: your own collection, one you own, or anywhere for a site admin. The collection directory is created as needed, and after the first push HEAD points at the pushed branch. Repositories created this way are public (a push has no way to carry the private flag; flip it in the settings or with `mochi repo edit --private` afterwards) and get `receive.denyNonFastForwards`, `receive.denyDeletes`, and a `receive.maxInputSize` limit of 2 GiB. Anonymous fetch stays open on public repositories; a private one asks for the same credentials a push does and serves only readers. The username in the Basic pair may be anything when the password is a valid token: a token identifies its owner by itself, as on GitHub.

### Not typing the token every time

Being asked for the token on every push is the wrong default for a vault you use daily. A token is the password git sends over Basic auth, so the place to keep it is git's own credential store, which `git clone`, `git fetch`, `git push`, and `git lfs` all consult through the same plumbing. `mochi login` puts it there:

```bash
mochi login https://vault.example.com --helper store   # asks for the token, without echo
```

Afterwards nothing about this vault prompts again, and `mochi` commands aimed at it need no arguments either. `mochi logout` removes the credential and forgets the vault.

`--helper` says where the token lives, and is recorded for this vault's host alone, so other remotes keep whatever they already use:

| Helper | Where the token goes |
| --- | --- |
| `store` | `~/.git-credentials`, mode 0600, in plain text, the same posture as a GitHub token |
| `cache` | memory only, forgotten after 15 minutes |
| `libsecret` | the desktop keyring, on Linux |
| `osxkeychain` | the login keychain, on macOS |

Pass `--helper` once; later runs of `mochi login` reuse whatever is already configured for the host. If nothing is, the command refuses rather than reporting success, because `git credential approve` with no helper configured stores nothing and still exits zero. The token is checked against `/api/whoami` before being stored, so a mistyped one fails immediately rather than at the next push, and it is read back afterwards, which is what catches a helper that is configured but not installed.

Note that this is a client-side arrangement: the vault has no notion of a login, holds no session for git, and is unaware that a credential was stored. Revoking access is still a matter of removing the token from `vault.json`.

Because the token lives in git's store rather than in a Mochi Forge file, any helper git can use will do, including one of your own that fetches the token from elsewhere:

```bash
git config --global 'credential.https://vault.example.com.helper' \
  '!f(){ echo username=jeremy; echo "password=$(my-secret-tool get mochi)"; }; f'
```

Such a helper stores nothing, so `mochi login` against it does no more than record the vault and confirm that reading the credential back yields the token it just checked, which is all it needs to do. The trade-off is that this works only where whatever the helper calls works, so editors, GUI git clients, and cron jobs may see no credential at all.

### Importing an existing repository

Importing runs on your machine, not on the server, and `mochi import` is what runs it:

```bash
mochi import https://github.com/owner/repo mycollection
```

That clones the source into a temporary directory, pushes it at the vault, which creates the repository, and removes the clone again. The source may be an https or ssh git URL, `owner/repo` as shorthand for GitHub, or a directory on this machine, which is the case for a repository that exists only as a local clone. The name comes from the source's last segment; write `mycollection/another-name` to choose another, or give `--collection` and `--name` separately, which is easier to build in a script than a joined path. The collection need not exist: the push creates it, as any push to a new path does.

The source is read with whatever git credentials this machine already has, so a private source works if your own `git clone` of it works, and the push is authorized by the token `mochi login` stored. Branches and tags come across. Issues and pull requests do not. A name already taken stops the import before the clone, since a mirror push would replace that repository's branches and tags.

A repository's one-line description is not part of its git data, so a clone carries everything except that. Where the source is a GitHub repository, the import asks GitHub's API for the description once the push has arrived and sets it here. That call is unauthenticated, so it answers for a public repository and not for a private one; when it does not answer, the import says so and finishes, leaving the description to be set in repository settings. `--description 'some text'` sets one of your own instead of asking, and `--no-description` skips the question entirely.

Git LFS objects are not carried over by default, because a mirror push copies the pointer files and not the objects behind them, which leaves the imported files reading as missing. `--lfs` brings them too, and needs `git-lfs` installed:

```bash
mochi import https://github.com/owner/repo mycollection --lfs
```

Note that nothing about this happens on the server. A vault that imported on your behalf would need outbound network access, credentials for other services, a disk budget, and work that outlives a request, none of which this project has; doing it from your machine needs none of it, and progress and cancellation come from your terminal. The cost is that the data passes through your machine, and that importing many repositories is a shell loop rather than a form.

The **Import or fork** button on a collection page writes out the same commands, and `mochi fork` beside them, filled in with that collection and this vault's URL, for copying into a terminal. It also carries the two git commands the import is made of, for a machine with no Node on it:

```bash
tmp="$(mktemp -d /tmp/import.XXXXXX)" && \
  git clone --bare https://github.com/owner/repo.git "$tmp" && \
  GIT_ASKPASS= git -C "$tmp" push --mirror https://you@vault.example.com/mycollection/repo && \
  rm -rf "$tmp"
```

The clone is a scratch copy, so it goes to a temporary directory rather than to whatever directory you happen to be standing in, and a fresh one each time means a failed attempt never blocks the next. If you have run `mochi login`, the push takes the token from git's credential store and asks nothing; otherwise git asks for a password on the push, and that is your Mochi Forge token. The `GIT_ASKPASS=` prefix keeps that prompt in the terminal you pasted the command into. Without it, an editor that sets `GIT_ASKPASS` for its integrated terminal, as VS Code does, answers the prompt with a dialog box elsewhere in the window instead; if that dialog goes unnoticed, git prints nothing after the clone and waits, which reads as a hang.

By hand, LFS objects are two more commands from inside the bare clone, before it is deleted:

```bash
git -C "$tmp" lfs fetch --all https://github.com/owner/repo.git
GIT_ASKPASS= git -C "$tmp" lfs push --all https://you@vault.example.com/mycollection/repo
```

`--all` copies every version of every tracked file rather than only the tips, so the history stays checkoutable.

The clone is `--bare` rather than `--mirror` on purpose: mirroring a GitHub repository also copies `refs/pull/*`, which can be thousands of refs.

### Forking from GitHub, and sending changes back

A vault can act as the working forge for a repository whose home is GitHub: fork it in, work on it here with branches, pull requests, and workflows, and send finished changes back as GitHub pull requests. Three commands make the loop, and every one of them runs on your machine, for the same reason importing does: the vault holds no GitHub credential, so nothing in it can reach GitHub on its own.

```bash
mochi fork owner/repo mycollection          # import, and record where it came from
mochi sync                                  # fast-forward from the upstream
mochi pr export 3                           # send pull request 3 on to GitHub
```

`mochi fork` is `mochi import` plus a memory: the source URL is recorded as the repository's upstream (`mochi.upstream` in the bare repository's config), which the repository header shows as "forked from", and which the other two commands read. It takes the same options as import, and refuses a local directory, which has no URL to record. On a repository imported before this existed, or created some other way, `mochi repo edit --upstream <url>` records one after the fact, and `--upstream ''` clears it; the Upstream field on the repository's settings page does the same in the browser.

`mochi sync` keeps the fork from rotting: it fetches the branch from the upstream URL with whatever git credentials this machine already has, and pushes the result to the vault with your token. Only a fast-forward is ever pushed. A branch that is ahead of its upstream is reported as such and left alone, and one that has diverged is refused with the two counts, since deciding how to reconcile it is a merge or a rebase in a clone, not something a sync should guess at. The branch defaults to the repository's default branch; `--branch` names another. On the web, the "forked from" line in the repository's header carries a Sync link for anyone with push access, leading to a page that writes this command out filled in, the way the import page does.

`mochi pr export <n>` turns a pull request in the vault into one on GitHub. It reads the pull request here, pushes its head branch to a fork under your GitHub account (created with `gh` the first time; `--fork owner/repo` names an existing one), and opens a pull request against the upstream with the same title and body, plus a line saying where it came from. GitHub requires the head branch to live on GitHub, which is why the fork in the middle is unavoidable; it is a publishing mirror that holds the branches you have exported and nothing else. Running the command again force-pushes the branch and finds the pull request already open rather than opening a second one, so revising after review is export again. The GitHub side goes through `gh` and its credentials, so `gh auth login` once is the only setup, and the base branch defaults to the pull request's own base; `--base` overrides it. With write access on the upstream, the middle fork is unnecessary: `--fork` naming the upstream itself pushes the head branch straight there and opens a same-repository pull request. Note that the export force-pushes the branch it names, wherever it names it, so aimed at the upstream this takes branch names that are yours alone.

The division of labor this buys is worth stating: an agent, or anyone else, can be given a mochi token and no GitHub credential at all. They can fork, branch, open pull requests, and run workflows entirely inside the vault, and `mochi pr export` remains a deliberate command run by someone holding a GitHub credential. The vault works as a staging area whose contents cannot reach GitHub without that step.

### Collections

A collection is a directory of repositories, and most of them come into being on the way to something else: creating a repository, importing one, or pushing to a path that does not exist yet all create the collection they land in. For the other order, an empty collection made first and filled later, there is **New collection** on the collections page, and:

```bash
mochi collection add mycollection
mochi collection list
mochi collection rename mycollection newname
```

Creating one is creating a namespace: the collection named after you is yours to create, and any other name takes a site admin. An empty collection is an empty directory, so removing it again is `rmdir` in the vault.

Renaming one is a single directory rename, since a collection holds everything of its own inside its directory, and the same operation is on the collection's **Settings** page in the web interface. Everything moves with it; token scopes naming the old collection do not, and have to be granted again under the new name. See [Renaming a repository or a collection](vault.md#renaming-a-repository-or-a-collection).

### Users and tokens

`vault.json` holds a `users` object. Each user has a list of hashed tokens, and optionally the site-admin bit:

```json
{
  "version": 2,
  "users": {
    "owner": { "siteAdmin": true, "tokens": [{ "hash": "..." }] },
    "ci": { "tokens": [{ "hash": "...", "scope": ["mycollection/site"] }] }
  }
}
```

What a user may reach is not recorded here; it lives with the thing that grants it (see [Who may do what](vault.md#who-may-do-what)). A user owns the collection named after them, a collection lists further owners in its `collection.json`, and a repository lists collaborators with roles in its `mochi.json`. A token may carry a scope of its own, globs over `collection/repo`, which narrows that one token (`--token-scope`) without changing the user: outside its globs it grants nothing beyond anonymous reading, inside them it caps at the write role, and it can administer nothing. The server re-reads `vault.json` when it changes; hand-editing it remains possible and is the escape hatch for locked-out vaults. If the file cannot be parsed, writes refuse until it is fixed, while read access continues to work. A `vault.json` from before roles (no `"version": 2`) is migrated the first time the server starts, with the original kept as `vault.json.pre-roles`.

### Granting access to a collection or repository

Access is granted where it applies, by someone with the admin role there:

```bash
mochi user add alice                          # alice owns the collection 'alice' from the start
mochi collab add mycollection/webapp alice    # the write role on one repository
mochi collab add mycollection/webapp bob --role read   # read: sees it even when private
mochi collab list mycollection/webapp
mochi collection owner add mycollection alice # the admin role on everything in mycollection
mochi user grant alice --site-admin           # everything, everywhere
mochi user list                               # review who holds tokens and the site-admin bit
```

Note that `--site-admin` on `mochi user add` applies only when creating a user; on an existing user the command refuses rather than silently escalating (run it plain to mint an additional token).

### Private repositories

`mochi repo create mycollection/secrets --private` creates a repository only its collaborators, the collection's owners, and site admins can see; `mochi repo edit mycollection/secrets --public` (or `--private`) flips an existing one, taking the admin role. To everyone else a private repository answers the same 404 an absent one does, in listings, over git, and in the API alike.

### JSON API

The CLI is a thin client over the JSON API, authenticated with `Authorization: Bearer <token>`. Every operation the web interface offers has a route, and [The JSON API](api.md) is the reference: every route, its body, its response, and what it requires of the caller.

The API accepts only bearer tokens and git accepts only Basic auth; session cookies never authorize either. The three credential presentations stay deliberately distinct.

A runner authenticates with its own token rather than a user's, and the endpoints it uses to take jobs and report on them (`/api/runner/*`) are a protocol between the vault and the runner rather than an interface to program against. [Workflows](workflows.md) describes what a runner is and what it does.

If you are writing something that will drive this rather than reading it yourself, [Mochi Forge for an agent](agents.md) is a page and a half, and includes an honest list of what Mochi Forge does not have.
