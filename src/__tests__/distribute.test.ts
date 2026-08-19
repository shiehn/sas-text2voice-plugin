import {
  alignVoiceToSlots,
  distributeSyllables,
  melodyCapacity,
  shiftSlotsWrapped,
  MAX_SLOTS_PER_NOTE,
  MIN_SLOT_BEATS,
} from '../distribute';
import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';

const note = (pitch: number, startBeat: number, durationBeats: number): PluginMidiNote => ({
  pitch,
  startBeat,
  durationBeats,
  velocity: 90,
});

describe('distributeSyllables', () => {
  it('sets a quarter + rest + half as 2 eighths, rest, 4 eighths', () => {
    // The canonical case: a two-note melody with a rest between them should
    // sing at ONE steady eighth-note rate, not one syllable per note.
    const melody = [note(60, 0, 1), note(64, 2, 2)]; // quarter, (rest at beat 1), half
    const out = distributeSyllables(melody, 6, 2);

    expect(out.slotsPerNote).toEqual([2, 4]);
    expect(out.used).toBe(6);
    expect(out.dropped).toBe(0);

    // Every slot is an eighth — a single uniform rate across the phrase.
    expect(out.notes.map((n) => n.durationBeats)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    // ...and the rest between beats 1 and 2 is preserved as a genuine gap.
    expect(out.notes.map((n) => n.startBeat)).toEqual([0, 0.5, 2, 2.5, 3, 3.5]);
    // Each subdivision keeps its parent note's pitch.
    expect(out.notes.map((n) => n.pitch)).toEqual([60, 60, 64, 64, 64, 64]);
  });

  it('leaves the melody untouched when the phrase already matches note for note', () => {
    const melody = [note(60, 0, 1), note(62, 1, 1), note(64, 2, 1)];
    const out = distributeSyllables(melody, 3, 1);
    expect(out.slotsPerNote).toEqual([1, 1, 1]);
    expect(out.notes).toHaveLength(3);
    expect(out.notes.map((n) => n.durationBeats)).toEqual([1, 1, 1]);
  });

  it('never silences a note in the melody, however short the phrase', () => {
    // Four notes, two syllables: every note still EMITS a slot — the text
    // loops onto them (slot % syllableCount), so nothing falls silent. This
    // used to assert only slotsPerNote while the emitted notes were truncated:
    // false confidence at the exact bug site.
    const melody = [note(60, 0, 1), note(62, 1, 1), note(64, 2, 1), note(65, 3, 1)];
    const out = distributeSyllables(melody, 2, 2);
    expect(out.slotsPerNote.every((s) => s >= 1)).toBe(true);
    expect(out.notes.length).toBeGreaterThanOrEqual(4);
    expect(out.used).toBe(out.notes.length);
    expect(out.dropped).toBe(0);
    // Every melody pitch still sounds.
    const pitches = new Set(out.notes.map((n) => n.pitch));
    expect(pitches).toEqual(new Set([60, 62, 64, 65]));
  });

  it('takes slots back from the most CRAMMED note, converging on one rate', () => {
    // Melody [4, 1] beats asked to hold 4 syllables. Reducing from the note
    // with the most SLOTS gave [2,2] → slot durations [2,2,0.5,0.5], a 4:1
    // rate disparity. Reducing from the most crammed (smallest duration per
    // slot) gives [3,1] → [1.33,1.33,1.33,1] — one audible rate.
    const melody = [note(60, 0, 4), note(64, 4, 1)];
    const out = distributeSyllables(melody, 4, 2);
    expect(out.slotsPerNote).toEqual([3, 1]);
    const durations = out.notes.map((n) => n.durationBeats);
    expect(Math.max(...durations) / Math.min(...durations)).toBeLessThan(1.5);
  });

  it('still prefers giving back from the long note when rates are equal', () => {
    const melody = [note(60, 0, 2), note(64, 2, 1)];
    const out = distributeSyllables(melody, 5, 2); // natural capacity 4 + 2 = 6
    expect(out.slotsPerNote).toEqual([3, 2]);
    expect(out.used).toBe(5);
  });

  it('gives extra syllables to whichever note has the most room', () => {
    const melody = [note(60, 0, 2), note(64, 2, 0.5)];
    // Natural capacity at quarters: 2 + 1 = 3. Asking for 5 subdivides the
    // long note further rather than cramming the short one.
    const out = distributeSyllables(melody, 5, 1);
    expect(out.used).toBe(5);
    expect(out.slotsPerNote[0]).toBeGreaterThan(out.slotsPerNote[1]);
  });

  it('refuses to subdivide past the audibility floor and reports the overflow', () => {
    // One short note cannot absorb a long phrase — the surplus is dropped and
    // counted rather than crushed into inaudible clicks.
    const melody = [note(60, 0, 0.5)];
    const out = distributeSyllables(melody, 40, 4);
    expect(out.dropped).toBeGreaterThan(0);
    expect(out.used).toBe(out.notes.length);
    out.notes.forEach((n) => expect(n.durationBeats).toBeGreaterThanOrEqual(MIN_SLOT_BEATS));
  });

  it('floors the INITIAL split too, not just the top-up loop', () => {
    // A 0.2-beat note at rate 16-equivalent used to get round(0.2*4)=1 slot but
    // compose.ts can emit 0.05-beat notes; the initial split must respect the
    // same audibility floor the increase loop enforces.
    const melody = [note(60, 0, 0.3)];
    const out = distributeSyllables(melody, 8, 4);
    out.notes.forEach((n) => expect(n.durationBeats).toBeGreaterThanOrEqual(MIN_SLOT_BEATS));
  });

  it('caps how many syllables a single note may swallow', () => {
    const melody = [note(60, 0, 64)];
    const out = distributeSyllables(melody, 500, 4);
    expect(out.slotsPerNote[0]).toBeLessThanOrEqual(MAX_SLOTS_PER_NOTE);
  });

  it('subdivides a note into exactly equal parts that fill it', () => {
    const melody = [note(60, 4, 3)];
    const out = distributeSyllables(melody, 3, 1);
    expect(out.notes.map((n) => n.durationBeats)).toEqual([1, 1, 1]);
    const last = out.notes[out.notes.length - 1];
    // The subdivisions exactly span the parent note — no gap, no overhang.
    expect(last.startBeat + last.durationBeats).toBeCloseTo(7);
    expect(out.notes[0].startBeat).toBe(4);
  });

  it('keeps every slot inside the melody it came from', () => {
    const melody = [note(60, 0, 1), note(64, 4, 2)];
    const out = distributeSyllables(melody, 9, 4);
    for (const n of out.notes) {
      const parent = melody.find(
        (m) => n.startBeat >= m.startBeat && n.startBeat < m.startBeat + m.durationBeats,
      );
      expect(parent).toBeDefined();
      expect(n.startBeat + n.durationBeats).toBeLessThanOrEqual(
        parent!.startBeat + parent!.durationBeats + 1e-9,
      );
    }
  });

  it('emits used === notes.length and only reports drops on real overflow', () => {
    const melody = [note(60, 0, 1), note(62, 1, 0.5), note(64, 2, 3)];
    for (const count of [1, 2, 5, 8, 13, 50]) {
      for (const rate of [1, 2, 4]) {
        const out = distributeSyllables(melody, count, rate);
        expect(out.notes).toHaveLength(out.used);
        // dropped counts only syllables beyond the layout's capacity.
        expect(out.dropped).toBe(Math.max(0, count - out.used));
      }
    }
  });

  it('sorts an out-of-order melody before subdividing', () => {
    const out = distributeSyllables([note(64, 2, 1), note(60, 0, 1)], 2, 1);
    expect(out.notes.map((n) => n.pitch)).toEqual([60, 64]);
  });

  it('handles the degenerate inputs without throwing', () => {
    expect(distributeSyllables([], 5, 2).notes).toEqual([]);
    expect(distributeSyllables([], 5, 2).dropped).toBe(5);
    expect(distributeSyllables([note(60, 0, 1)], 0, 2).notes).toEqual([]);
  });
});

describe('melodyCapacity', () => {
  it('reports how much text a melody can hold at a given rate', () => {
    const melody = [note(60, 0, 1), note(64, 2, 2)];
    expect(melodyCapacity(melody, 1)).toBe(3); // quarters:  1 + 2
    expect(melodyCapacity(melody, 2)).toBe(6); // eighths:   2 + 4
    expect(melodyCapacity(melody, 4)).toBe(12); // sixteenths: 4 + 8
  });

  it('counts every note at least once', () => {
    expect(melodyCapacity([note(60, 0, 0.25)], 1)).toBe(1);
  });
});

describe('shiftSlotsWrapped', () => {
  it('delays a line and wraps it at the scene boundary', () => {
    const slots = [note(60, 0, 1), note(64, 7, 1)];
    const out = shiftSlotsWrapped(slots, 2, 8);
    expect(out[0].note.startBeat).toBe(2);
    // 7 + 2 = 9 → wraps to 1.
    expect(out[1].note.startBeat).toBe(1);
    expect(out.map((o) => o.sourceIndex)).toEqual([0, 1]);
  });

  it('SPLITS a note straddling the boundary instead of overhanging it', () => {
    const slots = [note(60, 7, 2)];
    const out = shiftSlotsWrapped(slots, 0, 8);
    expect(out).toHaveLength(2);
    expect(out[0].note.startBeat).toBe(7);
    expect(out[0].note.durationBeats).toBeCloseTo(1);
    expect(out[1].note.startBeat).toBe(0);
    expect(out[1].note.durationBeats).toBeCloseTo(1);
    // Both pieces carry the source slot's index, so they sing the same syllable.
    expect(out[0].sourceIndex).toBe(0);
    expect(out[1].sourceIndex).toBe(0);
  });

  it('skips resting entries and preserves order', () => {
    const out = shiftSlotsWrapped([null, note(60, 0, 1)], 1, 8);
    expect(out).toHaveLength(1);
    expect(out[0].sourceIndex).toBe(1);
  });
});

describe('alignVoiceToSlots', () => {
  const slots = [note(0, 0, 0.5), note(0, 0.5, 0.5), note(0, 1, 0.5), note(0, 1.5, 0.5)];

  it('gives the harmony voice the lead’s timing and its own pitch', () => {
    // One sustained harmony note under four lead syllables.
    const harmony = [note(55, 0, 2)];
    const out = alignVoiceToSlots(harmony, slots);
    expect(out.map((n) => n?.pitch)).toEqual([55, 55, 55, 55]);
    expect(out.map((n) => n?.startBeat)).toEqual([0, 0.5, 1, 1.5]);
    expect(out.map((n) => n?.durationBeats)).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it('follows the harmony voice’s own contour across the slots', () => {
    const harmony = [note(55, 0, 1), note(57, 1, 1)];
    expect(alignVoiceToSlots(harmony, slots).map((n) => n?.pitch)).toEqual([55, 55, 57, 57]);
  });

  it('contributes nothing where the voice is resting', () => {
    // Silent for the first beat, then enters — that is a voice joining in.
    const harmony = [note(55, 1, 1)];
    const out = alignVoiceToSlots(harmony, slots);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]?.pitch).toBe(55);
    expect(out[3]?.pitch).toBe(55);
  });

  it('returns one entry per slot so delivery can index them safely', () => {
    expect(alignVoiceToSlots([], slots)).toHaveLength(slots.length);
    expect(alignVoiceToSlots([], slots).every((n) => n === null)).toBe(true);
  });

  it('catches a short note tucked BETWEEN slot onsets by greatest overlap', () => {
    // A 0.3-beat counterpoint note inside one lead slot has no slot onset
    // falling inside it — it used to vanish. The overlap fallback keeps it.
    const shortNote = [note(59, 0.1, 0.3)];
    const out = alignVoiceToSlots(shortNote, slots);
    expect(out[0]?.pitch).toBe(59);
  });
});
