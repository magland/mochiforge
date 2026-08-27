import * as crypto from 'crypto';
import { Express, Request, Response } from 'express';
import * as fs from 'fs';
import { GitRepo, isValidRefName, isValidRepoPath } from './git';
import { languageBreakdown } from './languages';
import { Gates } from './limit';
import { LfsContext } from './lfsstore';
import { isMarkdownFile, renderMarkdown } from './markdown';
import { ageInnerName, isAgeFile } from './agefile';
import { parsePointer } from './pointer';
import { collectionProfile } from './profile';
import { esc, highlightCode, isBinary } from './render';
import { atomFeed } from './atom';
import { latestRun } from './ci/runs';
import { renderDiff } from './diff';
import { collectionDir, repoPath } from './layout';
import { canAdminCollection, repoIsPrivate, repoRole } from './perms';
import { displayName, findRepo, isValidName, isValidUserName, listCollections, listRepoDirs, repoDescription, siteDir } from './scan';
import { countTopics, isValidTopic, repoTopics } from './topics';
import { Viewer, getViewer } from './session';
import { siteSettings } from './sitesettings';
import { serveSite, siteHostUrl, siteRedirectUrl } from './site';
import { loadVault, mergeContributors, userExists } from './vault';
import * as views from './views';
import { encPath, repoUrl } from './views';
import { LoadedRepo, ah, baseUrlOf, loadRepo, makeCtx, send404, sendBusy, wildcard } from './web';

const COMMITS_PER_PAGE = 35;
const MAX_RENDER_SIZE = 1024 * 1024;
const MAX_LISTED_COMMITS = 250;

const ARCHIVE_FORMATS: Record<string, { format: 'tar.gz' | 'zip'; type: string }> = {
  'tar.gz': { format: 'tar.gz', type: 'application/gzip' },
  tgz: { format: 'tar.gz', type: 'application/gzip' },
  zip: { format: 'zip', type: 'application/zip' },
};

export const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

