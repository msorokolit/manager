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
      description: 'Native Docker labels set at volume create time (immutable)',
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
      description: 'Containers currently mounting this volume + their mount info (incl. per-mount rw/ro)',
    }),
    size_bytes: Opt(Type.Integer({
      description: 'Disk usage (-1 = unknown). May be omitted when /system/df is slow/disabled.',
    })),
  },
  { $id: 'VolumeSummary', additionalProperties: false },
);

/**
 * Inspect response: VolumeSummary fields plus the raw Docker inspect
 * payload (status, scopes, ucfreshClusterVolume, etc.) for the Raw tab.
 * The enriched fields are duplicated so that the SPA can read the
 * normalised snake_case shape without picking through PascalCase docker
 * fields, while still surfacing the full daemon response on the Raw tab.
 */
export const VolumeDetail = Type.Object(
  {
    // Normalised, snake_case — same shape as VolumeSummary.
    name: Type.String(),
    driver: Type.String(),
    mountpoint: Type.String(),
    scope: Type.String(),
    created_at: Opt(Type.String()),
    labels: Type.Record(Type.String(), Type.String()),
    options: Type.Record(Type.String(), Type.String()),
    stack: Opt(Type.String()),
    in_use: Type.Boolean(),
    used_by: Type.Array(VolumeUsage),
    size_bytes: Opt(Type.Integer()),
    // Raw daemon inspect payload (PascalCase). Tucked behind a single
    // field so the Raw tab can render it without our enrichment cluttering
    // the JSON, and so consumers that don't care about it can skip it.
    raw: Type.Unsafe({
      type: 'object',
      additionalProperties: true,
      description: 'Verbatim dockerode .inspect() response (PascalCase)',
    }),
  },
  { $id: 'VolumeDetail', additionalProperties: false },
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

/** Query params for the directory listing — kept as a schema so the
 * OpenAPI doc enumerates the sort options and bounds. */
export const VolumeBrowseListQuery = Type.Object(
  {
    path: Type.Optional(Type.String({ default: '' })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50000, default: 5000 })),
    offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
    // Server-side sort (#19). The previous client-side sort was misleading
    // on paginated directories ("page 1 sorted by size" wasn't actually
    // "top 100 by size").
    sort: Type.Optional(Type.Unsafe({
      type: 'string', enum: ['name', 'size', 'mtime'], default: 'name',
    })),
    order: Type.Optional(Type.Unsafe({
      type: 'string', enum: ['asc', 'desc'], default: 'asc',
    })),
    // Surface dirs-first ordering even in non-name sorts — directories
    // are usually what the user wants to drill into.
    dirs_first: Type.Optional(Type.Boolean({ default: true })),
  },
  { $id: 'VolumeBrowseListQuery', additionalProperties: false },
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
 * inside the helper container would resolve against that container's
 * /etc/passwd, which doesn't necessarily match the volume's actual user
 * database. At least one of uid / gid must be provided; -1 means
 * "leave unchanged" (matches the POSIX chown(2) semantics).
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

// Bulk request bounds: each path up to 1024 chars × up to 500 items
// keeps the JSON payload well under Linux's 128 KB argv ceiling even
// when serialised, and matches the "I selected a lot of stuff in the
// UI" upper bound. Larger batches probably want pagination anyway.
const BULK_PATH = Type.String({ minLength: 1, maxLength: 1024 });
const BULK_ITEMS = { minItems: 1, maxItems: 500 };

export const VolumeBrowseBulkChownRequest = Type.Object(
  {
    paths: Type.Array(BULK_PATH, BULK_ITEMS),
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
    paths: Type.Array(BULK_PATH, BULK_ITEMS),
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
    paths: Type.Array(BULK_PATH, BULK_ITEMS),
  },
  { $id: 'VolumeBrowseBulkDeleteRequest', additionalProperties: false },
);

/**
 * Combined Permissions request (#20): apply mode and/or owner changes
 * atomically inside one container, so the user can't get half-applied
 * state (mode changed but owner failed, or vice versa).
 *
 * - Provide `mode` to chmod, `uid`/`gid` (-1 = unchanged) to chown.
 * - At least one of (mode, uid, gid) must be present.
 * - `recursive` applies to both halves uniformly.
 */
export const VolumeBrowsePermissionsRequest = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    mode: Type.Optional(Type.String({
      pattern: '^0?[0-7]{3,4}$',
      description: 'Octal mode (e.g. "0644")',
    })),
    uid: Type.Optional(Type.Integer({ minimum: -1, maximum: 4294967295 })),
    gid: Type.Optional(Type.Integer({ minimum: -1, maximum: 4294967295 })),
    recursive: Type.Optional(Type.Boolean({ default: false })),
  },
  { $id: 'VolumeBrowsePermissionsRequest', additionalProperties: false },
);

export const VolumeBrowseBulkPermissionsRequest = Type.Object(
  {
    paths: Type.Array(BULK_PATH, BULK_ITEMS),
    mode: Type.Optional(Type.String({ pattern: '^0?[0-7]{3,4}$' })),
    uid: Type.Optional(Type.Integer({ minimum: -1, maximum: 4294967295 })),
    gid: Type.Optional(Type.Integer({ minimum: -1, maximum: 4294967295 })),
    recursive: Type.Optional(Type.Boolean({ default: false })),
  },
  { $id: 'VolumeBrowseBulkPermissionsRequest', additionalProperties: false },
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
 *
 * `mtime` is included so the editor can use the freshest concurrency
 * token (was previously taking it from the directory listing, which may
 * have been stale by the time the user opened the file).
 */
export const VolumeBrowseViewResponse = Type.Object(
  {
    path: Type.String(),
    size: Type.Integer(),
    mtime: Type.Number({ description: 'Unix mtime when the view was taken; pass back as if_mtime on save' }),
    is_binary: Type.Boolean(),
    truncated: Type.Boolean(),
    encoding: Opt(Type.String()),
    content: Opt(Type.String()),
  },
  { $id: 'VolumeBrowseViewResponse', additionalProperties: false },
);
