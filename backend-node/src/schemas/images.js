import { Type } from '@sinclair/typebox';
import { Opt } from './_common.js';

// Strict image-reference / image-id validator.
//
// Accepts either:
//   - sha256:<hex>...                                 (full image ID)
//   - <hex>...                                        (short image ID)
//   - [registry[:port]/]name[:tag][@sha256:hex]       (canonical reference)
//
// Forbidden characters: backslash, whitespace, control chars, '..' segments,
// shell metachars. Length capped to 512 to stop pathological inputs.
const IMAGE_REF_PATTERN =
  '^(sha256:[a-f0-9]{6,64}|[a-f0-9]{6,64}|[a-zA-Z0-9][a-zA-Z0-9._-]*(?::[0-9]{1,5})?(?:/[a-zA-Z0-9][a-zA-Z0-9._-]*)*(?::[a-zA-Z0-9][a-zA-Z0-9._-]*)?(?:@sha256:[a-f0-9]{64})?)$';

export const ImageIdParam = Type.Object(
  {
    id: Type.String({
      minLength: 1,
      maxLength: 512,
      pattern: IMAGE_REF_PATTERN,
      description: 'Image reference or ID (sha256, short ID, or repo[:tag][@digest])',
    }),
  },
  { additionalProperties: false },
);

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
