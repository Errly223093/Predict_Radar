import { WINDOWS, type WindowKey } from "@predict-radar/shared";
import { config } from "../config.js";
import { pool } from "../db.js";
import { sendTelegramMessage } from "../integrations/telegram.js";

const ALERT_THRESHOLDS: Record<WindowKey, number> = {
  "1m": 6,
  "5m": 8,
  "10m": 10,
  "30m": 14,
  "1h": 18,
  "6h": 24,
  "12h": 30,
  "24h": 38
};

type AlertRow = {
  ts_minute: Date;
  provider: string;
  market_id: string;
  outcome_id: string;
  title: string;
  outcome_label: string;
  probability: number;
  liquidity_usd: number | null;
  volume_24h_usd: number | null;
  label: string;
  reason_tags: string[];
  delta_1m: number | null;
  delta_5m: number | null;
  delta_10m: number | null;
  delta_30m: number | null;
  delta_1h: number | null;
  delta_6h: number | null;
  delta_12h: number | null;
  delta_24h: number | null;
};

function extractDelta(row: AlertRow, window: WindowKey): number | null {
  switch (window) {
    case "1m":
      return row.delta_1m;
    case "5m":
      return row.delta_5m;
    case "10m":
      return row.delta_10m;
    case "30m":
      return row.delta_30m;
    case "1h":
      return row.delta_1h;
    case "6h":
      return row.delta_6h;
    case "12h":
      return row.delta_12h;
    case "24h":
      return row.delta_24h;
    default:
      return null;
  }
}

function pickBestTriggeredWindow(row: AlertRow): { window: WindowKey; delta: number } | null {
  let best: { window: WindowKey; delta: number; score: number } | null = null;

  for (const window of WINDOWS) {
    const delta = extractDelta(row, window);
    if (delta === null) continue;

    const absDelta = Math.abs(delta);
    const threshold = ALERT_THRESHOLDS[window];
    if (absDelta < threshold) continue;

    const score = absDelta / threshold;
    if (!best || score > best.score) {
      best = { window, delta, score };
    }
  }

  return best ? { window: best.window, delta: best.delta } : null;
}

async function canSend(signature: string): Promise<boolean> {
  const cooldownMinutes = config.TELEGRAM_COOLDOWN_MINUTES;
  const result = await pool.query<{ last_sent_at: Date }>(
    `SELECT last_sent_at FROM alert_state WHERE signature = $1`,
    [signature]
  );

  if (result.rowCount === 0) return true;

  const lastSentAt = result.rows[0].last_sent_at.getTime();
  const elapsedMinutes = (Date.now() - lastSentAt) / 60_000;
  return elapsedMinutes >= cooldownMinutes;
}

async function markSent(signature: string): Promise<void> {
  await pool.query(
    `
      INSERT INTO alert_state (signature, last_sent_at)
      VALUES ($1, now())
      ON CONFLICT (signature)
      DO UPDATE SET last_sent_at = EXCLUDED.last_sent_at
    `,
    [signature]
  );
}

export async function runAlerts(): Promise<number> {
  const latestTsResult = await pool.query<{ ts: Date | null }>(
    `SELECT MAX(ts_minute) AS ts FROM classification_scores`
  );
  const ts = latestTsResult.rows[0]?.ts;
  if (!ts) return 0;

  const rows = await pool.query<AlertRow>(
    `
      SELECT
        d.ts_minute,
        d.provider,
        d.market_id,
        d.outcome_id,
        m.title,
        o.label AS outcome_label,
        s.probability,
        s.liquidity_usd,
        s.volume_24h_usd,
        c.label,
        c.reason_tags,
        d.delta_1m,
        d.delta_5m,
        d.delta_10m,
        d.delta_30m,
        d.delta_1h,
        d.delta_6h,
        d.delta_12h,
        d.delta_24h
      FROM classification_scores c
      JOIN deltas d
        ON d.ts_minute = c.ts_minute
       AND d.provider = c.provider
       AND d.market_id = c.market_id
       AND d.outcome_id = c.outcome_id
      JOIN snapshots_1m s
        ON s.ts_minute = c.ts_minute
       AND s.provider = c.provider
       AND s.market_id = c.market_id
       AND s.outcome_id = c.outcome_id
      JOIN markets m
        ON m.provider = c.provider
       AND m.market_id = c.market_id
      JOIN outcomes o
        ON o.provider = c.provider
       AND o.market_id = c.market_id
       AND o.outcome_id = c.outcome_id
      WHERE c.ts_minute = $1
        AND c.label = 'opaque_info_sensitive'
        AND COALESCE(s.liquidity_usd, 0) >= $2
        AND COALESCE(s.spread_pp, 100) <= $3
      ORDER BY ABS(COALESCE(d.delta_1m, 0)) DESC
      LIMIT 500
    `,
    [ts, config.MIN_LIQUIDITY_USD, config.MAX_SPREAD_PP]
  );

  let sentCount = 0;

  for (const row of rows.rows) {
    const bestWindow = pickBestTriggeredWindow(row);
    if (!bestWindow) continue;

    const direction = bestWindow.delta >= 0 ? "UP" : "DOWN";
    const signature = `${row.provider}:${row.market_id}:${row.outcome_id}:${bestWindow.window}:${direction}`;
    const allowed = await canSend(signature);
    if (!allowed) continue;

    const text = [
      "Prediction Radar Alert",
      `Provider: ${row.provider}`,
      `Market: ${row.title}`,
      `Outcome: ${row.outcome_label}`,
      `Prob: ${(row.probability * 100).toFixed(1)}%`,
      `Delta (${bestWindow.window}): ${bestWindow.delta >= 0 ? "+" : ""}${bestWindow.delta.toFixed(2)}pp`,
      `Label: ${row.label}`,
      `Reasons: ${row.reason_tags.join(", ") || "none"}`,
      `Time: ${row.ts_minute.toISOString()}`
    ].join("\n");

    await sendTelegramMessage(text);
    await markSent(signature);
    sentCount += 1;
  }

  return sentCount;
}
