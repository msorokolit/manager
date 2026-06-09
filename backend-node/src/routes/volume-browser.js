// In-browser file manager for docker volumes (sidecar pattern).
//
// Why a sidecar?
// --------------
// Docker volumes are a container-scoped abstraction. The supported way to
// touch their contents from outside the daemon is to mount them into a
// container; that container is our "sidecar". One sidecar per volume,
// reused across requests, started lazily on first browse. The sidecar:
//
//   - runs from `BROWSER_IMAGE` (default python:3-alpine; chosen for its
//     tiny size + `python3` for inline scripts + standard POSIX tools)
//   - has the volume mounted read-write at /target
//   - has no network attached (NetworkMode: 'none')
//   - has bounded resources (Memory, NanoCpus, PidsLimit) so a pathological
//     volume can't OOM the host
//   - is labelled `com.docker.manager.role=volume-browser` so an operator
//     can find/kill them all with `docker ps -f label=...`
//
// Path safety
// -----------
// User-supplied paths are first normalised against `/target` (rejects
// URL-level traversal like `..`). Then, before every filesystem-touching
// operation, we run `assertSafe()` inside the sidecar — a tiny Python
// exec that calls `os.path.realpath()` and refuses to proceed if the
// resolved path escapes `/target`. This defends against symlink escape
// (an admin or a previous user putting `escape -> /etc` inside the
// volume).
import { Buffer } from 'node:buffer';
import path from 'node:path';
import multer from 'multer';
import { Type } from '@sinclair/typebox';
import tar from 'tar-stream';
import { getClient } from '../docker-client.js';
import { settings } from '../config.js';
import { asyncHandler, HttpError, intQuery } from '../util.js';
import { createApiRouter, customResponse, streamResponse } from '../route-builder.js';
import {
  PassThroughObject,
  VolumeBrowseChmodRequest,
  VolumeBrowseListResponse,
  VolumeBrowseRenameRequest,
  VolumeBrowseViewResponse,
} from '../schemas/index.js';

const r = createApiRouter('/api/volumes', { tag: 'volume-browser' });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 },
});

const BROWSER_LABEL = 'com.docker.manager.role';
const BROWSER_LABEL_VAL = 'volume-browser';
const BROWSER_VOL_LABEL = 'com.docker.manager.volume';

// ---------- Sidecar inline scripts ----------

// Listing: rich metadata + cheap pagination + realpath escape check on the
// directory itself. Sorts entries by name; the UI re-sorts client-side for
// other columns so we don't have to round-trip.
const LIST_SCRIPT = `
import os, stat, sys, json
try:
    import pwd, grp
except ImportError:
    pwd = grp = None

p = sys.argv[1]
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 5000
offset = int(sys.argv[3]) if len(sys.argv) > 3 else 0

try:
    real_p = os.path.realpath(p)
    if not (real_p == '/target' or real_p.startswith('/target/')):
        print(json.dumps({"error": "Path escapes the volume root"}))
        sys.exit(0)
    entries = sorted(os.listdir(p))
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(0)

total = len(entries)
page = entries[offset:offset + limit]

out = []
for n in page:
    f = os.path.join(p, n)
    try:
        st = os.lstat(f)
    except OSError:
        continue
    item = {
        "name": n,
        "is_dir": stat.S_ISDIR(st.st_mode),
        "is_link": stat.S_ISLNK(st.st_mode),
        "size": st.st_size,
        "mode": st.st_mode,
        "mode_str": stat.filemode(st.st_mode),
        "mtime": st.st_mtime,
        "uid": st.st_uid,
        "gid": st.st_gid,
    }
    if pwd is not None:
        try: item["user"] = pwd.getpwuid(st.st_uid).pw_name
        except KeyError: item["user"] = str(st.st_uid)
    else:
        item["user"] = str(st.st_uid)
    if grp is not None:
        try: item["group"] = grp.getgrgid(st.st_gid).gr_name
        except KeyError: item["group"] = str(st.st_gid)
    else:
        item["group"] = str(st.st_gid)
    if item["is_link"]:
        try: item["link_target"] = os.readlink(f)
        except OSError: item["link_target"] = None
    out.append(item)

print(json.dumps({"total": total, "entries": out}))
`;

