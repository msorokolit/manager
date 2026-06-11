// Network management endpoints (Portainer-parity).
//
// What this module does:
//   - Enriches Docker's bare `listNetworks` with per-container attachment
//     info (Docker's /networks endpoint doesn't carry it; we cross-reference
//     listContainers ourselves).
//   - Surfaces the IPAM driver + every subnet/gateway in the summary so
//     the list view can render them in dedicated columns instead of
//     forcing the user into the inspect modal.
//   - Tags the predefined daemon-owned networks (bridge / host / none /
//     ingress) as `system: true` and refuses to delete them with a clean
//     409 instead of letting the daemon return a confusing 403.
//   - Adds bulk delete + accepts full IPAM config on create.
import { Type } from '@sinclair/typebox';
import { getClient } from '../docker-client.js';
import { asyncHandler, HttpError } from '../util.js';
import { createApiRouter } from '../route-builder.js';
import {
  ConnectRequest,
  CreateNetworkRequest,
  DisconnectRequest,
  NetworkBulkDeleteRequest,
  NetworkBulkResponse,
  NetworkDetail,
  NetworkSummary,
  PassThroughObject,
  PREDEFINED_NETWORKS,
} from '../schemas/index.js';

const r = createApiRouter('/api/networks', { tag: 'networks' });

// Compose writes either of these labels on the networks it manages
// (the precise key varies by compose version). We surface whichever
// is present as the network's `stack` for the UI to render.
const STACK_LABELS = [
  'com.docker.compose.project',
  'com.docker.stack.namespace',
];

