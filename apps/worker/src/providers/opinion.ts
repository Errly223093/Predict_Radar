import { clampProbability, type OutcomeSnapshot, type Provider } from "@predict-radar/shared";
import { config } from "../config.js";
import { normalizeCategory } from "../utils/normalize.js";
import type { ProviderAdapter } from "./base.js";

const OPINION_API_BASE = "https://proxy.opinion.trade:8443/openapi";
const OPINION_MARKETS_ENDPOINT = `${OPINION_API_BASE}/market`;
const OPINION_TOKEN_PRICE_ENDPOINT = `${OPINION_API_BASE}/token/latest-price`;

const OPINION_V2_BASE = "https://proxy.opinion.trade:8443/api";
const OPINION_ORDER_DEPTH_PATH = "/v2/order/market/depth";

const PAGE_SIZE = 20;
const REQUEST_SPACING_MS = 70; // ~14 req/sec to stay under documented 15 req/sec.
const DEPTH_LEVELS_TO_SUM = 20;

type UnknownRecord = Record<string, unknown>;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Shared rate limiter for the Opinion adapter: ensure requests are started at a fixed pace
// even when we run multiple requests concurrently.
let nextAllowedStartMs = 0;

async function rateLimitedFetch(url: string, init: RequestInit): Promise<Response> {
  const now = Date.now();
  const waitMs = Math.max(0, nextAllowedStartMs - now);
  nextAllowedStartMs = Math.max(nextAllowedStartMs, now) + REQUEST_SPACING_MS;
  if (waitMs > 0) await sleep(waitMs);
  return fetch(url, init);
}

async function fetchJson(url: string): Promise<UnknownRecord> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    // Opinion Open API uses `apikey` header (lowercase in docs and observed server behavior).
    apikey: config.OPINION_API_KEY ?? ""
  };

  let attempt = 0;
  while (attempt < 4) {
    attempt += 1;

    const response = await rateLimitedFetch(url, { headers });

    if (response.status === 429) {
      // Back off a bit and retry. (Server doesn't always provide retry-after.)
      await sleep(500 * attempt);
      continue;
    }

    if (!response.ok) {
      const payload = await response.text().catch(() => "");
      throw new Error(`Opinion request failed: ${response.status} ${payload.slice(0, 200)}`);
    }

    return (await response.json()) as UnknownRecord;
  }

  throw new Error("Opinion request failed: rate limited (429) after retries");
}

async function fetchMarkets(): Promise<UnknownRecord[]> {
  const markets: UnknownRecord[] = [];
  let page = 1;

  while (page < 200) {
    const url = new URL(OPINION_MARKETS_ENDPOINT);
    url.searchParams.set("status", "activated");
    url.searchParams.set("sortBy", "5"); // volume24h desc
    url.searchParams.set("marketType", "2"); // all
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(PAGE_SIZE));

    const json = await fetchJson(url.toString());
    const result = (json["result"] ?? null) as UnknownRecord | null;
    const list = result ? asArray(result["list"]) : [];

    if (list.length === 0) break;
    for (const entry of list) {
      markets.push((entry ?? {}) as UnknownRecord);
    }

    if (list.length < PAGE_SIZE) break;
    page += 1;
  }

  return markets;
}

async function fetchTokenPrice(tokenId: string): Promise<number | null> {
  if (!tokenId || tokenId.trim().length === 0) return null;

  const url = new URL(OPINION_TOKEN_PRICE_ENDPOINT);
  url.searchParams.set("token_id", tokenId);

  const json = await fetchJson(url.toString());
  const result = (json["result"] ?? null) as UnknownRecord | null;
  if (!result) return null;

  return toProbability(result["price"]);
}

function chainKeyFromChainId(chainIdRaw: unknown): "bsc" | "monad" | "base" | null {
  const chainId = typeof chainIdRaw === "string" ? chainIdRaw.trim() : String(chainIdRaw ?? "");
  switch (chainId) {
    case "56":
      return "bsc";
    case "10143":
      return "monad";
    case "8453":
      return "base";
    default:
      return null;
  }
}

type DepthLevel = readonly [string, string];

function parseDepthLevels(value: unknown): DepthLevel[] {
  if (!Array.isArray(value)) return [];
  const levels: DepthLevel[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const price = entry[0];
    const size = entry[1];
    if (typeof price !== "string" || typeof size !== "string") continue;
    levels.push([price, size] as const);
  }
  return levels;
}

function bestBidAskFromDepth(levels: { bids: DepthLevel[]; asks: DepthLevel[] }): {
  bestBid: number | null;
  bestAsk: number | null;
} {
  let bestBid: number | null = null;
  for (const [priceRaw] of levels.bids) {
    const price = toNumber(priceRaw);
    if (price === null) continue;
    if (bestBid === null || price > bestBid) bestBid = price;
  }

  let bestAsk: number | null = null;
  for (const [priceRaw] of levels.asks) {
    const price = toNumber(priceRaw);
    if (price === null) continue;
    if (bestAsk === null || price < bestAsk) bestAsk = price;
  }

  return { bestBid, bestAsk };
}

