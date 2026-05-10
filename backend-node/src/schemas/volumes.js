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

export const VolumeBrowseEntry = Type.Object(
  {
    name: Type.String(),
    is_dir: Type.Boolean(),
    is_link: Type.Boolean(),
    size: Type.Integer(),
    mode: Type.Integer(),
    mtime: Type.Number(),
  },
  { $id: 'VolumeBrowseEntry', additionalProperties: false },
);

export const VolumeBrowseListResponse = Type.Object(
  {
    path: Type.String(),
    entries: Type.Array(VolumeBrowseEntry),
  },
  { $id: 'VolumeBrowseListResponse', additionalProperties: false },
);
