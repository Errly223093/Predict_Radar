import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";
import { trainAnchorNbModel, AnchorNbModel, deterministicSplitKey, type AnchorType } from "../ml/anchor-nb.js";
import { buildMarketText } from "../utils/market-text.js";
import { saveAnchorNbModel } from "../ml/anchor-nb.js";

type TrainingRow = {
  provider: string;
  market_id: string;
  title: string;
  normalized_category: string;
  metadata_json: Record<string, unknown> | null;
  anchor_type: string;
};

function asAnchorType(value: string): AnchorType {
  switch (value) {
    case "spot_price_anchored":
    case "live_score_anchored":
    case "scheduled_macro_release":
    case "policy_regulatory_decision":
    case "sports_team_news":
    case "crypto_news_security":
    case "other_unknown":
      return value;
    default:
      return "other_unknown";
  }
}

function prettyPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const rows = await pool.query<TrainingRow>(
    `
      SELECT
        m.provider,
        m.market_id,
        m.title,
        m.normalized_category,
        m.metadata_json,
        p.anchor_type
      FROM markets m
      JOIN market_profiles p
        ON p.provider = m.provider
       AND p.market_id = m.market_id
      WHERE p.anchor_type IS NOT NULL
      ORDER BY m.provider, m.market_id
    `
  );

  const examples = rows.rows.map((row) => {
    const base = buildMarketText(row.title ?? "", row.metadata_json);
    const text = `${base} category=${String(row.normalized_category ?? "").toLowerCase()} provider=${String(row.provider ?? "").toLowerCase()}`;
    return {
      provider: row.provider,
      marketId: row.market_id,
      text,
      anchorType: asAnchorType(row.anchor_type)
    };
  });

  const train: Array<{ text: string; anchorType: AnchorType }> = [];
  const test: Array<{ text: string; anchorType: AnchorType }> = [];

  for (const ex of examples) {
    const bucket = deterministicSplitKey(ex.provider, ex.marketId);
    if (bucket <= 7) train.push({ text: ex.text, anchorType: ex.anchorType });
    else test.push({ text: ex.text, anchorType: ex.anchorType });
  }

  console.info(`[train-anchor] examples=${examples.length} train=${train.length} test=${test.length}`);

  const modelJson = trainAnchorNbModel(train, { maxVocab: 3500, minDf: 3, alpha: 1.0, modelVersion: "anchor-nb-v1" });
  const model = new AnchorNbModel(modelJson);

  // Evaluation on held-out split.
  const labels = model.anchorTypes;
  const index = new Map<string, number>();
  for (let i = 0; i < labels.length; i += 1) index.set(labels[i], i);

  const confusion = Array.from({ length: labels.length }, () => new Array<number>(labels.length).fill(0));
  let correct = 0;

  for (const ex of test) {
    const predicted = model.predict(ex.text).anchorType;
    if (predicted === ex.anchorType) correct += 1;
    const t = index.get(ex.anchorType) ?? 0;
    const p = index.get(predicted) ?? 0;
    confusion[t][p] += 1;
  }

  const accuracy = test.length === 0 ? 0 : correct / test.length;
  console.info(`[train-anchor] heldout_accuracy=${prettyPct(accuracy)}`);

  for (let i = 0; i < labels.length; i += 1) {
    const total = confusion[i].reduce((sum, v) => sum + v, 0);
    const hit = confusion[i][i] ?? 0;
    if (total === 0) continue;
    console.info(`[train-anchor] class=${labels[i]} accuracy=${prettyPct(hit / total)} support=${total}`);
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const outPath = path.resolve(__dirname, "../../models/anchor-nb-v1.json");
  await saveAnchorNbModel(modelJson, outPath);
  console.info(`[train-anchor] wrote ${outPath} vocab=${modelJson.vocab.length}`);
}

main()
  .catch((error) => {
    console.error("[train-anchor] failed", error);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end().catch(() => undefined);
  });
