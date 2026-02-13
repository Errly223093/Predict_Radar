import { fetchExternalSignals } from "./external-signals.js";
import { pool } from "../db.js";
import { isCryptoLinked, isSportsLinked } from "../utils/normalize.js";

type ClassificationInputRow = {
  ts_minute: Date;
  provider: string;
  market_id: string;
  outcome_id: string;
  title: string;
  normalized_category: string;
  spread_pp: number | null;
  volume_24h_usd: number | null;
  liquidity_usd: number | null;
  delta_1m: number | null;
  delta_24h: number | null;
};

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export async function runClassification(): Promise<number> {
  const latestTsResult = await pool.query<{ ts: Date | null }>(
    `SELECT MAX(ts_minute) AS ts FROM deltas`
  );
  const ts = latestTsResult.rows[0]?.ts;
  if (!ts) return 0;

  const latestRows = await pool.query<ClassificationInputRow>(
    `
      SELECT
        d.ts_minute,
        d.provider,
        d.market_id,
        d.outcome_id,
        m.title,
        m.normalized_category,
        s.spread_pp,
        s.volume_24h_usd,
        s.liquidity_usd,
        d.delta_1m,
        d.delta_24h
      FROM deltas d
      JOIN markets m
        ON m.provider = d.provider
       AND m.market_id = d.market_id
      JOIN snapshots_1m s
        ON s.ts_minute = d.ts_minute
       AND s.provider = d.provider
       AND s.market_id = d.market_id
       AND s.outcome_id = d.outcome_id
      WHERE d.ts_minute = $1
    `,
    [ts]
  );

  const external = await fetchExternalSignals();

  for (const row of latestRows.rows) {
    let opaqueScore = 20;
    let exogenousScore = 10;
    const reasonTags: string[] = [];

    const title = row.title ?? "";
    const abs1m = Math.abs(row.delta_1m ?? 0);

    if (row.normalized_category === "sports" || isSportsLinked(title)) {
      exogenousScore += 45;
      reasonTags.push("sports_live_market");
    }

    const isCrypto = row.normalized_category === "crypto" || isCryptoLinked(title);
    if (isCrypto) {
      exogenousScore += 30;
      reasonTags.push("crypto_price_linked");

      const move = Math.max(Math.abs(external.btc1mPct ?? 0), Math.abs(external.eth1mPct ?? 0));
      if (move >= 0.8) {
        exogenousScore += 20;
        reasonTags.push("spot_price_shock");
      }
    }

    if (["politics", "policy", "macro", "other"].includes(row.normalized_category)) {
      opaqueScore += 20;
      reasonTags.push("opaque_info_prone_category");
    }

    if ((row.volume_24h_usd ?? 0) >= 10_000 && abs1m >= 4) {
      opaqueScore += 20;
      reasonTags.push("meaningful_size_move");
    }

    if ((row.spread_pp ?? 100) <= 8) {
      opaqueScore += 10;
      reasonTags.push("tight_spread");
    }

    if (abs1m >= 15) {
      exogenousScore += 15;
      reasonTags.push("abrupt_micro_move");
    }

    opaqueScore = clampScore(opaqueScore);
    exogenousScore = clampScore(exogenousScore);

    const label =
      opaqueScore >= exogenousScore && opaqueScore >= 50
        ? "opaque_info_sensitive"
        : exogenousScore >= 50
          ? "exogenous_arbitrage"
          : "unclear";

    await pool.query(
      `
        INSERT INTO classification_scores (
          ts_minute,
          provider,
          market_id,
          outcome_id,
          opaque_score,
          exogenous_score,
          label,
          reason_tags,
          model_version
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'rules-v1')
        ON CONFLICT (ts_minute, provider, market_id, outcome_id)
        DO UPDATE SET
          opaque_score = EXCLUDED.opaque_score,
          exogenous_score = EXCLUDED.exogenous_score,
          label = EXCLUDED.label,
          reason_tags = EXCLUDED.reason_tags,
          model_version = EXCLUDED.model_version
      `,
      [
        row.ts_minute,
        row.provider,
        row.market_id,
        row.outcome_id,
        opaqueScore,
        exogenousScore,
        label,
        reasonTags
      ]
    );
  }

  return latestRows.rowCount ?? 0;
}
