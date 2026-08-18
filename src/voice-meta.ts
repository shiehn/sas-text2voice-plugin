/**
 * Text2Voice voice-group metadata — the ensemble plugin's voice-group shape.
 * Membership is per-member scene-data under `track:<dbId>:text2voiceVoice`;
 * the anchor is voiceIndex 0 and holds the group's config (including the
 * source text) plus the cached composition.
 */

import type {
  GroupParseSpec,
  PluginHost,
  ResolvedTrackGroup,
  GeneratorTrackState,
  PluginMidiNote,
} from '@signalsandsorcery/plugin-sdk';
import {
  normalizeCharacter,
  normalizeDelivery,
  normalizeHarmony,
  normalizeVoiceCount,
  type Character,
  type DeliveryMode,
  type HarmonyStyle,
} from './harmony-styles';

export const TEXT2VOICE_VOICE_META_KEY = 'text2voiceVoice';
/** Anchor-held config: the source text plus the three intent axes. */
export const TEXT2VOICE_CONFIG_KEY = 'text2voiceConfig';
/** Anchor-held cache of the composed music (the expensive artifact). */
export const TEXT2VOICE_MELODY_KEY = 'text2voiceMelody';
/** Anchor-held cache of the words currently sitting on that music. */
export const TEXT2VOICE_WORDS_KEY = 'text2voiceWords';

/** Guards a pathological paste; scenes hold at most a page or so of prose. */
export const MAX_TEXT_LENGTH = 20000;

export interface Text2VoiceMeta {
  /** dbId of the anchor (voice 0). */
  groupId: string;
  /** 0 = lead voice; increases downward. */
  voiceIndex: number;
  /** Label shown in the voice row ("lead", "harmony 2"). */
  label: string;
  /** System speech voice this lane speaks with, when pinned. */
  ttsVoice?: string;
}

export function asText2VoiceMeta(val: unknown): Text2VoiceMeta | null {
  if (!val || typeof val !== 'object') return null;
  const m = val as Partial<Text2VoiceMeta>;
  if (typeof m.groupId !== 'string' || typeof m.voiceIndex !== 'number') return null;
  const meta: Text2VoiceMeta = {
    groupId: m.groupId,
    voiceIndex: m.voiceIndex,
    label: typeof m.label === 'string' ? m.label : '',
  };
  if (typeof m.ttsVoice === 'string') meta.ttsVoice = m.ttsVoice;
  return meta;
}

export const text2voiceGroupSpec: GroupParseSpec<Text2VoiceMeta> = {
  metaKey: TEXT2VOICE_VOICE_META_KEY,
  asMeta: asText2VoiceMeta,
  groupIdOf: (m) => m.groupId,
  sortMembers: (a, b) => a.meta.voiceIndex - b.meta.voiceIndex,
};

export function text2voiceGroupIsComplete(
  group: ResolvedTrackGroup<Text2VoiceMeta, GeneratorTrackState>,
): boolean {
  return group.members.some((m) => m.meta.voiceIndex === 0);
}

/**
 * Stamp a NEWBORN track as a voice-group of ONE so the header — with the text
 * area and the harmony/delivery/character controls — exists BEFORE the first
 * generation. Configure first, generate once: the ensemble/arp pattern.
 */
export async function stampText2VoiceAnchor(
  host: Pick<PluginHost, 'setSceneData'>,
  sceneId: string,
  keyFor: (dbId: string, suffix: string) => string,
  dbId: string,
): Promise<void> {
  const meta: Text2VoiceMeta = { groupId: dbId, voiceIndex: 0, label: 'lead' };
  await host.setSceneData(sceneId, keyFor(dbId, TEXT2VOICE_VOICE_META_KEY), meta);
}

// --- anchor-held config ---

export interface Text2VoiceConfig {
  /** The prose the user pasted. The model quotes a phrase from this. */
  text: string;
  harmony: HarmonyStyle;
  delivery: DeliveryMode;
  character: Character;
  voiceCount: number;
  /** Notes per quarter-note beat: 1 = quarters, 2 = eighths, 4 = sixteenths. */
  notesPerBeat: number;
  /** System speech voice for the group; per-lane pins override it. */
  ttsVoice?: string;
  /**
   * Set by the panel's "New melody" action and cleared by the next generate.
   * A transient request, not a preference — it lives here only because the
   * core's generate handler takes a track id and carries no payload.
   */
  forceMelody?: boolean;
}

export function asText2VoiceConfig(val: unknown): Text2VoiceConfig | null {
  if (!val || typeof val !== 'object') return null;
  const c = val as Partial<Text2VoiceConfig>;
  const config: Text2VoiceConfig = {
    text: typeof c.text === 'string' ? c.text.slice(0, MAX_TEXT_LENGTH) : '',
    harmony: normalizeHarmony(c.harmony),
    delivery: normalizeDelivery(c.delivery),
    character: normalizeCharacter(c.character),
    voiceCount: normalizeVoiceCount(c.voiceCount),
    notesPerBeat: c.notesPerBeat === 1 || c.notesPerBeat === 2 || c.notesPerBeat === 4 ? c.notesPerBeat : 2,
  };
  if (typeof c.ttsVoice === 'string') config.ttsVoice = c.ttsVoice;
  if (c.forceMelody === true) config.forceMelody = true;
  return config;
}

