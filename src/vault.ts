import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { withFileLock, writeFileAtomic } from './atomic';
import { fileCache } from './filecache';
import { isDotName, isValidUserName } from './scan';

export const VAULT_FILE = 'vault.json';

export interface TokenRecord {
  hash: string;
  scope?: string[];
  /**
   * A stable identifier, so that a token can be named without naming its hash.
   * Minted with the token; a record from before this existed has none, and is
   * then identified by the first eight characters of its hash instead, so
   * existing vaults keep working without migration.
   */
  id?: string;
  /** When the token was minted. Absent on a record from before this existed. */
  created?: string;
}

/** How a token is named in a listing or a revocation: its id, or a stand-in for one. */
export function tokenId(t: TokenRecord): string {
  return t.id ?? t.hash.slice(0, 8);
}

/**
 * A passkey a user registered from their account page. What is stored is the
 * public half alone: the credential id the authenticator minted, the public
 * key (converted to a DER SPKI at registration, so signing in is one
 * crypto.verify), and the signature counter for authenticators that keep one.
 * Like a token, a passkey is a credential the vault can take away: sessions
 * signed in with it resolve it against live vault.json on every request, so
 * removing it here ends them at once.
 */
export interface PasskeyRecord {
  /** The credential id, base64url. */
  id: string;
  /** The public key as a DER SPKI, base64url. */
  publicKey: string;
  /** The COSE algorithm the key signs under: -7 ES256, -8 EdDSA, -257 RS256. */
  alg: number;
  /** The authenticator's signature counter; 0 from the many that keep none. */
  counter: number;
  created?: string;
  /** The label the user gave it, so two passkeys can be told apart. */
  name?: string;
}

/**
 * The GitHub account a user has linked, or that provisioned them. What is
 * stored is GitHub's stable numeric account id and, for display, the login it
 * carried when last seen; logins can change hands on GitHub, ids cannot, so
 * the id is what a sign-in is matched by. Like a token or a passkey, the link
 * is a credential the vault can take away: a session signed in with GitHub
 * resolves it against live vault.json on every request, so unlinking here
 * ends such sessions at once.
 */
export interface GithubAccount {
  /** GitHub's numeric account id, the stable half of the identity. */
  id: number;
  /** The login as last seen, for display; refreshed when it changes. */
  login: string;
  linked?: string;
}

/**
 * One entry on the admin's list of GitHub accounts that may sign in without
 * already having an account here: the first sign-in creates one, named after
 * the login. Approval is recorded by numeric id, resolved from the login when
 * the entry is added, so a later rename on GitHub transfers nothing.
 */
export interface GithubApproval {
  id: number;
  login: string;
  added?: string;
}

/**
 * What a user chooses to say about themselves on their profile page. Every
 * field is optional and plain text; the links are the one exception, held to
 * http(s) URLs where they are written so the page never links anywhere else.
 */
export interface UserProfile {
  /** The name shown beside the username, e.g. "Jeremy Magland". */
  name?: string;
  bio?: string;
  links?: string[];
}

export interface UserRecord {
  tokens: TokenRecord[];
  /** Passkeys the user may sign in to the web interface with. */
  passkeys?: PasskeyRecord[];
  /**
   * Site admins hold the admin role on every repository and manage users,
   * runners, and the vault itself. Everything finer-grained lives with the
   * thing it protects: collection owners in collection.json, repository
   * collaborators in the repository's mochi.json; see src/perms.ts.
   */
  siteAdmin?: boolean;
  /**
   * Git author emails that belong to this user, beside the synthetic
   * `<user>@noreply.<host>` the web editor writes, which is theirs without
   * being listed. One person pushing under their own git identity and editing
   * in the browser is otherwise two contributors with two faces.
   */
  emails?: string[];
  /** The profile the user wrote for themselves; absent until they write one. */
  profile?: UserProfile;
  /** The GitHub account this user signs in with, when one is linked. */
  github?: GithubAccount;
  /**
   * The glob scopes a pre-roles vault.json granted this user, carried only
   * from parsing such a file to the migration that rewrites it (see
   * src/migrate.ts). Nothing else reads them: an unmigrated vault grants
   * nothing beyond anonymous reading, and the server migrates on startup
   * before it listens.
   */
  legacy?: { scope: string[]; admin: string[] };
}

