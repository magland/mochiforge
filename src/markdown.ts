// Markdown rendering for repository documents.
//
// The target is what GitHub renders, since that is what people write their
// READMEs against: fenced code with syntax highlighting, LaTeX math, tables,
// task lists, footnotes, alert callouts, emoji shortcodes, autolinks, heading
// anchors, and a conservative subset of inline HTML.
//
// Two properties are load-bearing and should survive any later rewrite. First,
// nothing a document author writes may become active markup on this origin: the
// rendered output passes through an allowlist sanitizer, and the allowlist has
// no `style` attribute, no scripts, no frames. Second, everything is rendered
// on the server; no page needs client-side JavaScript to read.
//
// Trusted fragments we generate ourselves (highlighted code, KaTeX output)
// would not survive that allowlist intact, so they are parked in slots: the
// renderer emits an opaque marker, the sanitizer sees plain text, and the
// fragments are substituted back afterwards. The marker is random per render,
// so a document cannot forge one.

import * as crypto from 'crypto';
import hljs from 'highlight.js';
import katex from 'katex';
import MarkdownIt from 'markdown-it';
import katexPlugin from '@vscode/markdown-it-katex';
import { full as emojiPlugin } from 'markdown-it-emoji';
import footnotePlugin from 'markdown-it-footnote';
import sanitizeHtml from 'sanitize-html';
import { esc } from './render';
import { copyButton } from './views';

export interface MarkdownOpts {
  /** Base URL for relative image sources (the raw endpoint). */
  rawBase: string;
  /** Base URL for relative links (the blob endpoint). */
  blobBase: string;
  /** Where `#12` points. Cross-referencing issues is off without it. */
  issueBase?: string;
  /** Where a commit id points. Cross-referencing commits is off without it. */
  commitBase?: string;
  /**
   * Whether `@name` names a user this vault knows, in which case it is linked
   * to their profile page at `/<name>`. Mentions are off without it, and a
   * name it answers false for stays plain text: half the strings people write
   * after an @ are not users, and a link to a 404 would say otherwise.
   */
  mentions?: (name: string) => boolean;
}

// GitHub's cross-references: `#12` is that issue, and a hex string of seven
// or more characters is that commit. The pattern refuses a run that is part
// of a longer word, and a commit id must contain at least one letter, so that
// a plain number written in passing is not mistaken for one.
const CROSS_REF = /(?<![\w#/-])(?:#(\d{1,9})|([0-9a-f]{7,40}))(?![\w-])/g;

// GitHub's @mentions: an @ followed by something shaped like a username (see
// isValidUserName in src/scan.ts). The pattern refuses an @ that ends a word,
// so an email address written in passing is not half-linked. The match is
// greedy over the username characters; trailing punctuation that keeps the
// name from resolving is peeled off afterwards, so "@bob." mentions bob.
const MENTION = /(?<![\w@.-])@([A-Za-z0-9][A-Za-z0-9._-]*)/g;

export function isMarkdownFile(filename: string): boolean {
  const base = filename.split('/').pop() ?? filename;
  return /\.(md|markdown)$/i.test(base);
}

const ALERTS: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
};

// GitHub-style heading anchors: lowercase, punctuation dropped, spaces to hyphens.
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/[\s_]+/g, '-');
}

function isRelative(url: string): boolean {
  return !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(url);
}

