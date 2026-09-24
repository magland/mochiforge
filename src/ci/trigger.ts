import { findRepo } from '../scan';
import { publishSiteAfterPush } from '../sitepublish';
import { CiEngine } from './engine';

// One place that turns a branch having moved into a workflow event.
//
// A commit made in the browser, a commit made over the API, and a merge are all
// pushes as far as workflows are concerned, and forgetting one would be a silent
// divergence between the interfaces: the same operation would run CI through one
// door and not through the other. There were two copies of this before there were
// two transports, which is one copy too many already.

const ZERO = '0'.repeat(40);

/**
 * Report a branch move to the CI engine, if there is one.
 *
 * A failure here is logged and never allowed to affect the operation that caused
 * it, which by this point has already been committed.
 */
export function firePush(
  root: string,
  engine: CiEngine | undefined,
  repo: { collection: string; name: string },
  branch: string,
  before: string | null,
  after: string,
  actor: string
): void {
  const gitRepo = findRepo(root, repo.collection, repo.name);
  if (!gitRepo) return;
  const ref = `refs/heads/${branch}`;
  // The site first, then CI: a site published from the repository follows
  // the branch whichever door the commit came through, engine or no engine.
  publishSiteAfterPush(root, gitRepo, ref)
    .then(() => engine?.handlePush(gitRepo, { ref, before: before ?? ZERO, after, actor }))
    .catch((e) => console.error(`CI trigger failed: ${e instanceof Error ? e.message : e}`));
}
