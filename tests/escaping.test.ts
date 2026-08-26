import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as forms from '../src/forms';
import type { Viewer } from '../src/session';
import type { RepoCtx, TreeView } from '../src/views';
import * as views from '../src/views';

// The pages, driven with hostile input.
//
// Every page here is built from the html`` tag, which escapes what it
// interpolates; these tests are what keeps that true as pages are edited.
// Rather than inspecting the templates, each case puts a script tag where a
// repository, a branch, a description, or a username goes and asserts that
// nothing executable comes out the other end.

/** A payload that is inert escaped and executable if it is not. */
const XSS = '<script>alert(1)</script>';
/** One that breaks out of an attribute instead of a text node. */
const ATTR = '" onmouseover="alert(1)';

function assertSafe(page: string, what: string): void {
  assert.ok(!page.includes('<script>alert(1)'), `${what}: a script tag survived escaping`);
  assert.ok(!page.includes('onmouseover="alert(1)'), `${what}: an event handler survived escaping`);
  // The payload has to actually reach the page, or the test proves nothing.
  assert.ok(page.includes('&lt;script&gt;') || page.includes('&quot;'), `${what}: the payload never reached the page`);
}

const viewer: Viewer = {
  auth: {
    username: 'someone',
    user: { tokens: [{ hash: 'aa' }], scope: ['*'], admin: ['*'] },
    token: { hash: 'aa', id: 'abcd1234' },
  },
  csrf: 'csrf-value',
};

function ctxFor(overrides: Partial<RepoCtx> = {}): RepoCtx {
  return {
    collection: 'demo',
    repo: 'proj',
    ref: 'main',
    refIsBranch: true,
    defaultBranch: 'main',
    branches: [{ name: 'main', sha: 'a'.repeat(40), date: '', subject: '' }],
    tags: [],
    cloneUrl: 'http://vault.example/demo/proj',
    hasSite: false,
    siteUrl: '',
    hasCi: false,
    releases: [],
    openIssues: 0,
    openPulls: 0,
    forkedFrom: null,
    upstream: null,
    viewer,
    isPrivate: false,
    canPush: true,
    canAdmin: true,
    ...overrides,
  };
}

function treeView(overrides: Partial<TreeView> = {}): TreeView {
  return {
    path: '',
    entries: [],
    entryCommits: new Map(),
    latest: null,
    commitCount: 0,
    description: null,
    topics: [],
    readmeHtml: null,
    readmeName: null,
    languages: [],
    contributors: [],
    ...overrides,
  };
}

test('a repository name and description are escaped in a listing', () => {
  const page = views.homePage(
    '/srv/vault',
    [{ name: XSS, repoCount: 1 }],
    [{ collection: 'demo', name: XSS, description: XSS, updated: null }],
    'recent',
    viewer
  );
  assertSafe(page, 'homePage');
});

test('a collection name is escaped in its own page and its breadcrumb', () => {
  const page = views.collectionPage(XSS, [], 'recent', viewer, true);
  assertSafe(page, 'collectionPage');
});

test('a user profile is escaped on their namespace page and its settings form', () => {
  const owner = { displayName: XSS, bio: XSS, links: ['https://example.org/' + ATTR], siteAdmin: true, isViewer: true };
  assertSafe(views.collectionPage('someone', [], 'recent', viewer, true, null, owner), 'collectionPage with owner');
  assertSafe(
    forms.profileSettingsPage(viewer, { name: XSS, bio: XSS, links: [`https://example.org/?${ATTR}`] }, XSS, XSS),
    'profileSettingsPage'
  );
});

test('a branch name is escaped in the ref picker and the breadcrumb', () => {
  const ctx = ctxFor({
    ref: ATTR,
    branches: [{ name: ATTR, sha: 'b'.repeat(40), date: '', subject: XSS }],
  });
  assertSafe(views.treePage(ctx, treeView()), 'treePage');
  assertSafe(views.refListPage(ctx, 'branches'), 'refListPage');
});

test('a file path and a commit subject are escaped in a tree listing', () => {
  const ctx = ctxFor();
  const view = treeView({
    entries: [{ name: XSS, type: 'blob', sha: 'c'.repeat(40), size: 1, mode: '100644' }],
    latest: { sha: 'c'.repeat(40), subject: XSS, author: XSS, email: XSS, date: '' },
    description: XSS,
  });
  assertSafe(views.treePage(ctx, view), 'treePage with entries');
});