export interface Vault {
  users: Record<string, UserRecord>;
  /** GitHub accounts approved to sign in; see GithubApproval. */
  githubApproved?: GithubApproval[];
  /** True when the file predates roles and awaits migration. */
  legacy?: boolean;
}

/** The version written to vault.json since roles replaced glob scopes. */
export const VAULT_VERSION = 2;

export type VaultState =
  | { status: 'ok'; vault: Vault }
  | { status: 'missing' }
  | { status: 'error'; message: string };

export function vaultFilePath(root: string): string {
  return path.join(root, VAULT_FILE);
}

function asStringArray(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
}

function normalizeVault(parsed: unknown): Vault {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('vault.json must be a JSON object');
  }
  const usersRaw = (parsed as Record<string, unknown>).users;
  if (typeof usersRaw !== 'object' || usersRaw === null) {
    throw new Error('vault.json must have a "users" object');
  }
  // A file without the version marker was written before roles existed and
  // still carries glob scopes. Its users and tokens parse as usual, and the
  // globs ride along in `legacy` for the migration to translate; the file is
  // legacy as a whole, so half-migrated states cannot exist.
  const legacy = (parsed as Record<string, unknown>).version !== VAULT_VERSION;
  const users: Record<string, UserRecord> = {};
  for (const [name, u] of Object.entries(usersRaw as Record<string, unknown>)) {
    if (typeof u !== 'object' || u === null) {
      throw new Error(`user ${name} must be an object`);
    }
    const rec = u as Record<string, unknown>;
    const scope = asStringArray(rec.scope ?? []);
    if (!scope) {
      throw new Error(`user ${name}: "scope" must be a list of strings`);
    }
    const admin = asStringArray(rec.admin ?? []);
    if (!admin) {
      throw new Error(`user ${name}: "admin" must be a list of strings`);
    }
    const tokensRaw = rec.tokens ?? [];
    if (!Array.isArray(tokensRaw)) {
      throw new Error(`user ${name}: "tokens" must be a list`);
    }
    const tokens: TokenRecord[] = tokensRaw.map((t, i) => {
      if (typeof t === 'string') return { hash: t };
      if (typeof t === 'object' && t !== null && typeof (t as Record<string, unknown>).hash === 'string') {
        const tRec = t as Record<string, unknown>;
        const rec: TokenRecord = { hash: tRec.hash as string };
        if (typeof tRec.id === 'string' && tRec.id !== '') rec.id = tRec.id;
        if (typeof tRec.created === 'string' && tRec.created !== '') rec.created = tRec.created;
        if (tRec.scope !== undefined) {
          const ts = asStringArray(tRec.scope);
          if (!ts) throw new Error(`user ${name}: token ${i} "scope" must be a list of strings`);
          rec.scope = ts;
        }
        return rec;
      }
      throw new Error(`user ${name}: token ${i} must be a hash string or an object with a "hash"`);
    });
    const emails = asStringArray(rec.emails ?? []);
    if (!emails) {
      throw new Error(`user ${name}: "emails" must be a list of strings`);
    }
    // Parsed explicitly, like every other field: normalizeVault builds a fresh
    // object, so a field it did not read would be dropped by the next write.
    const passkeysRaw = rec.passkeys ?? [];
    if (!Array.isArray(passkeysRaw)) {
      throw new Error(`user ${name}: "passkeys" must be a list`);
    }
    const passkeys: PasskeyRecord[] = passkeysRaw.map((p, i) => {
      if (
        typeof p !== 'object' ||
        p === null ||
        typeof (p as Record<string, unknown>).id !== 'string' ||
        typeof (p as Record<string, unknown>).publicKey !== 'string' ||
        typeof (p as Record<string, unknown>).alg !== 'number'
      ) {
        throw new Error(`user ${name}: passkey ${i} must be an object with "id", "publicKey", and "alg"`);
      }
      const pRec = p as Record<string, unknown>;
      const out: PasskeyRecord = {
        id: pRec.id as string,
        publicKey: pRec.publicKey as string,
        alg: pRec.alg as number,
        counter: typeof pRec.counter === 'number' && pRec.counter >= 0 ? Math.floor(pRec.counter) : 0,
      };
      if (typeof pRec.created === 'string' && pRec.created !== '') out.created = pRec.created;
      if (typeof pRec.name === 'string' && pRec.name !== '') out.name = pRec.name;
      return out;
    });
    const profile = normalizeProfile(rec.profile, name);
    const github = normalizeGithubAccount(rec.github, name);
    users[name] = {
      tokens,
      ...(passkeys.length ? { passkeys } : {}),
      ...(rec.siteAdmin === true ? { siteAdmin: true } : {}),
      ...(emails.length ? { emails } : {}),
      ...(profile ? { profile } : {}),
      ...(github ? { github } : {}),
      ...(legacy ? { legacy: { scope, admin } } : {}),
    };
  }
  const githubApproved = normalizeGithubApproved((parsed as Record<string, unknown>).githubApproved);
  return {
    users,
    ...(githubApproved.length ? { githubApproved } : {}),
    ...(legacy ? { legacy: true } : {}),
  };
}

