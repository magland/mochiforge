# Sites

A static site per repository, served from a sibling directory, once the site is enabled.

A repository can have a static site, served at `/<collection>/<repo>/site/`. The content is plain files in a sibling directory next to the bare repository:

```
<vault>/collections/alice/repos/
  webapp.git/     (the repository)
  webapp.site/    (its site; index.html at the root)
```

Anything that can write files can publish: a manual copy, a build script, a workflow. Directory requests serve `index.html`, and a `404.html` at the site root, if present, is used for missing paths. While the site is enabled and the directory exists, a Site tab appears in the repository's navigation, and the repository's row in its collection listing carries a globe link straight to the site.

Everything in the directory is served, dotfiles included, so copy in what you mean to publish and not, say, a working tree with its `.git` alongside it. What is not served is anything outside the directory: a symlink that resolves out of the site, including into another repository's site, reads as a missing file.

## Enabling a site

A site is opt-in per repository, the way GitHub Pages is. The directory alone publishes nothing: until the site is enabled, its routes answer 404, no Site tab appears, and a workflow's deploy step is refused. Enabling and the rest of the site settings take the admin role on the repository, like visibility, because enabling a site publishes whatever the directory holds to everyone.

The switch lives in the Site box of the repository's settings page, in `PATCH /api/repos/<c>/<r>` as `siteEnabled`, and in the CLI:

```bash
mochi repo edit alice/webapp --enable-site
mochi repo edit alice/webapp --disable-site
```

Disabling keeps the files: the directory stays on disk (and stays in backups), nothing is served, and re-enabling brings the site straight back. Deleting the directory is a separate, manual act.

On disk the settings are `<repo>.git/site.json` beside git's own config, hand-editable like everything else in a vault:

```json
{
  "enabled": true,
  "source": "copy",
  "label": ""
}
```

A missing or unreadable file reads as disabled. Note that this makes sites strictly opt-in on upgrade: a vault created before this setting existed serves none of its sites until each is enabled.

`source` says how the site is published, and it gates writing rather than serving, since the server cannot tell how bytes landed in a directory it only reads:

- `"copy"` (the default): whatever can write the vault publishes by writing the directory, and the runner's `deploy-pages` endpoint is refused.
- `"actions"`: a workflow run's `deploy-pages` step may publish the site too. See [Workflows](workflows.md).

## Site content is untrusted code

A site is HTML and script written by whoever can write the directory, which is anyone with the write role on the repository and any workflow that publishes it. Publishing a site is therefore a real privilege, and it should be read that way when handing out roles. A private repository's site, when it has one, stays public: the sites hostname serves without sessions, so the rendered site is world-readable even while the code is not, like GitHub Pages on a private repository.

It matters because of what a document can do on the origin it is served from. Site files live under the vault's own hostname, so without a boundary a site's script could `fetch('/anything', {credentials: 'include'})` with the visitor's session cookie, read the response, take the CSRF token out of any page that session can load, and then post as that visitor. If the visitor happened to be an owner, that reaches user creation and token minting. `httpOnly` and `sameSite` do not help, because the script is not cross-origin.

So site responses are sandboxed. Each one carries:

```
Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads
Access-Control-Allow-Origin: *
X-Content-Type-Options: nosniff
```

The absence of `allow-same-origin` is the point: it places the document in an opaque origin, which is not the vault's origin and not any other site's either. Script still runs, so most of what a static site does still works. What a sandboxed site cannot do:

- read or write cookies, including its own; `document.cookie` is empty and setting it does nothing
- use `localStorage` or `sessionStorage`; touching either **throws**, so a library that reaches for it without a guard will fail rather than degrade
- use `IndexedDB`
- register a service worker, so an offline-first app will not install

`Access-Control-Allow-Origin: *` is there so that a page in an opaque origin can still `fetch` its own sibling files, which is what a single-page app, a wasm loader, or any data-driven site needs. Those requests carry no credentials, so allowing them gives nothing away. The header goes on site responses only, never on forge pages and never on the API.

Forge pages carry a policy of their own:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src * data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none';
  form-action 'self'; frame-ancestors 'self'
