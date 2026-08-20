/**
 * The expression layer — how a style's pack becomes per-syllable v3 fields.
 *
 * What matters here is PLACEMENT, not amounts: scoops belong to phrase
 * entries, glides to adjacent notes, vibrato to sustains, falls and breath to
 * phrase finals — and realism 0 must strip every one of them, because that is
 * the contract that keeps the original machine voice reachable.
 */

import type { VoiceSyllableAssignment } from '../harmony-styles';
import { foldMelismaRuns, type MelodyNote } from '../compose';
import { distributeSyllables, melodyCapacity } from '../distribute';
import { buildVocalLineRequest, type ExpressionOptions } from '../render-spec';
import { DEFAULT_EXPRESSION, STYLES, type ExpressionPack } from '../styles';

const BPM = 120; // 1 beat = 0.5s

const note = (startBeat: number, durationBeats: number, pitch = 60): VoiceSyllableAssignment => ({
  syllableIndex: null,
  note: { pitch, startBeat, durationBeats, velocity: 90 },
  treatment: undefined,
});

/** Two phrases: [0..2) sung tight, gap, [4..6) — lead-like assignment line. */
function phraseAssignments(): VoiceSyllableAssignment[] {
  return [
    { ...note(0, 1, 60), syllableIndex: 0 },
    { ...note(1, 1, 64), syllableIndex: 1 }, // adjacent -> legato from 60
    { ...note(4, 1.5, 62), syllableIndex: 2 }, // after a gap -> new phrase
    { ...note(5.5, 0.5, 60), syllableIndex: 3 }, // phrase final
  ];
}

const PACK: ExpressionPack = {
  retuneMs: 80,
  scoopCents: 100,
  vibrato: { rateHz: 5, depthCents: 50, onsetMs: 300, ampDepth: 0.2 },
  driftCents: 10,
  humanizePitchCents: 12,
  humanizeTimingMs: 10,
  breathTail: 0.3,
  singersFormant: 0.4,
  tilt: 0.1,
  align: 'nucleus',
  timeMode: 'vowel',
};

function build(opts?: Partial<ExpressionOptions>): ReturnType<typeof buildVocalLineRequest> {
  return buildVocalLineRequest(
    phraseAssignments(),
    ['la', 'da', 'so', 'ma'],
    'natural',
    0,
    1,
    BPM,
    8,
    undefined,
    undefined,
    { expression: PACK, realism: 1, laneSeed: 5, ...opts },
  );
}