export function registerBrowse(app: Express, root: string, gates: Gates, lfs: LfsContext | null = null): void {
  /**
   * What a listing says about one repository. The facts beyond the name come
   * from different places, so they are gathered once here and used by both
   * the front page and a collection's own. A private repository the viewer
   * has no role on is not listed at all, matching the 404 its page gives.
   */
  async function repoCards(req: Request, collection: string, viewer: Viewer | null): Promise<views.RepoCard[]> {
    const visible = listRepoDirs(root, collection).filter(
      (d) =>
        repoRole(root, viewer?.auth ?? null, {
          collection,
          name: displayName(d),
          dir: repoPath(root, collection, d),
        }) !== null
    );
    return Promise.all(
      visible.map(async (d) => {
        const name = displayName(d);
        const repo = new GitRepo(repoPath(root, collection, d), collection, name);
        // A repository with a site is linked straight to it from the listing,
        // at its own origin where it has one, so a visitor scanning a
        // collection reaches the published page without stopping at the
        // repository first. Only when the site is enabled: files on disk with
        // the switch off are not a site.
        const hasSite = siteSettings(repo.dir).enabled && siteDir(root, collection, name) !== null;
        const origin = hasSite ? siteHostUrl(root, req, collection, name) : null;
        const run = latestRun(root, collection, name);
        return {
          collection,
          name,
          description: repoDescription(repo.dir),
          topics: repoTopics(repo.dir),
          isPrivate: repoIsPrivate(repo.dir),
          updated: await repo.lastUpdated(),
          siteUrl: !hasSite
            ? null
            : origin
              ? `${origin}/`
              : `/${encodeURIComponent(collection)}/${encodeURIComponent(name)}/site/`,
          ci: run
            ? {
                conclusion: run.conclusion ?? null,
                running: run.status !== 'completed',
                url: `/${encodeURIComponent(collection)}/${encodeURIComponent(name)}/actions/runs/${run.number}`,
              }
            : null,
        };
      })
    );
  }

  // Newest first is the default: a listing is read to see what has been
  // happening, and only sometimes to find a name already known.
  function sortParam(req: Request): 'recent' | 'name' {
    return req.query.sort === 'name' ? 'name' : 'recent';
  }

  // The topic a listing is narrowed to. A value that is not a topic reads as
  // no narrowing rather than an error, the way an unknown sort does.
  function topicParam(req: Request): string {
    const t = typeof req.query.topic === 'string' ? req.query.topic : '';
    return isValidTopic(t) ? t : '';
  }

  /** The filter a listing page hands its view: what was chosen, and what there is to choose. */
  function topicFilter(cards: views.RepoCard[], topic: string): { filtered: views.RepoCard[]; filter: views.TopicFilter } {
    return {
      filtered: topic === '' ? cards : cards.filter((c) => (c.topics ?? []).includes(topic)),
      filter: { current: topic, inUse: countTopics(cards.map((c) => c.topics ?? [])) },
    };
  }

  app.get(
    '/',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const cardsPer = await Promise.all(listCollections(root).map((c) => repoCards(req, c.name, viewer)));
      // The counts beside collection names count what this viewer can see,
      // for the same reason the cards do.
      const collections = listCollections(root).map((c, i) => ({ name: c.name, repoCount: cardsPer[i].length }));
      const { filtered, filter } = topicFilter(cardsPer.flat(), topicParam(req));
      res.type('html').send(views.homePage(root, collections, filtered, sortParam(req), viewer, filter));
    })
  );

  // The vault's topics, and one topic's repositories. Registered before the
  // generic /:collection routes, and `topics` is a reserved name (see
  // src/scan.ts), so no collection can sit where these answer.
  app.get(
    '/topics',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const cardsPer = await Promise.all(listCollections(root).map((c) => repoCards(req, c.name, viewer)));
      const counts = countTopics(cardsPer.flat().map((c) => c.topics ?? []));
      res.type('html').send(views.topicsIndexPage(counts, viewer));
    })
  );

  app.get(
    '/topics/:topic',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const topic = req.params.topic;
      if (!isValidTopic(topic)) {
        send404(res, 'Not found', viewer);
        return;
      }
      const cardsPer = await Promise.all(listCollections(root).map((c) => repoCards(req, c.name, viewer)));
      const repos = cardsPer.flat().filter((c) => (c.topics ?? []).includes(topic));
      res.type('html').send(views.topicPage(topic, repos, sortParam(req), viewer));
    })
  );

  app.get('/about', (req, res) => {
    res.type('html').send(views.aboutPage(baseUrlOf(req), getViewer(req, root)));
  });

  app.get(
    '/:collection',
    ah(async (req, res) => {
      const collection = req.params.collection;
      const viewer = getViewer(req, root);
      let collectionIsDir = false;
      try {
        collectionIsDir = fs.statSync(collectionDir(root, collection)).isDirectory();
      } catch {
        collectionIsDir = false;
      }
      // A vault user's namespace page exists as soon as the user does: the
      // collection directory only appears with their first repository, and a
      // profile that 404s until then would say the user does not exist.
      const state = loadVault(root);
      const userRecord =
        isValidUserName(collection) && state.status === 'ok' ? (state.vault.users[collection] ?? null) : null;
      if (!isValidName(collection) || (!collectionIsDir && !userRecord)) {
        send404(res, `Collection ${collection} not found`, viewer);
        return;
      }
      // The profile lives in the .mochi repository, so a private one
      // introduces the collection only to viewers who could read it.
      const profileRepo = findRepo(root, collection, '.mochi');
      const profileVisible = profileRepo === null || repoRole(root, viewer?.auth ?? null, profileRepo) !== null;
      const [allCards, profile] = await Promise.all([
        collectionIsDir ? repoCards(req, collection, viewer) : Promise.resolve([]),
        profileVisible
          ? collectionProfile(root, collection)
          : Promise.resolve({ readme: null, addUrl: `/new?collection=${encodeURIComponent(collection)}` }),
      ]);
      const canSettings = collectionIsDir && viewer !== null && canAdminCollection(root, viewer.auth, collection);
      // What the page shows of the user behind the name. The links were held
      // to http(s) where the profile was saved; the filter here keeps a
      // hand-edited vault.json from linking the page anywhere else.
      const owner: views.ProfileOwner | null = userRecord
        ? {
            displayName: userRecord.profile?.name ?? null,
            bio: userRecord.profile?.bio ?? null,
            links: (userRecord.profile?.links ?? []).filter((l) => /^https?:\/\//i.test(l)),
            siteAdmin: userRecord.siteAdmin === true,
            isViewer: viewer !== null && viewer.auth.username === collection,
          }
        : null;
      const { filtered, filter } = topicFilter(allCards, topicParam(req));
      res
        .type('html')
        .send(views.collectionPage(collection, filtered, sortParam(req), viewer, canSettings, profile, owner, filter));
    })
  );

  async function renderTree(req: Request, res: Response, loaded: LoadedRepo, ref: string, treePath: string) {
    const viewer = getViewer(req, root);
    const ctx = await makeCtx(root, req, loaded, ref, viewer);
    let entries;
    try {
      entries = await loaded.repo.listTree(ref, treePath);
    } catch {
      send404(res, `Path ${treePath || '/'} not found at ${ref}`, viewer);
      return;
    }
    // The listing wants a commit per entry, which is a git log per entry: cheap
    // for the directory sizes people browse, and capped so that an unusually
    // wide one degrades into a listing without the message and age columns
    // rather than into a page that takes a second to build.
    const entryPaths = entries
      .slice(0, MAX_LISTED_COMMITS)
      .map((e) => (treePath === '' ? e.name : `${treePath}/${e.name}`));
    // The language breakdown reads the whole tree, so it is measured only at
    // the root, which is the only place the About panel that shows it appears.
    const [latest, entryCommits, commitCount, languages, contributors] = await Promise.all([
      loaded.repo.log(ref, 0, 1, treePath || undefined).then((cs) => cs[0] ?? null),
      loaded.repo.lastCommits(ref, entryPaths),
      loaded.repo.commitCount(ref).catch(() => 0),
      treePath === '' ? languageBreakdown(loaded.repo.dir, ref) : Promise.resolve([]),
      treePath === ''
        ? loaded.repo.contributors(ref).then((people) => {
            // One person, one face: a user's web edits carry a synthetic
            // author, and their listed emails are theirs too.
            const state = loadVault(root);
            return mergeContributors(state.status === 'ok' ? state.vault : null, people);
          })
        : Promise.resolve([]),
    ]);
    let readmeHtml: string | null = null;
    let readmeName: string | null = null;
    const readme = entries.find((e) => e.type === 'blob' && /^readme(\.(md|markdown|txt))?$/i.test(e.name));
    if (readme && (readme.size ?? 0) <= MAX_RENDER_SIZE) {
      const readmePath = treePath === '' ? readme.name : `${treePath}/${readme.name}`;
      const buf = await loaded.repo.catBlob(ref, readmePath);
      if (!isBinary(buf)) {
        const text = buf.toString('utf8');
        readmeName = readme.name;
        const base = repoUrl(ctx);
        const dirSuffix = treePath === '' ? '' : `/${encPath(treePath)}`;
        if (/\.(md|markdown)$/i.test(readme.name) || !readme.name.includes('.')) {
          readmeHtml = renderMarkdown(text, {
            rawBase: `${base}/raw/${encPath(ref)}${dirSuffix}`,
            blobBase: `${base}/blob/${encPath(ref)}${dirSuffix}`,
            issueBase: `${base}/issues`,
            commitBase: `${base}/commit`,
            mentions: (name) => userExists(root, name),
          });
        } else {
          readmeHtml = `<pre>${esc(text)}</pre>`;
        }
      }
    }
    res.type('html').send(
      views.treePage(ctx, {
        path: treePath,
        entries,
        entryCommits,
        latest,
        commitCount,
        description: repoDescription(loaded.repo.dir),
        topics: repoTopics(loaded.repo.dir),
        contributors,
        readmeHtml,
        readmeName,
        languages,
        msg: typeof req.query.msg === 'string' ? req.query.msg : undefined,
      })
    );
  }

  app.get(
    '/:collection/:repo',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      if (!loaded.defaultBranch) {
        res.type('html').send(views.emptyRepoPage(await makeCtx(root, req, loaded, '', viewer)));
        return;
      }
      await renderTree(req, res, loaded, loaded.defaultBranch, '');
    })
  );

  app.get(
    '/:collection/:repo/tree/*',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const { ref, path: treePath } = loaded.repo.resolveRefAndPath(wildcard(req), loaded.refNames);
      if (!isValidRefName(ref) || !isValidRepoPath(treePath)) {
        send404(res, 'Not found', viewer);
        return;
      }
      if (treePath !== '') {
        const type = await loaded.repo.entryType(ref, treePath);
        if (type === 'blob') {
          res.redirect(`${repoUrl(await makeCtx(root, req, loaded, ref, viewer))}/blob/${encPath(ref)}/${encPath(treePath)}`);
          return;
        }
      }
      await renderTree(req, res, loaded, ref, treePath);
    })
  );

  app.get(
    '/:collection/:repo/blob/*',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const { ref, path: filePath } = loaded.repo.resolveRefAndPath(wildcard(req), loaded.refNames);
      if (!isValidRefName(ref) || !isValidRepoPath(filePath) || filePath === '') {
        send404(res, 'Not found', viewer);
        return;
      }
      const ctx = await makeCtx(root, req, loaded, ref, viewer);
      const type = await loaded.repo.entryType(ref, filePath);
      if (type === 'tree') {
        res.redirect(`${repoUrl(ctx)}/tree/${encPath(ref)}/${encPath(filePath)}`);
        return;
      }
      if (type !== 'blob') {
        send404(res, `File ${filePath} not found at ${ref}`, viewer);
        return;
      }
      const buf = await loaded.repo.catBlob(ref, filePath);
      const ext = (filePath.split('.').pop() ?? '').toLowerCase();
      const rawUrl = `${repoUrl(ctx)}/raw/${encPath(ref)}/${encPath(filePath)}`;
      // LFS pointer detection precedes every content branch: an LFS-tracked
      // .md or .png must render as a download card, not as its pointer text.
      // ?plain=1 falls through to the source view, as on GitHub, keeping the
      // underlying pointer inspectable.
      const pointer = parsePointer(buf);
      if (pointer) {
        if (req.query.plain !== '1') {
          res
            .type('html')
            .send(
              views.blobPage(ctx, filePath, { kind: 'lfs', rawUrl, size: pointer.size, oid: pointer.oid }, true)
            );
          return;
        }
        // ?plain=1 shows the pointer itself, whatever the file is named: an
        // LFS-tracked .png must not be rendered from its pointer text as an
        // image, or the source view would be unreachable for it. Pointers are
        // never editable, so no edit controls here.
        const src = buf.toString('utf8');
        res.type('html').send(
          views.blobPage(
            ctx,
            filePath,
            {
              kind: 'code',
              html: esc(src),
              lineCount: src.replace(/\n$/, '').split('\n').length,
              size: buf.length,
              editable: false,
            },
            true
          )
        );
        return;
      }
      // An age ciphertext renders as a decrypt-in-the-browser card, whatever
      // its framing: armored files are text and binary ones are not, and the
      // card treats both alike. ?plain=1 falls through, so the armored source
      // is inspectable the way a markdown file's is.
      if (isAgeFile(filePath) && req.query.plain !== '1') {
        res.type('html').send(
          views.blobPage(ctx, filePath, {
            kind: 'age',
            rawUrl,
            size: buf.length,
            editable: ctx.canPush && ctx.refIsBranch,
            markdownInner: isMarkdownFile(ageInnerName(filePath)),
          })
        );
        return;
      }
      if (IMAGE_TYPES[ext]) {
        res.type('html').send(views.blobPage(ctx, filePath, { kind: 'image', rawUrl, size: buf.length }));
        return;
      }
      if (isBinary(buf)) {
        res.type('html').send(views.blobPage(ctx, filePath, { kind: 'binary', rawUrl, size: buf.length }));
        return;
      }
      if (buf.length > MAX_RENDER_SIZE) {
        res.type('html').send(views.blobPage(ctx, filePath, { kind: 'too-large', rawUrl, size: buf.length }));
        return;
      }
      const text = buf.toString('utf8');
      const editable = ctx.canPush && ctx.refIsBranch;
      const markdown = isMarkdownFile(filePath);
      // Markdown renders by default; ?plain=1 asks for the source, as on GitHub.
      if (markdown && req.query.plain !== '1') {
        const dir = filePath.includes('/') ? `/${encPath(filePath.slice(0, filePath.lastIndexOf('/')))}` : '';
        const html = renderMarkdown(text, {
          rawBase: `${repoUrl(ctx)}/raw/${encPath(ref)}${dir}`,
          blobBase: `${repoUrl(ctx)}/blob/${encPath(ref)}${dir}`,
          issueBase: `${repoUrl(ctx)}/issues`,
          commitBase: `${repoUrl(ctx)}/commit`,
          mentions: ctx.hasUser,
        });
        res
          .type('html')
          .send(views.blobPage(ctx, filePath, { kind: 'markdown', html, size: buf.length, editable }, true));
        return;
      }
      const html = highlightCode(text, filePath);
      const lineCount = text === '' ? 1 : text.replace(/\n$/, '').split('\n').length;
      res
        .type('html')
        .send(
          views.blobPage(ctx, filePath, { kind: 'code', html, lineCount, size: buf.length, editable }, markdown)
        );
    })
  );

  // Blame: who last changed each line, and the way back to the revision
  // before that change. Only for a file we would show as text anyway; the
  // rest redirect to the blob page, which explains what they are.
  app.get(
    '/:collection/:repo/blame/*',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const { ref, path: filePath } = loaded.repo.resolveRefAndPath(wildcard(req), loaded.refNames);
      if (!isValidRefName(ref) || !isValidRepoPath(filePath) || filePath === '') {
        send404(res, 'Not found', viewer);
        return;
      }
      const ctx = await makeCtx(root, req, loaded, ref, viewer);
      const blobUrl = `${repoUrl(ctx)}/blob/${encPath(ref)}/${encPath(filePath)}`;
      if ((await loaded.repo.entryType(ref, filePath)) !== 'blob') {
        send404(res, `File ${filePath} not found at ${ref}`, viewer);
        return;
      }
      const buf = await loaded.repo.catBlob(ref, filePath);
      if (isBinary(buf) || buf.length > MAX_RENDER_SIZE) {
        res.redirect(blobUrl);
        return;
      }
      const lines = await loaded.repo.blame(ref, filePath);
      const text = lines.map((l) => l.text).join('\n');
      res.type('html').send(views.blamePage(ctx, filePath, highlightCode(text, filePath), lines, buf.length));
    })
  );

  app.get(
    '/:collection/:repo/raw/*',
    ah(async (req, res) => {
      const loaded = await loadRepo(root, req, res, getViewer(req, root));
      if (!loaded) return;
      const { ref, path: filePath } = loaded.repo.resolveRefAndPath(wildcard(req), loaded.refNames);
      if (!isValidRefName(ref) || !isValidRepoPath(filePath) || filePath === '') {
        send404(res);
        return;
      }
      const type = await loaded.repo.entryType(ref, filePath);
      if (type !== 'blob') {
        res.status(404).type('text/plain').send('not found');
        return;
      }
      const buf = await loaded.repo.catBlob(ref, filePath);
      // A pointer blob redirects to the stored object; the filename gives the
      // browser something better to save than a 64-character object id.
      const pointer = parsePointer(buf);
      if (pointer && lfs) {
        const info = await lfs.store.head(loaded.repo.collection, loaded.repo.name, pointer.oid);
        if (!info) {
          res
            .status(404)
            .type('text/plain')
            .send(
              'This file is stored with Git LFS, but its object is missing from storage (the commits were pushed without pushing the LFS objects).\n'
            );
          return;
        }
        const dl = await lfs.store.signDownload(loaded.repo.collection, loaded.repo.name, pointer.oid, {
          filename: filePath.split('/').pop(),
        });
        res.redirect(302, dl.href);
        return;
      }
      // Reading a public repository is anonymous, so its raw files may be
      // cached publicly; the question is only for how long. A full commit id
      // can never come to name different bytes, so under one the answer is
      // forever. Under a branch or tag it is "until it changes", which HTTP
      // spells as revalidate every time: the ETag is a hash of the bytes
      // themselves, so an unchanged file costs a 304 and no body, whichever
      // commit now holds it. The pointer redirect above returns before this
      // on purpose: a redirect to a presigned URL expires and must not be
      // cached. A private repository's bytes were served to one reader and
      // must never come out of a shared cache for another.
      const cacheScope = repoIsPrivate(loaded.repo.dir) ? 'private' : 'public';
      if (/^[0-9a-f]{40}$/.test(ref)) {
        res.setHeader('Cache-Control', `${cacheScope}, max-age=31536000, immutable`);
      } else {
        res.setHeader('Cache-Control', `${cacheScope}, no-cache`);
        res.setHeader('ETag', `"${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32)}"`);
        if (req.fresh) {
          res.status(304).end();
          return;
        }
      }
      const ext = (filePath.split('.').pop() ?? '').toLowerCase();
      // Repository content must never be able to inject HTML into this
      // origin: non-image types are served as text/plain in a sandbox.
      res.setHeader('Content-Security-Policy', 'sandbox');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (IMAGE_TYPES[ext]) {
        res.type(IMAGE_TYPES[ext]);
      } else if (isBinary(buf)) {
        res.type('application/octet-stream');
      } else {
        res.type('text/plain; charset=utf-8');
      }
      res.send(buf);
    })
  );

  // Source downloads, as GitHub's Code button offers them: the extension on
  // the URL picks the format and the rest of it is the ref.
  app.get(
    '/:collection/:repo/archive/*',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const m = wildcard(req).match(/^(.+)\.(tar\.gz|tgz|zip)$/);
      if (!m) {
        send404(res, 'Ask for an archive as <ref>.tar.gz or <ref>.zip', viewer);
        return;
      }
      const [, ref, ext] = m;
      const spec = ARCHIVE_FORMATS[ext];
      // A ref this repository has, or a commit id: never an arbitrary
      // revision expression out of a URL.
      const known = loaded.refNames.includes(ref) || /^[0-9a-f]{7,40}$/.test(ref);
      const sha = isValidRefName(ref) && known ? await loaded.repo.resolve(ref) : null;
      if (!sha) {
        send404(res, `Ref ${ref} not found`, viewer);
        return;
      }
      // An archive is a subprocess and a stream, which is exactly what a 304
      // saves: the commit the ref resolves to determines every byte of the
      // archive, so it is the validator, checked before a slot is taken or
      // git is spawned. An archive of a full commit id is immutable outright.
      const cacheScope = repoIsPrivate(loaded.repo.dir) ? 'private' : 'public';
      if (ref === sha) {
        res.setHeader('Cache-Control', `${cacheScope}, max-age=31536000, immutable`);
      } else {
        res.setHeader('Cache-Control', `${cacheScope}, no-cache`);
        res.setHeader('ETag', `"${sha}"`);
        if (req.fresh) {
          res.status(304).end();
          return;
        }
      }
      // The slot is held until the stream ends, which is what the gate is for: an
      // archive holds a subprocess and a socket for as long as the client cares
      // to read.
      const release = await gates.tree.enter();
      if (!release) {
        sendBusy(res, viewer);
        return;
      }
      res.on('close', release);
      const stem = `${loaded.repo.name}-${ref.replace(/\//g, '-')}`;
      res.type(spec.type);
      res.setHeader('Content-Disposition', `attachment; filename="${stem}.${ext}"`);
      try {
        await loaded.repo.archiveTo(ref, spec.format, `${stem}/`, res);
        res.end();
      } catch {
        // The response is already streaming, so there is no status left to
        // send: break the connection rather than finish a truncated archive.
        res.destroy();
      } finally {
        release();
      }
    })
  );

  app.get('/:collection/:repo/commits', (req, res) => {
    res.redirect(`/${encodeURIComponent(req.params.collection)}/${encodeURIComponent(req.params.repo)}`);
  });

  app.get(
    '/:collection/:repo/commits/*',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      // A path after the ref narrows the history to that file or directory,
      // which is what the History button on a blob or tree page asks for.
      // A .atom suffix asks for the same history as a feed, as on GitHub.
      const asked = wildcard(req);
      const wantsFeed = asked.endsWith('.atom');
      const { ref, path: histPath } = loaded.repo.resolveRefAndPath(
        wantsFeed ? asked.slice(0, -'.atom'.length) : asked,
        loaded.refNames
      );
      if (!isValidRefName(ref) || !isValidRepoPath(histPath)) {
        send404(res, 'Not found', viewer);
        return;
      }
      const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
      // An author narrows it further: this is where a contributor in the
      // About panel leads, and it is a literal string rather than a pattern.
      const author = String(req.query.author ?? '').slice(0, 200) || undefined;
      let total: number;
      try {
        total = await loaded.repo.commitCount(ref, histPath || undefined, author);
      } catch {
        send404(res, `Ref ${ref} not found`, viewer);
        return;
      }
      const totalPages = Math.max(1, Math.ceil(total / COMMITS_PER_PAGE));
      const commits = await loaded.repo.log(
        ref,
        (page - 1) * COMMITS_PER_PAGE,
        COMMITS_PER_PAGE,
        histPath || undefined,
        author
      );
      if (wantsFeed) {
        const site = `${baseUrlOf(req)}/${encodeURIComponent(loaded.repo.collection)}/${encodeURIComponent(
          loaded.repo.name
        )}`;
        const where = `${encPath(ref)}${histPath ? `/${encPath(histPath)}` : ''}`;
        res.type('application/atom+xml; charset=utf-8').send(
          atomFeed({
            id: `${site}/commits/${where}`,
            title: `${loaded.repo.collection}/${loaded.repo.name}${histPath ? `: ${histPath}` : ''} at ${ref}`,
            selfLink: `${site}/commits/${where}.atom`,
            htmlLink: `${site}/commits/${where}`,
            entries: commits.map((c) => ({
              id: `${site}/commit/${c.sha}`,
              title: c.subject,
              updated: c.date,
              link: `${site}/commit/${c.sha}`,
              author: c.author,
            })),
          })
        );
        return;
      }
      res
        .type('html')
        .send(
          views.commitsPage(await makeCtx(root, req, loaded, ref, viewer), histPath, commits, page, totalPages, total, author)
        );
    })
  );

  app.get(
    '/:collection/:repo/commit/:sha',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const sha = req.params.sha;
      if (!/^[0-9a-f]{4,40}$/i.test(sha)) {
        send404(res, 'Not found', viewer);
        return;
      }
      const detail = await loaded.repo.commit(sha);
      if (!detail) {
        send404(res, `Commit ${sha} not found`, viewer);
        return;
      }
      const patch = await loaded.repo.commitPatch(detail.sha);
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? detail.sha, viewer);
      res
        .type('html')
        .send(views.commitPage(ctx, detail, renderDiff(patch, { blobBase: `${repoUrl(ctx)}/blob/${detail.sha}` })));
    })
  );

  app.get(
    '/:collection/:repo/branches',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      res.type('html').send(views.refListPage(ctx, 'branches'));
    })
  );

  app.get(
    '/:collection/:repo/tags',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      res.type('html').send(views.refListPage(ctx, 'tags'));
    })
  );

  // Sites are served through src/site.ts, which both this route and the
  // per-site hostname share. The mode is what differs: on the forge's own
  // origin a site is sandboxed, because its script would otherwise run as the
  // visitor.
  //
  // When the vault has a sites host and this repository is eligible for one,
  // the site lives at its own origin and this path only points there. 302 and
  // not 301: a permanent redirect would be cached hard, and removing
  // sites.host from config.json must take effect on the next request.
  app.get('/:collection/:repo/site/*', (req, res) => {
    const origin = siteRedirectUrl(root, req, req.params.collection, displayName(req.params.repo));
    if (origin) {
      const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      res.redirect(302, `${origin}/${wildcard(req)}${query}`);
      return;
    }
    serveSite(root, req.params.collection, req.params.repo, req, res, 'sandbox');
  });

  // The missing-slash redirect lands on the site origin in one hop rather than
  // two when there is one.
  app.get('/:collection/:repo/site', (req, res) => {
    const origin = siteRedirectUrl(root, req, req.params.collection, displayName(req.params.repo));
    if (origin) {
      res.redirect(302, `${origin}/`);
      return;
    }
    res.redirect(
      `/${encodeURIComponent(req.params.collection)}/${encodeURIComponent(displayName(req.params.repo))}/site/`
    );
  });
}
