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

export const VolumeSummary = Type.Object(
  {
    name: Type.String(),
    driver: Type.String(),
    mountpoint: Type.String(),
    scope: Type.String(),
    created_at: Opt(Type.String()),
    labels: Type.Record(Type.String(), Type.String()),
    options: Type.Record(Type.String(), Type.String()),
  },
  { $id: 'VolumeSummary', additionalProperties: true },
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
