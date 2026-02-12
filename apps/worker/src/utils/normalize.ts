import type { Category } from "@predict-radar/shared";

const cryptoWords = ["btc", "bitcoin", "eth", "ethereum", "sol", "crypto", "price"];
const sportsWords = ["vs", "mlb", "nba", "nfl", "score", "goal", "inning", "match", "game"];
const politicsWords = ["election", "president", "senate", "vote", "party", "minister", "policy"];

export function normalizeCategory(raw: string | null | undefined, title: string): Category {
  const full = `${raw ?? ""} ${title}`.toLowerCase();

  if (cryptoWords.some((word) => full.includes(word))) return "crypto";
  if (sportsWords.some((word) => full.includes(word))) return "sports";
  if (politicsWords.some((word) => full.includes(word))) return "politics";
  if (full.includes("macro") || full.includes("fed") || full.includes("cpi")) return "macro";
  if (full.includes("policy") || full.includes("regulation")) return "policy";

  return "other";
}

export function isCryptoLinked(title: string): boolean {
  const value = title.toLowerCase();
  return cryptoWords.some((word) => value.includes(word));
}

export function isSportsLinked(title: string): boolean {
  const value = title.toLowerCase();
  return sportsWords.some((word) => value.includes(word));
}
