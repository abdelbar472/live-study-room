# Live Study Room — Postman

Import both files into Postman:

- `Live Study Room.postman_collection.json`
- `Live Study Room - Local.postman_environment.json`

Then select the **Live Study Room - Local** environment and run `Auth > Login`.

## How auth works here

- `login` / `register` return a **15 minute** access token and set an `httpOnly` refresh cookie (path-scoped to `/api/auth`).
- The collection stores the access token in `{{accessToken}}` and sends it as a Bearer token.
- A collection-level pre-request script decodes the JWT and calls `POST /api/auth/refresh` when it is missing or about to expire. Concurrent manual requests are not an issue here, but the app itself uses a single-flight refresh.
- `refresh` rotates the token: the old one is revoked and a new one is issued. Replaying a revoked token revokes the whole login chain.
- `logout` revokes the chain and clears the cookie.

## Caveats

- The refresh token is a cookie, so **Send cookies** must stay enabled (Settings → General). Use `http://localhost:3000` consistently — `127.0.0.1` is a different host and will not send the cookie.
- Exporting the collection does not export cookies. Log in again after importing on a new machine.
- Never commit a real `JWT_SECRET` or an exported cookie jar.
- Socket.IO auth is not testable in Postman; the client passes the same access token as `auth.token` in the handshake.
