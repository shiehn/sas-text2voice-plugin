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

export const HARMONY_STYLES = [
  'unison',
  'choral',
  'organum',
  'drone',
  'counterpoint',
  'cluster',
] as const;
export type HarmonyStyle = (typeof HARMONY_STYLES)[number];

export const DELIVERY_MODES = ['unison', 'canon', 'hocket'] as const;
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
        // One sustained note for the whole phrase: tonic, then fifth, then
        // tonic an octave down, alternating outward.
        const degree = v % 2 === 1 ? 0 : 7;
        const octave = -12 * Math.floor((v - 1) / 2);
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
  note: PluginMidiNote;
}

/**
 * Deal `syllableCount` syllables onto each voice's notes according to the
 * delivery mode. Every voice keeps its own notes; only WHICH syllable (if any)
 * lands on each note changes.
 *
 * `canon` offsets each voice's reading position so the same sentence overlaps
 * itself; `hocket` gives each consecutive syllable to a different voice and
 * rests the others.
 */
export function assignSyllables(
  voices: PluginMidiNote[][],
  syllableCount: number,
  delivery: DeliveryMode,
  canonOffsetSyllables = 2,
): VoiceSyllableAssignment[][] {
  return voices.map((notes, voiceIndex) =>
    notes.map((note, noteIndex) => {
      let syllableIndex: number | null;
      switch (delivery) {
        case 'canon': {
          const shifted = noteIndex - voiceIndex * canonOffsetSyllables;
          syllableIndex = shifted >= 0 && shifted < syllableCount ? shifted : null;
          break;
        }
        case 'hocket':
          syllableIndex =
            noteIndex % voices.length === voiceIndex && noteIndex < syllableCount
              ? noteIndex
              : null;
          break;
        case 'unison':
        default:
          syllableIndex = noteIndex < syllableCount ? noteIndex : null;
          break;
      }
      return { syllableIndex, note };
    }),
  );
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
