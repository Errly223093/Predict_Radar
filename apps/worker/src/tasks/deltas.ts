import { pool } from "../db.js";

const WINDOW_SPECS = [
  { key: "1m", minutes: 1 },
  { key: "5m", minutes: 5 },
  { key: "10m", minutes: 10 },
  { key: "30m", minutes: 30 },
  { key: "1h", minutes: 60 },
  { key: "6h", minutes: 360 },
  { key: "12h", minutes: 720 },
  { key: "24h", minutes: 1440 }
] as const;

function buildDeltaInsertSql(): string {
  const joins = WINDOW_SPECS.map(
    (window) => `
      LEFT JOIN LATERAL (
        SELECT s2.probability
        FROM snapshots_1m s2
        WHERE s2.provider = b.provider
          AND s2.market_id = b.market_id
          AND s2.outcome_id = b.outcome_id
          AND s2.ts_minute <= b.ts_minute - interval '${window.minutes} minutes'
        ORDER BY s2.ts_minute DESC
        LIMIT 1
      ) w_${window.key} ON TRUE
    `
  ).join("\n");

  const selectDeltas = WINDOW_SPECS.map(
    (window) => `
      CASE
        WHEN w_${window.key}.probability IS NULL THEN NULL
        ELSE ROUND(((b.probability - w_${window.key}.probability) * 100)::numeric, 2)::double precision
      END AS delta_${window.key}
    `
  ).join(",\n");

  const conflictUpdates = WINDOW_SPECS.map(
    (window) => `delta_${window.key} = EXCLUDED.delta_${window.key}`
  ).join(",\n        ");

  return `
    WITH latest AS (
      SELECT MAX(ts_minute) AS ts
      FROM snapshots_1m
    ),
    base AS (
      SELECT s.ts_minute, s.provider, s.market_id, s.outcome_id, s.probability
      FROM snapshots_1m s
      JOIN latest l ON s.ts_minute = l.ts
    )
    INSERT INTO deltas (
      ts_minute,
      provider,
      market_id,
      outcome_id,
      delta_1m,
      delta_5m,
      delta_10m,
      delta_30m,
      delta_1h,
      delta_6h,
      delta_12h,
      delta_24h
    )
    SELECT
      b.ts_minute,
      b.provider,
      b.market_id,
      b.outcome_id,
      ${selectDeltas}
    FROM base b
    ${joins}
    ON CONFLICT (ts_minute, provider, market_id, outcome_id)
    DO UPDATE SET
      ${conflictUpdates}
  `;
}

export async function runDeltaComputation(): Promise<number> {
  const sql = buildDeltaInsertSql();
  const result = await pool.query(sql);
  return result.rowCount ?? 0;
}
