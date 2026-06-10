// Integration tests for the network HTTP layer.
//
// Mocks dockerode and drives the network router through supertest. We
// can't unit-test the dockerode wire format without a daemon, but we
// can fully cover:
//
//   - list enrichment (subnets/gateways flattened, system flag,
//     stack from compose labels, containers cross-referenced from
//     listContainers)
//   - inspect returns the NetworkDetail shape with raw payload
//   - create rejects predefined-network names (#parity bug: previously
//     the daemon's "name exists" was confusing)
//   - create translates IPAM snake_case -> PascalCase
//   - DELETE refuses predefined networks with 409 (clear message,
//     not the daemon's 403)
//   - DELETE maps daemon 403 (network in use) to HTTP 409
//   - bulk delete returns per-item results + admin gating + force flag
//     parity
//   - connect / disconnect routes through to the right dockerode call
//   - viewer JWT can list + inspect but not mutate
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { signToken } from '../src/jwt.js';

// ---------- Shared fakes ----------

const fakeNetworks = new Map();       // id -> network body
const fakeContainers = [];            // listContainers({all:true}) returns this
const removeMock = vi.fn();           // returns '403'/'404' to simulate daemon
const createMock = vi.fn();           // captures createNetwork opts
const connectMock = vi.fn();          // captures connect call args
const disconnectMock = vi.fn();       // captures disconnect call args
const pruneMock = vi.fn(async () => ({ NetworksDeleted: [], SpaceReclaimed: 0 }));

function makeNetwork(name, opts = {}) {
  return {
    Id: opts.id || `id-${name}`,
    Name: name,
    Driver: opts.driver || 'bridge',
    Scope: opts.scope || 'local',
    Internal: !!opts.internal,
    Attachable: opts.attachable !== false,
    EnableIPv6: !!opts.enable_ipv6,
    Created: opts.created || '2026-06-10T12:00:00Z',
    IPAM: opts.ipam || {
      Driver: 'default',
      Options: {},
      Config: [{ Subnet: '172.20.0.0/16', Gateway: '172.20.0.1' }],
    },
    Options: opts.options || {},
    Labels: opts.labels || {},
    // Note: `listNetworks` doesn't actually return Containers; inspect
    // does. We don't rely on it (we cross-reference listContainers).
    Containers: opts.containers || {},
  };
}

vi.mock('../src/docker-client.js', () => {
  const client = {
    listNetworks: async () => [...fakeNetworks.values()],
    listContainers: async () => fakeContainers,
    createNetwork: async (opts) => {
      createMock(opts);
      const id = `id-${opts.Name}`;
      fakeNetworks.set(id, makeNetwork(opts.Name, {
        id, driver: opts.Driver, internal: opts.Internal,
        attachable: opts.Attachable, enable_ipv6: opts.EnableIPv6,
        ipam: opts.IPAM
          ? { Driver: opts.IPAM.Driver, Options: opts.IPAM.Options || {}, Config: opts.IPAM.Config || [] }
          : undefined,
        options: opts.Options || {}, labels: opts.Labels || {},
      }));
      // dockerode returns a network handle; we only need .inspect() on it.
      return { inspect: async () => fakeNetworks.get(id) };
    },
    pruneNetworks: pruneMock,
    getNetwork(id) {
      // Accept either ID or name lookups (the route uses both at
      // different points). Name lookups are how PREDEFINED_NETWORKS
      // refusal works for ID-based deletes — the route calls inspect
      // first to learn the name.
      const findByIdOrName = () => {
        if (fakeNetworks.has(id)) return fakeNetworks.get(id);
        for (const n of fakeNetworks.values()) if (n.Name === id) return n;
        return null;
      };
      return {
        inspect: async () => {
          const n = findByIdOrName();
          if (!n) { const e = new Error('not found'); e.statusCode = 404; throw e; }
          return n;
        },
        remove: async () => {
          const n = findByIdOrName();
          if (!n) { const e = new Error('not found'); e.statusCode = 404; throw e; }
          const r = removeMock(n.Name);
          if (r === '403') { const e = new Error('network is in use'); e.statusCode = 403; throw e; }
          // Use the network's actual id key so name-based delete works.
          fakeNetworks.delete(n.Id);
          return {};
        },
        connect: async (opts) => { connectMock(id, opts); return {}; },
        disconnect: async (opts) => { disconnectMock(id, opts); return {}; },
      };
    },
  };
  return {
    getClient: () => client,
    dockerError: (e) => ({ status: e.statusCode || 500, detail: e.message || 'docker error' }),
  };
});

