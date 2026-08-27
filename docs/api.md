# The JSON API

Every route the vault answers with JSON, what it takes, and what it requires of the caller.

For a shorter introduction aimed at a program rather than a person, see [Mochi Forge for an agent](agents.md). For the command line over this API, see [The command line](cli.md).

## The rules that hold everywhere

**Authentication is a bearer token and nothing else.** `Authorization: Bearer <token>`. A session cookie never authorizes an API call, and a bearer token never authorizes an HTML form post; git accepts only Basic auth. The three credential presentations stay deliberately distinct, and each is checked in one place.

**There is no anonymous reading.** The web is where anonymous reading lives. Requiring a token on `/api` keeps one rule for the whole surface, and it is the rule to revisit first if a real caller needs otherwise.

**Authorization follows the roles.** A read of a public repository takes any valid token; a private repository additionally takes a role on it, and without one it answers the same 404 an absent repository does, in listings and on direct reads alike. A write takes the write role, as `git push` does. Renaming a repository, deleting one, and managing its visibility and collaborators take the admin role, which collaborators may hold and which collection owners and site admins hold everywhere they own. Users, runners for collections you do not own, and vault-wide settings take a site admin: a collection owner should not restyle the whole vault. See [Who may do what](vault.md#who-may-do-what).

**A repository is two path segments,** `/api/repos/<collection>/<repo>`, with the `.git` suffix accepted and ignored.

**Lists come back as a named array,** `{"issues": [...]}` rather than a bare array, so that adding a count or a truncation flag later is not a breaking change. Where a list can be narrowed, the response also carries `total`, which is how many matched before `limit` was applied.

**There is no pagination protocol.** `?limit=` and the server's own caps are what there is. A vault's collections are small and everything is read off disk per request, so a cursor protocol would be machinery with nothing to carry.

**The response objects are the vault's own.** They are the interfaces in `src/issues.ts`, `src/pulls.ts`, `src/releases.ts`, and `src/ci/runs.ts`, unchanged, so a field added to the vault's state appears here without a decision being made about it. Timestamps are ISO 8601 strings.

**Errors are `{"error": "..."}`** with a status that says what kind of failure it was:

| Status | Meaning |
| --- | --- |
| 400 | The request was malformed, or a domain rule refused it |
| 401 | No token, or the token was rejected |
| 403 | The token is valid and not allowed to do this |
| 404 | No such repository, issue, run, file, or ref |
| 409 | It already exists, or someone got there first, or it will not apply |
| 413 | Too large; push it instead, or use Git LFS |
| 429 | Too many failed credential checks, or too many requests. Carries `Retry-After` |
| 503 | The server is busy with other git work. Carries `Retry-After` |

**No version prefix.** Additive change is the compatibility story, the same one the vault's on-disk formats have.

**There is no content negotiation on the HTML routes.** `/demo/proj/tree/main` renders a page whatever the `Accept` header says. The two surfaces authenticate differently, carry different parameters, and have different error shapes; serving both off one route would mean one handler holding two of everything.

## Whoami, collections, users

```
GET    /api/whoami                     the user, their standing, and this token's restriction
GET    /api/collections                collections and how many repositories each shows the caller
GET    /api/collections/:name          one collection: its owners and the repositories the caller may see
POST   /api/collections                create an empty one            {name}   (your namespace, or site admin)
POST   /api/collections/:name/rename   rename it, and everything in it {name}  (owner)
DELETE /api/collections/:name          remove an empty one                     (owner)
PUT    /api/collections/:name/owners/:user    add an owner                     (owner)
DELETE /api/collections/:name/owners/:user    remove an owner                  (owner)
GET    /api/users                      every user                     (site admin)
POST   /api/users                      create a user, or mint a token {username, siteAdmin?, tokenScope?}  (site admin)
POST   /api/users/:name/grant          set the site-admin bit         {siteAdmin}  (site admin)
GET    /api/users/:name                one user, with their token ids
DELETE /api/users/:name                remove a user                  (requires ?confirm=<name>; site admin)
GET    /api/users/:name/tokens         token ids, creation times, scopes
DELETE /api/users/:name/tokens/:id     revoke one token
```

`POST /api/users` returns the token once. Only its SHA-256 hash is stored, so it cannot be recovered afterwards. What a user may reach is not set on the user: it is granted on the repository (collaborators) or the collection (owners), or by the one site-admin bit `grant` carries.

A token listing never contains a token or its hash. What it contains is an `id`, which is what revocation takes; a token minted before ids existed is identified by the first eight characters of its hash instead, so an existing vault needs no migration.

Renaming a collection moves everything in it: the repositories, their issues, pull requests, releases, sites, run histories, and Git LFS objects. It is one directory rename, so it costs the same on a collection of one repository as on a collection of a hundred gigabytes, except for LFS objects in a bucket, whose keys name the collection and are copied to the new prefix. Requests for the old address are redirected to the new one, this API's routes included: a `GET /api/collections/oldname` or a `GET /api/repos/oldname/thing` answers `301` with a `Location` naming the new address, and a request that writes answers `308` so the method and body survive the hop. The redirect lasts until something else is created under that name; see [The old address](vault.md#the-old-address). Owners travel with the collection and collaborators with each repository; token scopes in `vault.json` naming the old collection are the exception, covering nothing afterwards until granted again. Asking for the name the collection already has answers `{"changed": false}` rather than an error, as elsewhere in this API. See [Renaming a repository or a collection](vault.md#renaming-a-repository-or-a-collection).

Deleting a collection takes an empty one: a collection holding any repository, or anything a repository keeps beside it, answers `409` rather than being emptied. The collection's own owners file does not count against emptiness and is removed with it. Redirects that pointed at the deleted name are forgotten, so a collection created later under that name inherits no traffic. The same operation is offered on the collection's settings page in the web interface, under a typed confirmation, and by `mochi collection delete`.

A user may read their own record and their own token ids without being a site admin. Removing a user refuses to remove the caller: unlike revoking one token, that cannot be undone by minting another. Revoking the token currently in use **is** allowed, and the response says `wasThisToken: true` rather than refusing; locking yourself out is your business, and `vault.json` remains hand-editable.

## Vault settings

```
GET    /api/config                     theme, CI retention, sites, network, and limits
                                                                      (site admin)
PATCH  /api/config                     {theme?, ci?, sites?, limits?} (site admin)
GET    /api/egress                     bytes sent today, per repository, and earlier days
                                                                      (site admin)
```

All three take a site admin: a collection owner should not read or change a vault-wide setting, nor read which repositories the vault is sending most of its bytes for.

`theme`, `ci`, and `sites` are writable. Every reader of them consults `config.json` per request, so a change is in effect on the next one and no restart is involved. `sites` takes a `host` string, and `""` puts sites back on the forge's own hostname under the sandbox; a value that is not a plausible hostname is refused with 400 rather than stored. See [Sites](sites.md) for what a sites host does, and [Deploying a vault](deploying.md#a-hostname-for-each-site) for the DNS and certificates it needs.

`network.trustProxy` and the rest of the `limits` block are readable and not writable. They are read once when the server starts (see [Deploying a vault](deploying.md)), so a route that changed them would report a change the running server had not made. Edit `config.json` in the vault and restart.

`limits.egressGbPerDay` is the exception, and the only field `limits` accepts here: it caps the bytes the vault may send in one UTC day and is read per request, so a change is in force on the next one. That it is writable over HTTP is the point. The moment an operator wants to raise it is the moment the vault has stopped answering ordinary requests, and telling them to restart it then is telling them to reach the volume by hand. `0` sends without a limit. Any other field in the block is refused with 400 rather than quietly ignored.

`GET /api/egress` returns the same numbers `/admin/egress` shows: `day` and `total` for today in UTC, `rows` of `{repo, site, bytes}` largest first, `capBytes` and `capGb`, `overBudget`, `resetsIn` seconds, and `history` of up to 30 earlier days. A row whose `repo` is `(vault)` is everything belonging to no repository, and `(other)` appears only once a day's breakdown has reached its 2000-row ceiling. `lfsBucketExcluded` says whether LFS downloads are bypassing this server through presigned bucket URLs, in which case those bytes are not in the totals, though the batch endpoint that mints those URLs is refused past the cap like any other route. See [Deploying a vault](deploying.md#outgoing-bytes) for what the cap does and what it does not count.

## Repositories

```
GET    /api/repos                                  every repository the caller may see, flat;
                                                   ?topic=<t> keeps only those carrying the topic
GET    /api/repos/:c/:r                            one repository: description, topics, default branch,
                                                   counts, fork parent, upstream URL, visibility,
                                                   whether it has a site
GET    /api/topics                                 every topic in use, with how many repositories
                                                   the caller may see carry each
POST   /api/repos                                  create   {collection, name, description?, initReadme?, private?}
PATCH  /api/repos/:c/:r                            settings {description?, topics?, defaultBranch?, upstream?, private?}
                                                   (private takes the admin role; the rest take write;
                                                   upstream is an https or ssh git URL, '' clears it;
                                                   topics is the whole set as a list of strings)
POST   /api/repos/:c/:r/fork                       fork     {collection, name?}
                                                   (read on the source, create where it lands)
POST   /api/repos/:c/:r/rename                     rename   {name?, collection?}          (admin;
                                                   a move also takes create in the destination)
DELETE /api/repos/:c/:r                            delete   (requires ?confirm=<c>/<r>)   (admin)
POST   /api/repos/:c/:r/gc                         drop unreachable objects              (admin;
                                                   requires ?confirm=<c>/<r>)
GET    /api/repos/:c/:r/collaborators              collaborators, owners, and visibility  (admin)
PUT    /api/repos/:c/:r/collaborators/:user        give a role   {role: read|write|admin} (admin)
DELETE /api/repos/:c/:r/collaborators/:user        remove one                             (admin)
GET    /api/repos/:c/:r/branches                   branches, with the default branch named
POST   /api/repos/:c/:r/branches                   create   {name, from}
DELETE /api/repos/:c/:r/branches/*                 delete a branch
GET    /api/repos/:c/:r/tags                       tags
POST   /api/repos/:c/:r/tags                       create   {name, at}
DELETE /api/repos/:c/:r/tags/*                     delete a tag
GET    /api/repos/:c/:r/site                       whether a site exists, its file count, when it changed
```

`GET /api/repos/:c/:r` also carries `private`, `role` (the caller's, or null), and `canPush`, so a caller need not discover what it may do by being refused. A private repository the caller has no role on is left out of `GET /api/repos` and answers 404 everywhere else, exactly as an absent one would.

A topic is lowercase letters, digits, and hyphens, starting with a letter or digit, at most 50 characters, and a repository carries at most 20; anything else is refused rather than rewritten. `topics` on PATCH replaces the whole set, as it does on GitHub, so add-one and remove-one are a caller's read-modify-write; `[]` clears them. There is no topic registry: a topic exists while some repository carries it, and `GET /api/topics` is the count of what does.

Forking takes read access to the source and permission to create in the collection the fork lands in. A fork of a private repository starts private.

Branch and tag deletion take the name as a wildcard path segment, because a ref name may contain slashes and `release/1.0` does not fit in one.

`?confirm=` on delete is the API's equivalent of the web's typed confirmation. It costs nothing and it makes an accidental `DELETE` from a loop over a listing impossible.

The site route is read only. Publishing a site is a workflow's job or a file copy into the vault; an upload path here would be a second way to write the one directory whose contents are served to browsers (see [Sites](sites.md)).

## Contents and history

```
GET  /api/repos/:c/:r/tree?ref=&commits=1       the root directory listing
GET  /api/repos/:c/:r/tree/*?ref=&commits=1     a directory listing; commits=1 adds the last
                                                commit per entry, at one git log each
GET  /api/repos/:c/:r/contents/*?ref=           one file: metadata plus text, base64 when binary,
                                                or a note when it is a Git LFS pointer
GET  /api/repos/:c/:r/raw/*?ref=                the bytes, sandboxed as the web raw route is
GET  /api/repos/:c/:r/commits?ref=&path=&limit= commits, newest first
GET  /api/repos/:c/:r/commits/:sha              one commit
GET  /api/repos/:c/:r/commits/:sha/patch        the patch, as text/plain
GET  /api/repos/:c/:r/compare/*                 <base>...<head>: counts, commits, and the diff
GET  /api/repos/:c/:r/blame/*?ref=              blame lines
GET  /api/repos/:c/:r/search?q=&ref=            literal search hits
GET  /api/repos/:c/:r/paths?ref=&limit=         every path in the tree
GET  /api/repos/:c/:r/contributors?ref=
GET  /api/repos/:c/:r/languages?ref=
PUT  /api/repos/:c/:r/contents/*                create or replace a file, committing
DELETE /api/repos/:c/:r/contents/*              delete a file, committing
POST /api/repos/:c/:r/commits                   several files as one commit
```

`?ref=` accepts a branch, a tag, or a commit id, never an arbitrary revision expression, and defaults to the repository's default branch.

`GET .../contents/*` carries `commit`, the commit the ref was at. That is the value to hand back as `expectedSha` on a write.

A file over 1 MiB is refused with 413 rather than returned; fetch it from `/raw/` or from a clone. The search and tree routes are behind the same concurrency gates the web routes are, so they may answer 503 with `Retry-After` when the server is already busy with git (see [Deploying a vault](deploying.md#limits)).

### Writing a file

```json
{
  "branch": "main",
  "message": "Add a thing",
  "content": "text of the file",
  "encoding": "utf-8 | base64",
  "expectedSha": "<the commit the caller last saw, optional>",
  "newBranch": "<optional; created at expectedSha and committed to instead>"
}
```

`PUT` creates or replaces, so a caller that has read a file and means to change it does not have to know which of the two it is doing; the response says `created`.

`expectedSha` is optimistic concurrency and it is what a caller that reads, thinks, and then writes wants. Given one, a branch that has moved since is 409 rather than a silent overwrite. A sha that names no commit in this repository is also 409, with a message saying to read the file again. Absent, the write is unconditional.

A path holding a Git LFS pointer is refused: the repository holds a pointer and not the file, so writing text over it would orphan the object.

The multi-file shape:

```json
{
  "branch": "main",
  "message": "Change three things",
  "expectedSha": "...",
  "newBranch": null,
  "files": [
    { "path": "a.txt", "content": "..." },
    { "path": "b.png", "content": "<base64>", "encoding": "base64" },
    { "path": "old.txt", "delete": true }
  ]
}
```

One commit, because three files changed as one logical edit should not be three commits recording states nobody chose. A single file is capped at 1 MiB and the whole body at 25 MiB; anything larger belongs in a push, or in Git LFS.

**Every write here fires the same CI push event a `git push` fires.** A commit made over the API is a push as far as workflows are concerned, and the two interfaces would otherwise diverge silently.

## Issues

```
GET    /api/repos/:c/:r/issues?state=&label=&author=&sort=&q=&limit=
POST   /api/repos/:c/:r/issues                  {title, body?, labels?}
GET    /api/repos/:c/:r/issues/:n               the issue with its comments
PATCH  /api/repos/:c/:r/issues/:n               {title?, body?, labels?}
POST   /api/repos/:c/:r/issues/:n/comments      {body}
POST   /api/repos/:c/:r/issues/:n/state         {state: "open" | "closed"}
GET    /api/repos/:c/:r/issues/labels           labels and authors in use, with counts
```

`state` is `open` (the default), `closed`, or `all`. `sort` is `newest`, `oldest`, `updated`, or `comments`. `q` matches the title, the body, or a label.

`labels` on `PATCH` replaces the whole set. Numbers are per repository and never reused.

**The author is the token's user.** No `author` field is read from a body, on any route, ever.

## Pull requests

```
GET    /api/repos/:c/:r/pulls?state=&limit=
POST   /api/repos/:c/:r/pulls                   {title, body?, base, head}
GET    /api/repos/:c/:r/pulls/:n                the pull request with its comments
PATCH  /api/repos/:c/:r/pulls/:n                {title?, body?}
POST   /api/repos/:c/:r/pulls/:n/comments       {body}
POST   /api/repos/:c/:r/pulls/:n/state          {state: "open" | "closed"}
GET    /api/repos/:c/:r/pulls/:n/diff           the diff, as compare returns it
GET    /api/repos/:c/:r/pulls/:n/commits        the commits between base and head
GET    /api/repos/:c/:r/pulls/:n/merge          mergeability, without merging
POST   /api/repos/:c/:r/pulls/:n/merge          {method?, message?, deleteBranch?}
POST   /api/repos/:c/:r/pulls/:n/delete-branch  delete the head branch after the fact
```

`state` is `open` (the default), `closed`, `merged`, or `all`. Both `base` and `head` must be branches the repository has.

`GET .../merge` is the useful one: it answers whether the merge would apply without writing anything, which is the read to make before the write. It reports `mergeable`, and on a conflict the paths that conflict.

`POST .../merge` takes `method` of `merge` (the default, keeping both parents) or `squash`. A conflict is **409 with the conflicting paths in the body**, not a 400 and not a 500. A pull request that is not open is also 409: to a caller deciding whether to retry, "someone already merged this" is the same answer as "someone got there first".

Merging takes the write role on the repository. Authorship is not enough, as it is for closing, because merging moves a branch.

Neither the diff nor the commit list is ever stored. Both are questions for git, answered from base and head at the moment they are asked, so a stored copy could only ever be a stale one.

## Releases

```
GET    /api/repos/:c/:r/releases
GET    /api/repos/:c/:r/releases/:tag           (tag percent-encoded)
PUT    /api/repos/:c/:r/releases/:tag           create or update {name?, body?, prerelease?}
DELETE /api/repos/:c/:r/releases/:tag
```

`PUT` rather than `POST`, because a release is keyed by its tag and the file written is the same either way. Creating and editing being one call removes a whole class of "already exists, retry as an edit" logic from the caller; a field left out keeps whatever is there.

The tag has to exist in the repository first, which is what the web form checks: notes for a tag nobody can check out are notes about nothing. `DELETE` removes the notes and keeps the tag, and says so.

**There are no release assets.** A release's downloads are the archive routes, so there is nothing to upload.

## Workflows and runs

```
GET  /api/repos/:c/:r/workflows?ref=            workflows at a ref, with their dispatch inputs
GET  /api/repos/:c/:r/runs?limit=&status=       runs, newest first
GET  /api/repos/:c/:r/runs/:n                   one run with its jobs and step states
GET  /api/repos/:c/:r/runs/:n/jobs/:job         one job
GET  /api/repos/:c/:r/runs/:n/jobs/:job/log     the log; ?tail=<n>, ?format=text|ndjson
GET  /api/repos/:c/:r/runs/:n/artifacts
GET  /api/repos/:c/:r/runs/:n/artifacts/:name   the tar
POST /api/repos/:c/:r/runs/:n/cancel
POST /api/repos/:c/:r/runs/:n/rerun
POST /api/repos/:c/:r/runs/:n/exec-command      mint the command for the run's manual jobs
POST /api/repos/:c/:r/dispatches                {workflow, ref?, inputs?}
```

`GET .../runs/:n` includes the jobs with their step states, because "which step failed" is the next question after "did it fail" and a request per job to answer it would be a poor trade.

`?tail=` defaults to 200 and is not a convenience. A job log can be large and is capped by the server as it is written; a caller diagnosing a failure wants the end of it, and handing over the whole thing spends its attention on the part that worked. `?tail=0` asks for all of it. The response distinguishes the two kinds of truncation, which are not the same thing: `truncated` means tail kept only the end, and `capped` means the server stopped recording. A job that failed in the planner has no log at all, only `error`.

Cancelling a run that is not in progress is 409. Dispatching requires the workflow to have a `workflow_dispatch` trigger and the ref to be a branch the repository has.

`exec-command` takes the write role and answers `{command, token, expiresAt, expiresInMinutes}` for a run with waiting [manual jobs](workflows.md#manual-jobs-run-by-pasting-a-command): 400 when the run has none, 409 when it has finished. The token appears in this response and nowhere else, must be redeemed within fifteen minutes, and works once.

**There is nothing behind `gh pr checks`.** Mochi Forge has no check suites and no commit statuses. The nearest answer is the runs whose sha matches the pull request's head, which is exactly what `mochi pr checks` computes.

## Backing up a vault

```
GET  /api/backup/manifest?exclude=&hash=1       NDJSON: every file and repository in the vault
POST /api/backup/fetch                          {paths: [...]}, answered as a length-prefixed stream
```

Two routes, together enough to pull a whole vault onto another disk. `mochi backup` is the client; [Backing up a vault](backup.md) describes it and what a backup does not promise. Both require a site admin with an unrestricted token, since the manifest necessarily names `vault.json` and `.secret`, and both hold the same concurrency gate a file listing does, so a backup in progress cannot crowd out a push.

The manifest streams NDJSON, so a large vault costs the server no more memory than a small one:

```jsonl
{"kind":"vault","lfs":"volume","excluded":[]}
{"kind":"file","path":"vault.json","size":812,"mtime":1755600123456,"mode":384}
{"kind":"repo","path":"collections/alice/repos/webapp.git","collection":"alice","repo":"webapp","refs":"3f9a...","packed":48213004}
{"kind":"file","path":"collections/alice/repos/webapp.issues/7/issue.json","size":344,"mtime":1755600123456,"mode":420}
{"kind":"end","files":9143,"bytes":1043221,"repos":12}
```

Paths are vault-relative and always POSIX-separated, and `mtime` is in milliseconds. `?hash=1` adds `sha256` to each file line, for `--checksum` runs and for `mochi backup verify`. `?exclude=` takes any of `runs`, `sites`, `lfs`, `secrets` and leaves those out. A repository is reported as `kind:"repo"` and its contents are deliberately *not* enumerated: git is their transport, and `refs` is a digest over every ref, what it points at, and where `HEAD` points, so a client can skip a repository nothing has changed in. The `end` line is what says the walk completed; a client that does not see one must not treat the manifest as the whole vault.

`POST /api/backup/fetch` takes `{"paths": [...]}` and answers with the bytes of each, framed by a JSON line rather than packed into a tar:

```
<line: {"path":"collections/alice/repos/webapp.issues/7/issue.json","size":344}\n><344 bytes>
<line: {"path":...,"size":...}\n><bytes>
<line: {"end":true,"missing":["collections/alice/repos/webapp.issues/9/body.md"]}\n>
```

A length-prefixed stream needs no tar on either side, has no symlink, ownership, or path-traversal cases to get wrong, and lets a file that vanished between the manifest and the fetch be reported in the `end` line rather than aborting the transfer. That last case is not hypothetical: CI retention trims run history while a backup of it is in flight. A path that is not inside the vault, including anything with a `..` segment, is a `400` rather than a `missing` entry. One request may name at most 2000 paths and 64 MB of file, over which it is a `400` naming the limit and the client asks for fewer; a request naming a single path is exempt from the byte limit, so a large file is still fetchable.

## Runners

Registering the runners a vault will hand jobs to. Note the plural: these are `/api/runners`, an ordinary admin surface authenticated by a user's token, and are not the runner protocol below.

```
GET    /api/runners                    registered runners, their liveness, and the queue  (admin)
POST   /api/runners                    register one   {name, labels?, allow}              (own every collection in allow, or site admin)
DELETE /api/runners/:name              remove one                                         (the same, over its allow)
```

`POST` returns `{name, token, labels, allow}`, and the token once: it is what `mochi runner run --token` presents, and only its hash is kept. `allow` is a list of globs saying which repositories the runner serves and is required, since a runner with no allow list could take no job. `labels` defaults to `["ubuntu-latest"]`.

Registration takes ownership of every collection the `allow` globs name (a site admin covers any), because a runner executes repository-controlled code on its own machine: granting one a repository is granting that repository's authors the runner. Removing a runner takes the same standing over the allow list it was registered with. A name that is already registered is 409.

## The runner protocol

Each runner in that listing carries `lastSeen` (when it last spoke to the vault, or `null` if not since the vault started: it is kept in memory, so a restart forgets it and a live runner re-announces within one poll) and `running` (the job it holds, or `null`). Beside them, `queued` lists the jobs waiting for a runner with the `runs-on` labels each is asking for, which is what answers "why has this run not started".

`/api/runner/*`, singular, is a private protocol between a vault and the runners it hands jobs to, authenticated by a runner token rather than a user's. It is not an interface to program against and is not documented here. [Workflows](workflows.md) describes what a runner is and does. `/api/manual/*` is the same kind of thing for `mochi job run`, the process behind a pasted exec command, and is private for the same reason.

## Rate limits

A read is not rate limited by count, but three things bound what the server will do:

- **Concurrency gates** on the routes that spawn git. Beyond one, a request waits briefly and is then refused with `503` and `Retry-After`.
- **Failed credential checks,** per address and per address-and-username. A working token is never throttled however often it is used. A refusal is `429` with `Retry-After`.
- **A coarse per-address ceiling** on everything not exempt. `/api/runner/*` is exempt, since a runner polls continuously and legitimately.

The numbers, and how to change them, are in [Deploying a vault](deploying.md#limits).
