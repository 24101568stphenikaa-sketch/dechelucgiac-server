# De Che Luc Giac matchmaking server

This Node.js service provides WebSocket matchmaking and relays validated game actions. Player registration, login, profiles, cups, and admin tools are handled by Supabase in the separate web client; this server does not require a database URL.

## Run locally

Requirements: Node.js 18 or later.

```sh
npm ci
npm start
```

The server listens on `PORT` (default `8080`). `GET /health` returns `{"status":"ok"}` for health checks; other HTTP routes return 404. WebSocket clients connect to the server root.

## Matchmaking behavior

- Five queued human players are matched immediately.
- When the oldest queued player has waited 60 seconds, all currently waiting players (up to five) enter one room; empty slots are filled with AI by the clients.
- A client can request an early match with `FORCE_MATCH` or leave the queue with `CANCEL_MATCH`.
- Room members share the same map seed. Validated player/host-AI actions are relayed to other connected clients.

## Deploy on Render

Connect this repository's `main` branch to a Render Web Service. Use `npm ci` as the build command and `npm start` as the start command. Render supplies `PORT`; no `DATABASE_URL` is needed. Configure the web client to connect to the service's WebSocket URL (`wss://...onrender.com`). Use `/health` for the service health check.

Keep the Supabase service-role key out of this repository and browser code. The static web client's Supabase URL and publishable key belong in that separate client project.
