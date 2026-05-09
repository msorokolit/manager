# Docker Manager

A self-hosted, web-based UI for managing enterprise systems running on Docker.
It exposes a clean dashboard for the most common day-2 operations against a
single Docker engine: containers, images, networks, volumes, and host info.

The stack is intentionally small and easy to audit:

- **Backend**: FastAPI + the official `docker` Python SDK
- **Frontend**: A single-page app written in vanilla JS, styled with Tailwind
  (loaded via CDN) — no build step is required
- **Auth**: HTTP Basic with two roles (`admin`, optional read-only `viewer`)
- **Packaging**: A single Docker image; runs via `docker compose`

## Features

- Dashboard with engine/host stats and recent containers
- Containers — list, inspect, start/stop/restart/pause/kill, remove, prune
  - One-click follow-mode log streaming
  - "Run container" form with image, name, command, env, ports, volumes,
    restart policy, network, and pre-pull
- Images — list, inspect, pull (with streaming progress), remove, prune dangling
- Networks — list, inspect, create (bridge/overlay/macvlan/ipvlan/host), remove, prune
- Volumes — list, inspect, create, remove, prune
- System — engine info, version, disk usage breakdown
- Live daemon-status indicator (green/red) with periodic ping
- Two roles:
  - `admin` — can call any endpoint
  - `viewer` (optional) — can read everything but cannot mutate

## Quick start (Docker Compose)

```bash
git clone <this repo> docker-manager
cd docker-manager
cp .env.example .env
# edit .env, at minimum set ADMIN_PASSWORD
docker compose up -d --build
```

Then open <http://localhost:8000> and log in with the credentials from `.env`.

## Quick start (local Python)

Requires Python 3.11+ and a reachable Docker daemon (e.g. via
`/var/run/docker.sock` or the `DOCKER_HOST` environment variable).

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
ADMIN_USER=admin ADMIN_PASSWORD=admin \
  uvicorn app.main:app --host 0.0.0.0 --port 8000
```

The frontend is served from the same process at `/`.
The OpenAPI docs are available at `/docs`.

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

## Security notes

- This UI is intended for **trusted operators** on a private network. Mounting
  `/var/run/docker.sock` into any container effectively grants root on the host.
  Never expose this service directly to the public internet without a reverse
  proxy enforcing TLS, IP allow-listing, and additional auth.
- Set a strong `ADMIN_PASSWORD`. The default of `admin/admin` exists only to
  make first-run testing trivial.
- For an audit-friendly read-only deployment, set `ALLOW_DESTRUCTIVE=false` and
  use the `viewer` account.
- HTTP Basic credentials are sent on every request; always front this with TLS
  in production (Caddy, Traefik, nginx, an ingress controller, etc.).

## Project layout

```
backend/
  app/
    main.py            FastAPI app + static SPA serving
    config.py          Env-driven settings
    auth.py            HTTP Basic + role gating
    docker_client.py   Lazy DockerClient singleton
    routers/
      system.py        info, version, df, ping, events
      containers.py    list/inspect/run/start/stop/.../logs/stream/stats/prune
      images.py        list/inspect/pull (streaming)/remove/prune
      networks.py      list/inspect/create/remove/prune
      volumes.py       list/inspect/create/remove/prune
  requirements.txt
frontend/
  index.html
  app.js               SPA: routing, views, dialogs
  styles.css
Dockerfile
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