// Both GitHub shapes are parsed explicitly for the same reason passkeys are:
// normalizeVault builds a fresh object, so a field it did not read would be
// dropped by the next write.
function normalizeGithubAccount(raw: unknown, username: string): GithubAccount | null {
  if (raw === undefined || raw === null) return null;
  if (
    typeof raw !== 'object' ||
    typeof (raw as Record<string, unknown>).id !== 'number' ||
    typeof (raw as Record<string, unknown>).login !== 'string'
  ) {
    throw new Error(`user ${username}: "github" must be an object with a numeric "id" and a "login"`);
  }
  const rec = raw as Record<string, unknown>;
  const out: GithubAccount = { id: Math.floor(rec.id as number), login: rec.login as string };
  if (typeof rec.linked === 'string' && rec.linked !== '') out.linked = rec.linked;
  return out;
}

function normalizeGithubApproved(raw: unknown): GithubApproval[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('"githubApproved" must be a list');
  }
  return raw.map((a, i) => {
    if (
      typeof a !== 'object' ||
      a === null ||
      typeof (a as Record<string, unknown>).id !== 'number' ||
      typeof (a as Record<string, unknown>).login !== 'string'
    ) {
      throw new Error(`githubApproved ${i} must be an object with a numeric "id" and a "login"`);
    }
    const rec = a as Record<string, unknown>;
    const out: GithubApproval = { id: Math.floor(rec.id as number), login: rec.login as string };
    if (typeof rec.added === 'string' && rec.added !== '') out.added = rec.added;
    return out;
  });
}

// A hand-edited vault.json should not take the vault down over a profile, so
// the check is a shape check: fields that are not strings are refused, and a
// profile with nothing in it reads as no profile at all.
function normalizeProfile(raw: unknown, username: string): UserProfile | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') {
    throw new Error(`user ${username}: "profile" must be an object`);
  }
  const rec = raw as Record<string, unknown>;
  const profile: UserProfile = {};
  if (rec.name !== undefined) {
    if (typeof rec.name !== 'string') throw new Error(`user ${username}: profile "name" must be a string`);
    if (rec.name !== '') profile.name = rec.name;
  }
  if (rec.bio !== undefined) {
    if (typeof rec.bio !== 'string') throw new Error(`user ${username}: profile "bio" must be a string`);
    if (rec.bio !== '') profile.bio = rec.bio;
  }
  if (rec.links !== undefined) {
    const links = asStringArray(rec.links);
    if (!links) throw new Error(`user ${username}: profile "links" must be a list of strings`);
    if (links.length) profile.links = links;
  }
  return Object.keys(profile).length ? profile : null;
}

