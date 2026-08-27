import { Express, Response } from 'express';
import { CiEngine } from '../ci/engine';
import { firePush } from '../ci/trigger';
import { isValidNewRefName, isValidRefName, isValidRepoPath } from '../git';
import { AuthLimiter } from '../limit';
import { LfsContext } from '../lfsstore';
import {
  FileAction,
  MAX_EDIT_SIZE,
  MAX_UPLOAD_SIZE,
  NewBranchError,
  OpError,
  UploadedFile,
  collectRepo,
  commitFiles,
  createBranch,
  createRepoWithReadme,
  createTag,
  deleteBranch,
  deleteRepo,
  deleteTag,
  forkRepo,
  RepoContext,
  opErrorStatus,
  renameRepo,
  setDefaultBranch,
  setDescription,
  setUpstream,
  writeFile,
} from '../ops';
import {
  canAdminRepo,
  canCreateRepo,
  collectionOwners,
  isSiteAdmin,
  removeCollaborator,
  repoAccess,
  repoIsPrivate,
  repoRenameBlocker,
  setCollaborator,
  setRepoPrivate,
} from '../perms';
import { clearRepoDomain, repoDomain, setRepoDomain } from '../domains';
import { findRepo, isValidName, reservedRepoSuffix, upstreamOf } from '../scan';
import { editSiteSettings, isUsableSiteLabel, siteLabelConflict, siteSettings } from '../sitesettings';
import { repoTopics, setTopics } from '../topics';
import { loadVault } from '../vault';
import {
  Actor,
  ReadContext,
  WriteContext,
  apiError,
  bodyOf,
  requireApiAuth,
  requirePush,
  requireRepo,
  requireRepoAdmin,
  sendOpError,
  stringField,
  stringsField,
} from './auth';

// Writing a repository over the API: files, commits, branches, tags, and the
// repository itself.
//
// Every write here fires the CI push event the web handlers fire. A commit made
// over the API is a push as far as workflows are concerned, and forgetting that
// would be a silent, confusing divergence between the two interfaces: the same
// change would run CI through one door and not the other.

/** The write body, as both the single-file and multi-file routes accept it. */
interface WriteBody {
  branch: string;
  message: string;
  expectedSha: string | null;
  newBranch: string | null;
}

function writeBody(body: Record<string, unknown>, fallbackMessage: string): WriteBody | string {
  const branch = stringField(body, 'branch');
  if (branch === null || !isValidRefName(branch)) return '"branch" is required and must be a usable branch name';
  const newBranch = stringField(body, 'newBranch');
  if (newBranch !== null && !isValidNewRefName(newBranch)) return '"newBranch" is not a usable branch name';
  const expectedSha = stringField(body, 'expectedSha');
  return {
    branch,
    message: stringField(body, 'message')?.trim() || fallbackMessage,
    expectedSha,
    newBranch,
  };
}

/**
 * Decode a file's content. base64 for anything that is not text, which is how a
 * caller sends an image or a fixture through a JSON body.
 */
function decodeContent(body: Record<string, unknown>, res: Response): Buffer | null {
  const content = stringField(body, 'content');
  if (content === null) {
    apiError(res, 400, '"content" is required');
    return null;
  }
  const encoding = stringField(body, 'encoding') ?? 'utf-8';
  if (encoding !== 'utf-8' && encoding !== 'base64') {
    apiError(res, 400, '"encoding" must be "utf-8" or "base64"');
    return null;
  }
  const buf = Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8');
  if (buf.length > MAX_EDIT_SIZE) {
    apiError(res, 413, `a single file may be at most ${MAX_EDIT_SIZE} bytes; push anything larger, or use Git LFS`);
    return null;
  }
  return buf;
}

/** The wildcard tail of a route path. */
function tail(req: { params: Record<string, unknown> }): string {
  return (req.params as Record<string, string>)['0'] ?? '';
}

/**
 * The branch tip the write will be guarded against. When the caller supplied an
 * expectedSha it is theirs; otherwise the write is unconditional and takes
 * whatever the branch is at now, which is what an unguarded write means.
 */
