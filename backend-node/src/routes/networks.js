// Network management endpoints.
import { Router } from 'express';
import { authenticate, requireAdmin } from '../auth.js';
import { getClient } from '../docker-client.js';
import { asyncHandler, HttpError } from '../util.js';
import { opt, validateBody, z } from '../validate.js';

const router = Router();
router.use(authenticate);

const NETWORK_DRIVERS = ['bridge', 'overlay', 'macvlan', 'ipvlan', 'host', 'none'];

const CreateNetworkBody = z
  .object({
    name: z.string().min(1).max(255),
    driver: z.string().max(64).default('bridge'),
    internal: z.boolean().default(false),
    attachable: z.boolean().default(true),
    labels: opt(z.record(z.string(), z.string())),
  })
  .strict();

const ConnectBody = z
  .object({
    container: z.string().min(1, 'container is required').max(128),
    aliases: opt(z.array(z.string())),
    ipv4_address: opt(z.string()),
    ipv6_address: opt(z.string()),
    links: opt(z.array(z.string())),
  })
  .strict();

const DisconnectBody = z
  .object({
    container: z.string().min(1, 'container is required').max(128),
    force: z.boolean().default(false),
  })
  .strict();

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

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const list = await getClient().listNetworks();
    res.json(list.map(summary));
  }),
);

router.post(
  '/',
  requireAdmin,
  validateBody(CreateNetworkBody),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const n = await getClient().createNetwork({
      Name: b.name,
      Driver: b.driver,
      Internal: b.internal,
      Attachable: b.attachable,
      Labels: b.labels || {},
    });
    const inspect = await n.inspect();
    res.json(summary(inspect));
  }),
);

router.post(
  '/prune',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await getClient().pruneNetworks());
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await getClient().getNetwork(req.params.id).inspect());
  }),
);

router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    await getClient().getNetwork(req.params.id).remove();
    res.json({ removed: req.params.id });
  }),
);

router.post(
  '/:id/connect',
  requireAdmin,
  validateBody(ConnectBody),
  asyncHandler(async (req, res) => {
    const b = req.body;
    await getClient().getNetwork(req.params.id).connect({
      Container: b.container,
      EndpointConfig: {
        Aliases: b.aliases || undefined,
        Links: b.links || undefined,
        IPAMConfig:
          b.ipv4_address || b.ipv6_address
            ? {
                IPv4Address: b.ipv4_address || undefined,
                IPv6Address: b.ipv6_address || undefined,
              }
            : undefined,
      },
    });
    res.json({ network: req.params.id, container: b.container, connected: true });
  }),
);

router.post(
  '/:id/disconnect',
  requireAdmin,
  validateBody(DisconnectBody),
  asyncHandler(async (req, res) => {
    const b = req.body;
    await getClient().getNetwork(req.params.id).disconnect({
      Container: b.container,
      Force: b.force,
    });
    res.json({
      network: req.params.id,
      container: b.container,
      disconnected: true,
    });
  }),
);

export default router;
