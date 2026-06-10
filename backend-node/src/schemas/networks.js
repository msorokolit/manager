import { Type } from '@sinclair/typebox';
import { Opt, StringEnum } from './_common.js';

// User-pickable drivers. The "predefined" set (host, none, null) is
// owned by the daemon — you can attach to them but you can't create a
// new instance, so they're not in this list. macvlan/ipvlan/overlay
// stay because operators with the right host config legitimately want
// to create them.
export const NETWORK_DRIVERS = ['bridge', 'overlay', 'macvlan', 'ipvlan'];

// Predefined networks the daemon owns: `bridge` (default), `host`,
// `none`, and (on swarm hosts) `ingress`. The UI should not offer a
// Remove button for these; the backend also surfaces a friendly 409
// when an admin tries to delete one through the API directly.
export const PREDEFINED_NETWORKS = new Set(['bridge', 'host', 'none', 'ingress']);

// ---------- IPAM ----------
//
// IPAM (IP Address Management) is how Docker assigns addresses to
// containers attached to a network. Each network can have multiple IPAM
// configs (one IPv4 + one IPv6, typically). Portainer exposes all four
// per-config fields; we accept the same shape and pass it through.
export const IpamConfigEntry = Type.Object(
  {
    subnet: Opt(Type.String({ description: 'CIDR, e.g. 172.20.0.0/16 or 2001:db8::/64' })),
    gateway: Opt(Type.String({ description: 'Default gateway for the subnet' })),
    ip_range: Opt(Type.String({ description: 'Range Docker may allocate from (subset of subnet)' })),
    aux_addresses: Opt(Type.Record(Type.String(), Type.String(), {
      description: 'Reserved name -> address mappings (e.g. {"router": "172.20.0.1"})',
    })),
  },
  { $id: 'IpamConfigEntry', additionalProperties: false },
);

export const IpamSpec = Type.Object(
  {
    driver: Opt(Type.String({ default: 'default', maxLength: 64 })),
    options: Opt(Type.Record(Type.String(), Type.String())),
    config: Opt(Type.Array(IpamConfigEntry, { maxItems: 16 })),
  },
  { $id: 'IpamSpec', additionalProperties: false },
);

// ---------- Create ----------

export const CreateNetworkRequest = Type.Object(
  {
    name: Type.String({
      minLength: 1, maxLength: 255,
      // Docker's accepted set for network names is the same as for other
      // resources: alphanumerics + `_.-`, leading must be alphanumeric.
      pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.-]*$',
    }),
    driver: Type.Optional(Type.String({ maxLength: 64, default: 'bridge' })),
    internal: Type.Optional(Type.Boolean({ default: false })),
    attachable: Type.Optional(Type.Boolean({ default: true })),
    enable_ipv6: Type.Optional(Type.Boolean({ default: false })),
    driver_opts: Opt(Type.Record(Type.String(), Type.String())),
    ipam: Opt(IpamSpec),
    labels: Opt(Type.Record(Type.String(), Type.String())),
  },
  { $id: 'CreateNetworkRequest', additionalProperties: false },
);

// ---------- Connect / Disconnect ----------

