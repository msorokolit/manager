// System-level endpoints: ping, info, version, df, events, events/stream.
import { Router } from 'express';
import { authenticate } from '../auth.js';
import { getClient } from '../docker-client.js';
import { asyncHandler, intQuery, pipeNdjson } from '../util.js';

const router = Router();
router.use(authenticate);

router.get(
  '/ping',
  asyncHandler(async (req, res) => {
    const client = getClient();
    await client.ping();
    res.json({ ok: true, user: req.user.username, role: req.user.role });
  }),
);

router.get(
  '/info',
  asyncHandler(async (_req, res) => {
    res.json(await getClient().info());
  }),
);

router.get(
  '/version',
  asyncHandler(async (_req, res) => {
    res.json(await getClient().version());
  }),
);

router.get(
  '/df',
  asyncHandler(async (_req, res) => {
    res.json(await getClient().df());
  }),
);

router.get(
  '/events',
  asyncHandler(async (req, res) => {
    const limit = intQuery(req.query.limit, 25, { min: 1, max: 1000 });
    const end = Math.floor(Date.now() / 1000);
    const start = end - 60 * 60;
    const out = [];

    const stream = await getClient().getEvents({ since: start, until: end });

    let buf = '';
    await new Promise((resolve) => {
      const finish = () => {
        try {
          stream.destroy();
        } catch {}
        resolve();
      };
      stream.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            out.push(JSON.parse(line));
          } catch {}
          if (out.length >= limit) return finish();
        }
      });
      stream.on('end', resolve);
      stream.on('error', resolve);
      // Hard-stop in case there are no events in the window.
      setTimeout(finish, 1500);
    });

    res.json(out);
  }),
);

router.get(
  '/events/stream',
  asyncHandler(async (_req, res) => {
    const stream = await getClient().getEvents();
    pipeNdjson(stream, res);
  }),
);

export default router;
