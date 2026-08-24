# The vault

How a vault is laid out on disk, and how signing in to the web interface relates to the tokens git uses.

A vault is a plain directory. Its collections are in `collections/`, and a collection's repositories are in that collection's `repos/`; everything else a repository accumulates sits beside it there, under a suffixed name:

```
<vault>/
  vault.json                    (users and hashed tokens; created on first start)
  config.json                   (vault settings: theme, sites host, CI retention, limits)
  egress.json                   (bytes sent out, per repository per day; created on first request)
  .secret                       (session-cookie signing key; created on first need)
  runners.json                  (registered workflow runners; created when you add one)
  redirects.json                (where renamed things used to be; created on the first rename)
  collections/
    alice/
      collection.json           (the collection's explicit owners; created when one is added)
      repos/
        .mochi.git/         (the collection's profile README; see below)
        hello-numerics.git/     (bare repository)
        hello-numerics.runs/    (its workflow runs and logs)
        webapp.git/             (holds mochi.json: visibility and collaborators;
                                 and topics: the repository's topics, one per line)
        webapp.site/            (static site for webapp)
        webapp.issues/          (its issues, one directory each)
        webapp.pulls/           (its pull requests, one directory each)
        webapp.releases/        (its release notes, one file per tag)
        webapp.lfs/             (its Git LFS objects, when no bucket is configured)
    bob/
      repos/
        notes.git/
```

The `.git` suffix on repository directory names is optional; it is stripped for display either way.

Two levels of the tree hold only things somebody named, and nothing else. That is what `collections/` and `repos/` are for: the vault's own files sit beside its collections rather than among them, and a collection can gain files of its own without any of them being a name a collection or a repository may then never be called. A file added to the vault later takes no name away from a vault that already exists.

There is nothing else: no database, and no state outside this directory. That is what makes backing up a vault `cp -a` and moving one to another machine `rsync`, and it means each part of a vault can be read, written, and grepped with ordinary tools while the server is running, since the server reads what is on disk on every request. Both of those need a shell where the vault is, which a vault on a Fly volume does not have; [Backing up a vault](backup.md) is the same copy pulled over HTTP instead, and is what to use for a hosted vault. Each of these directories is described alongside the feature that writes it: [issues and pull requests](issues-and-pull-requests.md), [sites](sites.md), [workflows](workflows.md), and [Git LFS](lfs.md).

## Who may do what

Authorization is GitHub-shaped: roles on repositories, owners on collections, and one site-admin bit, each stored with the thing it protects.

- **A user owns the collection named after them.** Nothing records this; it follows from the name, the way a GitHub account owns its namespace. An owner holds the admin role on every repository in the collection, may create repositories in it (including by push-to-create), and manages the collection itself: its settings, its owners, its name.
- **A collection may list further owners** in `collections/<name>/collection.json`:

  ```json
  { "owners": ["bob"] }
  ```

  The file sits beside `repos/`, so it moves with the collection when the collection is renamed. Owners and site admins edit the list, on the collection's settings page, with `mochi collection owner add`, or over the API.
- **A repository may list collaborators**, each with a role, in `mochi.json` inside the bare repository, beside git's own `config`. The same file carries the private flag:

  ```json
  { "private": true, "collaborators": { "carol": "read", "dave": "write" } }
  ```

  The roles order as `read` < `write` < `admin`. *read* may see a private repository; *write* may also push, edit files in the browser, and manage branches, tags, issues, and releases; *admin* may also change the repository's settings, visibility, and collaborators, rename it, and delete it. A repository with no `mochi.json` is public with no collaborators, which is what every repository was before the file existed. Collaborators are managed on the repository's settings page, with `mochi collab add`, or over the API.
- **A site admin** (`"siteAdmin": true` on the user in `vault.json`) holds the admin role everywhere and manages users, runners, and the vault's own settings. The `owner` user a fresh vault creates is one.

