import type { OutcomeSnapshot, Provider } from "@predict-radar/shared";
import { config } from "../config.js";
import type { ProviderAdapter } from "./base.js";

const OPINION_MARKETS_ENDPOINT =
  "https://proxy.opinion.trade:8443/openapi/market?status=activated&sortBy=5&limit=500";

export class OpinionAdapter implements ProviderAdapter {
  readonly name: Provider = "opinion";

  readonly enabled = Boolean(config.ENABLE_OPINION && config.OPINION_API_KEY);

  async fetchSnapshots(_tsMinute: Date): Promise<OutcomeSnapshot[]> {
    if (!this.enabled) return [];

    const response = await fetch(OPINION_MARKETS_ENDPOINT, {
      headers: {
        "X-API-KEY": config.OPINION_API_KEY ?? "",
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Opinion request failed: ${response.status}`);
    }

    // Opinion is intentionally disabled for V1 until key access is validated end-to-end.
    return [];
  }
}
