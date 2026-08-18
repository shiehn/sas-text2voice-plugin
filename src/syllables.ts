/**
 * Syllable handling — pure, no host, no model.
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

export interface ReconcileResult {
  /** One entry per surviving note; parallel to `notes`. */
  notes: PluginMidiNote[];
  /** syllable text per surviving note; same length as `notes`. */
  syllables: string[];
  /** Syllables that did not fit and were dropped. */
  droppedSyllables: number;
  /** Notes absorbed into a predecessor because there was no syllable for them. */
  mergedNotes: number;
}

/**
 * Force a strict 1:1 syllable↔note mapping.
 *
 * Surplus NOTES are merged into their predecessor (the syllable is simply held
 * longer) rather than left silent, so the phrase still spans the bar it was
 * written for. Note this is a sustain, not a true melisma: the renderer holds
 * one pitch per syllable, so a syllable cannot move in pitch while sounding.
 *
 * Surplus SYLLABLES are dropped from the end and counted, so the panel can
 * report honestly that the phrase did not fit.
 */
export function reconcileSyllablesToNotes(
  syllables: string[],
  notes: PluginMidiNote[],
): ReconcileResult {
  if (notes.length === 0) {
    return { notes: [], syllables: [], droppedSyllables: syllables.length, mergedNotes: 0 };
  }
  if (syllables.length === 0) {
    return { notes: [], syllables: [], droppedSyllables: 0, mergedNotes: notes.length };
  }

  const sorted = [...notes].sort((a, b) => a.startBeat - b.startBeat);

  if (syllables.length >= sorted.length) {
    return {
      notes: sorted,
      syllables: syllables.slice(0, sorted.length),
      droppedSyllables: syllables.length - sorted.length,
      mergedNotes: 0,
    };
  }

  // Fewer syllables than notes: keep the first `syllables.length` notes and
  // extend each to swallow the notes that follow it before the next kept one.
  const keepCount = syllables.length;
  const kept: PluginMidiNote[] = [];
  // Spread the kept notes evenly through the phrase rather than clumping them
  // at the front, so a long line still uses its whole bar.
  const stride = sorted.length / keepCount;
  const keepIndexes: number[] = [];
  for (let i = 0; i < keepCount; i++) keepIndexes.push(Math.floor(i * stride));

  for (let i = 0; i < keepCount; i++) {
    const startIdx = keepIndexes[i];
    const nextIdx = i + 1 < keepCount ? keepIndexes[i + 1] : sorted.length;
    const first = sorted[startIdx];
    const last = sorted[nextIdx - 1];
    const end = last.startBeat + last.durationBeats;
    kept.push({ ...first, durationBeats: Math.max(0.05, end - first.startBeat) });
  }

  return {
    notes: kept,
    syllables: [...syllables],
    droppedSyllables: 0,
    mergedNotes: sorted.length - keepCount,
  };
}
