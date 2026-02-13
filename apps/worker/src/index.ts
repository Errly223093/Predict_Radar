import "dotenv/config";
import { config } from "./config.js";
import { pool, runMigrations } from "./db.js";
import { KalshiAdapter } from "./providers/kalshi.js";
import { OpinionAdapter } from "./providers/opinion.js";
import { PolymarketAdapter } from "./providers/polymarket.js";
import { runAlerts } from "./tasks/alerts.js";
import { runClassification } from "./tasks/classification.js";
import { runDeltaComputation } from "./tasks/deltas.js";
import { runMarketProfiling } from "./tasks/market-profiles.js";
import { runSnapshotIngestion } from "./tasks/snapshot.js";

const adapters = [new PolymarketAdapter(), new KalshiAdapter(), new OpinionAdapter()];

let running = false;

async function cycle(): Promise<void> {
  if (running) {
    console.warn("[worker] skipping cycle: previous cycle still running");
    return;
  }

  running = true;
  const startedAt = Date.now();

  try {
    const snapshot = await runSnapshotIngestion(adapters);
    const profiled = await runMarketProfiling();
    const deltaRows = await runDeltaComputation();
    const classRows = await runClassification();
    const alertCount = await runAlerts();

    const elapsedMs = Date.now() - startedAt;
    console.info(
      `[worker] ts=${snapshot.tsMinute.toISOString()} snapshots=${snapshot.snapshotCount} profiles=${profiled} deltas=${deltaRows} classifications=${classRows} alerts=${alertCount} elapsed_ms=${elapsedMs}`
    );
  } catch (error) {
    console.error("[worker] cycle failed", error);
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  await runMigrations();
  console.info("[worker] migration complete");

  await cycle();
  setInterval(cycle, config.WORKER_LOOP_INTERVAL_MS);
}

main().catch((error) => {
  console.error("[worker] fatal error", error);
  pool
    .end()
    .catch(() => undefined)
    .finally(() => process.exit(1));
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.info(`[worker] received ${signal}, shutting down`);
    pool
      .end()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
}
