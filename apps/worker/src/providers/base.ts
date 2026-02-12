import type { OutcomeSnapshot, Provider } from "@predict-radar/shared";

export interface ProviderAdapter {
  readonly name: Provider;
  readonly enabled: boolean;
  fetchSnapshots(tsMinute: Date): Promise<OutcomeSnapshot[]>;
}
