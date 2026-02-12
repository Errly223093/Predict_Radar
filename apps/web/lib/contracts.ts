export const WINDOWS = ["3m", "9m", "30m", "1h", "3h", "6h", "12h", "24h"] as const;

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
