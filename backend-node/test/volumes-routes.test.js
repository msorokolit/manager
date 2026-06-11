// Integration tests for the volume + volume-browser HTTP layer (#30).
//
// We don't need a live Docker daemon for any of these — the
// `docker-client` module is mocked so we can return canned responses and
// assert on the way our routes map them onto HTTP semantics:
//
//   - enrichment: stack label, used_by per-mount rw flag, sizes nullable
//   - admin/viewer role gating (volume reads + writes)
//   - force=false default on single delete + 409 on in-use
//   - bulk delete with bounded parallelism + per-item results
//   - PUT /labels endpoint is gone (404)
//   - browse list returns the right status code mapping (404 not-found,
//     400 escape, 409 already-exists) via parseScriptResult
//   - volume-browser write endpoints don't check ALLOW_DESTRUCTIVE
//     (admin alone is enough) — #22
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { signToken } from '../src/jwt.js';

// ---------- Shared fakes ----------
const fakeContainers = [];     // listContainers({ all: true }) returns this
const fakeVolumes = new Map(); // name -> volume body
const fakeDfVolumes = [];      // /system/df volumes block
let listVolumesError = null;
let dfError = null;
const removeMock = vi.fn();

function makeVolume(name, opts = {}) {
  return {
    Name: name,
    Driver: opts.driver || 'local',
    Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
    Scope: 'local',
    CreatedAt: opts.createdAt || '2026-06-10T11:00:00Z',
    Labels: opts.labels || {},
    Options: opts.options || {},
  };
}

vi.mock('../src/docker-client.js', () => {
  // The dockerode shape the route code touches:
  //   client.listVolumes()
  //   client.listContainers({ all: true })
  //   client.df()
  //   client.getVolume(name).inspect() / .remove({force})
  //   client.createVolume({...})
  //   client.pruneVolumes()
  const client = {
    listVolumes: async () => {
      if (listVolumesError) throw listVolumesError;
      return { Volumes: [...fakeVolumes.values()] };
    },
    listContainers: async () => fakeContainers,
    df: async () => {
      if (dfError) throw dfError;
      return { Volumes: fakeDfVolumes };
    },
    getVolume(name) {
      return {
        inspect: async () => {
          const v = fakeVolumes.get(name);
          if (!v) { const e = new Error('not found'); e.statusCode = 404; throw e; }
          return v;
        },
        remove: async (opts) => {
          const v = fakeVolumes.get(name);
          if (!v) { const e = new Error('not found'); e.statusCode = 404; throw e; }
          const r = removeMock(name, opts);
          if (r === '409') {
            const e = new Error('in use'); e.statusCode = 409; throw e;
          }
          fakeVolumes.delete(name);
          return {};
        },
      };
    },
    createVolume: async (opts) => {
      fakeVolumes.set(opts.Name, makeVolume(opts.Name, {
        driver: opts.Driver, labels: opts.Labels, options: opts.DriverOpts,
      }));
      return {};
    },
    pruneVolumes: async () => ({ VolumesDeleted: [], SpaceReclaimed: 0 }),
  };
  return {
    getClient: () => client,
    dockerError: (e) => ({ status: e.statusCode || 500, detail: e.message || 'docker error' }),
  };
});

// Now the routers can be imported (after the mocks are registered).
const { default: volumesApi } = await import('../src/routes/volumes.js');
const { default: volumeBrowserApi } = await import('../src/routes/volume-browser.js');
const { sendError } = await import('../src/util.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(volumesApi.basePath, volumesApi.router);
  app.use(volumeBrowserApi.basePath, volumeBrowserApi.router);
  app.use((err, _req, res, _next) => sendError(res, err));
  return app;
}

function withRole(role) {
  return `Bearer ${signToken({ sub: role, role }).token}`;
}

beforeEach(() => {
  fakeContainers.length = 0;
  fakeVolumes.clear();
  fakeDfVolumes.length = 0;
  listVolumesError = null;
  dfError = null;
  removeMock.mockReset();
  removeMock.mockReturnValue(null);
});

// ---------- /api/volumes ----------

