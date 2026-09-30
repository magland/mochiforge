import { createHash } from 'crypto';
import { Express } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { ageScript } from './agescript';
import { faviconSvg } from './logo';
import { pageScript } from './pagescript';
import { CSS } from './style';
import { Theme, activeTheme, allThemeVarsCss, findTheme } from './themes';

/**
 * The forge's stylesheet, with a tag naming this exact body.
 *
 * The sheet is 76 KB and every page links it, so what it costs is decided by
 * whether the browser may keep it. It used to say `no-cache`, which bought a
 * conditional request on every navigation -- 304 at best, and a round trip
 * before anything could be painted. The tag ends that: it is a hash of the
 * bytes, so a changed theme or an edited style.ts changes the URL, and any URL
 * that carries the right tag can be kept for good.
 *
 * Built once per theme rather than per request, which also stops the 76 KB
 * concatenation from happening on every hit.
 */
const sheets = new Map<string, { body: string; tag: string }>();

export function styleSheet(theme: Theme): { body: string; tag: string } {
  const made = sheets.get(theme.name);
  if (made) return made;
  const body = allThemeVarsCss(theme) + CSS;
  const sheet = { body, tag: createHash('sha256').update(body).digest('hex').slice(0, 12) };
  sheets.set(theme.name, sheet);
  return sheet;
}

/**
 * The routes for what every page links: the stylesheet, the page script, the
 * encrypted-file script, the code colours, KaTeX's stylesheet and fonts, and
 * the favicon. They are registered by the forge's server, and by a sibling
 * application built on these modules (see src/naming.ts), whose pages come
 * from the same layout and so link the same files. `favicon` is the one piece
 * a sibling draws for itself.
 */
export function registerAssets(app: Express, opts: { favicon?: () => string } = {}): void {
  const favicon = opts.favicon ?? (() => faviconSvg());
  const hlCache = new Map<string, string>();
  app.get('/assets/style.css', (req, res) => {
    const sheet = styleSheet(activeTheme());
    // A request that names the body it wants may keep it forever, because a
    // different body would be a different tag and so a different URL. One that
    // does not -- an old page still in a tab, or someone typing the path --
    // gets the current sheet and no licence to hold on to it.
    const fresh = String(req.query.v ?? '') === sheet.tag;
    res
      .type('text/css')
      .set('Cache-Control', fresh ? 'public, max-age=31536000, immutable' : 'no-cache')
      .send(sheet.body);
  });
  // The page script, on the same terms as the stylesheet above: a request that
  // names the body it wants may keep it forever, since a different body would
  // be a different tag and so a different URL.
  app.get('/assets/page.js', (req, res) => {
    const script = pageScript();
    const fresh = String(req.query.v ?? '') === script.tag;
    res
      .type('text/javascript')
      .set('Cache-Control', fresh ? 'public, max-age=31536000, immutable' : 'no-cache')
      .set('X-Content-Type-Options', 'nosniff')
      .send(script.body);
  });
  // The encrypted-file script, on the same terms again. It is ~300 KB of
  // vendored cryptography plus its glue, which is why only the pages that
  // need it link it (see PageOpts.ageScript) and why the immutable caching
  // matters more here than anywhere.
  app.get('/assets/age.js', (req, res) => {
    const script = ageScript();
    const fresh = String(req.query.v ?? '') === script.tag;
    res
      .type('text/javascript')
      .set('Cache-Control', fresh ? 'public, max-age=31536000, immutable' : 'no-cache')
      .set('X-Content-Type-Options', 'nosniff')
      .send(script.body);
  });
  app.get('/assets/hl.css', (req, res) => {
    // Code colours are a whole stylesheet rather than a set of tokens, so the
    // reader's theme picks a file instead of an attribute. The name still
    // comes from the theme table and never from the request: ?t= selects a
    // theme by name, and an unknown one falls back to the vault's.
    const name = (findTheme(String(req.query.t ?? '')) ?? activeTheme()).hljs;
    let css = hlCache.get(name);
    if (css === undefined) {
      try {
        css = fs.readFileSync(require.resolve(`highlight.js/styles/${name}.css`), 'utf8');
      } catch {
        css = '';
      }
      hlCache.set(name, css);
    }
    res.type('text/css').set('Cache-Control', 'public, max-age=86400').send(css);
  });
  // KaTeX ships the stylesheet and fonts its output needs; serving them from
  // the installed package keeps rendered math working with no external
  // requests, which matters for vaults on closed networks.
  const katexDir = path.dirname(require.resolve('katex/dist/katex.min.css'));
  let katexCss: string | null = null;
  app.get('/assets/katex/katex.css', (_req, res) => {
    if (katexCss === null) katexCss = fs.readFileSync(path.join(katexDir, 'katex.min.css'), 'utf8');
    res.type('text/css').set('Cache-Control', 'public, max-age=86400').send(katexCss);
  });
  app.get('/assets/katex/fonts/:file', (req, res) => {
    // The request never reaches the filesystem unless it names a KaTeX font.
    if (!/^KaTeX_[A-Za-z0-9]+-[A-Za-z]+\.(woff2|woff|ttf)$/.test(req.params.file)) {
      res.status(404).end();
      return;
    }
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(path.join(katexDir, 'fonts', req.params.file));
  });
  // The favicon is the logo mark on a tile coloured from the active theme, so
  // it changes with the vault's appearance. Browsers that will not take an SVG
  // icon fall back to /favicon.ico, which stays empty.
  app.get('/favicon.svg', (_req, res) => {
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(favicon());
  });
  app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });
}
