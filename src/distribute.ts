/**
 * Spreading a phrase across a melody.
 *
 * The melody supplies the pitch contour and, just as importantly, the
 * BREATHING — where the rests fall. It does not supply one note per syllable.
 * Each note instead carries as many syllables as fit at a chosen subdivision,
 * which is how text is actually set to music:
 *
 *     melody:   quarter        (rest)      half
 *     sung as:  2 eighths      (rest)      4 eighths
 *
 * One uniform rate across the whole line, so it reads as flowing speech rather
 * than a metronome, while long notes still linger and rests still breathe.
 *
 * When the phrase is SHORTER than the melody's capacity, the text LOOPS to
 * fill it (a mantra) — every note in the melody sounds, and repetition reads
 * as deliberate. When it is LONGER, the overflow is dropped from the end and
 * reported, never crushed into inaudible clicks.
 */

import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';

/**
 * Floor on how short a syllable slot may get, in quarter-note beats.
 * Below roughly an eighth-triplet a syllable stops being audible as a word —
 * it turns into a click. Note this is tempo-relative by nature: at 60 BPM this
 * is 125 ms, at 160 BPM it is 47 ms, so fast tempos naturally refuse to
 * subdivide as far.
 */
export const MIN_SLOT_BEATS = 0.125;

/** Nothing musical wants more than this many syllables inside one note. */
export const MAX_SLOTS_PER_NOTE = 16;

export interface DistributionResult {
  /**
   * The full slot layout — every melody note sounds. One entry per slot;
   * pitch from the parent note, timing subdivided. Syllables map onto slots
   * as `slotIndex % syllableCount` (the text loops when short).
   */
  notes: PluginMidiNote[];
  /** Slot count actually emitted (== notes.length). */
  used: number;
  /** Syllables that did not fit anywhere and were dropped from the end. */
  dropped: number;
  /** Slots per melody note, parallel to the input — useful for reporting. */
  slotsPerNote: number[];
}

/**
 * Subdivide `notes` so the melody carries `syllableCount` syllables.
 *
 * `subdivisionsPerBeat` is the target rate: 1 = quarters, 2 = eighths,
 * 4 = sixteenths. It is a starting point, not a straitjacket — the capacity is
 * then nudged toward the phrase length, keeping the per-slot rate as uniform
 * as possible while it does.
 */
export function distributeSyllables(
  notes: PluginMidiNote[],
  syllableCount: number,
  subdivisionsPerBeat: number,
): DistributionResult {
  const sorted = [...notes].sort((a, b) => a.startBeat - b.startBeat);
  if (sorted.length === 0) {
    return { notes: [], used: 0, dropped: Math.max(0, syllableCount), slotsPerNote: [] };
  }
  if (syllableCount <= 0) {
    return { notes: [], used: 0, dropped: 0, slotsPerNote: [] };
  }

  const rate = Math.max(1, subdivisionsPerBeat);

  // Natural capacity at the requested rate: a 1-beat note takes `rate`
  // syllables, a 2-beat note twice that. Never fewer than one — every note in
  // the melody gets sung — and never so many that a slot dips under the
  // audibility floor.
  const maxByFloor = (n: PluginMidiNote): number =>
    Math.max(1, Math.floor(n.durationBeats / MIN_SLOT_BEATS));
  const slots = sorted.map((n) =>
    Math.max(
      1,
      Math.min(MAX_SLOTS_PER_NOTE, maxByFloor(n), Math.round(n.durationBeats * rate)),
    ),
  );
  let total = slots.reduce((a, b) => a + b, 0);

  // Too many slots for the phrase: take one back from whichever note is
  // currently the most CRAMMED (smallest duration-per-slot), so the layout
  // converges toward one uniform rate instead of long notes collapsing to the
  // same slot count as short ones.
  while (total > syllableCount) {
    let idx = -1;
    let worst = Infinity;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] <= 1) continue;
      const perSlot = sorted[i].durationBeats / slots[i];
      if (perSlot < worst) {
        worst = perSlot;
        idx = i;
      }
    }
    if (idx < 0) break; // every note is already down to a single syllable
    slots[idx] -= 1;
    total -= 1;
  }

  // Too few: give the extra syllables to whichever note currently has the most
  // room per syllable. Stop before any slot would become too short to hear.
  while (total < syllableCount) {
    let idx = -1;
    let roomiest = -1;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] >= MAX_SLOTS_PER_NOTE) continue;
      const next = sorted[i].durationBeats / (slots[i] + 1);
      if (next < MIN_SLOT_BEATS) continue;
      const room = sorted[i].durationBeats / slots[i];
      if (room > roomiest) {
        roomiest = room;
        idx = i;
      }
    }
    if (idx < 0) break; // the melody is full; the rest of the phrase will not fit
    slots[idx] += 1;
    total += 1;
  }

  // Emit EVERY slot: each note becomes `slots[i]` equal parts at its pitch.
  // Nothing is sliced away — a phrase shorter than the layout loops onto it.
  const out: PluginMidiNote[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const note = sorted[i];
    const k = slots[i];
    const part = note.durationBeats / k;
    for (let j = 0; j < k; j++) {
      out.push({
        ...note,
        startBeat: note.startBeat + j * part,
        durationBeats: part,
      });
    }
  }

  return {
    notes: out,
    used: out.length,
    dropped: Math.max(0, syllableCount - out.length),
    slotsPerNote: slots,
  };
}

