import { avatar } from './avatar';
import { EgressSnapshot } from './egress';
import { Html, html, joinHtml, raw } from './html';
import { IconName, icon } from './icons';
import { isMarkdownFile } from './markdown';
import { markdownEditor, previewUrl } from './mdedit';
import { MARK } from './logo';
import { formatSize, timeTag } from './render';
import { Viewer } from './session';
import { Theme } from './themes';
import { isSiteAdmin } from './perms';
import { GithubAccount, UserProfile, UserRecord, passkeyBinding, tokenId } from './vault';
import {
  PageOpts,
  RepoCtx,
  agePassInput,
  copyButton,
  copyRow,
  csrfField,
  encPath,
  layout,
  repoHeader,
  repoOpts,
  repoUrl,
  userLink,
} from './views';

// Form pages for the UI operations. Every mutating form embeds the session's
// CSRF value and posts back to a handler that re-checks authorization against
// live vault.json.

function errorBanner(error?: string): Html | '' {
  return error ? html`<div class="form-error">${error}</div>` : '';
}

export function flashBanner(msg?: string): Html | '' {
  return msg ? html`<div class="flash">${msg}</div>` : '';
}

export function loginPage(next: string, error?: string, github = false): string {
  // A narrow card under the mark, centred on the page: signing in is the one
  // thing this page is for, so nothing else is on it. The passkey button is
  // hidden until the page script finds WebAuthn support, so a browser without
  // it sees the form it can use and nothing it cannot; the GitHub button is
  // decided by the server, since whether it can work is the vault's own state.
  const content = html`<div class="signin">
<div class="signin-mark">${raw(MARK)}</div>
<h1>Sign in to Mochi Forge</h1>
${errorBanner(error)}
<div class="form-box">
<form method="post" action="/login">
<input type="hidden" name="next" value="${next}">
<div class="field"><label for="username">Username</label><input type="text" id="username" name="username" autocomplete="username" autofocus required></div>
<div class="field"><label for="token">Token</label><input type="password" id="token" name="token" autocomplete="current-password" required></div>
<button type="submit" class="btn btn-primary">Sign in</button>
</form>
<div class="signin-alt" data-passkey-login hidden>
<button type="button" class="btn" data-passkey-login-btn data-next="${next}">${icon('lock')}<span>Sign in with a passkey</span></button>
<div class="form-error" data-passkey-error hidden></div>
</div>
${
    github
      ? html`<div class="signin-alt"><a class="btn" href="/login/github?next=${encodeURIComponent(
          next
        )}">${icon('person')}<span>Sign in with GitHub</span></a></div>`
      : ''
  }
</div>
<p class="muted small signin-note">A token is what git uses for pushing. Tokens are minted by an administrator; there are no passwords.
Passkeys are added from your account page, once you are signed in.</p>
<p class="muted small signin-note">Already signed in on another device? <a href="/login/link?next=${encodeURIComponent(
    next
  )}">Enter a code from it</a>.</p>
</div>`;
  return layout('Sign in', content, { path: '/login' });
}

/** The page a handoff code is typed into: the other half of accountLinkPage. */
export function loginLinkPage(next: string, error?: string): string {
  const content = html`<div class="signin">
<div class="signin-mark">${raw(MARK)}</div>
<h1>Sign in with a code</h1>
${errorBanner(error)}
<div class="form-box">
<form method="post" action="/login/link">
<input type="hidden" name="next" value="${next}">
<div class="field"><label for="code">Code</label><input type="text" id="code" name="code" class="mono" autocomplete="off" spellcheck="false" placeholder="ABCD-EFGH" autofocus required></div>
<button type="submit" class="btn btn-primary">Sign in</button>
</form>
</div>
<p class="muted small signin-note">On a device where you are already signed in, open your account page and choose
&ldquo;Sign in on another device&rdquo;. The code it shows works once and expires after a few minutes.</p>
</div>`;
  return layout('Sign in with a code', content, { path: '/login' });
}

/**
 * The page a `mochi web` link lands on. It names the account and asks for a
 * click rather than signing the browser in on arrival: a GET must not change
 * who the browser is, or a link someone was tricked into opening would sign
 * them in as somebody else without a word.
 */
export function loginLinkConfirmPage(username: string, code: string, next: string): string {
  const content = html`<div class="signin">
<div class="signin-mark">${raw(MARK)}</div>
<h1>Sign in to Mochi Forge</h1>
<div class="form-box">
<p>This link signs this browser in as <b>${username}</b>.</p>
<form method="post" action="/login/code">
<input type="hidden" name="code" value="${code}">
<input type="hidden" name="next" value="${next}">
<button type="submit" class="btn btn-primary">Continue as ${username}</button>
</form>
</div>
<p class="muted small signin-note">Not you, or not something you asked for? Close this page; the link works once and expires by itself.</p>
</div>`;
  return layout('Sign in', content, { path: '/login' });
}

/**
 * The signed-in user's own page: their passkeys and the way to another
 * device. Tokens are deliberately not here; they are minted and revoked on
 * the admin pages, and this page holds only what a user manages for
 * themselves.
 */
export function accountPage(
  viewer: Viewer,
  opts: {
    restricted: boolean;
    msg?: string;
    error?: string;
    github?: { enabled: boolean; account: GithubAccount | null };
  } = { restricted: false }
): string {
  const name = viewer.auth.username;
  const user = viewer.auth.user;
  const passkeys = user.passkeys ?? [];
  const rows = passkeys.map((p) => {
    const current = viewer.auth.token.hash === passkeyBinding(p.id);
    return html`<tr><td>${p.name ?? 'Passkey'}${
      current ? raw(' <span class="counter">this session</span>') : ''
    }</td><td class="muted small">${
      p.created ? timeTag(p.created, '') : ''
    }</td><td class="mono small muted">${p.id.slice(0, 8)}&hellip;</td><td class="right">
<form method="post" action="/account/passkeys/${encodeURIComponent(p.id)}/delete" class="inline-form">
${csrfField(viewer)}
<button type="submit" class="btn btn-danger-outline">Remove</button>
</form></td></tr>`;
  });
  const list = passkeys.length
    ? html`<table class="listing"><tbody><tr><th>Passkey</th><th>Added</th><th>Id</th><th class="right"></th></tr>${rows}</tbody></table>
<p class="muted small">Removing a passkey is immediate: a session signed in with it is signed out on its next page load.</p>`
    : html`<p class="muted">No passkeys yet.</p>`;
  const add = opts.restricted
    ? html`<p class="muted small">This session was signed in with a restricted token, which may not add passkeys:
a passkey signs in with your full account, so adding one takes a session that already has it.</p>`
    : html`<div class="inline-form" data-passkey-form>
${csrfField(viewer)}
<label for="pk-name">Name</label><input type="text" id="pk-name" name="name" placeholder="e.g. laptop" autocomplete="off">
<button type="button" class="btn" data-passkey-add>${icon('plus')}<span>Add a passkey</span></button>
</div>
<div class="form-error" data-passkey-error hidden></div>
<p class="muted small" data-passkey-unsupported hidden>This browser does not offer passkeys here. Passkeys need a browser
with WebAuthn, over https (or on localhost).</p>
<p class="muted small">A passkey signs you in to this vault's web pages with your screen lock or security key, instead of
the token. It is kept by your browser or device; the vault stores only its public half. git keeps using tokens.</p>`;
  const passkeyBox = html`<div class="form-box">
<h2>Passkeys</h2>
${list}
${add}
</div>`;
  const gh = opts.github;
  // Shown when the vault offers GitHub sign-in, and also when it no longer
  // does but a link remains: a stored credential should never be invisible to
  // the person it belongs to.
  const githubBox =
    !gh || (!gh.enabled && !gh.account)
      ? ''
      : html`<div class="form-box">
<h2>GitHub</h2>
${
          gh.account
            ? html`<p>Linked to <a href="https://github.com/${gh.account.login}"><b>${gh.account.login}</b></a> <span class="mono small muted">id ${String(
                gh.account.id
              )}</span>${gh.account.linked ? html`, since ${timeTag(gh.account.linked, '')}` : ''}.</p>
<p class="muted small">&ldquo;Sign in with GitHub&rdquo; on the sign-in page signs in as <b>${name}</b>. Unlinking is
immediate: a session signed in with GitHub is signed out on its next page load. git keeps using tokens either way.</p>
<form method="post" action="/account/github/unlink" class="inline-form">
${csrfField(viewer)}
<button type="submit" class="btn btn-danger-outline">Unlink</button>
</form>`
            : opts.restricted
              ? html`<p class="muted small">This session was signed in with a restricted token, which may not link a GitHub
account: signing in with GitHub carries your full standing, so linking takes a session that already has it.</p>`
              : html`<form method="post" action="/account/github" class="inline-form">
${csrfField(viewer)}
<button type="submit" class="btn">${icon('link')}<span>Link a GitHub account</span></button>
</form>
<p class="muted small">Linking sends you to GitHub to authorize once; nothing of GitHub's is stored here beyond the
account's id and name. Afterwards &ldquo;Sign in with GitHub&rdquo; on the sign-in page signs you in as <b>${name}</b>.
git keeps using tokens.</p>`
        }
</div>`;
  const handoff = html`<div class="form-box">
