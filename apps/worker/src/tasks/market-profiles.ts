import { pool } from "../db.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMarketText } from "../utils/market-text.js";
import {
  AnchorNbModel,
  anchorTypeInsiderPossible,
  loadAnchorNbModel,
  type AnchorType
} from "../ml/anchor-nb.js";

type MarketRow = {
  provider: string;
  market_id: string;
  title: string;
  normalized_category: string;
  metadata_json: Record<string, unknown> | null;
};

const RULES_MODEL_VERSION = "anchor-rules-v1";
const HYBRID_MODEL_VERSION = "anchor-hybrid-nb-v1";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODEL_PATH = path.resolve(__dirname, "../../models/anchor-nb-v1.json");

let cachedModel: AnchorNbModel | null = null;
let lastModelCheckMs = 0;

async function getModel(): Promise<AnchorNbModel | null> {
  const now = Date.now();
  if (cachedModel && now - lastModelCheckMs < 10 * 60_000) return cachedModel;
  if (!cachedModel && now - lastModelCheckMs < 60_000) return cachedModel;

  lastModelCheckMs = now;
  const loaded = await loadAnchorNbModel(MODEL_PATH);
  if (loaded) {
    cachedModel = loaded;
    console.info(`[profiles] loaded ${loaded.modelVersion} vocab=${loaded.vocab.length}`);
    return cachedModel;
  }

  if (cachedModel) {
    // Keep the previous model if the file temporarily disappears.
    return cachedModel;
  }

  return null;
}

const CRYPTO_KEYWORDS = [
  "btc",
  "bitcoin",
  "eth",
  "ethereum",
  "sol",
  "solana",
  "crypto",
  "token",
  "altcoin"
];

const PRICE_ANCHOR_KEYWORDS = ["above", "below", "over", "under", "at least", ">=", "<=", "$"];

const SPORTS_KEYWORDS = [
  "vs",
  "mlb",
  "nba",
  "nfl",
  "nhl",
  "soccer",
  "football",
  "baseball",
  "basketball",
  "tennis",
  "match",
  "game",
  "quarter",
  "inning",
  "halftime",
  "overtime"
];

const LIVE_SCORE_PATTERNS: RegExp[] = [
  /\b(over|under)\s+\d+(\.\d+)?\b/i,
  /\b(points?|runs?|goals?|rebounds?|assists?|yards?)\b/i,
  /\bwins?\s+by\b/i,
  /\bspread\b/i,
  /\bscore\b/i,
  // Props/lines like "LeBron James: 3+"
  /:\s*\d+\+\b/
];

const TEAM_NEWS_PATTERNS: RegExp[] = [
  /\binjur(y|ies|ed)\b/i,
  /\bquestionable\b/i,
  /\bprobable\b/i,
  /\bdoubtful\b/i,
  /\bruled\s+out\b/i,
  /\b(out\s+for|out\s+tonight|will\s+play)\b/i,
  /\bstarting\s+lineup\b/i,
  /\b(trade|traded|waiv(e|ed)|sign(ed|ing)|suspend(ed|ed))\b/i
];

const MACRO_PATTERNS: RegExp[] = [
  /\bcpi\b/i,
  /\bfomc\b/i,
  /\bnonfarm\b/i,
  /\bpayrolls?\b/i,
  /\bgdp\b/i,
  /\bfed\b/i,
  /\brate\s+(cut|hike)\b/i,
  /\binflation\b/i
];

const POLICY_PATTERNS: RegExp[] = [
  /\b(sec|cftc)\b/i,
  /\betf\b/i,
  /\bregulat(ion|ory)\b/i,
  /\blaw(suit)?\b/i,
  /\bcourt\b/i,
  /\bban(ned)?\b/i,
  /\bbill\b/i,
  /\bvot(e|ing)\b/i
];

const CRYPTO_NEWS_PATTERNS: RegExp[] = [
  /\bhack(ed|ing)?\b/i,
  /\bexploit\b/i,
  /\bbreach\b/i,
  /\bairdrop\b/i,
  /\b(listing|listed|delist|delisted)\b/i,
  /\bmainnet\b/i,
  /\bupgrade\b/i,
  /\bhard\s+fork\b/i,
  /\bbridge\b/i,
  /\betf\b/i,
  /\bsec\b/i
];

