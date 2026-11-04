# Live Study Room — Postman

Import one file:

- `Live Study Room.postman_collection.json`

No separate environment is needed. The collection carries all variables, so it
works immediately after import.

## Quick start

1. Import the collection.
2. Leave `baseUrl` at **`http://localhost:8080`** when using Docker Compose.
   Change it to `http://localhost:3000` only when the API runs directly with
   `npm run dev`.
3. Run **Setup (A and B)** first. It creates or logs in two demo users and saves
   both access tokens.
4. Run the other folders in order, or run the whole collection once. Requests
   that act as user B already use `{{accessTokenB}}`.

If an older `Live Study Room - Local` environment is still selected in Postman,
it can override the collection's `baseUrl`. Delete that environment, or set its
`baseUrl` to `http://localhost:8080`.

## Demo users

| User | Email | Password | Role |
| --- | --- | --- | --- |
| A | `postman.alpha@example.com` | `password123` | Active user: creates rooms, sends the first friend request, approves join requests |
| B | `postman.beta@example.com` | `password123` | Second user: accepts requests/invitations, asks to join |

Change `nameA` / `emailA` / `passwordA` and `nameB` / `emailB` / `passwordB` in
the collection variables to use your own accounts. Login A stores the active
token in `{{accessToken}}`; Login B stores its token in `{{accessTokenB}}`.

Running the collection again is safe: Register accepts `201` or `409`, and the
friend flow cleans up any previous friendship before starting.

## Folder map

- **Setup (A and B)** — register/login both users, refresh, profile update, user
  search, and public profile.
- **Friends** — send, list, accept, remove, decline, and cancel friend requests.
- **Rooms and Invitations** — public room join, invite-only room invitation,
  accept, and decline.
- **Join Requests** — ask to join, list all/one room, accept, and decline.
- **Attachments** — upload a base64 data URL and download it through nginx.
- **Session** — logout and clear the saved tokens.

## Auth notes

- `register` / `login` return a **15-minute** access token and set an `httpOnly`
  refresh cookie (path `/api/auth`).
- The collection sends the active token as a Bearer token.
- A collection-level pre-request script decodes the JWT and calls
  `POST /api/auth/refresh` when the active token is missing or about to expire.
- `refresh` rotates the token: the old one is revoked and a new one is issued.
  Replaying a revoked token revokes the whole login chain.
- `logout` revokes the chain and clears the cookie.
- The refresh cookie is shared per host, so `Refresh` and `Logout` depend on the
  most recent login. All other requests use bearer tokens and do not depend on
  the cookie.

## Caveats

- **Send cookies** must stay enabled for `Refresh` and `Logout` (Settings →
  General). Use one host consistently — `localhost` and `127.0.0.1` are
  different hosts for cookies.
- Exporting the collection does not export cookies. Log in again after importing
  on a new machine.
- Never commit a real `JWT_SECRET` or an exported cookie jar.
- Socket.IO cannot be tested in Postman; the client passes the same access token
  as `auth.token` in the handshake.
- Attachment upload expects a base64 data URL in `attachmentData`. The default
  is a small text file; the API accepts images, PDF, text, Office files, ZIP,
  MP3, and MP4 up to 5 MB.
