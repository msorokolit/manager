# Docker Manager

A self-hosted, web-based UI for managing enterprise systems running on Docker.
It exposes a clean dashboard for the most common day-2 operations against a
single Docker engine: containers, images, networks, volumes, and host info.

The stack is intentionally small and easy to audit:

- **Backend (default)**: Node.js (Express + [`dockerode`](https://github.com/apocas/dockerode))
  in `backend-node/`
- **Backend (alternate)**: FastAPI + the official `docker` Python SDK in `backend/`.
  Both speak the same HTTP API and are wire-compatible, so the same SPA serves
  both. Build with `Dockerfile.python` if you'd rather run the Python edition.
- **Frontend**: A single-page app written in vanilla JS, styled with Tailwind
  (loaded via CDN) — no build step is required
- **Auth**: HTTP Basic with two roles (`admin`, optional read-only `viewer`)
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

## Quick start (local Python — alternate backend)

Requires Python 3.11+. The Python backend exposes the same API and serves the
same SPA, so you can pick either:

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
ADMIN_USER=admin ADMIN_PASSWORD=admin \
  uvicorn app.main:app --host 0.0.0.0 --port 8000
```

The frontend is served from the same process at `/`. The Python backend also
ships an OpenAPI schema at `/docs` (Swagger UI). The Node backend serves the
same surface at the same URLs but does not auto-generate Swagger docs.

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
- HTTP Basic credentials are sent on every request; always front this with TLS
  in production (Caddy, Traefik, nginx, an ingress controller, etc.).
- The terminal endpoint is a WebSocket. Browsers cannot attach an HTTP Basic
  header to `new WebSocket(...)`, so authentication uses a one-shot ticket
  (`POST /api/exec/ticket`) that is consumed on connect and expires in 60s.
  Tickets are bound to the issuing role and only admins can mint them.
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
backend-node/                   Default Node.js backend (Express + dockerode)
  package.json
  src/
    index.js                    HTTP + WS server, SPA serving, route wiring
    config.js                   Env-driven settings
    auth.js                     HTTP Basic + role gating
    docker-client.js            Lazy dockerode singleton
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

backend/                        Alternate Python backend (FastAPI + docker-py)
  app/
    main.py                     FastAPI app + static SPA serving
    config.py                   Env-driven settings
    auth.py                     HTTP Basic + role gating
    docker_client.py            Lazy DockerClient singleton
    routers/                    Same per-resource set as the Node version
  requirements.txt

frontend/                       Wire-compatible with both backends
  index.html
  app.js                        SPA: routing, views, dialogs
  styles.css

Dockerfile                      Node backend image (default)
Dockerfile.python               Python backend image (alternate)
docker-compose.yml
.env.example
```

## API

The full OpenAPI schema is auto-generated and available at
`http://localhost:8000/docs` (Swagger UI) or `/openapi.json`.

Most endpoints accept the same Basic credentials used by the UI, e.g.

```bash
curl -u admin:secret http://localhost:8000/api/containers | jq
curl -u admin:secret -X POST http://localhost:8000/api/containers/<id>/restart
```

## License

MIT.
