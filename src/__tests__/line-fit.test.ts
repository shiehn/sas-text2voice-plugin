/**
 * S-443: written lines on the melody, phrase by phrase. A line shorter than
 * its phrase holds a syllable through several notes (the folded `pitches`
 * run the renderer already sings, SynthV S-434's melisma); a longer one
 * subdivides; nothing ever lands past the bar.
 */
import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';
import {
  alignVoiceToFittedSlots,
  clampSlotPitches,
  fitLinesToLead,
  fittedWordSpans,
  foldUnits,
  heuristicSyllables,
  leadPhrases,
  MAX_RUN_STEPS,
  normalizeRun,
  splitLineSyllables,
} from '../line-fit';
import { validateSyllableSplit } from '../syllables';

type Run = Array<{ midi: number; beats: number }>;
const n = (pitch: number, startBeat: number, durationBeats = 1): PluginMidiNote => ({ pitch, startBeat, durationBeats, velocity: 88 });
const runOf = (x: PluginMidiNote): Run | undefined => (x as PluginMidiNote & { pitches?: Run }).pitches;

/** Two phrases of 6 quarter notes each, a 4-beat rest between them (8 bars of 4/4 = 32 beats). */
function twelveNotes(): PluginMidiNote[] {
  const notes: PluginMidiNote[] = [];
  for (let i = 0; i < 6; i++) notes.push(n(60 + i, i * 2, 2));
  for (let i = 0; i < 6; i++) notes.push(n(67 - i, 16 + i * 2, 2));
  return notes;
}

describe('heuristicSyllables', () => {
  it.each([
    ['silver', ['sil', 'ver']],
    ['became', ['be', 'came']],
    ['window', ['win', 'dow']],
    ['night', ['night']],
    ['open', ['o', 'pen']],
  ])('%s', (word, want) => {
    expect(heuristicSyllables(word)).toEqual(want);
  });

  it('every split reassembles into its line (punctuation rides along)', () => {
    for (const line of ['Under the silver rain,', 'the harbour lights are burning', "don't wake the evening"]) {
      const syls = splitLineSyllables(line);
      expect(validateSyllableSplit(syls, line).ok).toBe(true);
    }
  });
});

describe('leadPhrases + foldUnits', () => {
  it('splits at rests', () => {
    expect(leadPhrases(twelveNotes()).map((p) => p.length)).toEqual([6, 6]);
  });

  it('folds 6 notes into 2 held syllables: one run each, the phrase-final note on the last', () => {
    const phrase = leadPhrases(twelveNotes())[0];
    const folded = foldUnits(phrase, 2);
    expect(folded).toHaveLength(2);
    expect(folded[0].startBeat).toBe(0);
    expect(folded[0].durationBeats).toBe(6);
    expect(runOf(folded[0])).toEqual([
      { midi: 60, beats: 2 },
      { midi: 61, beats: 2 },
      { midi: 62, beats: 2 },
    ]);
    expect(folded[1].startBeat + folded[1].durationBeats).toBe(12);
  });

  it('gives the extra notes to the last syllables', () => {
    const folded = foldUnits(leadPhrases(twelveNotes())[0], 4);
    expect(folded.map((s) => runOf(s)?.length ?? 1)).toEqual([1, 1, 2, 2]);
  });

  it('a run on one repeated pitch is just a long note', () => {
    const folded = foldUnits([n(60, 0), n(60, 1), n(60, 2)], 1);
    expect(runOf(folded[0])).toBeUndefined();
    expect(folded[0].durationBeats).toBe(3);
  });
});

describe('fitLinesToLead', () => {
  it('8 bars of choir: 2 lines of 2 syllables over 12 notes, line by phrase, every note sung', () => {
    const fit = fitLinesToLead(twelveNotes(), [2, 2], 2);
    expect(fit.aligned).toBe(true);
    expect(fit.slots).toHaveLength(4);
    expect(fit.syllableIndex).toEqual([0, 1, 2, 3]);
    expect(fit.dropped).toBe(0);
    expect(fit.heldNotes).toBe(8);
    // Line 2's last syllable ends where the melody ends: the rhyme lands on the final note.
    const last = fit.slots[3];
    expect(last.startBeat + last.durationBeats).toBe(28);
    // Every slot sits inside the scene.
    expect(fit.slots.every((s) => s.startBeat + s.durationBeats <= 32)).toBe(true);
  });

  it('a line longer than its phrase subdivides the notes', () => {
    const fit = fitLinesToLead([n(60, 0, 2), n(62, 2, 2)], [6], 2);
    expect(fit.slots).toHaveLength(6);
    expect(fit.dropped).toBe(0);
  });

  it('drops what does not fit and says so, never past the phrase', () => {
    const fit = fitLinesToLead([n(60, 0, 0.25)], [8], 4);
    expect(fit.slots.length).toBeLessThan(8);
    expect(fit.dropped).toBe(8 - fit.slots.length);
    expect(fit.slots.every((s) => s.startBeat + s.durationBeats <= 0.25 + 1e-9)).toBe(true);
  });

  it('lines and phrases that do not pair up share the syllables by length', () => {
    const fit = fitLinesToLead(twelveNotes(), [3], 2);
    expect(fit.aligned).toBe(false);
    expect(fit.slots).toHaveLength(3);
    expect(fit.dropped).toBe(0);
  });
});

describe('harmony and breath', () => {
  it('a harmony voice moves under a held syllable', () => {
    const lead = leadPhrases(twelveNotes())[0];
    const slots = foldUnits(lead, 2);
    const harmony = lead.map((x) => ({ ...x, pitch: x.pitch - 4 }));
    const aligned = alignVoiceToFittedSlots(harmony, slots);
    expect(runOf(aligned[0] as PluginMidiNote)?.map((p) => p.midi)).toEqual([56, 57, 58]);
  });

  it('a slot the breath guard shortened has its run cut to fit', () => {
    const slot = { ...n(60, 0, 3), pitches: [{ midi: 60, beats: 2 }, { midi: 62, beats: 2 }] } as PluginMidiNote;
    const [cut] = clampSlotPitches([slot]);
    expect(runOf(cut as PluginMidiNote)).toEqual([
      { midi: 60, beats: 2 },
      { midi: 62, beats: 1 },
    ]);
  });
});

it('word spans follow the lines', () => {
  const spans = fittedWordSpans(['cold light', 'silver'], [['cold', 'light'], ['sil', 'ver']], [0, 1, 2, 3], 0);
  expect(spans.map((s) => [s.word, s.startSyl, s.endSyl])).toEqual([
    ['cold', 0, 1],
    ['light', 1, 2],
    ['silver', 2, 4],
  ]);
});

describe('runs the renderer accepts', () => {
  it('a syllable held through 40 changing notes is at most 32 steps', () => {
    const notes = Array.from({ length: 40 }, (_, i) => n(48 + i, i * 0.5, 0.5));
    const [held] = foldUnits(notes, 1);
    const run = runOf(held) ?? [];
    expect(run.length).toBeGreaterThan(1);
    expect(run.length).toBeLessThanOrEqual(MAX_RUN_STEPS);
    expect(run[0].midi).toBe(48);
    expect(held.durationBeats).toBe(20);
  });

  it('merges repeats and slivers', () => {
    expect(normalizeRun([{ midi: 60, beats: 1 }, { midi: 60, beats: 1 }, { midi: 62, beats: 0.01 }, { midi: 64, beats: 1 }])).toEqual([
      { midi: 60, beats: 2.01 },
      { midi: 64, beats: 1 },
    ]);
  });
});