function includesAny(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => text.includes(kw));
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function classifyAnchor(row: MarketRow, model: AnchorNbModel | null): { anchorType: AnchorType; insiderPossible: boolean; confidence: number } {
  const text = buildMarketText(row.title ?? "", row.metadata_json);
  const category = String(row.normalized_category ?? "").toLowerCase();
  const provider = String(row.provider ?? "").toLowerCase();

  const isCryptoContext = category === "crypto" || includesAny(text, CRYPTO_KEYWORDS);
  const isSportsContext = category === "sports" || includesAny(text, SPORTS_KEYWORDS);

  // 1) Spot-price anchored (crypto + price threshold language / numeric hints).
  if (isCryptoContext) {
    const hasPriceWords = includesAny(text, PRICE_ANCHOR_KEYWORDS);
    const hasNumbers = /\d/.test(text);
    if (hasPriceWords && hasNumbers) {
      return {
        anchorType: "spot_price_anchored",
        insiderPossible: false,
        confidence: 0.95
      };
    }
  }

  // 2) Live-score anchored (in-play sports lines / props).
  if (isSportsContext && matchesAny(text, LIVE_SCORE_PATTERNS) && !matchesAny(text, TEAM_NEWS_PATTERNS)) {
    return {
      anchorType: "live_score_anchored",
      insiderPossible: false,
      confidence: 0.95
    };
  }

  // 3) ML model (only if confident enough). We keep hard gates above for precision.
  if (model) {
    const enriched = `${text} category=${category} provider=${provider}`;
    const prediction = model.predict(enriched);
    const confidence = prediction.confidence;

    let anchorType = prediction.anchorType;
    if (anchorType === "spot_price_anchored" && !isCryptoContext) anchorType = "other_unknown";
    if (anchorType === "live_score_anchored" && !isSportsContext) anchorType = "other_unknown";

    if (confidence >= 0.55) {
      return {
        anchorType,
        insiderPossible: anchorTypeInsiderPossible(anchorType),
        confidence
      };
    }
  }

  // 3) Macro scheduled releases.
  if (matchesAny(text, MACRO_PATTERNS)) {
    return {
      anchorType: "scheduled_macro_release",
      insiderPossible: true,
      confidence: 0.8
    };
  }

  // 4) Crypto news / security / regulatory events.
  if (isCryptoContext && matchesAny(text, CRYPTO_NEWS_PATTERNS) && !matchesAny(text, LIVE_SCORE_PATTERNS)) {
    return {
      anchorType: "crypto_news_security",
      insiderPossible: true,
      confidence: 0.8
    };
  }

  // 5) Sports team/news events (injury/trade/lineup).
  if (isSportsContext && matchesAny(text, TEAM_NEWS_PATTERNS)) {
    return {
      anchorType: "sports_team_news",
      insiderPossible: true,
      confidence: 0.8
    };
  }

  // 6) General policy/regulatory decisions.
  if (matchesAny(text, POLICY_PATTERNS)) {
    return {
      anchorType: "policy_regulatory_decision",
      insiderPossible: true,
      confidence: 0.65
    };
  }

  return {
    anchorType: "other_unknown",
    insiderPossible: true,
    confidence: 0.3
  };
}

export async function runMarketProfiling(options?: { limit?: number }): Promise<number> {
  const limit = Math.max(50, Math.min(2000, options?.limit ?? 600));
  const model = await getModel();
  const desiredModelVersion = model ? HYBRID_MODEL_VERSION : RULES_MODEL_VERSION;

  const query = model
    ? `
      SELECT
        m.provider,
        m.market_id,
        m.title,
        m.normalized_category,
        m.metadata_json
      FROM markets m
      LEFT JOIN market_profiles p
        ON p.provider = m.provider
       AND p.market_id = m.market_id
      WHERE p.provider IS NULL
         OR p.model_version <> $1
      ORDER BY m.provider, m.market_id
      LIMIT $2::int
    `
    : `
      SELECT
        m.provider,
        m.market_id,
        m.title,
        m.normalized_category,
        m.metadata_json
      FROM markets m
      LEFT JOIN market_profiles p
        ON p.provider = m.provider
       AND p.market_id = m.market_id
      WHERE p.provider IS NULL
      ORDER BY m.provider, m.market_id
      LIMIT $1::int
    `;

  const params = model ? [desiredModelVersion, limit] : [limit];
  const rows = await pool.query<MarketRow>(query, params);

  let upserted = 0;

  for (const row of rows.rows) {
    const profile = classifyAnchor(row, model);

    await pool.query(
      `
        INSERT INTO market_profiles (
          provider,
          market_id,
          anchor_type,
          insider_possible,
          confidence,
          model_version,
          updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6, now())
        ON CONFLICT (provider, market_id)
        DO UPDATE SET
          anchor_type = EXCLUDED.anchor_type,
          insider_possible = EXCLUDED.insider_possible,
          confidence = EXCLUDED.confidence,
          model_version = EXCLUDED.model_version,
          updated_at = EXCLUDED.updated_at
      `,
      [
        row.provider,
        row.market_id,
        profile.anchorType,
        profile.insiderPossible,
        profile.confidence,
        desiredModelVersion
      ]
    );

    upserted += 1;
  }

  return upserted;
}
