import * as fs from 'fs';
import * as path from 'path';
import { execGit } from './git';
import { repoPath } from './layout';
import { displayName, listCollections, listRepoDirs } from './scan';

// Periodic `git gc` over the repositories in the vault.
//
// Git adds objects and never removes them. A force push, a branch deleted, a
// history rewritten: each one leaves the commits, trees, and blobs it abandoned
// in the object store, unreachable from any ref, still readable by anyone who
// knows the hash, and still counted against the disk. Only a garbage collection
// walks out from the refs and drops what it could not reach.
//
// Nothing else here runs one. Git's own automatic pass is tuned for a working
// copy accumulating loose objects, and a bare repository on a forge receives
// packs instead, so in practice it never fires. Without this sweep a vault
// keeps every mistake anyone has ever pushed to it.
//
// What makes a sweep safe to run beside live traffic is the grace period. A
// push uploads its objects before it moves the branch that will make them
// reachable, so for a moment those objects look exactly like abandoned ones; a
// collection that spared nothing could delete a push in flight. PRUNE_GRACE
// keeps this one away from anything recent, which is also why it is not the
// answer to "I pushed a secret, get it out now": that wants --prune=now, and
// wants to know that nobody is mid-push.

/** How often to look for repositories worth collecting. */
const SWEEP_MS = 6 * 60 * 60 * 1000;
/**
 * How long after the first sweep runs. Long enough that a restart does not
 * cost a sweep on a vault that is restarted a few times a day, short enough
 * that starting the server is not a way to postpone collection indefinitely.
 */
const FIRST_SWEEP_MS = 10 * 60 * 1000;
/**
 * Objects unreachable but newer than this are kept. Two days is far longer than
 * any push or clone this server will serve, and it is the whole safety
 * argument for running gc unattended, so it is deliberately generous.
 */
const PRUNE_GRACE = '2.days.ago';
/** A repository still collecting after this long is left to the next sweep. */
const GC_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * Written in the repository directory after a successful collection. Its mtime
 * is the only state the sweep keeps, and losing it costs one extra gc.
 */
const STAMP = 'mochi-last-gc';

// Queue depth, interval, and grace are constants rather than settings, as the
// gate queues in src/limit.ts are: nobody tunes them without reading this
// comment, and they can be promoted to config.json if anyone asks.

function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** The newest mtime anywhere under dir, which is only walked for `refs`. */
function newestUnder(dir: string): number {
  let newest = 0;
  const visit = (p: string): void => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(p);
    } catch {
      return;
    }
    if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    if (!stat.isDirectory()) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) visit(path.join(p, entry.name));
  };
  visit(dir);
  return newest;
}

/**
 * Whether anything has happened to this repository since it was last collected.
 *
 * Loose refs are walked, since `refs` holds one small file per branch and tag.
 * The object store is not: `objects` and `objects/pack` change whenever a push
 * lands, which is all this needs to know, and walking a real repository's
 * fanout directories on every sweep would cost more than the gc it is deciding
 * whether to run.
 *
 * Exported for the tests, which build a repository shape without a git binary.
 */
export function repoNeedsGc(repoDir: string): boolean {
  const last = mtimeOf(path.join(repoDir, STAMP));
  // Never collected: collect it, whatever its mtimes say.
  if (last === 0) return true;
  const changed = Math.max(
    newestUnder(path.join(repoDir, 'refs')),
    mtimeOf(path.join(repoDir, 'packed-refs')),
    mtimeOf(path.join(repoDir, 'objects')),
    mtimeOf(path.join(repoDir, 'objects', 'pack'))
  );
  return changed > last;
}

/**
 * Collect every repository that has changed since its last collection, one at a
 * time, and return the names of the ones collected.
 *
 * Serial on purpose: a gc is CPU and disk bound, and a vault whose repositories
 * all changed should spend one core on catching up rather than every core.
 */
export async function gcSweep(root: string): Promise<string[]> {
  const collected: string[] = [];
  for (const { name: collection } of listCollections(root)) {
    for (const dirName of listRepoDirs(root, collection)) {
      const dir = repoPath(root, collection, dirName);
      const full = `${collection}/${displayName(dirName)}`;
      if (!repoNeedsGc(dir)) continue;
      try {
        await execGit(dir, ['gc', '--quiet', `--prune=${PRUNE_GRACE}`], { timeoutMs: GC_TIMEOUT_MS });
      } catch (e) {
        // A gc that fails is not an outage, and the commonest reason is that
        // another one holds the repository's gc.pid lock. No stamp is written,
        // so the next sweep tries again.
        console.error(`gc ${full}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      // After the gc, so that the work the gc itself did to `objects` and
      // `packed-refs` does not read as a reason to collect again.
      try {
        fs.writeFileSync(path.join(dir, STAMP), '');
      } catch {
        // Without a stamp the repository is collected again next sweep, which
        // is wasteful and harmless.
      }
      collected.push(full);
    }
  }
  return collected;
}

/**
 * Start the sweep. Returns a function that stops it, which the tests use;
 * the server itself runs it for as long as it runs.
 *
 * The timer is unref'd, so a sweep pending is never the reason a process stays
 * alive, and a sweep already running is never joined by a second one.
 */
export function startMaintenance(root: string): () => void {
  let running = false;
  let interval: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const collected = await gcSweep(root);
      if (collected.length > 0) {
        console.log(`gc: collected ${collected.length} repositor${collected.length === 1 ? 'y' : 'ies'}`);
      }
    } catch (e) {
      console.error(`gc sweep: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  };

  const first = setTimeout(() => {
    void tick();
    interval = setInterval(() => void tick(), SWEEP_MS);
    interval.unref();
  }, FIRST_SWEEP_MS);
  first.unref();

  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
