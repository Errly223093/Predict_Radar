# Predict Radar

Free public dashboard for monitoring sharp probability moves in prediction markets.

## V1 Scope

- Live providers: `Polymarket`, `Kalshi`
- `Opinion`: disabled until official API key is granted (`Coming soon` in UI)
- Snapshot cadence: `1 minute`
- Delta windows: `3m`, `9m`, `30m`, `1h`, `3h`, `6h`, `12h`, `24h`
- Tabs: `Opaque-info-sensitive` vs `Exogenous-arbitrage`
- Telegram alerts: single global channel, immediate push, opaque signals only

## Monorepo Layout

- `apps/web`: Next.js dashboard + internal API (`/api/movers`)
- `apps/worker`: ingestion + delta + classification + telegram pipeline
- `packages/shared`: shared types/windows helpers

## Quick Start

### 1) Install

```bash
npm install
```

### 2) Environment

```bash
cp .env.example .env
```

Set at least:

- `DATABASE_URL`
- `TELEGRAM_ENABLED`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (if alerts enabled)

### 3) Start Postgres

```bash
docker compose up -d postgres
```

### 4) Run worker and web

Terminal A:

```bash
npm run dev:worker
```

Terminal B:

```bash
npm run dev:web
```

Web runs on `http://localhost:3000`.

## Internal API

`GET /api/movers`

Query params:

- `providers=polymarket,kalshi`
- `window=3m|9m|30m|1h|3h|6h|12h|24h`
- `sort=asc|desc`
- `tab=opaque|exogenous|all`
- `category=all|crypto|politics|policy|sports|macro|other`
- `includeLowLiquidity=true|false`
- `minLiquidity=5000`
- `maxSpread=15`

## Telegram Alert Logic

- Evaluated every worker cycle.
- Label gate: `opaque_info_sensitive` only.
- Default thresholds (absolute pp):
  - `3m >= 5`, `9m >= 7`, `30m >= 10`, `1h >= 13`
  - `3h >= 18`, `6h >= 22`, `12h >= 28`, `24h >= 36`
- Cooldown: `30 min` on same `(provider, market, outcome, window, direction)`.

## Notes

- Opinion official API is key-protected; this repo keeps adapter wiring but leaves it disabled by default.
- Classification is rules-first with lightweight external signals (Binance spot move).
