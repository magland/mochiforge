import { BlameLine, CommitDetail, CommitSummary, RefInfo, TreeEntry } from './git';
import { LanguageStat } from './languages';
import { Html, html, joinHtml, raw } from './html';
import { esc, formatDateFull, formatDay, formatSize, highlightedLines, timeTag } from './render';
import { Viewer, viewerIsAdmin } from './session';
import { styleSheet } from './assets';
import { pageScript } from './pagescript';
import { ageScript } from './agescript';
import { isAgeFile } from './agefile';
import { THEMES, activeTheme, darkFor } from './themes';
import { WORDMARK } from './logo';
import { IconName, icon } from './icons';
import { Upstream } from './source';
import { avatar } from './avatar';
import { buildInfo } from './version';
// Type only: profile.ts builds its URLs with encPath from here, so a value
// import in this direction would close a cycle.
import type { CollectionProfile } from './profile';

export interface RepoCtx {
  collection: string;
  repo: string;
  ref: string;
  refIsBranch: boolean;
  defaultBranch: string;
  branches: RefInfo[];
  tags: RefInfo[];
  cloneUrl: string;
  hasSite: boolean;
  /** Where the Site tab points: the site's own origin when it has one. */
  siteUrl: string;
  hasCi: boolean;
  /** Tags that have release notes in the vault. */
  releases: string[];
  /** Open issues, for the Issues tab's count. */
  openIssues: number;
  /** Open pull requests, for the tab's counter. */
  openPulls: number;
  /** The repository this one was forked from, if it was. */
  forkedFrom: { collection: string; repo: string } | null;
  /** The URL outside this vault it was forked from, if `mochi fork` recorded one. */
  upstream: Upstream | null;
  viewer: Viewer | null;
  /** Whether the repository is private, for the badge beside its name. */
  isPrivate: boolean;
  canPush: boolean;
  canAdmin: boolean;
  /**
   * The vault user a commit author email belongs to, or null for an identity
   * the vault does not know. Optional so a page built without a vault (tests,
   * mostly) simply links nobody.
   */
  accountFor?: (email: string) => string | null;
  /** Whether the vault knows a user by this name, for @mentions. */
  hasUser?: (name: string) => boolean;
}

export interface PageOpts {
  crumbs?: Html;
  viewer?: Viewer | null;
  // Current request path, used as the ?next= target of the Sign in link.
  path?: string;
  // What the jump box can reach from this page besides the vault's
  // repositories: where a repository page's own sections are, and where its
  // search and file finder take a query.
  jump?: JumpContext;
  // Load /assets/age.js too: only the pages that show or write an
  // age-encrypted file, so the vendored cryptography is never fetched by a
  // page that cannot need it.
  ageScript?: boolean;
}

export interface JumpContext {
  repo: string;
  sections: { label: string; href: string }[];
  searchUrl: string;
  findUrl: string;
}

