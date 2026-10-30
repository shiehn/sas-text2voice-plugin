/**
 * Phrases fit the bar length (S-443, after SynthV S-432 `song-budget.ts` and
 * S-442's bar-counted `sparse` band).
 *
 * The syllable budget is a COUNT, not a rate: about four syllables per eight
 * bars (3-6) for the slow sung styles, scaled by the section's bars. Tempo and
 * feel never move it: a 140 BPM scene and a 70 BPM scene of eight bars get
 * the same few words. The flow styles keep their denser grids through a
 * per-style multiplier (rap lines are bars; trap rolls triplets), so the same
 * rule serves a chorale and a tag-team verse.
 *
 * Everything here is pure:
 *   - `budgetSpecFor`  the style (or, for a hand-edited Custom setup, the pace) a config is budgeted as;
 *   - `sectionBudget`  the count over a section's bars: min, centre, max;
 *   - `wordsFirstLines` the syllables per line when no melody exists yet (one
 *     line per `phraseBars`, the centre shared out);
 *   - `melodyLineTargets` the syllables per phrase of a melody that is kept;
 *   - `rhymeLetters`   the AABB / ABAB letters over the lines (degrading to
 *     pairs below four lines, as the scene writer always has);
 *   - `trimToBudget`   a line over its count, cut at a word boundary.
 */

import { configMatchesStyle, STYLE_IDS, STYLES, type StyleId } from './styles';
import type { Character, DeliveryMode, HarmonyStyle } from './harmony-styles';
import { syllableWordSpans } from './syllables';

/** The slow sung count per eight bars (S-442: "about 4, not 4"). */
export const BASE_PER_EIGHT_BARS = { min: 3, centre: 4, max: 6 } as const;

export interface BudgetSpec {
  /** Times the base count per eight bars. */
  multiplier: number;
  /** One written line per this many bars when no melody exists yet. */
  phraseBars: number;
  /** "Choir" or "Custom (medium pace)", for the prompt and the log. */
  label: string;
}

/** Per style: the slow styles sing the base count; the flow styles keep their denser grids. */
export const STYLE_BUDGETS: Record<StyleId, Omit<BudgetSpec, 'label'>> = {
  choir: { multiplier: 1, phraseBars: 4 },
  chant: { multiplier: 1, phraseBars: 4 },
  ballad: { multiplier: 2, phraseBars: 4 },
  sprechgesang: { multiplier: 5, phraseBars: 2 },
  tagteam: { multiplier: 10, phraseBars: 1 },
  trap: { multiplier: 12, phraseBars: 1 },
};

/** A hand-edited (Custom) setup is budgeted by its pace: slow sings few, fast raps. */
export const PACE_BUDGETS: Record<1 | 2 | 3 | 4, Omit<BudgetSpec, 'label'>> = {
  1: { multiplier: 1, phraseBars: 4 },
  2: { multiplier: 2, phraseBars: 2 },
  3: { multiplier: 6, phraseBars: 1 },
  4: { multiplier: 8, phraseBars: 1 },
};

const PACE_NAMES: Record<1 | 2 | 3 | 4, string> = { 1: 'slow', 2: 'medium', 3: 'triplet', 4: 'fast' };

export interface BudgetAxes {
  style?: StyleId;
  harmony: HarmonyStyle;
  delivery: DeliveryMode;
  character: Character;
  notesPerBeat: number;
}

/**
 * The spec a config is budgeted as: its style while the axes still match it
 * (the style is a fingerprint, so a style edited into Custom no longer counts),
 * else the first style the axes match (the default setup is the choir), else
 * the pace.
 */
export function budgetSpecFor(axes: BudgetAxes): BudgetSpec & { styleId: StyleId | null } {
  const plain = { harmony: axes.harmony, delivery: axes.delivery, character: axes.character, notesPerBeat: axes.notesPerBeat };
  const styleId: StyleId | null =
    axes.style && configMatchesStyle(axes.style, plain)
      ? axes.style
      : (STYLE_IDS.find((id) => configMatchesStyle(id, plain)) ?? null);
  if (styleId) return { ...STYLE_BUDGETS[styleId], label: STYLES[styleId].label, styleId };
  const pace = (axes.notesPerBeat === 1 || axes.notesPerBeat === 3 || axes.notesPerBeat === 4 ? axes.notesPerBeat : 2) as 1 | 2 | 3 | 4;
  return { ...PACE_BUDGETS[pace], label: `Custom (${PACE_NAMES[pace]} pace)`, styleId: null };
}

export interface SectionBudget {
  min: number;
  centre: number;
  max: number;
}

/** The count over `bars` bars: the base per eight bars, times the spec's multiplier, scaled by the bars. */
export function sectionBudget(spec: Pick<BudgetSpec, 'multiplier'>, bars: number): SectionBudget {
  const scale = (Math.max(0, bars) / 8) * spec.multiplier;
  const min = Math.max(1, Math.round(BASE_PER_EIGHT_BARS.min * scale));
  const centre = Math.max(min, Math.round(BASE_PER_EIGHT_BARS.centre * scale));
  const max = Math.max(centre, Math.round(BASE_PER_EIGHT_BARS.max * scale));
  return { min, centre, max };
}

