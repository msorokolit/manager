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
- **Frontend**: A single-page app written in vanilla JS, styled with Tailwind,
  bundled with **webpack** under `frontend/`. xterm.js, Tailwind utilities and
  the application code are all served as a content-hashed bundle from the
  same origin — no third-party CDN at runtime.
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
  - **Volume browser** (Portainer-style file manager): each operation
    runs a short-lived container (`docker run --rm` with `AutoRemove`)
    that has the volume mounted at `/target`. Stateless on the manager
    side — nothing to leak, nothing to clean up on restart. Features:
    - Breadcrumb navigation, sort, pagination through large directories
    - **In-browser editor (CodeMirror 6)** with line numbers, syntax
      highlighting for ~15 languages (YAML, JSON, Python, JS/TS, HTML,
      CSS, Markdown, shell, nginx, Dockerfile, ini, toml, xml, lua,
      ruby, perl), Ctrl+S to save, dirty indicator, full-screen toggle,
      reload from disk, side-by-side **diff** of pending changes, and
      **optimistic concurrency** (saves include the mtime you read; the
      server rejects with 409 if the file changed underneath you)
    - **Atomic writes** (temp + `os.replace`) that preserve the file's
      original mode/uid/gid — editing a `0600 root:root` secret can't
      accidentally widen its perms
    - **Permissions editor** combining mode (octal + rwx triplets) and
      ownership (numeric uid/gid, `-1` to leave unchanged), with an
      optional recursive (`-R`) toggle for directories
    - Download single files / whole folders as `tar`, upload (button or
      drag-and-drop, multi-file), rename, mkdir
    - Multi-select with **single-round-trip** bulk delete / bulk chmod
      / bulk chown
    - Browser image pre-pulled at startup so the first browse is snappy
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