async function baseFor(ctx: ReadContext, body: WriteBody): Promise<string | null> {
  if (body.expectedSha) {
    // A sha that names no commit here cannot be what the caller last saw, so it
    // is refused as a stale expectation rather than handed to git, which would
    // fail in a way that reads as the server breaking.
    if (!(await ctx.repo.resolve(body.expectedSha))) {
      throw new OpError(
        `no commit ${body.expectedSha} in this repository; re-read the file and try again`,
        'conflict'
      );
    }
    return body.expectedSha;
  }
  const branches = await ctx.repo.listRefs('heads');
  return branches.find((b) => b.name === body.branch)?.sha ?? null;
}

function reportWriteError(res: Response, e: unknown): void {
  // A branch that could not be made is not a file that could not be written.
  if (e instanceof NewBranchError) {
    apiError(res, opErrorStatus(e.kind), e.message);
    return;
  }
  sendOpError(res, e, 'the write failed');
}

export function registerWriteApi(
  app: Express,
  root: string,
  limiter: AuthLimiter,
  lfs: LfsContext | null = null,
  engine?: CiEngine
): void {
  // As in registerWebOps: one context for the operations that move or remove a
  // repository, so both surfaces carry the same things across.
  const repoCtx: RepoContext = { lfs: lfs?.store, runs: engine };

  const fire = (ctx: WriteContext, branch: string, before: string | null, after: string, actor: Actor) =>
    firePush(root, engine, { collection: ctx.repo.collection, name: ctx.repo.name }, branch, before, after, actor.username);

  // ---- files ----

  // PUT creates or updates, because a caller that has read a file and means to
  // change it should not have to know which of the two it is doing. The action
  // kind is decided from whether the path is there now.
  app.put('/api/repos/:collection/:repo/contents/*', async (req, res) => {
    const ctx = requirePush(root, limiter, req, res);
    if (!ctx) return;
    const filePath = tail(req);
    if (filePath === '' || !isValidRepoPath(filePath)) {
      apiError(res, 400, 'that is not a usable path');
      return;
    }
    const body = bodyOf(req);
    const parsed = writeBody(body, `Update ${filePath.split('/').pop()}`);
    if (typeof parsed === 'string') {
      apiError(res, 400, parsed);
      return;
    }
    const content = decodeContent(body, res);
    if (!content) return;
    try {
      const base = await baseFor(ctx, parsed);
      const exists = base !== null && (await ctx.repo.entryType(base, filePath)) === 'blob';
      const action: FileAction = exists ? { kind: 'edit', content } : { kind: 'create', content };
      const written = await writeFile(ctx.repo.dir, {
        branch: parsed.branch,
        newBranch: parsed.newBranch,
        filePath,
        message: parsed.message,
        author: { name: ctx.actor.username, email: ctx.actor.email },
        expectedHead: base,
        action,
      });
      fire(ctx, written.branch, written.before, written.sha, ctx.actor);
      res.json({ branch: written.branch, sha: written.sha, path: filePath, created: !exists });
    } catch (e) {
      reportWriteError(res, e);
    }
  });

  app.delete('/api/repos/:collection/:repo/contents/*', async (req, res) => {
    const ctx = requirePush(root, limiter, req, res);
    if (!ctx) return;
    const filePath = tail(req);
    if (filePath === '' || !isValidRepoPath(filePath)) {
      apiError(res, 400, 'that is not a usable path');
      return;
    }
    const body = bodyOf(req);
    const parsed = writeBody(body, `Delete ${filePath.split('/').pop()}`);
    if (typeof parsed === 'string') {
      apiError(res, 400, parsed);
      return;
    }
    try {
      const written = await writeFile(ctx.repo.dir, {
        branch: parsed.branch,
        newBranch: parsed.newBranch,
        filePath,
        message: parsed.message,
        author: { name: ctx.actor.username, email: ctx.actor.email },
        expectedHead: await baseFor(ctx, parsed),
        action: { kind: 'delete' },
      });
      fire(ctx, written.branch, written.before, written.sha, ctx.actor);
      res.json({ branch: written.branch, sha: written.sha, path: filePath, deleted: true });
    } catch (e) {
      reportWriteError(res, e);
    }
  });

  // Several files as one commit, which is what a caller changing three files as
  // one logical edit wants, and what the upload route already does underneath.
  app.post('/api/repos/:collection/:repo/commits', async (req, res) => {
    const ctx = requirePush(root, limiter, req, res);
    if (!ctx) return;
    const body = bodyOf(req);
    const parsed = writeBody(body, 'Update files');
    if (typeof parsed === 'string') {
      apiError(res, 400, parsed);
      return;
    }
    const rawFiles = body.files;
    if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
      apiError(res, 400, '"files" must be a non-empty list');
      return;
    }
    const writes: UploadedFile[] = [];
    const removals: string[] = [];
    let total = 0;
    for (const raw of rawFiles) {
      if (typeof raw !== 'object' || raw === null) {
        apiError(res, 400, 'each entry of "files" must be an object');
        return;
      }
      const entry = raw as Record<string, unknown>;
      const filePath = stringField(entry, 'path');
      if (filePath === null || filePath === '' || !isValidRepoPath(filePath)) {
        apiError(res, 400, `"${String(entry.path)}" is not a usable path`);
        return;
      }
      if (entry.delete === true) {
        removals.push(filePath);
        continue;
      }
      const content = decodeContent(entry, res);
      if (!content) return;
      total += content.length;
      if (total > MAX_UPLOAD_SIZE) {
        apiError(res, 413, `one commit may carry at most ${MAX_UPLOAD_SIZE} bytes; push anything larger`);
        return;
      }
      writes.push({ path: filePath, content });
    }
    try {
      let branch = parsed.branch;
      const base = await baseFor(ctx, parsed);
      if (parsed.newBranch) {
        if (base === null) {
          apiError(res, 400, 'there is nothing to branch from yet; commit to this branch first');
          return;
        }
        await createBranch(ctx.repo.dir, parsed.newBranch, base);
        branch = parsed.newBranch;
      }
      const sha = await commitFiles(ctx.repo.dir, {
        branch,
        message: parsed.message,
        author: { name: ctx.actor.username, email: ctx.actor.email },
        expectedHead: base,
        files: writes,
        removals,
      });
      fire(ctx, branch, base, sha, ctx.actor);
      res.json({ branch, sha, files: writes.length, removed: removals.length });
    } catch (e) {
      reportWriteError(res, e);
    }
  });

  // ---- branches and tags ----
  //
  // Deletion takes the name as a wildcard, because a ref name may contain
  // slashes and one path segment could not hold `release/1.0`.

  app.post('/api/repos/:collection/:repo/branches', async (req, res) => {
    const ctx = requirePush(root, limiter, req, res);
    if (!ctx) return;
    const body = bodyOf(req);
    const name = stringField(body, 'name');
    const from = stringField(body, 'from');
    if (name === null || from === null) {
      apiError(res, 400, '"name" and "from" are required');
      return;
    }
    try {
      await createBranch(ctx.repo.dir, name, from);
      const sha = await ctx.repo.resolve(name);
      res.status(201).json({ name, sha });
    } catch (e) {
      sendOpError(res, e, 'could not create the branch');
    }
  });

  app.delete('/api/repos/:collection/:repo/branches/*', async (req, res) => {
    const ctx = requirePush(root, limiter, req, res);
    if (!ctx) return;
    const name = tail(req);
    if (!isValidRefName(name)) {
      apiError(res, 400, 'that is not a usable branch name');
      return;
    }
    try {
      await deleteBranch(ctx.repo.dir, name);
      res.json({ deleted: name });
    } catch (e) {
      sendOpError(res, e, 'could not delete the branch');
    }
  });

  app.post('/api/repos/:collection/:repo/tags', async (req, res) => {
    const ctx = requirePush(root, limiter, req, res);
    if (!ctx) return;
    const body = bodyOf(req);
    const name = stringField(body, 'name');
    const at = stringField(body, 'at');
    if (name === null || at === null) {
      apiError(res, 400, '"name" and "at" are required');
      return;
    }
    try {
      await createTag(ctx.repo.dir, name, at);
      res.status(201).json({ name, sha: await ctx.repo.resolve(name) });
    } catch (e) {
      sendOpError(res, e, 'could not create the tag');
    }
  });

  app.delete('/api/repos/:collection/:repo/tags/*', async (req, res) => {
    const ctx = requirePush(root, limiter, req, res);
    if (!ctx) return;
    const name = tail(req);
    if (!isValidRefName(name)) {
      apiError(res, 400, 'that is not a usable tag name');
      return;
    }
    try {
      await deleteTag(ctx.repo.dir, name);
      res.json({ deleted: name });
    } catch (e) {
      sendOpError(res, e, 'could not delete the tag');
    }
  });

  // ---- the repository itself ----

  app.post('/api/repos', async (req, res) => {
    const auth = requireApiAuth(root, limiter, req, res);
    if (!auth) return;
    const body = bodyOf(req);
    const collection = stringField(body, 'collection');
    const name = stringField(body, 'name');
    if (collection === null || name === null || !isValidName(collection) || !isValidName(name)) {
      apiError(res, 400, 'a valid "collection" and "name" are required (letters, digits, dot, underscore, dash)');
      return;
    }
    const reserved = reservedRepoSuffix(name);
    if (reserved) {
      apiError(res, 400, `a repository name may not end in ${reserved}, which is reserved for the directories a repository keeps beside it`);
      return;
    }
    if (!canCreateRepo(root, auth, collection, name)) {
      apiError(res, 403, `you are not allowed to create repositories in ${collection}`);
      return;
    }
    if (findRepo(root, collection, name)) {
      apiError(res, 409, `repository ${collection}/${name} already exists`);
      return;
    }
    if (body.private !== undefined && typeof body.private !== 'boolean') {
      apiError(res, 400, '"private" must be a boolean');
      return;
    }
    const host = (req.get('host') ?? 'localhost').replace(/:\d+$/, '');
    try {
      const created = await createRepoWithReadme(root, collection, name, {
        description: stringField(body, 'description') ?? '',
        readme: body.initReadme === true,
        private: body.private === true,
        author: { name: auth.username, email: `${auth.username}@noreply.${host}` },
      });
      if (created.sha) {
        firePush(root, engine, { collection, name }, 'main', null, created.sha, auth.username);
      }
      res.status(201).json({ collection, name, created: true, private: body.private === true, sha: created.sha });
    } catch (e) {
      sendOpError(res, e, 'could not create the repository');
    }
  });

  app.post('/api/repos/:collection/:repo/fork', async (req, res) => {
    // Reading the source is what forking needs; creating the fork needs
    // permission to create where it lands, which is checked below rather than
    // here.
    const source = requireRepo(root, limiter, req, res);
    if (!source) return;
    const body = bodyOf(req);
    const collection = stringField(body, 'collection');
    const name = stringField(body, 'name') ?? source.repo.name;
    if (collection === null || !isValidName(collection) || !isValidName(name)) {
      apiError(res, 400, 'a valid "collection" is required');
      return;
    }
    if (!canCreateRepo(root, source.auth, collection, name)) {
      apiError(res, 403, `you are not allowed to create repositories in ${collection}`);
      return;
    }
    try {
      await forkRepo(root, source.repo.collection, source.repo.name, collection, name);
      res.status(201).json({ collection, name, forkedFrom: { collection: source.repo.collection, repo: source.repo.name } });
    } catch (e) {
      sendOpError(res, e, 'could not fork the repository');
    }
  });

  app.patch('/api/repos/:collection/:repo', async (req, res) => {
    const ctx = requirePush(root, limiter, req, res);
    if (!ctx) return;
    const body = bodyOf(req);
    const description = stringField(body, 'description');
    const defaultBranch = stringField(body, 'defaultBranch');
    const upstream = stringField(body, 'upstream');
    const topics = stringsField(body, 'topics');
    if (topics === null) {
      apiError(res, 400, '"topics" must be a list of strings');
      return;
    }
    const priv = body.private;
    if (priv !== undefined && typeof priv !== 'boolean') {
      apiError(res, 400, '"private" must be a boolean');
      return;
    }
    const siteEnabled = body.siteEnabled;
    if (siteEnabled !== undefined && typeof siteEnabled !== 'boolean') {
      apiError(res, 400, '"siteEnabled" must be a boolean');
      return;
    }
    const siteSource = body.siteSource;
    if (siteSource !== undefined && siteSource !== 'copy' && siteSource !== 'actions') {
      apiError(res, 400, '"siteSource" must be "copy" or "actions"');
      return;
    }
    const siteLabel = stringField(body, 'siteLabel');
    if (siteLabel !== null && siteLabel !== '' && !isUsableSiteLabel(siteLabel)) {
      apiError(
        res,
        400,
        'a site label is lowercase letters, digits, and single interior hyphens, at most 63 characters'
      );
      return;
    }
    const siteDomain = stringField(body, 'siteDomain');
    const changingSite = siteEnabled !== undefined || siteSource !== undefined || siteLabel !== null;
    if (
      description === null &&
      defaultBranch === null &&
      upstream === null &&
      topics === undefined &&
      priv === undefined &&
      !changingSite &&
      siteDomain === null
    ) {
      apiError(
        res,
        400,
        'nothing to change; provide "description", "defaultBranch", "upstream", "topics", "private", "siteEnabled", "siteSource", "siteLabel", and/or "siteDomain"'
      );
      return;
    }
    // Visibility takes the admin role rather than write: publishing a
    // repository, or withdrawing one from everybody who could see it, is the
    // repository's own business the way deleting it is. The site settings are
    // on the same footing, since enabling a site publishes what the directory
    // holds to everyone.
    if ((priv !== undefined || changingSite) && !canAdminRepo(root, ctx.auth, ctx.repo)) {
      apiError(res, 403, `changing visibility or site settings needs the admin role on ${ctx.repo.collection}/${ctx.repo.name}`);
      return;
    }
    // A custom domain is the operator's act: the operator points DNS at the
    // vault and covers the name with a certificate, so attaching one takes a
    // site admin, not merely the repository's.
    if (siteDomain !== null && !isSiteAdmin(ctx.auth)) {
      apiError(res, 403, 'attaching a custom domain takes a site admin');
      return;
    }
    if (siteLabel !== null && siteLabel !== '') {
      const holder = siteLabelConflict(root, siteLabel, ctx.repo.collection, ctx.repo.name);
      if (holder) {
        apiError(res, 409, `the label ${siteLabel} is already used by ${holder}`);
        return;
      }
    }
    if (siteDomain !== null && siteDomain !== '') {
      const problem = setRepoDomain(root, ctx.repo.collection, ctx.repo.name, siteDomain);
      if (problem) {
        apiError(res, problem.kind === 'conflict' ? 409 : 400, problem.message);
        return;
      }
    }
    if (siteDomain === '') clearRepoDomain(root, ctx.repo.collection, ctx.repo.name);
    try {
      if (description !== null) setDescription(ctx.repo.dir, description);
      if (defaultBranch !== null) await setDefaultBranch(ctx.repo.dir, defaultBranch);
      if (upstream !== null) await setUpstream(ctx.repo.dir, upstream);
      if (topics !== undefined) setTopics(ctx.repo.dir, topics);
      if (priv !== undefined) setRepoPrivate(ctx.repo.dir, priv);
      if (changingSite) {
        editSiteSettings(ctx.repo.dir, (s) => {
          if (siteEnabled !== undefined) s.enabled = siteEnabled;
          if (siteSource !== undefined) s.source = siteSource;
          if (siteLabel !== null) s.label = siteLabel;
        });
      }
      const branches = await ctx.repo.listRefs('heads');
      const settings = siteSettings(ctx.repo.dir);
      res.json({
        collection: ctx.repo.collection,
        name: ctx.repo.name,
        defaultBranch: await ctx.repo.defaultBranch(branches),
        upstream: upstreamOf(ctx.repo.dir)?.url ?? null,
        topics: repoTopics(ctx.repo.dir),
        private: repoIsPrivate(ctx.repo.dir),
        site: {
          enabled: settings.enabled,
          source: settings.source,
          label: settings.label === '' ? null : settings.label,
          domain: repoDomain(root, ctx.repo.collection, ctx.repo.name),
        },
        changed: true,
      });
    } catch (e) {
      sendOpError(res, e, 'could not change the settings');
    }
  });

  // Renaming and deleting are the two operations the web puts behind a typed
  // confirmation, so they take the admin role on the repository rather than write.
  app.post('/api/repos/:collection/:repo/rename', async (req, res) => {
    const ctx = requireRepoAdmin(root, limiter, req, res);
    if (!ctx) return;
    const body = bodyOf(req);
    const name = stringField(body, 'name') ?? ctx.repo.name;
    const collection = stringField(body, 'collection') ?? ctx.repo.collection;
    if (!isValidName(name) || !isValidName(collection)) {
      apiError(res, 400, '"name" and "collection" must be usable names');
      return;
    }
    // The same rule the web settings page applies: admin on what is moving
    // (which requireRepoAdmin has established), and for a move to another
    // collection, permission to create over there.
    const blocker = repoRenameBlocker(root, ctx.auth, ctx.repo, collection, name);
    if (blocker) {
      apiError(res, 403, `renaming this repository needs ${blocker}`);
      return;
    }
    try {
      await renameRepo(root, ctx.repo.collection, ctx.repo.name, collection, name, repoCtx);
      res.json({ collection, name, renamed: true });
    } catch (e) {
      sendOpError(res, e, 'could not rename the repository');
    }
  });

  // Collecting a repository now, rather than waiting for the sweep in
  // src/maintenance.ts to reach it. It takes the admin role and the same typed
  // confirmation deletion takes, because what it removes is unrecoverable:
  // everything no ref can reach, which is exactly what a person who has just
  // rewritten a history away is asking for, and exactly what someone who
  // mistook this for a repack is not.
  app.post('/api/repos/:collection/:repo/gc', async (req, res) => {
    const ctx = requireRepoAdmin(root, limiter, req, res);
    if (!ctx) return;
    const full = `${ctx.repo.collection}/${ctx.repo.name}`;
    if (String(req.query.confirm ?? '') !== full) {
      apiError(res, 400, `to drop every unreachable object in this repository, send ?confirm=${full}`);
      return;
    }
    try {
      const { before, after } = await collectRepo(ctx.repo.dir);
      res.json({
        repo: full,
        before,
        after,
        removed: Math.max(0, before.objects - after.objects),
        kilobytesFreed: Math.max(0, before.kilobytes - after.kilobytes),
      });
    } catch (e) {
      sendOpError(res, e, 'could not collect the repository');
    }
  });

  // ?confirm= is the API's equivalent of the web's typed confirmation. It costs
  // nothing and it makes an accidental DELETE from a loop over a listing
  // impossible.
  app.delete('/api/repos/:collection/:repo', async (req, res) => {
    const ctx = requireRepoAdmin(root, limiter, req, res);
    if (!ctx) return;
    const full = `${ctx.repo.collection}/${ctx.repo.name}`;
    if (String(req.query.confirm ?? '') !== full) {
      apiError(res, 400, `to delete this repository and everything beside it, send ?confirm=${full}`);
      return;
    }
    try {
      await deleteRepo(root, ctx.repo.collection, ctx.repo.name, repoCtx);
      res.json({ deleted: full });
    } catch (e) {
      sendOpError(res, e, 'could not delete the repository');
    }
  });

  // ---- collaborators ----

  // All three take the admin role on the repository: who may see or write a
  // repository is decided by the people who administer it, and the list of
  // who those people are is itself not public.

  app.get('/api/repos/:collection/:repo/collaborators', (req, res) => {
    const ctx = requireRepoAdmin(root, limiter, req, res);
    if (!ctx) return;
    const access = repoAccess(ctx.repo.dir);
    res.json({
      collaborators: Object.entries(access.collaborators).map(([username, role]) => ({ username, role })),
      owners: collectionOwners(root, ctx.repo.collection),
      private: access.private,
    });
  });

  app.put('/api/repos/:collection/:repo/collaborators/:user', (req, res) => {
    const ctx = requireRepoAdmin(root, limiter, req, res);
    if (!ctx) return;
    const username = req.params.user;
    const role = stringField(bodyOf(req), 'role') ?? 'write';
    if (role !== 'read' && role !== 'write' && role !== 'admin') {
      apiError(res, 400, '"role" must be "read", "write", or "admin"');
      return;
    }
    // Only a user the vault knows: a collaborator entry for a name nobody
    // holds grants nothing today and, worse, would grant everything it says
    // to whoever is given the name later.
    const state = loadVault(root);
    if (state.status !== 'ok' || !state.vault.users[username]) {
      apiError(res, 404, `no user ${username} in this vault`);
      return;
    }
    setCollaborator(ctx.repo.dir, username, role);
    res.json({ username, role });
  });

  app.delete('/api/repos/:collection/:repo/collaborators/:user', (req, res) => {
    const ctx = requireRepoAdmin(root, limiter, req, res);
    if (!ctx) return;
    const username = req.params.user;
    const access = repoAccess(ctx.repo.dir);
    if (access.collaborators[username] === undefined) {
      apiError(res, 404, `${username} is not a collaborator on ${ctx.repo.collection}/${ctx.repo.name}`);
      return;
    }
    removeCollaborator(ctx.repo.dir, username);
    res.json({ removed: username });
  });
}