<h2>Sign in on another device</h2>
<form method="post" action="/account/link">
${csrfField(viewer)}
<button type="submit" class="btn">${icon('link')}<span>Show a sign-in code</span></button>
</form>
<p class="muted small">Shows a short code. On the other device, open the sign-in page, choose &ldquo;Enter a code&rdquo;,
and type it. The code works once, expires after five minutes, and signs that device in as you.</p>
</div>`;
  const content = html`<div class="page-head"><div class="with-avatar">${avatar(name, 32)}<h1>${name}</h1></div></div>
${flashBanner(opts.msg)}
${errorBanner(opts.error)}
<p class="muted">${user.siteAdmin ? 'Site admin' : html`Owns the collection <span class="mono">${name}</span> by name`}</p>
${passkeyBox}
${githubBox}
${handoff}`;
  return layout('Your account', content, { viewer, path: '/account' });
}

/** The code accountPage's handoff form minted, shown once. */
export function accountLinkPage(viewer: Viewer, code: string, minutes: number): string {
  const content = html`<div class="form-box">
<h1>Sign in on another device</h1>
<p>On the other device, open this vault's sign-in page, choose <b>Enter a code from a signed-in device</b>, and type:</p>
<div class="handoff-code mono">${code}</div>
<p class="muted small">The code signs that device in as <b>${viewer.auth.username}</b>. It works once and expires in
${minutes} minutes; showing it again mints a fresh one. The new session is tied to the same credential as this one, so
revoking that credential signs out both.</p>
<p><a href="/account">&larr; Your account</a></p>
</div>`;
  return layout('Sign in on another device', content, { viewer, path: '/account' });
}

export function newRepoPage(
  viewer: Viewer,
  collectionNames: string[],
  preset: { collection?: string; name?: string; description?: string },
  error?: string
): string {
  const datalist = collectionNames.map((o) => html`<option value="${o}">`);
  const content = html`<div class="form-box wide">
<h1>Create a new repository</h1>
<p class="muted">A repository is a directory in the vault holding a bare git repository. Its name and the collection it sits in are its address.</p>
<hr class="rule">
${errorBanner(error)}
<form method="post" action="/new">
${csrfField(viewer)}
<div class="name-row">
  <div class="field"><label for="collection">Collection</label><input type="text" id="collection" name="collection" list="collections" value="${
    preset.collection ?? ''
  }" required><datalist id="collections">${datalist}</datalist></div>
  <div class="name-slash">/</div>
  <div class="field"><label for="name">Repository name</label><input type="text" id="name" name="name" value="${
    preset.name ?? ''
  }" required></div>
</div>
<p class="muted small">The collection may be one that exists or a new one to create along with the repository.</p>
<div class="field"><label for="description">Description <span class="muted">(optional)</span></label><input type="text" id="description" name="description" value="${
    preset.description ?? ''
  }"></div>
<hr class="rule">
<div class="field"><label class="checkbox"><input type="checkbox" name="init" value="1" checked> Initialize with a README</label>
<p class="muted small">Gives the repository a first commit on <span class="mono">main</span>, so it can be browsed and cloned straight away.</p></div>
<div class="field"><label class="checkbox"><input type="checkbox" name="private" value="1"> Private</label>
<p class="muted small">A private repository is visible only to its collaborators, the collection's owners, and site admins. Everything else in a vault reads anonymously.</p></div>
<button type="submit" class="btn btn-primary">${icon('repo')}<span>Create repository</span></button>
</form>
</div>`;
  return layout('New repository', content, { viewer, path: '/new' });
}

/**
 * The fork form. GitHub asks where the copy should go and lets the name be
 * changed on the way; so does this, with the collection defaulting to one
 * named after the signed-in user, which is the shape most vaults have.
 */
export function forkPage(
  ctx: RepoCtx,
  viewer: Viewer,
  collectionNames: string[],
  preset: { collection?: string; name?: string },
  error?: string
): string {
  const base = repoUrl(ctx);
  const datalist = collectionNames.map((o) => html`<option value="${o}">`);
  const content = html`${repoHeader(ctx, 'code')}
<div class="form-box wide">
<h1>Fork ${ctx.collection}/${ctx.repo}</h1>
<p class="muted">A fork is a copy of the repository somewhere else in this vault. Its objects are shared with the original on disk until one of them gains new ones, so a fork costs almost nothing.</p>
<hr class="rule">
${errorBanner(error)}
<form method="post" action="${base}/fork">
${csrfField(viewer)}
<div class="name-row">
  <div class="field"><label for="collection">Collection</label><input type="text" id="collection" name="collection" list="collections" value="${
    preset.collection ?? ''
  }" required><datalist id="collections">${datalist}</datalist></div>
  <div class="name-slash">/</div>
  <div class="field"><label for="name">Repository name</label><input type="text" id="name" name="name" value="${
    preset.name ?? ctx.repo
  }" required></div>
</div>
<p class="muted small">You need permission to create in the destination collection: your own, one you own, or anywhere for a site admin. Branches and tags come across; issues, releases, and workflow runs stay with the original.</p>
<button type="submit" class="btn btn-primary">${icon('repo-forked')}<span>Create fork</span></button>
</form>
</div>`;
  return layout(`Fork ${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, `${base}/fork`));
}

/**
 * The import-or-fork page. Both operations run on the reader's machine rather
 * than on the server, and what this page does is hand them the command that
 * does it. Earlier it asked for the source in a form and wrote a shell
 * one-liner from the answers, which put a form in front of an operation the
 * page cannot perform; now `mochi fork` and `mochi import` perform it, so the
 * page only has to say what to run, with the collection and the vault's own
 * URL filled in. The two commands do the same copy; the difference is that a
 * fork records where it came from, so the page is organized around that one
 * question. The git commands remain below for a machine with no Node on it.
 */
export function importPage(
  viewer: Viewer,
  opts: { collection: string | null; vaultUrl: string; gitCommand: string | null }
): string {
  const collection = opts.collection ?? 'mycollection';
  const back = opts.collection
    ? html`<p><a class="btn" href="/${encodeURIComponent(opts.collection)}">Back to ${opts.collection}</a></p>`
    : '';
  const fallback = opts.gitCommand
    ? html`<hr class="rule">
<h2>Without the CLI</h2>
<p class="muted small">The same two steps by hand. Replace the source URL, and the name after the collection if you want one other than the source's. This makes an import; to turn it into a fork, record the upstream in the repository's settings afterwards.</p>
${copyRow(opts.gitCommand)}`
    : '';
  const content = html`<div class="form-box wide">
<h1>Import or fork a repository</h1>
<p class="muted">Both copy a repository from outside this vault into it, and both run on your machine, not on this server: git reads the source with the credentials you already have there and pushes it here, which creates the repository. The <span class="mono">mochi</span> command does both. The difference is memory: a fork records where it came from, an import does not.</p>
<hr class="rule">
<h2>Once per machine</h2>
${copyRow('npm install -g @magland/mochi')}
${copyRow(`mochi login ${opts.vaultUrl}`)}
<h2>Fork: a copy that remembers its source</h2>
${copyRow(`mochi fork https://github.com/owner/repo ${collection}`)}
<p class="muted small">The source URL is recorded as the repository's upstream: the header shows &ldquo;forked from&rdquo;, <span class="mono">mochi sync</span> fast-forwards a branch from it, and <span class="mono">mochi pr export</span> sends a pull request back to it. When the source keeps living where it is, this is usually what you want.</p>
<h2>Import: a copy that stands on its own</h2>
${copyRow(`mochi import https://github.com/owner/repo ${collection}`)}
<p class="muted small">Nothing is recorded about the source. For a repository whose home this vault becomes, or for a local directory (<span class="mono">mochi import ~/work/repo ${collection}</span>), which has no URL to record.</p>
<hr class="rule">
<p class="muted small">For either command, the source may be an https or ssh git URL, or <span class="mono">owner/repo</span> for GitHub. The repository takes its name from the source; write <span class="mono">${collection}/another-name</span> to choose another. Add <span class="mono">--lfs</span> to carry Git LFS objects too. A collection that does not exist yet is created by the push. A public GitHub source also has its description read from GitHub and set here.</p>
<p class="muted small">An import becomes a fork after the fact: set the upstream URL in the repository's settings, or run <span class="mono">mochi repo edit ${collection}/name --upstream &lt;url&gt;</span>. And a repository already in this vault is forked with the Fork button on its own page, which copies it without leaving the server.</p>
${fallback}
${back}
</div>`;
  return layout('Import or fork a repository', content, { viewer, path: '/import' });
}

/**
 * The sync page, reached from the "forked from" line in the repository
 * header. Like importing, syncing runs on the reader's machine rather than on
 * the server, which holds no credential for the upstream and never fetches
 * from another host; so, like the import page, this one hands them the
 * command that does it, filled in with this repository's address.
 */
export function syncPage(ctx: RepoCtx, vaultUrl: string): string {
  const base = repoUrl(ctx);
  const up = ctx.upstream!;
  const branch = ctx.defaultBranch
    ? html`That fast-forwards <span class="mono">${ctx.defaultBranch}</span>; <span class="mono">--branch</span> names another.`
    : html`This repository is empty, so name the branch to sync with <span class="mono">--branch</span>.`;
  const content = html`${repoHeader(ctx, 'code')}
<div class="form-box wide">
<h1>Sync from the upstream</h1>
<p class="muted">This repository was forked from ${
    up.web ? html`<a href="${up.web}" rel="noopener">${up.label}</a>` : html`<span class="mono">${up.label}</span>`
  }. Syncing runs on your machine, not on this server: git fetches the upstream with the credentials you already have there and pushes the result here, so the vault never needs a credential for the upstream. The <span class="mono">mochi</span> command does both.</p>
<hr class="rule">
<h2>Once per machine</h2>
${copyRow('npm install -g @magland/mochi')}
${copyRow(`mochi login ${vaultUrl}`)}
<h2>Then, whenever the upstream has moved</h2>
${copyRow(`mochi sync ${ctx.collection}/${ctx.repo}`)}
<p class="muted small">${branch} Only a fast-forward is ever pushed: a branch that has grown commits of its own is reported as diverged and left alone, since reconciling it is a merge or a rebase in a clone of your own. The upstream URL is the one recorded in <a href="${base}/settings">settings</a>.</p>
<p><a class="btn" href="${base}">Back to ${ctx.repo}</a></p>
</div>`;
  return layout(`Sync ${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, `${base}/sync`));
}

