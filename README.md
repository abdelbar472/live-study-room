# Live Study Room

Realtime study rooms with live presence, chat, friends, and invites.

**Vue 3** · **Node.js / Express** · **MongoDB** · **Socket.IO** · **JWT auth**

Create a room, join from multiple browsers, see who’s online, chat instantly, add friends, and manage public or invite-only rooms — backed by MongoDB and Socket.IO.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Features

- **Auth** — register / login with short-lived access tokens + rotating `httpOnly` refresh cookies
- **Profiles** — bio, status text, avatar color; search users by name or email
- **Friends** — request, accept, decline, list friends with live online status
- **Rooms** — public or invite-only; join requests, invitations, membership
- **Live presence** — who is in the room updates in realtime
- **Live chat** — messages (and optional attachments) over Socket.IO, persisted in MongoDB
- **Notifications** — friends, room invites/requests via personal socket events
- **Same-origin Docker setup** — nginx serves the Vue build and proxies `/api` + `/socket.io`
- **Postman collection** — ready-to-import API flows under [`postman/`](postman/)

---

## Tech stack

| Layer | Choice |
|-------|--------|
| Frontend | Vue 3, Vite |
| Backend | Node.js, Express |
| Database | MongoDB |
| Realtime | Socket.IO |
| Auth | JWT access token + refresh cookie rotation |
| Deploy (local) | Docker Compose, nginx |

---

## Architecture

```text
browser :8080
   │
   ▼
client (nginx) ── /api, /socket.io ──▶ server (Node) ──▶ mongo
   │                                    │
   └── static Vue build                 └── port 3000 (internal)
```

- The browser only talks to nginx → **same-origin** API and refresh cookie (first-party `httpOnly`).
- nginx proxies `/api/` and `/socket.io/` (including WebSocket upgrade) to the `server` service.
- MongoDB is bound to `127.0.0.1:27017` on the host for local dev; not exposed off-machine.
- Server image runs production deps only as a non-root user; client image is a static nginx build.

### Realtime flow

1. Client connects to Socket.IO with the access token (`auth.token`).
2. Client emits `room:join` → server joins a socket room and broadcasts presence.
3. Client emits `chat:send` → server saves to MongoDB and emits `chat:message` to the room.
4. On leave / disconnect → presence updates for everyone still in the room.
5. `presence:online` keeps the friends list’s online indicators in sync.

---

## Quick start (Docker)

```bash
git clone https://github.com/abdelbar472/live-study-room.git
cd live-study-room

cp .env.example .env
# set a real JWT_SECRET, e.g.
# node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

npm run docker:up
```

Open **http://localhost:8080**

```bash
npm run docker:logs    # follow logs
npm run docker:down    # stop (volume kept)
npm run docker:reset   # stop and delete Mongo volume
```

---

## Local development

Run Mongo in Docker; API and Vite on the host:

```bash
docker compose up -d mongo
npm run install:all
npm run dev
```

- API: http://localhost:3000
- Client: http://localhost:5173

Vite proxies `/api` and `/socket.io` to the API so auth cookies and sockets behave like production.

---

## Configuration

Copy `.env.example` → `.env`. Important variables:

| Variable | Default | Notes |
|----------|---------|--------|
| `JWT_SECRET` | — | **Required.** Use a long random string. |
| `CLIENT_PORT` | `8080` | Host port for the nginx client. |
| `ACCESS_TOKEN_TTL` | `15m` | Short-lived bearer token. |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Rotating refresh cookie lifetime. |
| `COOKIE_SECURE` | `false` | Set `true` behind HTTPS. |
| `COOKIE_SAME_SITE` | `lax` | Keep `lax` for same-origin. |
| `VITE_API_URL` | empty | Only for split deployments (needs client rebuild). |
| `CLIENT_ORIGIN` | `http://localhost:8080` | CORS / cookie related origin when needed. |

---

## Auth

