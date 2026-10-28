import type { Request, Response } from "express";
import { HttpError } from "./httpError.js";
import { recentAverageDurations } from "./db.js";
import type { Batch, Job } from "./db.js";
import { listPresets } from "./presets.js";
import { isActive, sendError } from "./jobs.js";

// Time estimate (FRG-76).
// The time of one job of a preset comes from, in this order:
// 1. "history": the average of the last 20 finished jobs of that preset,
// 2. "preset": estimatedSeconds in its preset.json,
// 3. "unknown": neither. A total with unknown presets is "at least" that long.
// "Time test" (timeTest.ts) makes history for every preset that can be tested.

// How many of the newest finished jobs make the average.
const HISTORY_JOBS = 20;
const MAX_ITEMS = 100;
const MAX_COUNT = 10_000;

export type EstimateSource = "history" | "preset" | "unknown";

export type PresetEstimate = { presetId: string; name: string; eachMs: number | null; source: EstimateSource };

export type Estimate = {
  totalMs: number; // Only the presets with a known time.
  perPreset: { presetId: string; name: string; count: number; eachMs: number | null; totalMs: number | null; source: EstimateSource }[];
  unknownPresets: string[];
};

// The time of one job for each of these presets. A preset id that has no folder is "unknown".
// When MongoDB cannot be reached there is no history, so only estimatedSeconds is used.
export async function presetEstimates(presetIds: string[]): Promise<Map<string, PresetEstimate>> {
  const ids = [...new Set(presetIds)];
  const presets = new Map((await listPresets()).map((preset) => [preset.id, preset]));
  let history = new Map<string, { averageMs: number }>();
  try {
    if (ids.length > 0) history = await recentAverageDurations(ids, HISTORY_JOBS);
  } catch {
    // MongoDB is offline. The values from preset.json still work.
  }

  const estimates = new Map<string, PresetEstimate>();
  for (const presetId of ids) {
    const preset = presets.get(presetId);
    const name = preset?.name ?? presetId;
    const averageMs = history.get(presetId)?.averageMs;
    if (averageMs !== undefined) estimates.set(presetId, { presetId, name, eachMs: averageMs, source: "history" });
    else if (preset?.estimatedSeconds) estimates.set(presetId, { presetId, name, eachMs: preset.estimatedSeconds * 1000, source: "preset" });
    else estimates.set(presetId, { presetId, name, eachMs: null, source: "unknown" });
  }
  return estimates;
}

// The time for a list of jobs: how many of each preset. The same preset twice is counted together.
export async function estimateJobs(items: { presetId: string; count: number }[]): Promise<Estimate> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.presetId, (counts.get(item.presetId) ?? 0) + item.count);
  const estimates = await presetEstimates([...counts.keys()]);

  const perPreset = [...counts].map(([presetId, count]) => {
    const { name, eachMs, source } = estimates.get(presetId)!;
    return { presetId, name, count, eachMs, totalMs: eachMs === null ? null : eachMs * count, source };
  });
  return {
    totalMs: perPreset.reduce((sum, row) => sum + (row.totalMs ?? 0), 0),
    perPreset,
    unknownPresets: perPreset.filter((row) => row.source === "unknown").map((row) => row.presetId),
  };
}

// POST /api/estimate
// Body: { "items": [{ "presetId": "text-to-image-basic", "count": 10 }, ...] }.
// Answer: { totalMs, perPreset: [{ presetId, name, count, eachMs, totalMs, source }], unknownPresets }.
// eachMs and totalMs of an "unknown" preset are null. An id with no preset folder answers 400.
export async function estimateHandler(req: Request, res: Response) {
  try {
    const items: unknown = req.body?.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
      throw new HttpError(400, `items must be a list of 1 to ${MAX_ITEMS} { presetId, count }.`);
    }
    const presetIds = new Set((await listPresets()).map((preset) => preset.id));
    for (const item of items) {
      if (typeof item?.presetId !== "string" || !presetIds.has(item.presetId)) {
        throw new HttpError(400, `There is no preset "${String(item?.presetId)}".`);
      }
      if (!Number.isInteger(item.count) || item.count < 1 || item.count > MAX_COUNT) {
        throw new HttpError(400, `count must be a whole number from 1 to ${MAX_COUNT}.`);
      }
    }
    res.json(await estimateJobs(items as { presetId: string; count: number }[]));
  } catch (error) {
    sendError(res, error);
  }
}

// ---- Time left of a batch (FRG-75) ----

export type TimeLeft = {
  done: number;
  left: number; // Cards not done or failed, with the running one.
  failed: number;
  leftMs: number; // Only the cards with a known time.
  finishAt: Date; // now + leftMs.
  unknownCards: number; // Cards left whose preset time is not known: the real time is longer.
};

// How long the rest of a batch takes. cards: the batch's cards by id (from memory or MongoDB).
// 1. Each card not run yet: this batch's own average for that preset once one of its cards of that
//    preset finished, otherwise the estimate above.
// 2. The running card: its time minus how long it has run (never below 0).
export async function batchTimeLeft(batch: Batch, left: string[], cards: Map<string, Job>): Promise<TimeLeft> {
  const now = Date.now();

  // This batch's own average per preset, from its finished cards.
  const own = new Map<string, { sum: number; count: number }>();
  for (const id of batch.doneCardIds) {
    const card = cards.get(id);
    if (!card?.presetId || card.durationMs <= 0) continue;
    const entry = own.get(card.presetId) ?? { sum: 0, count: 0 };
    entry.sum += card.durationMs;
    entry.count += 1;
    own.set(card.presetId, entry);
  }

  const leftCards = left.map((id) => cards.get(id));
  const estimates = await presetEstimates(
    leftCards.flatMap((card) => (card?.presetId && !own.has(card.presetId) ? [card.presetId] : [])),
  );

  let leftMs = 0;
  let unknownCards = 0;
  for (const card of leftCards) {
    const presetId = card?.presetId;
    const mine = presetId ? own.get(presetId) : undefined;
    const eachMs = mine ? mine.sum / mine.count : presetId ? estimates.get(presetId)?.eachMs : null;
    if (!card || eachMs === null || eachMs === undefined) {
      unknownCards += 1;
      continue;
    }
    // The running card: only the part that is still to come. createdAt is when it started (runDraft).
    const running = card.id === batch.currentCardId && isActive(card.status);
    leftMs += running ? Math.max(0, eachMs - (now - new Date(card.createdAt).getTime())) : eachMs;
  }
  leftMs = Math.round(leftMs);

  return {
    done: batch.doneCardIds.length,
    left: left.length,
    failed: batch.failedCardIds.length,
    leftMs,
    finishAt: new Date(now + leftMs),
    unknownCards,
  };
}
