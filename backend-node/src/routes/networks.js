// Network management endpoints.
import { Router } from 'express';
import { authenticate, requireAdmin } from '../auth.js';
import { getClient } from '../docker-client.js';
import { asyncHandler, HttpError } from '../util.js';

const router = Router();
router.use(authenticate);

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
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (!b.name) throw new HttpError(400, 'name is required');
    const n = await getClient().createNetwork({
      Name: b.name,
      Driver: b.driver || 'bridge',
      Internal: !!b.internal,
      Attachable: b.attachable !== false,
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
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (!b.container) throw new HttpError(400, 'container is required');
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
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (!b.container) throw new HttpError(400, 'container is required');
    await getClient().getNetwork(req.params.id).disconnect({
      Container: b.container,
      Force: !!b.force,
    });
    res.json({
      network: req.params.id,
      container: b.container,
      disconnected: true,
    });
  }),
);

export default router;
