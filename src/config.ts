import * as fs from 'fs';
import * as path from 'path';
import { withFileLock, writeFileAtomic } from './atomic';
import { fileCache } from './filecache';
import { normalizeHostname } from './siteshost';
import { DEFAULT_THEME, findTheme } from './themes';

// Vault-level settings, kept in <vault>/config.json next to vault.json. Like
// everything else, this is a plain file in the vault: hand-editing it is
// legitimate, and a missing or unreadable file simply means defaults.

export const CONFIG_FILE = 'config.json';

export interface CiConfig {
  /** How many completed runs to keep per repository. */
  runs: number;
  /** Also drop completed runs older than this many days; 0 disables. */
  days: number;
  /** Largest artifact a job may upload, in megabytes. */
  artifactMb: number;
}

export interface SitesConfig {
  /**
   * Hostname whose subdomains serve repository sites, e.g.
   * "vault-sites.example.org". Empty means sites are served on the forge
   * host, sandboxed.
   */
  host: string;
}

export interface NetworkConfig {
  /**
   * Whether X-Forwarded-For and X-Forwarded-Proto may be believed. True only
   * when a reverse proxy you control is the only way in.
   */
  trustProxy: boolean;
}

export interface LimitsConfig {
  /** Requests per minute per address, over everything not exempt. 0 disables. */
  requestsPerMinute: number;
  /** Failed credential checks per address per username, per 15 minutes. 0 disables. */
  authFailures: number;
  /** Concurrent git subprocesses, per class. */
  clone: number;
  push: number;
  search: number;
  tree: number;
  /**
   * Gigabytes the vault may send out in one UTC day, over everything. 0
   * disables. The one setting in this block that is read per request rather
   * than at startup, because the moment it needs changing is the moment the
   * vault has stopped answering.
   */
  egressGbPerDay: number;
}

export interface AuthConfig {
  /**
   * The client id of the GitHub OAuth App behind "Sign in with GitHub"; empty
   * means the sign-in page does not offer it. The client secret is
   * deliberately not here: config.json is ordinary vault state, so the secret
   * lives in `<vault>/.github-secret` beside `.secret` (see src/githubauth.ts).
   */
  githubClientId: string;
}

export interface VaultConfig {
  theme: string;
  auth: AuthConfig;
  ci: CiConfig;
  sites: SitesConfig;
  network: NetworkConfig;
  limits: LimitsConfig;
}

// A hostname of at least two labels, each of letters, digits, and interior
// hyphens. A value carrying a scheme, a port, or a single label is not one, and
// is treated as a typo rather than obeyed.
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Whether a string is usable as a hostname in this file's settings. Exported so
 * that a route accepting one refuses a typo with a message, rather than storing
 * it and leaving loadConfig to fall back to the default silently: a setting
 * written through the API is being watched by someone who wants to know.
 */
export function isPlausibleHostname(value: string): boolean {
  return HOSTNAME_RE.test(value);
}

export function configFilePath(root: string): string {
  return path.join(root, CONFIG_FILE);
}

const DEFAULTS: VaultConfig = {
  theme: DEFAULT_THEME,
  auth: { githubClientId: '' },
  ci: { runs: 100, days: 0, artifactMb: 500 },
  sites: { host: '' },
  network: { trustProxy: false },
  // 20 GB a day is generous for a personal forge and cheap if it is ever all
  // sent: it is the number that stops a crawler or a CI loop turning a host
  // that bills for egress and does not cap it into a bill nobody chose.
  limits: { requestsPerMinute: 600, authFailures: 10, clone: 4, push: 4, search: 2, tree: 4, egressGbPerDay: 20 },
};

function defaults(): VaultConfig {
  return {
    ...DEFAULTS,
    auth: { ...DEFAULTS.auth },
    ci: { ...DEFAULTS.ci },
    sites: { ...DEFAULTS.sites },
    network: { ...DEFAULTS.network },
    limits: { ...DEFAULTS.limits },
  };
}

const cache = fileCache<VaultConfig>({ read: readConfig, missing: () => defaults() });

export function loadConfig(root: string): VaultConfig {
  return cache.get(configFilePath(root));
}

