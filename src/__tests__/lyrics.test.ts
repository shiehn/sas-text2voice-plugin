import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';
import { materializeLines, phraseBudgets } from '../lyrics';
import { detectPhrases } from '../phrases';

const slot = (startBeat: number, dur = 0.5): PluginMidiNote => ({
  pitch: 62,
  startBeat,
  durationBeats: dur,
  velocity: 90,
});

/** Four rest-separated phrases of 3 slots each (scene = 16 beats). */
function fourPhrases(): ReturnType<typeof detectPhrases> {
  const slots: PluginMidiNote[] = [];
  for (let p = 0; p < 4; p++) {
    for (let i = 0; i < 3; i++) slots.push(slot(p * 4 + i * 0.5));
  }
  return detectPhrases(slots, 16);
}

describe('phraseBudgets', () => {
  it('assigns AABB letters over four rest phrases', () => {
    const { budgets, effectiveScheme } = phraseBudgets(fourPhrases(), 'AABB');
    expect(effectiveScheme).toBe('AABB');
    expect(budgets.map((b) => b.rhyme)).toEqual(['A', 'A', 'B', 'B']);
    expect(budgets.map((b) => b.syllables)).toEqual([3, 3, 3, 3]);
  });

  it('assigns ABAB letters over four rest phrases', () => {
    const { budgets } = phraseBudgets(fourPhrases(), 'ABAB');
    expect(budgets.map((b) => b.rhyme)).toEqual(['A', 'B', 'A', 'B']);
  });

  it('degrades to pairs below four phrases, and reports it', () => {
    const slots = [slot(0), slot(0.5), slot(4), slot(4.5)];
    const phrases = detectPhrases(slots, 8);
    const { budgets, effectiveScheme } = phraseBudgets(phrases, 'AABB');
    expect(effectiveScheme).toBe('pairs');
    expect(budgets.map((b) => b.rhyme)).toEqual(['A', 'A']);
  });

  it('degrades to none for a single phrase', () => {
    const phrases = detectPhrases([slot(0), slot(0.5)], 4);
    expect(phraseBudgets(phrases, 'ABAB').effectiveScheme).toBe('none');
  });

  it('never letters a carved breath boundary', () => {
    // The guard SHORTENS slot 1 (0.5 → 0.3), opening a real gap it then tags.
    const slots = [slot(0), slot(0.5, 0.3), slot(1), slot(4), slot(4.5), slot(5), slot(8), slot(8.5), slot(9), slot(12), slot(12.5), slot(13)];
    const phrases = detectPhrases(slots, 16, new Set([1]));
    const { budgets } = phraseBudgets(phrases, 'AABB');
    const breathIdx = phrases.findIndex((p) => p.boundary === 'breath');
    expect(breathIdx).toBeGreaterThanOrEqual(0);
    expect(budgets[breathIdx].rhyme).toBeNull();
    // The rest phrases still take letters around it.
    const lettered = budgets.filter((b) => b.rhyme !== null);
    expect(lettered.length).toBeGreaterThanOrEqual(4);
  });
});

describe('materializeLines', () => {
  const phrases = fourPhrases();

  it('is 1:1 with the slots when the lines fit exactly', () => {
    const lines = [
      ['cir', 'cuits', 'hum'],
      ['sys', 'tems', 'love'],
      ['me', 'tal', 'heart'],
      ['nev', 'er', 'part'],
    ];
    const texts = ['circuits hum', 'systems love', 'metal heart', 'never part'];
    const out = materializeLines(lines, texts, phrases);
    expect(out.syllables).toHaveLength(12);
    expect(out.phrase).toBe('circuits hum / systems love / metal heart / never part');
    // Exact word spans survive.
    expect(out.wordSpans.find((w) => w.word === 'circuits')).toMatchObject({ startSyl: 0, endSyl: 2 });
    expect(out.wordSpans.find((w) => w.word === 'part')).toMatchObject({ startSyl: 11, endSyl: 12 });
  });

  it('pins each line\'s LAST syllable to the phrase-final slot, whatever the miscount', () => {
    const lines = [
      ['hum'],                          // 1 for 3 → looped, tail pinned
      ['sys', 'tems', 'of', 'love'],    // 4 for 3 → trimmed from the front
      ['me', 'tal', 'heart'],
      ['part'],
    ];
    const out = materializeLines(lines, ['hum', 'systems of love', 'metal heart', 'part'], phrases);
    expect(out.syllables).toHaveLength(12);
    // Phrase-final positions carry the rhyme syllables.
    expect(out.syllables[2]).toBe('hum');
    expect(out.syllables[5]).toBe('love');
    expect(out.syllables[8]).toBe('heart');
    expect(out.syllables[11]).toBe('part');
  });

  it('is deterministic — the render-time rebuild matches the cached one', () => {
    const lines = [['a'], ['b', 'c'], ['d', 'e', 'f'], ['g']];
    const texts = ['a', 'b c', 'd e f', 'g'];
    const first = materializeLines(lines, texts, phrases);
    const second = materializeLines(lines, texts, phrases);
    expect(second).toEqual(first);
  });
});
