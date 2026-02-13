export const WINDOWS = ["1m", "5m", "10m", "30m", "1h", "6h", "12h", "24h"] as const;

export type WindowKey = (typeof WINDOWS)[number];

export const WINDOW_TO_MINUTES: Record<WindowKey, number> = {
  "1m": 1,
  "5m": 5,
  "10m": 10,
  "30m": 30,
  "1h": 60,
  "6h": 360,
  "12h": 720,
  "24h": 1440
};

export type Provider = "polymarket" | "kalshi" | "opinion";

export type Label = "opaque_info_sensitive" | "exogenous_arbitrage" | "unclear";

export type Category =
  | "crypto"
  | "politics"
  | "policy"
  | "sports"
  | "macro"
  | "other";

export interface OutcomeSnapshot {
  provider: Provider;
  marketId: string;
  outcomeId: string;
  outcomeLabel: string;
  marketTitle: string;
  rawCategory: string | null;
  normalizedCategory: Category;
  marketMeta?: Record<string, unknown>;
  probability: number;
  spreadPp: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  timestamp: Date;
}

export interface DeltaRecord {
  provider: Provider;
  marketId: string;
  outcomeId: string;
  timestamp: Date;
  deltasPp: Record<WindowKey, number | null>;
}

export interface ClassificationResult {
  provider: Provider;
  marketId: string;
  outcomeId: string;
  timestamp: Date;
  opaqueScore: number;
  exogenousScore: number;
  label: Label;
  reasonTags: string[];
}

export interface MoverRow {
  provider: Provider;
  marketId: string;
  marketTitle: string;
  outcomeId: string;
  outcomeLabel: string;
  normalizedCategory: Category;
  probability: number;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  label: Label;
  reasonTags: string[];
  deltasPp: Record<WindowKey, number | null>;
  timestamp: string;
}