describe('expression placement', () => {
  it('phrase entries scoop; adjacent notes glide instead', () => {
    const req = build();
    const [first, second, third] = req.syllables;
    expect(first.scoopCents).toBe(100);
    expect(first.legatoFromMidi).toBeUndefined();
    // Adjacent + different pitch: legato from the previous note, no scoop.
    expect(second.legatoFromMidi).toBe(60);
    expect(second.scoopCents).toBeUndefined();
    // New phrase after the gap scoops again.
    expect(third.scoopCents).toBe(100);
  });

  it('vibrato lands only on notes long enough to bloom', () => {
    const req = build();
    // 1-beat = 500ms > onset 300 + 150 -> vibrato; 0.5-beat = 250ms -> none.
    expect(req.syllables[0].vibrato?.depthCents).toBe(50);
    expect(req.syllables[3].vibrato).toBeUndefined();
  });

  it('phrase finals fall and aspirate; sustained entries swell', () => {
    const req = build();
    expect(req.syllables[1].envelope).toBe('fall'); // end of phrase 1
    expect(req.syllables[3].envelope).toBe('fall'); // end of phrase 2
    expect(req.syllables[3].breathiness?.[1]).toBeCloseTo(0.3);
    expect(req.syllables[2].envelope).toBe('swell'); // long phrase entry
  });

  it('the lane carries a humanize seed; timing/pitch scale with realism', () => {
    const full = build();
    expect(full.humanize).toEqual({ seed: 5, pitchCents: 12, timingMs: 10, vibratoJitter: 1 });
    const half = build({ realism: 0.5 });
    expect(half.humanize?.pitchCents).toBe(6);
  });

  it('realism 0 strips EVERY expression field — the machine voice survives', () => {
    const req = build({ realism: 0 });
    for (const syl of req.syllables) {
      for (const key of [
        'retuneMs', 'scoopCents', 'legatoFromMidi', 'driftCents', 'vibrato',
        'singersFormant', 'tilt',
        'envelope', 'breathiness', 'align', 'word', 'wordId',
      ]) {
        expect((syl as unknown as Record<string, unknown>)[key]).toBeUndefined();
      }
    }
    expect(req.humanize).toBeUndefined();
  });

  it('word spans become word/wordId so words are spoken whole', () => {
    const req = build({
      wordSpans: [
        { word: 'lada', startSyl: 0, endSyl: 2 },
        { word: 'soma', startSyl: 2, endSyl: 4 },
      ],
    });
    expect(req.syllables[0].word).toBe('lada');
    expect(req.syllables[0].wordId).toBe(0);
    expect(req.syllables[1].wordId).toBe(0);
    expect(req.syllables[2].wordId).toBe(1);
  });

  it('stress leans in, unstress backs off, scaled by the dial', () => {
    const req = build({ stress: [1, 0, 1, 0] });
    expect(req.syllables[0].gain).toBeCloseTo(1.15);
    expect(req.syllables[1].gain).toBeCloseTo(0.94);
    const half = build({ stress: [1, 0, 1, 0], realism: 0.5 });
    expect(half.syllables[0].gain).toBeCloseTo(1.075);
  });

  it('every style ships a pack and the default exists', () => {
    for (const style of Object.values(STYLES)) {
      expect(style.expression.retuneMs).toBeGreaterThanOrEqual(0);
    }
    expect(DEFAULT_EXPRESSION.align).toBe('nucleus');
  });
});

describe('melisma folding', () => {
  const m = (startBeat: number, durationBeats: number, pitch: number, melisma?: boolean): MelodyNote => ({
    pitch,
    startBeat,
    durationBeats,
    velocity: 90,
    ...(melisma ? { melisma: true } : {}),
  });

  it('folds contiguous marked notes into a pitch run on the head', () => {
    const folded = foldMelismaRuns([m(0, 1, 60), m(1, 0.5, 62, true), m(1.5, 0.5, 64, true), m(3, 1, 60)]);
    expect(folded).toHaveLength(2);
    const head = folded[0] as MelodyNote;
    expect(head.durationBeats).toBe(2);
    expect(head.pitches).toEqual([
      { midi: 60, beats: 1 },
      { midi: 62, beats: 0.5 },
      { midi: 64, beats: 0.5 },
    ]);
  });

  it('a mark after a rest is ignored rather than guessed at', () => {
    const folded = foldMelismaRuns([m(0, 1, 60), m(2, 1, 64, true)]);
    expect(folded).toHaveLength(2);
    expect((folded[1] as MelodyNote).pitches).toBeUndefined();
  });

  it('a folded run is ONE indivisible slot under syllable pressure', () => {
    const folded = foldMelismaRuns([m(0, 1, 60), m(1, 1, 62, true), m(2, 1, 64)]);
    // 8 syllables want slots; the 2-beat run must still take exactly one.
    const spread = distributeSyllables(folded, 8, 2);
    expect(spread.slotsPerNote[0]).toBe(1);
    expect(melodyCapacity(folded, 2)).toBe(1 + 2);
    // And the run's pitches survive onto its single slot.
    const runSlot = spread.notes.find(
      (n) => (n as MelodyNote).pitches !== undefined,
    ) as MelodyNote;
    expect(runSlot.pitches).toHaveLength(2);
    expect(runSlot.durationBeats).toBe(2);
  });

  it('melisma pitches reach the render spec in seconds', () => {
    const folded = foldMelismaRuns([m(0, 1, 60), m(1, 1, 67, true)]);
    const req = buildVocalLineRequest(
      [{ syllableIndex: 0, note: folded[0], treatment: undefined }],
      ['ah'],
      'natural',
      0,
      1,
      BPM,
      4,
    );
    expect(req.syllables[0].pitches).toEqual([
      { midi: 60, durSec: 0.5 },
      { midi: 67, durSec: 0.5 },
    ]);
  });
});