```

`frame-ancestors` is why only the forge may frame its own pages. The CSRF token refuses a request forged from another origin, but it does not refuse a real click on a real control inside somebody else's frame, which is what that closes.

`script-src 'self'` is the one that matters most, and it is why forge pages contain no inline script at all. The interface serves untrusted content from its own origin, a repository's files and a rendered README and an issue somebody wrote, so the escaping in the templates is not the only line worth having: under this policy, markup that somehow carried an injected `<script>` or an `onclick` still could not run. The single script a page loads is `/assets/page.js`, and anything page-specific reaches it through a data attribute rather than through generated JavaScript. A policy that allowed the interface's own inline script would allow an injected one too, since the browser cannot tell them apart.

Two directives are deliberately looser. `style-src` allows inline style, because the interface paints with values it computes: a language bar's widths, a theme swatch's palette, an egress meter's fill. An inline style cannot execute anything, so it buys far less than `script-src` does and costs nothing to keep. And `img-src` allows any host, because a README may already reference an external image and does today; narrowing it would quietly stop those rendering, and doing it properly needs an image proxy, which is what GitHub built for the same reason.

Site responses replace the whole header with the sandbox above and so are restricted by none of this: a published static site is ordinarily embedded wherever its author likes, may load whatever it likes, and that is no business of the forge's. Raw file responses replace it too, with a bare `sandbox`.

## A hostname per site

A sandbox is the right default because it needs no configuration and works on a bare `*.fly.dev` name. It is also blunt: a site that wants storage, or a service worker, or a cookie of its own has no way to get one. The alternative is to give each site a real origin, which is what a hostname does.

Set one on the vault, from wherever you administer it:

```bash
mochi config set --sites-host vault-sites.example.org
```

That writes `sites.host` in the vault's `config.json`, which is read per request, so it is in effect on the next one; `--sites-host ''` clears it again. The same field is on the vault settings page in the web interface (`/admin/settings`), and hand-editing the file does the same thing, which is what a vault with no CLI to hand still supports.

Each eligible repository's site is then served from `<repo>--<alias>.<sites host>`, so `webapp` in collection `alice` becomes `webapp--alice.vault-sites.example.org`. The alias is usually the collection's own name, and [Collection aliases](#collection-aliases) below covers the case where it cannot be. On that hostname the repository is the origin root: `/index.html` is the site's own, and so are `/assets/style.css` and `/favicon.svg`, which the forge does not shadow there. No session is ever resolved on a sites hostname and no cookie is set on one, so a site cannot see a visitor's session even in principle. Responses carry `X-Content-Type-Options: nosniff` and nothing else; the sandbox is gone, because the origin is now doing that work.

The forge path keeps working and redirects: `/<collection>/<repo>/site/...` answers `302` to the same path on the site's origin, query string included. It is a temporary redirect on purpose, so removing `sites.host` takes effect on the next request rather than after every cache in the way has forgotten it. The Site tab links straight to the origin.

Because the hostname is built from the two names, renaming the repository or the collection moves the site to a different origin. The hostname it had answers `301` to the one it has now, path and query kept, on the same terms as the redirect on the forge host: only while no repository answers to the old name. See [The old address](vault.md#the-old-address).

The double hyphen is the separator, and it is unambiguous because neither half may contain one. A name may appear in a hostname only if it matches `^[a-z0-9]+(-[a-z0-9]+)*$`: lowercase letters, digits, and single interior hyphens. That rules out uppercase, dots, underscores, leading and trailing hyphens, and doubled hyphens. The combined label must also fit in the 63 characters DNS allows.

Repository names are more permissive than that, so **not every repository is eligible**, and an ineligible one keeps being served on the forge host under the sandbox unless its admin claims a label that is usable. This refuses rather than lowercases, because lowercasing `Webapp1` would collide with a `webapp1` beside it: hostnames are case-insensitive and both names are legal on disk. It is a documented rule, not a bug, and the Site tab points wherever that repository's site actually is.

A value that is not a plausible hostname is ignored and the default used, the same way an unknown theme name is, so a typo in `config.json` cannot take the vault down or serve sites from a name no certificate covers.

### Collection aliases

Collection names are as permissive as repository names, so a collection can be called something no hostname label may carry. Refusing there would be worse than refusing a repository name: every repository in `simulated_instruments` would have no derived hostname at all, and the tier that exists to be the guaranteed one would be missing for a whole collection. So a collection's name is not used directly. Each collection has a **site alias**, the label standing in for its name in every derived hostname, decided in three tiers:

1. the alias stored for the collection, when an owner has set one. It is checked against every other collection when it is written, so it is unique.
2. otherwise the collection's own name, when that name is already a usable label. Nothing can take this tier away: a vault serving `webapp--alice` keeps serving it whatever else is created later.
3. otherwise the name rewritten as a label, every run of characters a label may not hold becoming a single hyphen and the ends trimmed, so `simulated_instruments` becomes `simulated-instruments`. This tier applies only when no other collection holds that label at any tier.

The rewrite is deliberately not trusted to be unique: `a_b` and `a.b` both want `a-b`. When two names want one label, neither gets it, rather than one silently winning, and both collections' settings pages say which label is unavailable and why. An owner resolves it by storing an alias:

```bash
mochi collection edit simulated_instruments --site-alias sims   # <repo>--sims.vault-sites.example.org
mochi collection edit simulated_instruments --site-alias ''     # back to the tiers above
```

The same field is in the **Site alias** box of the collection's settings page, and `siteAlias` on `PATCH /api/collections/:name`. It takes ownership of the collection, the same as its rename. An alias another collection is already reached by is refused, naming it. The alias lives in `collections/<name>/site.json`:

```json
{
  "alias": "sims"
}
```

Changing an alias moves every site in the collection to a new origin at once, and unlike a rename the hostnames they had do not redirect: the alias they carry simply names no collection any more. A collection with no alias at all has no derived hostnames, and its sites stay on the forge host under the sandbox unless each repository claims a label of its own.

### Choosing the label

A repository need not keep the derived `<repo>--<alias>` label. Its admin can pick one, in the Site box of the settings page, as `siteLabel` on the PATCH route, or with:

```bash
mochi repo edit alice/webapp --site-label myapp     # myapp.vault-sites.example.org
mochi repo edit alice/webapp --site-label ''        # back to webapp--alice
```

A custom label is a single DNS label with no double hyphen, which is what keeps it from ever colliding with a derived name; a label another repository already holds is refused, naming the holder. While a custom label is set, the derived hostname answers `301` to it, path and query kept, the same way a renamed repository's old hostname does. This is also the way out for a repository whose name is not usable as a hostname label: pick a label that is.

Note that these labels are one flat namespace across the whole vault, first come first served, and any repository admin may claim from it. That is the trade-off for a short hostname, and it is why the derived name is what a site falls back to rather than what it depends on. The vault settings page lists every claimed label with the repository holding it, alongside each collection's alias, so what is taken can be read rather than discovered by having a claim refused.

Some labels are **reserved** and no repository may claim them: `admin`, `api`, `assets`, `cdn`, `forge`, `git`, `localhost`, `mail`, `ns1`, `ns2`, `sites`, `smtp`, `static`, `vault`, and `www`. These are the names an operator is likely to want under the sites host for something else, and a repository that had claimed one would quietly own it. A request for a reserved name is parsed as usual and then answers to nothing, which is what leaves the name free to point elsewhere. A label like `xn--p1ai` needs no reserving: no claimed label may contain a doubled hyphen at all, so none can be read as punycode.

### A custom domain

A site can also be served from a domain of its own, `docs.example.org` rather than anything under the sites host. Attaching one takes a site admin, not merely the repository's, because it is the operator's act all the way down: the operator points the DNS record at the vault, covers the name with a certificate, and answers for what the server serves under it.

```bash
mochi repo edit alice/webapp --site-domain docs.example.org
mochi repo edit alice/webapp --site-domain ''       # detach it
```

A site admin also gets a Custom domain field in the Site box of the repository's settings page, doing the same thing; other viewers see where the domain answers, or who to ask. On the API it is `siteDomain` on the PATCH route.

The mapping lives in `<vault>/domains.json`, beside `config.json` and hand-editable like it:

```json
{
  "domains": {
    "docs.example.org": "alice/webapp"
  }
}
```

A repository holds at most one domain, and a domain maps to one repository; attaching a domain another repository holds is refused, naming the holder. The domain becomes the site's canonical origin: the sites-host name (derived or custom label) answers `301` to it, and the forge path redirects there. The domain follows the repository through renames and is dropped with a deletion, so a repository created later under the name does not inherit it. On its domain the site is served exactly as it is on a sites hostname: unsandboxed, no session resolved, no cookie set, and `GET`/`HEAD` only.

Two cautions. The server serves a mapped domain to whatever `Host` header names it, so the reverse proxy or DNS is what decides which requests arrive; TLS for the domain is the operator's to provide, alongside the sites-host wildcard. And the server does not know the forge's own hostname, so nothing can stop a mapping from claiming it; map a domain you also use for the forge and the forge stops answering there. The sites host and its subdomains are refused, since those names already have a meaning.

### What a hostname does and does not isolate

Per-repository hostnames give each site its own storage, its own DOM, and its own service worker scope. They do **not** isolate cookies. The cookie boundary is the registrable domain, not the hostname, so a site at `a--alice.vault-sites.example.org` can set a cookie with `Domain=vault-sites.example.org`, which every other site on that host then receives. Fixing that would need the sites domain on the Public Suffix List, which is a submission rather than a code change.

So a site wanting private state should use `localStorage` or IndexedDB, which are keyed by origin and therefore genuinely separate. Treat cookies on a shared sites host as readable by every site on it.

The vault's own session cookie is not affected: it is set only on the forge's hostname, and over https it carries the `__Host-` prefix, which browsers refuse to accept from a cookie bearing a `Domain` attribute. That closes the other direction, where a sibling subdomain shadows a real session with one of its own.

The DNS records and certificates this needs are in [A domain of your own](deploying.md#a-domain-of-your-own).

GitHub calls this feature Pages, and earlier versions of Mochi Forge did too, with the directory named `<repo>.pages`. We renamed it because "pages" already means something else in a web interface made of pages. A vault created before the rename needs one command per site: `mv <repo>.pages <repo>.site`.
