/**
 * The three intent axes the panel exposes, as pure data + pure transforms.
 *
 *   HARMONY   how the voices relate in PITCH
 *   DELIVERY  how the TEXT is spread across them
 *   CHARACTER what each voice sounds like (WORLD parameters)
 *
 * Harmony splits into two families, which is what keeps generation cheap:
 * `unison`, `organum` and `drone` are DERIVED mechanically from the lead line,
 * so they cost no extra model work and are perfectly deterministic; only
 * `choral`, `counterpoint` and `cluster` need the model to compose several
 * lines at once.
 */

import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';
import { shiftSlotsWrapped } from './distribute';
import type { PhraseSpan } from './phrases';
import type { WordSpan } from './syllables';

export const HARMONY_STYLES = [
  'unison',
  'choral',
  'organum',
  'drone',
  'counterpoint',
  'cluster',
] as const;
export type HarmonyStyle = (typeof HARMONY_STYLES)[number];

export const DELIVERY_MODES = ['unison', 'canon', 'hocket', 'tagteam'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const CHARACTERS = ['natural', 'choir', 'ghost', 'machine', 'menagerie'] as const;
export type Character = (typeof CHARACTERS)[number];

export const MIN_VOICES = 1;
export const MAX_VOICES = 6;

export const DEFAULT_HARMONY: HarmonyStyle = 'choral';
export const DEFAULT_DELIVERY: DeliveryMode = 'unison';
export const DEFAULT_CHARACTER: Character = 'choir';
export const DEFAULT_VOICE_COUNT = 3;

/** Styles the model composes voice-by-voice; the rest are derived from the lead. */
const COMPOSED: ReadonlySet<HarmonyStyle> = new Set<HarmonyStyle>([
  'choral',
  'counterpoint',
  'cluster',
]);

export function isComposedHarmony(style: HarmonyStyle): boolean {
  return COMPOSED.has(style);
}

export const HARMONY_DESCRIPTIONS: Record<HarmonyStyle, string> = {
  unison: 'Every voice on the same line, spread across octaves — one enormous voice.',
  choral: 'Block harmony: all voices move together on the same syllables, like a chorale.',
  organum: 'Parallel fifths and octaves under the lead — medieval, hollow, deliberately archaic.',
  drone: 'The lead carries the text over voices sustaining the tonic and fifth underneath.',
  counterpoint: 'Independent lines with their own contours — words drift apart as the harmony holds.',
  cluster: 'Voices stacked in tight seconds — harmonically unstable by design.',
};

export const DELIVERY_DESCRIPTIONS: Record<DeliveryMode, string> = {
  unison: 'Every voice speaks the same words at the same moment. Most intelligible.',
  canon: 'Voices enter one after another on the same text, overlapping themselves.',
  hocket: 'Consecutive syllables bounce between voices — one line split across mouths.',
  tagteam: 'The lead carries the line; the whole crew shouts the last word of every phrase.',
};

// ---------------------------------------------------------------------------
// Character → WORLD parameters
// ---------------------------------------------------------------------------

export interface VoiceCharacterParams {
  /** Spectral-envelope warp: >1 shrinks the apparent head, <1 enlarges it. */
  formantWarp: number;
  /** 0..1, lerps aperiodicity toward fully noisy. */
  breath: number;
  /** Semitones of seeded F0 random-walk. */
  jitter: number;
}

/**
 * Per-voice parameters for a character. Several characters deliberately SPREAD
 * across the voice count rather than applying one setting to all of them —
 * `choir` fans the formant warp from large-headed to small so a single melody
 * is sung by bodies of different sizes, which is the effect that made the
 * prototype worth building.
 */
export function characterFor(
  character: Character,
  voiceIndex: number,
  voiceCount: number,
): VoiceCharacterParams {
  // 0 → 1 across the voices; a single voice sits in the middle of the fan.
  const t = voiceCount <= 1 ? 0.5 : voiceIndex / (voiceCount - 1);
  switch (character) {
    case 'natural':
      return { formantWarp: 1.0, breath: 0.0, jitter: 0.0 };
    case 'choir':
      // 0.80 (ogre) → 1.30 (child), a smooth fan across the section.
      return { formantWarp: 0.8 + t * 0.5, breath: 0.3 - t * 0.25, jitter: 0.0 };
    case 'ghost':
      return { formantWarp: 0.92 + t * 0.16, breath: 0.45 + t * 0.2, jitter: 0.4 + t * 0.4 };
    case 'machine':
      return { formantWarp: 1.0 - t * 0.12, breath: 0.0, jitter: 0.0 };
    case 'menagerie':
      // The widest legal fan: cavernous through insectile.
      return { formantWarp: 0.6 + t * 0.9, breath: 0.1 + t * 0.15, jitter: t * 0.5 };
    default:
      return { formantWarp: 1.0, breath: 0.0, jitter: 0.0 };
  }
}

// ---------------------------------------------------------------------------
// Derived harmony
// ---------------------------------------------------------------------------

/** Lowest and highest MIDI note a rendered voice may occupy. */
const PITCH_FLOOR = 36;
const PITCH_CEIL = 84;

function clampPitch(p: number): number {
  let v = p;
  while (v < PITCH_FLOOR) v += 12;
  while (v > PITCH_CEIL) v -= 12;
  return v;
}

/**
 * Build voices 1..n-1 from the lead for the mechanical harmony styles.
 * Returns one note array per voice INCLUDING the lead at index 0.
 *
 * `tonicPc` is the scene key's pitch class, used only by `drone` (the sustained
 * voices need a key centre, not a transposition of the melody).
 */
export function deriveHarmonyVoices(
  lead: PluginMidiNote[],
  style: HarmonyStyle,
  voiceCount: number,
  tonicPc: number,
  totalBeats: number,
): PluginMidiNote[][] {
  const voices: PluginMidiNote[][] = [lead];
  if (voiceCount <= 1 || lead.length === 0) return voices;

  for (let v = 1; v < voiceCount; v++) {
    switch (style) {
      case 'unison': {
        // Octave stack downward; the ear fuses these into one voice.
        const shift = -12 * v;
        voices.push(lead.map((n) => ({ ...n, pitch: clampPitch(n.pitch + shift) })));
        break;
      }
      case 'organum': {
        // Strict parallel motion — a fifth, then an octave, then both again.
        // Chromatic by nature; that hollow parallelism IS the style.
        const intervals = [-7, -12, -19, -24, -31];
        const shift = intervals[(v - 1) % intervals.length];
        voices.push(lead.map((n) => ({ ...n, pitch: clampPitch(n.pitch + shift) })));
        break;
      }
      case 'drone': {
        // One sustained note for the whole phrase. Tonic and fifth first, then
        // the octave BELOW, then the octave ABOVE — never further down, because
        // the low clamp used to fold voices 5/6 back onto 3/4 and render two
        // lanes byte-identical.
        const degree = v % 2 === 1 ? 0 : 7;
        const octave = [0, 0, -12, -12, 12, 12][Math.min(v - 1, 5)];
        const base = clampPitch(48 + tonicPc + degree + octave);
        voices.push([
          {
            pitch: base,
            startBeat: 0,
            durationBeats: Math.max(1, totalBeats),
            velocity: 70,
          },
        ]);
        break;
      }
      default:
        // A composed style reached the derived path (no model output for this
        // voice): fall back to a unison octave rather than dropping the voice.
        voices.push(lead.map((n) => ({ ...n, pitch: clampPitch(n.pitch - 12 * v) })));
        break;
    }
  }
  return voices;
}

// ---------------------------------------------------------------------------
// Delivery — how syllables are dealt out to the voices
// ---------------------------------------------------------------------------

export interface VoiceSyllableAssignment {
  /** Index into the phrase's syllable array, or null for a rest. */
  syllableIndex: number | null;
  /**
   * The note to sing it on, or null when this voice is silent at this slot.
   * Every voice shares the LEAD's syllable timeline (see `alignVoiceToSlots`),
   * so the arrays stay index-aligned even where a voice drops out.
   */
  note: PluginMidiNote | null;
}

/**
 * Deal syllables onto each voice's slots according to the delivery mode.
 *
 * Slot index maps to syllable `index % syllableCount` — the text LOOPS when
 * the melody holds more slots than the phrase has syllables, so every note
 * sounds (a mantra) instead of the tail falling silent.
 *
 * `canon` delays each voice's WHOLE line — pitch and text together — by
 * `canonOffsetBeats` per voice, wrapping at the scene boundary so the round
 * survives the loop seam. `hocket` deals each slot to exactly one voice,
 * rotating among the voices actually SOUNDING there (a resting voice never
 * swallows a word; the lead is always a sounding fallback).
 */
export interface AssignOptions {
  /** Beats each successive canon voice enters late. */
  canonOffsetBeats?: number;
  /** Scene length in quarter-note beats — required for canon's wrap. */
  sceneBeats?: number;
  /** Phrase structure of the lead line — required for tagteam. */
  phrases?: PhraseSpan[];
  /** Word boundaries in the syllable split — required for tagteam. */
  wordSpans?: WordSpan[];
  /**
   * Per-voice: does this lane join the shouts? (Derived from lane roles by
   * the caller — passed as booleans so this module needs no role import.)
   * Index 0 is ignored: the lead always carries the full line.
   */
  shoutLanes?: boolean[];
}

export function assignSyllables(
  voices: Array<Array<PluginMidiNote | null>>,
  syllableCount: number,
  delivery: DeliveryMode,
  opts: AssignOptions = {},
): VoiceSyllableAssignment[][] {
  if (syllableCount <= 0) return voices.map(() => []);
  const sylAt = (slotIndex: number): number => slotIndex % syllableCount;

  if (delivery === 'canon') {
    const offset = opts.canonOffsetBeats ?? 2;
    const sceneBeats = opts.sceneBeats ?? 0;
    return voices.map((notes, voiceIndex) => {
      if (voiceIndex === 0 || sceneBeats <= 0) {
        return notes.map((note, i) => ({ syllableIndex: note ? sylAt(i) : null, note }));
      }
      // Delay the voice's own (pitch, syllable) line as a unit.
      const shifted = shiftSlotsWrapped(notes, voiceIndex * offset, sceneBeats);
      return shifted.map(({ note, sourceIndex }) => ({
        syllableIndex: sylAt(sourceIndex),
        note,
      }));
    });
  }

  if (delivery === 'hocket') {
    // Precompute, per slot, which voices are sounding — the rotation must only
    // ever land on one of them or the syllable is sung by nobody.
    const slotCount = voices[0]?.length ?? 0;
    const winner: number[] = [];
    for (let i = 0; i < slotCount; i++) {
      const sounding = voices
        .map((notes, v) => (notes[i] ? v : -1))
        .filter((v) => v >= 0);
      winner.push(sounding.length === 0 ? -1 : sounding[i % sounding.length]);
    }
    return voices.map((notes, voiceIndex) =>
      notes.map((note, i) => ({
        syllableIndex: winner[i] === voiceIndex && note ? sylAt(i) : null,
        note,
      })),
    );
  }

  if (delivery === 'tagteam') {
    // "Put your left leg... DOWN": the lead carries every line; the crew
    // punches each phrase's final WORD in unison. Only composed 'rest'
    // phrases take a shout — a carved catch-breath is not a phrase end.
    const phrases = (opts.phrases ?? []).filter((p) => p.boundary === 'rest');
    const wordSpans = opts.wordSpans ?? [];
    const shoutSlots = new Set<number>();
    for (const phrase of phrases) {
      const lastSyl = sylAt(phrase.endSlot - 1);
      const span = wordSpans.find((w) => lastSyl >= w.startSyl && lastSyl < w.endSyl);
      if (!span) continue;
      // Every slot of the phrase whose syllable belongs to the final word —
      // clamped to at most half the phrase so a two-slot line is not all shout.
      const candidates: number[] = [];
      for (let i = phrase.startSlot; i < phrase.endSlot; i++) {
        const syl = sylAt(i);
        if (syl >= span.startSyl && syl < span.endSyl) candidates.push(i);
      }
      const maxShout = Math.max(1, Math.floor((phrase.endSlot - phrase.startSlot) / 2));
      for (const i of candidates.slice(-maxShout)) shoutSlots.add(i);
    }
    return voices.map((notes, voiceIndex) => {
      if (voiceIndex === 0) {
        return notes.map((note, i) => ({ syllableIndex: note ? sylAt(i) : null, note }));
      }
      const shouts = opts.shoutLanes?.[voiceIndex] !== false;
      return notes.map((note, i) => {
        if (!shouts || !shoutSlots.has(i)) return { syllableIndex: null, note };
        // A resting crew member still shouts — on the lead's note.
        const sung = note ?? voices[0][i];
        return { syllableIndex: sung ? sylAt(i) : null, note: sung };
      });
    });
  }

    // unison
  return voices.map((notes) =>
    notes.map((note, i) => ({ syllableIndex: note ? sylAt(i) : null, note })),
  );
}

/**
 * A sustain lane: ONE syllable held across the voice's one long note — how a
 * drone renders. Bypasses the slot grid entirely: aligning a pedal tone to the
 * lead's slots would chop it into per-syllable re-attacks (a chant), which is
 * exactly the regression this exists to prevent.
 */
export function sustainAssignments(
  notes: PluginMidiNote[],
  syllableIndex: number,
): VoiceSyllableAssignment[] {
  return notes.map((note) => ({ syllableIndex, note }));
}

// ---------------------------------------------------------------------------
// Normalisers — stored config is untrusted (older scenes, hand-edited data)
// ---------------------------------------------------------------------------

export function normalizeHarmony(v: unknown): HarmonyStyle {
  return HARMONY_STYLES.includes(v as HarmonyStyle) ? (v as HarmonyStyle) : DEFAULT_HARMONY;
}

export function normalizeDelivery(v: unknown): DeliveryMode {
  return DELIVERY_MODES.includes(v as DeliveryMode) ? (v as DeliveryMode) : DEFAULT_DELIVERY;
}

export function normalizeCharacter(v: unknown): Character {
  return CHARACTERS.includes(v as Character) ? (v as Character) : DEFAULT_CHARACTER;
}

export function normalizeVoiceCount(v: unknown): number {
  const n = typeof v === 'number' ? Math.round(v) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_VOICE_COUNT;
  return Math.max(MIN_VOICES, Math.min(MAX_VOICES, n));
}
