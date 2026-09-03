import { createHash } from 'crypto';

// The one script every page loads.
//
// This used to be two inline <script> blocks in layout(), which worked and
// cost nothing extra to fetch, but meant the pages could never carry a
// Content-Security-Policy worth having: a policy that allows inline script
// allows an injected one too, and the browser cannot tell them apart. So the
// script lives here, is served from /assets/page.js, and the pages carry no
// executable markup of their own.
//
// It is the same bytes for every vault, every theme, and every page, which is
// what lets it be cached for good: the tag below is a hash of the body, so an
// edit to this file changes the URL. Anything page-specific reaches it through
// a data attribute rather than through interpolation -- the vault's theme on
// <html>, a live job's log endpoint on the <pre> that shows it -- which is
// also why there is nothing here for a template to escape.
//
// Style, for the same reason the rest of the frontend has no build step: this
// is ES5-shaped, no modules, no bundler, and it is loaded in <head> without
// defer so that the theme is applied before the first paint.

const PAGE_JS = `
// ---- appearance ----

// The appearance the reader chose, applied before the page is painted so the
// vault's own theme is never shown for a frame first. The stylesheet carries
// every theme's tokens, so this is one attribute; the code colours are a whole
// stylesheet of their own and so are a second request when they differ.
// The vault's own theme and the dark one it pairs with are stamped on <html>
// by the server, so this file is the same bytes for every vault and every
// theme and can be cached for good.
var mochiRoot = document.documentElement;
var mochiTheme = {
  vault: mochiRoot.getAttribute('data-theme-vault') || 'paper',
  dark: mochiRoot.getAttribute('data-theme-dark') || 'midnight',
};
function applyTheme() {
  var pick = null;
  try { pick = localStorage.getItem('mochi.theme'); } catch (e) {}
  var auto = !pick || pick === 'auto';
  if (auto) pick = matchMedia('(prefers-color-scheme: dark)').matches ? mochiTheme.dark : mochiTheme.vault;
  document.documentElement.setAttribute('data-theme', pick);
  var hl = document.getElementById('hl-css');
  var href = '/assets/hl.css?t=' + encodeURIComponent(pick);
  if (hl && hl.getAttribute('href') !== href) hl.setAttribute('href', href);
  var items = document.querySelectorAll('[data-theme-name]');
  for (var i = 0; i < items.length; i++) {
    var n = items[i].getAttribute('data-theme-name');
    items[i].setAttribute('aria-checked', String(auto ? n === 'auto' : n === pick));
  }
}
function setTheme(name) {
  try { localStorage.setItem('mochi.theme', name); } catch (e) {}
  applyTheme();
  if (typeof closeMenus === 'function') closeMenus(null);
}
applyTheme();
// Again once the menu exists: the call above runs before the body is parsed,
// which is the point of it, but it means the menu's marks are set here.
document.addEventListener('DOMContentLoaded', applyTheme);
// Following the system means following it while the page is open, not only
// when it was loaded.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---- copying, menus, filtering, and the jump box ----

function copyText(btn, text) {
  function done() { btn.classList.add('copied'); setTimeout(function () { btn.classList.remove('copied'); }, 1400); }
  function fallback() {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { fallback(); done(); });
  } else { fallback(); done(); }
}
// The text to copy is the button's own data-copy when it carries one, and
// otherwise whatever sits just before it: a <code>, or an <input> holding a URL.
function copyCmd(btn) {
  var el = btn.previousElementSibling;
  var own = btn.getAttribute('data-copy');
  copyText(btn, own !== null ? own : (el && el.tagName === 'INPUT' ? el.value : el.textContent));
}
// A file view is one element per line, so its text is gathered rather than
// read off one node; the line numbers are separate elements and stay out.
function copyLines(btn) {
  var lines = document.querySelectorAll('.code-lines .ltext');
  var out = [];
  for (var i = 0; i < lines.length; i++) out.push(lines[i].textContent);
  copyText(btn, out.join('\\n'));
}
// Menus are <details> elements. These two handlers give them the rest of what
// a menu is expected to do: close when the reader clicks elsewhere or presses
// Escape. Nothing else about them needs script.
function closeMenus(except) {
  var open = document.querySelectorAll('details.dropdown[open]');
  for (var i = 0; i < open.length; i++) {
    if (!except || !open[i].contains(except)) open[i].open = false;
  }
}
document.addEventListener('click', function (e) { closeMenus(e.target); });
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenus(null); });
// The file finder's matching: every character of the query in order, though
// not necessarily together, so "srcmn" finds src/compute/mean.py. Matching is
// done here rather than on the server because the whole list is already in
// the page.
function findMatch(hay, needle) {
  var i = 0;
  for (var j = 0; j < hay.length && i < needle.length; j++) {
    if (hay.charCodeAt(j) === needle.charCodeAt(i)) i++;
  }
  return i === needle.length;
}
function filterFiles(input) {
  var items = document.getElementById('find-list').children;
  var q = input.value.trim().toLowerCase();
  var shown = 0;
  for (var i = 0; i < items.length; i++) {
    var hit = q === '' || findMatch(items[i].textContent.toLowerCase(), q);
    items[i].hidden = !hit;
    if (hit) shown++;
  }
  document.getElementById('find-empty').hidden = shown !== 0;
}
// Enter opens the first match, Escape clears the box.
function findKey(e, input) {
  if (e.key === 'Escape') { input.value = ''; filterFiles(input); return; }
  if (e.key !== 'Enter') return;
  var items = document.getElementById('find-list').children;
  for (var i = 0; i < items.length; i++) {
    if (!items[i].hidden) { e.preventDefault(); location.href = items[i].href; return; }
  }
}
// ---- the jump box ----
// The repository names are the same list the front page shows, fetched once
// and kept for the tab, so typing costs nothing after the first opening.
var jumpRepos = null;
var jumpCtx = null;
var jumpCtxRead = false;
var jumpSel = 0;
// A path on this origin, or null. The context is read out of the page, and
// a rendered document shares the page; an href that is not a local path is
// not one the box will send anybody to.
function localPath(s) {
  return typeof s === 'string' && s.charAt(0) === '/' && s.charAt(1) !== '/' && s.charAt(1) !== '\\\\' ? s : null;
}
// The repository the page is about, read when the box first opens rather than
// when this file loads: the script is in <head>, so at load time the body,
// and the element, do not exist yet. The selector names the script tag the
// template emits (src/views.ts); a rendered document cannot contain one.
function jumpContext() {
  if (jumpCtxRead) return jumpCtx;
  jumpCtxRead = true;
  var el = document.querySelector('script#jump-data[type="application/json"]');
  if (!el) return null;
  var raw;
  try { raw = JSON.parse(el.textContent); } catch (e) { return null; }
  if (!raw || typeof raw.repo !== 'string') return null;
  var sections = [];
  var list = Array.isArray(raw.sections) ? raw.sections : [];
  for (var i = 0; i < list.length; i++) {
    var href = localPath(list[i] && list[i].href);
    if (href && typeof list[i].label === 'string') sections.push({ label: list[i].label, href: href });
  }
  var searchUrl = localPath(raw.searchUrl);
  var findUrl = localPath(raw.findUrl);
  if (!searchUrl || !findUrl) return null;
  jumpCtx = { repo: raw.repo, sections: sections, searchUrl: searchUrl, findUrl: findUrl };
  return jumpCtx;
}
function loadJumpRepos() {
  if (jumpRepos) return Promise.resolve(jumpRepos);
  var cached = null;
  // The key carries a version: the entries grew topics, and a tab holding the
  // older list of bare names would otherwise feed it to code expecting objects.
  try { cached = sessionStorage.getItem('mochi.repos.v2'); } catch (e) {}
  if (cached) { try { jumpRepos = JSON.parse(cached); return Promise.resolve(jumpRepos); } catch (e) {} }
  return fetch('/assets/repos.json').then(function (r) { return r.json(); }).then(function (list) {
    jumpRepos = list;
    try { sessionStorage.setItem('mochi.repos.v2', JSON.stringify(list)); } catch (e) {}
    return list;
  }, function () { jumpRepos = []; return jumpRepos; });
}
function openJump() {
  var dlg = document.getElementById('jump');
  if (!dlg || dlg.open) return;
  closeMenus(null);
  dlg.showModal();
  var q = document.getElementById('jump-q');
  q.value = '';
  q.focus();
  renderJump();
  loadJumpRepos().then(renderJump);
}
// The score is the position of the first character of the match, so a name
// beginning with what was typed comes before one that merely contains it, and
// a match on the repository's own name before one on its collection.
function jumpScore(hay, q) {
  if (q === '') return 0;
  var i = hay.toLowerCase().indexOf(q);
  if (i !== -1) return i;
  return findMatch(hay.toLowerCase(), q) ? 900 : -1;
}
function jumpItems() {
  var q = document.getElementById('jump-q').value.trim().toLowerCase();
  var out = [];
  var jumpCtx = jumpContext();
  if (jumpCtx) {
    for (var s = 0; s < jumpCtx.sections.length; s++) {
      var sec = jumpCtx.sections[s];
      var ss = jumpScore(sec.label, q);
      if (ss >= 0) out.push({ score: ss, group: jumpCtx.repo, label: sec.label, href: sec.href });
    }
  }
  var repos = jumpRepos || [];
  for (var i = 0; i < repos.length; i++) {
    var entry = repos[i];
    var name = typeof entry === 'string' ? entry : entry.name;
    var topics = (entry && entry.topics) || [];
    var slash = name.indexOf('/');
    var short = name.slice(slash + 1);
    var note = name.slice(0, slash);
    var sc = jumpScore(short, q);
    // Falling back to the whole path lets "concept/bench" find a repository,
    // but only as a literal substring: a collection name spread across it a
    // letter at a time would match nearly everything.
    if (sc < 0 && q !== '' && name.toLowerCase().indexOf(q) !== -1) sc = 950;
    // Last, the topics: typing one finds what carries it, below any match on
    // a name, and the note says which topic answered.
    if (sc < 0 && q !== '') {
      for (var t = 0; t < topics.length; t++) {
        if (topics[t].indexOf(q) !== -1) { sc = 960; note = note + ' · ' + topics[t]; break; }
      }
    }
    // A repository is what the box is mostly for, so its matches sort above a
    // section of equal quality rather than below.
    if (sc >= 0) out.push({ score: sc - 1, group: 'Repositories', label: short, note: note, href: '/' + name.split('/').map(encodeURIComponent).join('/') });
  }
  out.sort(function (a, b) { return a.score - b.score || a.label.localeCompare(b.label); });
  out = out.slice(0, 15);
  if (jumpCtx && q !== '') {
    var g = 'Search ' + jumpCtx.repo;
    out.push({ group: g, label: 'Contents matching \u201c' + q + '\u201d', href: jumpCtx.searchUrl + encodeURIComponent(q) });
    out.push({ group: g, label: 'File names', href: jumpCtx.findUrl });
  }
  return out;
}
function renderJump() {
  var list = document.getElementById('jump-list');
  if (!list) return;
  var items = jumpItems();
  if (jumpSel >= items.length) jumpSel = 0;
  var html = '';
  var group = null;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.group !== group) { group = it.group; html += '<li class="jump-group" role="presentation">' + escapeHtml(group) + '</li>'; }
    html += '<li role="option" aria-selected="' + (i === jumpSel) + '"><a class="jump-item' + (i === jumpSel ? ' on' : '') +
      '" href="' + escapeHtml(it.href) + '" data-jump-index="' + i + '"><span class="jump-name">' + escapeHtml(it.label) + '</span>' +
      (it.note ? '<span class="jump-note">' + escapeHtml(it.note) + '</span>' : '') + '</a></li>';
  }
  list.innerHTML = html || '<li class="jump-empty" role="presentation">' +
    (jumpRepos === null ? 'Loading\u2026' : 'Nothing matches.') + '</li>';
  var on = list.querySelector('.jump-item.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function jumpPoint(i) { jumpSel = i; renderJump(); }
function jumpKey(e) {
  var items = document.getElementById('jump-list').querySelectorAll('.jump-item');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!items.length) return;
    jumpSel = (jumpSel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    renderJump();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (items[jumpSel]) location.href = items[jumpSel].getAttribute('href');
  }
}
// / opens the box and t still goes straight to the file finder. A key pressed
// while typing into something is a keystroke, not a shortcut.
document.addEventListener('keydown', function (e) {
  var el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
  if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); openJump(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); openJump(); return; }
  if (e.key !== 't') return;
  var btn = document.querySelector('[data-find-url]');
  if (!btn) return;
  e.preventDefault();
  location.href = btn.getAttribute('data-find-url');
});
// Clicking the backdrop closes the box, as clicking outside any other menu does.
document.addEventListener('click', function (e) {
  var dlg = document.getElementById('jump');
  if (dlg && dlg.open && e.target === dlg) dlg.close();
});
// Ids inside a rendered document carry a user-content- prefix (see
// src/markdown.ts), so a link from outside it to /repo#install names an
// element that is not there under that name. When the fragment finds nothing,
// the prefixed element is scrolled to instead, on load and on every change.
function followHash() {
  var h = location.hash ? String(location.hash).slice(1) : '';
  if (!h || document.getElementById(h)) return;
  var name;
  try { name = decodeURIComponent(h); } catch (e) { name = h; }
  var el = document.getElementById('user-content-' + name);
  if (el && el.scrollIntoView) el.scrollIntoView();
}
document.addEventListener('DOMContentLoaded', followHash);
window.addEventListener('hashchange', followHash);
// The filter box above a listing: hide the rows that do not match, and say so
// when none do.
function filterRows(input) {
  var id = input.getAttribute('data-target');
  var table = document.getElementById(id);
  var empty = document.getElementById(id + '-empty');
  var q = input.value.trim().toLowerCase();
  var rows = table.tBodies[0].rows;
  var shown = 0;
  for (var i = 0; i < rows.length; i++) {
    var hit = q === '' || rows[i].textContent.toLowerCase().indexOf(q) !== -1;
    rows[i].hidden = !hit;
    if (hit) shown++;
  }
  if (empty) empty.hidden = shown !== 0;
}
// The same as filterRows, over a list of cards rather than table rows.
function filterCards(input) {
  var list = document.getElementById(input.getAttribute('data-target'));
  var empty = document.getElementById(input.getAttribute('data-target') + '-empty');
  var q = input.value.trim().toLowerCase();
  var items = list.children;
  var shown = 0;
  for (var i = 0; i < items.length; i++) {
    var hit = q === '' || items[i].textContent.toLowerCase().indexOf(q) !== -1;
    items[i].hidden = !hit;
    if (hit) shown++;
  }
  if (empty) empty.hidden = shown !== 0;
}
// The filter box in a menu of many items (branches and tags).
function filterMenu(input) {
  var menu = input.parentElement;
  var q = input.value.trim().toLowerCase();
  var groups = menu.querySelectorAll('.dd-group');
  for (var g = 0; g < groups.length; g++) {
    var items = groups[g].querySelectorAll('.dd-item');
    var shown = 0;
    for (var i = 0; i < items.length; i++) {
      var hit = q === '' || items[i].textContent.toLowerCase().indexOf(q) !== -1;
      items[i].hidden = !hit;
      if (hit) shown++;
    }
    groups[g].hidden = shown === 0;
  }
}

// ---- passkeys ----
//
// The WebAuthn ceremonies, client half. The server speaks JSON on
// /login/passkey* and /account/passkeys*, with every binary field base64url,
// which is also the encoding the WebAuthn API's own ids use. Buttons carry
// data attributes and start hidden; support is detected here, so a browser
// without WebAuthn (or a page served over plain http, where the API does not
// exist) simply never shows them.

function pkDecode(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  var bin = atob(s);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
function pkEncode(buf) {
  var b = new Uint8Array(buf);
  var bin = '';
  for (var i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
}
function pkSay(message) {
  var el = document.querySelector('[data-passkey-error]');
  if (!el) return;
  el.textContent = message || '';
  el.hidden = !message;
}
function pkFetch(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (d) {
      if (!r.ok) throw new Error(d.error || ('the server answered ' + r.status));
      return d;
    });
  });
}
// A cancelled or timed-out prompt is the user's decision, not a fault to
// paint red; anything else is said as the server or browser said it.
function pkProblem(e) {
  if (e && e.name === 'NotAllowedError') pkSay('Cancelled, or the prompt timed out. Try again when ready.');
  else pkSay((e && e.message) || 'Something went wrong.');
}
function pkRegister(btn) {
  var form = closestOf(btn, '[data-passkey-form]');
  var csrf = form.querySelector('input[name=csrf]').value;
  var label = (form.querySelector('input[name=name]') || { value: '' }).value;
  pkSay('');
  btn.disabled = true;
  pkFetch('/account/passkeys/challenge', { csrf: csrf })
    .then(function (o) {
      var publicKey = {
        challenge: pkDecode(o.challenge),
        rp: o.rp,
        user: { id: pkDecode(o.user.id), name: o.user.name, displayName: o.user.displayName },
        pubKeyCredParams: o.pubKeyCredParams,
        authenticatorSelection: o.authenticatorSelection,
        timeout: o.timeout,
        attestation: o.attestation,
        excludeCredentials: (o.excludeCredentials || []).map(function (c) {
          return { type: 'public-key', id: pkDecode(c.id) };
        }),
      };
      return navigator.credentials.create({ publicKey: publicKey });
    })
    .then(function (cred) {
      return pkFetch('/account/passkeys', {
        csrf: csrf,
        name: label,
        id: cred.id,
        clientDataJSON: pkEncode(cred.response.clientDataJSON),
        attestationObject: pkEncode(cred.response.attestationObject),
      });
    })
    .then(function (d) { location.href = d.next; })
    .catch(pkProblem)
    .then(function () { btn.disabled = false; });
}
function pkLogin(btn) {
  pkSay('');
  btn.disabled = true;
  pkFetch('/login/passkey/challenge', {})
    .then(function (o) {
      return navigator.credentials.get({
        publicKey: {
          challenge: pkDecode(o.challenge),
          rpId: o.rpId,
          timeout: o.timeout,
          userVerification: o.userVerification,
          allowCredentials: [],
        },
      });
    })
    .then(function (cred) {
      return pkFetch('/login/passkey', {
        next: btn.getAttribute('data-next') || '/',
        id: cred.id,
        clientDataJSON: pkEncode(cred.response.clientDataJSON),
        authenticatorData: pkEncode(cred.response.authenticatorData),
        signature: pkEncode(cred.response.signature),
        userHandle: cred.response.userHandle ? pkEncode(cred.response.userHandle) : null,
      });
    })
    .then(function (d) { location.href = d.next; })
    .catch(pkProblem)
    .then(function () { btn.disabled = false; });
}
document.addEventListener('DOMContentLoaded', function () {
  var supported = Boolean(window.PublicKeyCredential);
  var login = document.querySelector('[data-passkey-login]');
  if (login && supported) login.hidden = false;
  var add = document.querySelector('[data-passkey-add]');
  var unsupported = document.querySelector('[data-passkey-unsupported]');
  if (add && !supported) {
    add.disabled = true;
    if (unsupported) unsupported.hidden = false;
  }
});

// ---- wiring ----
//
// The markup carries data attributes rather than inline handlers, and the
// listeners are attached here. That is what a Content-Security-Policy without
// 'unsafe-inline' requires, and it costs the pages nothing: an attribute like
// data-confirm is data, so the template escapes it like any other value, where
// onsubmit="return confirm('...')" put a name inside a JavaScript string
// inside an HTML attribute and depended on the name never containing a quote.
//
// Delegated from the document wherever the elements come and go (a menu
// re-rendered, a dialog filled in), so nothing has to be re-attached.

// The nearest ancestor matching a selector, including the element itself.
function closestOf(el, selector) {
  while (el && el.nodeType === 1) {
    if (el.matches && el.matches(selector)) return el;
    el = el.parentElement;
  }
  return null;
}

document.addEventListener('click', function (e) {
  var t = e.target;
  if (closestOf(t, '[data-jump-open]')) { openJump(); return; }
  var theme = closestOf(t, '[data-theme-name]');
  if (theme) { setTheme(theme.getAttribute('data-theme-name')); return; }
  var copy = closestOf(t, '.copy-btn');
  if (copy) { copyCmd(copy); return; }
  var lines = closestOf(t, '[data-copy-lines]');
  if (lines) { copyLines(lines); return; }
  var select = closestOf(t, '[data-select-all]');
  if (select) { select.select(); return; }
  var pkAdd = closestOf(t, '[data-passkey-add]');
  if (pkAdd) { pkRegister(pkAdd); return; }
  var pkGo = closestOf(t, '[data-passkey-login-btn]');
  if (pkGo) { pkLogin(pkGo); return; }
  var mdTab = closestOf(t, '[data-md-pane]');
  if (mdTab) { mdPane(mdEditorOf(mdTab), mdTab.getAttribute('data-md-pane')); return; }
  var mdBtn = closestOf(t, '[data-md-act]');
  if (mdBtn) { mdAct(mdEditorOf(mdBtn), mdBtn.getAttribute('data-md-act')); return; }
});

document.addEventListener('input', function (e) {
  var el = e.target;
  if (!el || !el.matches) return;
  if (el.matches('.dd-filter')) { filterMenu(el); return; }
  if (el.matches('.find-input')) { filterFiles(el); return; }
  if (el.id === 'jump-q') { renderJump(); return; }
  if (el.matches('[data-filter="rows"]')) { filterRows(el); return; }
  if (el.matches('[data-filter="cards"]')) { filterCards(el); return; }
});

document.addEventListener('change', function (e) {
  var el = e.target;
  if (el && el.matches && el.matches('[data-workflow-picker]')) pickWorkflow(el);
});

document.addEventListener('keydown', function (e) {
  var el = e.target;
  if (!el || !el.matches) return;
  if (el.id === 'jump-q') { jumpKey(e); return; }
  if (el.matches('.find-input')) { findKey(e, el); return; }
  // The formatting shortcuts, only inside a markdown editor's field: the same
  // four GitHub answers to, so hands need not relearn anything.
  if (el.tagName === 'TEXTAREA' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
    var ed = mdEditorOf(el);
    if (!ed) return;
    var act = { b: 'bold', i: 'italic', k: 'link', e: 'code' }[String(e.key).toLowerCase()];
    if (act) { e.preventDefault(); mdAct(ed, act); }
  }
});

// mouseenter does not bubble, so the jump list is followed with mouseover,
// which does; the guard keeps a move within one row from re-rendering.
document.addEventListener('mouseover', function (e) {
  var item = closestOf(e.target, '[data-jump-index]');
  if (!item) return;
  var i = parseInt(item.getAttribute('data-jump-index'), 10);
  if (i !== jumpSel) jumpPoint(i);
});

// A form that carries data-confirm asks before it submits. Anything it says is
// the server's text, put in an attribute rather than in script.
document.addEventListener('submit', function (e) {
  var form = closestOf(e.target, 'form[data-confirm]');
  if (!form) return;
  if (!confirm(form.getAttribute('data-confirm'))) e.preventDefault();
});

// The workflow dispatch menu shows one form per workflow and the picker
// chooses between them. It lived beside the menu it belongs to; it is here now
// because that is where every listener is.
function pickWorkflow(sel) {
  var root = closestOf(sel, '.dispatch-body');
  if (!root) return;
  var forms = root.querySelectorAll('.dispatch-panel');
  for (var i = 0; i < forms.length; i++) {
    forms[i].hidden = forms[i].getAttribute('data-wf') !== sel.value;
  }
}

// ---- the markdown editor ----
//
// The toolbar writes markdown into the textarea rather than styling anything:
// what is stored is what was typed. Every button is a toggle where a toggle
// makes sense (bold twice is plain again), and the Preview tab shows the draft
// through the same renderer the saved page will use, fetched from the
// repository's own preview endpoint so relative links, #12, and commit ids
// resolve as they will when saved.

function mdEditorOf(el) { return closestOf(el, '[data-md-editor]'); }

// Replace [start, end) with text, leave [selStart, selEnd) selected, and keep
// the field focused so the next keystroke lands where the edit did.
function mdSet(input, start, end, text, selStart, selEnd) {
  input.focus();
  input.setRangeText(text, start, end, 'preserve');
  input.setSelectionRange(selStart, selEnd);
}

// Wrap the selection in the marks, or take them off again when they are
// already there, inside the selection or just around it.
function mdSurround(input, before, after, placeholder) {
  var s = input.selectionStart, e = input.selectionEnd, v = input.value;
  var sel = v.slice(s, e);
  if (sel.length >= before.length + after.length &&
      sel.slice(0, before.length) === before && sel.slice(sel.length - after.length) === after) {
    var inner = sel.slice(before.length, sel.length - after.length);
    mdSet(input, s, e, inner, s, s + inner.length);
    return;
  }
  if (s >= before.length && v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after) {
    mdSet(input, s - before.length, e + after.length, sel, s - before.length, s - before.length + sel.length);
    return;
  }
  var body = sel || placeholder || '';
  mdSet(input, s, e, before + body + after, s + before.length, s + before.length + body.length);
}

// The whole lines the selection touches, and where they sit in the value.
function mdLines(input) {
  var v = input.value;
  var s = v.lastIndexOf('\\n', input.selectionStart - 1) + 1;
  var e = v.indexOf('\\n', input.selectionEnd);
  if (e === -1) e = v.length;
  return { start: s, end: e, lines: v.slice(s, e).split('\\n') };
}

// Prefix each selected line, or strip the prefix when every line has one
// already; blank lines between prefixed ones are passed over.
function mdPrefix(input, make, strip) {
  var r = mdLines(input);
  var on = r.lines.every(function (l) { return l === '' || strip.test(l); });
  var out = [];
  for (var i = 0; i < r.lines.length; i++) {
    var l = r.lines[i];
    out.push(on ? l.replace(strip, '') : (l === '' && r.lines.length > 1 ? l : make(i) + l));
  }
  var text = out.join('\\n');
  mdSet(input, r.start, r.end, text, r.start, r.start + text.length);
}

// A link: a selected URL becomes the target with the cursor in the text, and
// anything else becomes the text with the url placeholder selected.
function mdLink(input) {
  var s = input.selectionStart, e = input.selectionEnd;
  var sel = input.value.slice(s, e);
  if (/^https?:\\/\\/\\S+$/.test(sel)) {
    mdSet(input, s, e, '[](' + sel + ')', s + 1, s + 1);
  } else {
    var body = sel || 'link text';
    mdSet(input, s, e, '[' + body + '](url)', s + body.length + 3, s + body.length + 6);
  }
}

function mdAct(ed, act) {
  var input = ed && ed.querySelector('textarea');
  if (!input || input.hidden) return;
  if (act === 'bold') return mdSurround(input, '**', '**', 'bold text');
  if (act === 'italic') return mdSurround(input, '_', '_', 'italic text');
  if (act === 'strike') return mdSurround(input, '~~', '~~', 'struck text');
  if (act === 'link') return mdLink(input);
  if (act === 'code') {
    var sel = input.value.slice(input.selectionStart, input.selectionEnd);
    if (sel.indexOf('\\n') !== -1) return mdSurround(input, '\`\`\`\\n', '\\n\`\`\`', '');
    return mdSurround(input, '\`', '\`', 'code');
  }
  if (act === 'heading') return mdPrefix(input, function () { return '### '; }, /^#{1,6} /);
  if (act === 'quote') return mdPrefix(input, function () { return '> '; }, /^> /);
  if (act === 'ul') return mdPrefix(input, function () { return '- '; }, /^[-*] (?!\\[[ xX]\\] )/);
  if (act === 'ol') return mdPrefix(input, function (i) { return (i + 1) + '. '; }, /^\\d+\\. /);
  if (act === 'task') return mdPrefix(input, function () { return '- [ ] '; }, /^[-*] \\[[ xX]\\] /);
}

// The tabs. Write is the field back; Preview posts the draft, with the CSRF
// value of the form it sits in, and shows what came back. The height of the
// field is kept so the page does not jump, and an unchanged draft is not
// posted again.
function mdPane(ed, pane) {
  var input = ed.querySelector('textarea');
  var render = ed.querySelector('.md-render');
  var tabs = ed.querySelectorAll('[data-md-pane]');
  for (var i = 0; i < tabs.length; i++) {
    var on = tabs[i].getAttribute('data-md-pane') === pane;
    tabs[i].classList[on ? 'add' : 'remove']('current');
    tabs[i].setAttribute('aria-selected', String(on));
  }
  var previewing = pane === 'preview';
  ed.classList[previewing ? 'add' : 'remove']('previewing');
  input.hidden = previewing;
  render.hidden = !previewing;
  if (!previewing) { input.focus(); return; }
  render.style.minHeight = input.offsetHeight + 'px';
  if (ed.mdShown === input.value) return;
  render.innerHTML = '<p class="muted">Rendering\\u2026</p>';
  var form = closestOf(ed, 'form');
  var csrf = form && form.querySelector('input[name=csrf]');
  var params = new URLSearchParams();
  params.set('csrf', csrf ? csrf.value : '');
  params.set('text', input.value);
  params.set('ref', ed.getAttribute('data-md-ref') || '');
  params.set('dir', ed.getAttribute('data-md-dir') || '');
  fetch(ed.getAttribute('data-md-preview'), { method: 'POST', body: params })
    .then(function (r) { if (!r.ok) throw new Error('preview ' + r.status); return r.text(); })
    .then(function (h) { ed.mdShown = input.value; render.innerHTML = h; })
    .catch(function () { render.innerHTML = '<p class="muted">The preview could not be rendered. The draft is untouched.</p>'; });
}

// The editors: in one of the code kind, Tab indents rather than leaving the
// field, since code is what is being typed (Shift-Tab still moves focus out,
// so the keyboard is not trapped). Navigating away from any edited buffer asks
// first; committing does not ask, since submitting is the point.
document.addEventListener('DOMContentLoaded', function () {
  var tas = document.querySelectorAll('textarea.code-editor, [data-md-editor] textarea');
  if (!tas.length) return;
  var initial = [];
  var submitted = false;
  function watch(ta) {
    initial.push(ta.value);
    var form = ta.closest('form');
    if (form && !form.mdWatched) {
      form.mdWatched = true;
      form.addEventListener('submit', function () { submitted = true; });
    }
    if (!ta.classList.contains('code-editor')) return;
    ta.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
    });
  }
  for (var i = 0; i < tas.length; i++) watch(tas[i]);
  window.addEventListener('beforeunload', function (e) {
    if (submitted) return;
    var dirty = false;
    for (var i = 0; i < tas.length; i++) if (tas[i].value !== initial[i]) dirty = true;
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
});

// A live job's log: the endpoint and the offset to resume from are on the
// element, so this file stays the same bytes whatever job is being watched.
document.addEventListener('DOMContentLoaded', function () {
  var el = document.getElementById('livelog');
  if (!el || !el.getAttribute('data-log-url')) return;
  var url = el.getAttribute('data-log-url');
  var offset = parseInt(el.getAttribute('data-log-offset') || '0', 10);
  var stick = true;
  el.addEventListener('scroll', function () {
    stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
  });
  function poll() {
    fetch(url + '?offset=' + offset, { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.lines && d.lines.length) {
          el.textContent += (el.textContent ? '\\n' : '') + d.lines.join('\\n');
          if (stick) el.scrollTop = el.scrollHeight;
        }
        offset = d.offset;
        if (d.done) { location.reload(); return; }
        setTimeout(poll, 1500);
      })
      .catch(function () { setTimeout(poll, 5000); });
  }
  el.scrollTop = el.scrollHeight;
  setTimeout(poll, 1000);
});

`;

/**
 * The script and a tag naming this exact body, in the shape styleSheet() uses
 * and for the same reason: a URL carrying the right tag may be kept for good.
 */
let made: { body: string; tag: string } | null = null;

export function pageScript(): { body: string; tag: string } {
  if (!made) {
    made = { body: PAGE_JS, tag: createHash('sha256').update(PAGE_JS).digest('hex').slice(0, 12) };
  }
  return made;
}