/**
 * Creating a collection on its own. A push creates the collection it lands in,
 * so this is for the order where the collection comes first: an empty one to
 * import into, or to hand someone push access over before anything is in it.
 */
export function newCollectionPage(viewer: Viewer, preset: { name?: string }, error?: string): string {
  const content = html`<div class="form-box wide">
<h1>Create a new collection</h1>
<p class="muted">A collection is a directory in the vault holding repositories. It may be empty; repositories arrive by creation, import, or push.</p>
<hr class="rule">
${errorBanner(error)}
<form method="post" action="/new/collection">
${csrfField(viewer)}
<div class="field"><label for="name">Collection name</label><input type="text" id="name" name="name" value="${
    preset.name ?? ''
  }" required autofocus></div>
<p class="muted small">Letters, digits, dot, underscore, and dash. The collection named after you is yours to create; any other name takes a site admin.</p>
<button type="submit" class="btn btn-primary">${icon('plus')}<span>Create collection</span></button>
</form>
</div>`;
  return layout('New collection', content, { viewer, path: '/new/collection' });
}

/**
 * A collection's own settings: its owners, its name, and its deletion.
 *
 * Repository settings live under the repository, so a collection's live under
 * the collection, at the same place in the path. The rename is graded amber
 * rather than red for the same reason a repository's is: what it breaks can be
 * put back by renaming it again. Deletion takes the red grade and the typed
 * confirmation, and is offered only when the collection is empty; one holding
 * repositories shows why the form is absent instead.
 */
export function collectionSettingsPage(
  viewer: Viewer,
  collection: string,
  repoCount: number,
  owners: string[],
  msg?: string,
  error?: string
): string {
  const base = `/${encodeURIComponent(collection)}`;
  const holds =
    repoCount === 0
      ? 'This collection is empty.'
      : `Every one of its ${
          repoCount === 1 ? 'repository' : `${repoCount} repositories`
        } moves with it, along with their sites, workflow runs, issues, pull requests, releases, and LFS objects.`;
  const content = html`<div class="page-head"><h1 class="with-avatar">${avatar(
    collection,
    28,
    'square'
  )}${collection}</h1></div>
<h2>Settings</h2>
${flashBanner(msg)}
${errorBanner(error)}
<div class="box settings-box"><div class="box-header">${icon('people')}Owners</div><div class="box-body">
<p class="muted small">Owners hold the admin role on every repository in the collection, may create repositories in it,
and manage these settings. A user named <span class="mono">${collection}</span> owns it by bearing its name and is not
listed here.</p>
${
    owners.length
      ? html`<table class="listing"><tbody><tr><th>User</th><th class="right"></th></tr>${owners.map(
          (o) => html`<tr><td class="with-avatar">${userLink(o, { face: 24, bold: true })}</td><td class="right">
<form method="post" action="${base}/settings/owners/remove" class="inline-form">
${csrfField(viewer)}
<input type="hidden" name="username" value="${o}">
<button type="submit" class="btn btn-danger-outline">Remove</button>
</form></td></tr>`
        )}</tbody></table>`
      : html`<p class="muted">No owners are listed.</p>`
  }
<form method="post" action="${base}/settings/owners" class="inline-form">
${csrfField(viewer)}
<label for="ownerUser">User</label><input type="text" id="ownerUser" name="username" required>
<button type="submit" class="btn">${icon('people')}<span>Add owner</span></button>
</form>
</div></div>
<div class="danger-zone caution">
<h3>Rename</h3>
<p>${holds} The old address is redirected here, so links and existing clones keep working until something else is created under that name, but token scopes naming the old collection have to be granted again under the new name.</p>
<form method="post" action="${base}/settings/rename" class="inline-form">
${csrfField(viewer)}
<label for="toName">Collection name</label><input type="text" id="toName" name="name" value="${collection}" required>
<button type="submit" class="btn">${icon('pencil')}<span>Rename</span></button>
</form>
</div>
<div class="danger-zone">
<h3>Danger zone</h3>
${
    repoCount === 0
      ? html`<p>Deleting this collection removes its directory and its owners list from the vault permanently. There is no undo.</p>
<form method="post" action="${base}/settings/delete">
${csrfField(viewer)}
<div class="field"><label for="confirm">Type <b class="mono">${collection}</b> to confirm</label><input type="text" id="confirm" name="confirm" autocomplete="off"></div>
<button type="submit" class="btn btn-danger">${icon('trash')}<span>Delete this collection</span></button>
</form>`
      : html`<p>A collection can be deleted only once it is empty. This one holds ${
          repoCount === 1 ? 'a repository' : `${repoCount} repositories`
        }; delete ${repoCount === 1 ? 'it' : 'them'}, or move ${
          repoCount === 1 ? 'it' : 'them'
        } to another collection, first.</p>`
  }
</div>`;
  return layout(`Settings - ${collection}`, content, {
    crumbs: html` / <a href="${base}">${collection}</a>`,
    viewer,
    path: `${base}/settings`,
  });
}

/**
 * The commit box: a summary and an optional extended description, which is
 * GitHub's shape and git's own (the two are joined by a blank line before the
 * commit is made). The face beside the heading is whose commit it will be.
 */
function commitFields(
  viewer: Viewer,
  expectedHead: string | null,
  messagePlaceholder: string,
  branch?: string
): Html {
  // Committing to a new branch is GitHub's second choice in this box, and the
  // one that keeps a shared branch clean. The name field is only read when
  // that choice is made, so leaving it filled in is harmless.
  const branchChoice =
    branch === undefined
      ? ''
      : html`<div class="commit-target">
<label class="checkbox"><input type="checkbox" name="newBranchWanted" value="1"> Commit to a new branch</label>
<div class="field"><label class="sr-only" for="newBranch">New branch name</label><input type="text" id="newBranch" name="newBranch" placeholder="${branch}-patch" autocomplete="off"></div>
<p class="muted small">Leave it unticked to commit straight to <span class="mono">${branch}</span>.</p>
</div>`;
  return html`${csrfField(viewer)}
<input type="hidden" name="expected" value="${expectedHead ?? ''}">
<div class="commit-box-head">${avatar(viewer.auth.username, 28)}<b>Commit changes</b></div>
<div class="field"><label class="sr-only" for="message">Commit message</label><input type="text" id="message" name="message" placeholder="${messagePlaceholder}"></div>
<div class="field"><label class="sr-only" for="description">Extended description</label><textarea id="description" name="description" rows="3" placeholder="Add an optional extended description"></textarea></div>
${branchChoice}`;
}

export function editFilePage(
  ctx: RepoCtx,
  filePath: string,
  content: string,
  expectedHead: string,
  error?: string
): string {
  const base = repoUrl(ctx);
  const action = `${base}/edit/${encPath(ctx.ref)}/${encPath(filePath)}`;
  const cancel = `${base}/blob/${encPath(ctx.ref)}/${encPath(filePath)}`;
  const rows = Math.min(30, Math.max(12, content.split('\n').length + 2));
  // A markdown file gets the markdown editor's tabs and toolbar around the
  // same field, with the preview resolving relative links against the file's
  // own branch and directory; any other file gets the plain editor.
  const editor = isMarkdownFile(filePath)
    ? markdownEditor({
        name: 'content',
        rows,
        value: content,
        codeEditor: true,
        preview: previewUrl(ctx),
        ref: ctx.ref,
        dir: filePath.split('/').slice(0, -1).join('/'),
      })
    : html`<textarea class="code-editor" name="content" rows="${rows}" spellcheck="false">${content}</textarea>`;
  const body = html`${repoHeader(ctx, 'code')}
<h2 class="file-head">Editing <span class="mono">${filePath}</span> on <span class="mono">${ctx.ref}</span></h2>
${errorBanner(error)}
<form method="post" action="${action}">
<div class="field"><label for="path">Path</label><input type="text" id="path" name="path" value="${filePath}" spellcheck="false"><p class="muted small">Changing it renames or moves the file in the same commit.</p></div>
${editor}
<div class="commit-box">
${commitFields(ctx.viewer!, expectedHead, `Update ${filePath.split('/').pop()}`, ctx.ref)}
<div class="actions"><button type="submit" class="btn btn-primary">Commit changes</button><a class="btn" href="${cancel}">Cancel</a></div>
</div>
</form>`;
  return layout(`Editing ${filePath} - ${ctx.collection}/${ctx.repo}`, body, repoOpts(ctx));
}

