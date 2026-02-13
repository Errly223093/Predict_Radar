"use client";

import { Fragment, useEffect, useMemo, useState, type JSX } from "react";
import {
  type Label,
  type Provider,
  type MoverMarketRow,
  type MoverOutcomeRow,
  type WindowKey
} from "@/lib/contracts";

type Tab = "opaque" | "exogenous" | "all";

type SortDir = "asc" | "desc";

type MoversMeta = {
  sortWindow: WindowKey;
  sort: SortDir;
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
};

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
  "1m": "Live",
  "5m": "5m",
  "10m": "10m",
  "30m": "30m",
  "1h": "1h",
  "6h": "6h",
  "12h": "12h",
  "24h": "24h"
};

const WINDOW_OPTIONS: WindowKey[] = ["1m", "5m", "10m", "30m", "1h", "6h", "12h", "24h"];

const STRONG_THRESHOLDS_PP: Record<WindowKey, number> = {
  "1m": 6,
  "5m": 8,
  "10m": 10,
  "30m": 14,
  "1h": 18,
  "6h": 24,
  "12h": 30,
  "24h": 38
};

const AUTO_REFRESH_MS = 15_000;
const PAGE_SIZE = 50;

function providerDisplay(provider: Provider): string {
  switch (provider) {
    case "polymarket":
      return "Polymarket";
    case "kalshi":
      return "Kalshi";
    case "opinion":
      return "Opinion";
    default:
      return provider;
  }
}

function toSigned(value: number | null): string {
  if (value === null) return "-";
  if (value === 0) return "0.00pp";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}pp`;
}

function deltaClass(value: number | null): string {
  if (value === null) return "neutral";
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "neutral";
}

function formatUsd(value: number | null): string {
  if (value === null) return "-";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(0)}`;
}

function labelDisplay(label: Label): string {
  switch (label) {
    case "opaque_info_sensitive":
      return "Opaque-Info";
    case "exogenous_arbitrage":
      return "Exogenous";
    case "unclear":
      return "Unclear";
    default:
      return label;
  }
}

function isKalshiMve(meta: Record<string, unknown> | null): boolean {
  return Boolean(meta && meta["kind"] === "kalshi_mve" && Array.isArray(meta["legs"]));
}

function getMveLegs(meta: Record<string, unknown> | null): Array<{ side: string | null; text: string }> {
  if (!isKalshiMve(meta)) return [];
  const legs = meta?.["legs"];
  if (!Array.isArray(legs)) return [];
  return legs
    .map((leg) => {
      const record = (leg ?? {}) as Record<string, unknown>;
      return {
        side: typeof record["side"] === "string" ? record["side"] : null,
        text: typeof record["text"] === "string" ? record["text"] : String(record["raw"] ?? "")
      };
    })
    .filter((leg) => leg.text.trim().length > 0);
}

function parseKalshiLegsFromTitle(rawTitle: string): Array<{ side: string | null; text: string }> {
  const parts = rawTitle
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 2) return [];

  return parts
    .map((raw) => {
      const lower = raw.toLowerCase();
      if (lower.startsWith("yes ")) {
        return { side: "yes", text: raw.slice(4).trim() };
      }
      if (lower.startsWith("no ")) {
        return { side: "no", text: raw.slice(3).trim() };
      }
      return { side: null, text: raw };
    })
    .filter((leg) => leg.text.trim().length > 0);
}

function kalshiTitleSummary(rawTitle: string): string {
  const legs = parseKalshiLegsFromTitle(rawTitle);
  if (legs.length < 2) return rawTitle;
  const headline = legs[0]?.text?.slice(0, 140) || "Combo";
  return `${headline} (+${legs.length - 1} legs)`;
}

function displayMarketTitle(market: MoverMarketRow): string {
  if (market.provider !== "kalshi") return market.marketTitle;
  // Defensive: if Kalshi still serves comma-joined MVE titles, show a short summary.
  if (market.marketTitle.includes(",")) {
    return kalshiTitleSummary(market.marketTitle);
  }
  return market.marketTitle;
}

function externalMarketUrl(market: MoverMarketRow): string | null {
  const metaUrl =
    market.marketMeta && typeof market.marketMeta["url"] === "string"
      ? (market.marketMeta["url"] as string)
      : null;
  if (metaUrl && metaUrl.trim().length > 0) return metaUrl.trim();

  switch (market.provider) {
    case "kalshi":
      return `https://kalshi.com/markets/${encodeURIComponent(market.marketId)}`;
    case "polymarket": {
      const slug =
        market.marketMeta && typeof market.marketMeta["slug"] === "string"
          ? (market.marketMeta["slug"] as string)
          : "";
      const trimmed = slug.trim();
      if (trimmed.length > 0) {
        return `https://polymarket.com/market/${encodeURIComponent(trimmed)}`;
      }

      // Fallback: in some cases our marketId may already be a slug.
      if (!market.marketId.startsWith("0x")) {
        return `https://polymarket.com/market/${encodeURIComponent(market.marketId)}`;
      }

      return null;
    }
    default:
      return null;
  }
}

