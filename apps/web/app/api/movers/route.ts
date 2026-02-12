import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { type MoverRow, WINDOWS, type WindowKey } from "@/lib/contracts";

const ORDER_COLUMN_MAP: Record<WindowKey, string> = {
  "3m": "d.delta_3m",
  "9m": "d.delta_9m",
  "30m": "d.delta_30m",
  "1h": "d.delta_1h",
  "3h": "d.delta_3h",
  "6h": "d.delta_6h",
  "12h": "d.delta_12h",
  "24h": "d.delta_24h"
};

const VALID_PROVIDERS = ["polymarket", "kalshi", "opinion"] as const;

type TabFilter = "opaque" | "exogenous" | "all";

type MoverQueryRow = {
  provider: "polymarket" | "kalshi" | "opinion";
  market_id: string;
  market_title: string;
  outcome_id: string;
  outcome_label: string;
  normalized_category: MoverRow["normalizedCategory"];
  probability: number;
  volume_24h_usd: number | null;
  liquidity_usd: number | null;
  label: MoverRow["label"];
  reason_tags: string[];
  delta_3m: number | null;
  delta_9m: number | null;
  delta_30m: number | null;
  delta_1h: number | null;
  delta_3h: number | null;
  delta_6h: number | null;
  delta_12h: number | null;
  delta_24h: number | null;
  ts_minute: Date;
};

function parseWindow(value: string | null): WindowKey {
  if (value && WINDOWS.includes(value as WindowKey)) {
    return value as WindowKey;
  }
  return "3m";
}

function parseTab(value: string | null): TabFilter {
  if (value === "opaque" || value === "exogenous" || value === "all") return value;
  return "opaque";
}

function parseProviders(value: string | null): string[] {
  if (!value) return ["polymarket", "kalshi"];

  const parsed = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => VALID_PROVIDERS.includes(item as (typeof VALID_PROVIDERS)[number]));

  return parsed.length > 0 ? parsed : ["polymarket", "kalshi"];
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);

    const windowKey = parseWindow(searchParams.get("window"));
    const sortDir = searchParams.get("sort") === "asc" ? "ASC" : "DESC";
    const providers = parseProviders(searchParams.get("providers"));
    const category = searchParams.get("category")?.trim().toLowerCase() ?? "";
    const tab = parseTab(searchParams.get("tab"));
    const minLiquidity = Number(searchParams.get("minLiquidity") ?? "5000");
    const maxSpread = Number(searchParams.get("maxSpread") ?? "15");
    const includeLowLiquidity = searchParams.get("includeLowLiquidity") === "true";
    const limitRaw = Number(searchParams.get("limit") ?? "200");
    const limit = Number.isFinite(limitRaw) ? Math.max(20, Math.min(500, limitRaw)) : 200;

    const whereParts: string[] = ["d.provider = ANY($1::text[])"];
    const params: unknown[] = [providers];
    let cursor = params.length + 1;

    if (category && category !== "all") {
      whereParts.push(`m.normalized_category = $${cursor}`);
      params.push(category);
      cursor += 1;
    }

    if (tab === "opaque") {
      whereParts.push(`COALESCE(c.label, 'unclear') = 'opaque_info_sensitive'`);
    } else if (tab === "exogenous") {
      whereParts.push(`COALESCE(c.label, 'unclear') = 'exogenous_arbitrage'`);
    }

    if (!includeLowLiquidity) {
      whereParts.push(`COALESCE(s.liquidity_usd, 0) >= $${cursor}`);
      params.push(Number.isFinite(minLiquidity) ? minLiquidity : 5000);
      cursor += 1;

      whereParts.push(`COALESCE(s.spread_pp, 100) <= $${cursor}`);
      params.push(Number.isFinite(maxSpread) ? maxSpread : 15);
      cursor += 1;
    }

    params.push(limit);

    const orderColumn = ORDER_COLUMN_MAP[windowKey];

    const query = `
      WITH latest AS (
        SELECT MAX(ts_minute) AS ts
        FROM deltas
      )
      SELECT
        d.provider,
        d.market_id,
        m.title AS market_title,
        d.outcome_id,
        o.label AS outcome_label,
        m.normalized_category,
        s.probability,
        s.volume_24h_usd,
        s.liquidity_usd,
        COALESCE(c.label, 'unclear') AS label,
        COALESCE(c.reason_tags, '{}'::text[]) AS reason_tags,
        d.delta_3m,
        d.delta_9m,
        d.delta_30m,
        d.delta_1h,
        d.delta_3h,
        d.delta_6h,
        d.delta_12h,
        d.delta_24h,
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
      WHERE ${whereParts.join(" AND ")}
      ORDER BY ${orderColumn} ${sortDir} NULLS LAST
      LIMIT $${params.length}
    `;

    const result = await pool.query<MoverQueryRow>(query, params);

    const data: MoverRow[] = result.rows.map((row) => ({
      provider: row.provider,
      marketId: row.market_id,
      marketTitle: row.market_title,
      outcomeId: row.outcome_id,
      outcomeLabel: row.outcome_label,
      normalizedCategory: row.normalized_category,
      probability: Number(row.probability),
      volume24hUsd: row.volume_24h_usd === null ? null : Number(row.volume_24h_usd),
      liquidityUsd: row.liquidity_usd === null ? null : Number(row.liquidity_usd),
      label: row.label,
      reasonTags: Array.isArray(row.reason_tags) ? row.reason_tags : [],
      deltasPp: {
        "3m": row.delta_3m === null ? null : Number(row.delta_3m),
        "9m": row.delta_9m === null ? null : Number(row.delta_9m),
        "30m": row.delta_30m === null ? null : Number(row.delta_30m),
        "1h": row.delta_1h === null ? null : Number(row.delta_1h),
        "3h": row.delta_3h === null ? null : Number(row.delta_3h),
        "6h": row.delta_6h === null ? null : Number(row.delta_6h),
        "12h": row.delta_12h === null ? null : Number(row.delta_12h),
        "24h": row.delta_24h === null ? null : Number(row.delta_24h)
      },
      timestamp: new Date(row.ts_minute).toISOString()
    }));

    return NextResponse.json({ data, meta: { window: windowKey, sort: sortDir.toLowerCase() } });
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