export function encPath(p: string): string {
  return p
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

export function repoUrl(ctx: { collection: string; repo: string }): string {
  return `/${encodeURIComponent(ctx.collection)}/${encodeURIComponent(ctx.repo)}`;
}

export function csrfField(viewer: Viewer): Html {
  return html`<input type="hidden" name="csrf" value="${viewer.csrf}">`;
}

/**
 * A vault username as a link to their profile page at /<name>. The link keeps
 * the weight and colour of the text around it, so a name reads the same
 * whether or not it is one; only hover says it goes somewhere. `face` puts
 * the identicon before the name at that size, and `bold` matches the places
 * that already set the name in bold.
 */
export function userLink(name: string, opts: { face?: number; bold?: boolean } = {}): Html {
  const label = opts.bold ? html`<b>${name}</b>` : html`${name}`;
  return html`<a class="user-link" href="/${encodeURIComponent(name)}">${
    opts.face ? avatar(name, opts.face) : ''
  }${label}</a>`;
}

/**
 * A git author identity, linked to a profile when the email resolves to a
 * vault user and shown exactly as git reported it when it does not. The
 * identicon is drawn from the account where there is one, so the same person
 * wears the same face whatever author emails their commits carry.
 */
export function gitAuthor(ctx: RepoCtx, name: string, email: string | undefined, opts: { face?: number; bold?: boolean } = {}): Html {
  const account = email ? (ctx.accountFor?.(email) ?? null) : null;
  if (account) {
    const label = opts.bold ? html`<b>${name}</b>` : html`${name}`;
    return html`<a class="user-link" href="/${encodeURIComponent(account)}" title="${account}">${
      opts.face ? avatar(account, opts.face) : ''
    }${label}</a>`;
  }
  const label = opts.bold ? html`<b>${name}</b>` : html`${name}`;
  return html`${opts.face ? avatar(email || name, opts.face) : ''}${label}`;
}

const FOLDER_ICON = icon('folder', 'icon');
const FILE_ICON = icon('file', 'icon file');
// An age-encrypted file wears the lock wherever files are listed, so what is
// encrypted can be seen without opening anything.
const AGE_ICON = icon('lock', 'icon file');
const REPO_ICON = icon('repo', 'icon');
const fileIcon = (name: string): Html => (isAgeFile(name) ? AGE_ICON : FILE_ICON);

function userBox(opts: PageOpts): Html {
  const viewer = opts.viewer ?? null;
  if (!viewer) {
    const next = opts.path && opts.path.startsWith('/') ? opts.path : '/';
    return html`<a class="btn" href="/login?next=${encodeURIComponent(next)}">Sign in</a>`;
  }
  // The signed-in header is an avatar that opens a menu, as GitHub's is: the
  // name and what you can do with the account are one click away rather than
  // spread across the bar.
  const name = viewer.auth.username;
  const admin = viewerIsAdmin(viewer)
    ? html`<a class="dd-item" href="/admin">${icon('sliders')}<span>Admin</span></a>`
    : '';
  return html`<details class="dropdown user-menu">
<summary aria-label="Account menu">${avatar(name, 24)}${icon('chevron-down', 'caret')}</summary>
<div class="dropdown-menu dd-right">
  <div class="dd-section">Signed in as <b>${name}</b></div>
  <a class="dd-item" href="/${encodeURIComponent(name)}">${icon('person')}<span>Your profile</span></a>
  <a class="dd-item" href="/account">${icon('lock')}<span>Your account</span></a>
  ${admin}
  <form method="post" action="/logout">${csrfField(viewer)}<button type="submit" class="dd-item">${icon(
    'sign-out'
  )}<span>Sign out</span></button></form>
</div>
</details>`;
}

/**
 * The jump box. A vault is many repositories and one collection page, so the
 * way between any two of them was previously up and back down; this is the
 * one control that goes straight there, from every page, on one keystroke.
 * The button carries the keystroke on its face, since a shortcut nothing
 * mentions is a shortcut nobody finds.
 */
function jumpButton(): Html {
  return html`<button type="button" class="jump-open" data-jump-open aria-haspopup="dialog" aria-label="Jump to a repository">${icon(
    'search'
  )}<span class="jump-label">Jump to</span><kbd class="jump-key">/</kbd></button>`;
}

/**
 * Which appearance the reader wants. The vault's theme is what the operator
 * chose and stays the default, but the reader is the one looking at it, on
 * their screen and at their hour, so they get the last word. The choice is
 * kept in their own browser: nothing about it reaches the vault, and a vault
 * that is read anonymously has nowhere to keep it anyway.
 */
function themeMenu(): Html {
  const item = (name: string, label: string) =>
    html`<button type="button" class="dd-item theme-item" role="menuitemradio" aria-checked="false" data-theme-name="${name}"><span class="theme-check">${icon('check')}</span><span>${label}</span></button>`;
  return html`<details class="dropdown theme-menu">
<summary aria-label="Appearance">${icon('appearance')}</summary>
<div class="dropdown-menu dd-right" role="menu">
  <div class="dd-section">Appearance</div>
  ${item('auto', 'Match my system')}
  ${joinHtml(THEMES.map((t) => item(t.name, t.label)), '\n  ')}
</div>
</details>`;
}

/**
 * The way to /about from every page. A visitor can land anywhere in a vault,
 * on a file or an issue rather than the front page, so what this site is has
 * to be reachable from wherever they arrived rather than from one listing.
 */
function aboutLink(): Html {
  return html`<a class="topbar-icon" href="/about" aria-label="About" title="About this vault">${icon('info')}</a>`;
}

function jumpDialog(jump: JumpContext | null): Html {
  const data = jump
    ? // The payload is JSON in a script tag, where escaping entities would
      // corrupt it; < is neutralized in the JSON's own spelling instead.
      html`<script type="application/json" id="jump-data">${raw(JSON.stringify(jump).replace(/</g, '\\u003c'))}</script>`
    : '';
  return html`${data}<dialog class="jump" id="jump" aria-label="Jump to">
<div class="jump-field">${icon('search', 'jump-glyph')}<input id="jump-q" type="text" autocomplete="off" spellcheck="false" placeholder="Jump to a repository" aria-label="Jump to a repository" aria-controls="jump-list"></div>
<ul class="jump-list" id="jump-list" role="listbox" aria-label="Results"></ul>
<div class="jump-foot"><kbd>↑</kbd><kbd>↓</kbd> move<kbd>↵</kbd>open<kbd>esc</kbd>close</div>
</dialog>`;
}

/**
 * What this vault is running, at the foot of every page. An operator who has
 * just deployed something needs to know whether they are looking at it, and a
 * version alone cannot say: main carries the last release's version until the
 * next bump, so several different builds answer to "0.3.0". The commit narrows
 * it to one and the date says when that one was compiled. A vault running from
 * source has no build to name and says that instead of showing a date it would
 * have had to invent. See src/version.ts for where the stamp comes from.
 */
function buildStamp(): Html {
  const build = buildInfo();
  const parts: Html[] = [html`Mochi Forge <span class="mono">${build.version}</span>`];
  if (build.commit) parts.push(html`build <span class="mono">${build.commit}</span>`);
  const iso = build.builtAt;
  const built = iso ? new Date(iso) : null;
  parts.push(
    iso && built && !isNaN(built.getTime())
      ? // The day, not "3 days ago": what this gets compared against is a date
        // kept somewhere else, a release or a deploy log, and the exact time is
        // a hover away for anyone telling two builds of one day apart.
        html`built <time datetime="${built.toISOString()}" title="${formatDateFull(iso)}">${formatDay(iso)}</time>`
      : html`running from source`
  );
  return joinHtml(parts, ' <span class="foot-sep">\u00b7</span> ');
}

export function layout(title: string, content: Html, opts: PageOpts = {}): string {
  // The theme name rides along as a query parameter so a changed theme busts
  // any cache in front of the stylesheets, and the stylesheet carries a tag of
  // its own contents so that an upgrade does too. Between them the sheet can
  // then be kept for good instead of revalidated on every navigation.
  const theme = activeTheme().name;
  const sheet = styleSheet(activeTheme()).tag;
  const script = pageScript().tag;
  // Deferred: nothing on it is needed before the DOM exists, and the page's
  // own script must not wait behind 300 KB of cryptography.
  const age = opts.ageScript ? html`<script src="/assets/age.js?v=${ageScript().tag}" defer></script>` : '';
  // The theme pair rides on <html> rather than in the script, which is what
  // lets /assets/page.js be one cacheable file for every vault: the script
  // reads these two attributes instead of being generated around them.
  return html`<!doctype html>
<html lang="en" data-theme-vault="${theme}" data-theme-dark="${darkFor(activeTheme())}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/assets/style.css?t=${encodeURIComponent(theme)}&amp;v=${sheet}">
<link id="hl-css" rel="stylesheet" href="/assets/hl.css?t=${encodeURIComponent(theme)}">
<link rel="stylesheet" href="/assets/katex/katex.css">
<link rel="icon" href="/favicon.svg?t=${encodeURIComponent(theme)}" type="image/svg+xml">
<script src="/assets/page.js?v=${script}"></script>${age}
</head>
<body>
<header class="topbar"><div class="container"><a class="brand" href="/">${raw(WORDMARK)}</a><span class="crumbs">${opts.crumbs}</span><div class="userbox">${jumpButton()}${aboutLink()}${themeMenu()}${userBox(opts)}</div></div></header>
<main class="container">
${content}
</main>
<footer class="pagefoot"><div class="container">${buildStamp()}</div></footer>
${jumpDialog(opts.jump ?? null)}
</body>
</html>`.text;
}

export function repoOpts(ctx: RepoCtx, path?: string): PageOpts {
  // Every repository page puts its address in the top bar as well as at the
  // head of the page. The bar is what stays in view once the reader has
  // scrolled into a long file or a long thread, so it is the one place that
  // can always answer "where am I, and how do I get back up from here".
  const crumbs = html` / <a href="/${encodeURIComponent(ctx.collection)}">${ctx.collection}</a> / <a href="${repoUrl(
    ctx
  )}">${ctx.repo}</a>`;
  return { viewer: ctx.viewer, path, crumbs, jump: jumpContext(ctx) };
}

/**
 * What the jump box offers from inside a repository: the sections its tabs
 * lead to, and the two searches that take what has been typed rather than
 * matching against it. The list mirrors the tab row, so a section that is not
 * shown there is not reachable here either.
 */
function jumpContext(ctx: RepoCtx): JumpContext {
  const base = repoUrl(ctx);
  const sections: { label: string; href: string }[] = [
    { label: 'Code', href: base },
    { label: 'Commits', href: `${base}/commits/${encPath(ctx.ref)}` },
    { label: 'Issues', href: `${base}/issues` },
    { label: 'Pull requests', href: `${base}/pulls` },
    { label: 'Branches', href: `${base}/branches` },
    { label: 'Tags', href: `${base}/tags` },
    { label: 'Releases', href: `${base}/releases` },
  ];
  if (ctx.hasCi) sections.push({ label: 'Actions', href: `${base}/actions` });
  if (ctx.hasSite) sections.push({ label: 'Site', href: ctx.siteUrl });
  if (ctx.canPush || ctx.canAdmin) sections.push({ label: 'Settings', href: `${base}/settings` });
  return {
    repo: ctx.repo,
    sections,
    searchUrl: `${base}/search?ref=${encodeURIComponent(ctx.ref)}&q=`,
    findUrl: `${base}/find/${encPath(ctx.ref)}`,
  };
}

/**
 * The copy button that sits after a <code> or <input> holding the text.
 * Confirmation is a class the script toggles rather than replaced markup, so
 * the idle and copied faces are both in the page and neither needs escaping
 * at click time.
 */
export function copyButton(label = '', text?: string, title = ''): Html {
  const face = (glyph: IconName, caption: string, cls: string) =>
    html`<span class="${cls}">${icon(glyph)}${label ? html`<span>${caption}</span>` : ''}</span>`;
  // With no text of its own the button copies the element before it, which is
  // how the command rows and the clone box use it.
  const payload = text === undefined ? '' : html` data-copy="${text}"`;
  return html`<button class="copy-btn" type="button"${payload}${
    title ? html` title="${title}"` : ''
  } aria-label="Copy${label ? ` ${label.toLowerCase()}` : ''}">${face('copy', label, 'copy-idle')}${face(
    'check',
    'Copied',
    'copy-done'
  )}</button>`;
}

export function copyRow(cmd: string): Html {
  return html`<div class="cmd-row"><code>${cmd}</code>${copyButton()}</div>`;
}

/**
 * A passphrase input wrapped with a show/hide toggle. The input never carries
 * a name, so no form can ever post its value; /assets/age.js wires the
 * toggle, and both eye glyphs are drawn here so the script draws nothing.
 * With an `id` the field is labelled by its <label>; without one it carries
 * its placeholder as the accessible name.
 */
export function agePassInput(opts: {
  id?: string;
  placeholder?: string;
  autocomplete: 'off' | 'new-password';
  required?: boolean;
}): Html {
  const label = opts.placeholder ?? 'Passphrase';
  return html`<span class="age-pass-wrap"><input type="password"${opts.id ? html` id="${opts.id}"` : ''}${
    opts.placeholder ? html` placeholder="${opts.placeholder}"` : ''
  }${opts.id ? '' : html` aria-label="${label}"`} autocomplete="${opts.autocomplete}" spellcheck="false"${
    opts.required ? raw(' required') : ''
  }><button type="button" class="age-eye" aria-label="Show the passphrase" aria-pressed="false">${icon(
    'eye',
    'glyph-eye'
  )}${icon('eye-off', 'glyph-eye-off')}</button></span>`;
}

/**
 * The branch and tag picker: a button carrying the current ref, opening a
 * menu of every ref with a filter box, as on GitHub. It is a <details>
 * element, so it opens, closes, and takes the keyboard without a component
 * framework; the page script closes it on an outside click and filters the
 * list as you type.
 */
function refPicker(ctx: RepoCtx, urlForRef: (ref: string) => string): Html {
  const isTag = ctx.tags.some((t) => t.name === ctx.ref);
  const known = isTag || ctx.branches.some((b) => b.name === ctx.ref);
  const item = (r: RefInfo) => {
    const current = r.name === ctx.ref;
    return html`<a class="dd-item${current ? ' current' : ''}" href="${urlForRef(r.name)}">${
      current ? icon('check', 'dd-check') : raw('<span class="dd-check"></span>')
    }<span class="dd-label">${r.name}</span></a>`;
  };
  const group = (label: string, refs: RefInfo[]) =>
    refs.length === 0
      ? ''
      : html`<div class="dd-group"><div class="dd-section">${label}</div>${refs.map(item)}</div>`;
  // A ref that is neither branch nor tag is a raw commit the reader navigated
  // to; name it on the button so the picker never lies about where they are.
  const glyph = known ? (isTag ? 'tag' : 'git-branch') : 'git-commit';
  const shown = known ? ctx.ref : ctx.ref.slice(0, 7);
  return html`<details class="dropdown ref-picker">
<summary class="btn" title="Switch branches or tags">${icon(glyph)}<b class="dd-current">${shown}</b>${icon(
    'chevron-down',
    'caret'
  )}</summary>
<div class="dropdown-menu">
  <input class="dd-filter" type="text" placeholder="Find a branch or tag" aria-label="Filter branches and tags">
  <div class="dd-scroll">${group('Branches', ctx.branches)}${group('Tags', ctx.tags)}</div>
</div>
</details>`;
}

/**
 * The way in to the file finder. The data attribute is what the page script
 * watches for, so that t reaches the finder from any page that offers it, as
 * on GitHub.
 */
function findButton(ctx: RepoCtx): Html {
  const href = `${repoUrl(ctx)}/find/${encPath(ctx.ref)}`;
  return html`<a class="btn" href="${href}" data-find-url="${href}" title="Go to file (t)">${icon(
    'search'
  )}<span>Go to file</span></a>`;
}

/** The green Code button: the clone URL, and the source as an archive. */
function cloneMenu(ctx: RepoCtx): Html {
  const archive = (ext: string, label: string) =>
    html`<a class="dd-item" href="${repoUrl(ctx)}/archive/${encPath(ctx.ref)}.${ext}">${icon(
      'file-zip'
    )}<span class="dd-label">${label}</span></a>`;
  return html`<details class="dropdown clone-menu">
<summary class="btn btn-primary">${icon('code')}<span>Code</span>${icon('chevron-down', 'caret')}</summary>
<div class="dropdown-menu dd-right">
  <div class="dd-section">Clone with HTTP</div>
  <div class="cmd-row"><input readonly value="${ctx.cloneUrl}" data-select-all>${copyButton()}</div>
  <p class="muted small">Anyone can clone. Pushing asks for a username and a token.</p>
  <div class="dd-group"><div class="dd-section">Download ${ctx.ref}</div>
${archive('zip', 'Source as zip')}${archive('tar.gz', 'Source as tar.gz')}</div>
</div>
</details>`;
}

export function repoHeader(
  ctx: RepoCtx,
  active: 'code' | 'commits' | 'issues' | 'pulls' | 'actions' | 'branches' | 'tags' | 'releases' | 'settings'
): Html {
  const base = repoUrl(ctx);
  const tab = (id: string, label: string, href: string, glyph: IconName, count?: number) =>
    html`<a class="tab${active === id ? ' active' : ''}" href="${href}">${icon(glyph)}<span>${label}</span>${
      count !== undefined ? html`<span class="counter">${count}</span>` : ''
    }</a>`;
  // The search box rides in the title row, so searching this repository is a
  // keystroke away from every one of its pages.
  const search = html`<form class="repo-search" method="get" action="${base}/search" role="search"><input type="hidden" name="ref" value="${ctx.ref}"><input class="search-input" type="search" name="q" placeholder="Search this repository" aria-label="Search this repository">${icon(
    'search',
    'search-glyph'
  )}</form>`;
  const parent = ctx.forkedFrom
    ? html`<div class="fork-note muted small">${icon('repo-forked')}<span>forked from <a href="/${encodeURIComponent(
        ctx.forkedFrom.collection
      )}/${encodeURIComponent(ctx.forkedFrom.repo)}">${ctx.forkedFrom.collection}/${ctx.forkedFrom.repo}</a></span></div>`
    : ctx.upstream
      ? html`<div class="fork-note muted small">${icon('repo-forked')}<span>forked from ${
          ctx.upstream.web
            ? html`<a href="${ctx.upstream.web}" rel="noopener">${ctx.upstream.label}</a>`
            : ctx.upstream.label
        }</span></div>`
      : '';
  const badge = ctx.isPrivate ? html` <span class="counter" title="Only collaborators, owners, and site admins can see this repository">Private</span>` : '';
  return html`<div class="repo-title">${REPO_ICON}<a href="/${encodeURIComponent(ctx.collection)}">${ctx.collection}</a> <span class="muted">/</span> <a href="${base}"><b>${ctx.repo}</b></a>${badge}${search}</div>
${parent}
<nav class="tabs">
${tab('code', 'Code', base, 'code')}
${tab('commits', 'Commits', `${base}/commits/${encPath(ctx.ref)}`, 'history')}
${tab('issues', 'Issues', `${base}/issues`, 'issue-opened', ctx.openIssues)}
${tab('pulls', 'Pull requests', `${base}/pulls`, 'git-pull-request', ctx.openPulls)}
${ctx.hasCi || active === 'actions' ? tab('actions', 'Actions', `${base}/actions`, 'play') : ''}
${tab('branches', 'Branches', `${base}/branches`, 'git-branch', ctx.branches.length)}
${tab('tags', 'Tags', `${base}/tags`, 'tag', ctx.tags.length)}
${ctx.releases.length || active === 'releases' ? tab('releases', 'Releases', `${base}/releases`, 'rocket', ctx.releases.length) : ''}
${ctx.hasSite ? tab('site', 'Site', ctx.siteUrl, 'globe') : ''}
${ctx.canPush || ctx.canAdmin ? tab('settings', 'Settings', `${base}/settings`, 'sliders') : ''}
</nav>`;
}

function breadcrumb(ctx: RepoCtx, path: string): Html {
  const base = repoUrl(ctx);
  const parts = path === '' ? [] : path.split('/');
  const pieces: Html[] = [html`<a href="${base}/tree/${encPath(ctx.ref)}">${ctx.repo}</a>`];
  let acc = '';
  parts.forEach((part, i) => {
    acc = acc === '' ? part : `${acc}/${part}`;
    const last = i === parts.length - 1;
    if (last) {
      pieces.push(html`<b>${part}</b>`);
    } else {
      pieces.push(html`<a href="${base}/tree/${encPath(ctx.ref)}/${encPath(acc)}">${part}</a>`);
    }
  });
  return html`<span class="crumb">${joinHtml(pieces, ' / ')}</span>`;
}

/**
 * The "find a repository" box GitHub puts above a long listing. It filters
 * rows in the page rather than asking the server, which is honest about what
 * it is: a way to find a name you already know in a list you can already see.
 * Short lists do not get one, since scanning five names is faster than typing.
 */
function listFilter(target: string, placeholder: string, rowCount: number): Html | '' {
  if (rowCount <= 5) return '';
  return html`<div class="toolbar"><div class="left"><input class="list-filter" type="text" placeholder="${placeholder}" data-target="${target}" data-filter="rows" aria-label="${placeholder}"></div></div>`;
}

function noMatches(target: string): Html {
  return html`<div class="empty-state" id="${target}-empty" hidden>No match.</div>`;
}

/** One repository as a listing shows it, on the front page or in a collection. */
export interface RepoCard {
  collection: string;
  name: string;
  description: string | null;
  /** The repository's topics, rendered as chips leading to /topics/<t>. */
  topics?: string[];
  /** Shown as a badge; a private repository is only ever listed to its own readers. */
  isPrivate?: boolean;
  updated: string | null;
  /** Where this repository's published site is, or null if it has none. */
  siteUrl?: string | null;
  /** How its newest workflow run ended, for the health mark. */
  ci?: { conclusion: string | null; running: boolean; url: string } | null;
}

/**
 * Topic chips, each leading to the vault-wide page for that topic. One look
 * everywhere on purpose: a topic is the same topic wherever it appears, so it
 * wears one colour from the theme rather than a colour of its own the way an
 * issue label does.
 */
export function topicChips(topics: string[] | undefined): Html | '' {
  if (!topics || topics.length === 0) return '';
  return html`<span class="topic-chips">${joinHtml(
    topics.map((t) => html`<a class="chip topic" href="/topics/${encodeURIComponent(t)}">${t}</a>`)
  )}</span>`;
}

const CI_MARKS: Record<string, { glyph: IconName; label: string }> = {
  running: { glyph: 'dot', label: 'running' },
  success: { glyph: 'check-circle', label: 'passed' },
  failure: { glyph: 'x-circle', label: 'failed' },
  cancelled: { glyph: 'stop', label: 'cancelled' },
  skipped: { glyph: 'skip', label: 'skipped' },
};

function ciMark(ci: NonNullable<RepoCard['ci']>, repoName: string): Html {
  const state = ci.running ? 'running' : (ci.conclusion ?? 'skipped');
  const mark = CI_MARKS[state] ?? CI_MARKS.skipped;
  return html`<a class="ci-mark ci-${state}" href="${ci.url}" aria-label="Last workflow run for ${repoName}: ${mark.label}" title="Last workflow run ${mark.label}">${icon(mark.glyph)}</a>`;
}

/**
 * A repository in a listing. Everything a reader decides on from a list of
 * names is here and nothing else is: what it is called, what it is, when it
 * was last touched, whether it publishes a site, and whether its last build
 * passed. The name is the only link that fills the card, so the site and the
 * build are reachable without opening the repository to find them.
 */
function repoCard(r: RepoCard, showCollection: boolean): Html {
  const href = `/${encodeURIComponent(r.collection)}/${encodeURIComponent(r.name)}`;
  const prefix = showCollection ? html`<span class="rc-collection">${r.collection}/</span>` : '';
  const site = r.siteUrl
    ? html`<a class="site-link" href="${r.siteUrl}" title="Site" aria-label="Site for ${r.name}">${icon('globe')}</a>`
    : '';
  const ci = r.ci ? ciMark(r.ci, r.name) : '';
  // The card clips to two lines with CSS, but the clipping is visual only:
  // the bytes still travel, and a listing repeats them per repository, so a
  // description larger than the model now accepts (one written before the cap
  // existed) is cut here rather than shipped whole to every reader.
  const shown =
    r.description && r.description.length > 400 ? `${r.description.slice(0, 400)}…` : r.description;
  const desc = shown ? html`<p class="rc-desc">${shown}</p>` : '';
  const topics = topicChips(r.topics);
  const when = r.updated ? html`<span class="rc-when">${timeTag(r.updated)}</span>` : '';
  const badge = r.isPrivate ? html`<span class="counter">Private</span>` : '';
  return html`<li class="repo-card">
<div class="rc-top"><a class="rc-name" href="${href}">${prefix}${r.name}</a>${badge}<span class="rc-marks">${site}${ci}</span></div>
${desc}
${topics ? html`<div class="rc-topics">${topics}</div>` : ''}
<div class="rc-meta">${when}</div>
</li>`;
}

/**
 * What the reader has narrowed a repository listing to by topic, and what the
 * listing's own links must therefore carry: the topic chosen (or '' for
 * none), and the topics in use among the repositories the page would
 * otherwise show, for the dropdown that does the narrowing.
 */
export interface TopicFilter {
  current: string;
  inUse: { topic: string; count: number }[];
}

/**
 * The listing itself. Sorting is a link rather than a script, so the order a
 * reader chose is in the address they can keep, and the two orders answer the
 * two questions a listing is asked: what has been happening lately, and where
 * is the one I already know the name of. Narrowing by topic is a link for the
 * same reason, and each link carries the rest of the choice, so picking a
 * sort never loses the topic and picking a topic never loses the sort.
 */
function repoListing(
  repos: RepoCard[],
  opts: { showCollection: boolean; sort: 'recent' | 'name'; sortBase: string; topics?: TopicFilter }
): Html {
  const sorted = [...repos];
  if (opts.sort === 'name') {
    sorted.sort((a, b) => a.name.localeCompare(b.name) || a.collection.localeCompare(b.collection));
  } else {
    sorted.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
  }
  const topic = opts.topics?.current ?? '';
  const listUrl = (sort: 'recent' | 'name', t: string) => {
    const params = new URLSearchParams();
    if (sort !== 'recent') params.set('sort', sort);
    if (t !== '') params.set('topic', t);
    const q = params.toString();
    return q === '' ? opts.sortBase : `${opts.sortBase}?${q}`;
  };
  const sortLink = (id: 'recent' | 'name', label: string) =>
    html`<a${opts.sort === id ? raw(' class="current" aria-current="true"') : ''} href="${listUrl(id, topic)}">${label}</a>`;
  const inUse = opts.topics?.inUse ?? [];
  const topicMenu =
    inUse.length !== 0 || topic !== ''
      ? html`<details class="dropdown topic-menu">
<summary class="btn">${icon('tag')}<span>${topic || 'Topics'}</span>${icon('chevron-down', 'caret')}</summary>
<div class="dropdown-menu"><div class="dd-scroll">${joinHtml([
          html`<a class="dd-item${topic === '' ? ' current' : ''}" href="${listUrl(opts.sort, '')}"><span class="dd-check"></span><span class="dd-label">Any topic</span></a>`,
          ...inUse.map(
            (t) =>
              html`<a class="dd-item${topic === t.topic ? ' current' : ''}" href="${listUrl(opts.sort, t.topic)}">${
                topic === t.topic ? icon('check', 'dd-check') : raw('<span class="dd-check"></span>')
              }<span class="dd-label">${t.topic}</span><span class="muted small">${t.count}</span></a>`
          ),
        ])}</div></div>
</details>`
      : '';
  const controls = html`<div class="listing-controls">
<input class="list-filter" type="text" placeholder="Filter repositories" data-target="repo-list" data-filter="cards" aria-label="Filter repositories">
${topicMenu}
<span class="seg">${sortLink('recent', 'Recent')}${sortLink('name', 'A–Z')}</span>
</div>`;
  // The controls stay once a topic is chosen, whatever the count: a narrowing
  // that hides the way back out would be a trap.
  return html`${repos.length > 5 || topic !== '' ? controls : ''}<ul class="repo-grid" id="repo-list">${joinHtml(
    sorted.map((r) => repoCard(r, opts.showCollection)),
    '\n'
  )}</ul>${noMatches('repo-list')}`;
}

export function homePage(
  rootLabel: string,
  collections: { name: string; repoCount: number }[],
  repos: RepoCard[],
  sort: 'recent' | 'name',
  viewer: Viewer | null,
  topics: TopicFilter = { current: '', inUse: [] }
): string {
  const total = repos.length;
  const chips = collections.length
    ? html`<nav class="collection-chips" aria-label="Collections">${collections.map(
        (c) =>
          html`<a class="coll-chip" href="/${encodeURIComponent(c.name)}">${avatar(c.name, 18, 'square')}<span>${
            c.name
          }</span><span class="coll-count">${c.repoCount}</span></a>`
      )}</nav>`
    : '';
  const body =
    total === 0
      ? topics.current !== ''
        ? html`<div class="empty-state">No repositories carry the topic <b>${topics.current}</b>. <a href="/">Show all</a>.</div>`
        : html`<div class="empty-state">No repositories yet.${
            viewer ? ' Create one with the buttons above, or push to a new path.' : ''
          }</div>`
      : repoListing(repos, { showCollection: true, sort, sortBase: '/', topics });
  const newBtn = viewer
    ? html`<a class="btn" href="/new/collection">${icon('plus')}<span>New collection</span></a><a class="btn btn-primary" href="/new">${icon(
        'plus'
      )}<span>New repository</span></a>`
    : '';
  const summary =
    total === 0
      ? ''
      : topics.current !== ''
        ? html`<p class="lede">${total} ${total === 1 ? 'repository' : 'repositories'} with the topic <b>${topics.current}</b>.</p>`
        : html`<p class="lede">${total} ${total === 1 ? 'repository' : 'repositories'} in ${collections.length} ${
            collections.length === 1 ? 'collection' : 'collections'
          }.</p>`;
  const content = html`<div class="page-head"><h1>Repositories</h1><span class="right-group">${newBtn}</span></div>
${summary}
${chips}
${body}
${
    // Where the vault sits on disk is the operator's business and not a
    // visitor's, so the path is shown to someone who could act on it.
    viewerIsAdmin(viewer) ? html`<p class="muted small vault-note">Serving ${rootLabel}</p>` : ''
  }`;
  return layout('Mochi Forge', content, { viewer, path: '/' });
}

/**
 * What this place is, in as few lines as answer the question. A visitor who
 * wants more detail than this has the vault itself and the project on GitHub;
 * a visitor who landed here cold wants one paragraph, not a manual.
 */
export function aboutPage(baseUrl: string, viewer: Viewer | null): string {
  const content = html`<div class="about-page">
<h1>About this vault</h1>
<p class="lede">This site is a <i>vault</i>: a small self-hosted git forge, holding git repositories grouped into
collections.</p>
<p>Browsing and cloning are anonymous, apart from private repositories:</p>
${copyRow(`git clone ${baseUrl}/<collection>/<repository>`)}
<p>Writing needs an account, which this vault's administrator creates; there is no sign-up. Your token is the password
git asks for, and it also <a href="/login">signs you in</a> here.</p>
<p>The software is <a href="https://github.com/magland/mochiforge">Mochi Forge</a>, open source under the Apache 2.0
license.</p>
</div>`;
  return layout('About - Mochi Forge', content, { viewer, path: '/about' });
}

/**
 * What the collection page adds when the collection is a user's namespace: the
 * page doubles as their profile, the way github.com/<user> is both. Everything
 * here comes from the profile the user wrote (see UserProfile in src/vault.ts)
 * plus the two facts the page decorates with.
 */
export interface ProfileOwner {
  /** The name the user chose to show; the username stands alone without one. */
  displayName: string | null;
  bio: string | null;
  /** http(s) URLs, enforced where the profile is saved. */
  links: string[];
  siteAdmin: boolean;
  /** Whether the viewer is this user, which is who gets the Edit profile button. */
  isViewer: boolean;
}

export function collectionPage(
  collection: string,
  repoList: RepoCard[],
  sort: 'recent' | 'name',
  viewer: Viewer | null,
  // Whether the viewer may reach the collection's settings, which is the only
  // way to the rename. A control nobody can use is not shown, as elsewhere.
  canAdminCollection: boolean,
  // The collection's profile README, read from its .mochi repository; see
  // src/profile.ts. Rendered above the listing, since it is what the page is
  // for once a collection has one.
  profile: CollectionProfile | null = null,
  // Present when a vault user bears the collection's name: the page is then
  // their profile page too, and this is what the profile part shows.
  owner: ProfileOwner | null = null,
  topics: TopicFilter = { current: '', inUse: [] }
): string {
  const body =
    repoList.length === 0
      ? topics.current !== ''
        ? html`<div class="empty-state">No repositories here carry the topic <b>${topics.current}</b>. <a href="/${encodeURIComponent(collection)}">Show all</a>.</div>`
        : html`<div class="empty-state">No repositories in this collection yet.${
            viewer ? ' Create one with the buttons above, or push to a new path.' : ''
          }</div>`
      : repoListing(repoList, {
          showCollection: false,
          sort,
          sortBase: `/${encodeURIComponent(collection)}`,
          topics,
        });
  const settingsBtn = canAdminCollection
    ? html`<a class="btn" href="/${encodeURIComponent(collection)}/settings">${icon('sliders')}<span>Settings</span></a>`
    : '';
  const newBtn = viewer
    ? html`<a class="btn" href="/import?collection=${encodeURIComponent(collection)}">${icon(
        'download'
      )}<span>Import or fork</span></a><a class="btn btn-primary" href="/new?collection=${encodeURIComponent(
        collection
      )}">${icon('plus')}<span>New repository</span></a>`
    : '';
  // The prompt to write a profile goes only to a viewer who could administer
  // the collection, and only while there is none: a page with a profile says
  // what it has to say, and the file is edited from the repository holding it.
  const profileBox = profile?.readme
    ? html`<div class="box profile-box" id="profile"><div class="box-header">${icon('book')}<a href="${
        profile.readme.url
      }">${profile.readme.name}</a></div><div class="box-body markdown-body">${raw(profile.readme.html)}</div></div>`
    : profile && canAdminCollection
      ? html`<p class="muted small profile-hint">This collection has no profile README. <a href="${
          profile.addUrl
        }">Add one</a> at <span class="mono">.mochi/profile/README.md</span> to introduce it here.</p>`
      : '';
  // A user's namespace page opens with who they are; a plain collection's
  // with what it is called. The avatar keeps the shape it has everywhere
  // else: round for a person, square for a collection.
  const editProfileBtn = owner?.isViewer
    ? html`<a class="btn" href="/settings/profile">${icon('pencil')}<span>Edit profile</span></a>`
    : '';
  const head = owner
    ? html`<div class="page-head"><h1 class="with-avatar">${avatar(collection, 32)}${
        owner.displayName ?? collection
      }${
        owner.displayName ? html` <span class="profile-username">${collection}</span>` : ''
      }${
        owner.siteAdmin ? html` <span class="counter" title="Administers this vault">Admin</span>` : ''
      }</h1><span class="right-group">${editProfileBtn}${settingsBtn}${newBtn}</span></div>${
        owner.bio ? html`<p class="profile-bio">${owner.bio}</p>` : ''
      }${
        owner.links.length
          ? html`<div class="profile-links">${joinHtml(
              owner.links.map(
                (l) => html`<a href="${l}" rel="nofollow noopener noreferrer">${icon('link')}<span>${l.replace(
                  /^https?:\/\//,
                  ''
                )}</span></a>`
              )
            )}</div>`
          : ''
      }`
    : html`<div class="page-head"><h1 class="with-avatar">${avatar(collection, 28, 'square')}${collection}</h1><span class="right-group">${settingsBtn}${newBtn}</span></div>`;
  const content = html`${head}${profileBox}${body}`;
  return layout(collection, content, {
    crumbs: html` / <a href="/${encodeURIComponent(collection)}">${collection}</a>`,
    viewer,
    path: `/${encodeURIComponent(collection)}`,
  });
}

/**
 * Every topic in use across the vault, as this viewer sees it: the same
 * repositories the front page would list, counted rather than repeated. The
 * page exists so a topic chip has somewhere vault-wide to lead, and so the
 * set of topics can be surveyed without opening repositories to collect it.
 */
export function topicsIndexPage(topics: { topic: string; count: number }[], viewer: Viewer | null): string {
  const body =
    topics.length === 0
      ? html`<div class="empty-state">No repository carries a topic yet.${
          viewer ? ' Add some from a repository’s About panel or settings.' : ''
        }</div>`
      : html`<ul class="topic-index">${joinHtml(
          topics.map(
            (t) =>
              html`<li><a class="chip topic" href="/topics/${encodeURIComponent(t.topic)}">${t.topic}</a><span class="muted small">${
                t.count
              } ${t.count === 1 ? 'repository' : 'repositories'}</span></li>`
          ),
          '\n'
        )}</ul>`;
  const content = html`<div class="page-head"><h1>Topics</h1></div>
<p class="lede">What the repositories in this vault say they are about, across every collection.</p>
${body}`;
  return layout('Topics', content, { viewer, path: '/topics' });
}

/** One topic's page: every visible repository carrying it, vault-wide. */
export function topicPage(topic: string, repos: RepoCard[], sort: 'recent' | 'name', viewer: Viewer | null): string {
  const body =
    repos.length === 0
      ? html`<div class="empty-state">No repository carries this topic. <a href="/topics">All topics</a>.</div>`
      : repoListing(repos, { showCollection: true, sort, sortBase: `/topics/${encodeURIComponent(topic)}` });
  const content = html`<div class="page-head"><h1 class="topic-title">${icon('tag')}${topic}</h1></div>
<p class="lede">${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'} with this topic &middot; <a href="/topics">all topics</a></p>
${body}`;
  return layout(`${topic} - Topics`, content, {
    crumbs: html` / <a href="/topics">topics</a> / <a href="/topics/${encodeURIComponent(topic)}">${topic}</a>`,
    viewer,
    path: `/topics/${encodeURIComponent(topic)}`,
  });
}

export interface TreeView {
  path: string;
  entries: TreeEntry[];
  /** The newest commit touching each entry, keyed by its path from the root. */
  entryCommits: Map<string, CommitSummary>;
  /** The newest commit at this path, for the bar above the listing. */
  latest: CommitSummary | null;
  commitCount: number;
  description: string | null;
  topics: string[];
  readmeHtml: string | null;
  readmeName: string | null;
  /** The language breakdown, measured at the root only and empty elsewhere. */
  languages: LanguageStat[];
  /** Who has committed on this ref, most commits first; the root only. */
  contributors: { name: string; email: string; commits: number; account?: string | null }[];
  /** A one-time note about how the reader got here, e.g. what an upload renamed. */
  msg?: string;
}

/** "1,284" - counts in the interface are grouped, as they are on GitHub. */
function count(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * What the repository is written in: one bar in the languages' own colours and
 * the list that names them. The bar is the same information as the list and no
 * more, so it is hidden from a screen reader rather than repeated to one.
 *
 * The colours are inline because they belong to the languages rather than to
 * the theme (the rule that structural CSS names no colour holds for the rest
 * of style.ts); they come from the table in languages.ts and never from
 * anything a repository contains.
 */
function languagesBlock(languages: LanguageStat[]): Html | '' {
  if (languages.length === 0) return '';
  const pct = (share: number) => `${share.toFixed(1)}%`;
  const segments = languages.map(
    (l) => html`<span class="lang-seg" style="width:${l.share.toFixed(2)}%;background:${l.color}"></span>`
  );
  const items = languages.map(
    (l) =>
      html`<li><span class="lang-dot" style="background:${l.color}"></span><span class="lang-name">${l.name}</span> <span class="lang-pct muted">${pct(l.share)}</span></li>`
  );
  return html`<div class="side-block">
  <h3>Languages</h3>
  <div class="lang-bar" aria-hidden="true">${segments}</div>
  <ul class="lang-list">${items}</ul>
</div>`;
}

/**
 * The About panel beside the repository root: what the repository says it is,
 * and the way in to the documents a reader looks for first.
 */
/** The most faces the panel shows before it counts the rest as a number. */
const SHOWN_CONTRIBUTORS = 12;

/**
 * Who wrote this repository, by commit count, as GitHub lists in its About
 * panel. A face with an account behind it leads to that user's profile page;
 * one without leads to that identity's commits here, which is all the vault
 * knows about them.
 */
function contributorsBlock(
  ctx: RepoCtx,
  people: { name: string; email: string; commits: number; account?: string | null }[]
): Html | '' {
  if (people.length === 0) return '';
  const base = repoUrl(ctx);
  // A contributor with an account gets the account's identicon, so the same
  // person wears the same face here as they do on the admin pages, whatever
  // git author emails their commits carry.
  const faces = people
    .slice(0, SHOWN_CONTRIBUTORS)
    .map(
      (p) =>
        html`<a class="contributor" href="${
          p.account
            ? `/${encodeURIComponent(p.account)}`
            : `${base}/commits/${encPath(ctx.ref)}?author=${encodeURIComponent(p.email || p.name)}`
        }" title="${p.account ?? p.name} - ${count(p.commits)} commit${p.commits === 1 ? '' : 's'}">${avatar(
          p.account ?? (p.email || p.name),
          28
        )}</a>`
    );
  const more =
    people.length > SHOWN_CONTRIBUTORS
      ? html`<span class="muted small">+${count(people.length - SHOWN_CONTRIBUTORS)} more</span>`
      : '';
  return html`<div class="side-block">
  <h3>Contributors <span class="counter">${count(people.length)}</span></h3>
  <div class="contributors">${faces}${more}</div>
</div>`;
}

function aboutPanel(ctx: RepoCtx, view: TreeView): Html {
  const base = repoUrl(ctx);
  const blob = (name: string) => `${base}/blob/${encPath(ctx.ref)}/${encPath(name)}`;
  const license = view.entries.find(
    (e) => e.type === 'blob' && /^(licen[cs]e|copying)(\.[a-z]+)?$/i.test(e.name)
  );
  const links: Html[] = [];
  if (view.readmeName) links.push(html`<a href="#readme">${icon('book')}<span>Readme</span></a>`);
  if (license) links.push(html`<a href="${blob(license.name)}">${icon('law')}<span>${license.name}</span></a>`);
  if (ctx.hasSite) links.push(html`<a href="${ctx.siteUrl}">${icon('globe')}<span>Site</span></a>`);
  if (ctx.releases.length)
    links.push(
      html`<a href="${base}/releases">${icon('rocket')}<span>${count(ctx.releases.length)} release${
        ctx.releases.length === 1 ? '' : 's'
      }</span></a>`
    );
  const settings =
    ctx.canPush || ctx.canAdmin
      ? html`<a class="side-edit" href="${base}/settings" title="Edit repository details" aria-label="Edit repository details">${icon(
          'sliders'
        )}</a>`
      : '';
  const description = view.description
    ? html`<p class="side-desc">${view.description}</p>`
    : html`<p class="side-desc muted">No description provided.</p>`;
  // Topics, and for a writer the place to change them without leaving the
  // page: a details element holding the one-line form, so the editor costs no
  // script and appears only when opened. The form posts the whole set, which
  // is what the API takes too.
  const topicEditor =
    ctx.canPush && ctx.viewer
      ? html`<details class="dropdown topic-edit"><summary class="chip topic-add" title="Edit topics" aria-label="Edit topics">${
          view.topics.length ? icon('pencil') : html`${icon('plus')}<span>Add topics</span>`
        }</summary>
<div class="dropdown-menu dd-right topic-edit-menu"><form method="post" action="${repoUrl(ctx)}/settings/topics">
${csrfField(ctx.viewer)}
<input type="hidden" name="next" value="repo">
<label class="muted small" for="side-topics">Topics, separated by spaces</label>
<input type="text" id="side-topics" name="topics" value="${view.topics.join(' ')}" placeholder="webgpu numbl mri">
<p class="muted small">Lowercase letters, digits, and hyphens.</p>
<button type="submit" class="btn btn-primary">${icon('check')}<span>Save</span></button>
</form></div></details>`
      : '';
  const topicsRow =
    view.topics.length || topicEditor
      ? html`<div class="side-topics">${topicChips(view.topics)}${topicEditor}</div>`
      : '';
  const facts = [
    html`<a href="${base}/commits/${encPath(ctx.ref)}">${icon('history')}<span>${count(view.commitCount)} commit${
      view.commitCount === 1 ? '' : 's'
    }</span></a>`,
    html`<a href="${base}/branches">${icon('git-branch')}<span>${count(ctx.branches.length)} branch${
      ctx.branches.length === 1 ? '' : 'es'
    }</span></a>`,
    html`<a href="${base}/tags">${icon('tag')}<span>${count(ctx.tags.length)} tag${ctx.tags.length === 1 ? '' : 's'}</span></a>`,
  ];
  // The documents a reader looks for and the counts they navigate by are both
  // facts about the repository, so they sit in the one About block rather than
  // under a second rule with no caption on it. A hairline keeps them apart.
  return html`<aside class="repo-side">
<div class="side-block">
  <h3>About${settings}</h3>
  ${description}
  ${topicsRow}
  ${links.length ? html`<div class="side-links">${links}</div><hr class="rule">` : ''}
  <div class="side-links">${facts}</div>
</div>
${contributorsBlock(ctx, view.contributors)}
${languagesBlock(view.languages)}
</aside>`;
}

export function treePage(ctx: RepoCtx, view: TreeView): string {
  const base = repoUrl(ctx);
  const { path, entries } = view;
  const refBase = `${base}/tree/${encPath(ctx.ref)}`;
  const atRoot = path === '';
  const rows: Html[] = [];
  if (!atRoot) {
    const parent = path.split('/').slice(0, -1).join('/');
    const up = parent === '' ? refBase : `${refBase}/${encPath(parent)}`;
    rows.push(html`<tr><td class="tree-name"><a href="${up}" aria-label="Parent directory">..</a></td><td></td><td></td></tr>`);
  }
  for (const e of entries) {
    const childPath = atRoot ? e.name : `${path}/${e.name}`;
    let name: Html;
    if (e.type === 'tree') {
      name = html`${FOLDER_ICON}<a href="${refBase}/${encPath(childPath)}">${e.name}</a>`;
    } else if (e.type === 'blob') {
      name = html`${fileIcon(e.name)}<a href="${base}/blob/${encPath(ctx.ref)}/${encPath(childPath)}">${e.name}</a>`;
    } else {
      name = html`${FOLDER_ICON}<span>${e.name}</span> <span class="muted small mono">@ ${e.sha.slice(0, 7)}</span>`;
    }
    // The message and age columns are what a directory listing on GitHub
    // shows, and they answer the question a listing is usually asked: what
    // changed here lately.
    const commit = view.entryCommits.get(childPath);
    const message = commit
      ? html`<a href="${base}/commit/${commit.sha}" title="${commit.subject}">${commit.subject}</a>`
      : '';
    rows.push(
      html`<tr><td class="tree-name">${name}</td><td class="tree-message muted small">${message}</td><td class="tree-age right small">${
        commit ? timeTag(commit.date) : ''
      }</td></tr>`
    );
  }
  const latest = view.latest;
  const latestBar = latest
    ? html`<div class="latest-commit">
  <span class="lc-main">${gitAuthor(ctx, latest.author, latest.email, { bold: true })} <a href="${base}/commit/${latest.sha}">${latest.subject}</a></span>
  <span class="lc-meta"><a class="sha" href="${base}/commit/${latest.sha}">${latest.sha.slice(
        0,
        7
      )}</a> ${timeTag(latest.date)} <a class="lc-history" href="${base}/commits/${encPath(ctx.ref)}">${icon(
        'history'
      )}<b>${count(view.commitCount)}</b> <span>Commits</span></a></span>
</div>`
    : '';
  const addFileUrl = `${base}/new/${encPath(ctx.ref)}${atRoot ? '' : `/${encPath(path)}`}`;
  // The history of this directory, which at the root is the history of the
  // repository: the same button GitHub puts above a listing.
  const historyBtn = html`<a class="btn" href="${base}/commits/${encPath(ctx.ref)}${
    atRoot ? '' : `/${encPath(path)}`
  }" title="Commits touching this directory">${icon('history')}<span>History</span></a>`;
  // Forking is offered to anyone who can sign in; where the copy may go is
  // settled on the form, where the answer can be explained.
  const forkBtn = atRoot
    ? html`<a class="btn" href="${
        ctx.viewer ? `${base}/fork` : `/login?next=${encodeURIComponent(`${base}/fork`)}`
      }" title="Copy this repository elsewhere in the vault">${icon('repo-forked')}<span>Fork</span></a>`
    : '';
  // GitHub's "Add file" is a menu of two: write one here, or upload some.
  const uploadUrl = `${base}/upload/${encPath(ctx.ref)}${atRoot ? '' : `/${encPath(path)}`}`;
  const addFileBtn =
    ctx.canPush && ctx.refIsBranch
      ? html`<details class="dropdown">
<summary class="btn">${icon('plus')}<span>Add file</span>${icon('chevron-down', 'caret')}</summary>
<div class="dropdown-menu dd-right">
<a class="dd-item" href="${addFileUrl}">${icon('file')}<span class="dd-label">Create new file</span></a>
<a class="dd-item" href="${uploadUrl}">${icon('upload')}<span class="dd-label">Upload files</span></a>
</div>
</details>`
      : '';
  const readmePath = atRoot ? view.readmeName : `${path}/${view.readmeName}`;
  const readme = view.readmeHtml
    ? html`<div class="box" id="readme"><div class="box-header">${icon('book')}<a href="${base}/blob/${encPath(
        ctx.ref
      )}/${encPath(readmePath ?? 'README')}">${view.readmeName ?? 'README'}</a></div><div class="box-body markdown-body">${raw(
        view.readmeHtml
      )}</div></div>`
    : '';
  const content = html`${repoHeader(ctx, 'code')}
${view.msg ? html`<div class="flash">${view.msg}</div>` : ''}
<div class="toolbar">
  <div class="left">${refPicker(ctx, (ref) => `${base}/tree/${encPath(ref)}`)}${breadcrumb(ctx, path)}</div>
  <div class="right-group">${findButton(ctx)}${historyBtn}${forkBtn}${addFileBtn}${cloneMenu(ctx)}</div>
</div>
<div class="repo-layout">
<div class="repo-main">
${latestBar}
<table class="listing tree"><tbody>${rows}</tbody></table>
${readme}
</div>
${atRoot ? aboutPanel(ctx, view) : ''}
</div>`;
  return layout(
    `${ctx.collection}/${ctx.repo}${path ? ` at ${path}` : ''}`,
    content,
    repoOpts(ctx, atRoot ? repoUrl(ctx) : `${refBase}/${encPath(path)}`)
  );
}

/**
 * The file finder. The whole path list is in the page and the filter runs in
 * the browser, so it answers a keystroke without a request; what it costs is
 * a page proportional to the tree, which is why the caller caps the list.
 *
 * Matching is subsequence matching, as GitHub's is: "srcmn" finds
 * src/compute/mean.py. Enter opens the first match, which is what makes this
 * a way of navigating rather than a list to read.
 */
export interface SearchView {
  files: { path: string; hits: { line: number; text: string }[]; more: number }[];
  total: number;
  /** git stopped early: there are more matches than the cap allows. */
  truncated: boolean;
  /** Files beyond the ones grouped onto the page. */
  capped: boolean;
}

/**
 * Show one matching line with the query marked in it. The positions come from
 * the raw text, so the slices around them are escaped individually rather
 * than searching escaped HTML for something that may no longer look the same.
 * A long line is cut around its first match: a result list is for finding the
 * file, not for reading it.
 */
function markMatches(text: string, query: string): Html {
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  let from = needle === '' ? -1 : hay.indexOf(needle);
  const first = from;
  const WINDOW = 240;
  let start = 0;
  let cut = text;
  if (text.length > WINDOW && first > WINDOW / 2) {
    start = first - Math.floor(WINDOW / 3);
    cut = text.slice(start);
  }
  if (cut.length > WINDOW) cut = cut.slice(0, WINDOW);
  const body = cut.toLowerCase();
  let out = '';
  let at = 0;
  for (let i = needle === '' ? -1 : body.indexOf(needle); i !== -1; i = body.indexOf(needle, at)) {
    out += esc(cut.slice(at, i)) + `<mark>${esc(cut.slice(i, i + needle.length))}</mark>`;
    at = i + needle.length;
  }
  out += esc(cut.slice(at));
  // Escaped by hand above, around positions found in the raw text; the whole
  // is therefore already HTML.
  return raw(`${start > 0 ? '&hellip;' : ''}${out}${start + cut.length < text.length ? '&hellip;' : ''}`);
}

/** Search results: the matching lines, grouped by the file they are in. */
export function searchPage(ctx: RepoCtx, query: string, view: SearchView): string {
  const base = repoUrl(ctx);
  const searchUrl = (ref: string) => `${base}/search?q=${encodeURIComponent(query)}&ref=${encodeURIComponent(ref)}`;
  const form = html`<form class="search-form" method="get" action="${base}/search" role="search"><input type="hidden" name="ref" value="${ctx.ref}"><input class="search-input" type="search" name="q" value="${query}" placeholder="Search this repository" aria-label="Search this repository" autofocus>${icon(
    'search',
    'search-glyph'
  )}</form>`;
  const boxes = view.files.map((f) => {
    const fileUrl = `${base}/blob/${encPath(ctx.ref)}/${encPath(f.path)}`;
    const lines = f.hits.map(
      (h) =>
        html`<a class="search-hit" href="${fileUrl}#L${h.line}"><span class="lnum">${h.line}</span><span class="ltext">${markMatches(
          h.text,
          query
        )}</span></a>`
    );
    const more = f.more
      ? html`<a class="search-more" href="${fileUrl}">${count(f.more)} more match${
          f.more === 1 ? '' : 'es'
        } in this file</a>`
      : '';
    return html`<div class="box search-file"><div class="box-header">${FILE_ICON}<a href="${fileUrl}">${f.path}</a></div><div class="search-hits">${lines}${more}</div></div>`;
  });
  const notes: string[] = [];
  if (view.truncated) notes.push('There were more matches than this page can show.');
  if (view.capped) notes.push('Matches in further files were left out.');
  let body: Html;
  if (query.trim() === '') {
    body = html`<div class="empty-state">Type to search the files at ${ctx.ref}. Matching is literal text, not a pattern.</div>`;
  } else if (view.files.length === 0) {
    body = html`<div class="empty-state">No file at ${ctx.ref} contains ${query}.</div>`;
  } else {
    body = html`<p class="muted small">${count(view.total)} matching line${view.total === 1 ? '' : 's'} in ${count(
      view.files.length
    )} file${view.files.length === 1 ? '' : 's'}${notes.length ? html` &middot; ${notes.join(' ')}` : ''}</p>${boxes}`;
  }
  const content = html`${repoHeader(ctx, 'code')}
<div class="toolbar">
  <div class="left">${refPicker(ctx, searchUrl)}${form}</div>
  <div class="right-group">${findButton(ctx)}</div>
</div>
${body}`;
  return layout(
    `${query ? `Search: ${query}` : 'Search'} - ${ctx.collection}/${ctx.repo}`,
    content,
    repoOpts(ctx, `${base}/search`)
  );
}

export function findFilePage(ctx: RepoCtx, paths: string[], total: number): string {
  const base = repoUrl(ctx);
  const items = paths.map((p) => {
    const cut = p.lastIndexOf('/');
    const dir = cut === -1 ? '' : html`<span class="muted">${p.slice(0, cut + 1)}</span>`;
    return html`<a class="find-item" href="${base}/blob/${encPath(ctx.ref)}/${encPath(p)}">${fileIcon(p)}<span>${dir}${p.slice(
      cut + 1
    )}</span></a>`;
  });
  const capped =
    total > paths.length
      ? html`<p class="muted small">Showing the first ${count(paths.length)} of ${count(total)} files.</p>`
      : '';
  const content = html`${repoHeader(ctx, 'code')}
<div class="toolbar">
  <div class="left">${refPicker(ctx, (ref) => `${base}/find/${encPath(ref)}`)}<span class="muted small">${count(
    total
  )} file${total === 1 ? '' : 's'}</span></div>
</div>
<input class="find-input" type="text" placeholder="Go to file" autofocus autocomplete="off" spellcheck="false" aria-label="Go to file">
${capped}
<div class="find-list" id="find-list">${items}</div>
<div class="empty-state" id="find-empty" hidden>No file matches.</div>`;
  return layout(
    `Find a file - ${ctx.collection}/${ctx.repo}`,
    content,
    repoOpts(ctx, `${base}/find/${encPath(ctx.ref)}`)
  );
}

export function blobPage(
  ctx: RepoCtx,
  path: string,
  view:
    | { kind: 'code'; html: string; lineCount: number; size: number; editable: boolean }
    | { kind: 'markdown'; html: string; size: number; editable: boolean }
    | { kind: 'image'; rawUrl: string; size: number }
    | { kind: 'binary'; rawUrl: string; size: number }
    | { kind: 'too-large'; rawUrl: string; size: number }
    | { kind: 'lfs'; rawUrl: string; size: number; oid: string }
    | { kind: 'age'; rawUrl: string; size: number; editable: boolean; markdownInner: boolean },
  isMarkdown = false
): string {
  const base = repoUrl(ctx);
  const blobUrl = `${base}/blob/${encPath(ctx.ref)}/${encPath(path)}`;
  const rawUrl = `${base}/raw/${encPath(ctx.ref)}/${encPath(path)}`;
  const editable = (view.kind === 'code' || view.kind === 'markdown' || view.kind === 'age') && view.editable;
  const editBtns = editable
    ? html`<a class="btn" href="${base}/edit/${encPath(ctx.ref)}/${encPath(path)}" title="Edit this file">${icon(
        'pencil'
      )}<span>Edit</span></a><a class="btn btn-danger-outline" href="${base}/delete/${encPath(ctx.ref)}/${encPath(
        path
      )}" title="Delete this file">${icon('trash')}<span>Delete</span></a>`
    : '';
  // GitHub spells the source view of a rendered file ?plain=1; we follow that.
  const seg = (label: string, glyph: IconName, href: string, current: boolean) =>
    html`<a${current ? raw(' class="current"') : ''} href="${href}">${icon(glyph)}<span>${label}</span></a>`;
  const toggle = isMarkdown
    ? html`<span class="seg">${seg('Preview', 'book', blobUrl, view.kind === 'markdown')}${seg(
        'Code',
        'code',
        `${blobUrl}?plain=1`,
        view.kind !== 'markdown'
      )}</span>`
    : '';
  let body: Html;
  const historyBtn = html`<a class="btn" href="${base}/commits/${encPath(ctx.ref)}/${encPath(
    path
  )}" title="Commits touching this file">${icon('history')}<span>History</span></a>`;
  // Blame is for anything we render as text, which includes a markdown file
  // being shown as a document rather than as source.
  const blameBtn =
    view.kind === 'code' || view.kind === 'markdown'
      ? html`<a class="btn" href="${base}/blame/${encPath(ctx.ref)}/${encPath(
          path
        )}" title="Who last changed each line">${icon('versions')}<span>Blame</span></a>`
      : '';
  const meta = (left: Html | string, extra: Html | '' = '') =>
    html`<div class="code-meta"><span class="muted small">${left}</span><span class="right-group">${toggle}${extra}${blameBtn}${historyBtn}<a class="btn" href="${rawUrl}" title="View the file as it was committed">${icon(
      'download'
    )}<span>Raw</span></a>${editBtns}</span></div>`;
  if (view.kind === 'code') {
    // One element per line, each an anchor: linking to a line is how people
    // point at code, and #L12 is the address GitHub taught them to expect.
    // The line text is highlight.js output, already escaped by its renderer.
    const rows = highlightedLines(view.html).map((line, i) => {
      const n = i + 1;
      return html`<div class="cline" id="L${n}"><a class="lnum" href="#L${n}" aria-label="Line ${n}">${n}</a><span class="ltext">${raw(line)}</span></div>`;
    });
    const copyRaw = html`<button class="btn" type="button" data-copy-lines title="Copy the file's contents"><span class="copy-idle">${icon(
      'copy'
    )}<span>Copy</span></span><span class="copy-done">${icon('check')}<span>Copied</span></span></button>`;
    body = html`${meta(html`${view.lineCount} line${view.lineCount === 1 ? '' : 's'} &middot; ${formatSize(view.size)}`, copyRaw)}
<div class="code-lines">${rows}</div>`;
  } else if (view.kind === 'markdown') {
    body = html`${meta(formatSize(view.size))}
<div class="rendered markdown-body">${raw(view.html)}</div>`;
  } else if (view.kind === 'image') {
    body = html`${meta(formatSize(view.size))}<div class="blob-image"><img src="${rawUrl}" alt="${path}"></div>`;
  } else if (view.kind === 'too-large') {
    body = html`${meta(formatSize(view.size))}<div class="blob-binary">File is too large to display. <a href="${rawUrl}">View raw</a></div>`;
  } else if (view.kind === 'lfs') {
    // The size comes from the pointer, so no storage request is needed to
    // render this card.
    body = html`${meta(formatSize(view.size))}<div class="blob-binary">
<p><b>Stored with Git LFS</b></p>
<p>This file is ${formatSize(view.size)}; the repository holds a pointer to it.</p>
<p class="muted small mono">sha256:${view.oid}</p>
<p><a class="btn btn-primary" href="${rawUrl}">${icon('download')}<span>Download</span></a></p>
</div>`;
  } else if (view.kind === 'age') {
    // The card is inert markup; /assets/age.js (loaded by this page alone)
    // wires the form, fetches the ciphertext from the raw URL, and decrypts
    // in the page. The passphrase inputs never carry a name, so no form
    // mishap can post one. On unlock the card gives way to a slim bar over
    // the output: what happened, a copy of the exact plaintext, and the lock
    // that puts the card back.
    body = html`${meta(formatSize(view.size))}
<div class="age-box" data-age-view data-age-raw="${rawUrl}" data-age-inner="${view.markdownInner ? 'markdown' : 'text'}">
<div class="blob-binary age-card">
<p class="age-head">${icon('lock')}<b>Encrypted with age</b></p>
<p class="muted small">The vault stores this file as ciphertext it cannot read. The passphrase decrypts it here, in this page, and is sent nowhere.</p>
<form class="age-unlock">${agePassInput({ placeholder: 'Passphrase', autocomplete: 'off', required: true })}<button type="submit" class="btn btn-primary" data-busy-label="Decrypting&hellip;">Decrypt</button></form>
<p class="age-error form-error" hidden></p>
<noscript><p class="muted small">Decrypting in the browser needs JavaScript. Without it, take the raw file and the age CLI.</p></noscript>
</div>
<div class="age-bar" data-age-bar hidden>
<span class="age-bar-note">${icon('lock')}<span>Decrypted in your browser; the vault still holds only the ciphertext.</span></span>
<span class="age-bar-actions"><button type="button" class="btn" data-age-copy title="Copy the decrypted text"><span class="copy-idle">${icon(
      'copy'
    )}<span>Copy</span></span><span class="copy-done">${icon('check')}<span>Copied</span></span></button><button type="button" class="btn" data-age-lock title="Clear the plaintext from the page">${icon(
      'lock'
    )}<span>Lock</span></button></span>
</div>
<div class="age-output" hidden></div>
</div>`;
  } else {
    body = html`${meta(formatSize(view.size))}<div class="blob-binary">Binary file. <a href="${rawUrl}">View raw</a></div>`;
  }
  const content = html`${repoHeader(ctx, 'code')}
<div class="toolbar">
  <div class="left">${refPicker(ctx, (ref) => `${base}/blob/${encPath(ref)}/${encPath(path)}`)}${breadcrumb(ctx, path)}</div>
</div>
${body}`;
  const opts = view.kind === 'age' ? { ...repoOpts(ctx, blobUrl), ageScript: true } : repoOpts(ctx, blobUrl);
  return layout(`${path} at ${ctx.ref} - ${ctx.collection}/${ctx.repo}`, content, opts);
}

/**
 * The blame view: every line of a file beside the commit that last touched
 * it, with consecutive lines from the same commit forming a block, as on
 * GitHub. A block that has a previous revision also offers the blame as it
 * stood before that change, which is how a reader walks a line backwards
 * through history.
 */
export function blamePage(ctx: RepoCtx, path: string, highlighted: string, lines: BlameLine[], size: number): string {
  const base = repoUrl(ctx);
  const blobUrl = `${base}/blob/${encPath(ctx.ref)}/${encPath(path)}`;
  const texts = highlightedLines(highlighted);
  const rows = lines.map((l, i) => {
    const n = i + 1;
    const starts = i === 0 || lines[i - 1].sha !== l.sha;
    const prior =
      starts && l.previous
        ? html`<a class="blame-prior" href="${base}/blame/${encPath(l.previous.sha)}/${encPath(
            l.previous.path
          )}" title="Blame this file before this change" aria-label="Blame this file before this change">${icon(
            'versions'
          )}</a>`
        : '';
    const about = starts
      ? html`<a class="sha" href="${base}/commit/${l.sha}">${l.sha.slice(0, 7)}</a><a class="blame-subject" href="${base}/commit/${
          l.sha
        }" title="${l.summary}">${l.summary}</a><span class="blame-when small muted">${gitAuthor(
          ctx,
          l.author,
          l.email
        )} ${timeTag(l.date)}</span>${prior}`
      : '';
    return html`<div class="blame-row${starts ? ' blame-start' : ''}" id="L${n}"><span class="blame-commit">${about}</span><a class="lnum" href="#L${n}" aria-label="Line ${n}">${n}</a><span class="ltext">${raw(
      texts[i] ?? ''
    )}</span></div>`;
  });
  const toggle = html`<span class="seg"><a href="${blobUrl}">Code</a><a class="current" href="${base}/blame/${encPath(
    ctx.ref
  )}/${encPath(path)}">Blame</a></span>`;
  const content = html`${repoHeader(ctx, 'code')}
<div class="toolbar">
  <div class="left">${refPicker(ctx, (ref) => `${base}/blame/${encPath(ref)}/${encPath(path)}`)}${breadcrumb(ctx, path)}</div>
</div>
<div class="code-meta"><span class="muted small">${lines.length} line${lines.length === 1 ? '' : 's'} &middot; ${formatSize(
    size
  )}</span><span class="right-group">${toggle}<a class="btn" href="${base}/commits/${encPath(ctx.ref)}/${encPath(
    path
  )}" title="Commits touching this file">${icon('history')}<span>History</span></a></span></div>
<div class="blame">${rows}</div>`;
  return layout(
    `Blame ${path} at ${ctx.ref} - ${ctx.collection}/${ctx.repo}`,
    content,
    repoOpts(ctx, `${base}/blame/${encPath(ctx.ref)}/${encPath(path)}`)
  );
}

export function commitsPage(
  ctx: RepoCtx,
  path: string,
  commits: CommitSummary[],
  page: number,
  totalPages: number,
  totalCount: number,
  author?: string
): string {
  const base = repoUrl(ctx);
  const suffix = path === '' ? '' : `/${encPath(path)}`;
  const query = author ? `?author=${encodeURIComponent(author)}` : '';
  // Each row carries what a reader might want next from that commit: to read
  // it, to take its id, or to browse the tree as it stood then.
  const row = (c: CommitSummary) =>
    html`<div class="commit-row"><span class="commit-main">${avatar(
      (c.email && ctx.accountFor?.(c.email)) || c.email || c.author,
      20
    )}<span><a class="title" href="${base}/commit/${
      c.sha
    }">${c.subject}</a><div class="muted small">${gitAuthor(ctx, c.author, c.email)} committed ${timeTag(
      c.date
    )}</div></span></span><span class="commit-actions"><a class="sha" href="${base}/commit/${c.sha}">${c.sha.slice(
      0,
      7
    )}</a>${copyButton('', c.sha, 'Copy the full commit id')}<a class="btn" href="${base}/tree/${
      c.sha
    }" title="Browse the repository at this commit" aria-label="Browse the repository at this commit">${icon(
      'code'
    )}</a></span></div>`;
  // Commits are grouped under the day they landed, as on GitHub: a history
  // reads as a sequence of days, and the dates stop repeating on every row.
  const groups: { day: string; rows: Html[] }[] = [];
  for (const c of commits) {
    const day = formatDay(c.date);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(row(c));
    else groups.push({ day, rows: [row(c)] });
  }
  const rows = groups.map(
    (g) =>
      html`<div class="commit-day">${icon('git-commit')}<span>Commits on ${g.day}</span></div><div class="commit-group">${g.rows}</div>`
  );
  const pager: Html[] = [];
  const pageUrl = (p: number) =>
    `${base}/commits/${encPath(ctx.ref)}${suffix}?page=${p}${
      author ? `&author=${encodeURIComponent(author)}` : ''
    }`;
  if (page > 1) pager.push(html`<a class="btn" href="${raw(pageUrl(page - 1))}">&larr; Newer</a>`);
  if (page < totalPages) pager.push(html`<a class="btn" href="${raw(pageUrl(page + 1))}">Older &rarr;</a>`);
  const scope =
    path === ''
      ? html`<span class="muted small">${count(totalCount)} commit${totalCount === 1 ? '' : 's'}</span>`
      : html`${breadcrumb(ctx, path)}<span class="muted small">${count(totalCount)} commit${
          totalCount === 1 ? '' : 's'
        } touching this path</span>`;
  const empty = author
    ? html`No commits here are by ${author}.`
    : path === ''
      ? html`No commits on this ref.`
      : html`Nothing in this ref's history touches ${path}.`;
  // A filter the reader can see is a filter they can take off again.
  const byAuthor = author
    ? html`<span class="filter-chip">${icon('person')}<span>${author}</span><a href="${base}/commits/${encPath(
        ctx.ref
      )}${suffix}" title="Show every author" aria-label="Show every author">${icon('x')}</a></span>`
    : '';
  const feed = html`<a class="btn" href="${base}/commits/${encPath(ctx.ref)}${suffix}.atom" title="Atom feed of this history">${icon(
    'rss'
  )}<span>Feed</span></a>`;
  const content = html`${repoHeader(ctx, 'commits')}
<div class="toolbar"><div class="left">${refPicker(
    ctx,
    (ref) => `${base}/commits/${encPath(ref)}${suffix}${query}`
  )}${byAuthor}${scope}</div><div class="right-group">${feed}</div></div>
${rows.length ? rows : html`<div class="empty-state">${empty}</div>`}
${pager.length ? html`<div class="pagination">${pager}</div>` : ''}`;
  return layout(
    `Commits${path ? ` for ${path}` : ''} at ${ctx.ref} - ${ctx.collection}/${ctx.repo}`,
    content,
    repoOpts(ctx, `${base}/commits/${encPath(ctx.ref)}${suffix}`)
  );
}

export function commitPage(ctx: RepoCtx, detail: CommitDetail, diffHtml: string): string {
  const base = repoUrl(ctx);
  const lines = detail.message.split('\n');
  const subject = lines[0] ?? '';
  const body = lines.slice(1).join('\n').trim();
  const parents = joinHtml(
    detail.parents.map((p) => html`<a class="sha" href="${base}/commit/${p}">${p.slice(0, 7)}</a>`),
    ' '
  );
  const content = html`${repoHeader(ctx, 'commits')}
<div class="commit-head">
  <div class="subject">${subject}</div>
  ${body ? html`<div class="body">${body}</div>` : ''}
  <div class="meta">
    <span>${gitAuthor(ctx, detail.author, detail.email, { bold: true })} &lt;${detail.email}&gt;</span>
    <span>committed ${timeTag(detail.date, '')}</span>
    <span>commit <span class="sha">${detail.sha.slice(0, 12)}</span></span>
    ${detail.parents.length ? html`<span>parent${detail.parents.length > 1 ? 's' : ''} ${parents}</span>` : ''}
    <span><a href="${base}/tree/${detail.sha}">Browse files</a></span>
  </div>
</div>
${raw(diffHtml)}`;
  return layout(`${subject} - ${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, `${base}/commit/${detail.sha}`));
}

export function refListPage(ctx: RepoCtx, kind: 'branches' | 'tags'): string {
  const base = repoUrl(ctx);
  const refs = kind === 'branches' ? ctx.branches : ctx.tags;
  const viewer = ctx.viewer;
  const noun = kind === 'branches' ? 'branch' : 'tag';
  const listId = `${kind}-list`;
  const rows = refs.map((r) => {
    let action: Html | '' = '';
    if (ctx.canPush && viewer && (kind === 'tags' || r.name !== ctx.defaultBranch)) {
      action = html`<form method="post" action="${base}/${kind}/delete" data-confirm="Delete ${noun} ${r.name}?">${csrfField(
        viewer
      )}<input type="hidden" name="name" value="${r.name}"><button type="submit" class="btn btn-danger-outline" title="Delete this ${noun}" aria-label="Delete ${r.name}">${icon(
        'trash'
      )}</button></form>`;
    }
    // A tag is what people download a release from, so its row carries the
    // archives, as the tags page on GitHub does.
    const archives =
      kind === 'tags'
        ? html`<a class="btn" href="${base}/archive/${encPath(r.name)}.zip" title="Download this tag as a zip">${icon(
            'file-zip'
          )}<span>zip</span></a><a class="btn" href="${base}/archive/${encPath(
            r.name
          )}.tar.gz" title="Download this tag as a tar.gz">${icon('file-zip')}<span>tar.gz</span></a>`
        : '';
    const badge =
      kind === 'branches' && r.name === ctx.defaultBranch ? html` <span class="badge">Default</span>` : '';
    // A tag with notes leads to them; one without invites whoever may push
    // to write them, which is the only way a release is ever created.
    const release =
      kind === 'tags'
        ? ctx.releases.includes(r.name)
          ? html`<a class="btn" href="${base}/releases/tag/${encPath(r.name)}" title="Release notes for ${r.name}">${icon(
              'rocket'
            )}<span>Release</span></a>`
          : ctx.canPush
            ? html`<a class="btn" href="${base}/releases/new?tag=${encodeURIComponent(
                r.name
              )}" title="Write release notes for ${r.name}">${icon('rocket')}<span>Draft release</span></a>`
            : ''
        : '';
    // Every ref but the default one can be compared against it, which is
    // the question a list of branches invites: what is on this one?
    const compare =
      ctx.defaultBranch && r.name !== ctx.defaultBranch
        ? html`<a class="btn" href="${base}/compare/${encPath(ctx.defaultBranch)}...${encPath(
            r.name
          )}" title="Compare with ${ctx.defaultBranch}">${icon('git-compare')}<span>Compare</span></a>`
        : '';
    return html`<tr>
<td class="ref-name">${icon(kind === 'branches' ? 'git-branch' : 'tag', 'icon')}<a href="${base}/tree/${encPath(
      r.name
    )}"><b>${r.name}</b></a>${badge}
<div class="muted small">Updated ${timeTag(r.date)} &middot; ${r.subject}</div></td>
<td class="right"><a class="sha" href="${base}/commit/${r.sha}">${r.sha.slice(0, 7)}</a></td>
<td class="right"><span class="right-group">${release}${compare}${archives}${action}</span></td>
</tr>`;
  });
  const body = rows.length
    ? html`${listFilter(listId, `Find a ${noun}`, refs.length)}<table class="listing" id="${listId}"><tbody>${rows}</tbody></table>${noMatches(
        listId
      )}`
    : html`<div class="empty-state">No ${kind} yet.</div>`;
  let createMenu: Html | '' = '';
  if (ctx.canPush && viewer && ctx.branches.length > 0) {
    const fromOptions = ctx.branches.map(
      (b) =>
        html`<option value="${b.name}"${b.name === ctx.defaultBranch ? raw(' selected') : ''}>${b.name}</option>`
    );
    const form =
      kind === 'branches'
        ? html`<form method="post" action="${base}/branches/create">${csrfField(viewer)}
<div class="field"><label for="new-ref">New branch name</label><input type="text" id="new-ref" name="name" placeholder="new-branch-name" required></div>
<div class="field"><label for="ref-from">From</label><select id="ref-from" name="from">${fromOptions}</select></div>
<button type="submit" class="btn btn-primary">Create branch</button></form>`
        : html`<form method="post" action="${base}/tags/create">${csrfField(viewer)}
<div class="field"><label for="new-ref">Tag name</label><input type="text" id="new-ref" name="name" placeholder="v1.0.0" required></div>
<div class="field"><label for="ref-at">At</label><select id="ref-at" name="at">${fromOptions}</select></div>
<button type="submit" class="btn btn-primary">Create tag</button></form>`;
    createMenu = html`<details class="dropdown">
<summary class="btn btn-primary">${icon('plus')}<span>New ${noun}</span>${icon('chevron-down', 'caret')}</summary>
<div class="dropdown-menu dd-right ref-form">${form}</div>
</details>`;
  }
  const content = html`${repoHeader(ctx, kind)}<div class="page-head"><h2>${
    kind === 'branches' ? 'Branches' : 'Tags'
  }</h2>${createMenu}</div>${body}`;
  return layout(`${kind} - ${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, `${base}/${kind}`));
}

/**
 * The quick-setup page GitHub shows for a repository with no commits: the
 * address to push to, and the two command sequences that are the usual next
 * step. It is the one place in the interface that teaches git commands,
 * because it is the one place where the answer really is a command.
 */
export function emptyRepoPage(ctx: RepoCtx): string {
  const base = repoUrl(ctx);
  const url = ctx.cloneUrl;
  const block = (lines: string[]) =>
    html`<div class="cmd-block"><pre>${lines.join('\n')}</pre>${copyButton()}</div>`;
  const readmeBtn = ctx.canPush
    ? html`<a class="btn btn-primary" href="${base}/new/main">${icon('plus')}<span>Create a README</span></a>`
    : '';
  const content = html`${repoHeader(ctx, 'code')}
<div class="box">
  <div class="box-header">${icon('repo')}Quick setup, if you have done this before</div>
  <div class="box-body">
    <div class="cmd-row"><code>${url}</code>${copyButton()}</div>
    <p class="muted">Cloning is anonymous. Pushing asks for your username and a token; <span class="mono">mochi login</span> hands the token to git once so it stops asking.</p>
    ${readmeBtn}
  </div>
</div>
<h3 class="setup-head">&hellip;or create a new repository on the command line</h3>
${block([
  `echo "# ${ctx.repo}" >> README.md`,
  'git init',
  'git add README.md',
  'git commit -m "first commit"',
  'git branch -M main',
  `git remote add origin ${url}`,
  'git push -u origin main',
])}
<h3 class="setup-head">&hellip;or push an existing repository from the command line</h3>
${block([`git remote add origin ${url}`, 'git branch -M main', 'git push -u origin main'])}`;
  return layout(`${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, base));
}

export function errorPage(status: number, message: string, opts: PageOpts & { backUrl?: string } = {}): string {
  const back = opts.backUrl
    ? html`<p><a href="${opts.backUrl}">Go back</a></p>`
    : html`<p><a href="/">Back to home</a></p>`;
  return layout(
    `${status}`,
    html`<div class="error-page"><div class="code">${status}</div><p>${message}</p>${back}</div>`,
    opts
  );
}
