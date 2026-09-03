import express, { Express, NextFunction, Request, Response } from 'express';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { GitRepo } from './git';
import { checkPushAuth, checkReadAuth } from './githttp';
import { AuthLimiter } from './limit';
import { LfsContext, SignedAction, localObjectPath, verifyTransfer } from './lfsstore';
import { findRepo } from './scan';
import { baseUrlOf } from './web';

// The server side of the Git LFS Batch API, plus the two transfer routes used
// only by the local backend. The Batch API lets the server return an
// arbitrary URL per object transfer, so with the s3 backend we return
// presigned bucket URLs and large-file bytes never pass through this process.
//
// git-lfs derives its endpoint by appending `.git/info/lfs` to the remote
// URL; findRepo strips the optional `.git`, so both spellings resolve and no
// client-side configuration is needed.

const MAX_BATCH_OBJECTS = 1000;
const HEAD_CONCURRENCY = 8;

// Object-id validation is the security boundary of this module: every oid
// must match this before it is used to build a key or path, playing the same
// role for object ids that isValidName plays for collection and repo names.
const OID_RE = /^[0-9a-f]{64}$/;

function sendLfs(res: Response, status: number, body: unknown): void {
  res
    .status(status)
    .set('Content-Type', 'application/vnd.git-lfs+json; charset=utf-8')
    // Batch responses carry short-lived signed URLs; nothing in front of the
    // server should hold on to them.
    .set('Cache-Control', 'no-store')
    .send(JSON.stringify(body));
}

function lfsError(res: Response, status: number, message: string): void {
  sendLfs(res, status, { message });
}

// A reader cancelling a large download, or a client dropping mid-upload, is
// ordinary traffic for this module rather than a fault, and must not fill the
// log with stack traces.
function isClientAbort(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET' || code === 'ECANCELED';
}

