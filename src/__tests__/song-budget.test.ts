/**
 * S-443: the syllable budget is a COUNT from the bars and the style (SynthV
 * S-432 + S-442's bar-counted band): about 4 per 8 bars (3-6) for the slow
 * sung styles, denser grids for the flow styles by a multiplier, scaled by the
 * section's bars, with no tempo or feel anywhere in it.
 */
import {
  budgetPromptLine,
  budgetSpecFor,
  melodyLineTargets,
  rhymeLetters,
  sectionBudget,
  trimToBudget,
  wordsFirstLines,
} from '../song-budget';
import { STYLE_IDS, styleAxes, type StyleId } from '../styles';

const axesOf = (id: StyleId) => ({ ...styleAxes(id), style: id });

describe('sectionBudget per style x bars', () => {
  const table: Record<StyleId, Record<number, [number, number, number]>> = {
    choir: { 4: [2, 2, 3], 8: [3, 4, 6], 16: [6, 8, 12] },
    chant: { 4: [2, 2, 3], 8: [3, 4, 6], 16: [6, 8, 12] },
    ballad: { 4: [3, 4, 6], 8: [6, 8, 12], 16: [12, 16, 24] },
    sprechgesang: { 4: [8, 10, 15], 8: [15, 20, 30], 16: [30, 40, 60] },
    tagteam: { 4: [15, 20, 30], 8: [30, 40, 60], 16: [60, 80, 120] },
    trap: { 4: [18, 24, 36], 8: [36, 48, 72], 16: [72, 96, 144] },
  };
  for (const id of STYLE_IDS) {
    for (const bars of [4, 8, 16]) {
      it(`${id}, ${bars} bars`, () => {
        const spec = budgetSpecFor(axesOf(id));
        expect(spec.styleId).toBe(id);
        const b = sectionBudget(spec, bars);
        expect([b.min, b.centre, b.max]).toEqual(table[id][bars]);
      });
    }
  }

  it('the slow sung styles sing about 4 syllables (3-6) per 8 bars', () => {
    for (const id of ['choir', 'chant'] as const) {
      expect(sectionBudget(budgetSpecFor(axesOf(id)), 8)).toEqual({ min: 3, centre: 4, max: 6 });
    }
  });

  it('the flow styles keep denser grids than the sung ones', () => {
    const choir = sectionBudget(budgetSpecFor(axesOf('choir')), 8).centre;
    for (const id of ['sprechgesang', 'tagteam', 'trap'] as const) {
      expect(sectionBudget(budgetSpecFor(axesOf(id)), 8).centre).toBeGreaterThan(choir * 4);
    }
  });

  it('scales with the section length', () => {
    const spec = budgetSpecFor(axesOf('choir'));
    expect(sectionBudget(spec, 16).centre).toBe(2 * sectionBudget(spec, 8).centre);
    expect(sectionBudget(spec, 32).centre).toBe(4 * sectionBudget(spec, 8).centre);
  });

  it('has no tempo or feel input at all (the same count at 70 and 140 BPM)', () => {
    // The functions take the style and the bars only.
    expect(sectionBudget.length).toBe(2);
    expect(wordsFirstLines.length).toBe(2);
  });

  it('a style edited into Custom is budgeted by its pace; the default setup is the choir', () => {
    expect(budgetSpecFor({ ...styleAxes('trap'), style: 'trap', notesPerBeat: 1 }).styleId).toBeNull();
    expect(budgetSpecFor({ ...styleAxes('trap'), style: 'trap', notesPerBeat: 1 }).multiplier).toBe(1);
    expect(budgetSpecFor({ harmony: 'counterpoint', delivery: 'hocket', character: 'menagerie', notesPerBeat: 4 }).multiplier).toBe(8);
    expect(budgetSpecFor({ harmony: 'choral', delivery: 'unison', character: 'choir', notesPerBeat: 2 }).styleId).toBe('choir');
  });
});

describe('wordsFirstLines', () => {
  it('8 bars of choir: two lines of two', () => {
    expect(wordsFirstLines(budgetSpecFor(axesOf('choir')), 8)).toEqual([2, 2]);
  });
  it('16 bars of choir: four lines of two', () => {
    expect(wordsFirstLines(budgetSpecFor(axesOf('choir')), 16)).toEqual([2, 2, 2, 2]);
  });
  it('8 bars of rap: a line a bar', () => {
    expect(wordsFirstLines(budgetSpecFor(axesOf('tagteam')), 8)).toEqual([5, 5, 5, 5, 5, 5, 5, 5]);
    expect(wordsFirstLines(budgetSpecFor(axesOf('trap')), 8)).toEqual([6, 6, 6, 6, 6, 6, 6, 6]);
  });
  it('the lines add up to the centre and never outnumber the syllables', () => {
    for (const id of STYLE_IDS) {
      for (const bars of [1, 2, 3, 6, 8, 12]) {
        const spec = budgetSpecFor(axesOf(id));
        const lines = wordsFirstLines(spec, bars);
        expect(lines.reduce((a, b) => a + b, 0)).toBe(sectionBudget(spec, bars).centre);
        expect(lines.every((n) => n >= 1)).toBe(true);
      }
    }
  });
});

describe('melodyLineTargets', () => {
  it('one line per phrase, at least one each, the rest to the longest phrases', () => {
    const r = melodyLineTargets([8, 4], [20, 20], { min: 3, centre: 4, max: 6 });
    expect(r.targets).toEqual([3, 1]);
    expect(r.over).toBe(false);
  });
  it('never asks a phrase for more than it holds', () => {
    expect(melodyLineTargets([8, 8], [1, 2], { min: 3, centre: 4, max: 6 }).targets).toEqual([1, 2]);
  });
  it('more phrases than the maximum: one syllable each, flagged', () => {
    const r = melodyLineTargets([1, 1, 1, 1, 1, 1, 1, 1], new Array(8).fill(4), { min: 3, centre: 4, max: 6 });
    expect(r.targets).toEqual(new Array(8).fill(1));
    expect(r.over).toBe(true);
  });
});

describe('rhymeLetters', () => {
  it('AABB and ABAB over four lines, pairs below, none for one line', () => {
    expect(rhymeLetters(4, 'AABB').letters).toEqual(['A', 'A', 'B', 'B']);
    expect(rhymeLetters(4, 'ABAB').letters).toEqual(['A', 'B', 'A', 'B']);
    expect(rhymeLetters(2, 'ABAB')).toEqual({ letters: ['A', 'A'], effective: 'pairs' });
    expect(rhymeLetters(1, 'AABB')).toEqual({ letters: [null], effective: 'none' });
    expect(rhymeLetters(3, 'none').letters).toEqual([null, null, null]);
  });
});

describe('trimToBudget', () => {
  it('cuts a line over its count at a word boundary', () => {
    const r = trimToBudget('under the silver rain', ['un', 'der', 'the', 'sil', 'ver', 'rain'], 3);
    expect(r).toEqual({ text: 'under the', syllables: ['un', 'der', 'the'], trimmed: true });
  });
  it('keeps at least one word, and leaves a line that fits', () => {
    expect(trimToBudget('everything', ['ev', 'ery', 'thing'], 1).syllables).toEqual(['ev', 'ery', 'thing']);
    expect(trimToBudget('cold light', ['cold', 'light'], 2).trimmed).toBe(false);
  });
});

it('the prompt line names lines, syllables, the band and the style', () => {
  const spec = budgetSpecFor(axesOf('choir'));
  expect(budgetPromptLine(spec, 8, [2, 2])).toBe('budget: 2 lines, 4 syllables in all (3-6 for 8 bars of Choir)');
});
