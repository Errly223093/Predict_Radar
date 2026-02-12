"use client";

import { useEffect, useMemo, useState, type JSX } from "react";
import { WINDOWS, type MoverRow, type WindowKey } from "@/lib/contracts";

type Tab = "opaque" | "exogenous" | "all";

type Sort = "asc" | "desc";

const CATEGORY_OPTIONS = [
  "all",
  "crypto",
  "politics",
  "policy",
  "sports",
  "macro",
  "other"
] as const;

const TAB_LABELS: Record<Tab, string> = {
  opaque: "Opaque-Info",
  exogenous: "Exogenous",
  all: "All"
};

const WINDOW_LABELS: Record<WindowKey, string> = {
  "3m": "3m",
  "9m": "9m",
  "30m": "30m",
  "1h": "1h",
  "3h": "3h",
  "6h": "6h",
  "12h": "12h",
  "24h": "24h"
};

const AUTO_REFRESH_MS = 15_000;

function toSigned(value: number | null): string {
  if (value === null) return "-";
  if (value === 0) return "0.00pp";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}pp`;
}

export default function HomePage(): JSX.Element {
  const [windowKey, setWindowKey] = useState<WindowKey>("3m");
  const [sort, setSort] = useState<Sort>("desc");
  const [tab, setTab] = useState<Tab>("all");
  const [category, setCategory] = useState<(typeof CATEGORY_OPTIONS)[number]>("all");
  const [includeLowLiquidity, setIncludeLowLiquidity] = useState(true);
  const [providers, setProviders] = useState<string[]>(["polymarket", "kalshi"]);

  const [rows, setRows] = useState<MoverRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const snapshotStats = useMemo(() => {
    const total = rows.length;
    const strongMoves = rows.filter((row) => Math.abs(row.deltasPp[windowKey] ?? 0) >= 15).length;
    return { total, strongMoves };
  }, [rows, windowKey]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const providersParam = providers.length > 0 ? providers.join(",") : "polymarket,kalshi";

    const load = async (showLoading: boolean): Promise<void> => {
      if (cancelled || inFlight) return;
      inFlight = true;

      const params = new URLSearchParams({
        window: windowKey,
        sort,
        tab,
        category,
        providers: providersParam,
        includeLowLiquidity: includeLowLiquidity ? "true" : "false"
      });

      if (showLoading) setLoading(true);
      if (showLoading) setError(null);

      try {
        const res = await fetch(`/api/movers?${params.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { data: MoverRow[] };
        if (cancelled) return;
        setRows(json.data);
        setLastUpdated(new Date().toISOString());
      } catch {
        if (!cancelled) {
          setError("Failed to load live movers.");
        }
      } finally {
        if (!cancelled && showLoading) setLoading(false);
        inFlight = false;
      }
    };

    void load(true);
    const interval = setInterval(() => {
      void load(false);
    }, AUTO_REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [windowKey, sort, tab, category, includeLowLiquidity, providers]);

  return (
    <main className="page-shell">
      <section className="hero-card">
        <div>
          <p className="eyebrow">Prediction Signal Radar</p>
          <h1>Watch fast probability shifts across live markets.</h1>
          <p className="subtext">
            Free public dashboard. Opaque-info signals and Exogenous-arbitrage moves are separated to
            help prioritize actionable events.
          </p>
        </div>
        <div className="stat-grid">
          <article>
            <span>Total Movers</span>
            <strong>{snapshotStats.total}</strong>
          </article>
          <article>
            <span>Strong Moves</span>
            <strong>{snapshotStats.strongMoves}</strong>
          </article>
          <article>
            <span>Window</span>
            <strong>{WINDOW_LABELS[windowKey]}</strong>
          </article>
        </div>
      </section>

      <section className="control-card">
        <div className="control-row">
          <label>
            Window
            <select value={windowKey} onChange={(e) => setWindowKey(e.target.value as WindowKey)}>
              {WINDOWS.map((window) => (
                <option key={window} value={window}>
                  {WINDOW_LABELS[window]}
                </option>
              ))}
            </select>
          </label>

          <label>
            Sort
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="desc">Delta Desc</option>
              <option value="asc">Delta Asc</option>
            </select>
          </label>

          <label>
            Category
            <select
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as (typeof CATEGORY_OPTIONS)[number])
              }
            >
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <label>
            Tab
            <select value={tab} onChange={(e) => setTab(e.target.value as Tab)}>
              {(Object.keys(TAB_LABELS) as Tab[]).map((value) => (
                <option key={value} value={value}>
                  {TAB_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="chip-row">
          <button
            type="button"
            className={providers.includes("polymarket") ? "chip active" : "chip"}
            onClick={() => {
              setProviders((prev) =>
                prev.includes("polymarket")
                  ? prev.filter((item) => item !== "polymarket")
                  : [...prev, "polymarket"]
              );
            }}
          >
            Polymarket
          </button>
          <button
            type="button"
            className={providers.includes("kalshi") ? "chip active" : "chip"}
            onClick={() => {
              setProviders((prev) =>
                prev.includes("kalshi")
                  ? prev.filter((item) => item !== "kalshi")
                  : [...prev, "kalshi"]
              );
            }}
          >
            Kalshi
          </button>
          <button type="button" className="chip disabled" disabled>
            Opinion (Coming soon)
          </button>

          <label className="checkbox-chip">
            <input
              type="checkbox"
              checked={includeLowLiquidity}
              onChange={(e) => setIncludeLowLiquidity(e.target.checked)}
            />
            Include low-liquidity
          </label>
        </div>
      </section>

      <section className="table-card">
        <div className="table-header">
          <h2>Live Movers</h2>
          <div className="table-meta">
            <span className="live-pill">Auto refresh 15s</span>
            <span>
              {lastUpdated ? `Last update ${new Date(lastUpdated).toLocaleTimeString()}` : "Waiting"}
            </span>
          </div>
        </div>

        {loading && <p className="state-message">Loading…</p>}
        {error && <p className="state-message error">{error}</p>}

        {!loading && !error && rows.length === 0 && (
          <div className="empty-state">
            <p>No rows matched your current filters.</p>
            <button
              type="button"
              className="chip active"
              onClick={() => {
                setTab("all");
                setIncludeLowLiquidity(true);
              }}
            >
              Show all signals
            </button>
          </div>
        )}

        {!loading && !error && rows.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Provider</th>
                  <th>Outcome</th>
                  <th>Prob</th>
                  <th>{WINDOW_LABELS[windowKey]}</th>
                  <th>24h</th>
                  <th>Category</th>
                  <th>Label</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const selectedDelta = row.deltasPp[windowKey];
                  const deltaClass =
                    selectedDelta === null
                      ? "neutral"
                      : selectedDelta > 0
                        ? "up"
                        : selectedDelta < 0
                          ? "down"
                          : "neutral";

                  return (
                    <tr key={`${row.provider}:${row.marketId}:${row.outcomeId}`}>
                      <td>
                        <p className="market-title">{row.marketTitle}</p>
                      </td>
                      <td>{row.provider}</td>
                      <td>{row.outcomeLabel}</td>
                      <td>{(row.probability * 100).toFixed(2)}%</td>
                      <td className={deltaClass}>{toSigned(selectedDelta)}</td>
                      <td
                        className={
                          row.deltasPp["24h"] === null
                            ? "neutral"
                            : row.deltasPp["24h"] > 0
                              ? "up"
                              : "down"
                        }
                      >
                        {toSigned(row.deltasPp["24h"])}
                      </td>
                      <td>{row.normalizedCategory}</td>
                      <td>
                        <span className={`pill ${row.label}`}>{row.label}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
