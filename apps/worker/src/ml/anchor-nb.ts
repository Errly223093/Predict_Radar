import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const ANCHOR_TYPES = [
  "spot_price_anchored",
  "live_score_anchored",
  "scheduled_macro_release",
  "policy_regulatory_decision",
  "sports_team_news",
  "crypto_news_security",
  "other_unknown"
] as const;

export type AnchorType = (typeof ANCHOR_TYPES)[number];

export function anchorTypeInsiderPossible(anchorType: AnchorType): boolean {
  return anchorType !== "spot_price_anchored" && anchorType !== "live_score_anchored";
}

function tokenize(text: string): string[] {
  const raw = text.split(" ").map((t) => t.trim()).filter(Boolean);

  const tokens: string[] = [];
  for (const token of raw) {
    if (token.length <= 1 && token !== "$" && token !== "+" && token !== "-") continue;
    tokens.push(token);
  }

  // Add light bigrams to capture phrases like "wins by", "rate hike", etc.
  for (let i = 0; i < Math.min(tokens.length, 80) - 1; i += 1) {
    tokens.push(`${tokens[i]}_${tokens[i + 1]}`);
  }

  return tokens;
}

function stableHash(input: string): number {
  // djb2
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return hash >>> 0;
}

function round(value: number, digits = 6): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

export type AnchorNbModelJson = {
  modelVersion: string;
  createdAt: string;
  anchorTypes: AnchorType[];
  vocab: string[];
  alpha: number;
  logPrior: number[];
  logProb: number[][];
};

export class AnchorNbModel {
  readonly modelVersion: string;
  readonly anchorTypes: AnchorType[];
  readonly vocab: string[];
  readonly alpha: number;
  readonly logPrior: Float64Array;
  readonly logProb: Float64Array[];
  private readonly vocabIndex: Map<string, number>;

  constructor(json: AnchorNbModelJson) {
    this.modelVersion = json.modelVersion;
    this.anchorTypes = json.anchorTypes;
    this.vocab = json.vocab;
    this.alpha = json.alpha;
    this.logPrior = new Float64Array(json.logPrior);
    this.logProb = json.logProb.map((row) => new Float64Array(row));

    const index = new Map<string, number>();
    for (let i = 0; i < this.vocab.length; i += 1) {
      index.set(this.vocab[i], i);
    }
    this.vocabIndex = index;
  }

  predict(text: string): { anchorType: AnchorType; confidence: number; scores: Record<string, number> } {
    const tokens = tokenize(text);
    const scoresArr = new Float64Array(this.anchorTypes.length);

    for (let c = 0; c < this.anchorTypes.length; c += 1) {
      let score = this.logPrior[c] ?? 0;
      const row = this.logProb[c];
      for (const token of tokens) {
        const idx = this.vocabIndex.get(token);
        if (idx === undefined) continue;
        score += row[idx] ?? 0;
      }
      scoresArr[c] = score;
    }

    // Softmax confidence for the top class.
    let max = -Infinity;
    let best = 0;
    for (let c = 0; c < scoresArr.length; c += 1) {
      const value = scoresArr[c];
      if (value > max) {
        max = value;
        best = c;
      }
    }

    let sum = 0;
    for (let c = 0; c < scoresArr.length; c += 1) {
      sum += Math.exp(scoresArr[c] - max);
    }
    const confidence = sum === 0 ? 0 : Math.exp(scoresArr[best] - max) / sum;

    const scores: Record<string, number> = {};
    for (let c = 0; c < this.anchorTypes.length; c += 1) {
      scores[this.anchorTypes[c]] = round(scoresArr[c], 4);
    }

    return {
      anchorType: this.anchorTypes[best] ?? "other_unknown",
      confidence: round(confidence, 4),
      scores
    };
  }
}

export function trainAnchorNbModel(examples: Array<{ text: string; anchorType: AnchorType }>, options?: {
  maxVocab?: number;
  minDf?: number;
  alpha?: number;
  modelVersion?: string;
}): AnchorNbModelJson {
  const maxVocab = Math.max(800, Math.min(8000, options?.maxVocab ?? 3500));
  const minDf = Math.max(2, Math.min(20, options?.minDf ?? 3));
  const alpha = options?.alpha ?? 1.0;
  const modelVersion = options?.modelVersion ?? "anchor-nb-v1";

  const df = new Map<string, number>();
  for (const example of examples) {
    const seen = new Set(tokenize(example.text));
    for (const token of seen) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }

  const vocab = Array.from(df.entries())
    .filter(([, count]) => count >= minDf)
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, maxVocab)
    .map(([token]) => token);

  const vocabIndex = new Map<string, number>();
  for (let i = 0; i < vocab.length; i += 1) vocabIndex.set(vocab[i], i);

  const classIndex = new Map<AnchorType, number>();
  for (let i = 0; i < ANCHOR_TYPES.length; i += 1) classIndex.set(ANCHOR_TYPES[i], i);

  const classDocCounts = new Array<number>(ANCHOR_TYPES.length).fill(0);
  const tokenCounts: Float64Array[] = Array.from({ length: ANCHOR_TYPES.length }, () => new Float64Array(vocab.length));
  const totalTokenCounts = new Array<number>(ANCHOR_TYPES.length).fill(0);

  for (const example of examples) {
    const c = classIndex.get(example.anchorType) ?? classIndex.get("other_unknown") ?? 0;
    classDocCounts[c] += 1;

    for (const token of tokenize(example.text)) {
      const idx = vocabIndex.get(token);
      if (idx === undefined) continue;
      tokenCounts[c][idx] += 1;
      totalTokenCounts[c] += 1;
    }
  }

  const totalDocs = examples.length || 1;
  const logPrior = classDocCounts.map((count) => round(Math.log(Math.max(1e-9, count / totalDocs)), 8));

  const logProb: number[][] = [];
  const vocabSize = vocab.length || 1;
  for (let c = 0; c < ANCHOR_TYPES.length; c += 1) {
    const denom = totalTokenCounts[c] + alpha * vocabSize;
    const row: number[] = new Array(vocabSize);
    for (let i = 0; i < vocabSize; i += 1) {
      row[i] = round(Math.log((tokenCounts[c][i] + alpha) / denom), 8);
    }
    logProb.push(row);
  }

  return {
    modelVersion,
    createdAt: new Date().toISOString(),
    anchorTypes: [...ANCHOR_TYPES],
    vocab,
    alpha,
    logPrior,
    logProb
  };
}

export async function saveAnchorNbModel(model: AnchorNbModelJson, filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(model), "utf-8");
}

export async function loadAnchorNbModel(filePath: string): Promise<AnchorNbModel | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const json = JSON.parse(raw) as AnchorNbModelJson;
    if (!Array.isArray(json.vocab) || !Array.isArray(json.logProb)) return null;
    return new AnchorNbModel(json);
  } catch {
    return null;
  }
}

export function deterministicSplitKey(provider: string, marketId: string): number {
  return stableHash(`${provider}:${marketId}`) % 10;
}