The repo is an [npm workspace](https://docs.npmjs.com/cli/v10/using-npm/workspaces),
so a single install at the root pulls down both the frontend and backend deps:

```bash
npm install                          # installs frontend + backend deps in one go
npm run build                        # builds the SPA bundle into frontend/dist/
ADMIN_USER=admin ADMIN_PASSWORD=admin npm start
# server on http://localhost:8000
```

Useful scripts at the root (defined in `package.json`):

| Script | What it does |
| --- | --- |
| `npm install` | Install deps for every workspace |
| `npm run build` | Production webpack build of the SPA → `frontend/dist/` |
| `npm start` | Start the backend (serves API + bundle on `:8000`) |
| `npm run preview` | `build` then `start` — production-mode end-to-end |
| `npm run dev` | Run **both** workers in parallel (webpack `--watch` + node `--watch`), color-prefixed via [concurrently](https://github.com/open-cli-tools/concurrently) |
| `npm run dev:frontend` / `npm run dev:backend` | Run just one watcher |
| `npm run clean` | Wipe `dist/` + every `node_modules/` |

The Docker image still bakes the bundle into a multi-stage build, so end-users
running `docker compose up -d --build` don't need to run `npm` themselves.

## Configuration

All configuration is via environment variables.

| Variable             | Default          | Notes                                                                 |
| -------------------- | ---------------- | --------------------------------------------------------------------- |
| `ADMIN_USER`         | `admin`          | Username for the full-access role                                     |
| `ADMIN_PASSWORD`     | `admin`          | **Change this**                                                       |
| `VIEWER_USER`        | _(unset)_        | Optional read-only account                                            |
| `VIEWER_PASSWORD`    | _(unset)_        | Required if `VIEWER_USER` is set                                      |
| `ALLOW_DESTRUCTIVE`  | `true`           | Set to `false` to deny **Docker-state-changing** calls (container kill/remove, volume remove, image/network/volume prune, stack down). Filesystem mutations inside a volume (chmod, chown, edit, mkdir) require admin role but are NOT gated by this flag. |
| `DOCKER_HOST`        | _(auto)_         | E.g. `tcp://docker:2375` or `unix:///var/run/docker.sock`             |
| `CORS_ORIGINS`       | _(empty)_        | Comma-separated origins to allow if the UI is hosted elsewhere        |
| `STATIC_DIR`         | `./frontend`     | Path to the SPA assets                                                |
| `LOG_TAIL_DEFAULT`   | `200`            | Default tail size for log endpoints                                   |
| `STACKS_DIR`         | `/data/stacks`   | Where managed compose stacks are persisted (one subdir per stack)     |
| `COMPOSE_BIN`        | `docker-compose` | Path to a compose v2 binary; resolved from `$PATH` if relative        |
| `EXEC_DEFAULT_SHELL` | `/bin/sh`        | Pre-filled command in the in-browser terminal                         |
| `DATA_DIR`           | `/data`          | Base directory for the registries file                                |
| `REGISTRIES_FILE`    | `${DATA_DIR}/registries.json` | JSON store of registry credentials (mode `0600`)         |
| `BROWSER_IMAGE`      | `python:3-alpine`| Image used for the per-operation volume-browser container (must include `python3`). Pre-pulled at startup. |
| `VOLUME_BROWSER_NO_LIMITS` | _(unset)_   | Set `true` only on nested-VM / sandboxed runners whose root cgroup is in "domain threaded" mode; skips `Memory`/`NanoCpus`/`PidsLimit` on the per-op container. `CapDrop:ALL` stays applied. |
| `VOLUME_BROWSER_OP_TIMEOUT_MS` | `90000`  | Wall-clock cap on a single volume-browser helper container. The container is force-removed and the request returns 504 if it exceeds this. Set `0` to disable (not recommended). |
| `JWT_SECRET`         | _(random)_       | HS256 signing key. Set this in production; otherwise a random key is generated on each restart and existing sessions are invalidated. |
| `JWT_TTL_SECONDS`    | `43200`          | Token lifetime in seconds. Floor 60s, ceiling 30 days.                |
| `RATE_LIMIT_DISABLED`| `false`          | Turn off the rate limiters entirely (dev only)                        |
| `RATE_LIMIT_GLOBAL_PER_MIN` | `600`     | Per-IP request budget per minute, applied app-wide                    |
| `RATE_LIMIT_LOGIN_PER_MIN`  | `10`      | Per-IP budget on `POST /api/auth/login` (credential-stuffing brake)   |
| `EXPENSIVE_CONCURRENCY_PER_USER` | `2` | Max simultaneous in-flight expensive requests (image pull, compose `up`/`pull`/`down`) per authenticated user. `0` disables. |
| `COMPOSE_DEADLINE_MS`| `1800000`        | Wall-clock deadline for a streaming compose subprocess. Bounded by SIGTERM, then SIGKILL. |
| `COMPOSE_KILL_GRACE_MS` | `10000`       | Grace period after SIGTERM before SIGKILL                             |
| `CORS_ORIGINS`       | _(empty)_        | Comma-separated origin allow-list. Empty means same-origin only — no CORS headers emitted. Set to e.g. `https://ops.example.com` to enable cross-origin browser access. |
| `HELMET_DISABLED`    | `false`          | Disable [Helmet](https://helmetjs.github.io/) entirely. NOT recommended. |
| `CSP_DISABLED`       | `false`          | Keep all other Helmet headers but drop the Content-Security-Policy header (useful if you proxy through a CDN that injects its own CSP). |
| `CSP_EXTRA_SCRIPT_SRC` / `CSP_EXTRA_STYLE_SRC` / `CSP_EXTRA_CONNECT_SRC` | _(empty)_ | Comma-separated additional sources to allow if you fork the SPA to load assets from another CDN. |
| `LOG_LEVEL`          | `info`           | Pino level: `trace` / `debug` / `info` / `warn` / `error` / `fatal` / `silent`. In tests defaults to `silent`. |
| `LOG_PRETTY`         | `false`          | Pipe app + access logs through `pino-pretty` (human-readable colourised lines). Off by default — production wants raw JSON for log shippers. |
| `AUDIT_ENABLED`      | `true`           | Persist a JSONL audit log of every mutating API request. Set `false` to disable entirely (then `/api/audit` returns 503). |
| `AUDIT_FILE`         | `${DATA_DIR}/audit.log` | Path to the audit log. Mode is enforced to `0600` on each write. |
| `AUDIT_MAX_BYTES`    | `10485760`       | Size cap on the live audit file. When exceeded, `audit.log` rotates to `audit.log.1`, `.1` → `.2`, etc. Set `0` to disable in-process rotation (when an external log shipper / `logrotate` handles it). |
| `AUDIT_ROTATE_KEEP`  | `5`              | Number of rotated audit files to keep. The oldest is dropped when a new rotation happens. |
| `SESSIONS_FILE`      | `${DATA_DIR}/sessions.json` | Persistence file for the server-side session store. Mode `0600` is enforced on every write. Restart-survival without forcing every user to re-login. |
| `SESSIONS_PERSIST_INTERVAL_MS` | `30000` | How often the in-memory session store flushes dirty rows to disk. Higher = less I/O; lower = smaller "sessions lost on crash" window. |
| `SESSIONS_MAX_PER_USER` | `0`           | Cap concurrent sessions per user. `0` = unlimited. Set to `1` in environments that mandate single-session-per-principal (banks / SOC); the oldest session is evicted when a new login would exceed the cap. |

## Logging & audit (enterprise)

Two structured streams, both backed by [pino](https://getpino.io/):

**1. Application + HTTP access log** — written to stdout as JSON-per-line. Every record carries a `request_id` (UUID v4, or the `X-Request-Id` header from an upstream proxy if it looks safe), plus the authenticated `user` / `role` and `source_ip` once auth has run. The same correlation ID is echoed back on the response as `X-Request-Id`, so an operator can trace `"what did user `alice` do at 14:23:11"` end-to-end across the proxy log, the app log, and the audit log with a single grep.

```json
{"level":30,"time":"2026-06-11T14:23:11.456Z","service":"docker-manager",
 "request_id":"7c2d9f4a-…","user":"alice","role":"admin","source_ip":"10.0.0.5",
 "kind":"http","msg":"7c2d9f4a-… 10.0.0.5 alice(admin) POST /api/containers/abc/start 200 -b 47.812 ms"}
```

[Morgan](https://github.com/expressjs/morgan) emits the HTTP access line; its stream is piped through pino so structured app logs and access logs share one transport. `/api/health` and `/api/system/events/stream` are skipped from the access log on purpose (probe hammering / long-lived SSE-style streams).

**2. Audit log** — append-only JSONL file (`AUDIT_FILE`, default `${DATA_DIR}/audit.log`, mode `0600`). One row per mutating API request, including 401/403 rejections so attempted misuse is captured too. Each row:

```json
{"ts":"2026-06-11T14:23:11.501Z","request_id":"7c2d9f4a-…",
 "actor":{"username":"alice","role":"admin"},"source_ip":"10.0.0.5",
 "method":"POST","path":"/api/containers/abc/start","action":"container.start",
 "resource_type":"container","resource_id":"abc",
 "outcome":"ok","status":200,"duration_ms":47.81}
```

The `action` is derived from the route's tag + path segments (`/api/containers/:id/start` → `container.start`; `/api/networks/:id/connect` → `network.connect`; `/api/volumes/delete/bulk` → `volume.delete.bulk`). Routes can override by setting `audit: { action: '…', resourceType: '…', resourceIdFrom: 'params.foo' | 'body.bar' }` in their spec.

The SPA exposes the audit log under an **Audit** tab (admin-only, hidden from viewer JWTs). The page has a full filter bar (actor / action glob / resource type / resource id / outcome / time window / request id / session id), pagination, a "Live" toggle that auto-refreshes every 5s, a "Download JSONL" button for sharing with a SOC during an incident, and per-row detail modals with one-click "filter by this" chips. From the **Sessions** tab, each row's `📜 Activity` button cross-links to the Audit page pre-filtered by that session's id.

The audit log is also admin-queryable via `GET /api/audit`:

```bash
# Last 50 actions by alice
curl -H "Authorization: Bearer $TOKEN" \
  "https://manager/api/audit?actor=alice&limit=50"

# All failed container removals in a time window
curl -H "Authorization: Bearer $TOKEN" \
  "https://manager/api/audit?action=container.remove*&outcome=error&since=2026-06-11T00:00:00Z"

# Reconstruct everything that happened during one request
curl -H "Authorization: Bearer $TOKEN" \
  "https://manager/api/audit?request_id=7c2d9f4a-…"
```

Filters: `since`, `until`, `actor`, `action` (glob: `container.*`, `*.bulk`, etc.), `resource_type`, `resource_id`, `outcome`, `request_id`, `limit` (max 1000), `offset`, `order` (`asc` / `desc`). The endpoint reads `AUDIT_FILE` plus all rotated siblings (`audit.log.1`, `audit.log.2`, …) so historical entries stay queryable after rotation.

For deployments past a few hundred MB of audit data, point `AUDIT_FILE` at a path your log shipper watches (`vector` / `fluentbit` / `filebeat`) and disable in-process rotation with `AUDIT_MAX_BYTES=0`. The JSONL format is the lowest-common-denominator input for every aggregator we tested.

## GPUs & host devices

The Run Container dialog exposes host devices + GPUs + alternate OCI runtimes as first-class fields. To avoid blind-guessing, the dialog calls `GET /api/system/devices` on open and renders:

- A device row editor (Host path / Container path / Perms) — typos are rejected at input time, not as opaque daemon errors two seconds later.
- A **GPU mode picker** (None / All / Specific) backed by detected NVIDIA GPUs from `nvidia-smi`, with optional capability checkboxes (`compute`, `utility`, `video`, …).
- A **Runtime select** populated from `docker info` Runtimes (`runc`, `nvidia`, `crun`, `kata-runtime`, …).
- A banner that surfaces the host's accelerator state: `"2 GPUs detected: NVIDIA RTX A4000 · runtime nvidia available"`, or a friendly warning when the manager container can't see GPUs the host has.

The **System** tab carries a dedicated *Accelerators & devices* panel with the runtime list, per-GPU details (model, VRAM, driver, UUID), and `/dev/dri` enumeration. Each GPU row has a *Use in container* shortcut that opens the Run dialog pre-populated with the matching index + nvidia runtime; `/dev/dri` gets the same shortcut for Intel/AMD VAAPI workloads.

Container **Inspect** → Resources tab gains a *GPU device requests* table alongside the existing Devices table, plus the container's effective Runtime line.

### Detection caveats

GPU enumeration is best-effort and runs from inside the manager container, so:

- **Runtimes** come from `docker info` — always accurate, the daemon is the source of truth.
- **NVIDIA GPUs** require `nvidia-smi` to be available inside the manager container *and* the container to be able to read `/dev/nvidia*`. The simplest setup is running the manager itself with `--runtime=nvidia`. Without that, the discovery endpoint returns `nvidia.available: false` with a `note` explaining what's missing, and the Run dialog falls back to a manual "GPU indices" text input.
- **`/dev/dri`** existence is a filesystem check inside the manager container; the device only shows up if it's bind-mounted in.

The dialog still works end-to-end without any of this — the runtime select is empty, GPU mode defaults to None, devices are entered as free-text rows. The discovery is a UX improvement, not a load-bearing dependency.

### API additions

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/system/devices` | Runtimes + GPUs + `/dev/dri` + suggested gpu_runtime. Cached 30 s. |
| `POST` | `/api/containers` | Now accepts `gpu_device_ids: [...]`, `gpu_capabilities: [...]`, `runtime: "..."`. The legacy `gpus: 'all' \| N` shorthand still works. Device strings (`devices: ["host:container:perms"]`) are now regex-validated. |

## Sessions

JWTs by themselves are stateless: once signed, they're valid until `exp`. That's fine for a toy, but it means no real "log out" (the token keeps working), no "sign me out everywhere", and no admin force-kick. So every login mints a row in a server-side session store and embeds its UUID into the JWT as `jti`. On every request the auth middleware looks the `jti` up — a missing row is "session revoked, please log in again". Revocation flips from a multi-hour wait for `exp` to a single `Map.delete`.

**What users can do** (any role):

| Endpoint | What it does |
|---|---|
| `POST /api/auth/logout` | Drop the session backing the current bearer token. |
| `POST /api/auth/logout-all` | Drop every one of *your* sessions (`?keep_current=true` to spare the calling one). |
| `GET /api/auth/sessions` | List your active sessions (with the `current` one marked). |
| `POST /api/auth/sessions/:id/revoke` | Drop one of your own sessions by id. |

**What admins can do additionally:**

| Endpoint | What it does |
|---|---|
| `GET /api/auth/sessions/all` | List every active session across all users (user / role / source IP / user-agent / `issued_at` / `last_seen` / `expires_at`). |
| `POST /api/auth/sessions/:id/revoke` | Kill any session by id (not just your own). |
| `POST /api/auth/sessions/revoke-user/:username` | Kill every session owned by one user (e.g. an offboarded operator). |
| `POST /api/auth/sessions/revoke-all` | Incident response: kill every active session. Spares the caller's session by default — pass `?include_self=true` to nuke yours too. |

The SPA exposes all of this under the **Sessions** tab: your sessions on top with `Sign out other devices` / `Sign out everywhere`, and (for admins) all users below with per-row `Revoke` and a `Sign out everyone` button.

Every session event (created, revoked, evicted by `SESSIONS_MAX_PER_USER`) lands in the app log with `session_id` and the actor, and every revocation endpoint is itself audited — so the audit log answers "*who signed everyone out at 03:14*" as well as "*when did alice last sign in*".

**Storage notes:** the store is in-memory (one Map) with a debounced atomic write to `SESSIONS_FILE` (mode 0600). Sessions survive a process restart via the file. This is the right shape for a single-replica deployment; multi-replica deployments should swap the persistence layer for Redis or a shared DB (replace `src/sessions.js` with the matching adapter — its public exports are the only API the rest of the codebase relies on).

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
  `Content-Security-Policy` tuned for the bundled SPA (see CSP details below).
  `Strict-Transport-Security` is intentionally **not** set so that operators
  running behind a TLS-terminating proxy can pick a sensible `max-age`
  themselves; if you don't have a proxy, add HSTS at your reverse-proxy
  layer rather than enabling helmet's default.
- All HTTP responses carry a [Helmet](https://helmetjs.github.io) security-
  header baseline plus a strict CSP, since the SPA is now bundled and served
  from the same origin (no third-party CDN at runtime):
    - `default-src 'self'`
    - `script-src 'self'` (no `'unsafe-inline'`, no third-party hosts)
    - `style-src 'self' 'unsafe-inline'` — the inline allowance covers a
      handful of `style="..."` attributes the SPA uses (e.g. on the terminal
      modal); everything else is in the bundled CSS
    - `connect-src 'self'` — covers `ws://` / `wss://` to the exec WebSocket
    - `img-src 'self' data:`, `font-src 'self' data:`,
      `worker-src 'self' blob:`
    - `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`
  CSP is dropped only on `/api/docs/` (Swagger UI's inline initializer); the
  rest of the app keeps the full policy. `CSP_EXTRA_*` env vars allow forks
  to add additional sources without disabling CSP entirely.
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
      volume-browser.js         list/get/view/edit/upload/mkdir/rename/chmod/chown/delete/archive + bulk chmod/chown/delete (one-shot container per op, AutoRemove)
      stacks.js                 CRUD + up/down/restart/pull/logs/validate + per-service actions
      registries.js             list/upsert/delete/test (file-backed credential store)
      exec.js                   POST /api/exec/ticket + WS /api/containers/:id/exec
      auth.js                   POST /api/auth/login + GET /api/auth/me

frontend/                       Webpack-bundled SPA
  package.json
  webpack.config.cjs
  postcss.config.cjs
  tailwind.config.cjs
  src/
    index.html                  Template (no CDN tags; webpack injects script/link)
    index.js                    SPA: routing, views, dialogs (imports xterm + styles)
    styles.css                  @tailwind directives + custom rules
  dist/                         Build output (gitignored): served at /

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
| volume-browser | list (paginated) / get / view / edit (PUT, atomic + mtime check) / archive / upload / mkdir / rename / chmod / chown / delete + bulk chmod / bulk chown / bulk delete |
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