function legsForMarket(market: MoverMarketRow): Array<{ side: string | null; text: string }> {
  const metaLegs = getMveLegs(market.marketMeta);
  if (metaLegs.length > 0) return metaLegs;
  if (market.provider !== "kalshi") return [];
  return parseKalshiLegsFromTitle(market.marketTitle);
}

function ProviderLogo({ provider, compact }: { provider: Provider; compact?: boolean }): JSX.Element {
  if (provider === "polymarket") {
    return (
      <img
        className={compact ? "provider-image polymarket compact" : "provider-image polymarket"}
        src="/providers/polymarket-wordmark.svg"
        alt="Polymarket"
        loading="lazy"
        decoding="async"
      />
    );
  }

  if (provider === "kalshi") {
    return (
      <span
        className={compact ? "provider-wordmark kalshi compact" : "provider-wordmark kalshi"}
        aria-label="Kalshi"
      >
        Kalshi
      </span>
    );
  }

  return <span className="provider-wordmark other">{providerDisplay(provider)}</span>;
}

export default function HomePage(): JSX.Element {
  const [secondaryWindow, setSecondaryWindow] = useState<WindowKey>("30m");
  const [sortWindow, setSortWindow] = useState<WindowKey>("1m");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [tab, setTab] = useState<Tab>("all");
  const [category, setCategory] = useState<(typeof CATEGORY_OPTIONS)[number]>("all");
  const [includeLowLiquidity, setIncludeLowLiquidity] = useState(true);
  const [providers, setProviders] = useState<string[]>(["polymarket", "kalshi"]);
  const [page, setPage] = useState(1);

  const [markets, setMarkets] = useState<MoverMarketRow[]>([]);
  const [pageMeta, setPageMeta] = useState<MoversMeta | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const snapshotStats = useMemo(() => {
    const total = pageMeta?.totalRows ?? markets.length;
    const threshold = STRONG_THRESHOLDS_PP[sortWindow];

    const strongMoves = markets.filter((market) => {
      const lead = market.outcomes.find((outcome) => outcome.outcomeId === market.leadOutcomeId);
      const delta = lead?.deltasPp[sortWindow] ?? null;
      return delta !== null && Math.abs(delta) >= threshold;
    }).length;

    return { total, strongMoves, threshold };
  }, [markets, pageMeta?.totalRows, sortWindow]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const providersParam = providers.length > 0 ? providers.join(",") : "polymarket,kalshi";

    const load = async (showLoading: boolean): Promise<void> => {
      if (cancelled || inFlight) return;
      inFlight = true;

      const params = new URLSearchParams({
        sortWindow,
        sort: sortDir,
        tab,
        category,
        providers: providersParam,
        includeLowLiquidity: includeLowLiquidity ? "true" : "false",
        page: String(page),
        pageSize: String(PAGE_SIZE)
      });

      if (showLoading) setLoading(true);
      if (showLoading) setError(null);

      try {
        const res = await fetch(`/api/movers?${params.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { data: MoverMarketRow[]; meta?: MoversMeta };
        if (cancelled) return;
        setMarkets(json.data);
        setPageMeta(json.meta ?? null);
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
  }, [sortWindow, sortDir, tab, category, includeLowLiquidity, providers, page]);

  const toggleExpanded = (key: string): void => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const onSortClick = (windowKey: WindowKey): void => {
    setExpandedKeys(new Set());
    setPage(1);
    if (sortWindow === windowKey) {
      setSortDir((prev) => (prev === "desc" ? "asc" : "desc"));
      return;
    }
    setSortWindow(windowKey);
    setSortDir("desc");
  };

  const onSecondaryWindowChange = (next: WindowKey): void => {
    setExpandedKeys(new Set());
    setPage(1);
    setSecondaryWindow(next);
    if (sortWindow !== "1m") {
      setSortWindow(next);
    }
  };

  const leadOutcome = (market: MoverMarketRow): MoverOutcomeRow | null => {
    return market.outcomes.find((outcome) => outcome.outcomeId === market.leadOutcomeId) ?? null;
  };

  const showSecondaryWindow = secondaryWindow !== "1m";
  const tableColumnCount = showSecondaryWindow ? 7 : 6;

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
            <span>{`Strong Moves (>=${snapshotStats.threshold}pp @${WINDOW_LABELS[sortWindow]})`}</span>
            <strong>{snapshotStats.strongMoves}</strong>
          </article>
          <article>
            <span>Sort Window</span>
            <strong>{WINDOW_LABELS[sortWindow]}</strong>
          </article>
        </div>
      </section>

      <section className="control-card">
        <div className="control-row">
          <label>
            Category
            <select
              value={category}
              onChange={(e) => {
                setExpandedKeys(new Set());
                setCategory(e.target.value as (typeof CATEGORY_OPTIONS)[number]);
                setPage(1);
              }}
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
            <select
              value={tab}
              onChange={(e) => {
                setExpandedKeys(new Set());
                setTab(e.target.value as Tab);
                setPage(1);
              }}
            >
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
            className={providers.includes("polymarket") ? "chip provider-chip active" : "chip provider-chip"}
            title="Polymarket"
            aria-label="Polymarket"
            onClick={() => {
              setExpandedKeys(new Set());
              setProviders((prev) =>
                prev.includes("polymarket")
                  ? prev.filter((item) => item !== "polymarket")
                  : [...prev, "polymarket"]
              );
              setPage(1);
            }}
          >
            <ProviderLogo provider="polymarket" />
            <span className="sr-only">Polymarket</span>
          </button>
          <button
            type="button"
            className={providers.includes("kalshi") ? "chip provider-chip active" : "chip provider-chip"}
            title="Kalshi"
            aria-label="Kalshi"
            onClick={() => {
              setExpandedKeys(new Set());
              setProviders((prev) =>
                prev.includes("kalshi") ? prev.filter((item) => item !== "kalshi") : [...prev, "kalshi"]
              );
              setPage(1);
            }}
          >
            <ProviderLogo provider="kalshi" />
            <span className="sr-only">Kalshi</span>
          </button>
          <button type="button" className="chip disabled" disabled>
            Opinion (Coming soon)
          </button>

          <label className="checkbox-chip">
            <input
              type="checkbox"
              checked={includeLowLiquidity}
              onChange={(e) => {
                setExpandedKeys(new Set());
                setIncludeLowLiquidity(e.target.checked);
                setPage(1);
              }}
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

        <div className="table-toolbar">
          <label className="toolbar-label">
            Window
            <select
              value={secondaryWindow}
              onChange={(e) => onSecondaryWindowChange(e.target.value as WindowKey)}
            >
              {WINDOW_OPTIONS.map((window) => (
                <option key={window} value={window}>
                  {WINDOW_LABELS[window]}
                </option>
              ))}
            </select>
          </label>

          <details className="legend">
            <summary>Label guide</summary>
            <div className="legend-body">
              <p>
                <strong>Opaque-Info</strong>: internal / hard-to-arbitrage info could be driving the move.
              </p>
              <p>
                <strong>Exogenous</strong>: sports-live or crypto-price linked moves (often fast arbitrage).
              </p>
              <p>
                <strong>Unclear</strong>: not enough evidence either way yet.
              </p>
            </div>
          </details>
        </div>

        {loading && <p className="state-message">Loading…</p>}
        {error && <p className="state-message error">{error}</p>}

        {!loading && !error && markets.length === 0 && (
          <div className="empty-state">
            <p>No rows matched your current filters.</p>
            <button
              type="button"
              className="chip active"
              onClick={() => {
                setExpandedKeys(new Set());
                setTab("all");
                setIncludeLowLiquidity(true);
                setPage(1);
              }}
            >
              Show all signals
            </button>
          </div>
        )}

        {!loading && !error && markets.length > 0 && (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="row-no">#</th>
                    <th>Market</th>
                    <th>Provider</th>
                    <th className="delta-th">
                      <button type="button" className="th-button" onClick={() => onSortClick("1m")}>
                        {WINDOW_LABELS["1m"]}
                        {sortWindow === "1m" ? (sortDir === "desc" ? " v" : " ^") : ""}
                      </button>
                    </th>
                    {showSecondaryWindow && (
                      <th className="delta-th">
                        <button
                          type="button"
                          className="th-button"
                          onClick={() => onSortClick(secondaryWindow)}
                        >
                          {WINDOW_LABELS[secondaryWindow]}
                          {sortWindow === secondaryWindow ? (sortDir === "desc" ? " v" : " ^") : ""}
                        </button>
                      </th>
                    )}
                    <th>Category</th>
                    <th>Label</th>
                  </tr>
                </thead>
                <tbody>
                  {markets.map((market, index) => {
                    const key = `${market.provider}:${market.marketId}`;
                    const expanded = expandedKeys.has(key);
                    const rowNo = (page - 1) * PAGE_SIZE + index + 1;
                    const lead = leadOutcome(market);
                    const deltaLive = lead?.deltasPp["1m"] ?? null;
                    const deltaSecondary = showSecondaryWindow ? lead?.deltasPp[secondaryWindow] ?? null : null;
                    const legs = legsForMarket(market);
                    const url = externalMarketUrl(market);

                    return (
                      <Fragment key={key}>
                        <tr
                          className={expanded ? "market-row expanded" : "market-row"}
                          onClick={() => toggleExpanded(key)}
                        >
                          <td className="row-no">{rowNo}</td>
                          <td>
                            <p className="market-title">
                              <span className="market-title-text">
                                {displayMarketTitle(market)}
                              </span>
                              {url && (
                                <a
                                  className="market-link"
                                  href={url}
                                  target="_blank"
                                  rel="noreferrer"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                  }}
                                >
                                  Open
                                </a>
                              )}
                            </p>
                          </td>
                          <td>
                            <span className="provider-cell" title={providerDisplay(market.provider)}>
                              <ProviderLogo provider={market.provider} compact />
                            </span>
                          </td>
                          <td className={deltaClass(deltaLive)}>{toSigned(deltaLive)}</td>
                          {showSecondaryWindow && (
                            <td className={deltaClass(deltaSecondary)}>{toSigned(deltaSecondary)}</td>
                          )}
                          <td>{market.normalizedCategory}</td>
                          <td>
                            <span className={`pill ${market.label}`}>{labelDisplay(market.label)}</span>
                          </td>
                        </tr>

                        {expanded && (
                          <tr className="details-row">
                            <td colSpan={tableColumnCount}>
                              <div className="details-panel">
                                {legs.length > 0 && (
                                  <div className="legs-panel">
                                    <h3>Legs</h3>
                                    <div className="legs-grid">
                                      {legs.map((leg, legIndex) => (
                                        <div key={`${key}:leg:${legIndex}`} className="leg-chip">
                                          <span className="leg-side">{leg.side ?? "?"}</span>
                                          <span className="leg-text">{leg.text}</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                <div className="outcomes-panel">
                                  <h3>{`Outcomes (${market.outcomes.length})`}</h3>
                                  <div className="subtable-wrap">
                                    <table className="subtable">
                                      <thead>
                                        <tr>
                                          <th>Outcome</th>
                                          <th>Prob</th>
                                          <th>{WINDOW_LABELS["1m"]}</th>
                                          {showSecondaryWindow && <th>{WINDOW_LABELS[secondaryWindow]}</th>}
                                          <th>24h</th>
                                          <th>Liquidity</th>
                                          <th>Spread</th>
                                          <th>Label</th>
                                          <th>Reasons</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {market.outcomes.map((outcome) => {
                                          const live = outcome.deltasPp["1m"];
                                          const second = showSecondaryWindow ? outcome.deltasPp[secondaryWindow] : null;
                                          const day = outcome.deltasPp["24h"];
                                          const isLead = outcome.outcomeId === market.leadOutcomeId;
                                          return (
                                            <tr
                                              key={`${key}:${outcome.outcomeId}`}
                                              className={isLead ? "subrow lead" : "subrow"}
                                            >
                                              <td>{outcome.outcomeLabel}</td>
                                              <td>{(outcome.probability * 100).toFixed(2)}%</td>
                                              <td className={deltaClass(live)}>{toSigned(live)}</td>
                                              {showSecondaryWindow && (
                                                <td className={deltaClass(second)}>{toSigned(second)}</td>
                                              )}
                                              <td className={deltaClass(day)}>{toSigned(day)}</td>
                                              <td>{formatUsd(outcome.liquidityUsd)}</td>
                                              <td>
                                                {outcome.spreadPp === null
                                                  ? "-"
                                                  : `${outcome.spreadPp.toFixed(2)}pp`}
                                              </td>
                                              <td>
                                                <span className={`pill ${outcome.label}`}>{labelDisplay(outcome.label)}</span>
                                              </td>
                                              <td>
                                                <div className="reason-chips">
                                                  {outcome.reasonTags.length === 0 ? (
                                                    <span className="reason-empty">-</span>
                                                  ) : (
                                                    outcome.reasonTags.map((tag) => (
                                                      <span key={`${key}:${outcome.outcomeId}:${tag}`} className="reason-chip">
                                                        {tag}
                                                      </span>
                                                    ))
                                                  )}
                                                </div>
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {pageMeta && pageMeta.totalPages > 1 && (
              <div className="pagination-bar">
                <button
                  type="button"
                  className="chip"
                  disabled={page <= 1}
                  onClick={() => {
                    setExpandedKeys(new Set());
                    setPage((prev) => Math.max(1, prev - 1));
                  }}
                >
                  Prev
                </button>
                <span className="pagination-label">
                  Page {page} / {pageMeta.totalPages}
                </span>
                <button
                  type="button"
                  className="chip"
                  disabled={page >= pageMeta.totalPages}
                  onClick={() => {
                    setExpandedKeys(new Set());
                    setPage((prev) => prev + 1);
                  }}
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
