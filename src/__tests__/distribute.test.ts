import {
  alignVoiceToSlots,
  distributeSyllables,
  melodyCapacity,
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
    // Four notes, two syllables: every note still sounds — the melody is the
    // music, not a container that empties out.
    const melody = [note(60, 0, 1), note(62, 1, 1), note(64, 2, 1), note(65, 3, 1)];
    const out = distributeSyllables(melody, 2, 2);
    expect(out.slotsPerNote.every((s) => s >= 1)).toBe(true);
    expect(out.slotsPerNote).toHaveLength(4);
  });

  it('takes slots back from the roomiest notes first, so long notes stay long', () => {
    // A half and a quarter with one syllable too few: the half gives one up,
    // rather than both collapsing to the same length.
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

  it('always returns exactly `used` notes, so words and notes cannot desync', () => {
    const melody = [note(60, 0, 1), note(62, 1, 0.5), note(64, 2, 3)];
    for (const count of [1, 2, 5, 8, 13, 50]) {
      for (const rate of [1, 2, 4]) {
        const out = distributeSyllables(melody, count, rate);
        expect(out.notes).toHaveLength(out.used);
        expect(out.used + out.dropped).toBe(count);
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
});