/**
 * The editor for an age-encrypted file. The server cannot fill the textarea,
 * so the page opens on a passphrase form instead: /assets/age.js fetches the
 * ciphertext, decrypts it in the page, and only then reveals the editor. The
 * commit posts fresh ciphertext through the same route and guards as any
 * other edit; the unlock form stands outside the commit form (forms do not
 * nest), and its passphrase input carries no name, so nothing can post it.
 * The optional new-passphrase pair re-keys the file on commit; those inputs
 * are nameless for the same reason.
 */
export function editAgeFilePage(ctx: RepoCtx, filePath: string, expectedHead: string, error?: string): string {
  const base = repoUrl(ctx);
  const action = `${base}/edit/${encPath(ctx.ref)}/${encPath(filePath)}`;
  const cancel = `${base}/blob/${encPath(ctx.ref)}/${encPath(filePath)}`;
  const rawUrl = `${base}/raw/${encPath(ctx.ref)}/${encPath(filePath)}`;
  const body = html`${repoHeader(ctx, 'code')}
<h2 class="file-head">Editing <span class="mono">${filePath}</span> on <span class="mono">${ctx.ref}</span></h2>
${errorBanner(error)}
<div class="age-card blob-binary">
<p class="age-head">${icon('lock')}<b>Encrypted with age</b></p>
<p class="muted small">The passphrase decrypts the file here, in this page, and encrypts it again when you commit. It is sent nowhere.</p>
<form class="age-unlock" data-age-for-edit>${agePassInput({
    placeholder: 'Passphrase',
    autocomplete: 'off',
    required: true,
  })}<button type="submit" class="btn btn-primary" data-busy-label="Decrypting&hellip;">Decrypt</button></form>
<p class="age-error form-error" hidden></p>
<noscript><p class="muted small">Editing in the browser needs JavaScript. Without it, edit a clone with the age CLI.</p></noscript>
</div>
<form method="post" action="${action}" data-age-edit data-age-raw="${rawUrl}" hidden>
<p class="age-bar-note">${icon('lock')}<span>Decrypted in your browser. Committing encrypts it again before anything leaves this page.</span></p>
<div class="field"><label for="path">Path</label><input type="text" id="path" name="path" value="${filePath}" spellcheck="false"><p class="muted small">Changing it renames or moves the file in the same commit.</p><p class="age-warn" data-age-rename-warn hidden>${icon(
    'alert'
  )}<span>The name no longer ends in <span class="mono">.age</span>: the file would still be committed encrypted, but the vault would stop treating it as an encrypted file.</span></p></div>
<textarea class="code-editor" rows="18" spellcheck="false" disabled></textarea>
<details class="age-newpass">
<summary>Change the passphrase</summary>
<div class="field"><label for="age-newpass">New passphrase</label>${agePassInput({
    id: 'age-newpass',
    autocomplete: 'new-password',
  })}</div>
<div class="field"><label for="age-newpass2">Repeat new passphrase</label>${agePassInput({
    id: 'age-newpass2',
    autocomplete: 'new-password',
  })}</div>
<p class="muted small">Left empty, the commit keeps the current passphrase. A forgotten passphrase is not recoverable.</p>
</details>
<input type="hidden" name="content" value="">
<p class="age-error form-error" hidden></p>
<div class="commit-box">
${commitFields(ctx.viewer!, expectedHead, `Update ${filePath.split('/').pop()}`, ctx.ref)}
<div class="actions"><button type="submit" class="btn btn-primary" disabled data-busy-label="Encrypting&hellip;">Commit changes</button><a class="btn" href="${cancel}">Cancel</a></div>
</div>
</form>`;
  return layout(`Editing ${filePath} - ${ctx.collection}/${ctx.repo}`, body, {
    ...repoOpts(ctx),
    ageScript: true,
  });
}

export function newFilePage(
  ctx: RepoCtx,
  branch: string,
  dir: string,
  expectedHead: string | null,
  preset: { filename?: string; content?: string },
  error?: string
): string {
  const base = repoUrl(ctx);
  const action = `${base}/new/${encPath(branch)}${dir === '' ? '' : `/${encPath(dir)}`}`;
  const cancel = expectedHead === null ? base : `${base}/tree/${encPath(branch)}${dir === '' ? '' : `/${encPath(dir)}`}`;
  const prefix = dir === '' ? '' : `${dir}/`;
  const branchNote =
    expectedHead === null
      ? html`<p class="muted small">This repository is empty; committing will create the <span class="mono">${branch}</span> branch.</p>`
      : '';
  const body = html`${repoHeader(ctx, 'code')}
<h2 class="file-head">New file in <span class="mono">${prefix || '/'}</span> on <span class="mono">${branch}</span></h2>
${branchNote}
${errorBanner(error)}
<form method="post" action="${action}" data-age-new>
<div class="field"><label for="filename">File name</label><div class="filename-row"><span class="mono muted">${prefix}</span><input type="text" id="filename" name="filename" value="${
    preset.filename ?? ''
  }" placeholder="path/to/file.md" required></div><p class="muted small" data-age-hint>A name ending in <span class="mono">.age</span> is encrypted with a passphrase in this page before it is committed.</p></div>
<div class="age-pass-fields blob-binary age-card" hidden>
<p class="age-head">${icon('lock')}<b>A name ending in <span class="mono">.age</span> makes an encrypted file</b></p>
<p class="muted small">The content below is encrypted in this page before it is committed; the vault stores only ciphertext, and the passphrase is sent nowhere and stored nowhere. A forgotten passphrase is not recoverable.</p>
<div class="field"><label for="age-pass">Passphrase</label>${agePassInput({
    id: 'age-pass',
    autocomplete: 'new-password',
  })}</div>
<div class="field"><label for="age-pass2">Repeat passphrase</label>${agePassInput({
    id: 'age-pass2',
    autocomplete: 'new-password',
  })}</div>
<p class="age-error form-error" hidden></p>
</div>
<textarea class="code-editor" name="content" rows="18" spellcheck="false">${preset.content ?? ''}</textarea>
<div class="commit-box">
${commitFields(ctx.viewer!, expectedHead, 'Create new file', expectedHead === null ? undefined : branch)}
<div class="actions"><button type="submit" class="btn btn-primary" data-busy-label="Encrypting&hellip;">Commit new file</button><a class="btn" href="${cancel}">Cancel</a></div>
</div>
</form>`;
  // The age script rides on every new-file page, because whether it is
  // needed is decided by the name the user has yet to type.
  return layout(`New file - ${ctx.collection}/${ctx.repo}`, body, { ...repoOpts(ctx), ageScript: true });
}

/**
 * The upload form. A file input and the same commit box as the editor, so
 * uploading is the same act as writing a file: a commit with a message, on
 * this branch or on a new one.
 */
export function uploadPage(
  ctx: RepoCtx,
  branch: string,
  dir: string,
  expectedHead: string | null,
  maxBytes: number,
  error?: string
): string {
  const base = repoUrl(ctx);
  const action = `${base}/upload/${encPath(branch)}${dir === '' ? '' : `/${encPath(dir)}`}`;
  const cancel = `${base}/tree/${encPath(branch)}${dir === '' ? '' : `/${encPath(dir)}`}`;
  const body = html`${repoHeader(ctx, 'code')}
<h2 class="file-head">Uploading to <span class="mono">${dir === '' ? '/' : `${dir}/`}</span> on <span class="mono">${branch}</span></h2>
${errorBanner(error)}
<form method="post" action="${action}" enctype="multipart/form-data">
<div class="field"><label for="files">Files</label>
<input type="file" id="files" name="files" multiple required>
<p class="muted small">Up to ${Math.floor(maxBytes / (1024 * 1024))} MB in one commit. A file that is already there is replaced, keeping its mode. Large binaries are better pushed with Git LFS.</p></div>
<div class="commit-box">
${commitFields(ctx.viewer!, expectedHead, 'Add files via upload', branch)}
<div class="actions"><button type="submit" class="btn btn-primary">${icon(
    'upload'
  )}<span>Commit changes</span></button><a class="btn" href="${cancel}">Cancel</a></div>
</div>
</form>`;
  return layout(`Upload to ${ctx.collection}/${ctx.repo}`, body, repoOpts(ctx, action));
}