// Routes import AFTER the mock registration.
const { default: networksApi } = await import('../src/routes/networks.js');
const { sendError } = await import('../src/util.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(networksApi.basePath, networksApi.router);
  app.use((err, _req, res, _next) => sendError(res, err));
  return app;
}

function withRole(role) {
  return `Bearer ${signToken({ sub: role, role }).token}`;
}

beforeEach(() => {
  fakeNetworks.clear();
  fakeContainers.length = 0;
  removeMock.mockReset();
  removeMock.mockReturnValue(null);
  createMock.mockReset();
  connectMock.mockReset();
  disconnectMock.mockReset();
  pruneMock.mockReset();
  pruneMock.mockResolvedValue({ NetworksDeleted: [], SpaceReclaimed: 0 });
});

// ---------- /api/networks (list) ----------

describe('GET /api/networks', () => {
  it('flags predefined networks as system: true and surfaces enrichment', async () => {
    fakeNetworks.set('id-bridge', makeNetwork('bridge'));
    fakeNetworks.set('id-host', makeNetwork('host', { driver: 'host', ipam: { Driver: 'default', Config: [] } }));
    fakeNetworks.set('id-my-app', makeNetwork('my-app', {
      labels: { 'com.docker.compose.project': 'my-app' },
      ipam: {
        Driver: 'default',
        Config: [
          { Subnet: '172.20.0.0/16', Gateway: '172.20.0.1' },
          { Subnet: '2001:db8::/64', Gateway: '2001:db8::1' },
        ],
      },
      enable_ipv6: true,
    }));
    fakeContainers.push({
      Id: 'cid-web', Names: ['/web-1'],
      NetworkSettings: { Networks: {
        'my-app': {
          NetworkID: 'id-my-app', IPAddress: '172.20.0.2',
          GlobalIPv6Address: '2001:db8::2', MacAddress: '02:42:ac:14:00:02',
          Aliases: ['web'],
        },
      } },
    });

    const r = await request(buildApp())
      .get('/api/networks')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(200);

    const byName = Object.fromEntries(r.body.map((n) => [n.name, n]));
    expect(byName.bridge.system).toBe(true);
    expect(byName.host.system).toBe(true);
    expect(byName['my-app']).toMatchObject({
      system: false,
      stack: 'my-app',
      enable_ipv6: true,
      ipam_driver: 'default',
      subnets: ['172.20.0.0/16', '2001:db8::/64'],
      gateways: ['172.20.0.1', '2001:db8::1'],
      in_use: true,
      containers_count: 1,
    });
    expect(byName['my-app'].used_by).toEqual([{
      container_id: 'cid-web',
      container_name: 'web-1',
      ipv4: '172.20.0.2',
      ipv6: '2001:db8::2',
      mac: '02:42:ac:14:00:02',
      aliases: ['web'],
    }]);
  });

  it('returns the daemon-default IPAM driver when not set', async () => {
    fakeNetworks.set('id-x', makeNetwork('x', { ipam: { Config: [] } }));
    const r = await request(buildApp())
      .get('/api/networks')
      .set('Authorization', withRole('viewer'));
    expect(r.body[0].ipam_driver).toBe('default');
    expect(r.body[0].subnets).toEqual([]);
  });
});

// ---------- POST /api/networks (create) ----------

