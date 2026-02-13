import {
  clampProbability,
  type OutcomeSnapshot,
  type Provider
} from "@predict-radar/shared";
import { normalizeCategory } from "../utils/normalize.js";
import type { ProviderAdapter } from "./base.js";

const POLYMARKET_MARKETS_URL =
  "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500";

type UnknownRecord = Record<string, unknown>;

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

function toProbability(value: unknown): number | null {
  const numeric = toNumber(value);
  if (numeric === null) return null;
  return clampProbability(numeric > 1 ? numeric / 100 : numeric);
}

export class PolymarketAdapter implements ProviderAdapter {
  readonly name: Provider = "polymarket";

  readonly enabled = true;

  async fetchSnapshots(tsMinute: Date): Promise<OutcomeSnapshot[]> {
    const response = await fetch(POLYMARKET_MARKETS_URL, {
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Polymarket request failed: ${response.status}`);
    }

    const markets = (await response.json()) as UnknownRecord[];
    const snapshots: OutcomeSnapshot[] = [];

    for (const market of markets) {
      const marketId = String(
        market["conditionId"] ?? market["id"] ?? market["slug"] ?? ""
      );
      if (!marketId) continue;

      const title = String(market["question"] ?? market["title"] ?? "Untitled market");
      const slug = typeof market["slug"] === "string" ? market["slug"].trim() : "";
      const marketMeta = slug
        ? {
            slug,
            url: `https://polymarket.com/market/${slug}`
          }
        : undefined;
      const rawCategory =
        (market["category"] as string | undefined) ??
        (market["tags"] as string[] | undefined)?.[0] ??
        null;
      const normalizedCategory = normalizeCategory(rawCategory, title);
      const volume24hUsd =
        toNumber(market["volume24hr"]) ?? toNumber(market["volume24h"]) ?? null;
      const liquidityUsd =
        toNumber(market["liquidity"]) ?? toNumber(market["liquidityClob"]) ?? null;

      const tokens = asArray(market["tokens"]);

      if (tokens.length > 0) {
        for (const [index, tokenRaw] of tokens.entries()) {
          const token = (tokenRaw ?? {}) as UnknownRecord;
          const outcomeLabel = String(token["outcome"] ?? `Outcome ${index + 1}`);
          const outcomeId = String(token["token_id"] ?? token["id"] ?? `${marketId}-${index}`);
          const probability =
            toProbability(token["price"]) ??
            toProbability(token["probability"]) ??
            toProbability(token["last_price"]);
          if (probability === null) continue;

          const bestBid = toProbability(token["best_bid"]);
          const bestAsk = toProbability(token["best_ask"]);
          const spreadPp =
            bestBid !== null && bestAsk !== null ? Math.abs(bestAsk - bestBid) * 100 : null;

          snapshots.push({
            provider: "polymarket",
            marketId,
            outcomeId,
            outcomeLabel,
            marketTitle: title,
            rawCategory,
            normalizedCategory,
            marketMeta,
            probability,
            spreadPp,
            volume24hUsd,
            liquidityUsd,
            timestamp: tsMinute
          });
        }
        continue;
      }

      const outcomes = asArray(market["outcomes"]);
      const outcomePrices = asArray(market["outcomePrices"]);
      for (const [index, outcome] of outcomes.entries()) {
        const probability = toProbability(outcomePrices[index]);
        if (probability === null) continue;

        snapshots.push({
          provider: "polymarket",
          marketId,
          outcomeId: `${marketId}-${index}`,
          outcomeLabel: String(outcome),
          marketTitle: title,
          rawCategory,
          normalizedCategory,
          marketMeta,
          probability,
          spreadPp: null,
          volume24hUsd,
          liquidityUsd,
          timestamp: tsMinute
        });
      }
    }

    return snapshots;
  }
}
