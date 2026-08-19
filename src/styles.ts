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

export const STYLE_IDS = ['choir', 'chant', 'tagteam', 'trap', 'sprechgesang'] as const;
export type StyleId = (typeof STYLE_IDS)[number];

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
  /** Extra system-prompt lines composed under this style. */
  promptPack: string[];
}

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
    promptPack: [],
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
    promptPack: [
      '## Style: chant',
      '- Recite: hold ONE pitch through runs of text (long notes), moving only at cadences.',
      '- Keep the contour narrow — a third either way — and settle downward at every rest.',
    ],
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
    promptPack: [
      '## Style: tag-team rap',
      '- Write PUNCHY lines: short phrases, hard rests between them, end-stopped.',
      '- The last word of every phrase is shouted by the whole crew — end phrases on',
      '  words that can take a punch: concrete nouns, hard consonant openings.',
      '- Favor end-rhyme between successive phrases when the text offers it.',
      '- Rhythm over melody: mostly one pitch per phrase with small drops at the ends.',
    ],
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
    promptPack: [
      '## Style: trap',
      '- Triplet flow: rolling runs of short notes, then SPACE. Leave real gaps after',
      '  phrases — another voice answers in them.',
      '- Sparse pitch movement: two or three pitches, mostly repeated notes.',
      '- End phrases on a word worth echoing.',
    ],
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
    promptPack: [
      '## Style: Sprechgesang',
      '- Expressionist declamation: wide, angular intervals — the leaps ARE the point here,',
      '  inverting the usual stepwise rule.',
      '- Strict, deliberate rhythm; irregular phrase lengths; unsettling rests.',
    ],
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
