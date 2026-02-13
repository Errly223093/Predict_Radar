import { clampProbability, type OutcomeSnapshot, type Provider } from "@predict-radar/shared";
import { config } from "../config.js";
import { normalizeCategory } from "../utils/normalize.js";
import type { ProviderAdapter } from "./base.js";

const OPINION_API_BASE = "https://proxy.opinion.trade:8443/openapi";
const OPINION_MARKETS_ENDPOINT = `${OPINION_API_BASE}/market`;
const OPINION_TOKEN_PRICE_ENDPOINT = `${OPINION_API_BASE}/token/latest-price`;

const PAGE_SIZE = 20;
const REQUEST_SPACING_MS = 70; // ~14 req/sec to stay under documented 15 req/sec.

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
      volume24hUsd: number | null;
      normalizedCategory: OutcomeSnapshot["normalizedCategory"];
    };

    type ChoiceSpec = {
      marketId: string;
      title: string;
      outcomeId: string;
      outcomeLabel: string;
      yesTokenId: string;
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

          choiceOutcomes.push({
            marketId,
            title,
            outcomeId: yesTokenId,
            outcomeLabel: childTitle,
            yesTokenId,
            volume24hUsd,
            normalizedCategory
          });
        }
        continue;
      }

      const yesTokenId = String(market["yesTokenId"] ?? "").trim();
      const noTokenId = String(market["noTokenId"] ?? "").trim();
      if (!yesTokenId || !noTokenId) continue;

      binaryMarkets.push({
        marketId,
        title,
        yesTokenId,
        noTokenId,
        volume24hUsd,
        normalizedCategory
      });
    }

    const tokenIds = [
      ...new Set([
        ...binaryMarkets.map((item) => item.yesTokenId),
        ...choiceOutcomes.map((item) => item.yesTokenId)
      ])
    ];

    const priceEntries = await Promise.all(
      tokenIds.map(async (tokenId) => [tokenId, await fetchTokenPrice(tokenId)] as const)
    );

    const priceByTokenId = new Map<string, number>();
    for (const [tokenId, price] of priceEntries) {
      if (price === null) continue;
      priceByTokenId.set(tokenId, price);
    }

    const snapshots: OutcomeSnapshot[] = [];

    for (const outcome of choiceOutcomes) {
      const yesProb = priceByTokenId.get(outcome.yesTokenId);
      if (yesProb === undefined) continue;

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
        spreadPp: 0,
        volume24hUsd: outcome.volume24hUsd,
        liquidityUsd: outcome.volume24hUsd,
        timestamp: tsMinute
      });
    }

    for (const market of binaryMarkets) {
      const yesProb = priceByTokenId.get(market.yesTokenId);
      if (yesProb === undefined) continue;

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
        spreadPp: 0,
        volume24hUsd: market.volume24hUsd,
        liquidityUsd: market.volume24hUsd,
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
        spreadPp: 0,
        volume24hUsd: market.volume24hUsd,
        liquidityUsd: market.volume24hUsd,
        timestamp: tsMinute
      });
    }

    return snapshots;
  }
}
