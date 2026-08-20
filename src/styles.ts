/**
 * Styles — named presets over the intent axes, plus the mechanics only a
 * style can express (lane roles, per-role mix, prompt packs).
 *
 * A style is a PRESET, not a mode: picking one writes all its axes in ONE
 * config persist (per-axis writes open a window where a generate reads a
 * half-applied style and composes a Franken-melody), and every axis stays
 * individually overridable afterwards — the panel then shows "Custom". The
 * planner never reads `style` itself; it reads the concrete axes, so applying
 * a style costs exactly what its axis changes cost and nothing more.
 *
 * Lane ROLES are derived, never stored: `laneRolesFor` is a pure function of
 * (style, harmony, voiceCount), evaluated fresh inside every generate. The
 * reconcile planner is positional, so derived roles re-map automatically when
 * the voice count changes — and mix settings (pan/volume) are re-applied for
 * EVERY lane EVERY run, because a reused track that was an adlib lane last
 * run would otherwise keep its wide pan into its new life as a chorister.
 */

import type { Character, DeliveryMode, HarmonyStyle } from './harmony-styles';

export type LaneRole = 'lead' | 'group' | 'adlib' | 'drone';

export const STYLE_IDS = ['choir', 'ballad', 'chant', 'tagteam', 'trap', 'sprechgesang'] as const;
export type StyleId = (typeof STYLE_IDS)[number];

/**
 * How a style's voices BEHAVE within their notes — the expression engine
 * (vox spec v3). Every value here is the style's amount AT FULL REALISM; the
 * user's realism dial (0..1) scales the whole pack, and 0 renders the exact
 * pre-expression output. Applied per assignment in `buildVocalLineRequest`
 * (phrase entries scoop, sustained notes get vibrato, phrase finals fall and
 * aspirate, adjacent notes glide), so the pack describes capability, not
 * placement.
 */
export interface ExpressionPack {
  /** Pitch approach time-constant (ms). Tiny = autotune; ~80 = a singer. */
  retuneMs: number;
  /** Phrase-entry approach from below, in cents. */
  scoopCents: number;
  /** null = no vibrato for this style. */
  vibrato: { rateHz: number; depthCents: number; onsetMs: number; ampDepth: number } | null;
  /** Slow intonation wander, cents. */
  driftCents: number;
  /** Lane decorrelation at full realism (different seed per lane). */
  humanizePitchCents: number;
  humanizeTimingMs: number;
  /** Phrase-final breathiness target (aspirated releases). */
  breathTail: number;
  /** 'nucleus' puts vowels on the grid — on for everything sung. */
  align: 'start' | 'nucleus';
  /** Trained-singer resonance amount at full realism (0..1). */
  singersFormant: number;
  /** Spectral brightness tilt at full realism (-1..1). */
  tilt: number;
  /** Override the treatment's timeMode ('vowel' = smarter deep compression). */
  timeMode?: 'fill' | 'natural' | 'vowel';
}

/** The realism dial's default — expressive, with the surreal one drag away. */
export const DEFAULT_REALISM = 0.6;

/** Styleless configs still deserve a voice that behaves like one. */
export const DEFAULT_EXPRESSION: ExpressionPack = {
  retuneMs: 50,
  scoopCents: 30,
  vibrato: { rateHz: 5.2, depthCents: 30, onsetMs: 400, ampDepth: 0.1 },
  driftCents: 6,
  humanizePitchCents: 8,
  humanizeTimingMs: 8,
  breathTail: 0.15,
  singersFormant: 0.25,
  tilt: 0.0,
  align: 'nucleus',
  timeMode: 'vowel',
};

/** How this style's voices are pitched and timed by the renderer. */
export interface VoxTreatment {
  pitchMode: 'lock' | 'natural' | 'contour';
  /** contour only: 0 = sung lock, 1 = full speech contour. */
  contourDepth: number;
  timeMode: 'fill' | 'natural';
}

/**
 * Where a style's voices LIVE. Register is what separates rap from chipmunk:
 * contour mode recenters the speech on the target note, so the target's
 * register decides the whole character. `top` is the LEAD's centre; voices
 * spread downward across `spanSemitones` (clamped to the renderer's safe
 * rails). Cached melodies are octave-normalized into the active style's
 * register at render time, so flipping styles stays free AND lands in range.
 */
