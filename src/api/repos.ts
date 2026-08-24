import { Express } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { AuthLimiter } from '../limit';
import { repoPath } from '../layout';
import { atLeast, repoIsPrivate, repoRole } from '../perms';
import { displayName, forkParent, listCollections, listRepoDirs, repoDescription, siteDir, upstreamOf } from '../scan';
import { countTopics, isValidTopic, repoTopics } from '../topics';
import { issueCounts } from '../issues';
import { pullCounts } from '../pulls';
import { listReleases } from '../releases';
import { apiError, requireApiAuth, requireRepo } from './auth';

// Repositories: what the vault holds, and what one repository is.
//
// The response objects stay close to what the vault already knows rather than
// being hand-built summaries, so that a field added to the vault's state appears
// here without a decision being made about it.

export interface RepoSummary {
  collection: string;
  name: string;
  description: string;
  topics: string[];
  forkedFrom: { collection: string; repo: string } | null;
  /** The URL outside this vault the repository was forked from, if recorded. */
  upstream: string | null;
  hasSite: boolean;
  private: boolean;
}

function summarize(root: string, collection: string, dirName: string): RepoSummary {
  const name = displayName(dirName);
  const dir = repoPath(root, collection, dirName);
  return {
    collection,
    name,
    description: repoDescription(dir) ?? '',
    topics: repoTopics(dir),
    forkedFrom: forkParent(dir),
    upstream: upstreamOf(dir)?.url ?? null,
    hasSite: siteDir(root, collection, name) !== null,
    private: repoIsPrivate(dir),
  };
}

export function registerRepoApi(app: Express, root: string, limiter: AuthLimiter): void {
  // Every repository in the vault, flat. A vault's collections are small and
  // this is read off disk per request, so there is no pagination: --limit and
  // the server-side caps are enough, and a cursor protocol would be machinery
  // with nothing to carry. ?topic= narrows the list to repositories carrying
  // that topic, which is the one cross-repository query topics exist for.
  app.get('/api/repos', (req, res) => {
    const auth = requireApiAuth(root, limiter, req, res);
    if (!auth) return;
    const topic = typeof req.query.topic === 'string' ? req.query.topic : '';
    if (topic !== '' && !isValidTopic(topic)) {
      apiError(res, 400, 'a topic is lowercase letters, digits, and hyphens, starting with a letter or digit');
      return;
    }
    const repos: RepoSummary[] = [];
    for (const c of listCollections(root)) {
      for (const dirName of listRepoDirs(root, c.name)) {
        const dir = repoPath(root, c.name, dirName);
        // A private repository the caller has no role on is not listed, the
        // same way its page 404s.
        if (repoRole(root, auth, { collection: c.name, name: displayName(dirName), dir }) === null) continue;
        if (topic !== '' && !repoTopics(dir).includes(topic)) continue;
        repos.push(summarize(root, c.name, dirName));
      }
    }
    res.json({ repos });
  });

  // Every topic in use, with how many repositories carry each: only what the
  // caller could see listed anyway, counted rather than repeated.
  app.get('/api/topics', (req, res) => {
    const auth = requireApiAuth(root, limiter, req, res);
    if (!auth) return;
    const lists: string[][] = [];
    for (const c of listCollections(root)) {
      for (const dirName of listRepoDirs(root, c.name)) {
        const dir = repoPath(root, c.name, dirName);
        if (repoRole(root, auth, { collection: c.name, name: displayName(dirName), dir }) === null) continue;
        lists.push(repoTopics(dir));
      }
    }
    res.json({ topics: countTopics(lists) });
  });

  app.get('/api/repos/:collection/:repo', async (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const { repo, auth } = found;
    const role = repoRole(root, auth, repo);
    const branches = await repo.listRefs('heads');
    const tags = await repo.listRefs('tags');
    const issues = issueCounts(root, repo.collection, repo.name);
    const pulls = pullCounts(root, repo.collection, repo.name);
    res.json({
      ...summarize(root, repo.collection, path.basename(repo.dir)),
      defaultBranch: await repo.defaultBranch(branches),
      updated: await repo.lastUpdated(),
      branches: branches.length,
      tags: tags.length,
      releases: listReleases(root, repo.collection, repo.name).length,
      openIssues: issues.open,
      closedIssues: issues.closed,
      openPulls: pulls.open,
      closedPulls: pulls.closed,
      // What this token may do here, so that a caller need not discover it by
      // being refused.
      role,
      canPush: atLeast(role, 'write'),
    });
  });

  app.get('/api/repos/:collection/:repo/branches', async (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const branches = await found.repo.listRefs('heads');
    res.json({ branches, defaultBranch: await found.repo.defaultBranch(branches) });
  });

  app.get('/api/repos/:collection/:repo/tags', async (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    res.json({ tags: await found.repo.listRefs('tags') });
  });

  // Read only, and deliberately. Publishing a site is a workflow's job or a file
  // copy into the vault; an upload path here would be a second way to write the
  // one directory whose contents are served to browsers.
  app.get('/api/repos/:collection/:repo/site', (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const dir = siteDir(root, found.repo.collection, found.repo.name);
    if (!dir) {
      res.json({ exists: false });
      return;
    }
    let entries = 0;
    let updated: string | null = null;
    try {
      const walk = (d: string): void => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) walk(path.join(d, e.name));
          else entries++;
        }
      };
      walk(dir);
      updated = fs.statSync(dir).mtime.toISOString();
    } catch {
      // An unreadable site directory reports what it can rather than failing.
    }
    res.json({ exists: true, entries, updated });
  });

  // A repository name that is not two path segments is a caller's mistake rather
  // than a missing repository, and saying so is cheaper than letting it 404.
  app.all('/api/repos/:collection', (_req, res) => {
    apiError(res, 404, 'address a repository as /api/repos/<collection>/<repo>');
  });
}
