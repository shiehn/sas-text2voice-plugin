/**
 * Syllable handling — pure, no host, no model.
 *
 * Fitting syllables to notes lives in distribute.ts: this file is only about
 * the WORDS — validating that the model quoted the user's text and split it
 * honestly.
 *
 * The model returns the syllable split alongside the phrase it chose, which is
 * what lets this plugin avoid a grapheme-to-phoneme dependency altogether (and
 * with it eSpeak NG, whose GPLv3 would be a problem in a closed-source
 * product). Everything the model hands back is untrusted, so it is validated
 * here: the phrase must genuinely occur in the source text, and the syllable
 * split must reassemble into the phrase.
 */

import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';

/** Strip to comparable word characters — apostrophes and case do not count. */
function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function wordsOf(text: string): string[] {
  return text.split(/\s+/).map(normalizeWord).filter((w) => w.length > 0);
}

/**
 * Cheap syllable-count sanity check: count vowel groups, with the usual
 * silent-final-e correction. Not a syllabifier — a second opinion used only to
 * flag an implausible split from the model.
 */
export function countVowelGroups(word: string): number {
  const w = normalizeWord(word);
  if (!w) return 0;
  const groups = w.match(/[aeiouy]+/g);
  let n = groups ? groups.length : 0;
  // "phrase", "note" — trailing e is usually silent, but never drop to zero.
  if (n > 1 && /[^aeiouy]e$/.test(w)) n -= 1;
  return Math.max(1, n);
}

export interface PhraseValidation {
  ok: boolean;
  reason?: string;
}

/**
 * The chosen phrase must be QUOTED from the source, not paraphrased — the whole
 * point is that the article is sung, not that the model writes lyrics about it.
 * Checked word-wise rather than by substring so punctuation and whitespace
 * differences do not cause false rejections.
 */
export function validatePhraseInSource(phrase: string, source: string): PhraseValidation {
  const phraseWords = wordsOf(phrase);
  if (phraseWords.length === 0) return { ok: false, reason: 'phrase is empty' };
  const sourceWords = wordsOf(source);
  if (sourceWords.length === 0) return { ok: false, reason: 'source text is empty' };

  // Look for the phrase as a contiguous run of source words.
  for (let i = 0; i + phraseWords.length <= sourceWords.length; i++) {
    let match = true;
    for (let j = 0; j < phraseWords.length; j++) {
      if (sourceWords[i + j] !== phraseWords[j]) {
        match = false;
        break;
      }
    }
    if (match) return { ok: true };
  }
  // Not contiguous. Allow it only if every word is present somewhere — the
  // model may legitimately have skipped a parenthetical — but nothing invented.
  const pool = new Set(sourceWords);
  const invented = phraseWords.filter((w) => !pool.has(w));
  if (invented.length > 0) {
    return { ok: false, reason: `not in source text: ${invented.slice(0, 5).join(', ')}` };
  }
  return { ok: true };
}

/**
 * The split must reassemble into the phrase, otherwise a syllable would be
 * spoken that the user never supplied.
 */
export function validateSyllableSplit(syllables: string[], phrase: string): PhraseValidation {
  if (syllables.length === 0) return { ok: false, reason: 'no syllables' };
  if (syllables.some((s) => !s.trim())) return { ok: false, reason: 'blank syllable' };
  const joined = normalizeWord(syllables.join(''));
  const target = normalizeWord(phrase);
  if (joined !== target) {
    return { ok: false, reason: 'syllables do not reassemble into the phrase' };
  }
  return { ok: true };
}

/**
 * How many syllables fit a scene, at a given note density.
 * `notesPerBeat` of 2 is eighth notes — comfortable; 4 is sixteenths, which is
 * breathless and where intelligibility starts to break down.
 */
export function syllableBudget(
  bars: number,
  quarterNotesPerBar: number,
  notesPerBeat: number,
): number {
  return Math.max(1, Math.floor(bars * quarterNotesPerBar * notesPerBeat));
}

// --- word spans --------------------------------------------------------------

export interface WordSpan {
  word: string;
  /** [startSyl, endSyl) into the syllable array. */
  startSyl: number;
  endSyl: number;
}

/**
 * Recover word boundaries from a validated syllable split: walk the phrase's
 * words, greedily consuming syllables until each word's letters are covered.
 * Provable because `validateSyllableSplit` already guaranteed the syllables
 * reassemble into the phrase.
 *
 * Consumers thinking in SLOTS must map slot → syllable (`slot % count`, the
 * text loops) BEFORE looking up the span.
 */
export function syllableWordSpans(phrase: string, syllables: string[]): WordSpan[] {
  const spans: WordSpan[] = [];
  const words = phrase.split(/\s+/).filter((w) => normalizeWord(w).length > 0);
  let syl = 0;
  for (const raw of words) {
    const target = normalizeWord(raw);
    const start = syl;
    let acc = '';
    while (syl < syllables.length && acc.length < target.length) {
      acc += normalizeWord(syllables[syl]);
      syl += 1;
    }
    if (acc !== target) {
      // The split disagrees with the words (should be impossible post-
      // validation) — return what resolved cleanly rather than guessing on.
      break;
    }
    spans.push({ word: raw, startSyl: start, endSyl: syl });
  }
  return spans;
}