test('a search query and the lines it matched are escaped', () => {
  const page = views.searchPage(ctxFor(), XSS, {
    files: [{ path: XSS, hits: [{ line: 1, text: `x ${XSS} y` }], more: 0 }],
    total: 1,
    truncated: false,
    capped: false,
  });
  assertSafe(page, 'searchPage');
});

test('a commit message and author are escaped on the commit page', () => {
  const page = views.commitPage(
    ctxFor(),
    {
      sha: 'd'.repeat(40),
      parents: [],
      author: XSS,
      email: XSS,
      date: '',
      message: `${XSS}\n\nbody ${XSS}`,
    },
    '<div class="diff"></div>'
  );
  assertSafe(page, 'commitPage');
});

test('an error message is escaped', () => {
  assertSafe(views.errorPage(404, XSS, { backUrl: `/x?${ATTR}` }), 'errorPage');
});

test('the about page and login form escape what they are handed', () => {
  assertSafe(views.aboutPage(`http://vault.example/${ATTR}`, null), 'aboutPage');
  assertSafe(forms.loginPage(`/next?${ATTR}`, XSS), 'loginPage');
});

test('a file being edited is escaped in the textarea and the path field', () => {
  assertSafe(forms.editFilePage(ctxFor(), XSS, `contents ${XSS}`, 'e'.repeat(40)), 'editFilePage');
  assertSafe(forms.deleteFilePage(ctxFor(), XSS, 'e'.repeat(40)), 'deleteFilePage');
  assertSafe(forms.conflictPage(ctxFor(), ATTR, `/retry?${ATTR}`), 'conflictPage');
});

test('a repository description is escaped on the settings page', () => {
  assertSafe(
    forms.settingsPage(
      ctxFor({ isPrivate: true, upstream: { url: XSS, label: XSS, web: null, github: null } }),
      XSS,
      [XSS],
      { collaborators: [{ username: XSS, role: XSS }], owners: [XSS] },
      XSS,
      XSS
    ),
    'settingsPage'
  );
  assertSafe(forms.collectionSettingsPage(viewer, XSS, 2, [XSS], XSS, XSS), 'collectionSettingsPage');
});

test('a username and its scopes are escaped on the admin pages', () => {
  const user = {
    tokens: [{ hash: 'ff', id: XSS, created: '' }],
    siteAdmin: true,
    emails: [XSS],
    passkeys: [{ id: XSS, publicKey: 'aa', alg: -7, counter: 0, name: XSS }],
  };
  assertSafe(forms.adminUsersPage(viewer, [{ name: XSS, user }], XSS, XSS), 'adminUsersPage');
  assertSafe(forms.adminUserPage(viewer, XSS, user, XSS, XSS), 'adminUserPage');
  assertSafe(forms.tokenPage(viewer, XSS, XSS, true), 'tokenPage');
});

test('the account and sign-in-code pages escape names, labels, and errors', () => {
  const pkViewer: Viewer = {
    ...viewer,
    auth: {
      ...viewer.auth,
      username: XSS,
      user: { tokens: [], passkeys: [{ id: ATTR, publicKey: 'aa', alg: -7, counter: 0, name: XSS }] },
    },
  };
  assertSafe(forms.accountPage(pkViewer, { restricted: false, msg: XSS, error: XSS }), 'accountPage');
  assertSafe(forms.accountLinkPage(pkViewer, 'ABCD-EFGH', 5), 'accountLinkPage');
  assertSafe(forms.loginLinkPage(`/next?${ATTR}`, XSS), 'loginLinkPage');
  assertSafe(forms.loginLinkConfirmPage(XSS, ATTR, `/next?${ATTR}`), 'loginLinkConfirmPage');
});

test('a fork or new-repository form escapes the collection names it offers', () => {
  assertSafe(forms.newRepoPage(viewer, [XSS], { collection: XSS, name: XSS, description: XSS }, XSS), 'newRepoPage');
  assertSafe(forms.forkPage(ctxFor(), viewer, [XSS], { collection: ATTR, name: XSS }, XSS), 'forkPage');
  assertSafe(forms.newCollectionPage(viewer, { name: XSS }, XSS), 'newCollectionPage');
});

test('the egress page escapes the row names it was handed', () => {
  const page = forms.egressPage(
    viewer,
    {
      day: '2026-08-20',
      rows: [{ repo: XSS, site: false, bytes: 10 }],
      total: 10,
      capBytes: 0,
      capGb: 0,
      overBudget: false,
      resetsIn: 60,
      history: [{ day: XSS, total: 1 }],
    },
    { lfsBucket: true, msg: XSS }
  );
  assertSafe(page, 'egressPage');
});