export function deleteFilePage(ctx: RepoCtx, filePath: string, expectedHead: string, error?: string): string {
  const base = repoUrl(ctx);
  const action = `${base}/delete/${encPath(ctx.ref)}/${encPath(filePath)}`;
  const cancel = `${base}/blob/${encPath(ctx.ref)}/${encPath(filePath)}`;
  const body = html`${repoHeader(ctx, 'code')}
<h2 class="file-head">Delete <span class="mono">${filePath}</span> from <span class="mono">${ctx.ref}</span></h2>
${errorBanner(error)}
<div class="form-box">
<p>This commits the removal of <b>${filePath}</b> to the <b>${ctx.ref}</b> branch. The file stays in the history.</p>
<form method="post" action="${action}">
${commitFields(ctx.viewer!, expectedHead, `Delete ${filePath.split('/').pop()}`)}
<div class="actions"><button type="submit" class="btn btn-danger">Delete file</button><a class="btn" href="${cancel}">Cancel</a></div>
</form>
</div>`;
  return layout(`Delete ${filePath} - ${ctx.collection}/${ctx.repo}`, body, repoOpts(ctx));
}

export function conflictPage(ctx: RepoCtx, branch: string, retryUrl: string): string {
  const body = html`${repoHeader(ctx, 'code')}
<div class="form-box">
<h2>The branch has moved</h2>
<p>Someone updated <b>${branch}</b> while you were editing, so your change was not committed; committing it now could silently undo theirs.</p>
<p><a class="btn btn-primary" href="${retryUrl}">Reload and try again</a></p>
</div>`;
  return layout(`Conflict - ${ctx.collection}/${ctx.repo}`, body, repoOpts(ctx));
}

export function settingsPage(
  ctx: RepoCtx,
  description: string,
  topics: string[],
  access: { collaborators: { username: string; role: string }[]; owners: string[] },
  msg?: string,
  error?: string
): string {
  const base = repoUrl(ctx);
  const branchOptions = ctx.branches.map(
    (b) => html`<option value="${b.name}"${b.name === ctx.defaultBranch ? raw(' selected') : ''}>${b.name}</option>`
  );
  const defaultBranchField =
    ctx.branches.length > 0
      ? html`<div class="field"><label for="defaultBranch">Default branch</label><select id="defaultBranch" name="defaultBranch">${branchOptions}</select></div>`
      : '';
  const settingsForm = ctx.canPush
    ? html`<div class="box settings-box"><div class="box-header">${icon('sliders')}General</div><div class="box-body">
<form method="post" action="${base}/settings">
${csrfField(ctx.viewer!)}
<div class="field"><label for="description">Description</label><input type="text" id="description" name="description" value="${description}"><p class="muted small">Shown beside the repository in listings and in the About panel.</p></div>
<div class="field"><label for="topics">Topics</label><input type="text" id="topics" name="topics" value="${topics.join(' ')}" placeholder="webgpu numbl mri"><p class="muted small">Separated by spaces or commas: lowercase letters, digits, and hyphens, up to 20. Listings can be narrowed by topic, and each topic has a page across the vault.</p></div>
${defaultBranchField}
<div class="field"><label for="upstream">Upstream</label><input type="text" id="upstream" name="upstream" value="${
        ctx.upstream?.url ?? ''
      }" placeholder="https://github.com/owner/repo"><p class="muted small">The URL outside this vault this repository was forked from: the header shows it as &ldquo;forked from&rdquo;, <span class="mono">mochi sync</span> fast-forwards from it, and <span class="mono">mochi pr export</span> sends pull requests back to it. An https or ssh git URL; leave empty for a repository that stands on its own.</p></div>
<button type="submit" class="btn btn-primary">${icon('check')}<span>Save</span></button>
</form>
</div></div>`
    : '';
  // Who may see and write the repository. Admin only, like the rename below:
  // access is the repository's own business.
  const collaboratorRows = access.collaborators.map(
    ({ username, role }) => html`<tr><td class="with-avatar">${userLink(username, { face: 24, bold: true })}</td><td class="muted">${role}</td><td class="right">
<form method="post" action="${base}/settings/collaborators/remove" class="inline-form">
${csrfField(ctx.viewer!)}
<input type="hidden" name="username" value="${username}">
<button type="submit" class="btn btn-danger-outline">Remove</button>
</form></td></tr>`
  );
  const ownersNote = access.owners.length
    ? html`<p class="muted small">Owners of <span class="mono">${ctx.collection}</span> (${joinHtml(
        access.owners.map((o) => html`<b>${o}</b>`),
        ', '
      )}, and the user the collection is named after) hold the admin role here without being listed.</p>`
    : html`<p class="muted small">The user the collection is named after, and any owners added to it, hold the admin role here without being listed.</p>`;
  const accessBox = ctx.canAdmin
    ? html`<div class="box settings-box"><div class="box-header">${icon('people')}Access</div><div class="box-body">
<form method="post" action="${base}/settings/visibility">
${csrfField(ctx.viewer!)}
<input type="hidden" name="private" value="${ctx.isPrivate ? 'false' : 'true'}">
<p>${
        ctx.isPrivate
          ? html`This repository is <b>private</b>: visible to its collaborators, the collection's owners, and site admins, on the web, over git, and in the API alike.${
              ctx.hasSite
                ? html` Its published <a href="${ctx.siteUrl}">site</a> stays world-readable; remove the site directory if the site must go too.`
                : ''
            }`
          : html`This repository is <b>public</b>: anyone can read and clone it, as everything in a vault is by default.`
      }</p>
<button type="submit" class="btn">${ctx.isPrivate ? 'Make public' : 'Make private'}</button>
</form>
<hr class="rule">
<h3>Collaborators</h3>
${
        collaboratorRows.length
          ? html`<table class="listing"><tbody><tr><th>User</th><th>Role</th><th class="right"></th></tr>${collaboratorRows}</tbody></table>`
          : html`<p class="muted">No collaborators.</p>`
      }
${ownersNote}
<form method="post" action="${base}/settings/collaborators" class="inline-form">
${csrfField(ctx.viewer!)}
<label for="collabUser">User</label><input type="text" id="collabUser" name="username" required>
<label for="collabRole">Role</label><select id="collabRole" name="role">
<option value="read">read</option>
<option value="write" selected>write</option>
<option value="admin">admin</option>
</select>
<button type="submit" class="btn">${icon('people')}<span>Add</span></button>
</form>
<p class="muted small">read may see a private repository; write may also push and edit; admin may also change its settings, visibility, and collaborators.</p>
</div></div>`
    : '';
  // Renaming and moving are one operation, since both are a directory rename.
  // It is flagged because every URL to this repository, and every remote
  // pointing at it, changes with it; it takes the amber grade rather than the
  // red one because what it breaks can be put back by renaming it again.
  const renameForm = ctx.canAdmin
    ? html`<div class="danger-zone caution">
<h3>Rename or move</h3>
<p>Everything moves with the repository: its site, its workflow runs, its issues, its releases, and its LFS objects. The old address is redirected here, so links and existing clones keep working, until something else is created under that name.</p>
<form method="post" action="${base}/settings/rename" class="inline-form">
${csrfField(ctx.viewer!)}
<label for="toCollection">Collection</label><input type="text" id="toCollection" name="collection" value="${ctx.collection}" required>
<label for="toName">Name</label><input type="text" id="toName" name="name" value="${ctx.repo}" required>
<button type="submit" class="btn">${icon('pencil')}<span>Rename</span></button>
</form>
<p class="muted small">The collection may be one that exists or a new one to create along with the move, so check it for typos: a misspelt collection is created, not refused.</p>
</div>`
    : '';
  const dangerZone = ctx.canAdmin
    ? html`<div class="danger-zone">
<h3>Danger zone</h3>
<p>Deleting a repository removes its directory${ctx.hasSite ? ' and its site' : ''} from the vault permanently. There is no undo.</p>
<form method="post" action="${base}/settings/delete">
${csrfField(ctx.viewer!)}
<div class="field"><label for="confirm">Type <b class="mono">${ctx.collection}/${ctx.repo}</b> to confirm</label><input type="text" id="confirm" name="confirm" autocomplete="off"></div>
<button type="submit" class="btn btn-danger">${icon('trash')}<span>Delete this repository</span></button>
</form>
</div>`
    : '';
  const body = html`${repoHeader(ctx, 'settings')}
<h2>Settings</h2>
${flashBanner(msg)}
${errorBanner(error)}
${settingsForm}
${accessBox}
${renameForm}
${dangerZone}`;
  return layout(`Settings - ${ctx.collection}/${ctx.repo}`, body, repoOpts(ctx, `${base}/settings`));
}

/**
 * Where a user writes the profile their page at /<username> shows: a display
 * name, a short bio, and links. The longer-form introduction is the profile
 * README (.mochi/profile/README.md in their collection), which is a file in a
 * repository rather than a form here, so this page only points at it.
 */