export interface StyleRegister {
  top: number;
  spanSemitones: number;
}

/** Note-length range (beats) the composer is steered toward. */
export interface RhythmRange {
  minBeats: number;
  maxBeats: number;
}

export const DEFAULT_REGISTER: StyleRegister = { top: 67, spanSemitones: 24 };
export const DEFAULT_RHYTHM_RANGE: RhythmRange = { minBeats: 0.5, maxBeats: 4 };

export interface StylePreset {
  id: StyleId;
  label: string;
  /** One-line hint shown in the picker. */
  hint: string;
  harmony: HarmonyStyle;
  delivery: DeliveryMode;
  character: Character;
  /** Notes per beat: 1 quarters, 2 eighths, 3 triplets, 4 sixteenths. */
  notesPerBeat: number;
  /** Whether the LAST lane is a hype-man echoing phrase-final words. */
  adlibLane: boolean;
  /** Pitch/time treatment for every lane (host >= 3.5.0; older hosts lock). */
  treatment: VoxTreatment;
  /** Lead centre + downward spread — see StyleRegister. */
  register: StyleRegister;
  /** Note lengths the composer is steered toward. */
  rhythmRange: RhythmRange;
  /** Breathy styles get audible inhales at phrase starts. */
  audibleInhales: boolean;
  /** Extra system-prompt lines composed under this style. */
  promptPack: string[];
  /** In-note behavior (scoops, vibrato, glides) — see ExpressionPack. */
  expression: ExpressionPack;
}

/** The default (and pre-style) treatment: fully sung. */
export const SUNG_TREATMENT: VoxTreatment = { pitchMode: 'lock', contourDepth: 1, timeMode: 'fill' };

