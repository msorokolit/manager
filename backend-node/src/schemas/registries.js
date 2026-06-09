import { Type } from '@sinclair/typebox';
import { Opt } from './_common.js';

export const RegistryRequest = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.-]*$',
    }),
    url: Type.Optional(Type.String({ format: 'uri', maxLength: 2048 })),
    username: Type.String({ minLength: 1, maxLength: 255 }),
    password: Type.String({ minLength: 1, maxLength: 2048 }),
    email: Opt(Type.String({ format: 'email', maxLength: 255 })),
  },
  { $id: 'RegistryRequest', additionalProperties: false },
);

// PUT body: name comes from the path, body name is optional / ignored.
export const RegistryUpdateRequest = Type.Object(
  {
    name: Opt(Type.String()),
    url: Type.Optional(Type.String({ format: 'uri', maxLength: 2048 })),
    username: Type.String({ minLength: 1, maxLength: 255 }),
    password: Type.String({ minLength: 1, maxLength: 2048 }),
    email: Opt(Type.String({ format: 'email', maxLength: 255 })),
  },
  { $id: 'RegistryUpdateRequest', additionalProperties: false },
);

export const RegistryPublic = Type.Object(
  {
    name: Type.String(),
    url: Type.String(),
    username: Type.String(),
    email: Opt(Type.String()),
  },
  { $id: 'RegistryPublic', additionalProperties: false },
);
