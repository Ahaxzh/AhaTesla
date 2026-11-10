<div align="center">

[![CI](https://github.com/Ahaxzh/AhaTesla/actions/workflows/ci.yml/badge.svg)](https://github.com/Ahaxzh/AhaTesla/actions/workflows/ci.yml)
[![Docker](https://github.com/Ahaxzh/AhaTesla/actions/workflows/docker.yml/badge.svg)](https://github.com/Ahaxzh/AhaTesla/actions/workflows/docker.yml)
[![ghcr](https://img.shields.io/badge/ghcr-ahaxzh%2Fahatesla-blue)](https://github.com/Ahaxzh/AhaTesla/pkgs/container/ahatesla)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

# AhaTesla

**Self-hosted Tesla companion — trips, charging costs & a real FIFO energy ledger, with multi-channel push**

[中文](./README.md)

</div>

---

## Features
- 🚗 **Trip log** — distance, energy, route map (**speed-colored trace + hover speeds**), FIFO batch breakdown, gas-car comparison (reads your TeslaMate PostgreSQL, strictly read-only)
- ⚡ **Charging ledger** — per-location pricing from TeslaMate geofences, time-of-use (TOU) rates, batch-allocation algorithm, power curve + charger efficiency, manual cost overrides
- 💰 **Monthly bill** — mileage vs. electricity vs. gas, sentry/parking drain, driving vs. parked cost split
- 📊 **Dashboard** — 24h state timeline, usage heatmap, semantic state cards (driving / charging / sentry / asleep)
- 📄 **Reports** — **daily digest** (yesterday + same-day-last-week comparison + anomaly notes), weekly & monthly reports (immutable archived snapshots)
- 🔔 **Push, your way** — Web Push (works from an **iPhone home-screen PWA**), Telegram, Feishu, WeCom, ntfy, Bark — a 9-event × 6-channel matrix; optionally plug in your own OpenAI-compatible model to polish the copy (off by default; full templates with no model)
- 🌓 **Look & feel** — light/dark/system theme, English & Chinese UI
- 📱 **Web / PWA** — install to your home screen, mobile-first dark UI
- 🔐 **Auth** — single-user JWT with access + refresh tokens, httpOnly cookie, scrypt hashing, lockout on failures

## Quick start (pick one track)

> Run the commands on your **Docker host**; the browser steps happen on your computer/phone.

### Track A · New user (no TeslaMate yet) — one command, full stack

```bash
git clone https://github.com/Ahaxzh/AhaTesla.git && cd AhaTesla

# 1. Generate and fill in 3 secrets (copy-paste commands included in the file, all required)
cp deploy/.env.example.fullstack deploy/.env && vim deploy/.env

# 2. One command brings up everything (AhaTesla + TeslaMate + PostgreSQL + Mosquitto)
docker compose -f deploy/fullstack-compose.yml --profile fullstack up -d --build
```

Then finish setup in the browser (~3 minutes):

1. Open `http://<host-ip>:18500` → register the admin (first registration becomes admin)
   - 18500/4000 bind to 127.0.0.1 by default. If the browser is on another machine, pick one:
     SSH tunnel `ssh -L 18500:127.0.0.1:18500 <host>` (and the same for 4000, needed next),
     a browser on the host itself, or rebind the port mapping to a LAN IP (LAN-only; keep 4000
     tunnel-only — it is TeslaMate's passwordless admin UI and can issue vehicle commands)
2. The wizard walks you to `http://<host-ip>:4000` — sign in to TeslaMate with **your Tesla account** (the only step that leaves the wizard; come back and wait for your car to appear)
3. Confirm the car → ledger/push channels (skippable) → done, the dashboard fills up

### Track B · Already running TeslaMate — 3 steps, zero changes to your stack

```bash
# 1. Check your TeslaMate network name (the official compose default is teslamate_default)
docker network ls | grep teslamate

# 2. Copy the env file (usually fine as-is)
cp deploy/.env.example.connect deploy/.env

# 3. Start (joins your teslamate network and talks to its database directly)
docker compose -f deploy/connect-compose.yml up -d --build
```

Open `http://<host-ip>:18500` and pick **"I already have TeslaMate"** in the wizard:

1. Enter your teslamate DB password (the `DATABASE_PASS` in your TeslaMate `docker-compose.yml` / `.env`; username defaults to `teslamate`)
2. AhaTesla **creates a read-only account for itself** and runs the four checks: reachable → auth → read-only safety → car discovery
3. Multi-car households pick the car(s) next → done

**When things don't line up** (the wizard shows the same hints inline):

| Situation | What to do |
|---|---|
| Auto-creating the read-only account fails (permissions…) | The wizard shows **copy-paste SQL** — run it in any psql that can reach the DB (e.g. `docker compose -f <your-teslamate>/docker-compose.yml exec database psql -U teslamate -d teslamate`), then hit "I've run it" |
| Network isn't named `teslamate_default` | `docker network connect <your-network> ahatesla-app`, or edit `networks.teslamate.name` in connect-compose.yml |
| TeslaMate lives on another machine | Set `DB_URL=postgres://...@<that-ip>:5432/teslamate` in `deploy/.env` (its 5432 must be reachable) and drop the teslamate network block from the compose file |
| Read-only check fails (you pasted an admin account) | Working as intended — AhaTesla refuses writable credentials; go back and use auto-provisioning |

### After deploying: iPhone notifications (optional)

Point any HTTPS reverse proxy (NPM, Caddy…) at 18500 → open in Safari → Share → Add to Home Screen → enable Web Push on the Push page (iOS ≥ 16.4). See [`deploy/NPM-SETUP.md`](deploy/NPM-SETUP.md).

### Try it first: Demo mode (no Tesla, no database)

```bash
AHATESLA_DEMO=1 PORT=18590 node server/src/index.mjs
# open http://127.0.0.1:18590 → register an admin at /setup → the dashboard shows 90 days of synthetic data
```

- Trips, charging, ledger, heatmap and reports all browseable (fixed-seed synthetic data, deliberately low-precision coordinates)
- The route map is an empty state (no million-row position synthesis); push channels and the AI assistant can be **configured for real**
- API contract unchanged; `/api/system/status` reports `demo: true`

## Architecture

```
Tesla (car) ←→ TeslaMate (protocol/tokens) → PostgreSQL ←read-only─ AhaTesla server (:18500)
                                                        ↘ Mosquitto MQTT (optional, faster events)
server/ Node22 ESM (API + JWT + static hosting + push engine) ← web/ React19+Vite+TS+Tailwind+PWA
```

- **Strictly read-only** access to the teslamate database (dedicated account + an active startup probe that the account really can't write)
- AhaTesla's own data (account / push rules / price history / secrets) lives in local SQLite; secrets encrypted at rest with AES-256-GCM
- No public backend, no telemetry, and never any vehicle commands

## Testing
- `server`: `npm test` — unit tests (pricing ledger / API routes / auth / push engine); `node --test test/live` for read-only tests against a real DB
- `web`: `npm test` — vitest component tests (every page/button, both viewports), `npm run build`
- E2E: Playwright, see `e2e/`

### Running e2e (Playwright)

One-liner (recommended — handles password injection and the isolated /setup instance):

```bash
bash scripts/run-e2e.sh          # regular cases + setup-wizard cases
```

Or drive the password-injection flow manually (against a persistent instance):

```bash
AHATESLA_E2E_PASSWORD='e2e-tmp-password' node scripts/e2e-reset-password.mjs   # inject (auto-backup)
cd server && npm start                                                          # restart to apply
AHATESLA_E2E_PASSWORD='e2e-tmp-password' npm run test:e2e                        # run
node scripts/e2e-reset-password.mjs --restore                                   # restore (restart again)
```

The script is idempotent: repeated injections never overwrite the original backup; `--restore` exits safely with no backup; passwords are never printed. See `--help`.

## Layout
```
server/  Node backend     web/ React frontend
deploy/  compose×3 + Dockerfile + SQL + NPM guide   docs/  contract & architecture (source of truth: API_CONTRACT.md)
e2e/     Playwright      scripts/ tooling
```

## Security posture
Read-only teslamate access · no vehicle commands · VIN/GPS/tokens never in logs or Git · secrets AES-GCM encrypted at rest · no public backend, no telemetry. See [SECURITY.md](SECURITY.md).

## License
[MIT](LICENSE)