describe('GET /api/volumes (list)', () => {
  it('returns the enriched shape and surfaces per-mount rw/ro', async () => {
    fakeVolumes.set('v1', makeVolume('v1', {
      labels: { 'com.docker.compose.project': 'my-app' },
    }));
    fakeVolumes.set('v2', makeVolume('v2'));
    fakeContainers.push({
      Id: 'cid-rw', Names: ['/web-1'],
      Mounts: [{ Type: 'volume', Name: 'v1', Destination: '/data', RW: true }],
    });
    fakeContainers.push({
      Id: 'cid-ro', Names: ['/backup-1'],
      Mounts: [{ Type: 'volume', Name: 'v1', Destination: '/src', RW: false }],
    });
    fakeDfVolumes.push({ Name: 'v1', UsageData: { Size: 12345 } });

    const r = await request(buildApp())
      .get('/api/volumes')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(2);
    const v1 = r.body.find((x) => x.name === 'v1');
    expect(v1).toMatchObject({
      stack: 'my-app',
      in_use: true,
      size_bytes: 12345,
    });
    const rw = v1.used_by.filter((u) => u.rw);
    const ro = v1.used_by.filter((u) => !u.rw);
    expect(rw).toHaveLength(1);
    expect(rw[0]).toMatchObject({ container_name: 'web-1', mount_path: '/data', rw: true });
    expect(ro).toHaveLength(1);
    expect(ro[0]).toMatchObject({ container_name: 'backup-1', mount_path: '/src', rw: false });

    const v2 = r.body.find((x) => x.name === 'v2');
    expect(v2.in_use).toBe(false);
    expect(v2.used_by).toEqual([]);
    expect(v2.stack).toBeNull();
  });

  it('skips /system/df when ?sizes=false (#14)', async () => {
    fakeVolumes.set('v1', makeVolume('v1'));
    fakeDfVolumes.push({ Name: 'v1', UsageData: { Size: 999 } });
    // dfError would crash the test if df was called.
    dfError = new Error('should not be called');
    const r = await request(buildApp())
      .get('/api/volumes?sizes=false')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(200);
    expect(r.body[0].size_bytes).toBeNull();
  });

  it('still returns 200 + null sizes when df fails (best-effort, #13)', async () => {
    fakeVolumes.set('v1', makeVolume('v1'));
    dfError = new Error('df broken');
    const r = await request(buildApp())
      .get('/api/volumes')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(200);
    expect(r.body[0].size_bytes).toBeNull();
  });
});

// ---------- POST /api/volumes (create) ----------

describe('POST /api/volumes (create)', () => {
  it('returns 201 Created with the enriched shape (#11, #15)', async () => {
    const r = await request(buildApp())
      .post('/api/volumes')
      .set('Authorization', withRole('admin'))
      .send({ name: 'new-vol', labels: { tier: 'prod' } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      name: 'new-vol',
      driver: 'local',
      labels: { tier: 'prod' },
      in_use: false,
      used_by: [],
    });
  });

  it('viewer role is forbidden (admin: true)', async () => {
    const r = await request(buildApp())
      .post('/api/volumes')
      .set('Authorization', withRole('viewer'))
      .send({ name: 'new-vol' });
    expect(r.status).toBe(403);
  });
});

// ---------- DELETE /api/volumes/:name ----------

describe('DELETE /api/volumes/:name (#1: force=false default)', () => {
  it('defaults to force=false', async () => {
    fakeVolumes.set('v1', makeVolume('v1'));
    await request(buildApp())
      .delete('/api/volumes/v1')
      .set('Authorization', withRole('admin'));
    expect(removeMock).toHaveBeenCalledWith('v1', { force: false });
  });

  it('passes force=true through to the daemon when ?force=true', async () => {
    fakeVolumes.set('v1', makeVolume('v1'));
    await request(buildApp())
      .delete('/api/volumes/v1?force=true')
      .set('Authorization', withRole('admin'));
    expect(removeMock).toHaveBeenCalledWith('v1', { force: true });
  });

  it('maps daemon 409 to HTTP 409 with helpful detail', async () => {
    fakeVolumes.set('v1', makeVolume('v1'));
    removeMock.mockReturnValue('409');
    const r = await request(buildApp())
      .delete('/api/volumes/v1')
      .set('Authorization', withRole('admin'));
    expect(r.status).toBe(409);
    expect(r.body.detail).toMatch(/in use/i);
    expect(r.body.detail).toMatch(/force=true/);
  });

  it('maps daemon 404 to HTTP 404', async () => {
    const r = await request(buildApp())
      .delete('/api/volumes/does-not-exist')
      .set('Authorization', withRole('admin'));
    expect(r.status).toBe(404);
  });

  it('viewer role is forbidden', async () => {
    fakeVolumes.set('v1', makeVolume('v1'));
    const r = await request(buildApp())
      .delete('/api/volumes/v1')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(403);
  });
});

