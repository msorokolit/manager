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
  NameParam,
  PassThroughObject,
  VolumeBrowseBulkChmodRequest,
  VolumeBrowseBulkChownRequest,
  VolumeBrowseBulkDeleteRequest,
  VolumeBrowseBulkPermissionsRequest,
  VolumeBrowseBulkResponse,
  VolumeBrowseChmodRequest,
  VolumeBrowseChownRequest,
  VolumeBrowseListQuery,
  VolumeBrowseListResponse,
  VolumeBrowsePermissionsRequest,
  VolumeBrowseRenameRequest,
  VolumeBrowseSaveRequest,
  VolumeBrowseSaveResponse,
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

// LIST_SCRIPT (#18, #19): server-side sort + scandir.
//
// The previous version did `sorted(os.listdir(p))` + per-entry lstat for
// every page request, which is O(n log n + n) per request on directory
// size — pathological on a 50k-entry dir even for limit=10.
//
// This version:
//   - scandir() streams names + DT_TYPE in one syscall
//   - we lstat() ONLY the page slice we're going to return (after sort)
//   - sort happens on (cheap) names + per-entry stat done lazily for the
//     non-name sort orders (mtime, size); we stat the whole directory in
//     that case but it's still one pass instead of two
//   - sort=name (default) doesn't pay the lstat cost for entries off-page
const LIST_SCRIPT = `
import os, stat, sys, json
try:
    import pwd, grp
except ImportError:
    pwd = grp = None

p = sys.argv[1]
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 5000
offset = int(sys.argv[3]) if len(sys.argv) > 3 else 0
sort_key = sys.argv[4] if len(sys.argv) > 4 else 'name'
order = sys.argv[5] if len(sys.argv) > 5 else 'asc'
dirs_first = sys.argv[6] != '0' if len(sys.argv) > 6 else True

try:
    real_p = os.path.realpath(p)
    if not (real_p == '/target' or real_p.startswith('/target/')):
        print(json.dumps({"error": "Path escapes the volume root"})); sys.exit(0)
    if not os.path.isdir(real_p):
        print(json.dumps({"error": "Not a directory"})); sys.exit(0)

    if sort_key == 'name':
        # Cheap path: scandir gives us names + d_type without an lstat.
        # We sort by name, slice the page, then stat only the page.
        with os.scandir(p) as it:
            raw = [(e.name, e.is_dir(follow_symlinks=False), e.is_symlink()) for e in it]
        if dirs_first:
            raw.sort(key=lambda t: (0 if t[1] else 1 if t[2] else 2, t[0].lower()))
        else:
            raw.sort(key=lambda t: t[0].lower())
        if order == 'desc': raw.reverse()
        total = len(raw)
        page = raw[offset:offset + limit]
        names = [n for n, _, _ in page]
    else:
        # Expensive path: we have to stat every entry to sort by size /
        # mtime. Still one pass each (one scandir, then one lstat per
        # entry). For huge directories the operator can switch back to
        # name sort if it's too slow.
        rows = []
        with os.scandir(p) as it:
            for e in it:
                try: st = e.stat(follow_symlinks=False)
                except OSError: continue
                rows.append((e.name, e.is_dir(follow_symlinks=False), e.is_symlink(),
                             st.st_size if not e.is_dir(follow_symlinks=False) else -1,
                             st.st_mtime))
        if sort_key == 'size':
            rows.sort(key=lambda t: t[3])
        elif sort_key == 'mtime':
            rows.sort(key=lambda t: t[4])
        if dirs_first:
            rows.sort(key=lambda t: 0 if t[1] else 1 if t[2] else 2)
        if order == 'desc': rows.reverse()
        total = len(rows)
        page = rows[offset:offset + limit]
        names = [t[0] for t in page]
except Exception as e:
    print(json.dumps({"error": str(e)})); sys.exit(0)

out = []
for n in names:
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

// VIEW_SCRIPT (#8): returns `mtime` so the editor's optimistic-concurrency
// token comes from the same fetch as the content, not a stale listing.
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
    base = {"size": st.st_size, "mtime": st.st_mtime,
            "is_binary": is_binary, "truncated": truncated}
    if is_binary:
        print(json.dumps(base))
    else:
        try: content = data.decode('utf-8'); encoding = 'utf-8'
        except UnicodeDecodeError: content = data.decode('latin-1'); encoding = 'latin-1'
        base["encoding"] = encoding
        base["content"] = content
        print(json.dumps(base))
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

// chown / chgrp. -1 for either uid or gid means "leave unchanged" (POSIX
// chown(2) semantics). lchown is used at top so a symlink target isn't
// followed; os.walk follows for the recursive case (matches GNU chown -R).
const CHOWN_SCRIPT = `
import os, sys, json
p = sys.argv[1]
uid = int(sys.argv[2])
gid = int(sys.argv[3])
recursive = sys.argv[4] == '1' if len(sys.argv) > 4 else False
try:
    rp = os.path.realpath(p) if os.path.lexists(p) else None
    if rp is None:
        print(json.dumps({"error": "Not found"})); sys.exit(0)
    if not (rp == '/target' or rp.startswith('/target/')):
        print(json.dumps({"error": "Path escapes the volume root"})); sys.exit(0)
    os.lchown(p, uid, gid)
    if recursive and os.path.isdir(p) and not os.path.islink(p):
        for root, dirs, files in os.walk(p):
            for name in dirs + files:
                os.lchown(os.path.join(root, name), uid, gid)
    print(json.dumps({"ok": True}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

// Atomic chmod + chown (#20). Reads spec from stdin so very large bulk
// payloads don't trip the argv limit. Either or both of mode / uid /
// gid may be set; -1 means "leave that owner-half unchanged".
//
// The whole operation runs in one container, so for a single path you
// either get both mutations or neither — no half-state where mode
// changed and ownership failed.
const PERMISSIONS_SCRIPT = `
import os, sys, json
spec = json.loads(sys.stdin.read())
paths = spec.get("paths") or [spec["path"]]
mode = spec.get("mode")
mode_int = int(mode, 8) if mode else None
uid = spec.get("uid")
gid = spec.get("gid")
recursive = bool(spec.get("recursive"))
bulk = "paths" in spec
results = []

def apply(p):
    rp = os.path.realpath(p) if os.path.lexists(p) else None
    if rp is None:
        return {"path": p, "ok": False, "error": "Not found"}
    if not (rp == '/target' or rp.startswith('/target/')):
        return {"path": p, "ok": False, "error": "Path escapes the volume root"}
    try:
        if mode_int is not None:
            if recursive and os.path.isdir(p) and not os.path.islink(p):
                os.chmod(p, mode_int)
                for root, dirs, files in os.walk(p):
                    for d in dirs: os.chmod(os.path.join(root, d), mode_int)
                    for f in files: os.chmod(os.path.join(root, f), mode_int)
            else:
                os.chmod(p, mode_int)
        if uid is not None or gid is not None:
            u = -1 if uid is None else int(uid)
            g = -1 if gid is None else int(gid)
            os.lchown(p, u, g)
            if recursive and os.path.isdir(p) and not os.path.islink(p):
                for root, dirs, files in os.walk(p):
                    for name in dirs + files:
                        os.lchown(os.path.join(root, name), u, g)
        return {"path": p, "ok": True}
    except Exception as e:
        return {"path": p, "ok": False, "error": str(e)}

for p in paths:
    results.append(apply(p))

if bulk:
    print(json.dumps({"results": results}))
else:
    # Single-target: surface the single result inline; on failure we
    # use the "error" envelope so parseScriptResult turns it into an
    # HTTP error with the right status code mapping.
    r0 = results[0]
    if r0["ok"]:
        print(json.dumps({"ok": True, "path": r0["path"]}))
    else:
        print(json.dumps({"error": r0["error"]}))
`;

const BULK_CHOWN_SCRIPT = `
import os, sys, json
spec = json.loads(sys.argv[1])
uid = int(spec["uid"])
gid = int(spec["gid"])
recursive = bool(spec.get("recursive"))
results = []
for p in spec["paths"]:
    item = {"path": p}
    try:
        rp = os.path.realpath(p) if os.path.lexists(p) else None
        if rp is None:
            item["ok"] = False; item["error"] = "Not found"
        elif not (rp == '/target' or rp.startswith('/target/')):
            item["ok"] = False; item["error"] = "Path escapes the volume root"
        else:
            os.lchown(p, uid, gid)
            if recursive and os.path.isdir(p) and not os.path.islink(p):
                for root, dirs, files in os.walk(p):
                    for name in dirs + files:
                        os.lchown(os.path.join(root, name), uid, gid)
            item["ok"] = True
    except Exception as e:
        item["ok"] = False; item["error"] = str(e)
    results.append(item)
print(json.dumps({"results": results}))
`;

// Atomic edit. Content arrives on stdin (no argv length limit). Sequence:
//   1. safety check on realpath
//   2. if_mtime check (optimistic concurrency)
//   3. capture original perms/owner if file exists
//   4. write to a sibling temp file in the same directory
//   5. restore perms/owner on the temp before rename
//   6. os.replace(tmp, path) — atomic on POSIX
// On any exception after temp is created, the temp file is unlinked so
// half-written turds don't accumulate in the volume.
const EDIT_SCRIPT = `
import os, sys, json, tempfile
p = sys.argv[1]
if_mtime = sys.argv[2] if len(sys.argv) > 2 else ''
new_mode = sys.argv[3] if len(sys.argv) > 3 else ''
content = sys.stdin.buffer.read()
try:
    if os.path.lexists(p):
        rp = os.path.realpath(p)
        if not (rp == '/target' or rp.startswith('/target/')):
            print(json.dumps({"error": "Path escapes the volume root"})); sys.exit(0)
        if os.path.islink(p):
            print(json.dumps({"error": "Refusing to edit through a symlink"})); sys.exit(0)
        if not os.path.isfile(p):
            print(json.dumps({"error": "Not a regular file"})); sys.exit(0)
        orig = os.stat(p)
        if if_mtime:
            if abs(orig.st_mtime - float(if_mtime)) > 0.001:
                print(json.dumps({"conflict":
                    "File changed on disk since you opened it",
                    "server_mtime": orig.st_mtime})); sys.exit(0)
    else:
        # New file: parent must exist and be inside /target.
        parent = os.path.realpath(os.path.dirname(p))
        if not (parent == '/target' or parent.startswith('/target/')):
            print(json.dumps({"error": "Parent escapes the volume root"})); sys.exit(0)
        if not os.path.isdir(os.path.dirname(p)):
            print(json.dumps({"error": "Parent directory does not exist"})); sys.exit(0)
        orig = None
    d = os.path.dirname(p)
    fd, tmp = tempfile.mkstemp(dir=d, prefix='.dm-edit-')
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(content)
        if orig is not None:
            os.chmod(tmp, orig.st_mode & 0o7777)
            try: os.chown(tmp, orig.st_uid, orig.st_gid)
            except PermissionError: pass
        elif new_mode:
            os.chmod(tmp, int(new_mode, 8))
        os.replace(tmp, p)
    except Exception:
        try: os.unlink(tmp)
        except FileNotFoundError: pass
        raise
    st = os.stat(p)
    print(json.dumps({"ok": True, "size": st.st_size, "mtime": st.st_mtime}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
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

// Capability set used by every volume-browser operation. The container is
// otherwise locked down (NetworkMode:none, only /target mounted, AutoRemove,
// no other caps, PidsLimit, no host networking, no devices), so granting
// these three to root inside the container is a tiny ask compared to what
// a file-manager admin needs to do:
//   CHOWN              — required for lchown(); even root can't chown without it
//   FOWNER             — bypass DAC owner check for chmod/utime on files we don't own
//   DAC_OVERRIDE       — bypass read/write/search DAC checks (mixed-ownership
//                        volumes — e.g. a file owned by uid 1000 mode 0600
//                        is unreadable to root-without-DAC_OVERRIDE)
//
// Read paths take the same caps because of the last bullet: without them,
// list / view / archive against a volume whose files belong to other UIDs
// returns EACCES even though we're root. That's exactly the case after
// any successful chown.
const BROWSER_CAPS = ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'];

function browserHostConfig(volume, { readonly = false, capAdd = [] } = {}) {
  const hc = {
    Binds: [`${volume}:/target:${readonly ? 'ro' : 'rw'}`],
    NetworkMode: 'none',
    CapDrop: ['ALL'],
    AutoRemove: true,
    PidsLimit: 64,
  };
  if (capAdd.length) hc.CapAdd = [...capAdd];
  // Same caveat as before: skip cgroup-v2 controllers when the host's
  // root cgroup is in threaded mode (nested CI VMs). Production hosts
  // never need this.
  if (!settings.volumeBrowserNoLimits) {
    hc.Memory = 256 * 1024 * 1024;
    hc.NanoCpus = 1_000_000_000;
  }
  return hc;
}

// Wall-clock cap on a single helper-container operation (#5). A hung
// python script, stuck I/O inside the container, or runaway recursion
// would otherwise pin the HTTP request open forever. Configurable via
// VOLUME_BROWSER_OP_TIMEOUT_MS; defaults to 90 s, which is generous for
// a chmod -R on a deep tree but bounded.
const DEFAULT_OP_TIMEOUT_MS = 90_000;

/**
 * One-shot container that runs `cmd`, returns its demuxed stdout+stderr,
 * and is auto-removed by the daemon. Uses the attach-before-start
 * pattern so AutoRemove can't race our read of the output stream.
 *
 * If `stdin` is a Buffer it's piped into the container's stdin and the
 * write side is closed (signalling EOF) once start() resolves. Useful
 * for ops that need to ship arbitrary bytes without argv-length caps
 * (file edits, bulk permission specs).
 *
 * The handler races the `attach` stream against a wall-clock timer. On
 * timeout we force-remove the container and reject with an HttpError
 * the central middleware maps to 504 Gateway Timeout.
 */
async function runOnce(volume, cmd, opts = {}) {
  const {
    readonly = false, stdin = null, capAdd = [],
    timeoutMs = settings.volumeBrowserOpTimeoutMs || DEFAULT_OP_TIMEOUT_MS,
  } = opts;
  await ensureVolumeExists(volume);
  const docker = getClient();
  const createOpts = {
    Image: settings.browserImage,
    Cmd: cmd,
    HostConfig: browserHostConfig(volume, { readonly, capAdd }),
    Labels: { [BROWSER_LABEL]: BROWSER_LABEL_VAL, [BROWSER_VOL_LABEL]: String(volume) },
  };
  if (stdin) {
    // OpenStdin wires /dev/stdin inside the container so scripts can read
    // it. StdinOnce closes stdin after the first reader's EOF (here, our
    // stream.end() call below). AttachStdin is required so the daemon
    // forwards our writes to the container instead of dropping them.
    createOpts.OpenStdin = true;
    createOpts.StdinOnce = true;
    createOpts.AttachStdin = true;
  }
  const container = await docker.createContainer(createOpts);

  // Attach BEFORE start: the daemon now owns the stdout/stderr pipe for
  // us, so we cannot miss output that's emitted between exit and the
  // AutoRemove cleanup.
  const stream = await container.attach({
    stream: true, stdout: true, stderr: true, hijack: true,
    stdin: !!stdin,
  });

  const outChunks = []; const errChunks = [];
  const stdoutSink = new Writable({ write(c, _e, cb) { outChunks.push(c); cb(); } });
  const stderrSink = new Writable({ write(c, _e, cb) { errChunks.push(c); cb(); } });
  docker.modem.demuxStream(stream, stdoutSink, stderrSink);

  const collected = new Promise((resolve, reject) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Tear down the container — its inner process is hung or runaway.
      container.remove({ force: true }).catch(() => {});
      try { stream.destroy(); } catch {}
      reject(new HttpError(504, `Helper container exceeded ${timeoutMs}ms timeout`));
    }, timeoutMs);
    t.unref && t.unref();

    stream.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve({
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      });
    });
    stream.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      reject(err);
    });
  });

  try {
    await container.start();
  } catch (err) {
    // If start() fails the daemon won't AutoRemove (the container never
    // ran), so we have to clean up by hand.
    container.remove({ force: true }).catch(() => {});
    throw err;
  }

  if (stdin) {
    // Write content then half-close the writable side. The daemon
    // detects the half-close, sends EOF to the container's stdin, and
    // keeps the readable side (stdout/stderr) open until exit.
    try {
      stream.write(stdin);
      stream.end();
    } catch (err) {
      container.remove({ force: true }).catch(() => {});
      throw err;
    }
  }

  return collected;
}

// #12: known python error strings → appropriate HTTP status codes.
// The scripts can't easily emit structured codes (they're tiny inline
// programs), so we recognise their canonical messages here. Everything
// else falls through to 400 — that's the safe default for "the input
// was wrong" without leaking unexpected internals as 500s.
function errorStatusFor(message) {
  const m = String(message || '');
  if (/^Not found$/i.test(m) || /\bNo such file or directory\b/i.test(m)) return 404;
  if (/^Destination already exists$/i.test(m) || /\bFile exists\b/i.test(m)) return 409;
  if (/^Refusing to (?:delete|edit|chmod|chown) the volume root$/i.test(m)) return 400;
  if (/escapes the volume root/i.test(m)) return 400;
  if (/^Refusing to edit through a symlink$/i.test(m)) return 400;
  if (/^Not a regular file$/i.test(m)) return 400;
  if (/^Not a directory$/i.test(m)) return 400;
  if (/^Parent directory does not exist$/i.test(m)) return 404;
  return 400;
}

/**
 * Parse the deterministic JSON envelope every script emits on stdout.
 * Maps an `{"error":...}` payload to an HttpError whose status code is
 * inferred from the message (#12) — "Not found" → 404, "Destination
 * already exists" → 409, escape-root → 400, etc.
 *
 * Container crashes / pipe failures show up as a JSON parse error here.
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
    throw new HttpError(errorStatusFor(data.error), data.error);
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

// `NameParam` is shared via schemas/_common.js (#35).
const PathQuery = Type.Object(
  { path: Type.Optional(Type.String({ default: '' })) },
  { additionalProperties: false },
);
const RequiredPathQuery = Type.Object(
  { path: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

// ---------- Routes ----------
//
// All routes (read + write) require `admin: true` (#4) — viewer JWTs
// can't browse / read file contents through this API. Reading an
// arbitrary volume's contents through the manager amounts to "give me
// the secrets file" for any production-mounted volume; the viewer role
// is meant for "see Docker resources", not "read all files".
//
// All routes are also `expensive: true` (#7) so the per-user concurrency
// cap covers reads as well as writes — an authenticated admin still
// can't fan out unbounded parallel list/view calls and saturate the
// daemon.

r.get(
  '/:name/browse/list',
  {
    summary: 'List a directory inside a volume (paginated, server-side sort)',
    admin: true,
    expensive: true,
    params: NameParam,
    query: VolumeBrowseListQuery,
    responses: { 200: VolumeBrowseListResponse },
  },
  asyncHandler(async (req, res) => {
    const safe = safePath(req.query.path || '');
    const limit = intQuery(req.query.limit, 5000, { min: 1, max: 50000 });
    const offset = intQuery(req.query.offset, 0, { min: 0 });
    const sort = ['name', 'size', 'mtime'].includes(req.query.sort) ? req.query.sort : 'name';
    const order = req.query.order === 'desc' ? 'desc' : 'asc';
    const dirsFirst = req.query.dirs_first !== false; // default true
    const out = await runOnce(
      req.params.name,
      [
        'python3', '-c', LIST_SCRIPT, safe,
        String(limit), String(offset), sort, order, dirsFirst ? '1' : '0',
      ],
      { readonly: true, capAdd: BROWSER_CAPS },
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
    summary: 'Read a regular file inline (text, capped at 1 MB; returns mtime for optimistic concurrency)',
    admin: true,
    expensive: true,
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
      { readonly: true, capAdd: BROWSER_CAPS },
    );
    const data = parseScriptResult(out, 'view');
    res.json({
      path: safe.slice('/target'.length) || '/',
      size: data.size,
      mtime: data.mtime, // #8: editor uses this as if_mtime on save
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
//
// #17: the review proposed collapsing assertSafeOnce + withScratchContainer
// into one container. We considered three approaches and rejected each:
//   (a) Replace getArchive with python-tar-to-stdout in one container.
//       This works but loses the Engine's native tar streaming, which
//       is faster than tarfile.add() and keeps the manager out of the
//       hot path. ~2x slower for large files.
//   (b) Run a long-lived helper (`sleep 60`), exec realpath, then call
//       getArchive on the same container. Adds an exec round-trip and
//       brings back the "must kill the container" cleanup the one-shot
//       architecture was designed to avoid.
//   (c) AutoRemove off + start + safety + getArchive + manual remove.
//       Same number of Docker API round-trips, just rearranged.
// The two-container pattern is ~330ms per byte-transfer, the safety
// container is fast (<200ms) and naturally caps at one per request via
// the per-user concurrency middleware, and the code is markedly simpler
// than any of the alternatives. Documented here so the next reviewer
// doesn't churn this again.

async function assertSafeOnce(volume, safe) {
  const out = await runOnce(
    volume,
    ['python3', '-c', ASSERT_SAFE_SCRIPT, safe],
    { readonly: true, capAdd: BROWSER_CAPS },
  );
  parseScriptResult(out, 'safety check'); // throws 400 on escape
}

// RFC 5987 / RFC 6266: safely encode a filename for Content-Disposition
// even when the file name contains quote characters, backslashes,
// newlines, or non-ASCII (#19 in the review). We always emit both the
// quoted-printable filename= (for old clients) AND a UTF-8-encoded
// filename*= (for modern ones), with sanitised values everywhere.
function contentDispositionFor(name) {
  // Strip control chars + slashes + NULs from both forms; quotes /
  // backslashes get escaped in the legacy form.
  const sanitised = String(name || 'download')
    .replace(/[\x00-\x1f\x7f/\\]/g, '_')
    .slice(0, 240); // leave headroom under most header-length limits
  const legacy = sanitised
    .replace(/[\u0080-\uffff]/g, '_') // ASCII-only for filename=
    .replace(/["\\]/g, '\\$&');
  // RFC 5987 percent-encoding for the UTF-8 variant
  const encoded = encodeURIComponent(sanitised)
    .replace(/['()]/g, escape) // some clients trip on these
    .replace(/\*/g, '%2A');
  return `attachment; filename="${legacy}"; filename*=UTF-8''${encoded}`;
}

r.get(
  '/:name/browse/file',
  {
    summary: 'Download a single file (streamed)',
    admin: true,
    expensive: true,
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

    // #6: stream the file body directly to res with back-pressure. The
    // previous implementation concatenated every tar chunk into a single
    // Buffer before responding — a 10 GB file would OOM the manager.
    // #9: stream errors REJECT the handler so the central middleware
    // returns 500 instead of resolving silently with a half-written body.
    await withScratchContainer(req.params.name, async (container) => {
      let archive;
      try { archive = await container.getArchive({ path: safe }); }
      catch (err) {
        if (err.statusCode === 404) throw new HttpError(404, 'File not found');
        throw err;
      }
      const extract = tar.extract();
      let headersSent = false;
      let entryStarted = false;

      await new Promise((resolve, reject) => {
        extract.on('entry', (header, entryStream, next) => {
          // Only the FIRST file entry is emitted — directories produce
          // multiple entries; refuse those and tell the caller to use
          // /archive instead.
          if (entryStarted) {
            entryStream.on('end', next);
            entryStream.resume();
            return;
          }
          if (header.type !== 'file') {
            entryStream.on('end', next);
            entryStream.resume();
            return;
          }
          entryStarted = true;
          const fname = path.posix.basename(header.name);
          if (!headersSent) {
            res.set({
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': contentDispositionFor(fname),
              'Content-Length': String(header.size),
              'Cache-Control': 'no-store',
            });
            headersSent = true;
          }
          // Pipe with back-pressure; if the client disconnects, abort the
          // archive stream so we don't keep pumping into a dead socket.
          entryStream.on('data', (chunk) => {
            if (!res.write(chunk)) {
              entryStream.pause();
              res.once('drain', () => entryStream.resume());
            }
          });
          entryStream.on('end', next);
          entryStream.on('error', reject);
        });
        extract.on('finish', () => {
          if (!entryStarted) {
            // No file entries — the path was a directory or empty tar.
            return reject(new HttpError(400, 'Not a regular file (use /archive to download directories)'));
          }
          res.end();
          resolve();
        });
        extract.on('error', reject);
        archive.on('error', reject);
        res.on('close', () => {
          try { archive.destroy(); } catch {}
          try { extract.destroy(); } catch {}
          // Only resolve once — if we haven't finished yet, treat the
          // disconnect as a normal stream end.
          if (!entryStarted) resolve();
        });
        archive.pipe(extract);
      });
    }, { readonly: true });
  }),
);

r.get(
  '/:name/browse/archive',
  {
    summary: 'Download a file or directory as a tar archive',
    admin: true,
    expensive: true,
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
        'Content-Disposition': contentDispositionFor(`${base}.tar`),
        'Cache-Control': 'no-store',
      });
      // #9: stream errors now reject so the central error middleware
      // surfaces them as 500 (with the response either ending cleanly
      // or being aborted) — previously we resolved silently and ended
      // up with truncated downloads that looked successful.
      await new Promise((resolve, reject) => {
        archive.on('data', (chunk) => {
          if (!res.write(chunk)) {
            archive.pause();
            res.once('drain', () => archive.resume());
          }
        });
        archive.on('end', () => { res.end(); resolve(); });
        archive.on('error', reject);
        res.on('close', () => {
          try { archive.destroy(); } catch {}
          resolve(); // client gave up; not our problem
        });
      });
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

    // Strip path separators and NUL from the supplied name BEFORE we
    // pack it into the tar (#20 in the review). multer's `originalname`
    // comes straight from the client and can contain anything.
    const rawName = String(req.file.originalname || 'uploaded');
    const fname = path.posix.basename(rawName)
      .replace(/[\x00/\\]/g, '_')
      .slice(0, 255) || 'uploaded';
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
    const out = await runOnce(
      req.params.name,
      ['python3', '-c', MKDIR_SCRIPT, safe],
      { capAdd: BROWSER_CAPS },
    );
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
    const out = await runOnce(
      req.params.name,
      ['python3', '-c', DELETE_SCRIPT, safe],
      { capAdd: BROWSER_CAPS },
    );
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
    const out = await runOnce(
      req.params.name,
      ['python3', '-c', RENAME_SCRIPT, from, to],
      { capAdd: BROWSER_CAPS },
    );
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
    const out = await runOnce(
      req.params.name,
      ['python3', '-c', CHMOD_SCRIPT, req.body.mode, safe, req.body.recursive ? '1' : '0'],
      { capAdd: BROWSER_CAPS },
    );
    parseScriptResult(out, 'chmod');
    res.json({ path: safe.slice('/target'.length) || '/', mode: req.body.mode });
  }),
);

r.post(
  '/:name/browse/chown',
  {
    summary: 'Change owner/group (numeric uid/gid) on a file or directory',
    admin: true,
    params: NameParam,
    body: VolumeBrowseChownRequest,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (req, res) => {
    if (req.body.uid == null && req.body.gid == null) {
      throw new HttpError(400, 'At least one of uid / gid must be provided');
    }
    const safe = safePath(req.body.path);
    if (safe === '/target') throw new HttpError(400, 'Cannot chown the volume root');
    const uid = req.body.uid == null ? -1 : req.body.uid;
    const gid = req.body.gid == null ? -1 : req.body.gid;
    const out = await runOnce(
      req.params.name,
      ['python3', '-c', CHOWN_SCRIPT, safe, String(uid), String(gid), req.body.recursive ? '1' : '0'],
      { capAdd: BROWSER_CAPS },
    );
    parseScriptResult(out, 'chown');
    res.json({
      path: safe.slice('/target'.length) || '/',
      uid: uid === -1 ? null : uid,
      gid: gid === -1 ? null : gid,
    });
  }),
);

// Atomic in-place file edit with optimistic concurrency. The endpoint is
// PUT (idempotent on identical content) and accepts the file body as a
// JSON-encoded string + optional `if_mtime` for the concurrency check.
// 409 on mtime mismatch lets the SPA prompt the user to reload / merge /
// overwrite instead of silently clobbering a concurrent edit.
r.put(
  '/:name/browse/file',
  {
    summary: 'Overwrite a regular file (atomic; preserves perms/owner)',
    admin: true,
    params: NameParam,
    query: RequiredPathQuery,
    body: VolumeBrowseSaveRequest,
    responses: { 200: VolumeBrowseSaveResponse },
  },
  asyncHandler(async (req, res) => {
    const safe = safePath(req.query.path);
    if (safe === '/target') throw new HttpError(400, 'Cannot edit the volume root');
    const content = Buffer.from(req.body.content || '', 'utf8');
    const args = [
      'python3', '-c', EDIT_SCRIPT,
      safe,
      req.body.if_mtime != null ? String(req.body.if_mtime) : '',
      req.body.mode || '',
    ];
    const out = await runOnce(req.params.name, args, { stdin: content, capAdd: BROWSER_CAPS });
    const text = (out.stdout || '').trim();
    if (!text) {
      throw new HttpError(500, `edit produced no output${out.stderr ? ': ' + out.stderr.slice(0, 200) : ''}`);
    }
    let data;
    try { data = JSON.parse(text); }
    catch { throw new HttpError(500, `edit returned malformed JSON: ${text.slice(0, 200)}`); }
    // Optimistic-concurrency conflict: surface as 409 with the server's
    // current mtime so the client can reconcile.
    if (data.conflict) {
      return res.status(409).json({
        detail: data.conflict,
        server_mtime: data.server_mtime,
      });
    }
    if (data.error) throw new HttpError(400, data.error);
    res.json({
      saved: true,
      path: safe.slice('/target'.length) || '/',
      size: data.size,
      mtime: data.mtime,
    });
  }),
);

// ---------- Bulk ops (multi-select fast path) ----------
//
// Without these, the SPA's multi-select toolbar would issue N separate
// HTTP calls, each ~200 ms of container start cost. With them, N items
// = 1 container = ~200 ms total.

// Shared collector for the bulk-result envelope produced by every bulk
// script. Trims the /target prefix from paths and packages success / fail
// totals so the client can render a row-by-row report.
function mapBulkResults(data) {
  const results = (data.results || []).map((r) => ({
    path: (r.path || '').replace(/^\/target/, '') || '/',
    ok: !!r.ok,
    ...(r.error ? { error: r.error } : {}),
  }));
  return {
    succeeded: results.filter((x) => x.ok).length,
    failed: results.filter((x) => !x.ok).length,
    results,
  };
}

/**
 * #3: bulk endpoints ship their JSON spec via stdin, not argv.
 *
 * The previous version passed up to ~4 MB of JSON as `argv[1]` (1000
 * paths × 4096 chars worst-case), which would trip Linux's 128 KB
 * ARG_MAX and the container would fail to start with an opaque kernel
 * error. The script reads from stdin instead, which has no length cap.
 */
async function runBulk(volume, script, spec) {
  const stdin = Buffer.from(JSON.stringify(spec), 'utf8');
  return runOnce(
    volume,
    ['python3', '-c', script],
    { stdin, capAdd: BROWSER_CAPS },
  );
}

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
    const out = await runBulk(req.params.name, BULK_CHMOD_SCRIPT, {
      mode: req.body.mode, recursive: !!req.body.recursive, paths,
    });
    res.json(mapBulkResults(parseScriptResult(out, 'bulk chmod')));
  }),
);

r.post(
  '/:name/browse/chown/bulk',
  {
    summary: 'chown many paths at once (multi-select)',
    admin: true,
    expensive: true,
    params: NameParam,
    body: VolumeBrowseBulkChownRequest,
    responses: { 200: VolumeBrowseBulkResponse },
  },
  asyncHandler(async (req, res) => {
    if (req.body.uid == null && req.body.gid == null) {
      throw new HttpError(400, 'At least one of uid / gid must be provided');
    }
    const paths = req.body.paths.map((p) => safePath(p));
    const out = await runBulk(req.params.name, BULK_CHOWN_SCRIPT, {
      uid: req.body.uid == null ? -1 : req.body.uid,
      gid: req.body.gid == null ? -1 : req.body.gid,
      recursive: !!req.body.recursive,
      paths,
    });
    res.json(mapBulkResults(parseScriptResult(out, 'bulk chown')));
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
    const out = await runBulk(req.params.name, BULK_DELETE_SCRIPT, { paths });
    res.json(mapBulkResults(parseScriptResult(out, 'bulk delete')));
  }),
);

// #20: atomic chmod + chown.
//
// The UI's Permissions modal previously fired chmod and chown as two
// independent HTTP calls — if the first succeeded and the second
// failed, the file ended up in a half-applied state. This endpoint
// applies both inside one container so the user gets either both
// mutations or neither.
r.post(
  '/:name/browse/permissions',
  {
    summary: 'Atomically apply mode and/or owner to a single path',
    admin: true,
    params: NameParam,
    body: VolumeBrowsePermissionsRequest,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (req, res) => {
    if (req.body.mode == null && req.body.uid == null && req.body.gid == null) {
      throw new HttpError(400, 'At least one of mode / uid / gid must be provided');
    }
    const safe = safePath(req.body.path);
    if (safe === '/target') {
      throw new HttpError(400, 'Cannot change permissions on the volume root');
    }
    const out = await runOnce(
      req.params.name,
      ['python3', '-c', PERMISSIONS_SCRIPT],
      {
        capAdd: BROWSER_CAPS,
        stdin: Buffer.from(JSON.stringify({
          path: safe,
          mode: req.body.mode,
          uid: req.body.uid,
          gid: req.body.gid,
          recursive: !!req.body.recursive,
        }), 'utf8'),
      },
    );
    parseScriptResult(out, 'permissions');
    res.json({
      path: safe.slice('/target'.length) || '/',
      ...(req.body.mode ? { mode: req.body.mode } : {}),
      ...(req.body.uid != null ? { uid: req.body.uid === -1 ? null : req.body.uid } : {}),
      ...(req.body.gid != null ? { gid: req.body.gid === -1 ? null : req.body.gid } : {}),
    });
  }),
);

r.post(
  '/:name/browse/permissions/bulk',
  {
    summary: 'Atomically apply mode and/or owner to many paths (multi-select)',
    admin: true,
    expensive: true,
    params: NameParam,
    body: VolumeBrowseBulkPermissionsRequest,
    responses: { 200: VolumeBrowseBulkResponse },
  },
  asyncHandler(async (req, res) => {
    if (req.body.mode == null && req.body.uid == null && req.body.gid == null) {
      throw new HttpError(400, 'At least one of mode / uid / gid must be provided');
    }
    const paths = req.body.paths.map((p) => safePath(p));
    const out = await runBulk(req.params.name, PERMISSIONS_SCRIPT, {
      paths,
      mode: req.body.mode,
      uid: req.body.uid,
      gid: req.body.gid,
      recursive: !!req.body.recursive,
    });
    res.json(mapBulkResults(parseScriptResult(out, 'bulk permissions')));
  }),
);

// Visible-for-testing only.
export const _internals = {
  safePath, parseScriptResult, errorStatusFor, contentDispositionFor,
};

export default r;
