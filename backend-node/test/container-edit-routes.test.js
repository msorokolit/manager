// POST /api/containers/:id/update, /rename, /recreate.
//
// Mocks dockerode so we can:
//   - assert the snake_case → PascalCase translation lands on .update()
//   - assert /rename hits .rename() with the right name
//   - drive the streamed recreate flow through every branch
//     (success / compose-managed-refused / partial-failure)
//
// Streaming is captured by reading res.text from supertest — the
// recreate endpoint sends plain text, so test can split on \n and
// assert on per-step messages.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-container-edit';
  process.env.LOG_LEVEL = 'silent';
});

import { signToken } from '../src/jwt.js';
import { withRole, resetSessions } from './helpers/auth-helper.js';

// ---------- Fakes ----------
const fakeContainers = new Map();   // id → inspect body
const fakeNewContainerId = 'new-container-id-abcdef';
const updateMock = vi.fn();
const renameMock = vi.fn();
const stopMock = vi.fn();
const removeMock = vi.fn();
const createMock = vi.fn();
const startMock = vi.fn();
const pullMock = vi.fn();

function makeInspect(name, opts = {}) {
  return {
    Id: opts.id || `id-${name}`,
    Name: `/${name}`,
    Config: {
      Image: opts.image || 'nginx:latest',
      Labels: opts.labels || {},
      Env: opts.env || [],
      Cmd: opts.cmd || null,
    },
    HostConfig: {
      Memory: opts.memory || 0,
      RestartPolicy: opts.restart_policy ? { Name: opts.restart_policy } : { Name: 'no' },
    },
    NetworkSettings: { Networks: {} },
    State: { Running: !!opts.running, Status: opts.running ? 'running' : 'exited' },
    Created: '2026-06-11T12:00:00Z',
  };
}

vi.mock('../src/docker-client.js', () => {
  const client = {
    listContainers: async () => [],
    getContainer(id) {
      return {
        inspect: async () => {
          const c = fakeContainers.get(id);
          if (!c) { const e = new Error('not found'); e.statusCode = 404; throw e; }
          return c;
        },
        update: async (opts) => {
          updateMock(id, opts);
          if (!fakeContainers.has(id)) { const e = new Error('not found'); e.statusCode = 404; throw e; }
          return {};
        },
        rename: async (opts) => {
          renameMock(id, opts);
          if (!fakeContainers.has(id)) { const e = new Error('not found'); e.statusCode = 404; throw e; }
          // Simulate name collision: any name starting with 'taken-'
          // (still passes the schema regex) yields the same 409 the
          // daemon would emit when the name is in use.
          if (/^taken-/.test(opts.name)) { const e = new Error('name in use'); e.statusCode = 409; throw e; }
          // Mutate the in-place name so post-rename inspect reflects it.
          fakeContainers.get(id).Name = `/${opts.name}`;
          return {};
        },
        stop: async (opts) => {
          stopMock(id, opts);
          if (!fakeContainers.has(id)) { const e = new Error('not found'); e.statusCode = 404; throw e; }
          // Honour test-controlled outcomes via the mock impl.
          return {};
        },
        remove: async (opts) => {
          removeMock(id, opts);
          if (!fakeContainers.has(id)) { const e = new Error('not found'); e.statusCode = 404; throw e; }
          fakeContainers.delete(id);
          return {};
        },
        start: async () => { startMock(id); return {}; },
      };
    },
    createContainer: async (opts) => {
      createMock(opts);
      const newC = {
        id: fakeNewContainerId,
        inspect: async () => makeInspect(opts.name || 'new', { id: fakeNewContainerId, running: true }),
        start: async () => { startMock(fakeNewContainerId); return {}; },
      };
      fakeContainers.set(fakeNewContainerId, makeInspect(opts.name || 'new', { id: fakeNewContainerId, running: true }));
      return newC;
    },
    pull: (ref, cb) => { pullMock(ref); cb(null, { /* fake stream */ }); },
    modem: {
      followProgress: (_stream, cb) => cb(null),
    },
  };
  return {
    getClient: () => client,
    dockerError: (e) => ({ status: e.statusCode || 500, detail: e.message || 'docker error' }),
  };
});

