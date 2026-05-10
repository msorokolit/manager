// In-browser file browser for docker volumes (sidecar pattern).
import { Buffer } from 'node:buffer';
import path from 'node:path';
import multer from 'multer';
import { Type } from '@sinclair/typebox';
import tar from 'tar-stream';
import { getClient } from '../docker-client.js';
import { settings } from '../config.js';
import { asyncHandler, HttpError } from '../util.js';
import { createApiRouter, customResponse } from '../route-builder.js';
import {
  PassThroughObject,
  VolumeBrowseListResponse,
} from '../schemas/index.js';

const r = createApiRouter('/api/volumes', { tag: 'volume-browser' });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 },
});

const BROWSER_LABEL = 'com.docker.manager.role';
const BROWSER_LABEL_VAL = 'volume-browser';
const BROWSER_VOL_LABEL = 'com.docker.manager.volume';

const LIST_SCRIPT = `
import os, stat, sys, json
p = sys.argv[1]
out = []
try:
    entries = sorted(os.listdir(p))
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(0)
for n in entries:
    f = os.path.join(p, n)
    try:
        st = os.lstat(f)
    except OSError:
        continue
    out.append({
        "name": n,
        "is_dir": stat.S_ISDIR(st.st_mode),
        "is_link": stat.S_ISLNK(st.st_mode),
        "size": st.st_size,
        "mode": st.st_mode,
        "mtime": st.st_mtime,
    })
print(json.dumps(out))
`;

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

async function ensureBrowser(volume) {
  const docker = getClient();
  try {
    await docker.getVolume(volume).inspect();
  } catch (err) {
    if (err.statusCode === 404) throw new HttpError(404, 'Volume not found');
    throw err;
  }
  const name = browserName(volume);
  const c = docker.getContainer(name);
  let exists = false;
  let info = null;
  try { info = await c.inspect(); exists = true; }
  catch (err) { if (err.statusCode !== 404) throw err; }
  if (exists) {
    if (!info.State || !info.State.Running) {
      try { await c.start(); } catch (e) { if (e.statusCode !== 304) throw e; }
    }
    return c;
  }
  try {
    await docker.getImage(settings.browserImage).inspect();
  } catch (err) {
    if (err.statusCode === 404) {
      await new Promise((resolve, reject) => {
        docker.pull(settings.browserImage, (e, stream) => {
          if (e) return reject(e);
          docker.modem.followProgress(stream, (err2) => (err2 ? reject(err2) : resolve()));
        });
      });
    } else { throw err; }
  }
  const created = await docker.createContainer({
    Image: settings.browserImage,
    name,
    Cmd: ['sleep', 'infinity'],
    HostConfig: { Binds: [`${volume}:/target:rw`], NetworkMode: 'none', AutoRemove: false },
    Labels: { [BROWSER_LABEL]: BROWSER_LABEL_VAL, [BROWSER_VOL_LABEL]: String(volume) },
  });
  await created.start();
  return created;
}

async function execAndCapture(container, cmd) {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false });
  const stream = await exec.start({ hijack: true, stdin: false });
  return await new Promise((resolve, reject) => {
    const stdout = []; const stderr = [];
    container.modem.demuxStream(stream, { write: (c) => stdout.push(c) }, { write: (c) => stderr.push(c) });
    stream.on('end', async () => {
      try {
        const inspect = await exec.inspect();
        resolve({ exitCode: inspect.ExitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
      } catch (e) { reject(e); }
    });
    stream.on('error', reject);
  });
}

const NameParam = Type.Object({ name: Type.String() }, { additionalProperties: false });
const PathQuery = Type.Object(
  { path: Type.Optional(Type.String({ default: '' })) },
  { additionalProperties: false },
);
const RequiredPathQuery = Type.Object(
  { path: Type.String() },
  { additionalProperties: false },
);

r.get(
  '/:name/browse/list',
  {
    summary: 'List a directory inside a volume',
    params: NameParam,
    query: PathQuery,
    responses: { 200: VolumeBrowseListResponse },
  },
  asyncHandler(async (req, res) => {
    const safe = safePath(req.query.path || '');
    const c = await ensureBrowser(req.params.name);
    const out = await execAndCapture(c, ['python3', '-c', LIST_SCRIPT, safe]);
    if (out.exitCode !== 0) throw new HttpError(500, out.stdout || out.stderr || 'exec failed');
    let data;
    try { data = JSON.parse(out.stdout.trim()); }
    catch { throw new HttpError(500, `Bad list output: ${out.stdout.slice(0, 200)}`); }
    if (data && typeof data === 'object' && data.error) throw new HttpError(400, data.error);
    res.json({ path: safe.slice('/target'.length) || '/', entries: data });
  }),
);

r.get(
  '/:name/browse/file',
  {
    summary: 'Download a file',
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
    if (!req.query.path) throw new HttpError(400, 'path required');
    const safe = safePath(req.query.path);
    if (safe === '/target') throw new HttpError(400, 'Cannot download root');
    const c = await ensureBrowser(req.params.name);
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
    if (!isFile || payload == null) throw new HttpError(400, 'Not a regular file');
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': payload.length,
    });
    res.end(payload);
  }),
);

// Multer needs to run *before* validateBody — so we don't put `body:` in the
// spec for this route. We also can't use validateBody here (the body is a
// multipart stream, not JSON).
r.post(
  '/:name/browse/file',
  {
    summary: 'Upload a file',
    admin: true,
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
    if (!req.query.path) throw new HttpError(400, 'path required');
    const safe = safePath(req.query.path);
    if (safe === '/target') throw new HttpError(400, 'Invalid directory');
    const c = await ensureBrowser(req.params.name);
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
    if (!req.query.path) throw new HttpError(400, 'path required');
    const safe = safePath(req.query.path);
    if (safe === '/target') throw new HttpError(400, 'Refusing to delete root');
    const c = await ensureBrowser(req.params.name);
    const out = await execAndCapture(c, ['rm', '-rf', safe]);
    if (out.exitCode !== 0) throw new HttpError(400, out.stderr || 'rm failed');
    res.json({ removed: safe.slice('/target'.length) });
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
    try { await docker.getContainer(name).remove({ force: true }); res.json({ stopped: true }); }
    catch (err) {
      if (err.statusCode === 404) return res.json({ stopped: false, reason: 'not running' });
      throw err;
    }
  }),
);

export default r;