// Async-handler wrapper that reports failures in the LFS error shape rather
// than the HTML error page.
function lah(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((e) => {
      if (isClientAbort(e)) {
        res.end();
        return;
      }
      console.error(e);
      if (!res.headersSent) lfsError(res, 500, 'internal error');
      else res.end();
    });
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// The local backend signs relative hrefs (it does not know the request host);
// prefix the request's own base URL. Bucket hrefs are already absolute.
function action(a: SignedAction, base: string): { href: string; header: Record<string, string>; expires_in: number } {
  return { href: a.href.startsWith('/') ? base + a.href : a.href, header: a.header, expires_in: a.expiresIn };
}

class SizeExceeded extends Error {}

export function registerLfs(app: Express, root: string, lfs: LfsContext | null, authLimiter: AuthLimiter): void {
  const store = lfs?.store ?? null;
  const maxSize = lfs?.maxSize ?? 0;
  // Lenient about the request content type: git-lfs sends
  // application/vnd.git-lfs+json, curl in tests may not.
  const json = express.json({ type: () => true, limit: '5mb' });

  // A body that will not parse is a malformed request, and must be reported
  // in the LFS error shape rather than falling through to the HTML error
  // page the app-level handler would render.
  const jsonErr = (err: Error, _req: Request, res: Response, next: NextFunction) => {
    if (err) {
      lfsError(res, 422, `request body is not valid JSON: ${err.message}`);
      return;
    }
    next();
  };

  function unavailable(res: Response): boolean {
    if (store) return false;
    lfsError(res, 501, 'Git LFS is not enabled on this vault');
    return true;
  }

  function sendDenied(
    res: Response,
    check: { status: number; message: string; retryAfter?: number }
  ): void {
    if (check.status === 401) {
      // LFS-Authenticate is the header git-lfs looks for.
      res.setHeader('LFS-Authenticate', 'Basic realm="mochi"');
      res.setHeader('WWW-Authenticate', 'Basic realm="mochi"');
    }
    if (check.retryAfter !== undefined) res.setHeader('Retry-After', String(check.retryAfter));
    lfsError(res, check.status, check.message);
  }

  // Upload (and verify) reuse the push authorization.
  function requireUploadAuth(req: Request, res: Response, repo: GitRepo): boolean {
    const check = checkPushAuth(root, authLimiter, req, repo.collection, repo.name, repo);
    if (!check.ok) {
      sendDenied(res, check);
      return false;
    }
    return true;
  }

  /**
   * The repository these LFS objects belong to, readable by this request, or
   * null having sent the refusal. Reading follows the git wire's rule
   * (checkReadAuth): public repositories serve anonymously, and a private one
   * answers exactly as an absent one does.
   */
  function requireRepoRead(req: Request, res: Response): GitRepo | null {
    const repo = findRepo(root, req.params.collection, req.params.repo);
    const check = checkReadAuth(root, authLimiter, req, repo);
    if (!check.ok) {
      sendDenied(res, check);
      return null;
    }
    if (!repo) {
      // Unreachable: checkReadAuth answers ok only for a repository it saw.
      lfsError(res, 404, 'repository not found');
      return null;
    }
    return repo;
  }

  // ---- Batch API ----

  app.post(
    '/:collection/:repo/info/lfs/objects/batch',
    json,
    jsonErr,
    lah(async (req, res) => {
      if (unavailable(res) || !store) return;
      const repo = requireRepoRead(req, res);
      if (!repo) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const operation = body.operation;
      if (operation !== 'download' && operation !== 'upload') {
        lfsError(res, 422, 'operation must be "download" or "upload"');
        return;
      }
      const transfers = body.transfers;
      if (transfers !== undefined && !(Array.isArray(transfers) && transfers.includes('basic'))) {
        lfsError(res, 422, 'only the "basic" transfer adapter is supported');
        return;
      }
      if (body.hash_algo !== undefined && body.hash_algo !== 'sha256') {
        lfsError(res, 422, 'only the sha256 hash algorithm is supported');
        return;
      }
      const objects = body.objects;
      if (!Array.isArray(objects)) {
        lfsError(res, 422, '"objects" must be an array');
        return;
      }
      if (objects.length > MAX_BATCH_OBJECTS) {
        lfsError(res, 422, `batches are limited to ${MAX_BATCH_OBJECTS} objects`);
        return;
      }
      const parsed: { oid: string; size: number }[] = [];
      for (const o of objects) {
        const rec = (typeof o === 'object' && o !== null ? o : {}) as Record<string, unknown>;
        if (typeof rec.oid !== 'string' || !OID_RE.test(rec.oid)) {
          lfsError(res, 422, 'invalid object id (expected 64 lowercase hex characters)');
          return;
        }
        if (typeof rec.size !== 'number' || !Number.isSafeInteger(rec.size) || rec.size < 0) {
          lfsError(res, 422, 'invalid object size');
          return;
        }
        parsed.push({ oid: rec.oid, size: rec.size });
      }
      // Download needs no more than the read access requireRepoRead already
      // established, matching anonymous clone: a public repository must
      // support `git clone` plus `git lfs pull` with no credentials.
      if (operation === 'upload' && !requireUploadAuth(req, res, repo)) return;

      const base = baseUrlOf(req);
      const authz = req.get('authorization');
      // One storage lookup per distinct object id. Download is anonymous, so
      // without this a single request repeating one oid a thousand times
      // would fan out to a thousand bucket operations.
      const distinct = [...new Map(parsed.map((o) => [o.oid, o])).values()];
      const results = await mapLimit(distinct, HEAD_CONCURRENCY, async (o) => {
        const info = await store.head(repo.collection, repo.name, o.oid);
        if (operation === 'download') {
          if (!info) {
            // A presigned URL for a missing object would surface as a
            // confusing mid-transfer failure; fail the object up front.
            return { oid: o.oid, size: o.size, error: { code: 404, message: 'object not found' } };
          }
          const dl = await store.signDownload(repo.collection, repo.name, o.oid);
          return {
            oid: o.oid,
            size: info.size,
            authenticated: true,
            actions: { download: action(dl, base) },
          };
        }
        // Already present: omitting actions tells the client to skip the
        // upload; this is the deduplication mechanism. Present at the size
        // the pointer claims, that is. A bucket takes whatever bytes a
        // presigned PUT delivers, so a client that lied about the size in
        // one batch and uploaded something else left an object under this
        // id that is not this object; it fails verification, but it would
        // otherwise also stand in for every honest upload of the real one
        // from then on. An object of the wrong size is treated as absent
        // and the upload it is given overwrites it.
        if (info && info.size === o.size) return { oid: o.oid, size: o.size, authenticated: true };
        if (o.size > maxSize) {
          return {
            oid: o.oid,
            size: o.size,
            error: { code: 422, message: `object exceeds the maximum size of ${maxSize} bytes` },
          };
        }
        const up = await store.signUpload(repo.collection, repo.name, o.oid, o.size);
        return {
          oid: o.oid,
          size: o.size,
          authenticated: true,
          actions: {
            upload: action(up, base),
            verify: {
              href: `${base}/${encodeURIComponent(repo.collection)}/${encodeURIComponent(repo.name)}/info/lfs/objects/verify`,
              header: authz ? { Authorization: authz } : {},
              expires_in: up.expiresIn,
            },
          },
        };
      });
      // Answer in the shape the client asked in: one entry per requested
      // object, in request order, even though repeats shared a lookup.
      const byOid = new Map(results.map((r) => [r.oid, r]));
      const out = parsed.map((o) => byOid.get(o.oid));
      sendLfs(res, 200, { transfer: 'basic', objects: out, hash_algo: 'sha256' });
    })
  );

  // ---- verify endpoint ----

  // Upload bytes bypass the server entirely in the s3 configuration, so this
  // is the only integrity check available there.
  app.post(
    '/:collection/:repo/info/lfs/objects/verify',
    json,
    jsonErr,
    lah(async (req, res) => {
      if (unavailable(res) || !store) return;
      const repo = requireRepoRead(req, res);
      if (!repo) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const oid = body.oid;
      const size = body.size;
      if (typeof oid !== 'string' || !OID_RE.test(oid)) {
        lfsError(res, 422, 'invalid object id (expected 64 lowercase hex characters)');
        return;
      }
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
        lfsError(res, 422, 'invalid object size');
        return;
      }
      if (!requireUploadAuth(req, res, repo)) return;
      const info = await store.head(repo.collection, repo.name, oid);
      if (!info) {
        lfsError(res, 404, 'object not found');
        return;
      }
      if (info.size !== size) {
        lfsError(res, 422, `size mismatch: expected ${size} bytes, stored object has ${info.size}`);
        return;
      }
      sendLfs(res, 200, { oid, size });
    })
  );

  // ---- local transfer routes ----

  // These serve the local backend's signed URLs. They are registered
  // unconditionally so a signed URL issued before a configuration change
  // resolves to a clear error rather than a router 404.

  interface TransferTarget {
    collection: string;
    repo: string;
    oid: string;
    disp: string;
  }

  function checkTransfer(req: Request, res: Response, op: 'download' | 'upload'): TransferTarget | null {
    if (unavailable(res) || !store) return null;
    const repo = findRepo(root, req.params.collection, req.params.repo);
    if (!repo) {
      lfsError(res, 404, 'repository not found');
      return null;
    }
    const oid = req.params.oid;
    if (!OID_RE.test(oid)) {
      lfsError(res, 422, 'invalid object id');
      return null;
    }
    if (store.kind !== 'local') {
      lfsError(res, 400, 'this vault stores LFS objects in a bucket; transfer URLs point at the bucket');
      return null;
    }
    // exp must be exactly the digits that were signed, not merely something
    // parseInt can salvage from them: the signature covers String(exp), so
    // accepting "1700000000zzz" would put a byte in the URL that no signature
    // covers, contradicting the invariant the scheme rests on.
    const rawExp = typeof req.query.exp === 'string' ? req.query.exp : '';
    const sig = typeof req.query.sig === 'string' ? req.query.sig : '';
    const disp = typeof req.query.disp === 'string' ? req.query.disp : '';
    if (!/^\d{1,15}$/.test(rawExp)) {
      lfsError(res, 403, 'malformed transfer URL');
      return null;
    }
    const exp = parseInt(rawExp, 10);
    if (exp < Math.floor(Date.now() / 1000)) {
      lfsError(res, 403, 'this transfer URL has expired');
      return null;
    }
    if (!verifyTransfer(root, op, repo.collection, repo.name, oid, exp, disp, sig)) {
      lfsError(res, 403, 'invalid transfer signature');
      return null;
    }
    return { collection: repo.collection, repo: repo.name, oid, disp };
  }

  app.get(
    '/:collection/:repo/info/lfs/objects/:oid',
    lah(async (req, res) => {
      const t = checkTransfer(req, res, 'download');
      if (!t) return;
      const file = localObjectPath(root, t.collection, t.repo, t.oid);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        lfsError(res, 404, 'object not found');
        return;
      }
      // These bytes are repository content served from the vault's own
      // origin, so they get the same treatment as the raw route in
      // src/browse.ts: a sandbox CSP and an attachment disposition, so an
      // uploaded HTML or SVG payload can never run as script here. The
      // filename is only present on hrefs the raw route signed.
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(st.size));
      res.setHeader('Content-Security-Policy', 'sandbox');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader(
        'Content-Disposition',
        t.disp === '' ? 'attachment' : `attachment; filename="${t.disp}"`
      );
      await pipeline(fs.createReadStream(file), res);
    })
  );

  app.put(
    '/:collection/:repo/info/lfs/objects/:oid',
    lah(async (req, res) => {
      const t = checkTransfer(req, res, 'upload');
      if (!t) return;
      const file = localObjectPath(root, t.collection, t.repo, t.oid);
      const dir = path.dirname(file);
      fs.mkdirSync(dir, { recursive: true });
      // Stream to a temporary file and rename into place, so a failed or
      // interrupted upload never leaves a corrupt object at the final path.
      // The rename is atomic, so two clients uploading the same object
      // concurrently are harmless: the content is identical by construction.
      const tmp = path.join(dir, `tmp-${crypto.randomBytes(8).toString('hex')}`);
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      const hasher = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          // The signature binds the oid but not a size, so cap what a signed
          // URL can write to disk.
          if (bytes > maxSize) {
            cb(new SizeExceeded());
            return;
          }
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      try {
        await pipeline(req, hasher, fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        if (e instanceof SizeExceeded) {
          lfsError(res, 422, `object exceeds the maximum size of ${maxSize} bytes`);
          return;
        }
        throw e;
      }
      const digest = hash.digest('hex');
      if (digest !== t.oid) {
        fs.rmSync(tmp, { force: true });
        lfsError(res, 422, `content hashes to ${digest}, not the requested object id`);
        return;
      }
      fs.renameSync(tmp, file);
      res.status(200).end();
    })
  );

  // ---- locking API: deliberately unsupported ----

  // git-lfs probes /locks/verify at push time and treats a 404 as "locking
  // not supported", which is the answer we want.
  app.all('/:collection/:repo/info/lfs/locks', (_req, res) => {
    lfsError(res, 404, 'the LFS file locking API is not supported');
  });
  app.all('/:collection/:repo/info/lfs/locks/*', (_req, res) => {
    lfsError(res, 404, 'the LFS file locking API is not supported');
  });
}