const { default: containersApi } = await import('../src/routes/containers.js');
const { sendError } = await import('../src/util.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(containersApi.basePath, containersApi.router);
  app.use((err, _req, res, _next) => sendError(res, err));
  return app;
}

beforeEach(() => {
  resetSessions();
  fakeContainers.clear();
  updateMock.mockReset();
  renameMock.mockReset();
  stopMock.mockReset(); stopMock.mockResolvedValue({});
  removeMock.mockReset(); removeMock.mockResolvedValue({});
  createMock.mockReset();
  startMock.mockReset();
  pullMock.mockReset();
});

// ============================================================
// POST /:id/update — live cgroup tweaks
// ============================================================

describe('POST /api/containers/:id/update', () => {
  it('translates snake_case body to PascalCase HostConfig.update()', async () => {
    fakeContainers.set('c1', makeInspect('c1'));
    const r = await request(buildApp())
      .post('/api/containers/c1/update')
      .set('Authorization', withRole('admin'))
      .send({
        cpus: 1.5, mem_limit: '512m', restart_policy: 'unless-stopped',
        pids_limit: 200,
      });
    expect(r.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith('c1', {
      NanoCpus: 1_500_000_000,
      Memory: 512 * 1024 ** 2,
      PidsLimit: 200,
      RestartPolicy: { Name: 'unless-stopped' },
    });
  });

  it('400 when the body is empty (no fields to update)', async () => {
    fakeContainers.set('c1', makeInspect('c1'));
    const r = await request(buildApp())
      .post('/api/containers/c1/update')
      .set('Authorization', withRole('admin'))
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.detail).toMatch(/no live-update fields/i);
  });

  it('rejects unknown fields (additionalProperties: false)', async () => {
    fakeContainers.set('c1', makeInspect('c1'));
    const r = await request(buildApp())
      .post('/api/containers/c1/update')
      .set('Authorization', withRole('admin'))
      .send({ image: 'nginx:alpine' });  // can't change image live
    expect(r.status).toBe(400);
  });

  it('404 when the container is missing', async () => {
    const r = await request(buildApp())
      .post('/api/containers/missing/update')
      .set('Authorization', withRole('admin'))
      .send({ cpus: 1 });
    expect(r.status).toBe(404);
  });

  it('viewer JWT is 403', async () => {
    fakeContainers.set('c1', makeInspect('c1'));
    const r = await request(buildApp())
      .post('/api/containers/c1/update')
      .set('Authorization', withRole('viewer'))
      .send({ cpus: 1 });
    expect(r.status).toBe(403);
  });
});

// ============================================================
// POST /:id/rename
// ============================================================

describe('POST /api/containers/:id/rename', () => {
  it('hits dockerode .rename() with the validated name', async () => {
    fakeContainers.set('c1', makeInspect('c1'));
    const r = await request(buildApp())
      .post('/api/containers/c1/rename')
      .set('Authorization', withRole('admin'))
      .send({ name: 'new-name' });
    expect(r.status).toBe(200);
    expect(renameMock).toHaveBeenCalledWith('c1', { name: 'new-name' });
  });

  it('400 on bad name (schema regex)', async () => {
    fakeContainers.set('c1', makeInspect('c1'));
    const r = await request(buildApp())
      .post('/api/containers/c1/rename')
      .set('Authorization', withRole('admin'))
      .send({ name: 'has space' });
    expect(r.status).toBe(400);
  });

  it('409 when the requested name is already taken', async () => {
    fakeContainers.set('c1', makeInspect('c1'));
    const r = await request(buildApp())
      .post('/api/containers/c1/rename')
      .set('Authorization', withRole('admin'))
      .send({ name: 'taken-name' });  // schema-valid; mock returns 409
    expect(r.status).toBe(409);
    expect(r.body.detail).toMatch(/already taken/i);
  });

  it('viewer JWT is 403', async () => {
    fakeContainers.set('c1', makeInspect('c1'));
    const r = await request(buildApp())
      .post('/api/containers/c1/rename')
      .set('Authorization', withRole('viewer'))
      .send({ name: 'whatever' });
    expect(r.status).toBe(403);
  });
});

// ============================================================
// POST /:id/recreate
// ============================================================