export const STYLES: Record<StyleId, StylePreset> = {
  choir: {
    id: 'choir',
    label: 'Choir',
    hint: 'block harmony, bodies of different sizes',
    harmony: 'choral',
    delivery: 'unison',
    character: 'choir',
    notesPerBeat: 2,
    adlibLane: false,
    treatment: SUNG_TREATMENT,
    register: DEFAULT_REGISTER,
    rhythmRange: DEFAULT_RHYTHM_RANGE,
    audibleInhales: false,
    promptPack: [],
    expression: {
      retuneMs: 90,
      scoopCents: 40,
      vibrato: { rateHz: 4.8, depthCents: 35, onsetMs: 500, ampDepth: 0.1 },
      driftCents: 8,
      humanizePitchCents: 14,
      humanizeTimingMs: 18,
      breathTail: 0.25,
      singersFormant: 0.3,
      tilt: 0.0,
      align: 'nucleus',
      timeMode: 'vowel',
    },
  },
  ballad: {
    id: 'ballad',
    label: 'Ballad',
    hint: 'one voice, long arcs, real vibrato',
    harmony: 'unison',
    delivery: 'unison',
    character: 'natural',
    notesPerBeat: 1,
    adlibLane: false,
    treatment: SUNG_TREATMENT,
    register: { top: 64, spanSemitones: 12 },
    rhythmRange: { minBeats: 1, maxBeats: 6 },
    audibleInhales: true,
    promptPack: [
      '## Style: ballad',
      '- Long lyrical phrases with room to breathe between them; sustained finals.',
      '- Melodic arcs that rise toward the middle of a phrase and settle at its end.',
      '- Mostly stepwise, with ONE expressive leap per phrase at the emotional word.',
    ],
    expression: {
      retuneMs: 80,
      scoopCents: 120,
      vibrato: { rateHz: 5.0, depthCents: 70, onsetMs: 450, ampDepth: 0.18 },
      driftCents: 10,
      humanizePitchCents: 10,
      humanizeTimingMs: 12,
      breathTail: 0.4,
      singersFormant: 0.5,
      tilt: 0.05,
      align: 'nucleus',
      timeMode: 'vowel',
    },
  },
  chant: {
    id: 'chant',
    label: 'Chant',
    hint: 'reciting tones over a drone',
    harmony: 'drone',
    delivery: 'unison',
    character: 'ghost',
    notesPerBeat: 1,
    adlibLane: false,
    treatment: { pitchMode: 'lock', contourDepth: 1, timeMode: 'fill' },
    register: { top: 60, spanSemitones: 14 },
    rhythmRange: { minBeats: 1, maxBeats: 8 },
    audibleInhales: true,
    promptPack: [
      '## Style: chant',
      '- Recite: hold ONE pitch through runs of text (long notes), moving only at cadences.',
      '- Keep the contour narrow — a third either way — and settle downward at every rest.',
    ],
    expression: {
      retuneMs: 120,
      scoopCents: 0,
      vibrato: null,
      driftCents: 12,
      humanizePitchCents: 10,
      humanizeTimingMs: 12,
      breathTail: 0.35,
      singersFormant: 0.15,
      tilt: -0.1,
      align: 'nucleus',
      timeMode: 'vowel',
    },
  },
  tagteam: {
    id: 'tagteam',
    label: 'Tag-Team Rap',
    hint: 'the crew shouts the last word of every line',
    harmony: 'unison',
    delivery: 'tagteam',
    character: 'machine',
    notesPerBeat: 2,
    adlibLane: false,
    treatment: { pitchMode: 'contour', contourDepth: 0.35, timeMode: 'natural' },
    register: { top: 52, spanSemitones: 7 },
    rhythmRange: { minBeats: 0.25, maxBeats: 2 },
    audibleInhales: false,
    promptPack: [
      '## Style: tag-team rap',
      '- Write PUNCHY lines: short phrases, hard rests between them, end-stopped.',
      '- The last word of every phrase is shouted by the whole crew — end phrases on',
      '  words that can take a punch: concrete nouns, hard consonant openings.',
      '- Favor end-rhyme between successive phrases when the text offers it.',
      '- Rhythm over melody: mostly one pitch per phrase with small drops at the ends.',
    ],
    expression: {
      retuneMs: 0,
      scoopCents: 0,
      vibrato: null,
      driftCents: 6,
      humanizePitchCents: 8,
      humanizeTimingMs: 14,
      breathTail: 0,
      singersFormant: 0.0,
      tilt: 0.1,
      align: 'nucleus',
    },
  },
  trap: {
    id: 'trap',
    label: 'Trap',
    hint: 'triplet flow, an adlib lane haunting the gaps',
    harmony: 'unison',
    delivery: 'unison',
    character: 'machine',
    notesPerBeat: 3,
    adlibLane: true,
    treatment: { pitchMode: 'contour', contourDepth: 0.5, timeMode: 'natural' },
    register: { top: 53, spanSemitones: 5 },
    rhythmRange: { minBeats: 0.25, maxBeats: 2 },
    audibleInhales: false,
    promptPack: [
      '## Style: trap',
      '- Triplet flow: rolling runs of short notes, then SPACE. Leave real gaps after',
      '  phrases — another voice answers in them.',
      '- Sparse pitch movement: two or three pitches, mostly repeated notes.',
      '- End phrases on a word worth echoing.',
    ],
    expression: {
      // The T-Pain dial: a tiny-but-audible retune IS the autotune sound.
      retuneMs: 6,
      scoopCents: 0,
      vibrato: null,
      driftCents: 0,
      humanizePitchCents: 4,
      humanizeTimingMs: 6,
      breathTail: 0,
      singersFormant: 0.0,
      tilt: 0.15,
      align: 'nucleus',
    },
  },
  sprechgesang: {
    id: 'sprechgesang',
    label: 'Sprechgesang',
    hint: 'strict rhythm, unmoored pitch',
    harmony: 'counterpoint',
    delivery: 'unison',
    character: 'ghost',
    notesPerBeat: 2,
    adlibLane: false,
    treatment: { pitchMode: 'contour', contourDepth: 0.85, timeMode: 'fill' },
    register: { top: 64, spanSemitones: 20 },
    rhythmRange: { minBeats: 0.5, maxBeats: 4 },
    audibleInhales: true,
    promptPack: [
      '## Style: Sprechgesang',
      '- Expressionist declamation: wide, angular intervals — the leaps ARE the point here,',
      '  inverting the usual stepwise rule.',
      '- Strict, deliberate rhythm; irregular phrase lengths; unsettling rests.',
    ],
    expression: {
      retuneMs: 40,
      scoopCents: 60,
      vibrato: { rateHz: 5.5, depthCents: 25, onsetMs: 400, ampDepth: 0.08 },
      driftCents: 20,
      humanizePitchCents: 16,
      humanizeTimingMs: 20,
      breathTail: 0.3,
      singersFormant: 0.2,
      tilt: 0.0,
      align: 'nucleus',
      timeMode: 'vowel',
    },
  },
};

