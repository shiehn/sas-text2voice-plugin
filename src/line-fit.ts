/**
 * Written lines onto a melody, phrase by phrase (S-443).
 *
 * The quote path spreads ONE phrase across the whole melody and loops it when
 * it is short (a mantra). Written lines are different: each line belongs to a
 * phrase, its last syllable on the phrase-final note (where a rhyme lands), and
 * the budget (song-budget.ts) deliberately gives fewer syllables than a slow
 * melody has notes. So:
 *
 *   fewer syllables than notes  the notes FOLD into held syllables: one
 *                               syllable sung through a run of notes (a melisma,
 *                               SynthV S-434 "a word is not a note"). The run is
 *                               the same folded-note form `foldMelismaRuns`
 *                               already makes (`pitches`), which the renderer
 *                               sings as one vowel moving through those pitches;
 *   as many                     one syllable per note;
 *   more                        the phrase's notes are subdivided, as the quote
 *                               path does (`distributeSyllables`), and whatever
 *                               still does not fit is dropped from the line's
 *                               end and reported, never crushed.
 *
 * When the lines and the melody's phrases do not pair up (a composed melody
 * phrased differently), the syllables are shared over the phrases by length
 * instead: every syllable still lands inside a phrase, none past the bar.
 *
 * Also here: a plain syllable split for lines with none (words edited in the
 * song's Lyrics tab), so Sing needs no model call to sing them.
 */

import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';
import { alignVoiceToSlots, distributeSyllables } from './distribute';
import { countVowelGroups, syllableWordSpans, type WordSpan } from './syllables';

type Run = Array<{ midi: number; beats: number }>;
type FoldedNote = PluginMidiNote & { pitches?: Run };

/** Two notes this close in time are the same phrase. */
const GAP_EPSILON_BEATS = 1e-3;

// ---------------------------------------------------------------------------
// A plain syllable split (no dictionary, no model)
// ---------------------------------------------------------------------------

const VOWEL = /[aeiouy]/i;

/**
 * One word into syllables at its vowel groups: V-CV (one consonant goes to the
 * next syllable), VC-CV (a cluster splits after its first consonant), the
 * trailing consonants and a silent final e stay on the last syllable. As many
 * pieces as `countVowelGroups` counts, and the pieces always reassemble into
 * the word (punctuation rides along), so `validateSyllableSplit` accepts them.
 */
export function heuristicSyllables(word: string): string[] {
  const n = countVowelGroups(word);
  if (n <= 1) return [word];
  // Vowel-group spans over the raw word (letters only count; a leading y is a consonant).
  const groups: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    const isV = VOWEL.test(c) && !(c.toLowerCase() === 'y' && (i === 0 || !/[a-z]/i.test(word[i - 1])));
    if (!isV) continue;
    const last = groups[groups.length - 1];
    if (last && last.end === i) last.end = i + 1;
    else groups.push({ start: i, end: i + 1 });
  }
  if (groups.length < 2) return [word];
  const used = groups.slice(0, n);
  const cuts: number[] = [];
  for (let g = 0; g + 1 < used.length; g++) {
    const consonants = used[g + 1].start - used[g].end;
    cuts.push(consonants >= 2 ? used[g].end + 1 : used[g].end);
  }
  const pieces: string[] = [];
  let from = 0;
  for (const c of cuts) {
    pieces.push(word.slice(from, c));
    from = c;
  }
  pieces.push(word.slice(from));
  return pieces.filter((p) => p.length > 0);
}

/** A line into syllables, word by word. */
export function splitLineSyllables(line: string): string[] {
  return line
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w))
    .flatMap((w) => heuristicSyllables(w));
}

// ---------------------------------------------------------------------------
// The melody's phrases
// ---------------------------------------------------------------------------

