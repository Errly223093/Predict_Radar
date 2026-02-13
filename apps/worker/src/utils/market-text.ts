type UnknownRecord = Record<string, unknown>;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function normalizeMarketText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s:$+.-]/gu, " ")
    .trim();
}

export function buildMarketText(title: string, meta: UnknownRecord | null): string {
  const parts: string[] = [title];

  if (meta && typeof meta === "object") {
    if (typeof meta["originalTitle"] === "string") parts.push(String(meta["originalTitle"]));

    const legs = asArray(meta["legs"]);
    for (const leg of legs) {
      const record = (leg ?? {}) as UnknownRecord;
      if (typeof record["raw"] === "string") parts.push(record["raw"]);
      else if (typeof record["text"] === "string") parts.push(record["text"]);
    }
  }

  return normalizeMarketText(parts.join(" "));
}