function readConfig(file: string): VaultConfig {
  let config: VaultConfig = defaults();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    // An unknown theme name falls back to the default rather than failing the
    // request: a typo in config.json should not take the vault down.
    if (typeof parsed.theme === 'string' && findTheme(parsed.theme)) config.theme = parsed.theme;
    // The client id is public and its exact shape is GitHub's business; the
    // check refuses only whitespace and control characters, which could not
    // be one and would otherwise ride into a redirect URL.
    if (typeof parsed.auth === 'object' && parsed.auth !== null) {
      const auth = parsed.auth as Record<string, unknown>;
      const id = typeof auth.githubClientId === 'string' ? auth.githubClientId.trim() : '';
      config.auth = { githubClientId: /^[\x21-\x7e]{1,100}$/.test(id) ? id : DEFAULTS.auth.githubClientId };
    }
    // Run retention: a vault's run history is the one part of its state that
    // grows without bound, so it is bounded by default and tunable here.
    if (typeof parsed.ci === 'object' && parsed.ci !== null) {
      const ci = parsed.ci as Record<string, unknown>;
      const runs = typeof ci.runs === 'number' && ci.runs >= 0 ? Math.floor(ci.runs) : DEFAULTS.ci.runs;
      const days = typeof ci.days === 'number' && ci.days >= 0 ? Math.floor(ci.days) : DEFAULTS.ci.days;
      const artifactMb =
        typeof ci.artifactMb === 'number' && ci.artifactMb > 0 ? Math.floor(ci.artifactMb) : DEFAULTS.ci.artifactMb;
      config.ci = { runs, days, artifactMb };
    }
    // A site host lets each repository's site have an origin of its own. A
    // value that is not a plausible hostname is ignored the way an unknown
    // theme name is: a typo here would otherwise stop sites being served at
    // all, or worse, serve them from a name that is not the one the
    // certificate covers.
    if (typeof parsed.sites === 'object' && parsed.sites !== null) {
      const sites = parsed.sites as Record<string, unknown>;
      const raw = typeof sites.host === 'string' ? normalizeHostname(sites.host) : '';
      config.sites = { host: isPlausibleHostname(raw) ? raw : DEFAULTS.sites.host };
    }
    // Whether the forwarded headers may be believed. False by default, because
    // believing them on a directly exposed vault lets any client claim any
    // address, which defeats every per-address limit and makes the limiter's own
    // key space unbounded.
    if (typeof parsed.network === 'object' && parsed.network !== null) {
      const network = parsed.network as Record<string, unknown>;
      config.network = {
        trustProxy: typeof network.trustProxy === 'boolean' ? network.trustProxy : DEFAULTS.network.trustProxy,
      };
    }
    // Each field falls back to its own default, so one bad value does not
    // discard the block.
    if (typeof parsed.limits === 'object' && parsed.limits !== null) {
      const limits = parsed.limits as Record<string, unknown>;
      // A limit may be 0, which disables it. A concurrency may not: a gate of
      // zero slots would refuse everything forever, which is an outage rather
      // than a setting, so it is treated as a bad value.
      const limit = (v: unknown, fallback: number) =>
        typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
      const slots = (v: unknown, fallback: number) =>
        typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
      // Not floored, unlike the two above: half a gigabyte is a reasonable
      // budget to give a vault, and 0 disables the cap.
      const gigabytes = (v: unknown, fallback: number) =>
        typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
      config.limits = {
        requestsPerMinute: limit(limits.requestsPerMinute, DEFAULTS.limits.requestsPerMinute),
        authFailures: limit(limits.authFailures, DEFAULTS.limits.authFailures),
        clone: slots(limits.clone, DEFAULTS.limits.clone),
        push: slots(limits.push, DEFAULTS.limits.push),
        search: slots(limits.search, DEFAULTS.limits.search),
        tree: slots(limits.tree, DEFAULTS.limits.tree),
        egressGbPerDay: gigabytes(limits.egressGbPerDay, DEFAULTS.limits.egressGbPerDay),
      };
    }
  } catch {
    config = defaults();
  }
  return config;
}

/**
 * Hold config.json's lock across a read, an edit, and the write back.
 *
 * `mochi config set` and `PATCH /api/config` merge changes into whatever is
 * on disk, so two of them overlapping keeps one change and drops the other. The
 * cache is dropped on the way in for the same reason it is in the runner
 * registry: an unchanged mtime and size is a good enough guess for a read, and
 * not good enough for the read half of a read-modify-write.
 *
 * The lock is not reentrant, so anything that needs to look at the file before
 * deciding whether to save calls `saveLocked` from inside its own `editConfig`
 * rather than calling `saveConfig`.
 */
function editConfig<T>(root: string, fn: () => T): T {
  return withFileLock(`${configFilePath(root)}.lock`, () => {
    cache.invalidate(configFilePath(root));
    return fn();
  });
}

function saveLocked(root: string, changes: Partial<VaultConfig>): VaultConfig {
  const next: VaultConfig = { ...loadConfig(root), ...changes };
  writeFileAtomic(configFilePath(root), JSON.stringify(next, null, 2) + '\n');
  cache.invalidate(configFilePath(root));
  return next;
}

export function saveConfig(root: string, changes: Partial<VaultConfig>): VaultConfig {
  return editConfig(root, () => saveLocked(root, changes));
}

/**
 * Record network.trustProxy: true unless the vault has already said something
 * about it. Called by `serve` when MOCHI_TRUST_PROXY is set, which is how
 * `mochi deploy fly` tells a vault it is behind a proxy: the deploy cannot
 * write to the volume itself, since the vault does not exist until the server
 * starts.
 *
 * It runs on every start and not only on a fresh vault, because a vault created
 * before this setting existed would otherwise come back from an upgrade with
 * forwarded headers no longer believed, which would break its clone URLs and its
 * Secure cookies. An explicit value in config.json is always left alone, so
 * turning it off by hand stays turned off.
 */
export function seedTrustProxy(root: string): boolean {
  return editConfig(root, () => {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(fs.readFileSync(configFilePath(root), 'utf8')) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    const network = typeof parsed.network === 'object' && parsed.network !== null ? (parsed.network as Record<string, unknown>) : {};
    if (typeof network.trustProxy === 'boolean') return false;
    saveLocked(root, { network: { trustProxy: true } });
    return true;
  });
}
