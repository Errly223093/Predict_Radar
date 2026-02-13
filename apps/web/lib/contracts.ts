export const WINDOWS = ["1m", "5m", "10m", "30m", "1h", "6h", "12h", "24h"] as const;

export type WindowKey = (typeof WINDOWS)[number];

export type Provider = "polymarket" | "kalshi" | "opinion";

export type Label = "opaque_info_sensitive" | "exogenous_arbitrage" | "unclear";

export type Category =
  | "crypto"
  | "politics"
  | "policy"
  | "sports"
  | "macro"
  | "other";

export interface MoverOutcomeRow {
  provider: Provider;
  marketId: string;
  marketTitle: string;
  outcomeId: string;
  outcomeLabel: string;
  normalizedCategory: Category;
  probability: number;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  spreadPp: number | null;
  label: Label;
  reasonTags: string[];
  deltasPp: Record<WindowKey, number | null>;
  timestamp: string;
}

export interface MoverMarketRow {
  provider: Provider;
  marketId: string;
  marketTitle: string;
  normalizedCategory: Category;
  label: Label;
  reasonTags: string[];
  leadOutcomeId: string;
  marketMeta: Record<string, unknown> | null;
  outcomes: MoverOutcomeRow[];
  timestamp: string;
}
