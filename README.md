# Live Study Room

Vue 3 client, Express + Socket.IO API, MongoDB.

## Docker (whole stack)

```bash
cp .env.example .env      # then set a real JWT_SECRET
npm run docker:up         # docker compose up -d --build
```

Open <http://localhost:8080>.

```bash
npm run docker:logs       # follow logs
npm run docker:down       # stop containers (data volume kept)
npm run docker:reset      # stop and delete the MongoDB volume
```

### How it is wired

```
browser :8080
   │
   ▼
client (nginx) ──/api, /socket.io──▶ server (Node) ──▶ mongo
   │                                    │
   └── static Vue build                 └── port 3000, internal only
```

- The browser only talks to nginx, so the API and refresh cookie are
  **same-origin**. No CORS in the browser and the `httpOnly` refresh cookie is
  first-party.
- nginx proxies `/api/` and `/socket.io/` (WebSocket upgrade included) and
  resolves the `server` container through Docker DNS on every request, so a
  restarted server is picked up without restarting nginx.
- `mongo` is published on `127.0.0.1:27017` only, so local `npm run dev` can
  reach it. It is never exposed off the host.
- Both app images are multi-stage, the server image installs production
  dependencies only and runs as a non-root user, and the client image is a
  static nginx build.

### Configuration

All settings live in the root `.env` (see `.env.example`). The important ones:

| Variable | Default | Notes |
|---|---|---|
| `JWT_SECRET` | `development-secret` | **Change this.** |
| `CLIENT_PORT` | `8080` | Host port for the client. |
| `ACCESS_TOKEN_TTL` | `15m` | Short-lived bearer token. |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Rotating refresh cookie lifetime. |
| `COOKIE_SECURE` | `false` | Set `true` behind HTTPS. |
| `COOKIE_SAME_SITE` | `lax` | Keep `lax` for same-origin. |
| `VITE_API_URL` | empty | Only for split deployments; needs a rebuild. |

## Local development (without app containers)

```bash
docker compose up -d mongo   # database only
npm run install:all
npm run dev                  # API :3000 + Vite :5173
```

Open <http://localhost:5173>. Vite proxies `/api` and `/socket.io` to the API,
so dev behaves like the Docker setup.

## Auth

- `POST /api/auth/register|login` → 15-minute access token + `httpOnly` refresh
  cookie (path `/api/auth`).
- `POST /api/auth/refresh` rotates the refresh token; replaying a revoked token
  revokes the whole login chain.
- `POST /api/auth/logout` revokes the chain and clears the cookie.
- Socket.IO authenticates with the same access token (`auth.token`).

A ready-to-use Postman collection is in [`postman/`](postman/README.md).
