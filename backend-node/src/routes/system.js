// System-level endpoints: ping, info, version, df, events, events/stream.
import { Type } from '@sinclair/typebox';
import { getClient } from '../docker-client.js';
import { asyncHandler, intQuery, pipeNdjson } from '../util.js';
import { createApiRouter, streamResponse } from '../route-builder.js';
import { PassThroughObject, PingResponse } from '../schemas/index.js';

const r = createApiRouter('/api/system', { tag: 'system' });

r.get(
  '/ping',
  {
    summary: 'Ping the Docker daemon',
    responses: { 200: PingResponse },
  },
  asyncHandler(async (req, res) => {
    await getClient().ping();
    res.json({ ok: true, user: req.user.username, role: req.user.role });
  }),
);

r.get(
  '/info',
  { summary: 'docker info (raw)', responses: { 200: PassThroughObject } },
  asyncHandler(async (_req, res) => res.json(await getClient().info())),
);

r.get(
  '/version',
  { summary: 'docker version (raw)', responses: { 200: PassThroughObject } },
  asyncHandler(async (_req, res) => res.json(await getClient().version())),
);

r.get(
  '/df',
  { summary: 'Docker disk usage', responses: { 200: PassThroughObject } },
  asyncHandler(async (_req, res) => res.json(await getClient().df())),
);

const EventsQuery = Type.Object(
  {
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 1000, default: 25 }),
    ),
  },
  { additionalProperties: false },
);

r.get(
  '/events',
  {
    summary: 'Recent docker events (bounded)',
    query: EventsQuery,
    responses: { 200: Type.Array(PassThroughObject) },
  },
  asyncHandler(async (req, res) => {
    const limit = intQuery(req.query.limit, 25, { min: 1, max: 1000 });
    const end = Math.floor(Date.now() / 1000);
    const start = end - 60 * 60;
    const out = [];
    const stream = await getClient().getEvents({ since: start, until: end });
    let buf = '';
    await new Promise((resolve) => {
      const finish = () => {
        try { stream.destroy(); } catch {}
        resolve();
      };
      stream.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          try { out.push(JSON.parse(line)); } catch {}
          if (out.length >= limit) return finish();
        }
      });
      stream.on('end', resolve);
      stream.on('error', resolve);
      setTimeout(finish, 1500);
    });
    res.json(out);
  }),
);

r.get(
  '/events/stream',
  {
    summary: 'Live docker events (NDJSON)',
    responses: { 200: streamResponse('NDJSON stream of docker event objects') },
  },
  asyncHandler(async (_req, res) => {
    const stream = await getClient().getEvents();
    pipeNdjson(stream, res);
  }),
);

export default r;
