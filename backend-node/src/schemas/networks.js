import { Type } from '@sinclair/typebox';
import { Opt, StringEnum } from './_common.js';

export const NETWORK_DRIVERS = ['bridge', 'overlay', 'macvlan', 'ipvlan', 'host', 'none'];

export const CreateNetworkRequest = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 255 }),
    driver: Type.Optional(Type.String({ maxLength: 64, default: 'bridge' })),
    internal: Type.Optional(Type.Boolean({ default: false })),
    attachable: Type.Optional(Type.Boolean({ default: true })),
    labels: Opt(Type.Record(Type.String(), Type.String())),
  },
  { $id: 'CreateNetworkRequest', additionalProperties: false },
);

export const ConnectRequest = Type.Object(
  {
    container: Type.String({ minLength: 1, maxLength: 128 }),
    aliases: Opt(Type.Array(Type.String())),
    ipv4_address: Opt(Type.String()),
    ipv6_address: Opt(Type.String()),
    links: Opt(Type.Array(Type.String())),
  },
  { $id: 'ConnectRequest', additionalProperties: false },
);

export const DisconnectRequest = Type.Object(
  {
    container: Type.String({ minLength: 1, maxLength: 128 }),
    force: Type.Optional(Type.Boolean({ default: false })),
  },
  { $id: 'DisconnectRequest', additionalProperties: false },
);

export const NetworkSummary = Type.Object(
  {
    id: Type.String(),
    short_id: Type.String(),
    name: Type.String(),
    driver: Type.String(),
    scope: Type.String(),
    internal: Type.Boolean(),
    attachable: Type.Boolean(),
    ipam: Type.Optional(Type.Any()),
    labels: Type.Record(Type.String(), Type.String()),
    containers: Type.Array(Type.String()),
  },
  { $id: 'NetworkSummary', additionalProperties: true },
);