function sumNotionalUsd(levels: DepthLevel[], side: "bids" | "asks"): number | null {
  const parsed = levels
    .map(([priceRaw, sizeRaw]) => {
      const price = toNumber(priceRaw);
      const size = toNumber(sizeRaw);
      if (price === null || size === null) return null;
      return { price, size };
    })
    .filter((item): item is { price: number; size: number } => item !== null);

  if (parsed.length === 0) return null;

  parsed.sort((a, b) => (side === "bids" ? b.price - a.price : a.price - b.price));

  let total = 0;
  for (const { price, size } of parsed.slice(0, DEPTH_LEVELS_TO_SUM)) {
    total += price * size;
  }
  return Number.isFinite(total) ? total : null;
}

async function fetchOrderDepth(params: {
  chainKey: "bsc" | "monad" | "base";
  questionId: string;
  symbol: string;
  symbolTypes: 0 | 1;
}): Promise<{ price: number | null; spreadPp: number | null; liquidityUsd: number | null }> {
  const url = new URL(`${OPINION_V2_BASE}/${params.chainKey}/api${OPINION_ORDER_DEPTH_PATH}`);
  url.searchParams.set("question_id", params.questionId);
  url.searchParams.set("symbol", params.symbol);
  url.searchParams.set("symbol_types", String(params.symbolTypes));

  const json = await fetchJson(url.toString());
  const result = (json["result"] ?? null) as UnknownRecord | null;
  if (!result) return { price: null, spreadPp: null, liquidityUsd: null };

  const asks = parseDepthLevels(result["asks"]);
  const bids = parseDepthLevels(result["bids"]);

  const { bestBid, bestAsk } = bestBidAskFromDepth({ bids, asks });
  const spreadPp =
    bestBid !== null && bestAsk !== null ? Math.abs(bestAsk - bestBid) * 100 : null;

  const lastPrice =
    toProbability(result["last_price"]) ??
    toProbability(result["lastPrice"]) ??
    (bestBid !== null && bestAsk !== null ? clampProbability((bestBid + bestAsk) / 2) : null);

  const bidsUsd = sumNotionalUsd(bids, "bids");
  const asksUsd = sumNotionalUsd(asks, "asks");
  const liquidityUsd =
    bidsUsd === null && asksUsd === null ? null : (bidsUsd ?? 0) + (asksUsd ?? 0);

  return {
    price: lastPrice,
    spreadPp,
    liquidityUsd
  };
}

export class OpinionAdapter implements ProviderAdapter {
  readonly name: Provider = "opinion";

  readonly enabled = Boolean(config.ENABLE_OPINION && config.OPINION_API_KEY);