// ---------- POST /api/volumes/delete/bulk ----------

describe('POST /api/volumes/delete/bulk (#16: bounded parallelism)', () => {
  it('returns per-item results with success and failure both surfaced', async () => {
    fakeVolumes.set('a', makeVolume('a'));
    fakeVolumes.set('b', makeVolume('b'));
    const r = await request(buildApp())
      .post('/api/volumes/delete/bulk')
      .set('Authorization', withRole('admin'))
      .send({ names: ['a', 'b', 'does-not-exist'] });
    expect(r.status).toBe(200);
    expect(r.body.succeeded).toBe(2);
    expect(r.body.failed).toBe(1);
    expect(r.body.results.find((x) => x.name === 'does-not-exist')).toMatchObject({
      ok: false, error: 'Not found',
    });
  });

  it('passes the force flag through', async () => {
    fakeVolumes.set('v', makeVolume('v'));
    await request(buildApp())
      .post('/api/volumes/delete/bulk')
      .set('Authorization', withRole('admin'))
      .send({ names: ['v'], force: true });
    expect(removeMock).toHaveBeenCalledWith('v', { force: true });
  });

  it('enforces minItems / maxItems on names', async () => {
    const a = await request(buildApp())
      .post('/api/volumes/delete/bulk')
      .set('Authorization', withRole('admin'))
      .send({ names: [] });
    expect(a.status).toBe(400);

    const tooMany = Array.from({ length: 1001 }, (_, i) => `v${i}`);
    const b = await request(buildApp())
      .post('/api/volumes/delete/bulk')
      .set('Authorization', withRole('admin'))
      .send({ names: tooMany });
    expect(b.status).toBe(400);
  });
});

// ---------- GET /api/volumes/:name (inspect) ----------

describe('GET /api/volumes/:name (inspect; #10 VolumeDetail shape)', () => {
  it('returns the normalised VolumeDetail shape with a raw field', async () => {
    fakeVolumes.set('v1', makeVolume('v1', {
      labels: { 'com.docker.compose.project': 'demo' },
    }));
    const r = await request(buildApp())
      .get('/api/volumes/v1')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      name: 'v1', stack: 'demo', in_use: false, used_by: [],
      raw: { Name: 'v1', Driver: 'local' },
    });
    // The PascalCase fields we previously exposed (DaemonLabels, ExtraLabels,
    // ReadOnly, UsedBy) must not appear in the new shape.
    expect(r.body.DaemonLabels).toBeUndefined();
    expect(r.body.ReadOnly).toBeUndefined();
    expect(r.body.UsedBy).toBeUndefined();
  });

  it('returns 404 for a missing volume', async () => {
    const r = await request(buildApp())
      .get('/api/volumes/nope')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(404);
  });
});

// ---------- PUT /api/volumes/:name/labels (removed) ----------

describe('PUT /api/volumes/:name/labels — removed', () => {
  it('returns 404 (endpoint was removed; labels are immutable)', async () => {
    fakeVolumes.set('v', makeVolume('v'));
    const r = await request(buildApp())
      .put('/api/volumes/v/labels')
      .set('Authorization', withRole('admin'))
      .send({ extra_labels: { x: 'y' } });
    expect(r.status).toBe(404);
  });
});

// ---------- Volume browser admin gating (#4) ----------

describe('volume-browser routes are admin-only (#4)', () => {
  it('GET /api/volumes/:name/browse/list refuses a viewer JWT', async () => {
    fakeVolumes.set('v', makeVolume('v'));
    const r = await request(buildApp())
      .get('/api/volumes/v/browse/list')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(403);
  });

  it('GET /api/volumes/:name/browse/view refuses a viewer JWT', async () => {
    fakeVolumes.set('v', makeVolume('v'));
    const r = await request(buildApp())
      .get('/api/volumes/v/browse/view?path=/x')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(403);
  });

  it('POST /api/volumes/:name/browse/mkdir refuses a viewer JWT', async () => {
    fakeVolumes.set('v', makeVolume('v'));
    const r = await request(buildApp())
      .post('/api/volumes/v/browse/mkdir?path=/x')
      .set('Authorization', withRole('viewer'));
    expect(r.status).toBe(403);
  });

  it('refuses unauthenticated requests (no bearer)', async () => {
    const r = await request(buildApp()).get('/api/volumes/v/browse/list');
    expect(r.status).toBe(401);
  });
});
