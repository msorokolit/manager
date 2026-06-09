// In-browser file manager for docker volumes (one-shot container pattern).
//
// Why no persistent sidecar?
// --------------------------
// Earlier revisions kept one long-lived `docker-manager-browser-<vol>`
// container per browsed volume, plus a TTL reaper to remove idle ones.
// That was an O(volumes-browsed) source of leakable state and required:
// ensureBrowser, per-volume mutex, lastAccess map, periodic sweep,
// orphan-adoption on restart, a Stop-sidecar UI button, three env vars.
//
// This version trades that complexity for per-operation latency: every
// request creates one short-lived container with the volume mounted at
// /target, runs a single command, and lets `AutoRemove: true` clean up.
// No persistent state on the manager side; nothing to leak; nothing
// for a restart to lose.
//
// AutoRemove safety
// -----------------
// The classic foot-gun with AutoRemove is the wait/logs race: the daemon
// removes the container the instant it exits, so a subsequent `.logs()`
// or `.wait()` call sees 404 and the operation looks like it failed.
// We avoid it by **attaching to the container's stdout/stderr stream
// BEFORE calling `start()`**. The attach stream owns the pipe; we consume
// it to completion (which only happens after the container exits) and
// only then return. We never call `.wait()` or `.logs()` post-exit, so
// the AutoRemove race can't trigger.
//
// Path safety
// -----------
// User-supplied paths are first normalised against `/target` (rejects
// URL-level traversal like `..`) by `safePath`. Every operation script
// then re-validates inside the container with `os.path.realpath()` so
// a symlink stored inside the volume (e.g. `escape -> /etc`) can't be
// used to escape /target.
import { Buffer } from 'node:buffer';
import { Writable } from 'node:stream';
import path from 'node:path';
import multer from 'multer';
import { Type } from '@sinclair/typebox';
import tar from 'tar-stream';
import { getClient } from '../docker-client.js';
import { settings } from '../config.js';
import { asyncHandler, HttpError, intQuery } from '../util.js';
import { createApiRouter, customResponse } from '../route-builder.js';
import {
  PassThroughObject,
  VolumeBrowseBulkChmodRequest,
  VolumeBrowseBulkDeleteRequest,
  VolumeBrowseBulkResponse,
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

// ---------- Inline scripts ----------
//
// Every script:
//   - takes its args via argv (no stdin to avoid attach-write races)
//   - validates `realpath(path).startswith('/target')` before any fs op
//   - ALWAYS exits 0 and ALWAYS prints a single JSON object to stdout
//   - signals errors with `{"error": "..."}` instead of non-zero exit
//
// Uniform "exit 0 + JSON stdout" means the route handler never has to
// distinguish container failure from operation failure from parse failure.

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
        print(json.dumps({"error": "Path escapes the volume root"})); sys.exit(0)
    entries = sorted(os.listdir(p))
except Exception as e:
    print(json.dumps({"error": str(e)})); sys.exit(0)

total = len(entries)
page = entries[offset:offset + limit]
out = []
for n in page:
    f = os.path.join(p, n)
    try: st = os.lstat(f)
    except OSError: continue
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
    else: item["user"] = str(st.st_uid)
    if grp is not None:
        try: item["group"] = grp.getgrgid(st.st_gid).gr_name
        except KeyError: item["group"] = str(st.st_gid)
    else: item["group"] = str(st.st_gid)
    if item["is_link"]:
        try: item["link_target"] = os.readlink(f)
        except OSError: item["link_target"] = None
    out.append(item)
print(json.dumps({"total": total, "entries": out}))
`;

const VIEW_SCRIPT = `
import os, stat, sys, json
MAX = 1024 * 1024
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
    if truncated: data = data[:MAX]
    is_binary = b'\\x00' in data[:8192]
    if is_binary:
        print(json.dumps({"size": st.st_size, "is_binary": True, "truncated": truncated}))
    else:
        try: content = data.decode('utf-8'); encoding = 'utf-8'
        except UnicodeDecodeError: content = data.decode('latin-1'); encoding = 'latin-1'
        print(json.dumps({"size": st.st_size, "is_binary": False, "truncated": truncated, "encoding": encoding, "content": content}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

// Standalone realpath check used by the byte-transfer paths
// (file download, archive download, file upload) before we hand off to
// the Engine's archive API. That API follows symlinks inside the
// container's namespace, so we have to refuse the operation if the
// requested path resolves outside /target.
const ASSERT_SAFE_SCRIPT = `
import os, sys, json
p = sys.argv[1]
try:
    if os.path.lexists(p):
        rp = os.path.realpath(p)
    else:
        parent = os.path.realpath(os.path.dirname(p))
        rp = os.path.join(parent, os.path.basename(p))
    if rp == '/target' or rp.startswith('/target/'):
        print(json.dumps({"ok": True}))
    else:
        print(json.dumps({"error": "Path escapes the volume root"}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

const CHMOD_SCRIPT = `
import os, sys, json
mode = int(sys.argv[1], 8)
p = sys.argv[2]
recursive = sys.argv[3] == '1' if len(sys.argv) > 3 else False
try:
    rp = os.path.realpath(p)
    if not (rp == '/target' or rp.startswith('/target/')):
        print(json.dumps({"error": "Path escapes the volume root"})); sys.exit(0)
    if recursive and os.path.isdir(p):
        os.chmod(p, mode)
        for root, dirs, files in os.walk(p):
            for d in dirs: os.chmod(os.path.join(root, d), mode)
            for f in files: os.chmod(os.path.join(root, f), mode)
    else:
        os.chmod(p, mode)
    print(json.dumps({"ok": True}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

const MKDIR_SCRIPT = `
import os, sys, json
p = sys.argv[1]
try:
    parent = os.path.realpath(os.path.dirname(p))
    final = os.path.join(parent, os.path.basename(p))
    if not (final == '/target' or final.startswith('/target/')):
        print(json.dumps({"error": "Path escapes the volume root"})); sys.exit(0)
    os.makedirs(p, exist_ok=True)
    print(json.dumps({"ok": True}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

const DELETE_SCRIPT = `
import os, sys, json, shutil
p = sys.argv[1]
try:
    rp = os.path.realpath(p) if os.path.lexists(p) else None
    if rp is None:
        print(json.dumps({"error": "Not found"})); sys.exit(0)
    if rp == '/target' or not rp.startswith('/target/'):
        print(json.dumps({"error": "Refusing to delete the volume root"})); sys.exit(0)
    if os.path.islink(p) or os.path.isfile(p):
        os.unlink(p)
    else:
        shutil.rmtree(p)
    print(json.dumps({"ok": True}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

const RENAME_SCRIPT = `
import os, sys, json
src, dst = sys.argv[1], sys.argv[2]
try:
    rs = os.path.realpath(src)
    if not (rs == '/target' or rs.startswith('/target/')):
        print(json.dumps({"error": "Source escapes the volume root"})); sys.exit(0)
    parent = os.path.realpath(os.path.dirname(dst))
    final = os.path.join(parent, os.path.basename(dst))
    if not (final == '/target' or final.startswith('/target/')):
        print(json.dumps({"error": "Destination escapes the volume root"})); sys.exit(0)
    if os.path.lexists(dst):
        print(json.dumps({"error": "Destination already exists"})); sys.exit(0)
    os.rename(src, dst)
    print(json.dumps({"ok": True}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

// Bulk ops: accept one JSON spec (passed as argv[1]) instead of stdin so
// we don't have to write to the attach pipe. argv on Linux supports
// 128 KB by default; well above any sane multi-select.
const BULK_CHMOD_SCRIPT = `
import os, sys, json
spec = json.loads(sys.argv[1])
mode = int(spec["mode"], 8)
recursive = bool(spec.get("recursive"))
paths = spec["paths"]
results = []
for p in paths:
    item = {"path": p}
    try:
        rp = os.path.realpath(p)
        if not (rp == '/target' or rp.startswith('/target/')):
            item["ok"] = False; item["error"] = "Path escapes the volume root"
        else:
            if recursive and os.path.isdir(p):
                os.chmod(p, mode)
                for root, dirs, files in os.walk(p):
                    for d in dirs: os.chmod(os.path.join(root, d), mode)
                    for f in files: os.chmod(os.path.join(root, f), mode)
            else:
                os.chmod(p, mode)
            item["ok"] = True
    except Exception as e:
        item["ok"] = False; item["error"] = str(e)
    results.append(item)
print(json.dumps({"results": results}))
`;

const BULK_DELETE_SCRIPT = `
import os, sys, json, shutil
spec = json.loads(sys.argv[1])
results = []
for p in spec["paths"]:
    item = {"path": p}
    try:
        rp = os.path.realpath(p) if os.path.lexists(p) else None
        if rp is None:
            item["ok"] = False; item["error"] = "Not found"
        elif rp == '/target' or not rp.startswith('/target/'):
            item["ok"] = False; item["error"] = "Refusing to delete the volume root"
        else:
            if os.path.islink(p) or os.path.isfile(p): os.unlink(p)
            else: shutil.rmtree(p)
            item["ok"] = True
    except Exception as e:
        item["ok"] = False; item["error"] = str(e)
    results.append(item)
print(json.dumps({"results": results}))
`;

// ---------- Helpers ----------

function safePath(rel) {
  const cleaned = path.posix.normalize(
    path.posix.join('/target', String(rel || '').replace(/^\/+/, '')),
  );
  if (cleaned !== '/target' && !cleaned.startsWith('/target/')) {
    throw new HttpError(400, 'Invalid path');
  }
  return cleaned;
}

async function ensureVolumeExists(volume) {
  try { await getClient().getVolume(volume).inspect(); }
  catch (err) {
    if (err.statusCode === 404) throw new HttpError(404, 'Volume not found');
    throw err;
  }
}

function browserHostConfig(volume, { readonly = false } = {}) {
  const hc = {
    Binds: [`${volume}:/target:${readonly ? 'ro' : 'rw'}`],
    NetworkMode: 'none',
    CapDrop: ['ALL'],
    AutoRemove: true,
    PidsLimit: 64,
  };
  // Same caveat as before: skip cgroup-v2 controllers when the host's
  // root cgroup is in threaded mode (nested CI VMs). Production hosts
  // never need this.
  if (!settings.volumeBrowserNoLimits) {
    hc.Memory = 256 * 1024 * 1024;
    hc.NanoCpus = 1_000_000_000;
  }
  return hc;
}

/**
 * One-shot container that runs `cmd`, returns its demuxed stdout+stderr,
 * and is auto-removed by the daemon. Uses the attach-before-start
 * pattern so AutoRemove can't race our read of the output stream.
 */
async function runOnce(volume, cmd, { readonly = false } = {}) {
  await ensureVolumeExists(volume);
  const docker = getClient();
  const container = await docker.createContainer({
    Image: settings.browserImage,
    Cmd: cmd,
    HostConfig: browserHostConfig(volume, { readonly }),
    Labels: { [BROWSER_LABEL]: BROWSER_LABEL_VAL, [BROWSER_VOL_LABEL]: String(volume) },
  });

  // Attach BEFORE start: the daemon now owns the stdout/stderr pipe for
  // us, so we cannot miss output that's emitted between exit and the
  // AutoRemove cleanup.
  const stream = await container.attach({
    stream: true, stdout: true, stderr: true, hijack: true, stdin: false,
  });

  const outChunks = []; const errChunks = [];
  const stdoutSink = new Writable({ write(c, _e, cb) { outChunks.push(c); cb(); } });
  const stderrSink = new Writable({ write(c, _e, cb) { errChunks.push(c); cb(); } });
  docker.modem.demuxStream(stream, stdoutSink, stderrSink);

  const collected = new Promise((resolve, reject) => {
    stream.on('end', () => resolve({
      stdout: Buffer.concat(outChunks).toString('utf8'),
      stderr: Buffer.concat(errChunks).toString('utf8'),
    }));
    stream.on('error', reject);
  });

  try {
    await container.start();
  } catch (err) {
    // If start() fails the daemon won't AutoRemove (the container never
    // ran), so we have to clean up by hand.
    container.remove({ force: true }).catch(() => {});
    throw err;
  }
  return collected;
}

/**
 * Parse the deterministic JSON envelope every script emits on stdout.
 * Maps an `{"error":...}` payload to an HttpError(400). Container
 * crashes / pipe failures show up as a JSON parse error here.
 */
function parseScriptResult(out, opName) {
  const text = (out.stdout || '').trim();
  if (!text) {
    const stderr = (out.stderr || '').trim();
    throw new HttpError(500, `${opName} produced no output${stderr ? ': ' + stderr.slice(0, 200) : ''}`);
  }
  let data;
  try { data = JSON.parse(text); }
  catch {
    throw new HttpError(500, `${opName} returned malformed JSON: ${text.slice(0, 200)}`);
  }
  if (data && typeof data === 'object' && data.error) {
    throw new HttpError(400, data.error);
  }
  return data;
}

/**
 * Create a never-started container with the volume mounted, hand it to
 * `fn`, then remove it. Used for `getArchive` / `putArchive` because
 * the Engine's archive endpoints don't require the container to be
 * running and skipping `start()` saves ~80 ms per request.
 */
async function withScratchContainer(volume, fn, { readonly = false } = {}) {
  await ensureVolumeExists(volume);
  const docker = getClient();
  const container = await docker.createContainer({
    Image: settings.browserImage,
    // Never started, so Cmd is a placeholder. The image is required to
    // exist (we pre-pull at boot, see ensureBrowserImage).
    Cmd: ['true'],
    HostConfig: {
      Binds: [`${volume}:/target:${readonly ? 'ro' : 'rw'}`],
      NetworkMode: 'none',
      CapDrop: ['ALL'],
      // AutoRemove only fires on container EXIT. Since we never start
      // this container, we must remove it ourselves in finally.
    },
    Labels: { [BROWSER_LABEL]: BROWSER_LABEL_VAL, [BROWSER_VOL_LABEL]: String(volume) },
  });
  try {
    return await fn(container);
  } finally {
    container.remove({ force: true }).catch(() => {});
  }
}

/**
 * Pre-pull `settings.browserImage` so the first browse on a fresh host
 * doesn't pay a multi-second `docker pull` cost on the user's request.
 * Best-effort: failure is logged but never blocks startup, because a
 * later op will retry the pull (via createContainer's implicit pull).
 */
export async function ensureBrowserImage(logger = console) {
  const docker = getClient();
  try {
    await docker.getImage(settings.browserImage).inspect();
    return;
  } catch (err) {
    if (err.statusCode !== 404) {
      logger.warn && logger.warn(`[volume-browser] image inspect failed: ${err.message}`);
      return;
    }
  }
  logger.log && logger.log(`[volume-browser] pre-pulling ${settings.browserImage}…`);
  try {
    await new Promise((resolve, reject) => {
      docker.pull(settings.browserImage, (e, stream) => {
        if (e) return reject(e);
        docker.modem.followProgress(stream, (e2) => (e2 ? reject(e2) : resolve()));
      });
    });
    logger.log && logger.log('[volume-browser] image ready');
  } catch (err) {
    logger.warn && logger.warn(`[volume-browser] pre-pull failed (will retry on first browse): ${err.message}`);
  }
}

// ---------- Schemas ----------

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
    summary: 'List a directory inside a volume (paginated)',
    params: NameParam,
    query: ListQuery,
    responses: { 200: VolumeBrowseListResponse },
  },
  asyncHandler(async (req, res) => {
    const safe = safePath(req.query.path || '');
    const limit = intQuery(req.query.limit, 5000, { min: 1, max: 50000 });
    const offset = intQuery(req.query.offset, 0, { min: 0 });
    const out = await runOnce(
      req.params.name,
      ['python3', '-c', LIST_SCRIPT, safe, String(limit), String(offset)],
      { readonly: true },
    );
    const data = parseScriptResult(out, 'list');
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
    const out = await runOnce(
      req.params.name,
      ['python3', '-c', VIEW_SCRIPT, safe],
      { readonly: true },
    );
    const data = parseScriptResult(out, 'view');
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

// ---------- Byte transfers (Engine archive API + scratch container) ----------
//
// File / archive download and file upload go through `getArchive` /
// `putArchive` on a never-started container — the Engine streams the
// tar natively, which is cheaper than running an extra `python3 tarfile`
// inside the container. A separate fast `runOnce(ASSERT_SAFE_SCRIPT)`
// runs first because the archive endpoints follow symlinks in the
// container's view and would otherwise let an in-volume `escape -> /etc`
// link escape /target.

async function assertSafeOnce(volume, safe) {
  const out = await runOnce(
    volume,
    ['python3', '-c', ASSERT_SAFE_SCRIPT, safe],
    { readonly: true },
  );
  parseScriptResult(out, 'safety check'); // throws 400 on escape
}

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
    if (safe === '/target') throw new HttpError(400, 'Cannot download the volume root');
    await assertSafeOnce(req.params.name, safe);

    await withScratchContainer(req.params.name, async (container) => {
      let archive;
      try { archive = await container.getArchive({ path: safe }); }
      catch (err) {
        if (err.statusCode === 404) throw new HttpError(404, 'File not found');
        throw err;
      }
      const extract = tar.extract();
      let payload = null; let filename = null; let isFile = false;
      const finished = new Promise((resolve) => {
        extract.on('entry', (header, stream, next) => {
          if (header.type === 'file' && payload == null) {
            isFile = true; filename = path.posix.basename(header.name);
            const chunks = [];
            stream.on('data', (c) => chunks.push(c));
            stream.on('end', () => { payload = Buffer.concat(chunks); next(); });
          } else {
            stream.on('end', next); stream.resume();
          }
        });
        extract.on('finish', resolve);
        extract.on('error', () => resolve());
      });
      archive.pipe(extract);
      await finished;
      if (!isFile || payload == null) {
        throw new HttpError(400, 'Not a regular file (use /archive to download directories)');
      }
      res.set({
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': payload.length,
      });
      res.end(payload);
    }, { readonly: true });
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
    await assertSafeOnce(req.params.name, safe);

    await withScratchContainer(req.params.name, async (container) => {
      let archive;
      try { archive = await container.getArchive({ path: safe }); }
      catch (err) {
        if (err.statusCode === 404) throw new HttpError(404, 'Path not found');
        throw err;
      }
      const base = path.posix.basename(safe) || 'archive';
      res.set({
        'Content-Type': 'application/x-tar',
        'Content-Disposition': `attachment; filename="${base}.tar"`,
        'Cache-Control': 'no-store',
      });
      await new Promise((resolve) => {
        archive.on('data', (chunk) => {
          if (!res.write(chunk)) {
            archive.pause();
            res.once('drain', () => archive.resume());
          }
        });
        archive.on('end', resolve);
        archive.on('error', resolve);
        res.on('close', () => { try { archive.destroy(); } catch {} resolve(); });
      });
      res.end();
    }, { readonly: true });
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
    await assertSafeOnce(req.params.name, safe);

    const fname = path.posix.basename(req.file.originalname || 'uploaded');
    const pack = tar.pack();
    pack.entry({ name: fname, mode: 0o644 }, req.file.buffer);
    pack.finalize();
    const chunks = [];
    for await (const chunk of pack) chunks.push(chunk);
    const tarBuf = Buffer.concat(chunks);

    await withScratchContainer(req.params.name, async (container) => {
      await container.putArchive(tarBuf, { path: safe });
    });
    res.json({ uploaded: fname, size: req.file.buffer.length, path: safe.slice('/target'.length) || '/' });
  }),
);

// ---------- Metadata ops (one container per request) ----------

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
    const out = await runOnce(req.params.name, ['python3', '-c', MKDIR_SCRIPT, safe]);
    parseScriptResult(out, 'mkdir');
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
    const out = await runOnce(req.params.name, ['python3', '-c', DELETE_SCRIPT, safe]);
    parseScriptResult(out, 'delete');
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
    const out = await runOnce(req.params.name, ['python3', '-c', RENAME_SCRIPT, from, to]);
    parseScriptResult(out, 'rename');
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
    const out = await runOnce(req.params.name, [
      'python3', '-c', CHMOD_SCRIPT,
      req.body.mode, safe, req.body.recursive ? '1' : '0',
    ]);
    parseScriptResult(out, 'chmod');
    res.json({ path: safe.slice('/target'.length) || '/', mode: req.body.mode });
  }),
);

// ---------- Bulk ops (multi-select fast path) ----------
//
// Without these, the SPA's multi-select toolbar would issue N separate
// HTTP calls, each ~200 ms of container start cost. With them, N items
// = 1 container = ~200 ms total.

r.post(
  '/:name/browse/chmod/bulk',
  {
    summary: 'chmod many paths at once (multi-select)',
    admin: true,
    expensive: true,
    params: NameParam,
    body: VolumeBrowseBulkChmodRequest,
    responses: { 200: VolumeBrowseBulkResponse },
  },
  asyncHandler(async (req, res) => {
    const paths = req.body.paths.map((p) => safePath(p));
    const spec = JSON.stringify({ mode: req.body.mode, recursive: !!req.body.recursive, paths });
    const out = await runOnce(req.params.name, ['python3', '-c', BULK_CHMOD_SCRIPT, spec]);
    const data = parseScriptResult(out, 'bulk chmod');
    const results = (data.results || []).map((r) => ({
      path: r.path.replace(/^\/target/, '') || '/',
      ok: !!r.ok,
      ...(r.error ? { error: r.error } : {}),
    }));
    res.json({
      succeeded: results.filter((x) => x.ok).length,
      failed: results.filter((x) => !x.ok).length,
      results,
    });
  }),
);

r.post(
  '/:name/browse/delete/bulk',
  {
    summary: 'Delete many paths at once (multi-select)',
    admin: true,
    expensive: true,
    params: NameParam,
    body: VolumeBrowseBulkDeleteRequest,
    responses: { 200: VolumeBrowseBulkResponse },
  },
  asyncHandler(async (req, res) => {
    const paths = req.body.paths.map((p) => safePath(p));
    const spec = JSON.stringify({ paths });
    const out = await runOnce(req.params.name, ['python3', '-c', BULK_DELETE_SCRIPT, spec]);
    const data = parseScriptResult(out, 'bulk delete');
    const results = (data.results || []).map((r) => ({
      path: r.path.replace(/^\/target/, '') || '/',
      ok: !!r.ok,
      ...(r.error ? { error: r.error } : {}),
    }));
    res.json({
      succeeded: results.filter((x) => x.ok).length,
      failed: results.filter((x) => !x.ok).length,
      results,
    });
  }),
);

// Visible-for-testing only.
export const _internals = { safePath, parseScriptResult };

export default r;
