/**
 * Write-lyrics mode — original words fitted to an existing melody.
 *
 * The chicken-and-egg: rhyme targets are phrase-final syllables, but phrase
 * structure comes from distribution, which needs a syllable count the words
 * call has not produced yet. Resolved with a PROVISIONAL pass: distribute the
 * melody at its natural capacity, breath-guard, detect phrases — rest
 * positions come from the melody, so the structure is stable — and hand the
 * model per-phrase syllable budgets plus the rhyme pairing. The model returns
 * `lines[]`, one syllable array per phrase.
 *
 * Materialization then makes the fit EXACT by construction: each line maps
 * onto its phrase's slots with the line's LAST syllable pinned to the
 * phrase's LAST slot — so a one-syllable miscount shifts inside its phrase
 * instead of dragging every rhyme off its landing. Short lines loop their
 * front; long lines drop from their front (the tail carries the rhyme).
 *
 * Because the words call targeted natural capacity, the render-time
 * distribution reproduces the same slot layout (any knob that would change it
 * routes to reword first), so materialized index == slot index, 1:1.
 */

import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';
import type { PhraseSpan } from './phrases';
import type { WordSpan } from './syllables';
import { syllableWordSpans } from './syllables';

export type RhymeScheme = 'none' | 'AABB' | 'ABAB';

export interface PhraseBudget {
  /** Syllables this phrase holds (its slot count). */
  syllables: number;
  /** Rhyme group letter, or null when unconstrained. */
  rhyme: string | null;
}

/**
 * Per-phrase budgets + rhyme letters for the words prompt.
 *
 * AABB/ABAB want four-phrase groups; with fewer REST phrases the scheme
 * degrades honestly: 2-3 phrases → pairs (AA / AAB pairing of neighbours),
 * 0-1 → none. The degradation is reported so the panel can say why.
 */
export function phraseBudgets(
  phrases: PhraseSpan[],
  scheme: RhymeScheme,
): { budgets: PhraseBudget[]; effectiveScheme: RhymeScheme | 'pairs' } {
  const rests = phrases.filter((p) => p.boundary === 'rest');
  const budgets: PhraseBudget[] = phrases.map((p) => ({
    syllables: p.endSlot - p.startSlot,
    rhyme: null,
  }));

  let effective: RhymeScheme | 'pairs' = scheme;
  if (scheme === 'none' || rests.length <= 1) {
    effective = scheme === 'none' ? 'none' : 'none';
  } else if (rests.length < 4) {
    effective = 'pairs';
  }

  if (effective === 'none') return { budgets, effectiveScheme: 'none' };

  // Assign letters over the REST phrases only (breath spans are invisible).
  const restIndexes = phrases
    .map((p, i) => (p.boundary === 'rest' ? i : -1))
    .filter((i) => i >= 0);
  restIndexes.forEach((phraseIdx, restIdx) => {
    let letter: string;
    if (effective === 'pairs') {
      letter = String.fromCharCode(65 + Math.floor(restIdx / 2)); // AABBCC…
    } else if (scheme === 'AABB') {
      letter = String.fromCharCode(65 + Math.floor(restIdx / 2));
    } else {
      // ABAB in four-phrase groups.
      letter = String.fromCharCode(65 + (Math.floor(restIdx / 4) * 2 + (restIdx % 2)));
    }
    budgets[phraseIdx].rhyme = letter;
  });
  return { budgets, effectiveScheme: effective };
}

export interface MaterializedLyrics {
  /** One syllable per lead slot, 1:1 by construction. */
  syllables: string[];
  /** Word spans in the materialized index space (for shouts/echoes). */
  wordSpans: WordSpan[];
  /** The lines joined for display ("line one / line two"). */
  phrase: string;
}

/**
 * Fit the model's lines onto the phrase structure, slot for slot.
 */
export function materializeLines(
  lines: string[][],
  lineTexts: string[],
  phrases: PhraseSpan[],
): MaterializedLyrics {
  const syllables: string[] = [];
  const wordSpans: WordSpan[] = [];
  const displayed: string[] = [];

  phrases.forEach((phrase, pi) => {
    const want = phrase.endSlot - phrase.startSlot;
    const line = lines[pi] ?? lines[lines.length - 1] ?? ['la'];
    const text = lineTexts[pi] ?? lineTexts[lineTexts.length - 1] ?? line.join(' ');
    displayed.push(text);
    const base = syllables.length;

    let fitted: string[];
    if (line.length === want) {
      fitted = [...line];
    } else if (line.length > want) {
      // Drop from the FRONT — the tail carries the rhyme.
      fitted = line.slice(line.length - want);
    } else {
      // Loop the front to fill, keeping the true tail pinned to the end.
      fitted = [];
      const head = Math.max(1, line.length - 1);
      for (let i = 0; i < want - 1; i++) fitted.push(line[i % head]);
      fitted.push(line[line.length - 1]);
      if (want === 1) fitted = [line[line.length - 1]];
    }
    syllables.push(...fitted);

    // Word spans for the FITTED sequence: exact when the line fit untouched;
    // for padded/trimmed lines, fall back to one span per syllable (shouts and
    // echoes then treat each syllable as a word — safe, slightly blunt).
    if (line.length === want) {
      for (const span of syllableWordSpans(text, line)) {
        wordSpans.push({ ...span, startSyl: span.startSyl + base, endSyl: span.endSyl + base });
      }
    } else {
      fitted.forEach((syl, i) => {
        wordSpans.push({ word: syl, startSyl: base + i, endSyl: base + i + 1 });
      });
    }
  });

  return { syllables, wordSpans, phrase: displayed.join(' / ') };
}