const cache = fileCache<VaultState>({
  read: (file) => {
    try {
      return { status: 'ok', vault: normalizeVault(JSON.parse(fs.readFileSync(file, 'utf8'))) };
    } catch (e) {
      return { status: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  },
  missing: () => ({ status: 'missing' }),
});

export function loadVault(root: string): VaultState {
  return cache.get(vaultFilePath(root));
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function mintToken(): { token: string; hash: string } {
  const token = 'mochi_' + crypto.randomBytes(32).toString('hex');
  return { token, hash: hashToken(token) };
}

export function globMatch(pattern: string, target: string): boolean {
  const rx = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${rx}$`).test(target);
}

export interface AuthResult {
  username: string;
  user: UserRecord;
  token: TokenRecord;
}

export function authenticate(vault: Vault, username: string, tokenPlain: string): AuthResult | null {
  const user = vault.users[username];
  if (!user) return null;
  const presented = Buffer.from(hashToken(tokenPlain), 'hex');
  for (const t of user.tokens) {
    let stored: Buffer;
    try {
      stored = Buffer.from(t.hash, 'hex');
    } catch {
      continue;
    }
    if (stored.length === presented.length && crypto.timingSafeEqual(stored, presented)) {
      return { username, user, token: t };
    }
  }
  return null;
}

export function authenticateToken(vault: Vault, tokenPlain: string): AuthResult | null {
  const presented = Buffer.from(hashToken(tokenPlain), 'hex');
  for (const [username, user] of Object.entries(vault.users)) {
    for (const t of user.tokens) {
      let stored: Buffer;
      try {
        stored = Buffer.from(t.hash, 'hex');
      } catch {
        continue;
      }
      if (stored.length === presented.length && crypto.timingSafeEqual(stored, presented)) {
        return { username, user, token: t };
      }
    }
  }
  return null;
}

// Who may do what lives in src/perms.ts, which reads roles and ownership from
// where each is stored; this file holds only who somebody is.

function writeVault(file: string, vault: Vault): void {
  const users: Record<string, unknown> = {};
  for (const [name, u] of Object.entries(vault.users)) {
    const { legacy: _legacy, ...rest } = u;
    users[name] = rest;
  }
  writeFileAtomic(
    file,
    JSON.stringify(
      {
        version: VAULT_VERSION,
        users,
        ...(vault.githubApproved?.length ? { githubApproved: vault.githubApproved } : {}),
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  );
}

/**
 * Every edit to vault.json is a read, a change in memory, and a write back, and
 * they are all short. Holding one lock across the whole of one makes them
 * serial against a second server and against a CLI run on the same directory,
 * which is the arrangement the documentation invites by saying a vault is just
 * a directory. Readers do not take the lock: they see the old file or the new
 * one, which the atomic rename already guarantees.
 */
function editVault<T>(root: string, fn: (file: string) => T): T {
  return withFileLock(path.join(root, `${VAULT_FILE}.lock`), () => fn(vaultFilePath(root)));
}

// Reread under the lock, refusing a pre-roles file: writeVault writes the
// current shape, so editing a legacy file in place would silently drop the
// glob scopes the migration still has to translate.
function readVaultForEdit(file: string): Vault {
  const vault = normalizeVault(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (vault.legacy) {
    throw new Error('vault.json predates roles; start the server once to migrate it');
  }
  return vault;
}

// The body of addUserToken, without the lock, so that bootstrapVault can put
// its own check-then-act inside the same one rather than nesting a second.
function addUserTokenLocked(
  file: string,
  username: string,
  opts: { siteAdmin?: boolean; tokenScope?: string[]; token?: string }
): { token: string; created: boolean; user: UserRecord } {
  let vault: Vault = { users: {} };
  if (fs.existsSync(file)) {
    vault = normalizeVault(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (vault.legacy) {
      throw new Error('vault.json predates roles; start the server once to migrate it');
    }
  }
  let user = vault.users[username];
  const created = !user;
  if (!user) {
    // A leading dot is allowed in a repository's name and in nothing else; a
    // user carrying one would be a name the interface hides for no reason.
    if (isDotName(username)) throw new Error(`invalid username ${username}`);
    user = { tokens: [], ...(opts.siteAdmin ? { siteAdmin: true } : {}) };
    vault.users[username] = user;
  } else if (opts.siteAdmin) {
    throw new Error(`user ${username} already exists; site admin is granted from the admin page or the users API`);
  }
  // A caller may supply the token instead of taking a minted one, which is how
  // a vault can be bootstrapped with a token its operator already holds. Only
  // the hash is stored either way, so the two cases differ in nothing else.
  const { token, hash } = opts.token ? { token: opts.token, hash: hashToken(opts.token) } : mintToken();
  const rec: TokenRecord = { hash, id: crypto.randomBytes(4).toString('hex'), created: new Date().toISOString() };
  if (opts.tokenScope && opts.tokenScope.length) rec.scope = opts.tokenScope;
  user.tokens.push(rec);
  writeVault(file, vault);
  return { token, created, user };
}

export function addUserToken(
  root: string,
  username: string,
  opts: { siteAdmin?: boolean; tokenScope?: string[]; token?: string } = {}
): { token: string; created: boolean; user: UserRecord } {
  return editVault(root, (file) => addUserTokenLocked(file, username, opts));
}

/**
 * The last step of the permissions migration (src/migrate.ts): rewrite a
 * pre-roles vault.json in the current shape, granting the site-admin bit to
 * the users named. The glob scopes are dropped here and only here, after the
 * migration has translated them into ownership and collaborator files; the
 * original file survives as the backup the migration wrote first.
 */
export function finishPermsMigration(root: string, siteAdmins: string[]): void {
  editVault(root, (file) => {
    const vault = normalizeVault(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!vault.legacy) return;
    delete vault.legacy;
    for (const [name, user] of Object.entries(vault.users)) {
      delete user.legacy;
      if (siteAdmins.includes(name)) user.siteAdmin = true;
    }
    writeVault(file, vault);
  });
}

/** Grant or withdraw the site-admin bit. */
export function setSiteAdmin(root: string, username: string, value: boolean): UserRecord {
  return editVault(root, (file) => {
    if (!fs.existsSync(file)) {
      throw new Error(`no vault.json at ${file}; create the user first with: mochi user add ${username}`);
    }
    const vault = readVaultForEdit(file);
    const user = vault.users[username];
    if (!user) {
      throw new Error(`user ${username} does not exist; create it with: mochi user add ${username}`);
    }
    if (value) user.siteAdmin = true;
    else delete user.siteAdmin;
    writeVault(file, vault);
    return user;
  });
}

/**
 * Initialize a vault that has none, creating the owner and its first token.
 * Returns null when there is already a vault.json, since a vault is
 * initialized once and everything after that is the operator's own doing.
 *
 * `presetToken` lets the token be handed in rather than minted, which is what
 * `mochi deploy` does: it mints the token on the operator's machine and
 * passes it to the server as an environment secret, so a fresh remote vault can
 * be logged in to without reading a token back out of the logs. A preset token
 * is never echoed by the caller, so it does not reach the log at all.
 */
export function bootstrapVault(
  root: string,
  presetToken?: string | null
): { username: string; token: string; preset: boolean } | null {
  const preset = (presetToken ?? '').trim();
  if (presetToken !== undefined && presetToken !== null && presetToken !== '' && !preset) {
    throw new Error('the owner token given for a new vault is blank');
  }
  // A token travels as a Basic-auth password and lands in URLs' credential
  // slots, so a supplied one is held to the shape of a minted one rather than
  // taken as given: printable, no spaces, and long enough not to be guessed.
  if (preset && !/^[\x21-\x7e]{24,256}$/.test(preset)) {
    throw new Error(
      'the owner token given for a new vault is not usable: it must be 24 to 256 characters, ' +
        'printable, and contain no spaces'
    );
  }
  // The existence check and the creation are one operation. Two servers started
  // against one fresh directory would otherwise both find no vault.json and both
  // bootstrap, and the second owner token to be written would be the only one
  // that worked, while both had been printed as if they were the credential.
  return editVault(root, (file) => {
    if (fs.existsSync(file)) return null;
    const { token } = addUserTokenLocked(file, 'owner', {
      siteAdmin: true,
      ...(preset ? { token: preset } : {}),
    });
    return { username: 'owner', token, preset: preset !== '' };
  });
}


/**
 * Revoke one token by its id. Revoking the token currently in use is allowed and
 * reported plainly rather than refused: locking yourself out is your business,
 * and vault.json remains hand-editable either way.
 */
export function revokeToken(root: string, username: string, id: string): { revoked: boolean; remaining: number } {
  return editVault(root, (file) => {
    const vault = readVaultForEdit(file);
    const user = vault.users[username];
    if (!user) throw new Error(`no user ${username}`);
    const before = user.tokens.length;
    user.tokens = user.tokens.filter((t) => tokenId(t) !== id);
    if (user.tokens.length === before) return { revoked: false, remaining: before };
    writeVault(file, vault);
    return { revoked: true, remaining: user.tokens.length };
  });
}

/** How a session bound to a passkey spells it in the cookie payload: never a
 * hex token hash, so the two kinds of binding cannot collide. */
export const PASSKEY_BINDING_PREFIX = 'pk:';

export function passkeyBinding(credentialId: string): string {
  return PASSKEY_BINDING_PREFIX + credentialId;
}

/** How a session signed in with GitHub spells its binding: the numeric GitHub
 * id behind a prefix, so it can collide with neither a token hash nor a
 * passkey binding. */
export const GITHUB_BINDING_PREFIX = 'gh:';

export function githubBinding(id: number): string {
  return GITHUB_BINDING_PREFIX + String(id);
}

/**
 * The AuthResult a session binding resolves to against a live vault: a token
 * binding finds its TokenRecord, while a passkey or GitHub binding finds the
 * credential and stands a synthetic token in for it. The synthetic record
 * carries no scope, deliberately: a passkey or a GitHub sign-in proves the
 * user, not a narrowed token, so a session signed in with one has the user's
 * own rights, exactly as an unscoped token would. Its hash is the binding
 * string, which is not hex and so can never name a real token anywhere else.
 */
export function authForBinding(vault: Vault, username: string, binding: string): AuthResult | null {
  const user = vault.users[username];
  if (!user) return null;
  if (binding.startsWith(PASSKEY_BINDING_PREFIX)) {
    const id = binding.slice(PASSKEY_BINDING_PREFIX.length);
    if (!user.passkeys?.some((p) => p.id === id)) return null;
    return { username, user, token: { hash: binding } };
  }
  if (binding.startsWith(GITHUB_BINDING_PREFIX)) {
    const id = Number(binding.slice(GITHUB_BINDING_PREFIX.length));
    if (!Number.isInteger(id) || user.github?.id !== id) return null;
    return { username, user, token: { hash: binding } };
  }
  const token = user.tokens.find((t) => t.hash === binding);
  return token ? { username, user, token } : null;
}

/** The user a credential id belongs to, for a sign-in that only knows the key. */
export function findPasskey(
  vault: Vault,
  credentialId: string
): { username: string; user: UserRecord; passkey: PasskeyRecord } | null {
  for (const [username, user] of Object.entries(vault.users)) {
    const passkey = user.passkeys?.find((p) => p.id === credentialId);
    if (passkey) return { username, user, passkey };
  }
  return null;
}

/** Register a passkey. The credential id must be new to the whole vault: an
 * authenticator names its keys uniquely, so a collision is a replayed
 * registration rather than a coincidence to accommodate. */
export function addPasskey(root: string, username: string, rec: Omit<PasskeyRecord, 'created'>): PasskeyRecord {
  return editVault(root, (file) => {
    const vault = readVaultForEdit(file);
    const user = vault.users[username];
    if (!user) throw new Error(`no user ${username}`);
    if (findPasskey(vault, rec.id)) throw new Error('this passkey is already registered');
    const stored: PasskeyRecord = { ...rec, created: new Date().toISOString() };
    user.passkeys = [...(user.passkeys ?? []), stored];
    writeVault(file, vault);
    return stored;
  });
}

/** Remove one passkey, ending any session signed in with it. */
export function removePasskey(root: string, username: string, credentialId: string): boolean {
  return editVault(root, (file) => {
    const vault = readVaultForEdit(file);
    const user = vault.users[username];
    if (!user) throw new Error(`no user ${username}`);
    const before = user.passkeys?.length ?? 0;
    const after = (user.passkeys ?? []).filter((p) => p.id !== credentialId);
    if (after.length === before) return false;
    if (after.length) user.passkeys = after;
    else delete user.passkeys;
    writeVault(file, vault);
    return true;
  });
}

/**
 * Record the signature counter an assertion carried. Best effort: the write
 * exists to catch a cloned authenticator replaying an old counter, and a
 * vault.json that cannot be written right now is not worth failing a sign-in
 * whose signature already verified.
 */
export function setPasskeyCounter(root: string, username: string, credentialId: string, counter: number): void {
  editVault(root, (file) => {
    const vault = readVaultForEdit(file);
    const passkey = vault.users[username]?.passkeys?.find((p) => p.id === credentialId);
    if (!passkey || passkey.counter >= counter) return;
    passkey.counter = counter;
    writeVault(file, vault);
  });
}

/** Replace the git author emails aliased to a user. An empty list clears them. */
export function setUserEmails(root: string, username: string, emails: string[]): UserRecord {
  return editVault(root, (file) => {
    const vault = readVaultForEdit(file);
    const user = vault.users[username];
    if (!user) throw new Error(`no user ${username}`);
    if (emails.length) user.emails = emails;
    else delete user.emails;
    writeVault(file, vault);
    return user;
  });
}

/**
 * Replace a user's profile. Empty fields are dropped rather than stored, and a
 * profile with nothing left is removed outright, so vault.json never carries an
 * empty object for a user who cleared theirs.
 */
export function setUserProfile(root: string, username: string, profile: UserProfile): UserRecord {
  return editVault(root, (file) => {
    const vault = readVaultForEdit(file);
    const user = vault.users[username];
    if (!user) throw new Error(`no user ${username}`);
    const clean: UserProfile = {};
    if (profile.name?.trim()) clean.name = profile.name.trim();
    if (profile.bio?.trim()) clean.bio = profile.bio.trim();
    const links = (profile.links ?? []).map((l) => l.trim()).filter((l) => l !== '');
    if (links.length) clean.links = links;
    if (Object.keys(clean).length) user.profile = clean;
    else delete user.profile;
    writeVault(file, vault);
    return user;
  });
}

/** Whether the vault knows a user by this name; false when it failed to load. */
export function userExists(root: string, name: string): boolean {
  const state = loadVault(root);
  return state.status === 'ok' && Object.prototype.hasOwnProperty.call(state.vault.users, name);
}

/**
 * The user a commit author email belongs to, or null when it belongs to no
 * one this vault knows. Two ways in: the synthetic `<user>@noreply.<anything>`
 * the web editor writes, recognised by shape so the answer does not depend on
 * which hostname the vault was being served under at the time, and the emails
 * a user has listed as theirs.
 */
export function accountForEmail(vault: Vault, email: string): string | null {
  const lower = email.toLowerCase();
  const m = lower.match(/^([^@]+)@noreply\./);
  if (m && vault.users[m[1]]) return m[1];
  for (const [name, user] of Object.entries(vault.users)) {
    if (user.emails?.some((e) => e.toLowerCase() === lower)) return name;
  }
  return null;
}

export interface Contributor {
  name: string;
  email: string;
  commits: number;
  /** The vault user these commits belong to, or null for an identity the vault does not know. */
  account: string | null;
}

/**
 * Fold one person's identities into one contributor. Grouped by account where
 * an email resolves to one, and by email otherwise; within a group the
 * human-written identity is preferred over the synthetic one for the name and
 * the email shown, since "Jeremy" is who committed and `owner@noreply...` is
 * how. Without a vault (one that failed to load) everyone stands as git
 * reported them.
 */
export function mergeContributors(
  vault: Vault | null,
  people: { name: string; email: string; commits: number }[]
): Contributor[] {
  const groups = new Map<string, Contributor & { bestCommits: number; bestSynthetic: boolean }>();
  for (const p of people) {
    const account = vault ? accountForEmail(vault, p.email) : null;
    const key = account !== null ? `u:${account}` : `e:${(p.email || p.name).toLowerCase()}`;
    const synthetic = /@noreply\./i.test(p.email);
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { ...p, account, bestCommits: p.commits, bestSynthetic: synthetic });
      continue;
    }
    g.commits += p.commits;
    // The identity shown is the best-represented human one; a synthetic
    // identity only fronts a group that holds nothing else.
    if ((g.bestSynthetic && !synthetic) || (g.bestSynthetic === synthetic && p.commits > g.bestCommits)) {
      g.name = p.name;
      g.email = p.email;
      g.bestCommits = p.commits;
      g.bestSynthetic = synthetic;
    }
  }
  return [...groups.values()]
    .map(({ bestCommits: _b, bestSynthetic: _s, ...c }) => c)
    .sort((a, b) => b.commits - a.commits);
}

/** The user a GitHub id is linked to, for a sign-in arriving from GitHub. */
export function findGithubAccount(vault: Vault, id: number): { username: string; user: UserRecord } | null {
  for (const [username, user] of Object.entries(vault.users)) {
    if (user.github?.id === id) return { username, user };
  }
  return null;
}

/**
 * Link a GitHub account to a user. One GitHub id links to at most one user,
 * or a sign-in with it would have two answers; relinking the same id to the
 * same user only refreshes the login.
 */
export function linkGithub(root: string, username: string, account: { id: number; login: string }): GithubAccount {
  return editVault(root, (file) => {
    const vault = readVaultForEdit(file);
    const user = vault.users[username];
    if (!user) throw new Error(`no user ${username}`);
    const holder = findGithubAccount(vault, account.id);
    if (holder && holder.username !== username) {
      throw new Error(`The GitHub account ${account.login} is already linked to ${holder.username}.`);
    }
    const linked = user.github?.id === account.id ? user.github.linked : new Date().toISOString();
    const stored: GithubAccount = { id: account.id, login: account.login, ...(linked ? { linked } : {}) };
    user.github = stored;
    writeVault(file, vault);
    return stored;
  });
}

/** Remove a user's GitHub link, ending any session signed in with it. */
export function unlinkGithub(root: string, username: string): boolean {
  return editVault(root, (file) => {
    const vault = readVaultForEdit(file);
    const user = vault.users[username];
    if (!user) throw new Error(`no user ${username}`);
    if (!user.github) return false;
    delete user.github;
    writeVault(file, vault);
    return true;
  });
}

/** Add a GitHub account to the approved list, or refresh its login there. */
export function approveGithub(root: string, account: { id: number; login: string }): GithubApproval {
  return editVault(root, (file) => {
    const vault = readVaultForEdit(file);
    const list = vault.githubApproved ?? [];
    const existing = list.find((a) => a.id === account.id);
    if (existing) {
      existing.login = account.login;
      vault.githubApproved = list;
      writeVault(file, vault);
      return existing;
    }
    const added: GithubApproval = { id: account.id, login: account.login, added: new Date().toISOString() };
    vault.githubApproved = [...list, added];
    writeVault(file, vault);
    return added;
  });
}

/** Remove one approval by GitHub id. A user already linked is not touched:
 * approval gates only the first sign-in, which creates an account. */
export function unapproveGithub(root: string, id: number): boolean {
  return editVault(root, (file) => {
    const vault = readVaultForEdit(file);
    const before = vault.githubApproved?.length ?? 0;
    const after = (vault.githubApproved ?? []).filter((a) => a.id !== id);
    if (after.length === before) return false;
    if (after.length) vault.githubApproved = after;
    else delete vault.githubApproved;
    writeVault(file, vault);
    return true;
  });
}

export type GithubSignIn =
  | { kind: 'ok'; username: string; created: boolean }
  | { kind: 'refused' }
  | { kind: 'error'; message: string };

/**
 * What a completed GitHub sign-in means to this vault. A linked account wins
 * outright; failing that, an approved id has an account created for it, named
 * after the GitHub login (with a numeric suffix when that name is taken or
 * reserved); anything else is refused. One vault edit end to end, so the
 * check and the provisioning cannot race a second sign-in into two accounts.
 * The new account holds no tokens: it can use the web signed in with GitHub,
 * and pushing over git waits until an administrator mints it a token.
 */
export function resolveGithubSignIn(root: string, account: { id: number; login: string }): GithubSignIn {
  return editVault(root, (file) => {
    if (!fs.existsSync(file)) return { kind: 'refused' } as const;
    const vault = readVaultForEdit(file);
    const linked = findGithubAccount(vault, account.id);
    if (linked) {
      // A rename on GitHub's side refreshes the stored login, which is
      // display only; the id did the matching.
      if (linked.user.github && linked.user.github.login !== account.login) {
        linked.user.github.login = account.login;
        writeVault(file, vault);
      }
      return { kind: 'ok', username: linked.username, created: false } as const;
    }
    const approval = (vault.githubApproved ?? []).find((a) => a.id === account.id);
    if (!approval) return { kind: 'refused' } as const;
    let username: string | null = null;
    for (const candidate of [account.login, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${account.login}-${n}`)]) {
      if (isValidUserName(candidate) && !vault.users[candidate]) {
        username = candidate;
        break;
      }
    }
    if (!username) {
      return { kind: 'error', message: `No free username could be derived from ${account.login}.` } as const;
    }
    vault.users[username] = {
      tokens: [],
      github: { id: account.id, login: account.login, linked: new Date().toISOString() },
    };
    if (approval.login !== account.login) approval.login = account.login;
    writeVault(file, vault);
    return { kind: 'ok', username, created: true } as const;
  });
}

/** Remove a user, and with them every token they hold. */
export function removeUser(root: string, username: string): boolean {
  return editVault(root, (file) => {
    const vault = readVaultForEdit(file);
    if (!vault.users[username]) return false;
    delete vault.users[username];
    writeVault(file, vault);
    return true;
  });
}