export function profileSettingsPage(
  viewer: Viewer,
  profile: UserProfile | undefined,
  msg?: string,
  error?: string
): string {
  const name = viewer.auth.username;
  const links = (profile?.links ?? []).join('\n');
  const content = html`<div class="page-head"><h1 class="with-avatar">${avatar(name, 32)}Your profile</h1><span class="right-group"><a class="btn" href="/${encodeURIComponent(
    name
  )}">${icon('person')}<span>View profile</span></a></span></div>
${flashBanner(msg)}
${errorBanner(error)}
<div class="form-box wide">
<form method="post" action="/settings/profile">
${csrfField(viewer)}
<div class="field"><label for="displayName">Name</label><input type="text" id="displayName" name="displayName" value="${
    profile?.name ?? ''
  }" maxlength="80" placeholder="${name}">
<p class="muted small">Shown on your profile beside your username, <span class="mono">${name}</span>.</p></div>
<div class="field"><label for="bio">Bio</label><textarea id="bio" name="bio" rows="3" maxlength="500" placeholder="A sentence or two about yourself">${
    profile?.bio ?? ''
  }</textarea></div>
<div class="field"><label for="links">Links</label><textarea id="links" name="links" rows="3" placeholder="https://example.org">${links}</textarea>
<p class="muted small">One per line, up to five, each starting with <span class="mono">http://</span> or
<span class="mono">https://</span>.</p></div>
<button type="submit" class="btn btn-primary">${icon('check')}<span>Save profile</span></button>
</form>
<hr class="rule">
<p class="muted small">For a longer introduction, your profile page also renders
<span class="mono">${name}/.mochi/profile/README.md</span>, edited like any other file in a repository.</p>
</div>`;
  return layout('Your profile', content, { viewer, path: '/settings/profile' });
}

export function adminUsersPage(
  viewer: Viewer,
  users: { name: string; user: UserRecord }[],
  msg?: string,
  error?: string
): string {
  const rows = users.map(({ name, user }) => {
    const actions = html`<details class="dropdown"><summary class="btn">${icon(
      'kebab'
    )}<span>Manage</span></summary><div class="dropdown-menu dd-right user-actions">
<form method="post" action="/admin/users/${encodeURIComponent(name)}/grant" class="inline-form">
${csrfField(viewer)}
<input type="hidden" name="siteAdmin" value="${user.siteAdmin ? 'false' : 'true'}">
<button type="submit" class="btn">${user.siteAdmin ? 'Withdraw site admin' : 'Make site admin'}</button>
</form>
<form method="post" action="/admin/users/${encodeURIComponent(name)}/token" class="inline-form">
${csrfField(viewer)}
<input type="text" name="tokenScope" placeholder="token scope (optional)">
<button type="submit" class="btn">Mint token</button>
</form>
</div></details>`;
    const userUrl = `/admin/users/${encodeURIComponent(name)}`;
    return html`<tr><td class="with-avatar">${avatar(name, 24)}<a href="${userUrl}"><b>${name}</b></a></td><td class="muted small">${
      user.siteAdmin ? 'site admin' : ''
    }</td><td class="right muted small"><a href="${userUrl}">${user.tokens.length} token${
      user.tokens.length === 1 ? '' : 's'
    }</a></td><td>${actions}</td></tr>`;
  });
  const content = html`<h1>Users</h1>
${flashBanner(msg)}
${errorBanner(error)}
<table class="listing"><tbody><tr><th>User</th><th>Site admin</th><th class="right">Tokens</th><th></th></tr>${rows}</tbody></table>
<div class="form-box" style="margin-top:24px">
<h2>Add user</h2>
<form method="post" action="/admin/users">
${csrfField(viewer)}
<div class="field"><label for="username">Username</label><input type="text" id="username" name="username" required>
<p class="muted small">A user owns the collection named after them: they create repositories there, administer them, and
may grant others access. Everything else is granted per repository (collaborators) or per collection (owners).</p></div>
<div class="field"><label><input type="checkbox" name="siteAdmin" value="true"> Site admin</label>
<p class="muted small">Site admins hold the admin role everywhere and manage users, runners, and the vault's settings.</p></div>
<button type="submit" class="btn btn-primary">Create user and mint token</button>
</form>
<p class="muted small">The new token is shown once on the next page.</p>
</div>`;
  return adminShell(viewer, 'users', 'Users', '/admin/users', content);
}

/**
 * One user: their scopes, each token they hold, and the way to take either
 * away. The tokens are the point of the page. Every write to a vault is
 * authorized by a bearer token, so a leaked one needs an off switch that does
 * not involve editing vault.json by hand, and this is it: revocation reads
 * live on the next request, for git and for the web session alike, since both
 * resolve the token against vault.json every time.
 */
export function adminUserPage(
  viewer: Viewer,
  name: string,
  user: UserRecord,
  msg?: string,
  error?: string
): string {
  const self = name === viewer.auth.username;
  const base = `/admin/users/${encodeURIComponent(name)}`;
  const tokenRows = user.tokens.map((t) => {
    const id = tokenId(t);
    const current = self && tokenId(viewer.auth.token) === id;
    const revoke = html`<form method="post" action="${base}/tokens/${encodeURIComponent(
      id
    )}/revoke" class="inline-form">
${csrfField(viewer)}
<button type="submit" class="btn btn-danger-outline">Revoke</button>
</form>`;
    return html`<tr><td class="mono">${id}${
      current ? raw(' <span class="counter">this session</span>') : ''
    }</td><td class="muted small">${
      t.created ? timeTag(t.created, '') : raw('<span class="muted">before minting was dated</span>')
    }</td><td class="mono small">${t.scope?.join(' ') ?? ''}${
      t.scope ? '' : raw('<span class="muted">the user’s scope</span>')
    }</td><td class="right">${revoke}</td></tr>`;
  });
  const tokens =
    user.tokens.length > 0
      ? html`<table class="listing"><tbody><tr><th>Token</th><th>Minted</th><th>Scope</th><th class="right"></th></tr>${tokenRows}</tbody></table>
<p class="muted small">Only a SHA-256 hash of each token is stored, so there is nothing to show beyond its id. Revocation
is immediate: the next push and the next page load are both refused. Revoking the token this session was signed in with
signs you out.</p>`
      : html`<div class="empty-state">No tokens. This user cannot push or sign in until one is minted.</div>`;
  const mint = html`<div class="form-box">
<h2>Mint a token</h2>
<form method="post" action="${base}/token">
${csrfField(viewer)}
<input type="hidden" name="next" value="${base}">
<div class="field"><label for="tokenScope">Token scope <span class="muted">(optional)</span></label>
<input type="text" id="tokenScope" name="tokenScope" placeholder="e.g. mycollection/*">
<p class="muted small">Globs that narrow this one token below the user's own scope. A token with a scope of its own
carries no admin rights. Leave empty for a token as broad as the user.</p></div>
<button type="submit" class="btn btn-primary">Mint token</button>
</form>
<p class="muted small">Minting does not revoke anything: the user's other tokens keep working until each is revoked here.</p>
</div>`;
  const grant = html`<div class="form-box">
<h2>Site admin</h2>
<form method="post" action="${base}/grant">
${csrfField(viewer)}
<input type="hidden" name="next" value="${base}">
<input type="hidden" name="siteAdmin" value="${user.siteAdmin ? 'false' : 'true'}">
<p>${
    user.siteAdmin
      ? html`<b>${name}</b> is a site admin: the admin role everywhere, plus users, runners, and the vault's settings.`
      : html`<b>${name}</b> owns the collection <span class="mono">${name}</span> by name; anything more is granted per
repository (collaborators), per collection (owners), or with the site-admin bit here.`
  }</p>
<button type="submit" class="btn">${user.siteAdmin ? 'Withdraw site admin' : 'Make site admin'}</button>
</form>
</div>`;
  // Passkeys sit beside tokens because they are the same kind of thing -- a
  // credential this user signs in with -- and revoking one is the same
  // emergency. Adding one is not here: registration takes the authenticator,
  // which is on the user's own device, so it lives on their /account page.
  const passkeyRows = (user.passkeys ?? []).map(
    (p) => html`<tr><td>${p.name ?? 'Passkey'}</td><td class="muted small">${
      p.created ? timeTag(p.created, '') : ''
    }</td><td class="mono small muted">${p.id.slice(0, 8)}&hellip;</td><td class="right">
<form method="post" action="${base}/passkeys/${encodeURIComponent(p.id)}/delete" class="inline-form">
${csrfField(viewer)}
<button type="submit" class="btn btn-danger-outline">Remove</button>
</form></td></tr>`
  );
  const passkeys = passkeyRows.length
    ? html`<h2>Passkeys</h2>
<table class="listing"><tbody><tr><th>Passkey</th><th>Added</th><th>Id</th><th class="right"></th></tr>${passkeyRows}</tbody></table>
<p class="muted small">Passkeys sign in to the web interface only, with the user's full standing. ${name} adds them from
their own account page; removal is immediate, like revoking a token.</p>`
    : '';
  // The GitHub link sits with the other credentials for the same reason
  // passkeys do: it is a way this user signs in, and unlinking is the same
  // emergency off switch. Linking is not here; it takes the GitHub side, so
  // it lives on the user's own account page.
  const github = user.github
    ? html`<div class="form-box">
<h2>GitHub</h2>
<form method="post" action="${base}/github/unlink">
${csrfField(viewer)}
<p>Linked to GitHub account <a href="https://github.com/${user.github.login}"><b>${user.github.login}</b></a>
<span class="mono small muted">id ${String(user.github.id)}</span>. &ldquo;Sign in with GitHub&rdquo; signs in as ${name},
with their full standing.</p>
<button type="submit" class="btn btn-danger-outline">Unlink</button>
</form>
<p class="muted small">Unlinking ends sessions signed in with GitHub on their next request. To bar this person from
GitHub sign-in entirely, also remove them from the approved list under <a href="/admin/github">GitHub sign-in</a>, or a
fresh account would be created for them on their next sign-in.</p>
</div>`
    : '';
  const identity = html`<div class="form-box">
