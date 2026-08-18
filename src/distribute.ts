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
 * This replaces the old one-syllable-per-note model, which had two problems: a
 * sparse melody could only ever carry a handful of words, and a rest silently
 * ATE a syllable rather than pausing before it.
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
  /** One note per syllable, in order: pitch from the melody, timing subdivided. */
  notes: PluginMidiNote[];
  /** How many syllables were placed. */
  used: number;
  /** Syllables that did not fit and were dropped from the end. */
  dropped: number;
  /** Slots per melody note, parallel to the input — useful for reporting. */
  slotsPerNote: number[];
}

/**
 * Subdivide `notes` so the melody carries `syllableCount` syllables.
 *
 * `subdivisionsPerBeat` is the target rate: 1 = quarters, 2 = eighths,
 * 4 = sixteenths. It is a starting point, not a straitjacket — the capacity is
 * then nudged up or down until it matches the phrase, so the setting always
 * lands on exactly the words it has.
 */
export function distributeSyllables(
  notes: PluginMidiNote[],
  syllableCount: number,
  subdivisionsPerBeat: number,
): DistributionResult {
  const sorted = [...notes].sort((a, b) => a.startBeat - b.startBeat);
  if (sorted.length === 0 || syllableCount <= 0) {
    return { notes: [], used: 0, dropped: Math.max(0, syllableCount), slotsPerNote: [] };
  }

  const rate = Math.max(1, subdivisionsPerBeat);

  // Natural capacity at the requested rate: a 1-beat note takes `rate`
  // syllables, a 2-beat note twice that. Never fewer than one — every note
  // in the melody gets sung.
  const slots = sorted.map((n) =>
    Math.max(1, Math.min(MAX_SLOTS_PER_NOTE, Math.round(n.durationBeats * rate))),
  );
  let total = slots.reduce((a, b) => a + b, 0);

  // Too many slots for the phrase: take them back from the roomiest notes
  // first, so long notes stay longer than short ones instead of everything
  // flattening to the same length.
  while (total > syllableCount) {
    let idx = -1;
    let most = 1;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] > most) {
        most = slots[i];
        idx = i;
      }
    }
    if (idx < 0) break; // every note is already down to a single syllable
    slots[idx] -= 1;
    total -= 1;
  }

  // Too few: give the extra syllables to whichever note currently has the most
  // room per syllable, so the line subdivides evenly rather than cramming one
  // note. Stop before any slot would become too short to hear as a word.
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

  // Emit: each note becomes `slots[i]` equal parts at the same pitch.
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

  const used = Math.min(out.length, syllableCount);
  return {
    notes: out.slice(0, used),
    used,
    dropped: Math.max(0, syllableCount - used),
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
    (sum, n) => sum + Math.max(1, Math.min(MAX_SLOTS_PER_NOTE, Math.round(n.durationBeats * rate))),
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
 * A voice that is resting when a slot falls simply contributes nothing there,
 * which is how voices enter and drop out of a texture.
 *
 * The trade-off is deliberate: harmony voices get independent CONTOURS and
 * independent rests, but not independent rhythm. For counterpoint that means
 * the lines diverge in shape rather than in syllable timing.
 */
export function alignVoiceToSlots(
  voiceNotes: PluginMidiNote[],
  slots: PluginMidiNote[],
): Array<PluginMidiNote | null> {
  const sorted = [...voiceNotes].sort((a, b) => a.startBeat - b.startBeat);
  return slots.map((slot) => {
    // The voice's note sounding at this slot's onset, if any.
    const held = sorted.find(
      (n) => slot.startBeat >= n.startBeat - 1e-9 && slot.startBeat < n.startBeat + n.durationBeats - 1e-9,
    );
    if (!held) return null;
    return {
      ...held,
      startBeat: slot.startBeat,
      durationBeats: slot.durationBeats,
    };
  });
}