  async fetchSnapshots(_tsMinute: Date): Promise<OutcomeSnapshot[]> {
    if (!this.enabled) return [];

    const tsMinute = _tsMinute;
    nextAllowedStartMs = 0; // reset pacing per cycle

    const markets = await fetchMarkets();

    type BinarySpec = {
      marketId: string;
      title: string;
      yesTokenId: string;
      noTokenId: string;
      questionId: string;
      chainKey: "bsc" | "monad" | "base";
      volume24hUsd: number | null;
      normalizedCategory: OutcomeSnapshot["normalizedCategory"];
    };

    type ChoiceSpec = {
      marketId: string;
      title: string;
      outcomeId: string;
      outcomeLabel: string;
      yesTokenId: string;
      questionId: string;
      chainKey: "bsc" | "monad" | "base";
      volume24hUsd: number | null;
      normalizedCategory: OutcomeSnapshot["normalizedCategory"];
    };

    const binaryMarkets: BinarySpec[] = [];
    const choiceOutcomes: ChoiceSpec[] = [];

    for (const market of markets) {
      const marketIdRaw = market["marketId"];
      const marketId = marketIdRaw === undefined ? "" : String(marketIdRaw);
      if (!marketId) continue;

      const title = String(market["marketTitle"] ?? market["title"] ?? `Opinion ${marketId}`);
      const normalizedCategory = normalizeCategory(null, title);
      const volume24hUsd = toNumber(market["volume24h"]) ?? toNumber(market["volume"]) ?? null;

      const childrenRaw = market["childMarkets"];
      const children = Array.isArray(childrenRaw) ? (childrenRaw as UnknownRecord[]) : [];

      if (children.length > 0) {
        for (const child of children) {
          const yesTokenId = String(child["yesTokenId"] ?? "").trim();
          if (!yesTokenId) continue;
          const childTitle = String(child["marketTitle"] ?? child["title"] ?? "").trim();
          if (!childTitle) continue;
          const questionId = String(child["questionId"] ?? "").trim();
          const chainKey = chainKeyFromChainId(child["chainId"] ?? market["chainId"]);
          if (!questionId || !chainKey) continue;

          choiceOutcomes.push({
            marketId,
            title,
            outcomeId: yesTokenId,
            outcomeLabel: childTitle,
            yesTokenId,
            questionId,
            chainKey,
            volume24hUsd,
            normalizedCategory
          });
        }
        continue;
      }

      const yesTokenId = String(market["yesTokenId"] ?? "").trim();
      const noTokenId = String(market["noTokenId"] ?? "").trim();
      const questionId = String(market["questionId"] ?? "").trim();
      const chainKey = chainKeyFromChainId(market["chainId"]);
      if (!yesTokenId || !noTokenId || !questionId || !chainKey) continue;

      binaryMarkets.push({
        marketId,
        title,
        yesTokenId,
        noTokenId,
        questionId,
        chainKey,
        volume24hUsd,
        normalizedCategory
      });
    }

    const depthSpecs: Array<{
      tokenId: string;
      questionId: string;
      chainKey: "bsc" | "monad" | "base";
      symbolTypes: 0;
    }> = [];

    for (const item of binaryMarkets) {
      depthSpecs.push({
        tokenId: item.yesTokenId,
        questionId: item.questionId,
        chainKey: item.chainKey,
        symbolTypes: 0
      });
    }

    for (const item of choiceOutcomes) {
      depthSpecs.push({
        tokenId: item.yesTokenId,
        questionId: item.questionId,
        chainKey: item.chainKey,
        symbolTypes: 0
      });
    }

    // Deduplicate by token id (safe: token ids are unique per outcome).
    const uniqueDepthSpecs = Array.from(
      new Map(depthSpecs.map((spec) => [spec.tokenId, spec] as const)).values()
    );

    const depthEntries = await Promise.all(
      uniqueDepthSpecs.map(async (spec) => {
        try {
          const metrics = await fetchOrderDepth({
            chainKey: spec.chainKey,
            questionId: spec.questionId,
            symbol: spec.tokenId,
            symbolTypes: spec.symbolTypes
          });
          return [spec.tokenId, metrics] as const;
        } catch (error) {
          console.warn(`[opinion] depth failed token=${spec.tokenId}`, error);
          return [
            spec.tokenId,
            { price: null, spreadPp: null, liquidityUsd: null }
          ] as const;
        }
      })
    );

    const metricsByTokenId = new Map<
      string,
      { price: number | null; spreadPp: number | null; liquidityUsd: number | null }
    >();
    for (const [tokenId, metrics] of depthEntries) {
      metricsByTokenId.set(tokenId, metrics);
    }

    const snapshots: OutcomeSnapshot[] = [];

    for (const outcome of choiceOutcomes) {
      const metrics = metricsByTokenId.get(outcome.yesTokenId);
      const yesProb = metrics?.price ?? null;
      if (yesProb === null) continue;

      snapshots.push({
        provider: "opinion",
        marketId: outcome.marketId,
        outcomeId: outcome.outcomeId,
        outcomeLabel: outcome.outcomeLabel,
        marketTitle: outcome.title,
        rawCategory: null,
        normalizedCategory: outcome.normalizedCategory,
        marketMeta: { kind: "opinion", marketId: outcome.marketId },
        probability: yesProb,
        spreadPp: metrics?.spreadPp ?? null,
        volume24hUsd: outcome.volume24hUsd,
        liquidityUsd: metrics?.liquidityUsd ?? null,
        timestamp: tsMinute
      });
    }

    for (const market of binaryMarkets) {
      const metrics = metricsByTokenId.get(market.yesTokenId);
      const yesProb =
        metrics?.price ?? (await fetchTokenPrice(market.yesTokenId).catch(() => null));
      if (yesProb === null) continue;

      snapshots.push({
        provider: "opinion",
        marketId: market.marketId,
        outcomeId: market.yesTokenId,
        outcomeLabel: "Yes",
        marketTitle: market.title,
        rawCategory: null,
        normalizedCategory: market.normalizedCategory,
        marketMeta: { kind: "opinion", marketId: market.marketId },
        probability: yesProb,
        spreadPp: metrics?.spreadPp ?? null,
        volume24hUsd: market.volume24hUsd,
        liquidityUsd: metrics?.liquidityUsd ?? null,
        timestamp: tsMinute
      });

      snapshots.push({
        provider: "opinion",
        marketId: market.marketId,
        outcomeId: market.noTokenId,
        outcomeLabel: "No",
        marketTitle: market.title,
        rawCategory: null,
        normalizedCategory: market.normalizedCategory,
        marketMeta: { kind: "opinion", marketId: market.marketId },
        probability: clampProbability(1 - yesProb),
        spreadPp: metrics?.spreadPp ?? null,
        volume24hUsd: market.volume24hUsd,
        liquidityUsd: metrics?.liquidityUsd ?? null,
        timestamp: tsMinute
      });
    }

    return snapshots;
  }
}
