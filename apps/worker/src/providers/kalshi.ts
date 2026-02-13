import {
  clampProbability,
  type OutcomeSnapshot,
  type Provider
} from "@predict-radar/shared";
import { normalizeCategory } from "../utils/normalize.js";
import type { ProviderAdapter } from "./base.js";

const KALSHI_ENDPOINTS = [
  "https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=1000",
  "https://api.kalshi.com/trade-api/v2/markets?status=open&limit=1000"
];

type UnknownRecord = Record<string, unknown>;

type MveLegDisplay = { side: "yes" | "no" | null; text: string; raw: string };

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

function centsToProbability(value: unknown): number | null {
  const numeric = toNumber(value);
  if (numeric === null) return null;
  return clampProbability(numeric > 1 ? numeric / 100 : numeric);
}

function centsToQuoteProbability(value: unknown): number | null {
  const numeric = toNumber(value);
  if (numeric === null) return null;
  // Kalshi uses 0/100 as placeholders when no quotes exist (common on inactive markets).
  // Treat them as missing so we don't report a fake 0.00pp spread.
  if (numeric <= 0 || numeric >= 100) return null;
  return clampProbability(numeric / 100);
}

async function fetchOpenMarkets(): Promise<UnknownRecord[]> {
  for (const endpoint of KALSHI_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        headers: { Accept: "application/json" }
      });
      if (!response.ok) continue;
      const json = (await response.json()) as UnknownRecord;
      const markets = json["markets"];
      if (Array.isArray(markets)) return markets as UnknownRecord[];
    } catch {
      // Try next endpoint.
    }
  }

  return [];
}

function buildMveLegs(rawTitle: string): MveLegDisplay[] {
  const parts = rawTitle
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.map((raw) => {
    const lower = raw.toLowerCase();
    if (lower.startsWith("yes ")) {
      return { side: "yes", text: raw.slice(4).trim(), raw };
    }
    if (lower.startsWith("no ")) {
      return { side: "no", text: raw.slice(3).trim(), raw };
    }
    return { side: null, text: raw, raw };
  });
}

export class KalshiAdapter implements ProviderAdapter {
  readonly name: Provider = "kalshi";

  readonly enabled = true;

  async fetchSnapshots(tsMinute: Date): Promise<OutcomeSnapshot[]> {
    const markets = await fetchOpenMarkets();
    const snapshots: OutcomeSnapshot[] = [];

    for (const market of markets) {
      const marketId = String(market["ticker"] ?? market["id"] ?? "");
      if (!marketId) continue;

      const rawTitle = String(market["title"] ?? market["subtitle"] ?? marketId);
      const mveSelectedLegs = Array.isArray(market["mve_selected_legs"])
        ? (market["mve_selected_legs"] as UnknownRecord[])
        : [];
      const collectionTicker = String(market["mve_collection_ticker"] ?? "").trim();
      const customStrike = (market["custom_strike"] ?? null) as UnknownRecord | null;
      const associatedMarketsRaw =
        customStrike && typeof customStrike === "object"
          ? customStrike["Associated Markets"]
          : null;
      const associatedMarketsCount =
        typeof associatedMarketsRaw === "string" && associatedMarketsRaw.trim().length > 0
          ? associatedMarketsRaw.split(",").map((item) => item.trim()).filter(Boolean).length
          : 0;
      const looksLikeMveTitle =
        rawTitle.includes(",") && /\b(yes|no)\b/i.test(rawTitle) && rawTitle.length > 40;

      const isMve =
        mveSelectedLegs.length >= 2 ||
        collectionTicker.length > 0 ||
        associatedMarketsCount >= 2 ||
        looksLikeMveTitle;

      let title = rawTitle;
      let marketMeta: Record<string, unknown> | undefined;
      if (isMve) {
        const legs = buildMveLegs(rawTitle);
        const legsCount = legs.length || mveSelectedLegs.length;
        const headline = legs[0]?.text?.slice(0, 140) || "Combo";
        title = legsCount > 1 ? `${headline} (+${legsCount - 1} legs)` : headline;
        marketMeta = {
          kind: "kalshi_mve",
          legs,
          legsCount,
          originalTitle: rawTitle,
          eventTicker: String(market["event_ticker"] ?? ""),
          collectionTicker,
          associatedMarketsCount,
          selectedLegs: mveSelectedLegs
        };
      }

      const rawCategory =
        String(market["category"] ?? market["event_ticker"] ?? market["series_ticker"] ?? "") ||
        null;
      const normalizedCategory = normalizeCategory(rawCategory, title);

      const yesBid = centsToQuoteProbability(market["yes_bid"]);
      const yesAsk = centsToQuoteProbability(market["yes_ask"]);
      const noBid = centsToQuoteProbability(market["no_bid"]);
      const noAsk = centsToQuoteProbability(market["no_ask"]);
      const last = centsToProbability(market["last_price"]);
      const yesProb =
        yesBid !== null && yesAsk !== null
          ? (yesBid + yesAsk) / 2
          : last !== null
            ? last
            : null;
      if (yesProb === null) continue;

      const spreadYesPp =
        yesBid !== null && yesAsk !== null ? Math.abs(yesAsk - yesBid) * 100 : null;
      const spreadNoPp =
        noBid !== null && noAsk !== null ? Math.abs(noAsk - noBid) * 100 : null;
      const spreadPp = spreadYesPp ?? spreadNoPp;
      const volume24hUsd =
        toNumber(market["volume_24h"]) ?? toNumber(market["volume"]) ?? null;
      const liquidityUsd = toNumber(market["open_interest"]) ?? volume24hUsd;

      snapshots.push({
        provider: "kalshi",
        marketId,
        outcomeId: `${marketId}-yes`,
        outcomeLabel: "Yes",
        marketTitle: title,
        rawCategory,
        normalizedCategory,
        marketMeta,
        probability: yesProb,
        spreadPp,
        volume24hUsd,
        liquidityUsd,
        timestamp: tsMinute
      });

      snapshots.push({
        provider: "kalshi",
        marketId,
        outcomeId: `${marketId}-no`,
        outcomeLabel: "No",
        marketTitle: title,
        rawCategory,
        normalizedCategory,
        marketMeta,
        probability: clampProbability(1 - yesProb),
        spreadPp,
        volume24hUsd,
        liquidityUsd,
        timestamp: tsMinute
      });
    }

    return snapshots;
  }
}
