import { Type } from '@sinclair/typebox';
import { Opt } from './_common.js';

export const CreateVolumeRequest = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: 255,
      pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.-]*$',
    }),
    driver: Type.Optional(Type.String({ maxLength: 64, default: 'local' })),
    labels: Opt(Type.Record(Type.String(), Type.String())),
    driver_opts: Opt(Type.Record(Type.String(), Type.String())),
  },
  { $id: 'CreateVolumeRequest', additionalProperties: false },
);

// One entry of "which container is using this volume right now". Same
// shape on the wire whether the volume is in use or not (we just send
// an empty array). `rw` mirrors the kernel mount mode the container has.
export const VolumeUsage = Type.Object(
  {
    container_id: Type.String(),
    container_name: Type.String(),
    mount_path: Type.String(),
    rw: Type.Boolean(),
  },
  { $id: 'VolumeUsage', additionalProperties: false },
);

export const VolumeSummary = Type.Object(
  {
    name: Type.String(),
    driver: Type.String(),
    mountpoint: Type.String(),
    scope: Type.String(),
    created_at: Opt(Type.String()),
    labels: Type.Record(Type.String(), Type.String(), {
      description: 'Merged: daemon labels + manager extra_labels (extras win on conflict)',
    }),
    options: Type.Record(Type.String(), Type.String()),
    // Enriched fields — Portainer-parity columns for the volume list.
    stack: Opt(Type.String({
      description: 'Compose project name from com.docker.compose.project label',
    })),
    in_use: Type.Boolean({
      description: 'True when at least one container has this volume mounted',
    }),
    used_by: Type.Array(VolumeUsage, {
      description: 'Containers currently mounting this volume + their mount info',
    }),
    size_bytes: Opt(Type.Integer({
      description: 'Disk usage (-1 = unknown). May be omitted when /system/df is slow/disabled.',
    })),
    read_only: Type.Boolean({
      default: false,
      description: 'True iff com.docker.manager.readonly label resolves to "true"',
    }),
  },
  { $id: 'VolumeSummary', additionalProperties: true },
);

/**
 * Replace the manager-side `extra_labels` map for a volume. We don't
 * touch the daemon's own labels (the Engine API has no PATCH for that),
 * but our list/inspect responses merge the two so the UI sees them as
 * one label set. Pass an empty object to clear all manager labels.
 */
export const VolumeLabelsUpdateRequest = Type.Object(
  {
    extra_labels: Type.Record(Type.String(), Type.String(), {
      description: 'Manager-side labels for this volume (replaces existing extras)',
    }),
  },
  { $id: 'VolumeLabelsUpdateRequest', additionalProperties: false },
);

/**
 * Bulk delete for the volume list's multi-select. Per-item failures
 * (in-use, not-found) come back in `results` so the UI can render a
 * row-by-row report rather than failing the whole batch on one error.
 */
export const VolumeBulkDeleteRequest = Type.Object(
  {
    names: Type.Array(Type.String({ minLength: 1, maxLength: 255 }), {
      minItems: 1, maxItems: 1000,
    }),
    force: Type.Optional(Type.Boolean({ default: false })),
  },
  { $id: 'VolumeBulkDeleteRequest', additionalProperties: false },
);

export const VolumeBulkResult = Type.Object(
  {
    name: Type.String(),
    ok: Type.Boolean(),
    error: Opt(Type.String()),
  },
  { additionalProperties: false },
);

export const VolumeBulkResponse = Type.Object(
  {
    succeeded: Type.Integer(),
    failed: Type.Integer(),
    results: Type.Array(VolumeBulkResult),
  },
  { $id: 'VolumeBulkResponse', additionalProperties: false },
);

// ---------- Volume browser (Portainer-style file manager) ----------

/**
 * One entry in a directory listing. Includes the rich filesystem metadata a
 * file manager UI needs: owner/group (both numeric uid/gid and resolved
 * names where possible), the POSIX permission string (e.g. "-rw-r--r--"),
 * symlink targets, and the raw stat mode bits.
 */
export const VolumeBrowseEntry = Type.Object(
  {
    name: Type.String(),
    is_dir: Type.Boolean(),
    is_link: Type.Boolean(),
    size: Type.Integer(),
    mode: Type.Integer({ description: 'Raw st_mode bits' }),
    mode_str: Type.String({ description: 'POSIX rwx representation, e.g. "-rw-r--r--"' }),
    mtime: Type.Number({ description: 'Unix mtime (seconds, may be fractional)' }),
    uid: Type.Integer(),
    gid: Type.Integer(),
    user: Type.String({ description: 'Resolved user name, or numeric uid as a string' }),
    group: Type.String({ description: 'Resolved group name, or numeric gid as a string' }),
    link_target: Opt(Type.String({ description: 'For symlinks: the link target as stored' })),
  },
  { $id: 'VolumeBrowseEntry', additionalProperties: false },
);

export const VolumeBrowseListResponse = Type.Object(
  {
    path: Type.String(),
    total: Type.Integer({ description: 'Total entries in the directory (pre-pagination)' }),
    entries: Type.Array(VolumeBrowseEntry),
  },
  { $id: 'VolumeBrowseListResponse', additionalProperties: false },
);