export function isStyleId(v: unknown): v is StyleId {
  return typeof v === 'string' && (STYLE_IDS as readonly string[]).includes(v);
}

/** The concrete axes a style writes — ONE merged persist, never per-axis. */
export function styleAxes(id: StyleId): {
  harmony: HarmonyStyle;
  delivery: DeliveryMode;
  character: Character;
  notesPerBeat: number;
} {
  const s = STYLES[id];
  return {
    harmony: s.harmony,
    delivery: s.delivery,
    character: s.character,
    notesPerBeat: s.notesPerBeat,
  };
}

/**
 * Does the current config still match a style's axes? When not, the panel
 * shows "Custom" — the style is a fingerprint, not a lock.
 */
export function configMatchesStyle(
  id: StyleId,
  axes: { harmony: HarmonyStyle; delivery: DeliveryMode; character: Character; notesPerBeat: number },
): boolean {
  const s = STYLES[id];
  return (
    s.harmony === axes.harmony &&
    s.delivery === axes.delivery &&
    s.character === axes.character &&
    s.notesPerBeat === axes.notesPerBeat
  );
}

/** The expression pack for a style — DEFAULT_EXPRESSION when no style is set. */
export function expressionFor(styleId: StyleId | null): ExpressionPack {
  return styleId ? STYLES[styleId].expression : DEFAULT_EXPRESSION;
}

/**
 * Role per lane index — pure, derived fresh every generate, stored nowhere.
 *
 * Index 0 is always the lead. The adlib lane, when a style has one, is always
 * the LAST index, so shrinking the voice count sheds it first. Drone-harmony
 * lanes are 'drone' regardless of style. A single voice collapses to lead.
 */
export function laneRolesFor(
  styleId: StyleId | null,
  harmony: HarmonyStyle,
  laneCount: number,
): LaneRole[] {
  const roles: LaneRole[] = [];
  const adlib = styleId ? STYLES[styleId].adlibLane && laneCount >= 2 : false;
  for (let i = 0; i < laneCount; i++) {
    if (i === 0) {
      roles.push('lead');
    } else if (adlib && i === laneCount - 1) {
      roles.push('adlib');
    } else if (harmony === 'drone') {
      roles.push('drone');
    } else {
      roles.push('group');
    }
  }
  return roles;
}

/** Mix placement per role, applied to EVERY lane EVERY run (resets included). */
export interface LaneMix {
  volume: number;
  pan: number;
}

export function laneMixFor(role: LaneRole, laneIndex: number): LaneMix {
  switch (role) {
    case 'lead':
      return { volume: 1.0, pan: 0 };
    case 'adlib':
      // Wide and behind the lead — the hype man is a spatial event.
      return { volume: 0.55, pan: laneIndex % 2 === 0 ? 0.6 : -0.6 };
    case 'drone':
      return { volume: 0.75, pan: laneIndex % 2 === 0 ? 0.25 : -0.25 };
    case 'group':
    default:
      // Spread the crew across the field, lead stays center.
      return { volume: 0.85, pan: [0.35, -0.35, 0.55, -0.55, 0.2][laneIndex % 5] };
  }
}

/** Human-readable role for the voice-row label. */
export function roleLabel(role: LaneRole, index: number): string {
  switch (role) {
    case 'lead':
      return 'lead';
    case 'adlib':
      return 'adlib';
    case 'drone':
      return `drone ${index}`;
    case 'group':
    default:
      return `harmony ${index}`;
  }
}
