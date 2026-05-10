// In-browser file browser for docker volumes (sidecar pattern).
import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import tar from 'tar-stream';
import { Buffer } from 'node:buffer';
import { authenticate, requireAdmin } from '../auth.js';
import { getClient } from '../docker-client.js';
import { settings } from '../config.js';
import { asyncHandler, HttpError, intQuery } from '../util.js';

const router = Router();
router.use(authenticate);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
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
  // Confirm volume exists
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
  try {
    info = await c.inspect();
    exists = true;
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }

  if (exists) {
    if (!info.State || !info.State.Running) {
      try {
        await c.start();
      } catch (e) {
        if (e.statusCode !== 304) throw e;
      }
    }
    return c;
  }

  // Pull image if needed
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
    },
    Labels: {
      [BROWSER_LABEL]: BROWSER_LABEL_VAL,
      [BROWSER_VOL_LABEL]: String(volume),
    },
  });
  await created.start();
  return created;
}

async function execAndCapture(container, cmd) {
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  // Demux multiplexed stream
  return await new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    container.modem.demuxStream(
      stream,
      { write: (c) => stdout.push(c) },
      { write: (c) => stderr.push(c) },
    );
    stream.on('end', async () => {
      try {
        const inspect = await exec.inspect();
        resolve({
          exitCode: inspect.ExitCode,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      } catch (e) {
        reject(e);
      }
    });
    stream.on('error', reject);
  });
}

router.get(
  '/:name/browse/list',
  asyncHandler(async (req, res) => {
    const safe = safePath(req.query.path || '');
    const c = await ensureBrowser(req.params.name);
    const r = await execAndCapture(c, ['python3', '-c', LIST_SCRIPT, safe]);
    if (r.exitCode !== 0) {
      throw new HttpError(500, r.stdout || r.stderr || 'exec failed');
    }
    let data;
    try {
      data = JSON.parse(r.stdout.trim());
    } catch (e) {
      throw new HttpError(500, `Bad list output: ${r.stdout.slice(0, 200)}`);
    }
    if (data && typeof data === 'object' && data.error) {
      throw new HttpError(400, data.error);
    }
    res.json({
      path: safe.slice('/target'.length) || '/',
      entries: data,
    });
  }),
);

router.get(
  '/:name/browse/file',
  asyncHandler(async (req, res) => {
    if (!req.query.path) throw new HttpError(400, 'path required');
    const safe = safePath(req.query.path);
    if (safe === '/target') throw new HttpError(400, 'Cannot download root');
    const c = await ensureBrowser(req.params.name);

    let archive;
    try {
      archive = await c.getArchive({ path: safe });
    } catch (err) {
      if (err.statusCode === 404) throw new HttpError(404, 'File not found');
      throw err;
    }

    const extract = tar.extract();
    let payload = null;
    let filename = null;
    let isFile = false;
    let done;
    const finished = new Promise((r) => (done = r));

    extract.on('entry', (header, stream, next) => {
      if (header.type === 'file' && payload == null) {
        isFile = true;
        filename = path.posix.basename(header.name);
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => {
          payload = Buffer.concat(chunks);
          next();
        });
      } else {
        stream.on('end', next);
        stream.resume();
      }
    });
    extract.on('finish', done);
    extract.on('error', () => done());
    archive.pipe(extract);
    await finished;

    if (!isFile || payload == null) {
      throw new HttpError(400, 'Not a regular file');
    }
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': payload.length,
    });
    res.end(payload);
  }),
);

router.post(
  '/:name/browse/file',
  requireAdmin,
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
    res.json({
      uploaded: fname,
      size: req.file.buffer.length,
      path: safe.slice('/target'.length) || '/',
    });
  }),
);

router.post(
  '/:name/browse/mkdir',
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (!req.query.path) throw new HttpError(400, 'path required');
    const safe = safePath(req.query.path);
    if (safe === '/target') throw new HttpError(400, 'Invalid directory');
    const c = await ensureBrowser(req.params.name);
    const r = await execAndCapture(c, ['mkdir', '-p', safe]);
    if (r.exitCode !== 0) throw new HttpError(400, r.stderr || 'mkdir failed');
    res.json({ created: safe.slice('/target'.length) || '/' });
  }),
);

router.delete(
  '/:name/browse/file',
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (!req.query.path) throw new HttpError(400, 'path required');
    const safe = safePath(req.query.path);
    if (safe === '/target') throw new HttpError(400, 'Refusing to delete root');
    const c = await ensureBrowser(req.params.name);
    const r = await execAndCapture(c, ['rm', '-rf', safe]);
    if (r.exitCode !== 0) throw new HttpError(400, r.stderr || 'rm failed');
    res.json({ removed: safe.slice('/target'.length) });
  }),
);

router.post(
  '/:name/browse/stop',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const docker = getClient();
    const name = browserName(req.params.name);
    try {
      const c = docker.getContainer(name);
      await c.remove({ force: true });
      res.json({ stopped: true });
    } catch (err) {
      if (err.statusCode === 404)
        return res.json({ stopped: false, reason: 'not running' });
      throw err;
    }
  }),
);

export default router;
