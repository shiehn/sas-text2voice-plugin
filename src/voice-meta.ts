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
/**
 * Anchor-held cache of the last composition. Re-rendering with a different
 * character or system voice replays this instead of calling the model again —
 * only editing the TEXT requires a new composition.
 */
export const TEXT2VOICE_COMPOSITION_KEY = 'text2voiceComposition';

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
  return config;
}

// --- anchor-held composition cache ---

export interface Text2VoiceComposition {
  /** The phrase the model quoted out of the source text. */
  phrase: string;
  /** Its syllable split, in order. */
  syllables: string[];
  /** One note array per voice, index 0 = lead. */
  voices: PluginMidiNote[][];
  /** Scene BPM the composition was written against. */
  bpm: number;
  /** Scene bar count it was written for. */
  bars: number;
  /** Harmony style it was composed under (a change invalidates the cache). */
  harmony: HarmonyStyle;
  /** Delivery it was composed under. */
  delivery: DeliveryMode;
}

export function asText2VoiceComposition(val: unknown): Text2VoiceComposition | null {
  if (!val || typeof val !== 'object') return null;
  const c = val as Partial<Text2VoiceComposition>;
  if (typeof c.phrase !== 'string' || !Array.isArray(c.syllables) || !Array.isArray(c.voices)) {
    return null;
  }
  if (!c.voices.every((v) => Array.isArray(v))) return null;
  return {
    phrase: c.phrase,
    syllables: c.syllables.filter((s): s is string => typeof s === 'string'),
    voices: c.voices as PluginMidiNote[][],
    bpm: typeof c.bpm === 'number' ? c.bpm : 120,
    bars: typeof c.bars === 'number' ? c.bars : 4,
    harmony: normalizeHarmony(c.harmony),
    delivery: normalizeDelivery(c.delivery),
  };
}

/**
 * Whether a cached composition can be replayed for the current settings.
 * Character and system voice are RENDER-time parameters, so changing either
 * reuses the cache; text, harmony, delivery, voice count and scene shape are
 * COMPOSE-time, so changing any of them requires a fresh model call.
 */
export function compositionIsReusable(
  cached: Text2VoiceComposition | null,
  config: Text2VoiceConfig,
  bpm: number,
  bars: number,
): boolean {
  if (!cached) return false;
  if (cached.harmony !== config.harmony) return false;
  if (cached.delivery !== config.delivery) return false;
  if (cached.voices.length !== config.voiceCount) return false;
  if (cached.bars !== bars) return false;
  if (Math.abs(cached.bpm - bpm) > 0.01) return false;
  return cached.syllables.length > 0 && cached.voices.length > 0;
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
