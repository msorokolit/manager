import { Type } from '@sinclair/typebox';
import { Opt, StringEnum } from './_common.js';

export const SERVICE_ACTIONS = ['up', 'start', 'stop', 'restart', 'pull', 'rm'];
const STACK_NAME_PATTERN = '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$';
const SERVICE_NAME_PATTERN = '^[a-zA-Z0-9][a-zA-Z0-9_.-]*$';

export const StackNameParam = Type.Object(
  { name: Type.String({ pattern: STACK_NAME_PATTERN }) },
  { additionalProperties: false },
);

export const StackServiceParam = Type.Object(
  {
    name: Type.String({ pattern: STACK_NAME_PATTERN }),
    service: Type.String({ pattern: SERVICE_NAME_PATTERN, maxLength: 128 }),
  },
  { additionalProperties: false },
);

export const StackServiceActionParam = Type.Object(
  {
    name: Type.String({ pattern: STACK_NAME_PATTERN }),
    service: Type.String({ pattern: SERVICE_NAME_PATTERN, maxLength: 128 }),
    action: StringEnum(SERVICE_ACTIONS),
  },
  { additionalProperties: false },
);

export const CreateStackRequest = Type.Object(
  {
    name: Type.String({ pattern: STACK_NAME_PATTERN }),
    compose: Type.String({ minLength: 1, maxLength: 1024 * 1024 }),
    env: Opt(Type.String({ maxLength: 64 * 1024 })),
    deploy: Type.Optional(Type.Boolean({ default: true })),
  },
  { $id: 'CreateStackRequest', additionalProperties: false },
);

export const UpdateStackRequest = Type.Object(
  {
    compose: Opt(Type.String({ maxLength: 1024 * 1024 })),
    env: Opt(Type.String({ maxLength: 64 * 1024 })),
  },
  { $id: 'UpdateStackRequest', additionalProperties: false },
);

export const StackSummary = Type.Object(
  {
    name: Type.String(),
    managed: Type.Boolean(),
    services: Type.Array(Type.String()),
    containers: Type.Integer(),
    running: Type.Integer(),
  },
  { $id: 'StackSummary', additionalProperties: false },
);

export const StackDetail = Type.Composite(
  [
    StackSummary,
    Type.Object({
      compose: Opt(Type.String()),
      env: Opt(Type.String()),
      containers_detail: Type.Array(
        Type.Object({
          id: Type.String(),
          name: Type.String(),
          service: Opt(Type.String()),
          status: Type.String(),
          image: Opt(Type.String()),
        }),
      ),
    }),
  ],
  { $id: 'StackDetail' },
);

export const ValidateResponse = Type.Object(
  {
    ok: Type.Boolean(),
    stdout: Type.String(),
    stderr: Type.String(),
  },
  { $id: 'ValidateResponse', additionalProperties: false },
);