// --- anchor-held caches: MELODY and WORDS are stored SEPARATELY ---------
//
// Composing the music is the expensive step, so it is cached independently of
// the words sitting on it. Replacing the text therefore keeps the melody and
// costs only a small phrase-selection call; changing the character or speech
// voice costs nothing at all. Only the settings that genuinely define the notes
// — harmony, delivery, voice count, tempo and length — throw the melody away.

export interface Text2VoiceMelody {
  /** One note array per voice, index 0 = lead. */
  voices: PluginMidiNote[][];
  /** Syllable slots the lead provides — the exact length a phrase must fit. */
  slotCount: number;
  bpm: number;
  bars: number;
  harmony: HarmonyStyle;
  delivery: DeliveryMode;
}

export interface Text2VoiceWords {
  /** The phrase quoted out of the source text. */
  phrase: string;
  /** Its syllable split, in order. */
  syllables: string[];
}

export function asText2VoiceMelody(val: unknown): Text2VoiceMelody | null {
  if (!val || typeof val !== 'object') return null;
  const m = val as Partial<Text2VoiceMelody>;
  if (!Array.isArray(m.voices) || !m.voices.every((v) => Array.isArray(v))) return null;
  if (m.voices.length === 0) return null;
  return {
    voices: m.voices as PluginMidiNote[][],
    slotCount: typeof m.slotCount === 'number' ? m.slotCount : (m.voices[0]?.length ?? 0),
    bpm: typeof m.bpm === 'number' ? m.bpm : 120,
    bars: typeof m.bars === 'number' ? m.bars : 4,
    harmony: normalizeHarmony(m.harmony),
    delivery: normalizeDelivery(m.delivery),
  };
}

export function asText2VoiceWords(val: unknown): Text2VoiceWords | null {
  if (!val || typeof val !== 'object') return null;
  const w = val as Partial<Text2VoiceWords>;
  if (typeof w.phrase !== 'string' || !Array.isArray(w.syllables)) return null;
  const syllables = w.syllables.filter((s): s is string => typeof s === 'string');
  if (syllables.length === 0) return null;
  return { phrase: w.phrase, syllables };
}

/**
 * Whether a cached melody still describes the current settings.
 *
 * Deliberately NOT sensitive to the source text, the character or the speech
 * voice — those are what the user is expected to churn, and keeping the melody
 * across them is the whole point of splitting the caches.
 */
export function melodyIsReusable(
  melody: Text2VoiceMelody | null,
  config: Text2VoiceConfig,
  bpm: number,
  bars: number,
): boolean {
  if (!melody) return false;
  if (melody.harmony !== config.harmony) return false;
  if (melody.delivery !== config.delivery) return false;
  if (melody.voices.length !== config.voiceCount) return false;
  if (melody.bars !== bars) return false;
  if (Math.abs(melody.bpm - bpm) > 0.01) return false;
  return melody.slotCount > 0;
}

/** What a generate run actually has to do. */
export type GenerationMode = 'compose' | 'reword' | 'render';

/**
 * Decide the cheapest sufficient action.
 *
 *   compose  melody + words     (one full model call)
 *   reword   words only         (one small phrase-selection call, melody kept)
 *   render   neither            (no model call at all)
 */
export function planGeneration(params: {
  melody: Text2VoiceMelody | null;
  words: Text2VoiceWords | null;
  config: Text2VoiceConfig;
  bpm: number;
  bars: number;
  /** The phrase still occurs in the current source text. */
  wordsStillInSource: boolean;
  /** User explicitly asked for a new melody. */
  forceMelody?: boolean;
}): GenerationMode {
  const { melody, words, config, bpm, bars, wordsStillInSource, forceMelody } = params;
  if (forceMelody) return 'compose';
  if (!melodyIsReusable(melody, config, bpm, bars)) return 'compose';
  if (!words || !wordsStillInSource) return 'reword';
  return 'render';
}

// --- reconcile planner (positional, the ensemble shape) ---

export interface ReconcileMember {
  dbId: string;
  engineId: string;
  voiceIndex: number;
}

export interface ReconcilePlan {
  reuse: Array<{ dbId: string; engineId: string; bucketIndex: number }>;
  createBucketIndexes: number[];
  remove: Array<{ dbId: string; engineId: string }>;
}

/**
 * Pair existing members with the new voice list positionally: index 0 (the
 * anchor) is always reused so the groupId and the config key never move.
 */
export function planReconcile(existing: ReconcileMember[], bucketCount: number): ReconcilePlan {
  const sorted = [...existing].sort((a, b) => a.voiceIndex - b.voiceIndex);
  const reuse: ReconcilePlan['reuse'] = [];
  const createBucketIndexes: number[] = [];
  const remove: ReconcilePlan['remove'] = [];
  for (let i = 0; i < bucketCount; i++) {
    const member = sorted[i];
    if (member) reuse.push({ dbId: member.dbId, engineId: member.engineId, bucketIndex: i });
    else createBucketIndexes.push(i);
  }
  for (let i = bucketCount; i < sorted.length; i++) {
    remove.push({ dbId: sorted[i].dbId, engineId: sorted[i].engineId });
  }
  return { reuse, createBucketIndexes, remove };
}