describe('POST /api/containers/:id/recreate', () => {
  it('refuses compose-managed containers (409) without touching the daemon', async () => {
    fakeContainers.set('c1', makeInspect('c1', {
      labels: { 'com.docker.compose.project': 'my-app' },
    }));
    const r = await request(buildApp())
      .post('/api/containers/c1/recreate')
      .set('Authorization', withRole('admin'))
      .send({ image: 'nginx:alpine' });
    expect(r.status).toBe(409);
    expect(r.body.detail).toMatch(/compose project 'my-app'/);
    // No mutating dockerode calls happened.
    expect(stopMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('full happy path: stop → remove → create → start, streaming each step', async () => {
    fakeContainers.set('c1', makeInspect('c1', { running: true }));
    const r = await request(buildApp())
      .post('/api/containers/c1/recreate')
      .set('Authorization', withRole('admin'))
      .send({ image: 'nginx:alpine' });
    expect(r.status).toBe(200);

    // The streamed text contains a step line for each phase plus the
    // final OK with the new container id.
    expect(r.text).toMatch(/\[recreate\] source: c1/);
    expect(r.text).toMatch(/\[recreate\] stopping/);
    expect(r.text).toMatch(/\[recreate\] stopped/);
    expect(r.text).toMatch(/\[recreate\] removing source container/);
    expect(r.text).toMatch(/\[recreate\] removed/);
    expect(r.text).toMatch(/\[recreate\] creating new container/);
    expect(r.text).toMatch(/\[recreate\] OK new_id=new-container-id/);

    expect(stopMock).toHaveBeenCalledWith('c1', { t: 10 });
    expect(removeMock).toHaveBeenCalledWith('c1', expect.objectContaining({ v: false }));
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(startMock).toHaveBeenCalledWith(fakeNewContainerId);
  });

  it('preserves the original name when no name is supplied', async () => {
    fakeContainers.set('c1', makeInspect('webserver'));
    await request(buildApp())
      .post('/api/containers/c1/recreate')
      .set('Authorization', withRole('admin'))
      .send({ image: 'nginx:alpine' });
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'webserver' }));
  });

  it('honours an explicit body.name', async () => {
    fakeContainers.set('c1', makeInspect('webserver'));
    await request(buildApp())
      .post('/api/containers/c1/recreate')
      .set('Authorization', withRole('admin'))
      .send({ image: 'nginx:alpine', name: 'webserver-v2' });
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'webserver-v2' }));
  });

  it('skips the stop step when the source container is already exited', async () => {
    fakeContainers.set('c1', makeInspect('c1', { running: false }));
    const r = await request(buildApp())
      .post('/api/containers/c1/recreate')
      .set('Authorization', withRole('admin'))
      .send({ image: 'nginx:alpine' });
    expect(r.status).toBe(200);
    expect(stopMock).not.toHaveBeenCalled();
    expect(removeMock).toHaveBeenCalled();
  });

  it('surfaces a create failure clearly so the operator can retry', async () => {
    fakeContainers.set('c1', makeInspect('c1', { running: true }));
    // dockerode createContainer throws — simulate via the mock by
    // shoving an error after the remove succeeded.
    createMock.mockImplementationOnce(() => {
      throw new Error('image not found');
    });
    const r = await request(buildApp())
      .post('/api/containers/c1/recreate')
      .set('Authorization', withRole('admin'))
      .send({ image: 'nginx:does-not-exist' });
    expect(r.status).toBe(200); // streaming response is 200 even on logical failure
    expect(r.text).toMatch(/\[recreate\] ERROR creating: image not found/);
    expect(r.text).toMatch(/ORIGINAL CONTAINER IS GONE/);
    // The text mentions retry guidance for the SPA's recreate dialog.
    expect(r.text).toMatch(/Re-run with the same body to retry create/);
  });

  it('404 when the source container does not exist', async () => {
    const r = await request(buildApp())
      .post('/api/containers/missing/recreate')
      .set('Authorization', withRole('admin'))
      .send({ image: 'nginx' });
    expect(r.status).toBe(404);
  });

  it('viewer JWT is 403', async () => {
    fakeContainers.set('c1', makeInspect('c1'));
    const r = await request(buildApp())
      .post('/api/containers/c1/recreate')
      .set('Authorization', withRole('viewer'))
      .send({ image: 'nginx' });
    expect(r.status).toBe(403);
  });
});
