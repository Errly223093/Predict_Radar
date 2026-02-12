import type { OutcomeSnapshot } from "@predict-radar/shared";
import { pool, toMinute } from "../db.js";
import type { ProviderAdapter } from "../providers/base.js";

async function upsertSnapshot(snapshot: OutcomeSnapshot): Promise<void> {
  await pool.query(
    `
      INSERT INTO markets (
        provider, market_id, title, raw_category, normalized_category, status, metadata_json, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, 'open', '{}'::jsonb, now())
      ON CONFLICT (provider, market_id)
      DO UPDATE SET
        title = EXCLUDED.title,
        raw_category = EXCLUDED.raw_category,
        normalized_category = EXCLUDED.normalized_category,
        updated_at = now()
    `,
    [
      snapshot.provider,
      snapshot.marketId,
      snapshot.marketTitle,
      snapshot.rawCategory,
      snapshot.normalizedCategory
    ]
  );

  await pool.query(
    `
      INSERT INTO outcomes (provider, market_id, outcome_id, label, updated_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (provider, market_id, outcome_id)
      DO UPDATE SET label = EXCLUDED.label, updated_at = now()
    `,
    [snapshot.provider, snapshot.marketId, snapshot.outcomeId, snapshot.outcomeLabel]
  );

  await pool.query(
    `
      INSERT INTO snapshots_1m (
        ts_minute,
        provider,
        market_id,
        outcome_id,
        probability,
        spread_pp,
        volume_24h_usd,
        liquidity_usd,
        market_title,
        raw_category,
        normalized_category
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
      )
      ON CONFLICT (ts_minute, provider, market_id, outcome_id)
      DO UPDATE SET
        probability = EXCLUDED.probability,
        spread_pp = EXCLUDED.spread_pp,
        volume_24h_usd = EXCLUDED.volume_24h_usd,
        liquidity_usd = EXCLUDED.liquidity_usd,
        market_title = EXCLUDED.market_title,
        raw_category = EXCLUDED.raw_category,
        normalized_category = EXCLUDED.normalized_category
    `,
    [
      snapshot.timestamp,
      snapshot.provider,
      snapshot.marketId,
      snapshot.outcomeId,
      snapshot.probability,
      snapshot.spreadPp,
      snapshot.volume24hUsd,
      snapshot.liquidityUsd,
      snapshot.marketTitle,
      snapshot.rawCategory,
      snapshot.normalizedCategory
    ]
  );
}

export async function runSnapshotIngestion(adapters: ProviderAdapter[]): Promise<{
  snapshotCount: number;
  tsMinute: Date;
}> {
  const tsMinute = toMinute();
  const allSnapshots: OutcomeSnapshot[] = [];

  for (const adapter of adapters) {
    if (!adapter.enabled) continue;

    try {
      const snapshots = await adapter.fetchSnapshots(tsMinute);
      allSnapshots.push(...snapshots);
      console.info(`[snapshot] ${adapter.name}: ${snapshots.length} snapshots`);
    } catch (error) {
      console.error(`[snapshot] ${adapter.name} failed`, error);
    }
  }

  for (const snapshot of allSnapshots) {
    await upsertSnapshot(snapshot);
  }

  return { snapshotCount: allSnapshots.length, tsMinute };
}