/** Share `total` over `n` parts as evenly as possible, the extra ones first. */
function shareEvenly(total: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  const extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * Words first (no melody yet): one line per `phraseBars` bars (at least one,
 * never more lines than syllables), the budget's centre shared out. Sing then
 * composes music FOR these lines.
 */
export function wordsFirstLines(spec: Pick<BudgetSpec, 'multiplier' | 'phraseBars'>, bars: number): number[] {
  const b = sectionBudget(spec, bars);
  const lines = Math.max(1, Math.min(b.centre, Math.round(Math.max(1, bars) / Math.max(1, spec.phraseBars))));
  return shareEvenly(b.centre, lines);
}

export interface MelodyTargets {
  /** Syllables per phrase of the melody, in order. */
  targets: number[];
  /** The melody has more phrases than the budget's maximum: one syllable each is already over it. */
  over: boolean;
}

/**
 * A kept melody: one line per phrase. Every phrase sings at least one syllable
 * (no music is left unsung), the rest of the centre goes to the longest phrases
 * (largest remainder by duration), and no phrase is asked for more than it can
 * hold (`capacity`, its slots at the pace).
 */
export function melodyLineTargets(durations: number[], capacity: number[], budget: SectionBudget): MelodyTargets {
  const n = durations.length;
  if (n === 0) return { targets: [], over: false };
  const total = Math.max(budget.centre, n);
  const targets = durations.map(() => 1);
  let left = total - n;
  const weight = durations.reduce((s, d) => s + Math.max(0, d), 0) || n;
  const want = durations.map((d) => (Math.max(0, d) / weight) * total);
  while (left > 0) {
    let best = -1;
    let gap = -Infinity;
    for (let i = 0; i < n; i++) {
      if (targets[i] >= Math.max(1, capacity[i] ?? Infinity)) continue;
      const g = want[i] - targets[i];
      if (g > gap + 1e-9) {
        gap = g;
        best = i;
      }
    }
    if (best < 0) break;
    targets[best] += 1;
    left -= 1;
  }
  return { targets, over: n > budget.max };
}

export type RhymeChoice = 'none' | 'AABB' | 'ABAB';

/**
 * Rhyme letters over `n` lines. AABB and ABAB want four lines; two or three
 * lines rhyme in neighbouring pairs; one line rhymes with nothing.
 */
export function rhymeLetters(n: number, scheme: RhymeChoice): { letters: Array<string | null>; effective: RhymeChoice | 'pairs' } {
  if (scheme === 'none' || n <= 1) return { letters: Array.from({ length: n }, () => null), effective: 'none' };
  const effective: RhymeChoice | 'pairs' = n < 4 ? 'pairs' : scheme;
  const letters = Array.from({ length: n }, (_, i) =>
    effective === 'ABAB'
      ? String.fromCharCode(65 + (Math.floor(i / 4) * 2 + (i % 2)))
      : String.fromCharCode(65 + Math.floor(i / 2)),
  );
  return { letters, effective };
}

/**
 * A line over its count, cut to it at a word boundary: the longest run of
 * whole words from the start that fits (at least one word). A line that fits,
 * or whose split cannot be aligned to its words, is left alone.
 */
export function trimToBudget(text: string, syllables: string[], budget: number): { text: string; syllables: string[]; trimmed: boolean } {
  const keep = { text, syllables, trimmed: false };
  if (budget < 1 || syllables.length <= budget) return keep;
  const spans = syllableWordSpans(text, syllables);
  if (spans.length === 0 || spans[spans.length - 1].endSyl !== syllables.length) return keep;
  let words = 0;
  for (const sp of spans) {
    if (sp.endSyl > budget) break;
    words += 1;
  }
  if (words === 0) words = 1;
  if (words === spans.length) return keep;
  const end = spans[words - 1].endSyl;
  return { text: spans.slice(0, words).map((s) => s.word).join(' '), syllables: syllables.slice(0, end), trimmed: true };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The section's budget in the prompt's words: "2 lines, 4 syllables in all (3-6 for 8 bars of Choir)". */
export function budgetPromptLine(spec: BudgetSpec, bars: number, targets: number[]): string {
  const b = sectionBudget(spec, bars);
  const asked = targets.reduce((s, t) => s + t, 0);
  return `budget: ${plural(targets.length, 'line')}, ${plural(asked, 'syllable')} in all (${b.min}-${b.max} for ${plural(bars, 'bar')} of ${spec.label})`;
}

/** The console line per section after the words are in. */
export function budgetLogLine(label: string, spec: BudgetSpec, bars: number, asked: number[], written: number, trimmed: number): string {
  const b = sectionBudget(spec, bars);
  const total = asked.reduce((s, t) => s + t, 0);
  let tail = `${plural(asked.length, 'line')}, ${total} syllables asked (${b.min}-${b.max}), ${written} written`;
  if (trimmed > 0) tail += `, ${plural(trimmed, 'line')} trimmed to the budget`;
  return `[Text2Voice] song budget: ${label}: ${spec.label} · ${plural(bars, 'bar')}: ${tail}`;
}
