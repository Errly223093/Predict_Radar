import { pool } from "../db.js";

type AnchorType =
  | "spot_price_anchored"
  | "live_score_anchored"
  | "scheduled_macro_release"
  | "policy_regulatory_decision"
  | "sports_team_news"
  | "crypto_news_security"
  | "other_unknown";

type MarketRow = {
  provider: string;
  market_id: string;
  title: string;
  normalized_category: string;
  metadata_json: Record<string, unknown> | null;
};

const MODEL_VERSION = "anchor-rules-v1";

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

const PRICE_ANCHOR_KEYWORDS = ["above", "below", "over", "under", "at least", ">= ", "<= ", "$"];

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

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s:$+.-]/gu, " ")
    .trim();
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function marketText(title: string, meta: Record<string, unknown> | null): string {
  const parts: string[] = [title];
  if (meta && typeof meta === "object") {
    if (typeof meta["originalTitle"] === "string") parts.push(String(meta["originalTitle"]));

    const legs = asArray(meta["legs"]);
    for (const leg of legs) {
      const record = (leg ?? {}) as Record<string, unknown>;
      if (typeof record["raw"] === "string") parts.push(record["raw"]);
      else if (typeof record["text"] === "string") parts.push(record["text"]);
    }
  }

  return normalizeText(parts.join(" "));
}

function includesAny(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => text.includes(kw));
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function classifyAnchor(row: MarketRow): { anchorType: AnchorType; insiderPossible: boolean; confidence: number } {
  const text = marketText(row.title ?? "", row.metadata_json);
  const category = String(row.normalized_category ?? "").toLowerCase();

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

  const rows = await pool.query<MarketRow>(
    `
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
      LIMIT $2
    `,
    [MODEL_VERSION, limit]
  );

  let upserted = 0;

  for (const row of rows.rows) {
    const profile = classifyAnchor(row);

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
        MODEL_VERSION
      ]
    );

    upserted += 1;
  }

  return upserted;
}