Anyone may read a public repository, signed in or not. A private repository is visible to its collaborators, the collection's owners, and site admins, and to nobody else: everyone else gets the same 404 an absent repository gets, on the web, over git, in the API, and in every listing, so a private name proves nothing by existing. A repository is made private at creation (`--private`, or the checkbox on the new-repository form) or from its settings page later; push-to-create always creates public repositories, since a push has no way to carry the flag. A fork of a private repository starts private. One deliberate exception: a private repository's published site stays public, like GitHub Pages on a private repository, because the sites hostname serves without sessions; withdraw the site directory if the site must go too.

A token may be minted with a scope, globs over `collection/repo`, which narrows what its holder may reach: outside its globs the token grants nothing beyond what an anonymous visitor gets, and inside them it caps at the write role, so a restricted token can never administer anything. This is how a script or a CI job is given one repository and nothing else.

### A vault.json from before roles

`vault.json` used to grant push and admin globs per user. A file written that way (it lacks `"version": 2`) is translated the first time a server that knows roles starts: admin scope over everything becomes the site-admin bit, scope over a whole collection becomes ownership of it, and scope over a single repository becomes a collaborator entry with the matching role (`write` for push scope, `admin` for admin scope). The original file is kept beside the new one as `vault.json.pre-roles`, and each translation that rounds up (there is no collection-wide write role to round down to) is printed as the server starts. Token scopes are unchanged: they narrowed a token before and they narrow one now.

## A collection's profile README

A collection page is a list of repository names, which says what a collection holds but not what it is for. A collection can introduce itself instead: a repository named `.mochi` in the collection, holding `profile/README.md`, has that file rendered above the listing. GitHub reads an organization's profile out of a `.github` repository the same way, and the convention is borrowed rather than invented so that the file needs no new place in the vault and no new way to edit it.

```
collections/
  alice/
    repos/
      .mochi.git/       ->  profile/README.md is shown on /alice
```

The repository is an ordinary one. It is created by pushing to `/alice/.mochi` or from the new-repository form, it appears in the collection's listing like any other, its own root `README.md` shows on its own page rather than on the collection's, and the write role on `alice/.mochi` is what decides who may change the profile. The file is read from the repository's default branch, so a change to it can be reviewed as a pull request first. Relative links and images in it resolve against `profile/`, as they do in any other README the interface renders, and `#12` still points at that repository's issue 12. Making the `.mochi` repository private hides the profile from anyone who could not read the repository, along with the repository itself.

Nothing is required. A collection without the repository, without the file, or with the file empty renders exactly as it did before, and a viewer who could administer the collection is offered a link to write one. Names beginning with a dot are otherwise unusual in a vault, and a leading dot is allowed for a repository alone: a collection or a user may not begin with one.

## A user's profile page

A user owns the collection named after them, so `/<username>` is already their namespace; the same page is their profile, the way `github.com/<user>` is both. The page exists as soon as the user does, before their collection holds anything, and shows the profile they wrote, the profile README described above (in their case `<username>/.mochi/profile/README.md`), and their repositories.