// Resolve a relative reference against the file's directory, collapsing the
// dot segments ourselves so the emitted URL is the path a reader would type.
function resolveRef(url: string, base: string): string {
  const cut = url.search(/[#?]/);
  const rel = cut === -1 ? url : url.slice(0, cut);
  const suffix = cut === -1 ? '' : url.slice(cut);
  const out: string[] = [];
  for (const seg of `${base}/${rel}`.split('/')) {
    if (seg === '.') continue;
    if (seg === '..') {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/') + suffix;
}

const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'div', 'span', 'section',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'pre', 'code', 'samp', 'kbd', 'var',
  'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
  'a', 'img', 'picture',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'details', 'summary', 'figure', 'figcaption',
  'abbr', 'cite', 'q', 'input',
];

// No `style` anywhere: an inline style on document content could cover the
// rest of the page, which is a phishing surface even without scripting. No
// `class` either, for the same reason by another route: the stylesheet is
// the interface's own, so `<div class="topbar">` in a README would stick to
// the top of the page over the real one, with a Sign in button of its own.
// The classes the renderer itself emits are allowed by name below, and only
// on the elements it emits them on; a class an author wrote is dropped, as
// GitHub drops it. `id` stays, prefixed (see userContentId).
const ALLOWED_ATTRS: Record<string, string[]> = {
  '*': ['id', 'title', 'align', 'dir', 'lang', 'role', 'aria-label', 'aria-hidden'],
  a: ['href', 'name', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height', 'loading'],
  th: ['colspan', 'rowspan', 'scope', 'valign'],
  td: ['colspan', 'rowspan', 'valign'],
  col: ['span', 'width'],
  colgroup: ['span'],
  ol: ['start', 'type', 'reversed'],
  li: ['value'],
  details: ['open'],
  input: ['type', 'checked', 'disabled'],
};

// What the renderer puts a class on, and which. Anything else is an author's
// and is dropped; see ALLOWED_ATTRS. The footnote entries are
// markdown-it-footnote's own markup.
const ALLOWED_CLASSES: Record<string, (string | RegExp)[]> = {
  code: [/^language-[A-Za-z0-9_+#.-]+$/, 'math-error'],
  div: ['code-block', 'math-block'],
  blockquote: ['alert', /^alert-(note|tip|important|warning|caution)$/],
  p: ['alert-title'],
  li: ['task-item', 'footnote-item'],
  a: ['heading-anchor', 'footnote-backref'],
  sup: ['footnote-ref'],
  hr: ['footnotes-sep'],
  section: ['footnotes'],
  ol: ['footnotes-list'],
};

/**
 * The prefix every id in a rendered document carries. The document and the
 * page around it share one id space, and the page's script finds its own
 * elements by id: a README with `<div id="jump">` would otherwise be what
 * openJump() found and tried to show as a dialog. GitHub prefixes with the
 * same word. Links within the document (`#install`, a footnote's `#fn1`, a
 * heading's own anchor) are rewritten to match, so a document's table of
 * contents keeps working; a link from outside the document to `/repo#install`
 * finds nothing by that name, and the page script takes it to the prefixed
 * element instead (followHash in src/pagescript.ts).
 */
export const USER_CONTENT_PREFIX = 'user-content-';

function prefixId(attribs: sanitizeHtml.Attributes): void {
  if (attribs.id !== undefined && attribs.id !== '') attribs.id = USER_CONTENT_PREFIX + attribs.id;
}

function sanitizeOptions(opts: MarkdownOpts): sanitizeHtml.IOptions {
  return {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRS,
    allowedClasses: ALLOWED_CLASSES,
    allowedSchemes: ['http', 'https', 'mailto', 'ftp'],
    allowedSchemesAppliedToAttributes: ['href', 'src', 'cite'],
    allowProtocolRelative: false,
    transformTags: {
      // Rewriting here rather than in a renderer rule covers links written as
      // markdown and links written as HTML with one implementation.
      a: (tagName, attribs) => {
        const href = attribs.href;
        if (href && href.startsWith('#')) {
          if (href.length > 1) attribs.href = `#${USER_CONTENT_PREFIX}${href.slice(1)}`;
        } else if (href && isRelative(href)) {
          attribs.href = resolveRef(href, opts.blobBase);
        } else if (href && /^https?:/i.test(href)) {
          attribs.rel = 'nofollow noopener noreferrer';
        }
        return { tagName, attribs };
      },
      img: (tagName, attribs) => {
        const src = attribs.src;
        if (src && isRelative(src)) attribs.src = resolveRef(src, opts.rawBase);
        attribs.loading = 'lazy';
        return { tagName, attribs };
      },
      // Every element, the two above included: sanitize-html applies this
      // entry and then the element's own, so the id prefix lives here alone.
      '*': (tagName, attribs) => {
        prefixId(attribs);
        return { tagName, attribs };
      },
    },
  };
}

function highlight(code: string, lang: string | null): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      // fall through to plain escaping
    }
  }
  return esc(code);
}

function mathHtml(src: string, display: boolean): string {
  try {
    return katex.renderToString(src, {
      displayMode: display,
      throwOnError: false,
      // trust:false keeps \href, \htmlClass and friends from emitting markup;
      // maxSize bounds \rule and similar from blowing up the page.
      trust: false,
      maxSize: 500,
      strict: false,
    });
  } catch {
    return `<code class="math-error">${esc(src)}</code>`;
  }
}

/**
 * What one render needs to know, and the only thing the rules below keep
 * between them.
 *
 * The parser used to be built per call, which let every rule close over its
 * render's own state. That cost 2.8ms of construction -- markdown-it, three
 * plugins and a dozen rule installs, the emoji plugin's tables most of all --
 * to do work measured in tenths of a millisecond, on every fragment of every
 * page: eleven times over for an issue with ten comments. The parser is built
 * once now, so the state that used to be a closure travels in markdown-it's
 * env instead, reachable from renderer rules as their fourth argument and from
 * core rules as state.env.
 */
interface RenderEnv {
  opts: MarkdownOpts;
  /** Trusted fragments held back from the sanitizer; see the file header. */
  slots: string[];
  marker: string;
  /** Heading slugs already issued, so a repeated heading gets a -1 suffix. */
  used: Map<string, number>;
  pendingSlug: string;
}

function slot(env: RenderEnv, html: string): string {
  env.slots.push(html);
  return `${env.marker}_${env.slots.length - 1}_`;
}

function codeBlock(env: RenderEnv, code: string, lang: string | null): string {
  const cls = lang ? ` class="language-${esc(lang)}"` : '';
  // The button sits after the <pre> because the page's copyCmd() copies its
  // previous sibling.
  return `${slot(
    env,
    `<div class="code-block"><pre><code${cls}>${highlight(code, lang)}</code></pre>${copyButton()}</div>`
  )}\n`;
}

function mathBlock(env: RenderEnv, src: string): string {
  return `<div class="math-block">${slot(env, mathHtml(src, true))}</div>\n`;
}

function buildMarkdownIt(): MarkdownIt {
  const md = new MarkdownIt({ html: true, linkify: true });
  md.use(footnotePlugin);
  md.use(emojiPlugin);

  // Cross-references are resolved over the inline token stream in a core
  // rule, not in an inline rule: by the time inline rules run, markdown-it's
  // text rule has already swallowed these characters, which is the same
  // reason its own linkify works this way. Text inside a link is left alone,
  // so a reference written inside one does not try to nest a second.
  md.core.ruler.push('mochi_refs', (state) => {
    const opts = (state.env as RenderEnv).opts;
    if (!opts.issueBase && !opts.commitBase) return;
    for (const block of state.tokens) {
      if (block.type !== 'inline' || !block.children) continue;
      const out: typeof block.children = [];
      let inLink = 0;
      let changed = false;
      for (const token of block.children) {
        if (token.type === 'link_open') inLink++;
        else if (token.type === 'link_close') inLink--;
        if (token.type !== 'text' || inLink > 0) {
          out.push(token);
          continue;
        }
        let last = 0;
        CROSS_REF.lastIndex = 0;
        for (let m = CROSS_REF.exec(token.content); m; m = CROSS_REF.exec(token.content)) {
          const [whole, issue, sha] = m;
          const href = issue
            ? opts.issueBase && `${opts.issueBase}/${issue}`
            : sha && /[a-f]/.test(sha) && opts.commitBase
              ? `${opts.commitBase}/${sha}`
              : undefined;
          if (!href) continue;
          if (m.index > last) {
            const before = new state.Token('text', '', 0);
            before.content = token.content.slice(last, m.index);
            out.push(before);
          }
          const open = new state.Token('link_open', 'a', 1);
          open.attrSet('href', href);
          const label = new state.Token('text', '', 0);
          // A full commit id is shown abbreviated, the way it is written
          // everywhere else in the interface.
          label.content = sha && sha.length > 7 ? sha.slice(0, 7) : whole;
          const close = new state.Token('link_close', 'a', -1);
          out.push(open, label, close);
          last = m.index + whole.length;
          changed = true;
        }
        if (last === 0) {
          out.push(token);
        } else if (last < token.content.length) {
          const rest = new state.Token('text', '', 0);
          rest.content = token.content.slice(last);
          out.push(rest);
        }
      }
      if (changed) block.children = out;
    }
  });

  // Mentions ride the same shape as mochi_refs above: a core rule over the
  // inline token stream, leaving text inside links alone. It runs after the
  // refs rule, so a mention never lands inside a link that rule just made.
  md.core.ruler.push('mochi_mentions', (state) => {
    const mentions = (state.env as RenderEnv).opts.mentions;
    if (!mentions) return;
    for (const block of state.tokens) {
      if (block.type !== 'inline' || !block.children) continue;
      const out: typeof block.children = [];
      let inLink = 0;
      let changed = false;
      for (const token of block.children) {
        if (token.type === 'link_open') inLink++;
        else if (token.type === 'link_close') inLink--;
        if (token.type !== 'text' || inLink > 0) {
          out.push(token);
          continue;
        }
        let last = 0;
        MENTION.lastIndex = 0;
        for (let m = MENTION.exec(token.content); m; m = MENTION.exec(token.content)) {
          // Dots, dashes, and underscores are legal in a username and common
          // as the punctuation right after one: "@bob." at the end of a
          // sentence means bob. Trailing punctuation is peeled only while the
          // name does not resolve, so a username that really ends that way
          // still wins.
          let name = m[1];
          while (name !== '' && !mentions(name)) {
            const cut = name.search(/[._-]+$/);
            if (cut === -1) {
              name = '';
              break;
            }
            name = name.slice(0, cut);
          }
          if (name === '') continue;
          if (m.index > last) {
            const before = new state.Token('text', '', 0);
            before.content = token.content.slice(last, m.index);
            out.push(before);
          }
          const open = new state.Token('link_open', 'a', 1);
          open.attrSet('href', `/${encodeURIComponent(name)}`);
          const label = new state.Token('text', '', 0);
          label.content = `@${name}`;
          const close = new state.Token('link_close', 'a', -1);
          out.push(open, label, close);
          last = m.index + 1 + name.length;
          MENTION.lastIndex = last;
          changed = true;
        }
        if (last === 0) {
          out.push(token);
        } else if (last < token.content.length) {
          const rest = new state.Token('text', '', 0);
          rest.content = token.content.slice(last);
          out.push(rest);
        }
      }
      if (changed) block.children = out;
    }
  });

  md.renderer.rules.fence = (tokens, idx, _options, env) => {
    const token = tokens[idx];
    const info = token.info.trim().split(/\s+/)[0].toLowerCase();
    if (info === 'math') return mathBlock(env as RenderEnv, token.content);
    return codeBlock(env as RenderEnv, token.content, info || null);
  };
  md.renderer.rules.code_block = (tokens, idx, _options, env) =>
    codeBlock(env as RenderEnv, tokens[idx].content, null);

  // The plugin renders math itself; we route it through a slot instead so the
  // sanitizer never has to allow KaTeX's own markup.
  md.use(katexPlugin, {});
  md.renderer.rules.math_inline = (tokens, idx, _options, env) =>
    slot(env as RenderEnv, mathHtml(tokens[idx].content, false));
  md.renderer.rules.math_block = (tokens, idx, _options, env) =>
    mathBlock(env as RenderEnv, tokens[idx].content);
  md.renderer.rules.math_inline_block = (tokens, idx, _options, env) =>
    mathBlock(env as RenderEnv, tokens[idx].content);

  // markdown-it expresses column alignment as an inline style, which the
  // sanitizer strips; carry it in the align attribute instead, as GitHub does.
  const alignRule: MarkdownIt.Renderer.RenderRule = (tokens, idx, options, _env, self) => {
    const token = tokens[idx];
    const style = token.attrGet('style');
    const m = style ? /text-align:\s*(left|center|right)/.exec(style) : null;
    if (m && token.attrs) {
      token.attrs = token.attrs.filter((a) => a[0] !== 'style');
      token.attrSet('align', m[1]);
    }
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.th_open = alignRule;
  md.renderer.rules.td_open = alignRule;

  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    const e = env as RenderEnv;
    const inline = tokens[idx + 1];
    const slug = slugify(inline && inline.type === 'inline' ? inline.content : '');
    e.pendingSlug = '';
    if (slug) {
      const seen = e.used.get(slug) ?? 0;
      e.used.set(slug, seen + 1);
      e.pendingSlug = seen === 0 ? slug : `${slug}-${seen}`;
      tokens[idx].attrSet('id', e.pendingSlug);
    }
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.heading_close = (tokens, idx, options, env, self) => {
    const e = env as RenderEnv;
    const anchor = e.pendingSlug
      ? `<a class="heading-anchor" href="#${e.pendingSlug}" aria-label="Permalink to this heading">#</a>`
      : '';
    e.pendingSlug = '';
    return anchor + self.renderToken(tokens, idx, options);
  };

  // Alert callouts and task lists are both a marker at the head of a
  // paragraph, so both are handled before inline parsing turns that paragraph
  // into children: rewriting `content` here is all it takes.
  md.core.ruler.before('inline', 'github_extras', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (
        token.type === 'blockquote_open' &&
        tokens[i + 1]?.type === 'paragraph_open' &&
        tokens[i + 2]?.type === 'inline'
      ) {
        const m = /^\[!(note|tip|important|warning|caution)\][ \t]*(\r?\n|$)/i.exec(tokens[i + 2].content);
        if (m) {
          const kind = m[1].toLowerCase();
          token.attrJoin('class', `alert alert-${kind}`);
          const rest = tokens[i + 2].content.slice(m[0].length);
          tokens[i + 2].content = rest;
          if (rest.trim() === '') {
            tokens[i + 1].hidden = true;
            tokens[i + 3].hidden = true;
          }
          const title = new state.Token('html_block', '', 0);
          title.content = `<p class="alert-title">${ALERTS[kind]}</p>\n`;
          tokens.splice(i + 1, 0, title);
          i += 1;
        }
        continue;
      }
      if (
        token.type === 'inline' &&
        tokens[i - 1]?.type === 'paragraph_open' &&
        tokens[i - 2]?.type === 'list_item_open'
      ) {
        const m = /^\[([ xX])\][ \t]+/.exec(token.content);
        if (m) {
          const checked = m[1].toLowerCase() === 'x' ? ' checked' : '';
          token.content = `<input type="checkbox" disabled${checked}> ${token.content.slice(m[0].length)}`;
          tokens[i - 2].attrJoin('class', 'task-item');
        }
      }
    }
  });

  return md;
}

// Built once, at load. Every render's state rides in the env instead.
const MD = buildMarkdownIt();

export function renderMarkdown(text: string, opts: MarkdownOpts): string {
  const env: RenderEnv = {
    opts,
    slots: [],
    // Random per render, so a document cannot forge a slot marker.
    marker: `md${crypto.randomBytes(9).toString('hex')}`,
    used: new Map(),
    pendingSlug: '',
  };
  const html = sanitizeHtml(MD.render(text, env), sanitizeOptions(opts));
  return html.replace(new RegExp(`${env.marker}_(\\d+)_`, 'g'), (_all, n: string) => env.slots[Number(n)] ?? '');
}
