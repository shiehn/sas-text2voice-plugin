import {
  countVowelGroups,
  reconcileSyllablesToNotes,
  syllableBudget,
  validatePhraseInSource,
  validateSyllableSplit,
} from '../syllables';
import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';

const SOURCE =
  'The observable universe is a ball-shaped region of the universe comprising all matter ' +
  'that can be observed from Earth.';

const note = (startBeat: number, durationBeats = 0.5): PluginMidiNote => ({
  pitch: 62,
  startBeat,
  durationBeats,
  velocity: 90,
});

describe('validatePhraseInSource', () => {
  it('accepts a verbatim quote', () => {
    expect(validatePhraseInSource('all matter that can be observed', SOURCE).ok).toBe(true);
  });

  it('ignores case and punctuation differences', () => {
    expect(validatePhraseInSource('The Observable Universe,', SOURCE).ok).toBe(true);
  });

  it('rejects invented words — the text must be quoted, not written about', () => {
    const result = validatePhraseInSource('the infinite cosmos beckons', SOURCE);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not in source/);
  });

  it('rejects an empty phrase and an empty source', () => {
    expect(validatePhraseInSource('', SOURCE).ok).toBe(false);
    expect(validatePhraseInSource('anything', '').ok).toBe(false);
  });

  it('allows a non-contiguous selection when every word is present', () => {
    expect(validatePhraseInSource('universe matter Earth', SOURCE).ok).toBe(true);
  });
});

describe('validateSyllableSplit', () => {
  it('accepts a split that reassembles into the phrase', () => {
    expect(validateSyllableSplit(['ob', 'serv', 'a', 'ble'], 'observable').ok).toBe(true);
  });

  it('tolerates spaces and punctuation in the phrase', () => {
    expect(validateSyllableSplit(['all', 'mat', 'ter'], 'all matter').ok).toBe(true);
  });

  it('rejects a split that drops or invents letters', () => {
    expect(validateSyllableSplit(['ob', 'serv'], 'observable').ok).toBe(false);
    expect(validateSyllableSplit(['ob', 'serv', 'a', 'bly'], 'observable').ok).toBe(false);
  });

  it('rejects blank syllables', () => {
    expect(validateSyllableSplit(['all', '  ', 'matter'], 'all matter').ok).toBe(false);
  });
});

describe('countVowelGroups', () => {
  it('counts vowel groups with the silent-e correction', () => {
    expect(countVowelGroups('universe')).toBe(3);
    expect(countVowelGroups('note')).toBe(1);
    expect(countVowelGroups('the')).toBe(1);
  });

  it('never returns zero for a real word', () => {
    expect(countVowelGroups('rhythm')).toBeGreaterThanOrEqual(1);
  });
});

describe('syllableBudget', () => {
  it('scales with bars, meter and density', () => {
    expect(syllableBudget(8, 4, 2)).toBe(64);
    expect(syllableBudget(16, 4, 4)).toBe(256);
    // 6/8 has three quarter-note beats per bar.
    expect(syllableBudget(4, 3, 2)).toBe(24);
  });
});

describe('reconcileSyllablesToNotes', () => {
  it('is a no-op when counts already match', () => {
    const notes = [note(0), note(0.5), note(1)];
    const out = reconcileSyllablesToNotes(['a', 'b', 'c'], notes);
    expect(out.notes).toHaveLength(3);
    expect(out.syllables).toEqual(['a', 'b', 'c']);
    expect(out.droppedSyllables).toBe(0);
    expect(out.mergedNotes).toBe(0);
  });

  it('drops surplus syllables and reports how many did not fit', () => {
    const out = reconcileSyllablesToNotes(['a', 'b', 'c', 'd', 'e'], [note(0), note(0.5)]);
    expect(out.syllables).toEqual(['a', 'b']);
    expect(out.droppedSyllables).toBe(3);
  });

  it('merges surplus notes so the phrase still spans its bar', () => {
    const notes = [note(0), note(0.5), note(1), note(1.5)];
    const out = reconcileSyllablesToNotes(['a', 'b'], notes);
    expect(out.notes).toHaveLength(2);
    expect(out.mergedNotes).toBe(2);
    // The last kept note is extended to the end of the material it absorbed.
    const last = out.notes[1];
    expect(last.startBeat + last.durationBeats).toBeCloseTo(2.0);
  });

  it('always returns equal-length notes and syllables', () => {
    const cases: Array<[string[], PluginMidiNote[]]> = [
      [['a'], [note(0), note(1), note(2)]],
      [['a', 'b', 'c'], [note(0)]],
      [[], [note(0)]],
      [['a'], []],
    ];
    for (const [syls, notes] of cases) {
      const out = reconcileSyllablesToNotes(syls, notes);
      expect(out.notes.length).toBe(out.syllables.length);
    }
  });

  it('sorts notes by start beat before pairing', () => {
    const out = reconcileSyllablesToNotes(['a', 'b'], [note(1), note(0)]);
    expect(out.notes[0].startBeat).toBe(0);
    expect(out.notes[1].startBeat).toBe(1);
  });
});
