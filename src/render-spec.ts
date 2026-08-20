/**
 * Build the render request for one voice: syllable text + target pitch +
 * absolute timing + the character's WORLD parameters + the style's EXPRESSION
 * (vox spec v3) — scoops at phrase entries, glides between adjacent notes,
 * vibrato on sustains, falls and aspirated releases at phrase finals, and a
 * per-lane humanize seed that turns unison clones into a choir.
 *
 * Kept pure and separate from the pipeline so the mapping from
 * (notes, syllables, character, bpm, expression) to a render request is
 * directly testable without a host — this is the layer where an off-by-one
 * silently mis-speaks a word, so it is worth testing on its own.
 */

import type {
  PluginMidiNote,
  RenderVocalLineRequest,
  VocalSyllableSpec as SdkVocalSyllableSpec,
} from '@signalsandsorcery/plugin-sdk';
import { characterFor, type Character } from './harmony-styles';
import type { VoiceSyllableAssignment } from './harmony-styles';
import { SUNG_TREATMENT, type ExpressionPack, type VoxTreatment } from './styles';
import type { WordSpan } from './syllables';

// The wire contract lives in the SDK (@since 3.4.0); these aliases keep the
// local call sites readable without redeclaring — and therefore risking drift
// from — the shape the host actually validates.
export type VocalSyllableSpec = SdkVocalSyllableSpec;
export type VocalLineRequest = RenderVocalLineRequest;

export function beatsToSeconds(beats: number, bpm: number): number {
  return (beats * 60) / bpm;
}

/** Assignments further apart than this (in beats) begin a new phrase. */
const PHRASE_GAP_BEATS = 0.24;
/** Assignments closer than this (in seconds) sing legato into each other. */
const LEGATO_GAP_SEC = 0.08;
/** Below this sustained length vibrato never has time to bloom. */
const VIBRATO_MIN_SEC = 0.55;

export interface ExpressionOptions {
  /** The style's pack, or null to render exactly as before. */
  expression: ExpressionPack | null;
  /** The user's realism dial, 0..1. 0 disables every v3 field. */
  realism: number;
  /** Distinct per lane — identical seeds render identical lanes. */
  laneSeed: number;
  /** Word boundaries over the syllable array, for word-level synthesis. */
  wordSpans?: WordSpan[] | null;
  /** Lexical stress per syllable (1 = stressed) — shapes accent gain. */
  stress?: number[] | null;
}

/**
 * Assemble one voice's render request. Assignments carrying a null syllable
 * index are rests and produce nothing — they still occupy their slot in time,
 * which is what makes hocket and canon line up.
 */