<h2>Identity</h2>
<form method="post" action="${base}/emails">
${csrfField(viewer)}
<div class="field"><label for="emails">Git author emails</label>
<input type="text" id="emails" name="emails" value="${(user.emails ?? []).join(' ')}" placeholder="e.g. jane@example.org">
<p class="muted small">Commits by these addresses are attributed to ${name}: one contributor, one face, however they
were authored. Edits made in the web interface as ${name} are attributed automatically. Space-separated; saving an
empty list clears it.</p></div>
<button type="submit" class="btn">Save emails</button>
</form>
</div>`;
  const danger = self
    ? html`<p class="muted small">A user cannot delete themselves; another administrator can, or edit <span class="mono">vault.json</span> by hand.</p>`
    : html`<div class="danger-zone">
<h3>Danger zone</h3>
<p>Deleting a user revokes every token they hold, immediately. Nothing they pushed is touched: commits, issues, and
comments keep their name.</p>
<form method="post" action="${base}/delete">
${csrfField(viewer)}
<div class="field"><label for="confirm">Type <b class="mono">${name}</b> to confirm</label><input type="text" id="confirm" name="confirm" autocomplete="off"></div>
<button type="submit" class="btn btn-danger">${icon('trash')}<span>Delete this user</span></button>
</form>
</div>`;
  const content = html`<div class="page-head"><div class="with-avatar">${avatar(name, 32)}<h1>${name}</h1></div><span class="right-group"><a class="btn" href="/${encodeURIComponent(
    name
  )}">${icon('person')}<span>Profile</span></a></span></div>
${flashBanner(msg)}
${errorBanner(error)}
<p class="muted">${user.siteAdmin ? 'Site admin' : html`Owns the collection <span class="mono">${name}</span> by name`}</p>
<h2>Tokens</h2>
${tokens}
${mint}
${passkeys}
${github}
${grant}
${identity}
${danger}
<p><a href="/admin/users">&larr; All users</a></p>`;
  return adminShell(viewer, 'users', `${name} - Users`, base, content);
}

/**
 * The shell every administration page sits in: the sections down the left, as
 * GitHub's settings pages have. It saves each page a "Back" link and makes it
 * plain what else there is to administer.
 */
export function adminShell(
  viewer: Viewer,
  active: 'index' | 'users' | 'runners' | 'appearance' | 'egress' | 'github',
  title: string,
  path: string,
  body: Html
): string {
  const item = (id: string, href: string, label: string, glyph: IconName) =>
    html`<a class="${active === id ? 'current' : ''}" href="${href}">${icon(glyph)}<span>${label}</span></a>`;
  // Every admin page is the site admin's now, but the shell keeps the check
  // so a page added for a weaker audience later hides what is not theirs.
  const canVault = isSiteAdmin(viewer.auth);
  const nav = html`<aside class="admin-side"><div class="side-block"><h3>${icon(
    'sliders'
  )}Administration</h3><div class="side-links">
${item('users', '/admin/users', 'Users', 'people')}
${item('runners', '/admin/runners', 'Runners', 'server')}
${canVault ? item('github', '/admin/github', 'GitHub sign-in', 'person') : ''}
${canVault ? item('egress', '/admin/egress', 'Egress', 'upload') : ''}
${canVault ? item('appearance', '/admin/appearance', 'Appearance', 'appearance') : ''}
</div></div></aside>`;
  // The bar locates an admin page the way it locates a repository page: the
  // trail up from here, for after the heading has scrolled away.
  const sections: Record<typeof active, { href: string; label: string } | null> = {
    index: null,
    users: { href: '/admin/users', label: 'Users' },
    runners: { href: '/admin/runners', label: 'Runners' },
    github: { href: '/admin/github', label: 'GitHub sign-in' },
    egress: { href: '/admin/egress', label: 'Egress' },
    appearance: { href: '/admin/appearance', label: 'Appearance' },
  };
  const section = sections[active];
  const crumbs = html` / <a href="/admin">admin</a>${
    section ? html` / <a href="${section.href}">${section.label}</a>` : ''
  }`;
  return layout(title, html`<div class="admin-layout">${nav}<div class="admin-main">${body}</div></div>`, {
    viewer,
    path,
    crumbs,
  });
}

export function adminIndexPage(viewer: Viewer, canVault: boolean): string {
  const card = (href: string, title: string, blurb: string) =>
    html`<a class="card" href="${href}"><b>${title}</b><span class="muted small">${blurb}</span></a>`;
  const content = html`<h1>Administration</h1>
<div class="card-list">
${card('/admin/users', 'Users', 'Create users, grant site admin, mint tokens.')}
${card('/admin/runners', 'Runners', 'Register the machines that execute workflow jobs.')}
${
  canVault
    ? card('/admin/github', 'GitHub sign-in', 'Let approved GitHub accounts sign in to this vault.')
    : ''
}
${
  canVault
    ? card('/admin/egress', 'Egress', 'See what has been sent out today, per repository, and cap what a day may send.')
    : ''
}
${
  canVault
    ? card('/admin/appearance', 'Appearance', 'Choose the theme this vault is served with.')
    : ''
}
</div>
${
  canVault
    ? ''
    : html`<p class="muted small">Appearance and the egress budget are vault-wide settings, so they are the site admin's.</p>`
}`;
  return adminShell(viewer, 'index', 'Administration', '/admin', content);
}

/**
 * What the vault has sent out today, and the cap on it.
 *
 * The page a bill sends someone looking, so it answers the two questions in
 * that order: how much has gone out today and which repository it went for,
 * then how to bound it. The breakdown is the honest part of the design and the
 * cap is the useful one, and both are on one page because a number without a
 * lever is just worrying.
 */
export function egressPage(
  viewer: Viewer,
  snap: EgressSnapshot,
  opts: { lfsBucket: boolean; msg?: string }
): string {
  const capped = snap.capBytes > 0;
  const share = capped ? Math.min(1, snap.total / snap.capBytes) : 0;
  // Amber before the vault stops answering rather than after, since the point
  // of looking at this page is to act before it does.
  const level = !capped ? 'off' : share >= 1 ? 'over' : share >= 0.8 ? 'near' : 'under';
  const meter = capped
    ? html`<div class="egress-meter"><span class="fill ${level}" style="width:${(share * 100).toFixed(
        1
      )}%"></span></div>`
    : '';
  const hours = Math.floor(snap.resetsIn / 3600);
  const mins = Math.round((snap.resetsIn % 3600) / 60);
  const resets = hours > 0 ? `${hours}h ${mins}m` : `${Math.max(1, mins)}m`;

  const banner = snap.overBudget
    ? html`<div class="form-error">This vault has reached its daily limit and is refusing ordinary requests. Administration pages
and signing in keep working. The counters reset at 00:00 UTC, in ${resets}; raising the limit below takes effect
immediately.</div>`
    : '';

  const rows =
    snap.rows.length > 0
      ? snap.rows.map((r) => {
          const bracketed = r.repo.startsWith('(');
          const name = bracketed
            ? html`<span class="muted">${r.repo}</span>`
            : html`<a href="/${encPath(r.repo)}">${r.repo}</a>`;
          const what = r.site ? raw('<span class="counter">site</span>') : '';
          return html`<tr><td>${name} ${what}</td><td class="right mono">${formatSize(r.bytes)}</td></tr>`;
        })
      : raw('<tr><td colspan="2" class="muted">Nothing has gone out yet today.</td></tr>');

  const history =
    snap.history.length > 0
      ? html`<h2>Earlier days</h2>
<table class="listing"><tbody><tr><th>Day (UTC)</th><th class="right">Out</th></tr>
${snap.history.map(
          (d) => html`<tr><td class="mono">${d.day}</td><td class="right mono">${formatSize(d.total)}</td></tr>`
        )}
</tbody></table>
<p class="muted small">Up to 30 days are kept, in <span class="mono">egress.json</span> at the root of the vault.</p>`
      : '';

  const content = html`<div class="page-head"><h1>Egress</h1></div>
${flashBanner(opts.msg)}
${banner}
<p class="muted">Bytes this server has written to clients, counted per repository and totalled per UTC day. A site served
from its own hostname is counted against the repository it belongs to, on a row of its own. Bytes that belong to no
repository are two rows: <span class="mono">(vault)</span> for the vault's own pages and API, and
<span class="mono">(unmatched)</span> for requests that named a repository this vault does not have.</p>
<div class="egress-total">
<b class="mono">${formatSize(snap.total)}</b>
<span class="muted">${capped ? `of ${formatSize(snap.capBytes)} today` : 'today, with no limit set'}</span>
</div>
${meter}
<p class="muted small">${snap.day} UTC. Resets in ${resets}.</p>

<table class="listing"><tbody><tr><th>Repository</th><th class="right">Out today</th></tr>${rows}</tbody></table>

<h2>Daily limit</h2>
<div class="form-box">
<form method="post" action="/admin/egress">
${csrfField(viewer)}
<div class="field">
<label for="egressGbPerDay">Gigabytes per day</label>
<input type="number" id="egressGbPerDay" name="egressGbPerDay" min="0" step="any" value="${snap.capGb}">
<p class="muted small">Once a day's total reaches this, every ordinary request is refused with a 503 until 00:00 UTC.
Administration pages, signing in, and the stylesheet they need keep working, within a further 64 MB, so that the limit
can be raised from here. 0 sends without a limit.</p>
</div>
<button type="submit" class="btn btn-primary">${icon('check')}<span>Save limit</span></button>
</form>
</div>

${history}

<h2>What is not counted</h2>
<ul class="muted small">
<li>Bytes are counted as they are written to the socket, so they include response headers and are compressed already.
What a host meters will be a little higher, since it also carries TCP and TLS framing.</li>
${
  opts.lfsBucket
    ? html`<li>Git LFS objects are served from the configured bucket through presigned URLs, so those downloads never pass