describe('POST /api/networks', () => {
  it('translates snake_case IPAM into PascalCase for dockerode', async () => {
    const r = await request(buildApp())
      .post('/api/networks')
      .set('Authorization', withRole('admin'))
      .send({
        name: 'tier-1',
        driver: 'bridge',
        internal: true,
        enable_ipv6: true,
        driver_opts: { foo: 'bar' },
        ipam: {
          driver: 'default',
          options: { ip_masq: 'true' },
          config: [
            { subnet: '172.20.0.0/16', gateway: '172.20.0.1', ip_range: '172.20.10.0/24',
              aux_addresses: { router: '172.20.0.1' } },
          ],
        },
        labels: { tier: 'prod' },
      });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      name: 'tier-1', stack: null, system: false,
      subnets: ['172.20.0.0/16'], gateways: ['172.20.0.1'],
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    const opts = createMock.mock.calls[0][0];
    expect(opts).toMatchObject({
      Name: 'tier-1', Driver: 'bridge', Internal: true,
      EnableIPv6: true, Options: { foo: 'bar' },
      Labels: { tier: 'prod' },
    });
    expect(opts.IPAM).toMatchObject({
      Driver: 'default',
      Options: { ip_masq: 'true' },
      Config: [{
        Subnet: '172.20.0.0/16', Gateway: '172.20.0.1',
        IPRange: '172.20.10.0/24',
        AuxiliaryAddresses: { router: '172.20.0.1' },
      }],
    });
  });

  it('refuses predefined network names with 409', async () => {
    for (const name of ['bridge', 'host', 'none', 'ingress']) {
      const r = await request(buildApp())
        .post('/api/networks')
        .set('Authorization', withRole('admin'))
        .send({ name });
      expect(r.status).toBe(409);
      expect(r.body.detail).toMatch(/predefined/i);
    }
    expect(createMock).not.toHaveBeenCalled();
  });

  it('viewer role is forbidden', async () => {
    const r = await request(buildApp())
      .post('/api/networks')
      .set('Authorization', withRole('viewer'))
      .send({ name: 'x' });
    expect(r.status).toBe(403);
  });

  it('rejects bad name with 400 from the validator', async () => {
    const r = await request(buildApp())
      .post('/api/networks')
      .set('Authorization', withRole('admin'))
      .send({ name: 'has space' });
    expect(r.status).toBe(400);
  });
});

// ---------- GET /api/networks/:id (inspect) ----------

describe('GET /api/networks/:id (inspect)', () => {
  it('returns the NetworkDetail shape with ipam, options, and raw', async () => {
    fakeNetworks.set('id-x', makeNetwork('x', {
      options: { 'com.docker.network.bridge.name': 'br-x' },
      ipam: {
        Driver: 'default',
        Options: { foo: 'bar' },
        Config: [{ Subnet: '10.0.0.0/24', Gateway: '10.0.0.1' }],
      },
    }));
    const r = await request(buildApp())
      .get('/api/networks/id-x')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: 'id-x', name: 'x',
      ipam: {
        driver: 'default',
        options: { foo: 'bar' },
        config: [{ subnet: '10.0.0.0/24', gateway: '10.0.0.1' }],
      },
      options: { 'com.docker.network.bridge.name': 'br-x' },
      raw: { Name: 'x' },
    });
  });

  it('returns 404 when the network is missing', async () => {
    const r = await request(buildApp())
      .get('/api/networks/nope')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(404);
  });
});

// ---------- DELETE /api/networks/:id ----------

