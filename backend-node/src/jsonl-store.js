// Tiny shared JSONL-file primitive for append + rotated-read.
//
// Two new persistent recorders (event-history, stats-history) need
// the same patterns the audit log already has:
//   1. Serial append with size-based rotation
//   2. Read all rotated siblings in chronological order, line-by-
//      line filter, paginate
//
// Rather than duplicating the audit code or refactoring audit
// (which would risk churning a well-tested module), we lift the
// shared bits into this primitive. Audit keeps its bespoke version
// for compatibility; new modules use this one.
//
// Design constraints copied from audit:
//   - Writes are append-only and serialised through a per-file
//     promise chain so a rotation step can't interleave with an
//     append.
//   - File is opened with mode 0600 so the data isn't world-
//     readable; matches audit defaults.
//   - We cache the file size and only re-stat periodically — every
//     50th write OR on path change OR on first write — so an
//     externally-truncated file doesn't make us keep growing past
//     the rotation cap silently.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

/**
 * Per-file mutable state holder. Each long-lived store creates one
 * of these at module load and passes it to appendLine / queryLines.
 * Keeping the state external (not module-globals) lets tests reset
 * cleanly without needing to reach into module internals.
 */
export function createStore({ file, maxBytes = 50 * 1024 * 1024, rotateKeep = 5 } = {}) {
  return {
    file,
    maxBytes,
    rotateKeep,
    writeChain: Promise.resolve(),
    cachedSize: null,
    cachedFile: null,
    writeCount: 0,
  };
}

/**
 * Append one already-stringified line (must end with `\n`) to the
 * store. Returns the chain promise so tests can await flush, but
 * callers in steady-state don't need to.
 *
 * Errors are NOT thrown — they're returned via the chain and
 * promise-callers can `.catch` if they care. Background recorders
 * typically ignore individual write failures (they'd be logged at
 * a higher level by the caller).
 */
export function appendLine(store, line, { onWriteError } = {}) {
  store.writeChain = store.writeChain.then(async () => {
    const { file, maxBytes, rotateKeep } = store;
    await fsp.mkdir(path.dirname(file), { recursive: true });

    // Re-stat on first write, on path change, or every 50 writes.
    // The latter catches `> events.jsonl` truncations from the
    // shell — without it, cachedSize would keep growing past
    // maxBytes without ever triggering rotation.
    store.writeCount++;
    if (store.cachedSize == null || store.cachedFile !== file || store.writeCount % 50 === 0) {
      try { store.cachedSize = (await fsp.stat(file)).size; }
      catch { store.cachedSize = 0; }
      store.cachedFile = file;
    }
    if (maxBytes > 0 && store.cachedSize + line.length >= maxBytes) {
      await rotate(file, rotateKeep);
      store.cachedSize = 0;
    }
    await fsp.appendFile(file, line, { flag: 'a', mode: 0o600 });
    store.cachedSize += line.length;
  }).catch((err) => {
    if (onWriteError) try { onWriteError(err); } catch { /* never re-throw */ }
  });
  return store.writeChain;
}

async function rotate(file, keep) {
  for (let i = Math.max(1, keep); i > 0; i--) {
    const from = i === 1 ? file : `${file}.${i - 1}`;
    const to = `${file}.${i}`;
    try {
      if (fs.existsSync(from)) {
        if (i === Math.max(1, keep)) await fsp.rm(from, { force: true });
        else await fsp.rename(from, to);
      }
    } catch {
      // Rename failed — bail out rather than lose entries by
      // continuing. The next append will grow the live file past
      // the cap; that's better than losing what's there.
      return;
    }
  }
}

/**
 * Walk all rotated siblings of `file` (oldest first → live file
 * last), parse each line, call `matches(entry)` and collect
 * matching entries. Returns a sorted, paginated result envelope
 * matching the audit query shape (total / returned / has_more /
 * entries).
 *
 * MAX_SCAN guards against a hostile or runaway query OOM-ing the
 * process; it's a per-call cap on lines parsed, not on matches
 * returned. The audit log uses 100k; we default the same.
 */
export async function queryLines(file, matches, {
  limit = 100, offset = 0, order = 'desc',
  orderKey = 'ts',
  maxScan = 100_000,
} = {}) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  let rotated = [];
  try {
    rotated = (await fsp.readdir(dir))
      .filter((n) => n === base || n.startsWith(base + '.'))
      .sort((a, b) => {
        // Sort so oldest comes first, live file last.
        if (a === base) return 1;
        if (b === base) return -1;
        const an = parseInt(a.slice(base.length + 1), 10) || 0;
        const bn = parseInt(b.slice(base.length + 1), 10) || 0;
        return bn - an;
      })
      .map((n) => path.join(dir, n));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const matched = [];
  let scanned = 0;
  for (const filename of rotated) {
    let stream;
    try { stream = fs.createReadStream(filename, { encoding: 'utf8' }); }
    catch { continue; }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      scanned++;
      if (scanned > maxScan) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try { entry = JSON.parse(trimmed); } catch { continue; }
      if (matches(entry)) matched.push(entry);
    }
    rl.close();
    if (scanned > maxScan) break;
  }

  matched.sort((a, b) => {
    const at = (typeof a[orderKey] === 'string' ? Date.parse(a[orderKey]) : a[orderKey]) || 0;
    const bt = (typeof b[orderKey] === 'string' ? Date.parse(b[orderKey]) : b[orderKey]) || 0;
    return order === 'asc' ? at - bt : bt - at;
  });
  const page = matched.slice(offset, offset + limit);
  return {
    total: matched.length,
    returned: page.length,
    has_more: offset + page.length < matched.length,
    scanned,
    truncated: scanned > maxScan,
    entries: page,
  };
}
