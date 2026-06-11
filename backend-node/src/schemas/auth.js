import { Type } from '@sinclair/typebox';
import { StringEnum } from './_common.js';

export const LoginRequest = Type.Object(
  {
    username: Type.String({ minLength: 1, maxLength: 255 }),
    password: Type.String({ minLength: 1, maxLength: 1024 }),
  },
  { $id: 'LoginRequest', additionalProperties: false },
);

export const LoginResponse = Type.Object(
  {
    token: Type.String({ description: 'Signed JWT (HS256)' }),
    token_type: Type.Literal('bearer'),
    expires_in: Type.Integer({ minimum: 1 }),
    user: Type.String(),
    role: StringEnum(['admin', 'viewer']),
  },
  { $id: 'LoginResponse', additionalProperties: false },
);

export const MeResponse = Type.Object(
  {
    user: Type.String(),
    role: StringEnum(['admin', 'viewer']),
  },
  { $id: 'MeResponse', additionalProperties: false },
);