function pickContainerName(names) {
  if (!Array.isArray(names) || names.length === 0) return '';
  const cleaned = names.map((n) => (n || '').replace(/^\//, '')).filter(Boolean);
  if (cleaned.length === 0) return '';
  cleaned.sort((a, b) => (a.length - b.length) || a.localeCompare(b));
  return cleaned[0];
}

/**
 * Map: network_name -> [{container_id, container_name, ipv4, ipv6, mac,
 * aliases}]. Built from one `listContainers({all: true})` call so the
 * cost is bounded regardless of how many networks the host has.
 *
 * Why listContainers and not network.inspect()?
 *   - inspect would be N HTTP calls (one per network).
 *   - the daemon's /containers/json includes NetworkSettings.Networks,
 *     which has everything we need.
 *   - the only field inspect carries that we'd want extra is the
 *     IPAMConfig requested aliases vs the runtime aliases; for the
 *     summary view, runtime aliases (from NetworkSettings) are what
 *     the operator actually wants to see.
 */
export function indexNetworkUsage(containers) {
  const out = new Map();
  for (const c of containers || []) {
    const networks = (c.NetworkSettings && c.NetworkSettings.Networks) || {};
    for (const [netName, ep] of Object.entries(networks)) {
      const list = out.get(netName) || [];
      list.push({
        container_id: c.Id,
        container_name: pickContainerName(c.Names),
        ipv4: ep.IPAddress || null,
        ipv6: ep.GlobalIPv6Address || null,
        mac: ep.MacAddress || null,
        aliases: Array.isArray(ep.Aliases) ? ep.Aliases : [],
      });
      out.set(netName, list);
    }
  }
  return out;
}

function stackOwner(labels) {
  for (const key of STACK_LABELS) {
    if (labels && labels[key]) return labels[key];
  }
  return null;
}

function normaliseIpamConfig(cfg) {
  if (!Array.isArray(cfg)) return [];
  return cfg.map((c) => ({
    subnet: c.Subnet || null,
    gateway: c.Gateway || null,
    ip_range: c.IPRange || null,
    aux_addresses: c.AuxiliaryAddresses || null,
  }));
}

/** Build the common summary shape used by both list and inspect. */
function buildSummary(n, usage) {
  const labels = n.Labels || {};
  const ipamConfig = normaliseIpamConfig(n.IPAM && n.IPAM.Config);
  const used = usage.get(n.Name) || [];
  return {
    id: n.Id,
    short_id: (n.Id || '').slice(0, 12),
    name: n.Name,
    driver: n.Driver,
    scope: n.Scope || '',
    internal: !!n.Internal,
    attachable: !!n.Attachable,
    enable_ipv6: !!n.EnableIPv6,
    created: n.Created || null,
    stack: stackOwner(labels),
    system: PREDEFINED_NETWORKS.has(n.Name),
    ipam_driver: (n.IPAM && n.IPAM.Driver) || 'default',
    subnets: ipamConfig.map((c) => c.subnet).filter(Boolean),
    gateways: ipamConfig.map((c) => c.gateway).filter(Boolean),
    in_use: used.length > 0,
    containers_count: used.length,
    used_by: used,
    labels,
  };
}

function buildDetail(n, usage) {
  const summary = buildSummary(n, usage);
  return {
    ...summary,
    ipam: {
      driver: (n.IPAM && n.IPAM.Driver) || 'default',
      options: (n.IPAM && n.IPAM.Options) || {},
      config: normaliseIpamConfig(n.IPAM && n.IPAM.Config),
    },
    options: n.Options || {},
    raw: n,
  };
}

// ---------- Schemas ----------

const IdParam = Type.Object(
  { id: Type.String({ minLength: 1, maxLength: 255 }) },
  { additionalProperties: false },
);

// ---------- List + Create ----------

r.get(
  '/',
  {
    summary: 'List networks (enriched: stack, subnets, attached containers, system flag)',
    responses: { 200: Type.Array(NetworkSummary) },
  },
  asyncHandler(async (_req, res) => {
    const docker = getClient();
    const [networks, containers] = await Promise.all([
      docker.listNetworks(),
      docker.listContainers({ all: true }),
    ]);
    const usage = indexNetworkUsage(containers);
    res.json((networks || []).map((n) => buildSummary(n, usage)));
  }),
);

r.post(
  '/',
  {
    summary: 'Create a network (full IPAM + driver options + labels)',
    admin: true,
    destructive: true,
    body: CreateNetworkRequest,
    responses: { 201: NetworkSummary },
  },
  asyncHandler(async (req, res) => {
    const b = req.body;

    // Refuse on the predefined names so the user gets a clean error
    // instead of a confusing "network with name 'host' already exists"
    // from the daemon. macvlan/ipvlan/overlay creation still works.
    if (PREDEFINED_NETWORKS.has(b.name)) {
      throw new HttpError(409, `'${b.name}' is a predefined daemon network; pick a different name`);
    }

    // Translate the snake_case IPAM spec into the PascalCase the
    // dockerode wire layer wants. We pass `undefined` for missing
    // pieces rather than empty arrays so the daemon doesn't see
    // "user asked for an empty IPAM config" and reject it.
    const ipam = b.ipam ? {
      Driver: b.ipam.driver || 'default',
      Options: b.ipam.options || undefined,
      Config: Array.isArray(b.ipam.config) && b.ipam.config.length
        ? b.ipam.config.map((c) => ({
            Subnet: c.subnet || undefined,
            Gateway: c.gateway || undefined,
            IPRange: c.ip_range || undefined,
            AuxiliaryAddresses: c.aux_addresses || undefined,
          }))
        : undefined,
    } : undefined;

    let n;
    try {
      n = await getClient().createNetwork({
        Name: b.name,
        Driver: b.driver || 'bridge',
        Internal: !!b.internal,
        Attachable: b.attachable !== false, // schema default true
        EnableIPv6: !!b.enable_ipv6,
        IPAM: ipam,
        Options: b.driver_opts || undefined,
        Labels: b.labels || {},
        CheckDuplicate: true,
      });
    } catch (err) {
      // Daemon-side IPAM conflicts (e.g. subnet overlaps an existing
      // network) come back as 403; surface as 409 so the SPA can
      // distinguish "you asked for something invalid" from "auth".
      if (err.statusCode === 403) {
        throw new HttpError(409, err.message || 'IPAM conflict (subnet may overlap an existing network)');
      }
      throw err;
    }

    // Brand-new networks can't have containers attached yet, and IPAM
    // shows up immediately in the inspect, so skip the listContainers
    // re-enrichment we'd need otherwise.
    const inspected = await n.inspect();
    res.status(201).json(buildSummary(inspected, new Map()));
  }),
);

// ---------- Prune ----------

r.post(
  '/prune',
  {
    summary: 'Prune unused networks',
    admin: true,
    destructive: true,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (_req, res) => res.json(await getClient().pruneNetworks())),
);

// ---------- Bulk delete ----------
//
// Multi-select on the list. Per-item failures (predefined, in-use,
// not-found) come back in `results` so the UI can render a row-by-row
// report. We never fail the whole request because one network was busy.
r.post(
  '/delete/bulk',
  {
    summary: 'Delete many networks at once (multi-select)',
    admin: true,
    destructive: true,
    body: NetworkBulkDeleteRequest,
    responses: { 200: NetworkBulkResponse },
  },
  asyncHandler(async (req, res) => {
    const ids = req.body.ids;

    async function deleteOne(id) {
      // We have to inspect first to find the network's NAME so we can
      // honour the predefined-set refusal even when the user passed an
      // ID (the predefined set is keyed by name). Best-effort: if
      // inspect 404s, let the daemon's remove return 404 too.
      try {
        const meta = await getClient().getNetwork(id).inspect();
        if (PREDEFINED_NETWORKS.has(meta.Name)) {
          return { id, ok: false, error: `Predefined network '${meta.Name}' cannot be removed` };
        }
      } catch { /* fall through to remove */ }

      try {
        await getClient().getNetwork(id).remove();
        return { id, ok: true };
      } catch (err) {
        if (err.statusCode === 404) return { id, ok: false, error: 'Not found' };
        if (err.statusCode === 403) {
          return { id, ok: false, error: 'Network is in use (disconnect attached containers first)' };
        }
        return { id, ok: false, error: err.message || 'unknown error' };
      }
    }

    const CONCURRENCY = 5;
    const results = new Array(ids.length);
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const slice = ids.slice(i, i + CONCURRENCY);
      const out = await Promise.all(slice.map(deleteOne));
      for (let j = 0; j < out.length; j++) results[i + j] = out[j];
    }
    res.json({
      succeeded: results.filter((x) => x.ok).length,
      failed: results.filter((x) => !x.ok).length,
      results,
    });
  }),
);

// ---------- Inspect ----------

r.get(
  '/:id',
  {
    summary: 'Inspect a network (normalised NetworkDetail shape)',
    params: IdParam,
    responses: { 200: NetworkDetail },
  },
  asyncHandler(async (req, res) => {
    const docker = getClient();
    let n;
    try {
      n = await docker.getNetwork(req.params.id).inspect();
    } catch (err) {
      if (err.statusCode === 404) throw new HttpError(404, 'Network not found');
      throw err;
    }
    // inspect() already includes the Containers map, but we re-resolve
    // names from listContainers because inspect's `Containers[id].Name`
    // can lag for very-recently-started containers.
    const containers = await docker.listContainers({ all: true });
    res.json(buildDetail(n, indexNetworkUsage(containers)));
  }),
);

// ---------- Remove (single) ----------

r.delete(
  '/:id',
  {
    summary: 'Remove a network (refuses predefined networks; 409 if in use)',
    admin: true,
    destructive: true,
    params: IdParam,
    responses: { 200: Type.Object({ removed: Type.String() }) },
  },
  asyncHandler(async (req, res) => {
    // Inspect first to catch the predefined set before the daemon
    // emits an unhelpful 403. We accept either an ID or a name in
    // :id, and inspect handles both.
    let meta;
    try {
      meta = await getClient().getNetwork(req.params.id).inspect();
    } catch (err) {
      if (err.statusCode === 404) throw new HttpError(404, 'Network not found');
      throw err;
    }
    if (PREDEFINED_NETWORKS.has(meta.Name)) {
      throw new HttpError(409, `'${meta.Name}' is a predefined daemon network and cannot be removed`);
    }
    try {
      await getClient().getNetwork(req.params.id).remove();
    } catch (err) {
      if (err.statusCode === 403) {
        // Docker returns 403 "network is in use" — translate to 409
        // so the SPA can branch on it cleanly (the meaning is "conflict
        // with current state", not "auth failure").
        throw new HttpError(409, 'Network is in use — disconnect attached containers first');
      }
      throw err;
    }
    res.json({ removed: req.params.id });
  }),
);

// ---------- Connect / Disconnect ----------

r.post(
  '/:id/connect',
  {
    summary: 'Connect a container to a network (full endpoint config)',
    admin: true,
    destructive: true,
    params: IdParam,
    body: ConnectRequest,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (req, res) => {
    const b = req.body;
    const ipamConfig = (b.ipv4_address || b.ipv6_address) ? {
      IPv4Address: b.ipv4_address || undefined,
      IPv6Address: b.ipv6_address || undefined,
    } : undefined;
    try {
      await getClient().getNetwork(req.params.id).connect({
        Container: b.container,
        EndpointConfig: {
          Aliases: b.aliases && b.aliases.length ? b.aliases : undefined,
          Links: b.links && b.links.length ? b.links : undefined,
          MacAddress: b.mac_address || undefined,
          DriverOpts: b.driver_opts || undefined,
          IPAMConfig: ipamConfig,
        },
      });
    } catch (err) {
      // Docker uses 403 for "container already on this network" and
      // "incompatible network mode" both. The message is descriptive,
      // so pass it through with 409.
      if (err.statusCode === 403) {
        throw new HttpError(409, err.message || 'Cannot connect (already attached or incompatible)');
      }
      if (err.statusCode === 404) throw new HttpError(404, err.message || 'Network or container not found');
      throw err;
    }
    res.json({ network: req.params.id, container: b.container, connected: true });
  }),
);

r.post(
  '/:id/disconnect',
  {
    summary: 'Disconnect a container from a network (force option for stuck endpoints)',
    admin: true,
    destructive: true,
    params: IdParam,
    body: DisconnectRequest,
    responses: { 200: PassThroughObject },
  },
  asyncHandler(async (req, res) => {
    const b = req.body;
    try {
      await getClient().getNetwork(req.params.id).disconnect({
        Container: b.container,
        Force: !!b.force,
      });
    } catch (err) {
      if (err.statusCode === 403) {
        throw new HttpError(409, err.message || 'Cannot disconnect (try force=true if the container is stuck)');
      }
      if (err.statusCode === 404) throw new HttpError(404, err.message || 'Network or container not found');
      throw err;
    }
    res.json({ network: req.params.id, container: b.container, disconnected: true });
  }),
);

// Visible-for-testing only.
export const _internals = { indexNetworkUsage, stackOwner, normaliseIpamConfig, buildSummary, buildDetail };

export default r;