| Endpoint | Behavior |
|----------|----------|
| `POST /api/auth/register` | Create user → access token + refresh cookie |
| `POST /api/auth/login` | Same as register response shape |
| `POST /api/auth/refresh` | Rotate refresh token; reuse of a revoked token invalidates the chain |
| `POST /api/auth/logout` | Revoke chain + clear cookie |
| `GET /api/auth/me` | Current user profile |

- Access token: `Authorization: Bearer <token>` (REST + Socket.IO `auth.token`).
- Refresh cookie: `httpOnly`, path `/api/auth`.

Postman: [`postman/`](postman/README.md).

---

## Features and API

All routes below require `Authorization: Bearer <access token>` unless noted.

### Profiles

- `GET /api/auth/me` and `GET /api/users/:id` — extended profile (`bio`, `statusText`, `avatarColor`, online flag)
- `PATCH /api/users/me` — update `name`, `bio`, `statusText`, `avatarColor`
- `GET /api/users/search?q=...` — search by name or email; includes relationship (`none`, `incoming`, `outgoing`, `friend`)

### Friends

- `GET /api/friends` — accepted friends with live online status
- `GET /api/friends/requests` — incoming and outgoing requests
- `POST /api/friends/requests` — body `{ "userId": "..." }`
- `POST /api/friends/requests/:id/accept` or `.../decline`
- `DELETE /api/friends/requests/:id` — cancel outgoing request
- `DELETE /api/friends/:userId` — remove a friend

A unique pair key in MongoDB prevents duplicate or reversed friendship documents.

### Rooms

- `GET /api/rooms` — list with `visibility`, `isMember`, `isOwner`, `invited`, `myRequestStatus`, and (for creators) `pendingRequests`
- `POST /api/rooms` — `name`, `description`, `subject`, `visibility` (`public` or `invite`)
- `POST /api/rooms/:id/join` — join public room, or invite-only with a pending invitation
- `POST /api/rooms/:id/join-requests` — ask to join invite-only room (optional `{ "message": "..." }`)
- `GET /api/rooms/join-requests` / `GET /api/rooms/:id/join-requests` — creator views pending requests
- `POST /api/rooms/:id/join-requests/:requestId/accept` or `.../decline`
- `POST /api/rooms/:id/invitations` — creator invites `{ "userId": "..." }`
- `GET /api/rooms/invitations` — current user’s pending invitations
- `POST /api/rooms/invitations/:id/accept` or `.../decline`

### Socket.IO

- `room:join` / `room:leave` → `presence:update` for people in that room
- `presence:online` → `{ userIds, count }` for friends-list online dots
- `chat:send` → `{ roomId, text, attachment }` → members receive `chat:message`
- Personal events: `friends:updated`, `room:invitations:updated`, `room:requests:updated`, `rooms:updated`, `notification`

### Attachments

- `POST /api/rooms/:id/attachments` — JSON base64 data URL `{ name, type, data }` from a room member
- Max **5 MB**; safe MIME allowlist (images, PDF, text, Office, ZIP, MP3/MP4)
- Response `{ name, type, size, url }`; client attaches that to the chat message
- Stored in `server/uploads` locally and the `study-room-uploads` Docker volume in Compose

---

## Project structure

```text
live-study-room/
├── client/              # Vue 3 + Vite
├── server/              # Express + Socket.IO + MongoDB
├── postman/             # API collection
├── docker-compose.yml
├── .env.example
└── package.json         # root scripts (dev, docker:*)
```

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run install:all` | Install server + client deps |
| `npm run dev` | API + Vite concurrently |
| `npm run build` | Build Vue client |
| `npm run docker:up` | Build and start full stack |
| `npm run docker:down` | Stop containers |
| `npm run docker:logs` | Tail logs |
| `npm run docker:reset` | Stop and remove volumes |

---

## License

MIT © Khaled Abdelbar — see [LICENSE](LICENSE).