/**
 * How many syllables a melody can hold at a given rate, before any balancing.
 * Used to tell the model roughly how long a phrase to look for.
 */
export function melodyCapacity(notes: PluginMidiNote[], subdivisionsPerBeat: number): number {
  const rate = Math.max(1, subdivisionsPerBeat);
  return notes.reduce(
    (sum, n) =>
      sum +
      Math.max(
        1,
        Math.min(
          MAX_SLOTS_PER_NOTE,
          Math.max(1, Math.floor(n.durationBeats / MIN_SLOT_BEATS)),
          Math.round(n.durationBeats * rate),
        ),
      ),
    0,
  );
}

/**
 * Put a harmony voice onto the lead's syllable timeline.
 *
 * The LEAD decides when syllables happen; the harmony voices supply pitch at
 * those moments. Without this they would each subdivide their own line and
 * drift, so "unison" and "choral" — where the whole point is that everyone
 * lands on the same word at the same instant — would not hold together.
 *
 * A voice with no note near a slot contributes nothing there, which is how
 * voices enter and drop out of a texture. A voice note that no slot ONSET
 * falls inside is still caught by the greatest-overlap fallback — otherwise a
 * short counterpoint note tucked between two onsets would silently vanish.
 *
 * The trade-off is deliberate: harmony voices get independent CONTOURS and
 * independent rests, but not independent rhythm.
 */
export function alignVoiceToSlots(
  voiceNotes: PluginMidiNote[],
  slots: PluginMidiNote[],
): Array<PluginMidiNote | null> {
  const sorted = [...voiceNotes].sort((a, b) => a.startBeat - b.startBeat);
  return slots.map((slot) => {
    // The voice's note sounding at this slot's onset, if any.
    const held = sorted.find(
      (n) =>
        slot.startBeat >= n.startBeat - 1e-9 &&
        slot.startBeat < n.startBeat + n.durationBeats - 1e-9,
    );
    const chosen = held ?? bestOverlap(sorted, slot);
    if (!chosen) return null;
    return {
      ...chosen,
      startBeat: slot.startBeat,
      durationBeats: slot.durationBeats,
    };
  });
}

/** The voice note overlapping the slot's span the most, or null when none do. */
function bestOverlap(sorted: PluginMidiNote[], slot: PluginMidiNote): PluginMidiNote | null {
  const slotEnd = slot.startBeat + slot.durationBeats;
  let best: PluginMidiNote | null = null;
  let bestAmount = 0;
  for (const n of sorted) {
    const overlap =
      Math.min(slotEnd, n.startBeat + n.durationBeats) - Math.max(slot.startBeat, n.startBeat);
    if (overlap > bestAmount + 1e-9) {
      bestAmount = overlap;
      best = n;
    }
  }
  return best;
}

/**
 * Shift a slot sequence later in time by `offsetBeats`, WRAPPING at the scene
 * boundary — the scene loops, so a canon entry that runs off the end continues
 * from the top and the round survives the loop seam. A slot straddling the
 * boundary is SPLIT into two (the renderer cannot place one event across it).
 *
 * Returns one entry per input slot, in the input's order, each carrying the
 * slot's ORIGINAL index so the syllable mapping follows the shifted line.
 */
export interface ShiftedSlot {
  note: PluginMidiNote;
  /** Index of the source slot this (piece of a) slot came from. */
  sourceIndex: number;
}

export function shiftSlotsWrapped(
  slots: Array<PluginMidiNote | null>,
  offsetBeats: number,
  sceneBeats: number,
): ShiftedSlot[] {
  const out: ShiftedSlot[] = [];
  if (sceneBeats <= 0) return out;
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (!slot) continue;
    const start = (((slot.startBeat + offsetBeats) % sceneBeats) + sceneBeats) % sceneBeats;
    const end = start + slot.durationBeats;
    if (end <= sceneBeats + 1e-9) {
      out.push({ note: { ...slot, startBeat: start }, sourceIndex: i });
    } else {
      const headLen = sceneBeats - start;
      const tailLen = slot.durationBeats - headLen;
      if (headLen > 1e-6) {
        out.push({ note: { ...slot, startBeat: start, durationBeats: headLen }, sourceIndex: i });
      }
      if (tailLen > 1e-6) {
        out.push({ note: { ...slot, startBeat: 0, durationBeats: tailLen }, sourceIndex: i });
      }
    }
  }
  return out;
}