through this server and are not in these numbers; the bucket's own metering is where they show up. The limit still
reaches them, one step earlier: a client has to ask this server for a presigned URL before it can fetch anything, and
that request is refused like any other once the day's budget is spent. Only URLs signed in the previous hour keep
working.</li>`
    : ''
}
<li>Counts are written to disk at most every 30 seconds, so a hard kill can lose up to that much. Two servers sharing
one vault add their counts together at each write, and each may send up to 30 seconds past the limit before it sees the
other's.</li>
</ul>`;
  return adminShell(viewer, 'egress', 'Egress', '/admin/egress', content);
}

export function appearancePage(
  viewer: Viewer,
  themes: Theme[],
  current: string,
  msg?: string
): string {
  const cards = themes.map((t) => {
    // The colours are the theme's own tokens, from themes.ts, so they are
    // markup rather than data: a swatch is the one place the interface paints
    // with a palette other than the active one.
    const v = t.vars;
    const swatch = raw(`<div class="theme-swatch" style="background:${v.bg}">
<div class="bar" style="background:${v.surface};border:1px solid ${v.border}"></div>
<div class="row"><span class="dot" style="background:${v.accent}"></span><span class="dot" style="background:${v.primary}"></span><span class="dot" style="background:${v.tabMarker}"></span><span style="color:${v.fg};font-size:12px;font-family:${v.fontHead}">Aa</span><span style="color:${v.fgMuted};font-size:12px">muted</span></div>
</div>`);
    return html`<div class="theme-card${t.name === current ? ' current' : ''}">
<label>
${swatch}
<div class="theme-meta">
<span class="name"><input type="radio" name="theme" value="${t.name}"${
      t.name === current ? raw(' checked') : ''
    }> ${t.label}${t.dark ? raw(' <span class="counter">dark</span>') : ''}</span>
<p class="muted small">${t.blurb}</p>
</div>
</label>
</div>`;
  });
  const content = html`<div class="page-head"><h1>Appearance</h1></div>
${flashBanner(msg)}
<p class="muted">The theme applies to the whole vault, for every visitor. It is stored in <span class="mono">config.json</span> next to <span class="mono">vault.json</span>, so it can also be set by hand.</p>
<form method="post" action="/admin/appearance">
${csrfField(viewer)}
<div class="theme-grid">${cards}</div>
<button type="submit" class="btn btn-primary">${icon('check')}<span>Save theme</span></button>
</form>`;
  return adminShell(viewer, 'appearance', 'Appearance', '/admin/appearance', content);
}

/**
 * Sign-in with GitHub, administered: the OAuth App's credentials, the list of
 * GitHub accounts approved to sign in, and what is already linked. The
 * callback URL is on the page because it is the one value GitHub's form asks
 * for that the administrator would otherwise have to derive by hand.
 */
export function adminGithubPage(
  viewer: Viewer,
  opts: {
    clientId: string;
    secretSet: boolean;
    callbackUrl: string;
    approved: { id: number; login: string; added?: string; account: string | null }[];
    linked: { username: string; id: number; login: string }[];
    msg?: string;
    error?: string;
  }
): string {
  const on = opts.clientId !== '' && opts.secretSet;
  const status = on
    ? html`<p>Sign-in with GitHub is <b>on</b>: the sign-in page offers it, approved GitHub accounts get an account here
on their first sign-in, and users may link their GitHub account from their account page.</p>`
    : html`<p>Sign-in with GitHub is <b>off</b>${
        opts.clientId !== '' ? ' until the client secret is added below' : ''
      }.</p>`;
  const setup = html`<div class="form-box">
<h2>OAuth App</h2>
${status}
<p class="muted small">Create a GitHub OAuth App (on GitHub: Settings &rarr; Developer settings &rarr; OAuth Apps) with
this authorization callback URL, and put its credentials here:</p>
${copyRow(opts.callbackUrl)}
<form method="post" action="/admin/github">
${csrfField(viewer)}
<div class="field"><label for="ghClientId">Client id</label><input type="text" id="ghClientId" name="clientId" value="${
    opts.clientId
  }" autocomplete="off"></div>
<div class="field"><label for="ghClientSecret">Client secret</label><input type="password" id="ghClientSecret" name="clientSecret" autocomplete="off" placeholder="${
    opts.secretSet ? 'stored; leave empty to keep it' : ''
  }">
<p class="muted small">The client id is public and kept in <span class="mono">config.json</span>; the secret is written
to <span class="mono">.github-secret</span> beside <span class="mono">.secret</span>, mode 600, and never shown again.
Saving with an empty client id turns sign-in with GitHub off and removes the stored secret.</p></div>
<button type="submit" class="btn btn-primary">${icon('check')}<span>Save</span></button>
</form>
</div>`;
  const approvedRows = opts.approved.map(
    (a) => html`<tr><td><a href="https://github.com/${a.login}">${a.login}</a></td><td class="mono small muted">${String(
      a.id
    )}</td><td class="muted small">${a.added ? timeTag(a.added, '') : ''}</td><td>${
      a.account
        ? userLink(a.account, { face: 20, bold: true })
        : raw('<span class="muted small">first sign-in creates one</span>')
    }</td><td class="right">
<form method="post" action="/admin/github/approved/${String(a.id)}/remove" class="inline-form">
${csrfField(viewer)}
<button type="submit" class="btn btn-danger-outline">Remove</button>
</form></td></tr>`
  );
  const approvedTable = approvedRows.length
    ? html`<table class="listing"><tbody><tr><th>GitHub user</th><th>Id</th><th>Approved</th><th>Account here</th><th class="right"></th></tr>${approvedRows}</tbody></table>`
    : html`<p class="muted">Nobody is approved yet.</p>`;
  const approve = html`<div class="form-box">
<h2>Approved GitHub accounts</h2>
<p class="muted small">An approved GitHub account may sign in here; its first sign-in creates a vault account named
after the GitHub login, holding no tokens until one is minted for it. Approval is recorded by GitHub's stable numeric
id, resolved from the username as it is added, so a later rename on GitHub transfers nothing. Removing an approval
stops new accounts being created; a GitHub account already linked to a user keeps signing in until it is unlinked on
that user's page.</p>
${approvedTable}
<form method="post" action="/admin/github/approve" class="inline-form">
${csrfField(viewer)}
<label for="ghLogin">GitHub username</label><input type="text" id="ghLogin" name="login" autocomplete="off" spellcheck="false" required>
<button type="submit" class="btn">${icon('plus')}<span>Approve</span></button>
</form>
</div>`;
  const linkedRows = opts.linked.map(
    (l) => html`<tr><td class="with-avatar">${userLink(l.username, { face: 20, bold: true })}</td><td><a href="https://github.com/${
      l.login
    }">${l.login}</a></td><td class="mono small muted">${String(l.id)}</td></tr>`
  );
  const linked = linkedRows.length
    ? html`<h2>Linked accounts</h2>
<table class="listing"><tbody><tr><th>User</th><th>GitHub account</th><th>Id</th></tr>${linkedRows}</tbody></table>
<p class="muted small">Each is unlinked from its user's page under <a href="/admin/users">Users</a>, or by the user on
their own account page.</p>`
    : '';
  const content = html`<div class="page-head"><h1>GitHub sign-in</h1></div>
${flashBanner(opts.msg)}
${errorBanner(opts.error)}
${setup}
${approve}
${linked}`;
  return adminShell(viewer, 'github', 'GitHub sign-in', '/admin/github', content);
}

export function tokenPage(viewer: Viewer, username: string, token: string, created: boolean): string {
  const heading = created ? `Created user ${username}` : `New token for ${username}`;
  const content = html`<div class="form-box">
<h1>${heading}</h1>
<p>Copy the token now; only its SHA-256 hash is stored, so it cannot be shown again.</p>
<div class="cmd-row"><code>${token}</code>${copyButton()}</div>
<p class="muted small">Use it as the password with username <b>${username}</b> when git asks for credentials, or to sign in here.</p>
<p><a class="btn" href="/admin/users">Back to users</a></p>
</div>`;
  return layout(heading, content, { viewer, path: '/admin/users' });
}

export function opErrorPage(message: string, opts: PageOpts & { backUrl?: string } = {}): string {
  const back = opts.backUrl ? html`<p><a class="btn" href="${opts.backUrl}">Go back</a></p>` : '';
  return layout(
    'Error',
    html`<div class="form-box"><h1>That did not work</h1><div class="form-error">${message}</div>${back}</div>`,
    opts
  );
}