export const ConnectRequest = Type.Object(
  {
    container: Type.String({ minLength: 1, maxLength: 128 }),
    aliases: Opt(Type.Array(Type.String({ maxLength: 255 }), { maxItems: 64 })),
    ipv4_address: Opt(Type.String({ maxLength: 45 })),
    ipv6_address: Opt(Type.String({ maxLength: 45 })),
    mac_address: Opt(Type.String({
      // Liberal regex — Docker accepts both colon- and dash-separated
      // and re-formats internally.
      pattern: '^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$',
      maxLength: 17,
      description: 'MAC address (e.g. 02:42:ac:11:00:02)',
    })),
    links: Opt(Type.Array(Type.String({ maxLength: 255 }), { maxItems: 64 })),
    driver_opts: Opt(Type.Record(Type.String(), Type.String())),
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

// ---------- Enrichment + summary ----------

// One per-container row in the network list / inspect. Mirrors what
// Docker's `network.inspect().Containers[id]` returns, but normalised
// to snake_case + includes the aliases the user gave on connect.
export const NetworkUsage = Type.Object(
  {
    container_id: Type.String(),
    container_name: Type.String(),
    ipv4: Opt(Type.String()),
    ipv6: Opt(Type.String()),
    mac: Opt(Type.String()),
    aliases: Type.Array(Type.String()),
  },
  { $id: 'NetworkUsage', additionalProperties: false },
);

// Portainer-style enriched summary. Most of these fields don't come
// from `docker network ls` (only inspect has Containers + IPAM
// details), so we cross-reference listContainers + the per-row IPAM
// from listNetworks itself, which does carry the subnet config.
export const NetworkSummary = Type.Object(
  {
    id: Type.String(),
    short_id: Type.String(),
    name: Type.String(),
    driver: Type.String(),
    scope: Type.String(),
    internal: Type.Boolean(),
    attachable: Type.Boolean(),
    enable_ipv6: Type.Boolean(),
    created: Opt(Type.String({ description: 'Network CreatedAt (ISO 8601)' })),
    // Portainer-parity enrichment ----------
    stack: Opt(Type.String({
      description: 'Owning compose project from com.docker.compose.network label',
    })),
    // The daemon-owned set (bridge, host, none, ingress) — undeletable.
    system: Type.Boolean({
      description: 'True for predefined / daemon-owned networks the user cannot remove',
    }),
    ipam_driver: Type.String(),
    subnets: Type.Array(Type.String(), {
      description: 'Flattened list of IPAM subnets, easy to render in a single cell',
    }),
    gateways: Type.Array(Type.String()),
    in_use: Type.Boolean(),
    containers_count: Type.Integer(),
    used_by: Type.Array(NetworkUsage, {
      description: 'Containers currently attached + their per-endpoint IP/MAC/aliases',
    }),
    labels: Type.Record(Type.String(), Type.String()),
  },
  { $id: 'NetworkSummary', additionalProperties: false },
);

// Inspect response: NetworkSummary + the full IPAM payload + the
// driver-specific options + the verbatim daemon inspect payload under
// `raw` (mirrors VolumeDetail's pattern).
export const NetworkDetail = Type.Object(
  {
    id: Type.String(),
    short_id: Type.String(),
    name: Type.String(),
    driver: Type.String(),
    scope: Type.String(),
    internal: Type.Boolean(),
    attachable: Type.Boolean(),
    enable_ipv6: Type.Boolean(),
    created: Opt(Type.String()),
    stack: Opt(Type.String()),
    system: Type.Boolean(),
    ipam_driver: Type.String(),
    subnets: Type.Array(Type.String()),
    gateways: Type.Array(Type.String()),
    in_use: Type.Boolean(),
    containers_count: Type.Integer(),
    used_by: Type.Array(NetworkUsage),
    labels: Type.Record(Type.String(), Type.String()),
    // Full IPAM config (incl. ip_range + aux_addresses), driver
    // options, and the raw daemon payload for the Raw tab.
    ipam: IpamSpec,
    options: Type.Record(Type.String(), Type.String()),
    raw: Type.Unsafe({ type: 'object', additionalProperties: true }),
  },
  { $id: 'NetworkDetail', additionalProperties: false },
);

// ---------- Bulk delete ----------

export const NetworkBulkDeleteRequest = Type.Object(
  {
    // Network IDs or names; the daemon accepts either on remove.
    ids: Type.Array(Type.String({ minLength: 1, maxLength: 255 }), {
      minItems: 1, maxItems: 500,
    }),
  },
  { $id: 'NetworkBulkDeleteRequest', additionalProperties: false },
);

export const NetworkBulkResult = Type.Object(
  {
    id: Type.String(),
    ok: Type.Boolean(),
    error: Opt(Type.String()),
  },
  { additionalProperties: false },
);

export const NetworkBulkResponse = Type.Object(
  {
    succeeded: Type.Integer(),
    failed: Type.Integer(),
    results: Type.Array(NetworkBulkResult),
  },
  { $id: 'NetworkBulkResponse', additionalProperties: false },
);
