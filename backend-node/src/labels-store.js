// Manager-side per-volume label store.
//
// Why a separate store? Docker's Engine API has no PATCH /volumes/{name}
// endpoint — once a volume is created, its Labels map is immutable from
// the daemon's perspective. To let admins set / edit labels like
// `com.docker.manager.readonly=true` post-creation without recreating
// the volume (which would lose data), we keep our own map on disk and
// merge it into every list / inspect response.
//
// Data shape on disk (atomic JSON file, mode 0600):
//   {
//     "vol-A": { "com.docker.manager.readonly": "true", "owner": "team-a" },
//     "vol-B": { "com.docker.manager.favourite": "true" }
//   }
//
// Concurrency: one in-process Map cached in memory; every write goes
// through `write_lock` so we don't race ourselves. The manager is
// single-process so we don't need a file lock; if/when we ever cluster
// the manager we'd need to swap this for a real KV.
import fs from 'node:fs/promises';
import path from 'node:path';
import { settings } from './config.js';

let cache = null;       // null = not loaded yet
let writeLock = Promise.resolve();
let storePath = null;   // resolved once at startup

function pathOf() {
  if (storePath) return storePath;
  storePath = settings.volumeLabelsFile;
  return storePath;
}

async function loadFromDisk() {
  const p = pathOf();
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // Coerce shape: each entry must be a plain object of string→string.
      const out = {};
      for (const [vol, labels] of Object.entries(parsed)) {
        if (labels && typeof labels === 'object' && !Array.isArray(labels)) {
          const clean = {};
          for (const [k, v] of Object.entries(labels)) {
            if (typeof k === 'string' && typeof v === 'string') clean[k] = v;
          }
          if (Object.keys(clean).length) out[vol] = clean;
        }
      }
      return out;
    }
    return {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    // Don't crash the manager on a corrupt store — log + start fresh.
    // eslint-disable-next-line no-console
    console.warn(`[labels-store] could not read ${p}: ${err.message}; starting empty`);
    return {};
  }
}

async function flushToDisk(data) {
  const p = pathOf();
  await fs.mkdir(path.dirname(p), { recursive: true });
  // Atomic write: temp + rename, mode 0600 (some entries are sensitive
  // by convention — keep the store as private as the registry file).
  const tmp = `${p}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, p);
}

async function ensureLoaded() {
  if (cache !== null) return cache;
  cache = await loadFromDisk();
  return cache;
}

/** Return the extra labels for one volume (empty object if none). */
export async function getLabels(name) {
  const c = await ensureLoaded();
  return { ...(c[name] || {}) };
}

/** Return the full {volume: labels} map. Cheap; callers iterate it. */
export async function getAllLabels() {
  const c = await ensureLoaded();
  // Shallow clone so callers can't mutate our in-memory cache.
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { ...v }]));
}

/**
 * Replace the entire label set for one volume. Pass an empty object to
 * remove all extra labels for that volume (the entry is dropped, not
 * stored as `{}`, so the file stays compact).
 *
 * Returns the new label map for the volume.
 */
export async function setLabels(name, labels) {
  await ensureLoaded();
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) {
    throw new TypeError('setLabels: labels must be a plain object');
  }
  // Run writes serially so we never lose an update to a concurrent one.
  const newCache = await (writeLock = writeLock.then(async () => {
    const next = { ...cache };
    const clean = {};
    for (const [k, v] of Object.entries(labels)) {
      if (typeof k === 'string' && k && typeof v === 'string') clean[k] = v;
    }
    if (Object.keys(clean).length === 0) delete next[name];
    else next[name] = clean;
    await flushToDisk(next);
    cache = next;
    return next;
  }));
  return { ...(newCache[name] || {}) };
}

/** Remove all extra labels for a volume (called from DELETE volume). */
export async function clearLabels(name) {
  return setLabels(name, {});
}

/**
 * Merge the manager-side labels into a daemon-supplied labels object.
 * Manager labels win on key conflicts — they're the deliberate user
 * action; the daemon's labels are whatever was set at create time.
 */
export function mergeLabels(daemonLabels, extraLabels) {
  return { ...(daemonLabels || {}), ...(extraLabels || {}) };
}

// Visible-for-testing: reset the in-memory cache + override storePath.
export function _resetForTests(overridePath) {
  cache = null;
  storePath = overridePath || null;
  writeLock = Promise.resolve();
}