The written part of the profile is a display name, a short bio, and up to five links, edited at `/settings/profile` (reached from the account menu or the Edit profile button on the user's own page) and stored as a `profile` field on the user in `vault.json`:

```json
{ "profile": { "name": "Alice A.", "bio": "Keeps this vault.", "links": ["https://example.org"] } }
```

Links are held to `http(s)` URLs where they are saved, since they render as hyperlinks on a page other people read. Usernames elsewhere in the interface lead to these pages: issue, pull request, and comment authors, workflow run actors, contributor faces, and commit authors whose email resolves to a user (the synthetic `<user>@noreply.<host>` address web edits carry, or the emails listed on the user's admin page). Writing `@name` in markdown, in a comment, a README, or release notes, links to that user's profile too, when the vault knows the name; a name it does not know stays plain text.

## A vault from before this layout

Collections used to sit directly in the vault directory, and repositories directly in a collection. A vault written that way is moved to the current layout the first time a server that knows it starts, and nothing has to be asked for:

```
Migrated 2 collection(s) to collections/<collection>/repos/: alice, bob
```

The move is renames only. No file is read, copied, or rewritten, so it costs the same on a vault of one repository and a vault of a hundred gigabytes, and a full disk does not stop it. Repository and collection names do not change, so every URL, clone address, and token scope means afterwards exactly what it meant before. A vault already on this layout is read once and left alone, so the check costs nothing on every start after the first.

If the migration cannot be finished - a permission the server does not have, a collection already occupying a name in `collections/` - it says so and the vault is not served. That is deliberate: a vault whose repositories are all still on disk should not come up looking empty. An interrupted run leaves a `.collections-migrating` directory behind, and the next start finishes from it.

One thing does not move: Git LFS objects in a bucket. Their keys are a bucket's, not the vault directory's, and rewriting them would mean copying every object; the local backend's `.lfs` directories move with their repositories like everything else.

## Signing in on the web

Users sign in with their username and an existing token, the same credential git uses for pushing; there are no passwords and no separate web credential. The server sets a signed, stateless session cookie (30 days, `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS). The signing key lives in `<vault>/.secret`; rotating that file invalidates every session at once, and permissions are re-derived from `vault.json` on every request, so a role taken away from a user applies to their open session on their next click. A session is bound to the token it was created with, and that token is looked up in `vault.json` on every request, so deleting one token ends the sessions started with it and leaves the user's other sessions untouched. Deleting the user ends all of theirs, and rotating `.secret` remains the way to end every session on the server at once.

Three conveniences sit beside the token form, all ending in the same session cookie and all revocable from `vault.json` like everything else.

**Passkeys.** A signed-in user can add a passkey from their account page (the user menu, then "Your account"), and afterwards the sign-in page offers "Sign in with a passkey": one confirmation with the screen lock or security key, no username typed. The vault stores only the credential's public half, as a `passkeys` field on the user in `vault.json`; the private key stays with the browser or device. A session signed in this way has the user's full standing, which is why a session from a restricted token may not add one. Passkeys are scoped to the hostname the vault is served under, so they need HTTPS (or localhost) and do not survive a move to a new domain; tokens are unaffected by either, so nobody is locked out. A user removes their own passkeys on the account page, and an administrator removes anyone's on `/admin/users/<name>`; removal ends the sessions signed in with that passkey on their next request, exactly as revoking a token does. git does not speak WebAuthn, so pushing keeps using tokens.

**Signing in another device.** The account page can show a short one-time code (five minutes, one use). On the other device, "Enter a code from a signed-in device" on the sign-in page redeems it. The new session is bound to the same token or passkey as the session that showed the code, so one revocation ends both.

**`mochi web`.** The CLI already holds a token, so `mochi web` asks the vault for a one-time sign-in link and opens it in the browser. The link lands on a page that names the account and signs in on a click; it works once, expires after two minutes, and the session it starts is bound to the same token the CLI holds.

Abilities in the interface mirror the roles exactly. The write role on a repository enables editing files and managing branches, tags, issues, and releases; the admin role adds the repository's settings, visibility, collaborators, rename, and deletion; the site-admin bit adds user, runner, and vault management. Signing in with a restricted (token-scoped) token carries that restriction into the session, and such sessions can administer nothing. Controls a user cannot use are simply not shown.

File edits use optimistic concurrency: the edit form records the commit it was loaded against, and if the branch moves before you commit, the edit is refused with a conflict page rather than clobbering the other change. Web commits are authored as `<username> <username@noreply.<host>>`. Contributor listings resolve that synthetic address back to the user, and an administrator can list a user's real git author emails on the user's admin page (`/admin/users/<name>`, stored as an `emails` field in `vault.json`), so one person pushing under their own identity and editing in the browser shows as one contributor rather than two. That page is also where each token a user holds is listed and revoked; revocation applies to the next request, for git and for web sessions alike.

One deliberate asymmetry: repositories created by push set `receive.denyDeletes`, so `git push --delete` is refused, while the web interface allows branch deletion after confirmation. The receive hook guards against accidents; a confirmed click is explicit intent.

## Renaming a repository or a collection

A repository is renamed, or moved to another collection, from its own Settings page; the two are one operation, since both are a directory rename. Renaming in place takes the admin role on the repository; moving it to another collection is also a creation over there, so that half additionally takes permission to create in the destination collection, exactly as a transfer does on GitHub. A collection is renamed from a Settings page of its own, at `/<collection>/settings`, reached from the button beside its name; that takes ownership of the collection, and the owners file moves with it, so the owners after the rename are the owners before it. Implicit ownership follows from the name and would not survive, so when the collection being renamed is somebody's namespace, that user is written into the explicit owners on the way rather than being locked out of what is still theirs. Nothing is confirmed by typing the name, as deletion is: a rename that was a mistake is undone by renaming it back. An empty collection is deleted from the same settings page, under a typed confirmation as a repository is; one holding any repository is refused rather than emptied.

Both are also operations of the CLI and the JSON API, as everything in the web interface is: `mochi repo rename`, `mochi collection rename`, and the `POST /api/repos/:c/:r/rename` and `POST /api/collections/:name/rename` routes behind them. Neither takes a `--yes` or a confirmation, for the reason above.

Everything a repository or a collection has accumulated moves with it, including sites, workflow runs, issues, pull requests, releases, and Git LFS objects. Collaborators travel inside the repository and owners inside the collection, so roles survive a rename untouched. One thing does not: token scopes in `vault.json` still name the old collection, so a scope that covered `oldname/*` covers nothing after the rename and has to be granted again under the new name; the page says so before the rename is made. Rewriting scopes automatically was considered and not done, since a glob is a statement about what a user may reach rather than a pointer to a directory, and quietly widening one is worse than leaving it to be granted deliberately.

### The old address

A rename changes every address the thing had, so the vault remembers the old one and redirects to the new. This covers the web pages, git over HTTP, the Git LFS endpoints, and the JSON API, since a redirect that only moved the browser would leave a clone, a `git fetch`, and a program using the API failing on an address a link follows happily:

```
$ curl -sI http://vault.example/demo/proj | head -2
HTTP/1.1 301 Moved Permanently
Location: /demo/renamed
```

The path under the name is carried across untouched, so `/demo/proj/blob/main/README.md` becomes `/demo/renamed/blob/main/README.md`, and a clone of the old URL follows the redirect and records the new one. Renaming a collection redirects every address under it, the collection page and each repository in it alike. When a sites hostname is configured, a site's own hostname is redirected too: `proj--demo.<sites host>` sends visitors to `renamed--demo.<sites host>`.

A push follows the redirect too, so a clone made before the rename keeps pushing without its remote being changed. That settles what a push to a redirected name does not do: it does not create a repository there, as a push to an unused name would. Creating a repository under a name that is being redirected is done deliberately, from **New repository** or `POST /api/repos`, and from that moment the name is its own again.

The redirect is consulted only when the old name is free, which is the whole of the rule that bounds it. Create a repository called `proj` in `demo` after the rename and it owns that name outright; the redirect goes quiet from that moment, with nothing to switch off. Renames chain, so a repository renamed twice is reachable from either of its former names. A deletion takes the redirects that pointed at what it removed, so a name is never redirected to a repository that merely inherited its name.

What is remembered is in `redirects.json` at the vault root, keyed by name:

```json
{
  "repos": { "demo/proj": "demo/renamed" },
  "collections": { "oldname": "newname" }
}
```

The file is pruned on each rename: an entry whose old name is in use again, or whose chain no longer leads anywhere, is dropped, since a lookup already ignores it. A vault that has never renamed anything has no such file, and the redirect costs it one `stat` per request.

Two limits are worth stating. Redirects are keyed by name rather than by any identity a repository carries, which is why deletion has to clean up after itself as described above. And a redirect is served with `Cache-Control: no-store` despite being a 301: a browser that cached it for a year would keep following it past the day someone created a repository under the old name, which is exactly when it has to stop.
