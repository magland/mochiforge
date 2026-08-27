# Backing up a vault

How to keep a copy of a vault on a disk of your own, updated incrementally, with snapshots you can go back to.

A vault is a plain directory, so on a machine you have a shell on, a backup is `cp -a` and a move is `rsync`. That remains true and remains the shortest answer. It is not true of the deployment `mochi deploy fly` produces: the vault is on a Fly volume, where there is no shell in the ordinary sense, no rsync at the far end, and no filesystem access except through `fly ssh`. The supported ways to get a copy of such a vault used to be a hand-written `tar` pipeline over `fly ssh console`, which transfers everything every time and is specific to one host, and Fly's own volume snapshots, which live at the same provider as the thing they protect.

Here we describe `mochi backup`, which pulls a whole vault over HTTP into a directory on your own machine. It needs no shell on the server and no flyctl, and it works identically against a Fly app, a VPS, a Docker deployment, and `127.0.0.1:3000`.

```bash
mochi backup ~/backups/myvault              # incremental sync
mochi backup ~/backups/myvault --snapshot   # ...then snapshot, then prune
```

The token needs to belong to a site admin, and must not be a token-scoped one, because the copy includes `vault.json`. The vault URL, the exclusions, and the retention policy are recorded in the backup directory, so after the first run a cron entry is the command and a directory:

```cron
17 3 * * *  mochi backup /srv/backups/myvault --snapshot --quiet
```

## A backup is a vault

```
~/backups/myvault/
  backup.json           which vault, what is left out, and how each run went
  current/              a servable vault: vault.json, collections/alice/repos/webapp.git/, ...
  snapshots/
    2026-08-19T140311Z/ a hardlinked copy of current/ at that moment
    2026-08-18T140256Z/
  .lock
```

`current/` has exactly the layout in [The vault](vault.md), with each `<repo>.git` a mirror created by `git clone --mirror`, which is a bare repository like any other. So restoring is one line:

```bash
mochi serve ~/backups/myvault/current
```

That is the whole recovery procedure, whether you want to look at last night's issues or stand the vault back up somewhere else, and it can be rehearsed at any time. To put the vault back on a host, copy `current/` onto that host and serve it there. A snapshot is a vault too, so `mochi serve ~/backups/myvault/snapshots/2026-08-18T140256Z` reads the vault as it was that morning, including whatever has since been deleted.

Note that there is no `mochi restore`. Reconciling a backup against a running vault is a different and much harder operation, and having one would leave two restore paths of which only one ever gets tested.

## How the transfer works

Repositories and everything else travel by different routes, because half the problem was already solved.

**Repositories** come across as mirrors. `git fetch` is the best incremental transport available for a bare repository: it moves only the objects the far end lacks, it is atomic per ref, and it runs over the same anonymous smart-HTTP endpoint every clone uses. A repository whose refs and default branch have not changed since the last run is skipped without a request at all, which is what keeps a nightly run over a hundred quiet repositories to a single request rather than a hundred handshakes against a machine that has to wake up first.

A few files inside each repository travel by the other route, because a mirror clone does not carry them: the `description`, which every listing shows; the `config`, which holds the fork parent and the `receive.*` protections a repository was created with; `site.json`, which holds the site's enabled switch, source, and label; and `mochi.json`, which holds the private flag and the collaborators, and whose loss would be the worst of the set, since a restore without it would serve every private repository as public. They are copied byte for byte, so a restored repository has its description, its push protections, its site settings, and its visibility rather than git's defaults. Note that the copy therefore has no `origin` remote, which is right: a restored repository should not point back at where it was restored from.

**Everything else** is compared by size and modification time, as rsync does by default, and fetched only where it differs. That is issues, pull requests, releases, sites, run history, LFS objects on the volume, and the state files at the vault root. Two routes carry it, `GET /api/backup/manifest` and `POST /api/backup/fetch`, both described in [The JSON API](api.md).

A file is also fetched again when the copy in `current/` is no longer the copy the last run wrote, so a backup damaged locally repairs itself on the next run rather than staying wrong. `--checksum` compares hashes from the vault against the bytes on disk instead of timestamps, which reads everything and is the mode to reach for when something is suspected rather than the one to run nightly.

The manifest is authoritative for deletions. A path in `current/` that it does not list is removed, and so is a mirror whose repository is gone from the vault. Deleted data therefore survives in the snapshots and nowhere else, which is what makes retention worth configuring.

Every path the manifest names has to be a path inside the vault, and the run stops on one that is not: a name that is absolute, or that climbs with `..`, would put a file somewhere on this machine rather than in the backup, and a vault answering that way is not one whose other answers are worth acting on. The vault holds the paths a fetch asks for to the same rule, so this is the mirror of it on the machine doing the copying.

