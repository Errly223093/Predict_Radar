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

export class KalshiAdapter implements ProviderAdapter {
  readonly name: Provider = "kalshi";

  readonly enabled = true;

  async fetchSnapshots(tsMinute: Date): Promise<OutcomeSnapshot[]> {
    const markets = await fetchOpenMarkets();
    const snapshots: OutcomeSnapshot[] = [];

    for (const market of markets) {
      const marketId = String(market["ticker"] ?? market["id"] ?? "");
      if (!marketId) continue;

      const title = String(market["title"] ?? market["subtitle"] ?? marketId);
      const rawCategory =
        String(market["category"] ?? market["event_ticker"] ?? market["series_ticker"] ?? "") ||
        null;
      const normalizedCategory = normalizeCategory(rawCategory, title);

      const yesBid = centsToProbability(market["yes_bid"]);
      const yesAsk = centsToProbability(market["yes_ask"]);
      const last = centsToProbability(market["last_price"]);
      const yesProb =
        yesBid !== null && yesAsk !== null
          ? (yesBid + yesAsk) / 2
          : last !== null
            ? last
            : null;
      if (yesProb === null) continue;

      const spreadPp =
        yesBid !== null && yesAsk !== null ? Math.abs(yesAsk - yesBid) * 100 : null;
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