/** The lead split into phrases at its rests (a folded melisma note is one unit). */
export function leadPhrases(lead: PluginMidiNote[]): PluginMidiNote[][] {
  const sorted = [...lead].sort((a, b) => a.startBeat - b.startBeat);
  const out: PluginMidiNote[][] = [];
  let cur: PluginMidiNote[] = [];
  for (const n of sorted) {
    const prev = cur[cur.length - 1];
    if (prev && n.startBeat - (prev.startBeat + prev.durationBeats) > GAP_EPSILON_BEATS) {
      out.push(cur);
      cur = [];
    }
    cur.push(n);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

const runOf = (n: FoldedNote): Run => (Array.isArray(n.pitches) && n.pitches.length > 0 ? n.pitches.map((p) => ({ ...p })) : [{ midi: n.pitch, beats: n.durationBeats }]);

/** The renderer (sas-audio-tool vox) takes 1..32 steps per syllable, none shorter than 0.01 s. */
export const MAX_RUN_STEPS = 32;
/** A step shorter than this (beats) joins its neighbour (0.01 s even at 300 BPM). */
export const MIN_STEP_BEATS = 0.05;

/**
 * A run the renderer accepts: repeated pitches merged, slivers joined to the
 * step before, and at most MAX_RUN_STEPS steps (neighbours merged pairwise,
 * the first pitch of each pair kept). Step lengths are relative to the
 * syllable in the renderer, so merging never moves the syllable itself.
 */
export function normalizeRun(run: Run): Run {
  let out: Run = [];
  for (const p of run) {
    const prev = out[out.length - 1];
    if (prev && (prev.midi === p.midi || p.beats < MIN_STEP_BEATS)) prev.beats += p.beats;
    else out.push({ ...p });
  }
  while (out.length > MAX_RUN_STEPS) {
    const next: Run = [];
    for (let i = 0; i < out.length; i += 2) {
      const a = out[i];
      const b = out[i + 1];
      next.push(b ? { midi: a.midi, beats: a.beats + b.beats } : { ...a });
    }
    out = next;
  }
  // Pairs that met on one pitch are one step.
  return out.reduce<Run>((acc, p) => {
    const prev = acc[acc.length - 1];
    if (prev && prev.midi === p.midi) prev.beats += p.beats;
    else acc.push(p);
    return acc;
  }, []);
}

/**
 * `units` (one phrase, contiguous) folded into `n` held syllables. The runs are
 * as even as the notes allow; the LAST syllables take the extra notes, so the
 * phrase settles on its longest-held word.
 */
export function foldUnits(units: PluginMidiNote[], n: number): PluginMidiNote[] {
  const m = units.length;
  if (n <= 0 || m === 0) return [];
  if (n >= m) return units.map((u) => ({ ...u }));
  const base = Math.floor(m / n);
  const extra = m - base * n;
  const out: PluginMidiNote[] = [];
  let at = 0;
  for (let k = 0; k < n; k++) {
    const size = base + (k >= n - extra ? 1 : 0);
    const group = units.slice(at, at + size) as FoldedNote[];
    at += size;
    const first = group[0];
    const last = group[group.length - 1];
    const run = normalizeRun(group.flatMap(runOf));
    const note: FoldedNote = {
      ...first,
      startBeat: first.startBeat,
      durationBeats: last.startBeat + last.durationBeats - first.startBeat,
    };
    delete note.pitches;
    if (run.length > 1 && run.some((p) => p.midi !== run[0].midi)) note.pitches = run;
    out.push(note);
  }
  return out;
}

export interface LineFit {
  /** One slot per sung syllable, in time order. */
  slots: PluginMidiNote[];
  /** For each slot, its index into the lines' syllables (flattened). */
  syllableIndex: number[];
  /** Syllables that found no room and were not sung. */
  dropped: number;
  /** True when line k sat on phrase k (rhymes on phrase-final notes). */
  aligned: boolean;
  /** Notes held under another syllable (melisma). */
  heldNotes: number;
  /** The lead's phrases (for the log). */
  phrases: number;
}

function fitPhrase(units: PluginMidiNote[], n: number, notesPerBeat: number): PluginMidiNote[] {
  if (n <= 0) return [];
  if (n <= units.length) return foldUnits(units, n);
  return distributeSyllables(units, n, notesPerBeat).notes.slice(0, n);
}

/**
 * Lay `lineCounts[k]` syllables of line k onto the lead. Line k takes phrase k
 * when there are as many lines as phrases; otherwise the syllables are shared
 * over the phrases by their length (each phrase at least one while syllables
 * last).
 */
export function fitLinesToLead(lead: PluginMidiNote[], lineCounts: number[], notesPerBeat: number): LineFit {
  const phrases = leadPhrases(lead);
  const total = lineCounts.reduce((s, c) => s + Math.max(0, c), 0);
  const empty: LineFit = { slots: [], syllableIndex: [], dropped: total, aligned: false, heldNotes: 0, phrases: phrases.length };
  if (phrases.length === 0 || total === 0) return empty;

  const aligned = lineCounts.length === phrases.length;
  // Per phrase: how many syllables, and which (flattened) syllable indexes they are.
  const perPhrase: number[][] = phrases.map(() => []);
  if (aligned) {
    let s = 0;
    lineCounts.forEach((c, k) => {
      for (let j = 0; j < c; j++) perPhrase[k].push(s + j);
      s += Math.max(0, c);
    });
  } else {
    const dur = phrases.map((p) => p[p.length - 1].startBeat + p[p.length - 1].durationBeats - p[0].startBeat);
    const weight = dur.reduce((a, b) => a + b, 0) || phrases.length;
    const share = phrases.map(() => 0);
    let left = total;
    // At least one each, in order, while syllables last; then by length.
    for (let i = 0; i < phrases.length && left > 0; i++) {
      share[i] = 1;
      left -= 1;
    }
    while (left > 0) {
      let best = 0;
      let gap = -Infinity;
      for (let i = 0; i < phrases.length; i++) {
        const g = (dur[i] / weight) * total - share[i];
        if (g > gap + 1e-9) {
          gap = g;
          best = i;
        }
      }
      share[best] += 1;
      left -= 1;
    }
    let s = 0;
    share.forEach((c, i) => {
      for (let j = 0; j < c; j++) perPhrase[i].push(s + j);
      s += c;
    });
  }

  const slots: PluginMidiNote[] = [];
  const syllableIndex: number[] = [];
  let heldNotes = 0;
  phrases.forEach((units, i) => {
    const want = perPhrase[i];
    const fitted = fitPhrase(units, want.length, notesPerBeat);
    if (fitted.length < units.length) heldNotes += units.length - fitted.length;
    fitted.forEach((slot, j) => {
      slots.push(slot);
      syllableIndex.push(want[j]);
    });
  });
  return { slots, syllableIndex, dropped: total - slots.length, aligned, heldNotes, phrases: phrases.length };
}

/**
 * A harmony voice on the fitted slots: `alignVoiceToSlots`, and under a held
 * syllable the voice moves too: its pitch at each step of the lead's run.
 */
export function alignVoiceToFittedSlots(voiceNotes: PluginMidiNote[], slots: PluginMidiNote[]): Array<PluginMidiNote | null> {
  const base = alignVoiceToSlots(voiceNotes, slots);
  const sorted = [...voiceNotes].sort((a, b) => a.startBeat - b.startBeat);
  const at = (beat: number): PluginMidiNote | undefined =>
    sorted.find((n) => beat >= n.startBeat - 1e-9 && beat < n.startBeat + n.durationBeats - 1e-9);
  return base.map((note, i) => {
    if (!note) return note;
    const run = (slots[i] as FoldedNote).pitches;
    const out: FoldedNote = { ...note };
    delete out.pitches;
    if (!run || run.length < 2) return out;
    let t = slots[i].startBeat;
    const voiceRun: Run = run.map((seg) => {
      const held = at(t + 1e-6);
      t += seg.beats;
      return { midi: held ? held.pitch : note.pitch, beats: seg.beats };
    });
    const steps = normalizeRun(voiceRun);
    if (steps.length > 1) out.pitches = steps;
    return out;
  });
}

/** After the breath guard shortened a slot, its run is cut to fit it (the tail of the last step goes first). */
export function clampSlotPitches<T extends PluginMidiNote | null>(slots: T[]): T[] {
  return slots.map((s) => {
    if (!s) return s;
    const run = (s as FoldedNote).pitches;
    if (!run || run.length === 0) return s;
    const total = run.reduce((a, p) => a + p.beats, 0);
    if (total <= s.durationBeats + 1e-9) return s;
    let left = s.durationBeats;
    const cut: Run = [];
    for (const p of run) {
      if (left <= 1e-9) break;
      const beats = Math.min(p.beats, left);
      cut.push({ midi: p.midi, beats });
      left -= beats;
    }
    const out = { ...s } as FoldedNote;
    const steps = normalizeRun(cut);
    if (steps.length > 1) out.pitches = steps;
    else delete out.pitches;
    return out as T;
  });
}

/** Word spans for the fitted lines (exact when nothing was dropped; else one span per syllable). */
export function fittedWordSpans(lineTexts: string[], lines: string[][], sungIndex: number[], dropped: number): WordSpan[] {
  if (dropped === 0) {
    const spans: WordSpan[] = [];
    let base = 0;
    lines.forEach((syls, k) => {
      for (const sp of syllableWordSpans(lineTexts[k] ?? syls.join(''), syls)) {
        spans.push({ ...sp, startSyl: sp.startSyl + base, endSyl: sp.endSyl + base });
      }
      base += syls.length;
    });
    return spans;
  }
  const flat = lines.flat();
  return sungIndex.map((idx, i) => ({ word: flat[idx] ?? '', startSyl: i, endSyl: i + 1 }));
}
