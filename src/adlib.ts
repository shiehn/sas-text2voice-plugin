/**
 * Adlib echoes — the hype man in the gaps.
 *
 * Trap practice: the last word of a line is echoed into the silence after it,
 * quieter and panned wide (Migos' "Versace" move). Adlib is a lane ROLE, not
 * a delivery mode — making it a delivery would beg the question of what the
 * OTHER voices do under it. So this is a post-pass over the finished
 * assignments: it APPENDS echo entries to the adlib lane, leaving every other
 * lane exactly as the delivery arranged it.
 *
 * Echo entries author their own times inside the phrase's trailing gap — the
 * one sanctioned departure from the slot timeline, safe because nothing
 * downstream indexes assignments positionally: `buildVocalLineRequest` reads
 * each entry's own note times.
 *
 * Loudness/pan are NOT set here: each rendered lane is peak-normalized, so a
 * per-syllable gain cannot make a whole lane quieter — the lane's track
 * volume/pan carry that (see laneMixFor).
 */

import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';
import type { VoiceSyllableAssignment } from './harmony-styles';
import type { PhraseSpan } from './phrases';
import type { WordSpan } from './syllables';

/** Gaps shorter than this can't hold an intelligible echo. */
const MIN_GAP_BEATS = 0.5;
/** The echo starts this far into the gap — off the lead's release. */
const ECHO_LAG_FRACTION = 0.2;
/** ...and fills at most this much of it, so the next phrase enters clean. */
const ECHO_FILL_FRACTION = 0.7;

/**
 * Echo each `'rest'` phrase's final word into its trailing gap, on the lead's
 * final pitch. Returns a NEW assignment array for the adlib lane.
 */
export function buildAdlibEchoes(
  leadSlots: PluginMidiNote[],
  phrases: PhraseSpan[],
  wordSpans: WordSpan[],
  syllableCount: number,
): VoiceSyllableAssignment[] {
  const echoes: VoiceSyllableAssignment[] = [];
  if (syllableCount <= 0) return echoes;

  for (const phrase of phrases) {
    if (phrase.boundary !== 'rest') continue;
    if (phrase.gapBeats < MIN_GAP_BEATS) continue;

    const lastSlot = leadSlots[phrase.endSlot - 1];
    if (!lastSlot) continue;
    const lastSyl = (phrase.endSlot - 1) % syllableCount;
    const span = wordSpans.find((w) => lastSyl >= w.startSyl && lastSyl < w.endSyl);
    if (!span) continue;

    const wordSyllables: number[] = [];
    for (let s = span.startSyl; s < span.endSyl; s++) wordSyllables.push(s);
    if (wordSyllables.length === 0) continue;

    const start = phrase.endBeat + phrase.gapBeats * ECHO_LAG_FRACTION;
    const budget = phrase.gapBeats * ECHO_FILL_FRACTION;
    const per = budget / wordSyllables.length;

    wordSyllables.forEach((syl, i) => {
      echoes.push({
        syllableIndex: syl,
        note: {
          ...lastSlot,
          startBeat: start + i * per,
          durationBeats: per,
        },
        // An echo is spoken-ish, half-loose around the lead's closing pitch.
        treatment: { pitchMode: 'contour', contourDepth: 0.5, timeMode: 'natural' },
      });
    });
  }
  return echoes;
}


/** Audible-inhale placement: gaps at least this long get a breath. */
const MIN_INHALE_GAP_BEATS = 0.75;
/** The inhale occupies the TAIL of the gap, landing just before the entry. */
const INHALE_BEATS = 0.3;

/**
 * A soft audible inhale just before each phrase AFTER a long enough gap —
 * rendered by speaking "haaah" REVERSED through the raw (no-analysis) path.
 * Appended to the LEAD lane of breathy styles.
 */
export function buildInhales(phrases: PhraseSpan[]): VoiceSyllableAssignment[] {
  const inhales: VoiceSyllableAssignment[] = [];
  for (const phrase of phrases) {
    if (phrase.gapBeats < MIN_INHALE_GAP_BEATS) continue;
    inhales.push({
      syllableIndex: 0, // unused: the treatment overrides the text
      note: {
        pitch: 60, // unused by the inhale path
        startBeat: phrase.endBeat + phrase.gapBeats - INHALE_BEATS,
        durationBeats: INHALE_BEATS,
        velocity: 40,
      },
      treatment: { kind: 'inhale', reverse: true, gain: 0.35, textOverride: 'haaah' },
    });
  }
  return inhales;
}