describe('DELETE /api/networks/:id', () => {
  it('refuses predefined networks with 409 (without calling daemon.remove)', async () => {
    fakeNetworks.set('id-host', makeNetwork('host'));
    const r = await request(buildApp())
      .delete('/api/networks/id-host')
      .set('Authorization', withRole('admin'));
    expect(r.status).toBe(409);
    expect(r.body.detail).toMatch(/predefined/i);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('also refuses predefined networks looked up by name', async () => {
    fakeNetworks.set('id-bridge', makeNetwork('bridge'));
    const r = await request(buildApp())
      .delete('/api/networks/bridge')
      .set('Authorization', withRole('admin'));
    expect(r.status).toBe(409);
  });

  it('maps daemon 403 (in use) to HTTP 409', async () => {
    fakeNetworks.set('id-x', makeNetwork('x'));
    removeMock.mockReturnValue('403');
    const r = await request(buildApp())
      .delete('/api/networks/id-x')
      .set('Authorization', withRole('admin'));
    expect(r.status).toBe(409);
    expect(r.body.detail).toMatch(/in use/i);
  });

  it('viewer role is forbidden', async () => {
    fakeNetworks.set('id-x', makeNetwork('x'));
    const r = await request(buildApp())
      .delete('/api/networks/id-x')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(403);
  });
});

// ---------- POST /api/networks/delete/bulk ----------

describe('POST /api/networks/delete/bulk', () => {
  it('surfaces per-item results (predefined / 404 / 409 / ok mixed)', async () => {
    fakeNetworks.set('id-a', makeNetwork('a'));
    fakeNetworks.set('id-b', makeNetwork('b'));
    fakeNetworks.set('id-bridge', makeNetwork('bridge'));
    // 'a' deletes fine; 'b' is in-use; 'bridge' is predefined;
    // 'nope' doesn't exist.
    removeMock.mockImplementation((name) => name === 'b' ? '403' : null);

    const r = await request(buildApp())
      .post('/api/networks/delete/bulk')
      .set('Authorization', withRole('admin'))
      .send({ ids: ['id-a', 'id-b', 'id-bridge', 'nope'] });

    expect(r.status).toBe(200);
    expect(r.body.succeeded).toBe(1);
    expect(r.body.failed).toBe(3);
    const m = Object.fromEntries(r.body.results.map((r) => [r.id, r]));
    expect(m['id-a'].ok).toBe(true);
    expect(m['id-b']).toMatchObject({ ok: false, error: expect.stringMatching(/in use/i) });
    expect(m['id-bridge']).toMatchObject({ ok: false, error: expect.stringMatching(/predefined/i) });
    expect(m['nope']).toMatchObject({ ok: false, error: 'Not found' });
  });

  it('viewer role is forbidden', async () => {
    const r = await request(buildApp())
      .post('/api/networks/delete/bulk')
      .set('Authorization', withRole('viewer'))
      .send({ ids: ['x'] });
    expect(r.status).toBe(403);
  });

  it('rejects empty / oversized ids[]', async () => {
    const a = await request(buildApp())
      .post('/api/networks/delete/bulk')
      .set('Authorization', withRole('admin'))
      .send({ ids: [] });
    expect(a.status).toBe(400);
    const b = await request(buildApp())
      .post('/api/networks/delete/bulk')
      .set('Authorization', withRole('admin'))
      .send({ ids: Array.from({ length: 501 }, (_, i) => `n${i}`) });
    expect(b.status).toBe(400);
  });
});

// ---------- Connect / Disconnect ----------

describe('POST /api/networks/:id/connect', () => {
  it('passes the full endpoint config (aliases, IPv4/6, MAC, links, opts)', async () => {
    fakeNetworks.set('id-x', makeNetwork('x'));
    const r = await request(buildApp())
      .post('/api/networks/id-x/connect')
      .set('Authorization', withRole('admin'))
      .send({
        container: 'cid', aliases: ['db'], ipv4_address: '172.20.0.10',
        ipv6_address: '2001:db8::10', mac_address: '02:42:ac:11:00:02',
        links: ['cache:redis'], driver_opts: { foo: 'bar' },
      });
    expect(r.status).toBe(200);
    const [, opts] = connectMock.mock.calls[0];
    expect(opts).toMatchObject({
      Container: 'cid',
      EndpointConfig: {
        Aliases: ['db'], Links: ['cache:redis'],
        MacAddress: '02:42:ac:11:00:02',
        DriverOpts: { foo: 'bar' },
        IPAMConfig: { IPv4Address: '172.20.0.10', IPv6Address: '2001:db8::10' },
      },
    });
  });

  it('omits empty arrays / undefined fields rather than sending []', async () => {
    fakeNetworks.set('id-x', makeNetwork('x'));
    await request(buildApp())
      .post('/api/networks/id-x/connect')
      .set('Authorization', withRole('admin'))
      .send({ container: 'cid' });
    const [, opts] = connectMock.mock.calls[0];
    expect(opts.EndpointConfig.Aliases).toBeUndefined();
    expect(opts.EndpointConfig.Links).toBeUndefined();
    expect(opts.EndpointConfig.MacAddress).toBeUndefined();
    expect(opts.EndpointConfig.IPAMConfig).toBeUndefined();
  });
});

describe('POST /api/networks/:id/disconnect', () => {
  it('passes force flag through', async () => {
    fakeNetworks.set('id-x', makeNetwork('x'));
    await request(buildApp())
      .post('/api/networks/id-x/disconnect')
      .set('Authorization', withRole('admin'))
      .send({ container: 'cid', force: true });
    const [, opts] = disconnectMock.mock.calls[0];
    expect(opts).toEqual({ Container: 'cid', Force: true });
  });

  it('defaults force to false', async () => {
    fakeNetworks.set('id-x', makeNetwork('x'));
    await request(buildApp())
      .post('/api/networks/id-x/disconnect')
      .set('Authorization', withRole('admin'))
      .send({ container: 'cid' });
    expect(disconnectMock.mock.calls[0][1]).toEqual({ Container: 'cid', Force: false });
  });

  it('viewer is forbidden', async () => {
    const r = await request(buildApp())
      .post('/api/networks/id-x/disconnect')
      .set('Authorization', withRole('viewer'))
      .send({ container: 'cid' });
    expect(r.status).toBe(403);
  });
});
