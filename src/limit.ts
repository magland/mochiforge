import { Request } from 'express';

// Rate limiting and abuse controls, in two primitives and one key function.
//
// Both primitives return a decision rather than writing a response, the way
// checkPushAuth does, because the callers refuse in four content types: HTML for
// the web, JSON for the API, plain text for git, and LFS's own JSON shape.
//
// Nothing here survives a restart or is shared between processes. Rate-limit
// state is high-frequency and worthless once stale, and it does not belong in a
// vault directory whose whole design is plain files written durably. Two servers
// pointed at one vault therefore count separately, and a restart forgives every
// offender. Both are documented limitations rather than bugs to engineer around.

/**
 * The address a limit is charged to. Express's req.ip reads X-Forwarded-For when
 * trust proxy is set, which is client-supplied, so it is used only when the
 * operator has said a proxy is in front. Otherwise the socket's peer address is
 * the only thing an attacker cannot choose.
 *
 * Every limiter keys on this. No route may key on req.ip directly, or a vault
 * exposed without a proxy would have every per-address limit defeated by one
 * fabricated header, and the limiter's own key space would be unbounded.
 */
export function clientKey(req: Request): string {
  const trusted = Boolean(req.app?.get('trust proxy'));
  const raw = trusted ? req.ip ?? req.socket.remoteAddress : req.socket.remoteAddress;
  return normalizeAddress(raw ?? 'unknown');
}

/**
 * One address, one key. Without this an attacker gets a fresh bucket per
 * spelling of the same address.
 *
 * IPv6 addresses are deliberately not aggregated into a /64. That would be the
 * more effective choice against a single host with a routed prefix and the more
 * damaging one behind a CGNAT or a university, and guessing wrong is worse than
 * the coarse behaviour.
 */
function normalizeAddress(address: string): string {
  const lower = address.trim().toLowerCase();
  return lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : lower;
}

// ---- the counter ----

export interface LimitDecision {
  ok: boolean;
  /** Seconds to put in Retry-After, when ok is false. */
  retryAfter: number;
}

export interface Limiter {
  /** Charge one event to key and say whether it is within the limit. */
  hit(key: string): LimitDecision;
  /** Whether key is currently over the limit, charging nothing. */
  check(key: string): LimitDecision;
}

const OK: LimitDecision = { ok: true, retryAfter: 0 };

/** How many expired entries one call may clear, so that a request cannot pay for a very large map. */
const SWEEP_BUDGET = 64;

/**
 * A fixed-window counter. A fixed window lets twice the limit through across a
 * window boundary; a token bucket would not, and buys a smoothness none of these
 * limits need.
 *
 * maxKeys is a hard ceiling, because an unbounded map keyed on anything an
 * attacker influences is itself a memory-exhaustion vector. When the map is full
 * and a sweep frees nothing, a hit on an unseen key is allowed. That is failing
 * open, and it is the right way round: a limiter that refuses everyone the moment
 * it is full has become the outage it exists to prevent. clientKey is what makes
 * this rare, by bounding the key space to real peers.
 */
export function createLimiter(opts: { limit: number; windowMs: number; maxKeys: number }): Limiter {
  const { limit, windowMs, maxKeys } = opts;
  const counts = new Map<string, { count: number; resetAt: number }>();
  let fullWarnedAt = 0;

  const retryAfter = (resetAt: number) => Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));

  // Amortised over a bounded number of entries, and only on a write, so one
  // request cannot pay for a very large map.
  const sweep = (now: number): void => {
    let looked = 0;
    for (const [key, entry] of counts) {
      if (looked++ >= SWEEP_BUDGET) break;
      if (entry.resetAt <= now) counts.delete(key);
    }
  };

  return {
    // check and hit agree on the boundary: after exactly `limit` events in a
    // window, check says not ok and the next hit would too.
    check(key: string): LimitDecision {
      if (limit <= 0) return OK;
      const entry = counts.get(key);
      const now = Date.now();
      if (!entry || entry.resetAt <= now) return OK;
      if (entry.count < limit) return OK;
      return { ok: false, retryAfter: retryAfter(entry.resetAt) };
    },
    hit(key: string): LimitDecision {
      if (limit <= 0) return OK;
      const now = Date.now();
      let entry = counts.get(key);
      if (!entry || entry.resetAt <= now) {
        if (!entry) {
          sweep(now);
          if (counts.size >= maxKeys) {
            // Once per window at most: a full map under attack would otherwise
            // fill the log faster than it fills memory.
            if (now - fullWarnedAt > windowMs) {
              fullWarnedAt = now;
              console.warn(
                `rate limiter at its ${maxKeys}-key ceiling; new addresses are not being counted until entries expire`
              );
            }
            return OK;
          }
        }
        entry = { count: 0, resetAt: now + windowMs };
        counts.set(key, entry);
      }
      entry.count++;
      if (entry.count > limit) return { ok: false, retryAfter: retryAfter(entry.resetAt) };
      return OK;
    },
  };
}

// ---- the gate ----

export interface Gate {
  /**
   * Wait for a slot, or refuse. Resolves to a release function, or null when
   * the queue is already full. Never rejects.
   */
  enter(): Promise<(() => void) | null>;
  readonly busy: number;
  readonly queued: number;
}

