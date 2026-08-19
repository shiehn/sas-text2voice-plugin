/**
 * Phrases — the shared structural view of a distributed lead line.
 *
 * A phrase is a contiguous run of syllable slots with silence after it. ONE
 * implementation feeds everything that thinks in phrases: the breath guard,
 * tag-team shouts (the group punches each phrase's final word), adlib echoes
 * (into the gap AFTER a phrase), and rhyme targeting (phrase-final syllables).
 *
 * Boundaries carry a KIND. A `'rest'` was written by the composer — a real
 * musical phrase end, and the only kind shouts/echoes/rhymes attach to. A
 * `'breath'` was carved by the guard mid-run so a singer could survive the
 * line — structurally a gap, musically an interruption, and invisible to the
 * phrase-final machinery.
 */

import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';
import { MIN_SLOT_BEATS } from './distribute';

/** Two slots this close in time are the same run. */
const GAP_EPSILON_BEATS = 1e-3;

/** Longest continuous sing before the guard carves a breath (seconds). */
export const MAX_BREATH_SEC = 3.5;
/** The catch-breath gap the guard opens (seconds). */
export const BREATH_GAP_SEC = 0.35;

export interface PhraseSpan {
  /** [startSlot, endSlot) into the lead slot array. */
  startSlot: number;
  endSlot: number;
  startBeat: number;
  /** End of the last slot in the span. */
  endBeat: number;
  /** Silence after this span, to the next span or the scene end. */
  gapBeats: number;
  /** What ENDS this span: a composed rest or a carved catch-breath. */
  boundary: 'rest' | 'breath';
}

/**
 * Split a slot timeline into phrases at its gaps.
 *
 * `breathAfterSlot` marks slot indexes the breath guard carved after — those
 * boundaries are tagged `'breath'`; everything else that ends at a genuine
 * time gap (or the scene end) is a `'rest'`.
 */
export function detectPhrases(
  slots: PluginMidiNote[],
  sceneBeats: number,
  breathAfterSlot: ReadonlySet<number> = new Set(),
): PhraseSpan[] {
  if (slots.length === 0) return [];
  const phrases: PhraseSpan[] = [];
  let start = 0;

  for (let i = 0; i < slots.length; i++) {
    const cur = slots[i];
    const curEnd = cur.startBeat + cur.durationBeats;
    const next = slots[i + 1];
    const gapToNext = next ? next.startBeat - curEnd : Math.max(0, sceneBeats - curEnd);
    const isBoundary = !next || gapToNext > GAP_EPSILON_BEATS;
    if (!isBoundary) continue;

    phrases.push({
      startSlot: start,
      endSlot: i + 1,
      startBeat: slots[start].startBeat,
      endBeat: curEnd,
      gapBeats: gapToNext,
      boundary: breathAfterSlot.has(i) ? 'breath' : 'rest',
    });
    start = i + 1;
  }
  return phrases;
}

export interface BreathGuardResult {
  /** The slot array with carved durations — count and order UNCHANGED. */
  slots: PluginMidiNote[];
  /** Slot indexes a breath was carved after (feed to detectPhrases). */
  breathAfterSlot: Set<number>;
  /** How many breaths were carved. */
  carved: number;
  /** Runs that exceeded the limit but had no slot long enough to carve. */
  uncarvable: number;
}

/**
 * Carve catch-breaths INSIDE over-long runs.
 *
 * Walks each rest-delimited run accumulating continuous singing time; every
 * time it crosses `maxBreathBeats` the CURRENT slot is shortened to open a
 * `breathBeats` gap after it (falling back to the previous slot when the
 * current one is too short to give; skipping — and counting — when neither
 * can). Only DURATIONS change: slot count and indexes are untouched, so the
 * slots↔syllables mapping survives unmodified.
 *
 * Shortening only a run's FINAL slot would let a twenty-second run keep its
 * twenty seconds and breathe after — the whole point is a gap mid-run.
 */
export function applyBreathGuard(
  slots: PluginMidiNote[],
  maxBreathBeats: number,
  breathBeats: number,
): BreathGuardResult {
  const out = slots.map((s) => ({ ...s }));
  const breathAfterSlot = new Set<number>();
  let carved = 0;
  let uncarvable = 0;

  let runStart = 0;
  let sung = 0;

  // Shorten slot `idx`'s duration: because startBeats are absolute, the gap
  // opens right AFTER idx, between it and its successor. Returns the slot the
  // gap follows, or -1 when neither candidate can give the beats.
  //
  // The PREVIOUS slot is preferred: the limit is only noticed once the
  // current slot has pushed the run OVER it, so ending the run after the
  // previous slot keeps every finished run at or under the lungful. Carving
  // at the current slot instead would end runs one slot too late — a 4-beat
  // limit yielding 5.5-beat runs.
  const carveAfter = (i: number): number => {
    for (const idx of [i - 1, i]) {
      if (idx < runStart) continue;
      if (out[idx].durationBeats - breathBeats >= MIN_SLOT_BEATS - 1e-9) {
        out[idx].durationBeats -= breathBeats;
        breathAfterSlot.add(idx);
        return idx;
      }
    }
    return -1;
  };

  for (let i = 0; i < out.length; i++) {
    const cur = out[i];
    if (i > runStart) {
      const prev = out[i - 1];
      const gap = cur.startBeat - (prev.startBeat + prev.durationBeats);
      if (gap > GAP_EPSILON_BEATS) {
        runStart = i;
        sung = 0;
      }
    }
    sung += cur.durationBeats;
    if (sung > maxBreathBeats) {
      const at = carveAfter(i);
      if (at >= 0) {
        carved += 1;
        // The gap sits after `at`. Carved at i-1 → the current slot begins
        // the next run; carved at i itself → the next run starts empty.
        runStart = at + 1;
        sung = at === i ? 0 : cur.durationBeats;
      } else {
        uncarvable += 1;
        sung = 0;
      }
    }
  }

  return { slots: out, breathAfterSlot, carved, uncarvable };
}

/** Beat-domain limits for a scene tempo. */
export function breathLimitsForBpm(bpm: number): { maxBreathBeats: number; breathBeats: number } {
  const beatsPerSec = bpm / 60;
  return {
    maxBreathBeats: MAX_BREATH_SEC * beatsPerSec,
    breathBeats: BREATH_GAP_SEC * beatsPerSec,
  };
}
