interface SpotState {
  price: number;
  observedAt: number;
}

interface ExternalSignals {
  btc1mPct: number | null;
  eth1mPct: number | null;
}

const previousPrices = new Map<string, SpotState>();

async function fetchSymbol(symbol: string): Promise<number | null> {
  try {
    const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    if (!response.ok) return null;
    const json = (await response.json()) as { price?: string };
    const numeric = Number(json.price);
    return Number.isFinite(numeric) ? numeric : null;
  } catch {
    return null;
  }
}

function computePctChange(symbol: string, current: number): number | null {
  const prev = previousPrices.get(symbol);
  previousPrices.set(symbol, { price: current, observedAt: Date.now() });

  if (!prev) return null;
  if (prev.price === 0) return null;
  return ((current - prev.price) / prev.price) * 100;
}

export async function fetchExternalSignals(): Promise<ExternalSignals> {
  const [btc, eth] = await Promise.all([fetchSymbol("BTCUSDT"), fetchSymbol("ETHUSDT")]);

  return {
    btc1mPct: btc === null ? null : computePctChange("BTCUSDT", btc),
    eth1mPct: eth === null ? null : computePctChange("ETHUSDT", eth)
  };
}