Every write into `current/` goes to a temporary file in the same directory and is renamed into place, which the snapshots depend on. See [Snapshots and hardlinks](#snapshots-and-hardlinks).

## Options

Everything is a whole vault: this backs up `vault.json` too, so a partial backup would not be servable as-is.

| Option | Effect |
| --- | --- |
| `--snapshot` | Take a snapshot after a successful sync, then prune |
| `--keep-daily N`, `--keep-weekly N`, `--keep-monthly N` | Retention (defaults 7, 4, 6) |
| `--no-runs`, `--no-sites`, `--no-lfs` | Leave out `<repo>.runs`, `<repo>.site`, `<repo>.lfs` |
| `--no-secrets` | Leave out `vault.json`, `runners.json`, and `.secret` |
| `--checksum` | Compare hashes rather than size and modification time |
| `--json`, `--quiet` | A machine-readable summary; or nothing on success |

The vault URL, the exclusions, and the retention policy are sticky: they are recorded in `backup.json` and stay in force until changed. For the exclusions that means naming none keeps whatever the last run used and naming any at all replaces the set, which is how a category is put back. `--checksum`, `--snapshot`, `--json`, and `--quiet` are modes for one run rather than settings, and are not recorded.

Run history is included by default. It is the largest churning part of a vault, and CI retention already trims it (see [Workflows](workflows.md)), but a backup that silently drops a category of thing the web interface shows is a backup that surprises someone eventually. `--no-runs` is there for anyone who would rather have the bytes.

`--no-secrets` leaves out the three files that hold credentials or session state. Note what that costs: a `current/` without `vault.json` is not a vault that can be served as-is, since starting a server on it initializes a new one with a new owner. Use it when the backup is going somewhere less trusted than the vault, and keep `vault.json` somewhere else.

`.lock` in the backup directory stops two runs from interleaving. A second concurrent run exits 5, the conflict code, rather than fetching against the first one's half-written files. A lock whose holder is gone is broken with a warning, since the usual way to leave one behind is a machine that lost power mid-run, and a backup that stops running until somebody notices a stale file is a backup that stops running.

## Snapshots and hardlinks

`--snapshot` builds `snapshots/<utc-timestamp>/` by walking `current/` and hardlinking every file. A snapshot of a 5 GB vault costs one inode per file and no data, and it is a directory that can be served, diffed, or copied out with ordinary tools.

This works only because nothing in the backup is ever modified in place. Git rewrites refs, `packed-refs`, and packfiles by rename, Mochi Forge writes its state files by rename, `mochi backup` writes by rename, and reflogs, the one thing git appends to, are turned off on the mirrors. **Anything that opens a file under `current/` for appending corrupts every snapshot that has already hardlinked it**, since they share the inode. Do not edit files under `current/` in place, and if you write code that touches a backup, write by rename. `mochi backup verify` reports a file with more hard links than the snapshots can account for, and taking a snapshot refuses such a file outright.

Retention is grandfather-father-son: the newest snapshot of each of the last N days, weeks, and months is kept and the rest are removed, evaluated in UTC so the decision does not move with the machine's timezone. The newest snapshot is always kept whatever the numbers say.

Note what "the newest of each day" means for a snapshot taken by hand. Two snapshots on the same UTC day leave one, the later, since only one of them is that day's newest. That is the same rule `restic` and `borg` apply, and it is the rule to remember before taking a snapshot in the morning and expecting it in the evening. `mochi backup prune <dir>` applies the policy without syncing.

The honest cost: a snapshot pins the packfiles that were current when it was taken, so a repack in a busy repository leaves the old pack on disk until the last snapshot referring to it is pruned. Disk use therefore grows faster than the vault does, and pruning is what reclaims it.

## Checking a backup

```bash
mochi backup list ~/backups/myvault      # snapshots, sizes, and the last run
mochi backup verify ~/backups/myvault    # against the vault, and against git
mochi backup prune ~/backups/myvault     # retention, without syncing
```

`verify` runs `git fsck --connectivity-only` over every mirror, asks the vault for hashes, and reports anything missing, extra, or different, including the hardlink check above. Note that it makes the vault read every byte it holds, so it is a thing to run when something is suspected or on a schedule of its own, not after every sync. It exits non-zero when there is something to report, so cron will tell you. `--connectivity-only` skips re-hashing every blob, which turns an hour into a minute and still catches the failure that matters, an object the history refers to and the backup does not have.

## What a backup does not promise

There is no vault-wide point-in-time image. The server reads and writes what is on disk per request and holds no lock a client could take, so a run is a walk of a live tree.

The failure mode that produces is a mixed vintage, not a corrupt file. Each ref update is atomic and each state file is written by rename, so every individual file in a backup is a file that really existed; what can differ is which moment each of them came from. A pull request merged halfway through a run might be captured with its merge commit but its pre-merge state. After the data pass, the manifest is requested again and anything whose timestamp moved during the run is fetched again, which closes the window for everything except a file written twice in the same run; and the next run corrects that.

**LFS objects in a bucket are not in the backup.** With a bucket configured they are not in the vault at all (see [Git LFS](lfs.md)), so there is nothing at the vault for this command to read. The backup notices and warns once per run. Back the bucket up alongside it:

```bash
rclone sync myvault-bucket:/ ~/backups/myvault-lfs
```

Re-implementing bucket-to-disk sync here would be a worse `rclone`. LFS objects stored on the volume, which is the default, are ordinary files in the vault and are backed up like everything else.

**Encryption and off-site copies are somebody else's job, deliberately.** The backup directory is plain files, so point `restic`, `borg`, `rclone`, or a Time Machine volume at it. Note that a snapshot is hardlinks, and a tool that follows them without recognizing them will copy the same bytes once per snapshot; most of them have a flag for it.

## On Fly

A Fly machine deployed by `mochi deploy fly` stops when idle and starts on the next request, so the first request of a backup wakes it and waits a few seconds. The command says so rather than appearing hung. A backup keeps the machine awake for its duration, which costs a little.

`mochi deploy fly show <app>` names the backup this machine keeps for that app, if it has one, so that "is anything copying this vault off Fly?" is a question with an answer.

Fly's own daily volume snapshots remain useful and are not a substitute: they live at the same provider as the volume they protect, and they cannot be read without Fly. Use both.
