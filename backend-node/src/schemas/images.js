import { Type } from '@sinclair/typebox';
import { Opt } from './_common.js';

export const PullRequest = Type.Object(
  {
    repository: Type.String({ minLength: 1, maxLength: 512 }),
    tag: Opt(Type.String({ maxLength: 255 })),
    registry: Opt(Type.String({ maxLength: 128, description: 'Name of a stored registry credential set' })),
  },
  { $id: 'PullRequest', additionalProperties: false },
);

export const ImageSummary = Type.Object(
  {
    id: Type.String(),
    short_id: Type.String(),
    tags: Type.Array(Type.String()),
    size: Opt(Type.Integer()),
    created: Opt(Type.String()),
    architecture: Opt(Type.String()),
    os: Opt(Type.String()),
    labels: Type.Record(Type.String(), Type.String()),
  },
  { $id: 'ImageSummary', additionalProperties: true },
);
