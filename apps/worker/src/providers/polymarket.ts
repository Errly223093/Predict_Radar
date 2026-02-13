import {
  clampProbability,
  type OutcomeSnapshot,
  type Provider
} from "@predict-radar/shared";
import { normalizeCategory } from "../utils/normalize.js";
import type { ProviderAdapter } from "./base.js";

const POLYMARKET_MARKETS_URL =
  "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500";
const POLYMARKET_CLOB_BOOK_URL = "https://clob.polymarket.com/book";

const CLOB_DEPTH_LEVELS_TO_SUM = 20;
const CLOB_CONCURRENCY = 16;

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

type ClobLevel = { price: string; size: string };
type ClobBook = { bids: ClobLevel[]; asks: ClobLevel[] };

function sumClobNotionalUsd(levels: ClobLevel[], side: "bids" | "asks"): number | null {
  const parsed = levels
    .map((level) => {
      const price = toNumber(level?.price);
      const size = toNumber(level?.size);
      if (price === null || size === null) return null;
      return { price, size };
    })
    .filter((item): item is { price: number; size: number } => item !== null);

  if (parsed.length === 0) return null;

  parsed.sort((a, b) => (side === "bids" ? b.price - a.price : a.price - b.price));

  let total = 0;
  for (const { price, size } of parsed.slice(0, CLOB_DEPTH_LEVELS_TO_SUM)) {
    total += price * size;
  }

  return Number.isFinite(total) ? total : null;
}

function bestBidAskFromBook(book: ClobBook): { bestBid: number | null; bestAsk: number | null } {
  let bestBid: number | null = null;
  for (const level of book.bids ?? []) {
    const price = toNumber(level?.price);
    if (price === null) continue;
    if (bestBid === null || price > bestBid) bestBid = price;
  }

  let bestAsk: number | null = null;
  for (const level of book.asks ?? []) {
    const price = toNumber(level?.price);
    if (price === null) continue;
    if (bestAsk === null || price < bestAsk) bestAsk = price;
  }

  return { bestBid, bestAsk };
}

function liquidityUsdFromBook(book: ClobBook): number | null {
  const bids = sumClobNotionalUsd(book.bids ?? [], "bids");
  const asks = sumClobNotionalUsd(book.asks ?? [], "asks");
  if (bids === null && asks === null) return null;
  const total = (bids ?? 0) + (asks ?? 0);
  return Number.isFinite(total) ? total : null;
}

async function fetchClobBook(tokenId: string): Promise<ClobBook | null> {
  if (!tokenId) return null;

  const url = new URL(POLYMARKET_CLOB_BOOK_URL);
  url.searchParams.set("token_id", tokenId);

  try {
    const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const json = (await response.json()) as UnknownRecord;
    const bids = Array.isArray(json["bids"]) ? (json["bids"] as ClobLevel[]) : [];
    const asks = Array.isArray(json["asks"]) ? (json["asks"] as ClobLevel[]) : [];
    return { bids, asks };
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });

  await Promise.all(workers);
  return results;
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

    const tokenIds = new Set<string>();
    const clobTokenIdsByMarketId = new Map<string, string[]>();

    for (const market of markets) {
      const marketId = String(
        market["conditionId"] ?? market["id"] ?? market["slug"] ?? ""
      );
      if (!marketId) continue;

      const clobTokenIds = asArray(market["clobTokenIds"]).map((id) => String(id ?? "").trim());
      if (clobTokenIds.length > 0) {
        clobTokenIdsByMarketId.set(marketId, clobTokenIds);
        for (const id of clobTokenIds) {
          if (id) tokenIds.add(id);
        }
      }
    }

    const uniqueTokenIds = Array.from(tokenIds);
    const books = await mapLimit(
      uniqueTokenIds,
      CLOB_CONCURRENCY,
      async (tokenId) => [tokenId, await fetchClobBook(tokenId)] as const
    );
    const bookByTokenId = new Map<string, ClobBook>();
    for (const [tokenId, book] of books) {
      if (!book) continue;
      bookByTokenId.set(tokenId, book);
    }

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
      const fallbackLiquidityUsd =
        toNumber(market["liquidity"]) ?? toNumber(market["liquidityClob"]) ?? null;

      const tokens = asArray(market["tokens"]);
      const clobTokenIds = clobTokenIdsByMarketId.get(marketId) ?? [];
      const fallbackBestBid = toProbability(market["bestBid"]);
      const fallbackBestAsk = toProbability(market["bestAsk"]);
      const fallbackSpreadPp =
        fallbackBestBid !== null && fallbackBestAsk !== null
          ? Math.abs(fallbackBestAsk - fallbackBestBid) * 100
          : null;

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

          const tokenId = String(clobTokenIds[index] ?? token["token_id"] ?? token["id"] ?? "");
          const book = tokenId ? bookByTokenId.get(tokenId) ?? null : null;
          const { bestBid, bestAsk } = book
            ? bestBidAskFromBook(book)
            : {
                bestBid: toProbability(token["best_bid"]) ?? fallbackBestBid,
                bestAsk: toProbability(token["best_ask"]) ?? fallbackBestAsk
              };
          const spreadPp =
            bestBid !== null && bestAsk !== null ? Math.abs(bestAsk - bestBid) * 100 : null;

          const liquidityUsd = (book ? liquidityUsdFromBook(book) : null) ?? fallbackLiquidityUsd;

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
            spreadPp: spreadPp ?? fallbackSpreadPp,
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

        const tokenId = String(clobTokenIds[index] ?? "").trim();
        const book = tokenId ? bookByTokenId.get(tokenId) ?? null : null;
        const { bestBid, bestAsk } = book
          ? bestBidAskFromBook(book)
          : { bestBid: fallbackBestBid, bestAsk: fallbackBestAsk };
        const spreadPp =
          bestBid !== null && bestAsk !== null ? Math.abs(bestAsk - bestBid) * 100 : null;

        const liquidityUsd = (book ? liquidityUsdFromBook(book) : null) ?? fallbackLiquidityUsd;

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
          spreadPp: spreadPp ?? fallbackSpreadPp,
          volume24hUsd,
          liquidityUsd,
          timestamp: tsMinute
        });
      }
    }

    return snapshots;
  }
}
