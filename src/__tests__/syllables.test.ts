import {
  countVowelGroups,
  syllableBudget,
  validatePhraseInSource,
  validateSyllableSplit,
} from '../syllables';

const SOURCE =
  'The observable universe is a ball-shaped region of the universe comprising all matter ' +
  'that can be observed from Earth.';


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