export function buildVocalLineRequest(
  assignments: VoiceSyllableAssignment[],
  syllables: string[],
  character: Character,
  voiceIndex: number,
  voiceCount: number,
  bpm: number,
  totalBeats: number,
  ttsVoice?: string,
  laneTreatment: VoxTreatment = SUNG_TREATMENT,
  expressionOpts?: ExpressionOptions,
): VocalLineRequest {
  const params = characterFor(character, voiceIndex, voiceCount);
  const specs: VocalSyllableSpec[] = [];

  const r = expressionOpts ? Math.max(0, Math.min(1, expressionOpts.realism)) : 0;
  const pack = r > 0 ? (expressionOpts?.expression ?? null) : null;

  // syllable index -> word-span index, for word/wordId grouping.
  const sylToSpan = new Map<number, number>();
  if (pack && expressionOpts?.wordSpans) {
    expressionOpts.wordSpans.forEach((span, k) => {
      for (let i = span.startSyl; i < span.endSyl; i++) sylToSpan.set(i, k);
    });
  }

  // Sung entries in time order, for phrase-boundary and legato context.
  const sung = assignments.filter(
    (a): a is VoiceSyllableAssignment & { note: PluginMidiNote } => a.note !== null,
  );

  for (let k = 0; k < sung.length; k++) {
    const a = sung[k];
    const isInhale = a.treatment?.kind === 'inhale';
    if (a.syllableIndex === null && !isInhale) continue;
    const text =
      a.treatment?.textOverride ?? (a.syllableIndex !== null ? syllables[a.syllableIndex] : '');
    if (!text) continue;

    const spec: VocalSyllableSpec = {
      text,
      midi: a.note.pitch,
      startSec: beatsToSeconds(a.note.startBeat, bpm),
      durSec: beatsToSeconds(a.note.durationBeats, bpm),
      formantWarp: params.formantWarp,
      breath: params.breath,
      jitter: params.jitter,
      // Lane-level treatment first, per-entry override on top.
      pitchMode: a.treatment?.pitchMode ?? laneTreatment.pitchMode,
      contourDepth: a.treatment?.contourDepth ?? laneTreatment.contourDepth,
      timeMode: a.treatment?.timeMode ?? laneTreatment.timeMode,
      gain: a.treatment?.gain ?? 1,
      reverse: a.treatment?.reverse ?? false,
      kind: a.treatment?.kind ?? 'syllable',
    };

    if (pack && !isInhale) {
      // Phrase context from this lane's own timeline. prev/next look at the
      // adjacent SUNG entries whether or not they carried a syllable, because
      // a shout or echo still occupies the singer's throat.
      const prev = k > 0 ? sung[k - 1] : undefined;
      const next = k + 1 < sung.length ? sung[k + 1] : undefined;
      const gapBefore = prev
        ? a.note.startBeat - (prev.note.startBeat + prev.note.durationBeats)
        : Number.POSITIVE_INFINITY;
      const gapAfter = next
        ? next.note.startBeat - (a.note.startBeat + a.note.durationBeats)
        : Number.POSITIVE_INFINITY;
      const phraseInitial = gapBefore >= PHRASE_GAP_BEATS;
      const phraseFinal = gapAfter >= PHRASE_GAP_BEATS;
      const gapBeforeSec = beatsToSeconds(Math.max(0, gapBefore), bpm);

      spec.retuneMs = pack.retuneMs * r;
      if (pack.driftCents > 0) spec.driftCents = pack.driftCents * r;
      spec.align = pack.align;
      if (pack.singersFormant > 0) spec.singersFormant = pack.singersFormant * r;
      if (pack.tilt !== 0) spec.tilt = pack.tilt * r;
      if (pack.timeMode && !a.treatment?.timeMode) spec.timeMode = pack.timeMode;

      if (phraseInitial && pack.scoopCents > 0) {
        spec.scoopCents = pack.scoopCents * r;
      } else if (
        !phraseInitial &&
        prev &&
        gapBeforeSec < LEGATO_GAP_SEC &&
        prev.note.pitch !== a.note.pitch &&
        (prev.treatment?.kind ?? 'syllable') === 'syllable'
      ) {
        spec.legatoFromMidi = prev.note.pitch;
      }

      if (
        pack.vibrato &&
        spec.durSec * 1000 > pack.vibrato.onsetMs + 150 &&
        spec.pitchMode !== 'natural'
      ) {
        spec.vibrato = {
          rateHz: pack.vibrato.rateHz,
          depthCents: pack.vibrato.depthCents * r,
          onsetMs: pack.vibrato.onsetMs,
          ampDepth: pack.vibrato.ampDepth * r,
        };
      }

      if (phraseFinal) {
        spec.envelope = 'fall';
        if (pack.breathTail > 0) {
          // Keep the character's own breathiness as the floor — a ghost must
          // not become LESS breathy because the phrase is ending.
          const base = params.breath ?? 0;
          spec.breathiness = [
            Math.max(base, 0.05 * r),
            Math.max(base, pack.breathTail * r),
          ];
        }
      } else if (spec.durSec >= VIBRATO_MIN_SEC && phraseInitial) {
        spec.envelope = 'swell';
      }

      // Word-level synthesis: consecutive syllables of one word become one
      // utterance, sliced at f0 gaps — coarticulation survives inside words.
      if (a.syllableIndex !== null && !a.treatment?.textOverride) {
        const span = sylToSpan.get(a.syllableIndex);
        if (span !== undefined) {
          spec.word = (expressionOpts?.wordSpans as WordSpan[])[span].word;
          spec.wordId = span;
        }
      }

      // Dynamics follow the words: stressed syllables lean in, unstressed
      // back off — scaled by the dial, multiplied into any existing accent.
      const stressArr = expressionOpts?.stress;
      if (stressArr && a.syllableIndex !== null && stressArr[a.syllableIndex] !== undefined) {
        const mult = stressArr[a.syllableIndex] >= 1 ? 1 + 0.15 * r : 1 - 0.06 * r;
        spec.gain = (spec.gain ?? 1) * mult;
      }
    }

    // Melisma runs carry their folded pitch sequence regardless of realism —
    // they are composition, not humanization.
    const pitches = (a.note as { pitches?: Array<{ midi: number; beats: number }> }).pitches;
    if (pitches && pitches.length > 1 && !isInhale) {
      spec.pitches = pitches.map((p) => ({ midi: p.midi, durSec: beatsToSeconds(p.beats, bpm) }));
    }

    specs.push(spec);
  }

  const request: VocalLineRequest = {
    syllables: specs,
    // A tail beyond the last note so a long final vowel is not clipped.
    durationSec: beatsToSeconds(totalBeats, bpm) + 0.5,
  };
  if (ttsVoice) request.ttsVoice = ttsVoice;
  if (pack && (pack.humanizePitchCents > 0 || pack.humanizeTimingMs > 0)) {
    request.humanize = {
      seed: expressionOpts?.laneSeed ?? voiceIndex + 1,
      pitchCents: pack.humanizePitchCents * r,
      timingMs: pack.humanizeTimingMs * r,
      vibratoJitter: r,
    };
  }
  return request;
}

/** Notes belonging to one voice, ordered, as the assignment layer expects. */
export function orderedNotes(notes: PluginMidiNote[]): PluginMidiNote[] {
  return [...notes].sort((a, b) => a.startBeat - b.startBeat);
}