/**
 * A concurrency gate: a count of slots in use and a FIFO of waiters.
 *
 * This is the primitive that bounds git. Counting requests per minute does not
 * help there, because the requests are slow rather than frequent: a clone holds a
 * subprocess and a socket for as long as the client cares to read, and a handful
 * of concurrent ls-tree calls on a large repository is already a memory problem
 * given execGit's 256 MB maxBuffer. What bounds it is a limit on how many may run
 * at once.
 *
 * The release function is idempotent, and every caller must invoke it from
 * somewhere that runs on every path out of the request, a client disconnect
 * included. An aborted clone is ordinary traffic, not an error, and a gate that
 * leaks a slot per abort stops answering after `concurrency` of them.
 */
export function createGate(opts: { concurrency: number; queue: number; timeoutMs: number }): Gate {
  const { concurrency, queue, timeoutMs } = opts;
  let busy = 0;
  const waiters: { resolve: (r: (() => void) | null) => void; timer: NodeJS.Timeout }[] = [];

  const releaser = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiters.shift();
      if (next) {
        clearTimeout(next.timer);
        // The slot passes straight to the waiter, so busy stays as it is.
        next.resolve(releaser());
        return;
      }
      busy--;
    };
  };

  return {
    get busy() {
      return busy;
    },
    get queued() {
      return waiters.length;
    },
    enter(): Promise<(() => void) | null> {
      if (busy < concurrency) {
        busy++;
        return Promise.resolve(releaser());
      }
      if (waiters.length >= queue) return Promise.resolve(null);
      return new Promise((resolve) => {
        // A waiter that has been queued longer than this is dropped, so a
        // request never waits indefinitely for work a client has probably
        // given up on.
        const timer = setTimeout(() => {
          const i = waiters.findIndex((w) => w.timer === timer);
          if (i !== -1) waiters.splice(i, 1);
          resolve(null);
        }, timeoutMs);
        // Nothing should keep the process alive for a queued waiter.
        timer.unref?.();
        waiters.push({ resolve, timer });
      });
    },
  };
}

// ---- the gates a vault holds ----

/**
 * What to put in Retry-After when a gate refuses. A gate refusal is about server
 * capacity right now rather than about a client's quota over a window, so there
 * is no window to compute from; a few seconds is long enough for the queue to
 * drain and short enough that a client retry is not a second outage.
 */
export const BUSY_RETRY_SECONDS = 5;

export interface Gates {
  clone: Gate; // git-upload-pack, both advertise and the RPC
  push: Gate; // git-receive-pack
  search: Gate; // git grep
  tree: Gate; // ls-tree for the file finder, git archive for source downloads
}

// Queue depths and timeouts are constants rather than configuration: nobody
// tunes these without reading the code, and they can be promoted later if anyone
// asks. The concurrencies are configurable, because those are the numbers that
// depend on the machine.
const QUEUES = {
  clone: { queue: 16, timeoutMs: 10000 },
  push: { queue: 16, timeoutMs: 30000 },
  search: { queue: 8, timeoutMs: 5000 },
  tree: { queue: 16, timeoutMs: 10000 },
};

/**
 * Separate gates and not one, so that a flood of anonymous clones cannot stop an
 * authorized push, which is the operation whose failure costs a person their
 * work.
 */
export function createGates(limits: { clone: number; push: number; search: number; tree: number }): Gates {
  return {
    clone: createGate({ concurrency: limits.clone, ...QUEUES.clone }),
    push: createGate({ concurrency: limits.push, ...QUEUES.push }),
    search: createGate({ concurrency: limits.search, ...QUEUES.search }),
    tree: createGate({ concurrency: limits.tree, ...QUEUES.tree }),
  };
}

// ---- failed credential checks ----

export interface AuthLimiter {
  /** Whether this request may attempt a credential at all. */
  allow(req: Request, username: string | null): LimitDecision;
  /** Record a failed attempt. Call only when the credential was wrong. */
  fail(req: Request, username: string | null): void;
}

const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_KEYS = 20000;
/** Bearer and runner tokens carry no username, so they share one bucket in the fine-grained window. */
const NO_USERNAME = '\x00token';

/**
 * A limiter charged only on failure, so a working credential is never throttled
 * however often it is used. That matters for /api/runner/*, which a runner calls
 * continuously with a valid token.
 *
 * Two windows. The fine-grained one is per address and username; the coarse one
 * is per address alone and deliberately the more generous, so that a shared
 * address behind NAT is not cut off by one person mistyping a token, while an
 * attacker spreading attempts over many usernames is still caught.
 *
 * The fine-grained map is the one an attacker can grow, by varying the username.
 * When it is full its hits stop counting, so `allow` falls back to the coarse
 * decision alone rather than failing open altogether; the coarse map's key space
 * is bounded by real peers. That is the reason there are two windows and not one.
 */
export function createAuthLimiter(authFailures: number): AuthLimiter {
  const fine = createLimiter({ limit: authFailures, windowMs: AUTH_WINDOW_MS, maxKeys: AUTH_MAX_KEYS });
  // Derived rather than configured, so there is one number to think about.
  const coarse = createLimiter({ limit: authFailures * 5, windowMs: AUTH_WINDOW_MS, maxKeys: AUTH_MAX_KEYS });

  const keys = (req: Request, username: string | null) => {
    const address = clientKey(req);
    return { address, fine: `${address}\x00${username ?? NO_USERNAME}` };
  };

  return {
    allow(req, username) {
      const k = keys(req, username);
      const a = fine.check(k.fine);
      if (!a.ok) return a;
      return coarse.check(k.address);
    },
    fail(req, username) {
      const k = keys(req, username);
      fine.hit(k.fine);
      coarse.hit(k.address);
    },
  };
}
