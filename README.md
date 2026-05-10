# Docker Manager

A self-hosted, web-based UI for managing enterprise systems running on Docker.
It exposes a clean dashboard for the most common day-2 operations against a
single Docker engine: containers, images, networks, volumes, and host info.

The stack is intentionally small and easy to audit:

- **Backend**: Node.js (Express + [`dockerode`](https://github.com/apocas/dockerode)
  + [`@sinclair/typebox`](https://github.com/sinclairzx81/typebox) +
  [`ajv`](https://ajv.js.org) + [`helmet`](https://helmetjs.github.io) +
  [`cors`](https://github.com/expressjs/cors) +
  [`jsonwebtoken`](https://github.com/auth0/node-jsonwebtoken) +
  [`swagger-ui-express`](https://github.com/scottie1984/swagger-ui-express))
  in `backend-node/`. Pure ESM, no transpilation. Schemas are JSON Schema
  fragments that drive both runtime validation **and** the auto-generated
  OpenAPI 3.1 spec — single source of truth.
- **Frontend**: A single-page app written in vanilla JS, styled with Tailwind
  (loaded via CDN) — no build step is required
- **Auth**: JWT bearer (HS256), two roles (`admin`, optional read-only `viewer`)
- **Packaging**: A single Docker image; runs via `docker compose`

## Features

- **Dashboard** with engine/host stats and recent containers
- **Containers** — list, inspect, start/stop/restart/pause/kill, remove, prune
  - One-click follow-mode log streaming
  - **Comprehensive "Run container" form** with collapsible sections covering
    image / name / cmd / entrypoint, port mappings, volumes, tmpfs, env, user,
    working dir, hostname, MAC, DNS, extra hosts, restart policy, networks
    and network mode, CPU / memory / pids / shm / GPU / ulimits / devices,
    privileged / capabilities / security_opt / sysctls, healthcheck override,
    log driver and options, labels, init / TTY / STDIN / auto-remove /
    read-only / stop-signal & grace
  - **In-browser interactive terminal** (xterm.js + WebSocket; full TTY,
    auto-resize, choose any command e.g. `/bin/bash`)
- **Stacks (docker-compose)** — store compose files on the manager and
  drive their lifecycle from the UI, plus discover compose projects already
  running on the host:
  - Create a stack from a compose YAML (and optional `.env`) and deploy with
    one click; output of `docker compose up -d` streamed live
  - `up`, `down`, `restart`, `pull`, tail logs — all stream stdout/stderr to
    the browser
  - Edit the compose / env content from the browser
  - "External" stacks (those not stored on the manager but identified by
    `com.docker.compose.project` labels) are listed read-only
- **Images** — list, inspect, pull (with streaming progress), remove, prune dangling
- **Networks** — list, inspect, create (bridge/overlay/macvlan/ipvlan/host), remove, prune
  - **Connect / disconnect** containers from the network inspect modal
- **Volumes** — list, inspect, create, remove, prune
  - **Volume browser**: spins up a small sidecar with the volume mounted at
    `/target` and lets you list directories, download files, upload files,
    create folders, and delete entries
- **Registries** — store per-registry credentials (Docker Hub, ghcr.io, ECR,
  GitLab Registry, private registries…), test login, then select them from the
  image-pull dialog. Stored at `REGISTRIES_FILE` with file mode `0600`.
- **Activity** — live tail of `docker events` and a per-container live stats
  panel (CPU %, memory usage / %, network rx/tx, block IO) with rolling
  sparklines fed from the streaming stats endpoint
- **System** — engine info, version, disk usage breakdown
- Live daemon-status indicator (green/red) with periodic ping
- Two roles:
  - `admin` — can call any endpoint, including stacks and exec
  - `viewer` (optional) — can read everything but cannot mutate or open shells

## Quick start (Docker Compose)

```bash
git clone <this repo> docker-manager
cd docker-manager
cp .env.example .env
# edit .env, at minimum set ADMIN_PASSWORD
docker compose up -d --build
```

Then open <http://localhost:8000> and log in with the credentials from `.env`.

## Quick start (local Node.js)

Requires Node.js 20+ and a reachable Docker daemon (e.g. via
`/var/run/docker.sock` or the `DOCKER_HOST` environment variable).

```bash
cd backend-node
npm install
ADMIN_USER=admin ADMIN_PASSWORD=admin npm start
# server on http://localhost:8000
```

The frontend is served from the same process at `/`.

## Configuration

All configuration is via environment variables.

| Variable             | Default          | Notes                                                                 |
| -------------------- | ---------------- | --------------------------------------------------------------------- |
| `ADMIN_USER`         | `admin`          | Username for the full-access role                                     |
| `ADMIN_PASSWORD`     | `admin`          | **Change this**                                                       |
| `VIEWER_USER`        | _(unset)_        | Optional read-only account                                            |
| `VIEWER_PASSWORD`    | _(unset)_        | Required if `VIEWER_USER` is set                                      |
| `ALLOW_DESTRUCTIVE`  | `true`           | Set to `false` to deny every state-changing call (read-only mode)     |
| `DOCKER_HOST`        | _(auto)_         | E.g. `tcp://docker:2375` or `unix:///var/run/docker.sock`             |
| `CORS_ORIGINS`       | _(empty)_        | Comma-separated origins to allow if the UI is hosted elsewhere        |
| `STATIC_DIR`         | `./frontend`     | Path to the SPA assets                                                |
| `LOG_TAIL_DEFAULT`   | `200`            | Default tail size for log endpoints                                   |
| `STACKS_DIR`         | `/data/stacks`   | Where managed compose stacks are persisted (one subdir per stack)     |
| `COMPOSE_BIN`        | `docker-compose` | Path to a compose v2 binary; resolved from `$PATH` if relative        |
| `EXEC_DEFAULT_SHELL` | `/bin/sh`        | Pre-filled command in the in-browser terminal                         |
| `DATA_DIR`           | `/data`          | Base directory for the registries file                                |
| `REGISTRIES_FILE`    | `${DATA_DIR}/registries.json` | JSON store of registry credentials (mode `0600`)         |
| `BROWSER_IMAGE`      | `python:3-alpine`| Sidecar image used by the volume browser (must include `python3`)     |
| `JWT_SECRET`         | _(random)_       | HS256 signing key. Set this in production; otherwise a random key is generated on each restart and existing sessions are invalidated. |
| `JWT_TTL_SECONDS`    | `43200`          | Token lifetime in seconds (default 12h)                                |
| `CORS_ORIGINS`       | _(empty)_        | Comma-separated origin allow-list. Empty means same-origin only — no CORS headers emitted. Set to e.g. `https://ops.example.com` to enable cross-origin browser access. |
| `HELMET_DISABLED`    | `false`          | Disable [Helmet](https://helmetjs.github.io/) entirely. NOT recommended. |
| `CSP_DISABLED`       | `false`          | Keep all other Helmet headers but drop the Content-Security-Policy header (useful if you proxy through a CDN that injects its own CSP). |
| `CSP_EXTRA_SCRIPT_SRC` / `CSP_EXTRA_STYLE_SRC` / `CSP_EXTRA_CONNECT_SRC` | _(empty)_ | Comma-separated additional sources to allow if you fork the SPA to load assets from another CDN. |

## Request validation & OpenAPI

Every endpoint that accepts a body or interesting path/query parameters has
a JSON Schema fragment authored with [TypeBox](https://github.com/sinclairzx81/typebox).
The same schemas are used at runtime by [AJV](https://ajv.js.org) to validate
requests **and** are referenced from the auto-generated OpenAPI 3.1 document.
There is one source of truth per type — schemas live under
`backend-node/src/schemas/` and are re-exported from `schemas/index.js`.

### Routes are declarative

Routes are declared with a small builder (`createApiRouter`) so adding a
route only ever touches its own `routes/<resource>.js` file — the OpenAPI
spec rebuilds itself from the registry on boot:

```js
import { createApiRouter } from '../route-builder.js';
import { LoginRequest, LoginResponse } from '../schemas/index.js';

const r = createApiRouter('/api/auth', { tag: 'auth' });

r.post(
  '/login',
  {
    summary: 'Exchange credentials for a JWT',
    auth: false,                          // public route
    body: LoginRequest,                   // -> validateBody + requestBody schema
    responses: { 200: LoginResponse },    // 400 / 502 / 503 auto-injected
  },
  asyncHandler(async (req, res) => { /* handler */ }),
);

export default r;
```

The builder wires up `authenticate` / `requireAdmin` / `validateBody` /
`validateQuery` / `validateParams` middleware automatically based on the
spec, and pushes a canonical operation descriptor into `r.operations`.
`index.js` aggregates `operations` from every api module and hands them to
`buildOpenApiSpec()` — there is no hand-maintained list of paths anywhere.

On a validation failure you get HTTP 400 with field-level errors:

```json
{
  "detail": "Validation failed",
  "errors": [
    { "path": "ulimits.0.soft", "message": "must be integer", "code": "type" },
    { "path": "sneaky",         "message": "Unrecognized field 'sneaky'", "code": "additionalProperties" }
  ]
}
```

Path parameters are validated where they affect filesystem or shell-out
behaviour (stack name, service name, action enum) so e.g. `service: "../etc"`
is rejected at the routing layer rather than relying on downstream sanitising.

### Browse the API

- **`GET /api/openapi.json`** — the raw OpenAPI 3.1 document
- **`GET /api/docs/`** — [Swagger UI](https://swagger.io/tools/swagger-ui/),
  with "Try it out" wired to the live server. Both URLs are public so the API
  is discoverable without logging in; protected operations show a lock and
  prompt for a Bearer token (paste the JWT from `POST /api/auth/login`).

## Security notes

- This UI is intended for **trusted operators** on a private network. Mounting
  `/var/run/docker.sock` into any container effectively grants root on the host.
  Never expose this service directly to the public internet without a reverse
  proxy enforcing TLS, IP allow-listing, and additional auth.
- Set a strong `ADMIN_PASSWORD`. The default of `admin/admin` exists only to
  make first-run testing trivial.
- For an audit-friendly read-only deployment, set `ALLOW_DESTRUCTIVE=false` and
  use the `viewer` account. Note that the in-browser terminal and all stack
  mutations require the `admin` role and so are disabled in this mode too.
- Authentication uses **JWT bearer tokens (HS256)**. Clients call
  `POST /api/auth/login` with `{username, password}` and receive a token they
  send as `Authorization: Bearer <token>` on every other request. **Always
  set `JWT_SECRET`** in production — without it a random secret is generated
  on each restart and every issued token is invalidated. Always front the
  service with TLS so the login payload and bearer token aren't transmitted
  in clear text.
- The verifier explicitly pins HS256, rejects `alg: none` and other
  algorithms, validates `exp`, and re-derives `username`/`role` from the
  signed claims so a tampered payload yields 401.
- All HTTP responses carry a [Helmet](https://helmetjs.github.io/) baseline
  set of security headers: `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Resource-Policy: same-site`, and a
  `Content-Security-Policy` tuned for the CDN-loaded Tailwind + xterm.js
  assets the SPA uses. `Strict-Transport-Security` is intentionally
  **not** set so that operators running behind a TLS-terminating proxy
  can pick a sensible `max-age` themselves; if you don't have a proxy,
  add HSTS at your reverse-proxy layer rather than enabling helmet's
  default.
- The bundled CSP allows `'unsafe-inline'` for both scripts and styles —
  required because Tailwind's CDN runtime injects `<style>` tags into the
  document and `index.html` carries one inline `<script>` block that
  configures it. The CSP otherwise restricts `script-src` to `self`
  + `cdn.tailwindcss.com` + `cdn.jsdelivr.net`, denies framing
  (`frame-ancestors 'none'`), denies `<object>`, and pins `connect-src`
  to `self` (covers ws:// and wss:// for the exec WebSocket on the same
  origin).
- CORS is disabled by default (same-origin SPA + API). Set `CORS_ORIGINS`
  to a comma-separated allow-list to enable credentialed cross-origin
  browser access — disallowed origins receive responses with no
  `Access-Control-Allow-Origin` header and the browser refuses the
  response.
- The terminal endpoint is a WebSocket. Browsers cannot attach an
  `Authorization` header to `new WebSocket(...)`, so authentication uses a
  one-shot ticket (`POST /api/exec/ticket`, requires a Bearer JWT) that is
  consumed on connect and expires in 60s. Tickets are bound to the issuing
  role and only admins can mint them.
- Registry credentials are stored in plain text on disk so the daemon can
  consume them on pull. The file is created with mode `0600` and lives on the
  manager host; back it up like any other secret material. Never store
  credentials for accounts more powerful than the manager itself.
- The volume browser starts a sidecar with the volume mounted read-write at
  `/target` and runs `mkdir`/`rm`/`python3` execs against it. Anyone with
  admin can create or delete files inside any volume by design — the same
  level of trust as `docker run -v`.

## Project layout

```
backend-node/
  package.json
  src/
    index.js                    HTTP + WS server, SPA serving, route wiring
    config.js                   Env-driven settings
    auth.js                     HTTP Basic + role gating
    docker-client.js            Lazy dockerode singleton
    jwt.js                      HS256 sign/verify (random secret if JWT_SECRET unset)
    validate.js                 AJV-based body / query / params validation middleware
    route-builder.js            createApiRouter() — wires middleware + records operations
    openapi.js                  Builds OpenAPI 3.1 from the operation registry on boot
    schemas/                    TypeBox / JSON Schema fragments, one file per resource
      _common.js, auth.js, containers.js, images.js, networks.js,
      volumes.js, stacks.js, registries.js, system.js, index.js
    util.js                     asyncHandler, NDJSON/raw stream helpers, errors
    routes/
      system.js                 ping, info, version, df, events, events/stream
      containers.js             list/inspect/run/start/stop/.../logs/stream/stats/stream/prune
      images.js                 list/inspect/pull (streaming)/remove/prune
      networks.js               list/inspect/create/connect/disconnect/remove/prune
      volumes.js                list/inspect/create/remove/prune
      volume-browser.js         list/get/upload/mkdir/delete/stop (sidecar-backed)
      stacks.js                 CRUD + up/down/restart/pull/logs/validate + per-service actions
      registries.js             list/upsert/delete/test (file-backed credential store)
      exec.js                   POST /api/exec/ticket + WS /api/containers/:id/exec
      auth.js                   POST /api/auth/login + GET /api/auth/me

frontend/
  index.html
  app.js                        SPA: routing, views, dialogs
  styles.css

Dockerfile
docker-compose.yml
.env.example
```

## API

51 HTTP endpoints + 1 WebSocket. All require HTTP Basic auth (admin or viewer
unless an endpoint is admin-only). Mutating endpoints are gated by
`ALLOW_DESTRUCTIVE`.

| Resource     | Endpoints                                                              |
| ------------ | ---------------------------------------------------------------------- |
| meta         | `GET /api/health`, `GET /api/config`                                   |
| auth         | `POST /api/auth/login` (public), `GET /api/auth/me` (Bearer)           |
| system       | `GET /api/system/{ping,info,version,df,events,events/stream}`          |
| containers   | list / inspect / run / start / stop / restart / pause / unpause / kill / remove / prune / logs / logs/stream / stats / stats/stream |
| images       | list / inspect / pull (NDJSON progress) / remove / prune               |
| networks     | list / inspect / create / connect / disconnect / remove / prune        |
| volumes      | list / inspect / create / remove / prune                               |
| volume-browser | list / get / upload / mkdir / delete / stop                          |
| stacks       | list / get / create / update / up / down / restart / pull / logs / validate / delete + per-service `{up,start,stop,restart,pull,rm,logs}` |
| registries   | list / upsert (POST or PUT) / delete / test                            |
| exec         | `POST /api/exec/ticket` + `WS /api/containers/:id/exec?ticket=&cmd=&cols=&rows=` |

All endpoints other than `POST /api/auth/login`, `GET /api/health` and
`GET /api/config` require a Bearer JWT. Typical usage:

```bash
TOKEN=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"secret"}' \
  http://localhost:8000/api/auth/login | jq -r .token)

curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/containers | jq
curl -H "Authorization: Bearer $TOKEN" -X POST \
  http://localhost:8000/api/containers/<id>/restart
```

## License

MIT.
