import { Type } from '@sinclair/typebox';
import { StringEnum } from './_common.js';

export const PingResponse = Type.Object(
  {
    ok: Type.Boolean(),
    user: Type.String(),
    role: StringEnum(['admin', 'viewer']),
  },
  { $id: 'PingResponse', additionalProperties: false },
);

export const HealthResponse = Type.Object(
  {
    status: Type.Literal('ok'),
    version: Type.String(),
  },
  { $id: 'HealthResponse', additionalProperties: false },
);

export const ConfigResponse = Type.Object(
  {
    version: Type.String(),
    allow_destructive: Type.Boolean(),
    compose_available: Type.Boolean(),
    stacks_dir: Type.String(),
    exec_default_shell: Type.String(),
    browser_image: Type.String(),
    registries_file: Type.String(),
    backend: Type.Literal('node'),
  },
  { $id: 'ConfigResponse', additionalProperties: true },
);

export const TicketResponse = Type.Object(
  {
    ticket: Type.String(),
    expires_in: Type.Integer({ minimum: 1 }),
  },
  { $id: 'TicketResponse', additionalProperties: false },
);
