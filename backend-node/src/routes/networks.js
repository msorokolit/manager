// Network management endpoints.
import { Type } from '@sinclair/typebox';
import { getClient } from '../docker-client.js';
import { asyncHandler } from '../util.js';
import { createApiRouter } from '../route-builder.js';
import {
  ConnectRequest,
  CreateNetworkRequest,
  DisconnectRequest,
  NetworkSummary,
  PassThroughObject,
} from '../schemas/index.js';

const r = createApiRouter('/api/networks', { tag: 'networks' });

function summary(n) {
  return {
    id: n.Id,
    short_id: (n.Id || '').slice(0, 12),
    name: n.Name,
    driver: n.Driver,
    scope: n.Scope,
    internal: n.Internal,
    attachable: n.Attachable,
    ipam: n.IPAM,
    labels: n.Labels || {},
    containers: Object.keys(n.Containers || {}),
  };
}

const IdParam = Type.Object({ id: Type.String() }, { additionalProperties: false });

r.get(
  '/',
  { summary: 'List networks', responses: { 200: Type.Array(NetworkSummary) } },
  asyncHandler(async (_req, res) =>
    res.json((await getClient().listNetworks()).map(summary)),
  ),
);

r.post(
  '/',
  {
    summary: 'Create a network',
    admin: true,
    destructive: true,
    body: CreateNetworkRequest,
    responses: { 200: NetworkSummary },
  },
  asyncHandler(async (req, res) => {
    const b = req.body;
    const n = await getClient().createNetwork({
      Name: b.name,
      Driver: b.driver,
      Internal: b.internal,
      Attachable: b.attachable,
      Labels: b.labels || {},
    });
    res.json(summary(await n.inspect()));
  }),
);

r.post(
  '/prune',
  { summary: 'Prune unused networks', admin: true, destructive: true, responses: { 200: PassThroughObject } },
  asyncHandler(async (_req, res) => res.json(await getClient().pruneNetworks())),
);

r.get(
  '/:id',
  { summary: 'Inspect a network', params: IdParam, responses: { 200: PassThroughObject } },
  asyncHandler(async (req, res) =>
    res.json(await getClient().getNetwork(req.params.id).inspect()),
  ),
);

r.delete(
  '/:id',
  {
    summary: 'Remove a network',
    admin: true,
    destructive: true,
    params: IdParam,
    responses: { 200: Type.Object({ removed: Type.String() }) },
  },
  asyncHandler(async (req, res) => {
    await getClient().getNetwork(req.params.id).remove();
    res.json({ removed: req.params.id });
  }),
);

r.post(
  '/:id/connect',
  {
    summary: 'Connect a container to a network',
    admin: true,
    destructive: true,
    params: IdParam,
    body: ConnectRequest,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (req, res) => {
    const b = req.body;
    await getClient().getNetwork(req.params.id).connect({
      Container: b.container,
      EndpointConfig: {
        Aliases: b.aliases || undefined,
        Links: b.links || undefined,
        IPAMConfig:
          b.ipv4_address || b.ipv6_address
            ? { IPv4Address: b.ipv4_address || undefined, IPv6Address: b.ipv6_address || undefined }
            : undefined,
      },
    });
    res.json({ network: req.params.id, container: b.container, connected: true });
  }),
);

r.post(
  '/:id/disconnect',
  {
    summary: 'Disconnect a container from a network',
    admin: true,
    destructive: true,
    params: IdParam,
    body: DisconnectRequest,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (req, res) => {
    const b = req.body;
    await getClient().getNetwork(req.params.id).disconnect({
      Container: b.container,
      Force: b.force,
    });
    res.json({ network: req.params.id, container: b.container, disconnected: true });
  }),
);

export default r;
