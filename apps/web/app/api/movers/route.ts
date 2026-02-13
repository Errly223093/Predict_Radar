import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { type MoverMarketRow, type MoverOutcomeRow, WINDOWS, type WindowKey } from "@/lib/contracts";

const DELTA_COLUMN_MAP: Record<WindowKey, string> = {
  "1m": "d.delta_1m",
  "5m": "d.delta_5m",
  "10m": "d.delta_10m",
  "30m": "d.delta_30m",
  "1h": "d.delta_1h",
  "6h": "d.delta_6h",
  "12h": "d.delta_12h",
  "24h": "d.delta_24h"
};

const VALID_PROVIDERS = ["polymarket", "kalshi", "opinion"] as const;

type TabFilter = "opaque" | "exogenous" | "all";

type LeadMarketQueryRow = {
  provider: "polymarket" | "kalshi" | "opinion";
  market_id: string;
  market_title: string;
  normalized_category: MoverMarketRow["normalizedCategory"];
  metadata_json: Record<string, unknown> | null;
  lead_outcome_id: string;
  lead_label: MoverMarketRow["label"];
  lead_reason_tags: string[];
  lead_sort_delta: number | null;
  ts_minute: Date;
};

type OutcomeQueryRow = {
  provider: "polymarket" | "kalshi" | "opinion";
  market_id: string;
  market_title: string;
  normalized_category: MoverMarketRow["normalizedCategory"];
  metadata_json: Record<string, unknown> | null;
  outcome_id: string;
  outcome_label: string;
  probability: number;
  volume_24h_usd: number | null;
  liquidity_usd: number | null;
  spread_pp: number | null;
  label: MoverOutcomeRow["label"];
  reason_tags: string[];
  delta_1m: number | null;
  delta_5m: number | null;
  delta_10m: number | null;
  delta_30m: number | null;
  delta_1h: number | null;
  delta_6h: number | null;
  delta_12h: number | null;
  delta_24h: number | null;
  ts_minute: Date;
};

function parseWindow(value: string | null, fallback: WindowKey): WindowKey {
  if (value && WINDOWS.includes(value as WindowKey)) {
    return value as WindowKey;
  }
  return fallback;
}

function parseTab(value: string | null): TabFilter {
  if (value === "opaque" || value === "exogenous" || value === "all") return value;
  return "all";
}

function parsePage(value: string | null): number {
  const numeric = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) return 1;
  return Math.max(1, Math.floor(numeric));
}

function parsePageSize(value: string | null): number {
  const numeric = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) return 50;
  return Math.max(10, Math.min(100, Math.floor(numeric)));
}

function parseProviders(value: string | null): string[] {
  if (!value) return ["polymarket", "kalshi"];

  const parsed = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => VALID_PROVIDERS.includes(item as (typeof VALID_PROVIDERS)[number]));

  return parsed.length > 0 ? parsed : ["polymarket", "kalshi"];
}

function toNumber(value: number | null): number | null {
  return value === null ? null : Number(value);
}

function toArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as unknown[]).map((item) => String(item)) : [];
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);

    const sortWindow = parseWindow(
      searchParams.get("sortWindow") ?? searchParams.get("window"),
      "1m"
    );
    const sortDir = searchParams.get("sort") === "asc" ? "ASC" : "DESC";
    const page = parsePage(searchParams.get("page"));
    const pageSize = parsePageSize(searchParams.get("pageSize"));
    const offset = (page - 1) * pageSize;

    const providers = parseProviders(searchParams.get("providers"));
    const category = searchParams.get("category")?.trim().toLowerCase() ?? "";
    const tab = parseTab(searchParams.get("tab"));
    const minLiquidity = Number(searchParams.get("minLiquidity") ?? "5000");
    const maxSpread = Number(searchParams.get("maxSpread") ?? "15");
    const includeLowLiquidity = searchParams.get("includeLowLiquidity") === "true";

    const sortColumn = DELTA_COLUMN_MAP[sortWindow];

    const wherePartsBase: string[] = ["d.provider = ANY($1::text[])"];
    const paramsBase: unknown[] = [providers];
    let cursor = paramsBase.length + 1;

    if (category && category !== "all") {
      wherePartsBase.push(`m.normalized_category = $${cursor}`);
      paramsBase.push(category);
      cursor += 1;
    }

    if (!includeLowLiquidity) {
      wherePartsBase.push(`COALESCE(s.liquidity_usd, 0) >= $${cursor}`);
      paramsBase.push(Number.isFinite(minLiquidity) ? minLiquidity : 5000);
      cursor += 1;

      wherePartsBase.push(`COALESCE(s.spread_pp, 100) <= $${cursor}`);
      paramsBase.push(Number.isFinite(maxSpread) ? maxSpread : 15);
      cursor += 1;
    }

    const wherePartsSelection = [...wherePartsBase];
    if (tab === "opaque") {
      wherePartsSelection.push(`COALESCE(c.label, 'unclear') = 'opaque_info_sensitive'`);
    } else if (tab === "exogenous") {
      wherePartsSelection.push(`COALESCE(c.label, 'unclear') = 'exogenous_arbitrage'`);
    }

    const selectionWhere = wherePartsSelection.join(" AND ");
    const baseWhere = wherePartsBase.join(" AND ");

    const countQuery = `
      WITH latest AS (
        SELECT MAX(ts_minute) AS ts
        FROM deltas
      )
      SELECT COUNT(*)::int AS total_markets
      FROM (
        SELECT d.provider, d.market_id
        FROM deltas d
        JOIN latest l ON d.ts_minute = l.ts
        JOIN markets m
          ON m.provider = d.provider
         AND m.market_id = d.market_id
        JOIN outcomes o
          ON o.provider = d.provider
         AND o.market_id = d.market_id
         AND o.outcome_id = d.outcome_id
        JOIN snapshots_1m s
          ON s.ts_minute = d.ts_minute
         AND s.provider = d.provider
         AND s.market_id = d.market_id
         AND s.outcome_id = d.outcome_id
        LEFT JOIN classification_scores c
          ON c.ts_minute = d.ts_minute
         AND c.provider = d.provider
         AND c.market_id = d.market_id
         AND c.outcome_id = d.outcome_id
        WHERE ${selectionWhere}
        GROUP BY d.provider, d.market_id
      ) t
    `;

    const countResult = await pool.query<{ total_markets: number }>(countQuery, paramsBase);
    const totalRows = countResult.rows[0]?.total_markets ?? 0;
    const totalPages = totalRows === 0 ? 0 : Math.ceil(totalRows / pageSize);

    const leadParams = [...paramsBase, pageSize, offset];
    const limitParam = paramsBase.length + 1;
    const offsetParam = paramsBase.length + 2;

    const leadQuery = `
      WITH latest AS (
        SELECT MAX(ts_minute) AS ts
        FROM deltas
      ),
      base AS (
        SELECT
          d.provider,
          d.market_id,
          d.outcome_id,
          m.title AS market_title,
          m.normalized_category,
          m.metadata_json,
          COALESCE(c.label, 'unclear') AS label,
          COALESCE(c.reason_tags, '{}'::text[]) AS reason_tags,
          ${sortColumn} AS sort_delta,
          d.ts_minute
        FROM deltas d
        JOIN latest l ON d.ts_minute = l.ts
        JOIN markets m
          ON m.provider = d.provider
         AND m.market_id = d.market_id
        JOIN outcomes o
          ON o.provider = d.provider
         AND o.market_id = d.market_id
         AND o.outcome_id = d.outcome_id
        JOIN snapshots_1m s
          ON s.ts_minute = d.ts_minute
         AND s.provider = d.provider
         AND s.market_id = d.market_id
         AND s.outcome_id = d.outcome_id
        LEFT JOIN classification_scores c
          ON c.ts_minute = d.ts_minute
         AND c.provider = d.provider
         AND c.market_id = d.market_id
         AND c.outcome_id = d.outcome_id
        WHERE ${selectionWhere}
      ),
      ranked AS (
        SELECT
          provider,
          market_id,
          market_title,
          normalized_category,
          metadata_json,
          outcome_id AS lead_outcome_id,
          label AS lead_label,
          reason_tags AS lead_reason_tags,
          sort_delta AS lead_sort_delta,
          ts_minute,
          ROW_NUMBER() OVER (
            PARTITION BY provider, market_id
            ORDER BY sort_delta ${sortDir} NULLS LAST
          ) AS rn
        FROM base
      )
      SELECT
        provider,
        market_id,
        market_title,
        normalized_category,
        metadata_json,
        lead_outcome_id,
        lead_label,
        lead_reason_tags,
        lead_sort_delta,
        ts_minute
      FROM ranked
      WHERE rn = 1
      ORDER BY lead_sort_delta ${sortDir} NULLS LAST
      LIMIT $${limitParam}
      OFFSET $${offsetParam}
    `;

    const leadResult = await pool.query<LeadMarketQueryRow>(leadQuery, leadParams);
    const leadRows = leadResult.rows;

    if (leadRows.length === 0) {
      return NextResponse.json({
        data: [],
        meta: {
          sortWindow,
          sort: sortDir.toLowerCase(),
          page,
          pageSize,
          totalRows,
          totalPages
        }
      });
    }

    const marketMap = new Map<string, MoverMarketRow>();
    for (const row of leadRows) {
      const key = `${row.provider}:${row.market_id}`;
      marketMap.set(key, {
        provider: row.provider,
        marketId: row.market_id,
        marketTitle: row.market_title,
        normalizedCategory: row.normalized_category,
        label: row.lead_label,
        reasonTags: toArray(row.lead_reason_tags),
        leadOutcomeId: row.lead_outcome_id,
        marketMeta: row.metadata_json ?? null,
        outcomes: [],
        timestamp: new Date(row.ts_minute).toISOString()
      });
    }

    const marketProviders = leadRows.map((row) => row.provider);
    const marketIds = leadRows.map((row) => row.market_id);

    const outcomesParams: unknown[] = [marketProviders, marketIds];
    let outcomesWhere = "TRUE";
    if (!includeLowLiquidity) {
      outcomesWhere = `COALESCE(s.liquidity_usd, 0) >= $3 AND COALESCE(s.spread_pp, 100) <= $4`;
      outcomesParams.push(Number.isFinite(minLiquidity) ? minLiquidity : 5000);
      outcomesParams.push(Number.isFinite(maxSpread) ? maxSpread : 15);
    }

    const outcomesQuery = `
      WITH latest AS (
        SELECT MAX(ts_minute) AS ts
        FROM deltas
      ),
      pairs AS (
        SELECT * FROM unnest($1::text[], $2::text[]) AS t(provider, market_id)
      )
      SELECT
        d.provider,
        d.market_id,
        m.title AS market_title,
        m.normalized_category,
        m.metadata_json,
        d.outcome_id,
        o.label AS outcome_label,
        s.probability,
        s.volume_24h_usd,
        s.liquidity_usd,
        s.spread_pp,
        COALESCE(c.label, 'unclear') AS label,
        COALESCE(c.reason_tags, '{}'::text[]) AS reason_tags,
        d.delta_1m,
        d.delta_5m,
        d.delta_10m,
        d.delta_30m,
        d.delta_1h,
        d.delta_6h,
        d.delta_12h,
        d.delta_24h,
        d.ts_minute
      FROM pairs p
      JOIN deltas d
        ON d.provider = p.provider
       AND d.market_id = p.market_id
      JOIN latest l ON d.ts_minute = l.ts
      JOIN markets m
        ON m.provider = d.provider
       AND m.market_id = d.market_id
      JOIN outcomes o
        ON o.provider = d.provider
       AND o.market_id = d.market_id
       AND o.outcome_id = d.outcome_id
      JOIN snapshots_1m s
        ON s.ts_minute = d.ts_minute
       AND s.provider = d.provider
       AND s.market_id = d.market_id
       AND s.outcome_id = d.outcome_id
      LEFT JOIN classification_scores c
        ON c.ts_minute = d.ts_minute
       AND c.provider = d.provider
       AND c.market_id = d.market_id
       AND c.outcome_id = d.outcome_id
      WHERE ${outcomesWhere}
      ORDER BY d.provider, d.market_id, ABS(${sortColumn}) DESC NULLS LAST
    `;

    const outcomeResult = await pool.query<OutcomeQueryRow>(outcomesQuery, outcomesParams);

    for (const row of outcomeResult.rows) {
      const key = `${row.provider}:${row.market_id}`;
      const market = marketMap.get(key);
      if (!market) continue;

      const outcome: MoverOutcomeRow = {
        provider: row.provider,
        marketId: row.market_id,
        marketTitle: row.market_title,
        outcomeId: row.outcome_id,
        outcomeLabel: row.outcome_label,
        normalizedCategory: row.normalized_category,
        probability: Number(row.probability),
        volume24hUsd: toNumber(row.volume_24h_usd),
        liquidityUsd: toNumber(row.liquidity_usd),
        spreadPp: toNumber(row.spread_pp),
        label: row.label,
        reasonTags: toArray(row.reason_tags),
        deltasPp: {
          "1m": toNumber(row.delta_1m),
          "5m": toNumber(row.delta_5m),
          "10m": toNumber(row.delta_10m),
          "30m": toNumber(row.delta_30m),
          "1h": toNumber(row.delta_1h),
          "6h": toNumber(row.delta_6h),
          "12h": toNumber(row.delta_12h),
          "24h": toNumber(row.delta_24h)
        },
        timestamp: new Date(row.ts_minute).toISOString()
      };

      market.outcomes.push(outcome);
    }

    const data = leadRows
      .map((row) => marketMap.get(`${row.provider}:${row.market_id}`))
      .filter(Boolean) as MoverMarketRow[];

    return NextResponse.json({
      data,
      meta: {
        sortWindow,
        sort: sortDir.toLowerCase(),
        page,
        pageSize,
        totalRows,
        totalPages
      }
    });
  } catch (error) {
    console.error("[api/movers] failed", error);
    return NextResponse.json(
      { error: "Failed to load movers." },
      {
        status: 500
      }
    );
  }
}