// Symlink-escape guard: takes a path, exits 0 if its realpath is inside
// /target, 2 if it escapes, 3 on other error. Run before any operation
// that resolves symlinks (get_archive, put_archive, rm, mkdir, rename).
const ASSERT_SAFE_SCRIPT = `
import os, sys
try:
    p = sys.argv[1]
    rp = os.path.realpath(p)
    # For ops on a not-yet-existing path (mkdir, rename target), the path
    # itself won't exist; resolve its parent and re-attach the leaf.
    if not os.path.exists(p):
        parent = os.path.realpath(os.path.dirname(p))
        rp = os.path.join(parent, os.path.basename(p))
    if rp == '/target' or rp.startswith('/target/'):
        sys.exit(0)
    sys.exit(2)
except Exception as e:
    print(str(e), file=sys.stderr)
    sys.exit(3)
`;

// Inline file view: text content with a hard size cap, binary detection,
// utf-8/latin-1 fallback, realpath check.
const VIEW_SCRIPT = `
import os, stat, sys, json
MAX = 1024 * 1024  # 1 MB

p = sys.argv[1]
try:
    rp = os.path.realpath(p)
    if not (rp == '/target' or rp.startswith('/target/')):
        print(json.dumps({"error": "Path escapes the volume root"})); sys.exit(0)
    st = os.stat(p)
    if not stat.S_ISREG(st.st_mode):
        print(json.dumps({"error": "Not a regular file"})); sys.exit(0)
    with open(p, 'rb') as f:
        data = f.read(MAX + 1)
    truncated = len(data) > MAX
    if truncated:
        data = data[:MAX]
    is_binary = b'\\x00' in data[:8192]
    if is_binary:
        print(json.dumps({"size": st.st_size, "is_binary": True, "truncated": truncated}))
    else:
        try:
            content = data.decode('utf-8'); encoding = 'utf-8'
        except UnicodeDecodeError:
            content = data.decode('latin-1'); encoding = 'latin-1'
        print(json.dumps({
            "size": st.st_size, "is_binary": False, "truncated": truncated,
            "encoding": encoding, "content": content,
        }))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

// ---------- Helpers ----------

function browserName(volume) {
  const safe = String(volume).replace(/[^a-zA-Z0-9_-]/g, '') || 'vol';
  return `docker-manager-browser-${safe}`;
}

function safePath(rel) {
  const cleaned = path.posix.normalize(
    path.posix.join('/target', String(rel || '').replace(/^\/+/, '')),
  );
  if (cleaned !== '/target' && !cleaned.startsWith('/target/')) {
    throw new HttpError(400, 'Invalid path');
  }
  return cleaned;
}

// Per-volume mutex for sidecar bring-up. Two concurrent first-time browses
// for the same volume would otherwise both try to createContainer({name})
// and the second would 409. Each volume's lock entry is deleted as soon as
// the in-flight ensureBrowser settles, so the map stays small.
const ensureLocks = new Map();

// Last-touch timestamp per active sidecar (volume name -> epoch ms). Used
// by the reaper to identify sidecars that have been idle for longer than
// settings.volumeBrowserTtlMs.
const lastAccess = new Map();

async function ensureBrowser(volume) {
  lastAccess.set(volume, Date.now());
  let pending = ensureLocks.get(volume);
  if (pending) return pending;
  pending = (async () => {
    const docker = getClient();
    // Confirm volume exists
    try {
      await docker.getVolume(volume).inspect();
    } catch (err) {
      if (err.statusCode === 404) throw new HttpError(404, 'Volume not found');
      throw err;
    }

    const name = browserName(volume);
    const c = docker.getContainer(name);
    try {
      const info = await c.inspect();
      if (!info.State || !info.State.Running) {
        try { await c.start(); } catch (e) { if (e.statusCode !== 304) throw e; }
      }
      return c;
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }

    // Pull the image if missing.
    try {
      await docker.getImage(settings.browserImage).inspect();
    } catch (err) {
      if (err.statusCode === 404) {
        await new Promise((resolve, reject) => {
          docker.pull(settings.browserImage, (e, stream) => {
            if (e) return reject(e);
            docker.modem.followProgress(stream, (err2) =>
              err2 ? reject(err2) : resolve(),
            );
          });
        });
      } else {
        throw err;
      }
    }

    const created = await docker.createContainer({
      Image: settings.browserImage,
      name,
      Cmd: ['sleep', 'infinity'],
      HostConfig: {
        Binds: [`${volume}:/target:rw`],
        NetworkMode: 'none',
        AutoRemove: false,
        // Bound the blast radius of a pathological listing or upload.
        Memory: 256 * 1024 * 1024, // 256 MB
        NanoCpus: 1_000_000_000,   // 1 vCPU
        PidsLimit: 256,
        // Drop dangerous capabilities even though the only mount is /target.
        CapDrop: ['ALL'],
      },
      Labels: { [BROWSER_LABEL]: BROWSER_LABEL_VAL, [BROWSER_VOL_LABEL]: String(volume) },
    });
    await created.start();
    return created;
  })().finally(() => {
    ensureLocks.delete(volume);
  });
  ensureLocks.set(volume, pending);
  return pending;
}

async function execAndCapture(container, cmd, opts = {}) {
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    ...(opts.user ? { User: opts.user } : {}),
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  return await new Promise((resolve, reject) => {
    const stdout = []; const stderr = [];
    container.modem.demuxStream(stream, { write: (c) => stdout.push(c) }, { write: (c) => stderr.push(c) });
    stream.on('end', async () => {
      try {
        const inspect = await exec.inspect();
        resolve({
          exitCode: inspect.ExitCode,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      } catch (e) { reject(e); }
    });
    stream.on('error', reject);
  });
}

/**
 * Refuse to proceed if `absPath` resolves outside /target (symlink escape).
 * Run before every filesystem-touching dockerode call.
 */
async function assertSafe(container, absPath) {
  const r = await execAndCapture(container, ['python3', '-c', ASSERT_SAFE_SCRIPT, absPath]);
  if (r.exitCode === 0) return;
  if (r.exitCode === 2) {
    throw new HttpError(400, 'Path resolves outside the volume root (symlink escape)');
  }
  throw new HttpError(500, r.stderr.trim() || 'Path safety check failed');
}

// ---------- Schemas (route-builder picks these up) ----------

const NameParam = Type.Object({ name: Type.String() }, { additionalProperties: false });
const PathQuery = Type.Object(
  { path: Type.Optional(Type.String({ default: '' })) },
  { additionalProperties: false },
);
const RequiredPathQuery = Type.Object(
  { path: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
const ListQuery = Type.Object(
  {
    path: Type.Optional(Type.String({ default: '' })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50000, default: 5000 })),
    offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
  },
  { additionalProperties: false },
);

// ---------- Routes ----------

r.get(
  '/:name/browse/list',
  {
    summary: 'List a directory inside a volume',
    params: NameParam,
    query: ListQuery,
    responses: { 200: VolumeBrowseListResponse },
  },
  asyncHandler(async (req, res) => {
    const safe = safePath(req.query.path || '');
    const limit = intQuery(req.query.limit, 5000, { min: 1, max: 50000 });
    const offset = intQuery(req.query.offset, 0, { min: 0 });
    const c = await ensureBrowser(req.params.name);
    const out = await execAndCapture(c, [
      'python3', '-c', LIST_SCRIPT, safe, String(limit), String(offset),
    ]);
    if (out.exitCode !== 0) throw new HttpError(500, out.stdout || out.stderr || 'exec failed');
    let data;
    try { data = JSON.parse(out.stdout.trim()); }
    catch { throw new HttpError(500, `Bad list output: ${out.stdout.slice(0, 200)}`); }
    if (data && typeof data === 'object' && data.error) throw new HttpError(400, data.error);
    res.json({
      path: safe.slice('/target'.length) || '/',
      total: data.total,
      entries: data.entries,
    });
  }),
);

r.get(
  '/:name/browse/view',
  {
    summary: 'Read a regular file inline (text, capped at 1 MB)',
    params: NameParam,
    query: RequiredPathQuery,
    responses: { 200: VolumeBrowseViewResponse },
  },
  asyncHandler(async (req, res) => {
    const safe = safePath(req.query.path);
    if (safe === '/target') throw new HttpError(400, 'Cannot view the volume root');
    const c = await ensureBrowser(req.params.name);
    const out = await execAndCapture(c, ['python3', '-c', VIEW_SCRIPT, safe]);
    if (out.exitCode !== 0) throw new HttpError(500, out.stderr || 'view failed');
    let data;
    try { data = JSON.parse(out.stdout.trim()); }
    catch { throw new HttpError(500, `Bad view output: ${out.stdout.slice(0, 200)}`); }
    if (data && data.error) throw new HttpError(400, data.error);
    res.json({
      path: safe.slice('/target'.length) || '/',
      size: data.size,
      is_binary: !!data.is_binary,
      truncated: !!data.truncated,
      encoding: data.encoding,
      content: data.content,
    });
  }),
);

r.get(
  '/:name/browse/file',
  {
    summary: 'Download a single file',
    params: NameParam,
    query: RequiredPathQuery,
    responses: {
      200: customResponse({
        description: 'File bytes',
        content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
      }),
    },
  },
  asyncHandler(async (req, res) => {
    const safe = safePath(req.query.path);
    if (safe === '/target') throw new HttpError(400, 'Cannot download root');
    const c = await ensureBrowser(req.params.name);
    await assertSafe(c, safe);
    let archive;
    try { archive = await c.getArchive({ path: safe }); }
    catch (err) { if (err.statusCode === 404) throw new HttpError(404, 'File not found'); throw err; }
    const extract = tar.extract();
    let payload = null; let filename = null; let isFile = false; let done;
    const finished = new Promise((rOk) => (done = rOk));
    extract.on('entry', (header, stream, next) => {
      if (header.type === 'file' && payload == null) {
        isFile = true; filename = path.posix.basename(header.name);
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => { payload = Buffer.concat(chunks); next(); });
      } else { stream.on('end', next); stream.resume(); }
    });
    extract.on('finish', done); extract.on('error', () => done());
    archive.pipe(extract); await finished;
    if (!isFile || payload == null) {
      throw new HttpError(400, 'Not a regular file (use /archive to download directories)');
    }
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': payload.length,
    });
    res.end(payload);
  }),
);

r.get(
  '/:name/browse/archive',
  {
    summary: 'Download a file or directory as a tar archive',
    params: NameParam,
    query: RequiredPathQuery,
    responses: {
      200: customResponse({
        description: 'Tar archive (as emitted by the Docker daemon)',
        content: { 'application/x-tar': { schema: { type: 'string', format: 'binary' } } },
      }),
    },
  },
  asyncHandler(async (req, res) => {
    const safe = safePath(req.query.path);
    if (safe === '/target') throw new HttpError(400, 'Cannot archive the volume root');
    const c = await ensureBrowser(req.params.name);
    await assertSafe(c, safe);
    let archive;
    try { archive = await c.getArchive({ path: safe }); }
    catch (err) { if (err.statusCode === 404) throw new HttpError(404, 'Path not found'); throw err; }
    const base = path.posix.basename(safe) || 'archive';
    res.set({
      'Content-Type': 'application/x-tar',
      'Content-Disposition': `attachment; filename="${base}.tar"`,
      'Cache-Control': 'no-store',
    });
    archive.on('data', (chunk) => {
      if (!res.write(chunk)) {
        archive.pause();
        res.once('drain', () => archive.resume());
      }
    });
    archive.on('end', () => res.end());
    archive.on('error', () => res.end());
    res.on('close', () => { try { archive.destroy(); } catch {} });
  }),
);

r.post(
  '/:name/browse/file',
  {
    summary: 'Upload a file',
    admin: true,
    expensive: true,
    params: NameParam,
    query: PathQuery,
    extra: {
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] },
          },
        },
      },
    },
    responses: { 200: PassThroughObject },
  },
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'file is required');
    const safe = safePath(req.query.path || '');
    const c = await ensureBrowser(req.params.name);
    await assertSafe(c, safe);
    const fname = path.posix.basename(req.file.originalname || 'uploaded');
    const pack = tar.pack();
    pack.entry({ name: fname, mode: 0o644 }, req.file.buffer);
    pack.finalize();
    const chunks = [];
    for await (const chunk of pack) chunks.push(chunk);
    const tarBuf = Buffer.concat(chunks);
    await c.putArchive(tarBuf, { path: safe });
    res.json({ uploaded: fname, size: req.file.buffer.length, path: safe.slice('/target'.length) || '/' });
  }),
);

r.post(
  '/:name/browse/mkdir',
  {
    summary: 'Make a directory',
    admin: true,
    params: NameParam,
    query: RequiredPathQuery,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (req, res) => {
    const safe = safePath(req.query.path);
    if (safe === '/target') throw new HttpError(400, 'Invalid directory');
    const c = await ensureBrowser(req.params.name);
    await assertSafe(c, safe);
    const out = await execAndCapture(c, ['mkdir', '-p', safe]);
    if (out.exitCode !== 0) throw new HttpError(400, out.stderr || 'mkdir failed');
    res.json({ created: safe.slice('/target'.length) || '/' });
  }),
);

r.delete(
  '/:name/browse/file',
  {
    summary: 'Delete a file or directory',
    admin: true,
    params: NameParam,
    query: RequiredPathQuery,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (req, res) => {
    const safe = safePath(req.query.path);
    if (safe === '/target') throw new HttpError(400, 'Refusing to delete root');
    const c = await ensureBrowser(req.params.name);
    await assertSafe(c, safe);
    const out = await execAndCapture(c, ['rm', '-rf', safe]);
    if (out.exitCode !== 0) throw new HttpError(400, out.stderr || 'rm failed');
    res.json({ removed: safe.slice('/target'.length) });
  }),
);

r.post(
  '/:name/browse/rename',
  {
    summary: 'Rename / move a file or directory',
    admin: true,
    params: NameParam,
    body: VolumeBrowseRenameRequest,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (req, res) => {
    const from = safePath(req.body.from);
    const to = safePath(req.body.to);
    if (from === '/target' || to === '/target') {
      throw new HttpError(400, 'Cannot rename the volume root');
    }
    if (from === to) {
      return res.json({ moved: from.slice('/target'.length), to: to.slice('/target'.length) });
    }
    const c = await ensureBrowser(req.params.name);
    // Check both ends: the source must exist inside /target, the destination
    // must end up inside /target (we resolve the parent for the dest).
    await assertSafe(c, from);
    await assertSafe(c, to);
    // mv -n refuses to overwrite an existing file; surface as 409.
    const out = await execAndCapture(c, ['mv', '-n', from, to]);
    if (out.exitCode !== 0) {
      // Try to disambiguate "target exists" vs other failures.
      throw new HttpError(409, out.stderr.trim() || 'rename failed (target may exist)');
    }
    res.json({
      moved: from.slice('/target'.length),
      to: to.slice('/target'.length),
    });
  }),
);

r.post(
  '/:name/browse/chmod',
  {
    summary: 'Change permissions on a file or directory',
    admin: true,
    params: NameParam,
    body: VolumeBrowseChmodRequest,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (req, res) => {
    const safe = safePath(req.body.path);
    if (safe === '/target') throw new HttpError(400, 'Cannot chmod the volume root');
    const c = await ensureBrowser(req.params.name);
    await assertSafe(c, safe);
    const args = ['chmod'];
    if (req.body.recursive) args.push('-R');
    args.push(req.body.mode, safe);
    const out = await execAndCapture(c, args);
    if (out.exitCode !== 0) throw new HttpError(400, out.stderr.trim() || 'chmod failed');
    res.json({ path: safe.slice('/target'.length) || '/', mode: req.body.mode });
  }),
);

r.post(
  '/:name/browse/stop',
  {
    summary: 'Stop the volume-browser sidecar',
    admin: true,
    params: NameParam,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (req, res) => {
    const docker = getClient();
    const name = browserName(req.params.name);
    try {
      await docker.getContainer(name).remove({ force: true });
      lastAccess.delete(req.params.name);
      res.json({ stopped: true });
    } catch (err) {
      if (err.statusCode === 404) {
        lastAccess.delete(req.params.name);
        return res.json({ stopped: false, reason: 'not running' });
      }
      throw err;
    }
  }),
);

// ---------- Idle sidecar reaper ----------
//
// A sidecar that hasn't received a request in `volumeBrowserTtlMs` is removed
// by the periodic reaper. Disabled when TTL is 0. Uses .unref() so the
// interval doesn't keep the Node process alive on its own.

let reaperHandle = null;

async function reapOnce(now = Date.now(), log = () => {}) {
  if (settings.volumeBrowserTtlMs <= 0) return 0;
  const docker = getClient();
  let removed = 0;
  for (const [vol, ts] of [...lastAccess.entries()]) {
    if (now - ts <= settings.volumeBrowserTtlMs) continue;
    try {
      await docker.getContainer(browserName(vol)).remove({ force: true });
      log(`reaped idle volume-browser sidecar for "${vol}"`);
      removed += 1;
    } catch (err) {
      if (err.statusCode !== 404) {
        log(`reaper: failed to remove sidecar for "${vol}": ${err.message}`);
      }
    }
    lastAccess.delete(vol);
  }
  return removed;
}

export function startReaper(logger = console) {
  if (reaperHandle || settings.volumeBrowserTtlMs <= 0) return;
  reaperHandle = setInterval(
    () => reapOnce(Date.now(), (m) => logger.log && logger.log(`[volume-browser] ${m}`)),
    settings.volumeBrowserReapIntervalMs,
  );
  reaperHandle.unref && reaperHandle.unref();
}

export function stopReaper() {
  if (reaperHandle) {
    clearInterval(reaperHandle);
    reaperHandle = null;
  }
}

// Visible-for-testing.
export const _internals = { lastAccess, reapOnce, browserName };

export default r;