export const VolumeBrowseChmodRequest = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    // chmod accepts both "0644" and "644"; the regex tolerates either.
    mode: Type.String({
      pattern: '^0?[0-7]{3,4}$',
      description: 'Octal mode (e.g. "0644", "755")',
    }),
    recursive: Type.Optional(Type.Boolean({ default: false })),
  },
  { $id: 'VolumeBrowseChmodRequest', additionalProperties: false },
);

/**
 * chown: change owner / group on a path. Numeric IDs only — name lookup
 * inside the sidecar would resolve against the sidecar's /etc/passwd
 * which doesn't necessarily match the volume's actual user database.
 * At least one of uid / gid must be provided; -1 means "leave unchanged"
 * (matches the POSIX chown(2) semantics).
 */
export const VolumeBrowseChownRequest = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    uid: Type.Optional(Type.Integer({ minimum: -1, maximum: 4294967295 })),
    gid: Type.Optional(Type.Integer({ minimum: -1, maximum: 4294967295 })),
    recursive: Type.Optional(Type.Boolean({ default: false })),
  },
  { $id: 'VolumeBrowseChownRequest', additionalProperties: false },
);

export const VolumeBrowseBulkChownRequest = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
      minItems: 1, maxItems: 1000,
    }),
    uid: Type.Optional(Type.Integer({ minimum: -1, maximum: 4294967295 })),
    gid: Type.Optional(Type.Integer({ minimum: -1, maximum: 4294967295 })),
    recursive: Type.Optional(Type.Boolean({ default: false })),
  },
  { $id: 'VolumeBrowseBulkChownRequest', additionalProperties: false },
);

/**
 * Edit (overwrite) a regular file. `if_mtime` enables optimistic
 * concurrency: clients send the mtime they read; server refuses with
 * 409 if the file changed underneath them. `mode` is honoured only
 * when creating a new file (otherwise the existing file's mode is
 * preserved, so editing a 0600 secret won't accidentally widen it).
 */
export const VolumeBrowseSaveRequest = Type.Object(
  {
    content: Type.String({ description: 'UTF-8 text content' }),
    if_mtime: Type.Optional(
      Type.Number({ description: 'Mtime observed when reading; rejected if file changed since' }),
    ),
    mode: Type.Optional(
      Type.String({
        pattern: '^0?[0-7]{3,4}$',
        description: 'Octal mode applied only on file creation',
      }),
    ),
  },
  { $id: 'VolumeBrowseSaveRequest', additionalProperties: false },
);

export const VolumeBrowseSaveResponse = Type.Object(
  {
    saved: Type.Boolean(),
    path: Type.String(),
    size: Type.Integer(),
    mtime: Type.Number(),
  },
  { $id: 'VolumeBrowseSaveResponse', additionalProperties: false },
);

/**
 * Bulk chmod: apply one mode to many paths in a single round-trip. Saves
 * (N-1) container startups when the user multi-selects N items in the file
 * manager and changes their permissions.
 */
export const VolumeBrowseBulkChmodRequest = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
      minItems: 1, maxItems: 1000,
    }),
    mode: Type.String({
      pattern: '^0?[0-7]{3,4}$',
      description: 'Octal mode (e.g. "0644", "755")',
    }),
    recursive: Type.Optional(Type.Boolean({ default: false })),
  },
  { $id: 'VolumeBrowseBulkChmodRequest', additionalProperties: false },
);

/**
 * Bulk delete: same idea — N path removals in one container run.
 */
export const VolumeBrowseBulkDeleteRequest = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
      minItems: 1, maxItems: 1000,
    }),
  },
  { $id: 'VolumeBrowseBulkDeleteRequest', additionalProperties: false },
);

/**
 * Bulk-op result: one entry per requested path. Partial failures are
 * surfaced per-entry, not as a 4xx — clients render a row-by-row report.
 */
export const VolumeBrowseBulkResult = Type.Object(
  {
    path: Type.String(),
    ok: Type.Boolean(),
    error: Opt(Type.String()),
  },
  { additionalProperties: false },
);

export const VolumeBrowseBulkResponse = Type.Object(
  {
    succeeded: Type.Integer(),
    failed: Type.Integer(),
    results: Type.Array(VolumeBrowseBulkResult),
  },
  { $id: 'VolumeBrowseBulkResponse', additionalProperties: false },
);

export const VolumeBrowseRenameRequest = Type.Object(
  {
    // Both paths are relative to the volume root; the server validates them.
    from: Type.String({ minLength: 1, maxLength: 4096 }),
    to: Type.String({ minLength: 1, maxLength: 4096 }),
  },
  { $id: 'VolumeBrowseRenameRequest', additionalProperties: false },
);

/**
 * Response for the inline file-view endpoint. Either a text payload (UTF-8
 * if decodable, else latin-1 as a fallback), or a "binary" marker when the
 * file contains NULs in the first 8 KB.
 */
export const VolumeBrowseViewResponse = Type.Object(
  {
    path: Type.String(),
    size: Type.Integer(),
    is_binary: Type.Boolean(),
    truncated: Type.Boolean(),
    encoding: Opt(Type.String()),
    content: Opt(Type.String()),
  },
  { $id: 'VolumeBrowseViewResponse', additionalProperties: false },
);
