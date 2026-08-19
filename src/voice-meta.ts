/**
 * Text2Voice voice-group metadata — the ensemble plugin's voice-group shape.
 * Membership is per-member scene-data under `track:<dbId>:text2voiceVoice`;
 * the anchor is voiceIndex 0 and holds the group's config (including the
 * source text) plus the cached melody and words.
 */

import type {
  GroupParseSpec,
  PluginHost,
  ResolvedTrackGroup,
  GeneratorTrackState,
  PluginMidiNote,
} from '@signalsandsorcery/plugin-sdk';
import { isStyleId, type StyleId } from './styles';
import {
  isComposedHarmony,
  normalizeCharacter,
  normalizeDelivery,
  normalizeHarmony,
  normalizeVoiceCount,
  type Character,
  type DeliveryMode,
  type HarmonyStyle,
} from './harmony-styles';

export const TEXT2VOICE_VOICE_META_KEY = 'text2voiceVoice';
/** Anchor-held config: the source text plus the intent axes. */
export const TEXT2VOICE_CONFIG_KEY = 'text2voiceConfig';
/** Anchor-held cache of the composed music (the expensive artifact). */
export const TEXT2VOICE_MELODY_KEY = 'text2voiceMelody';
/** Anchor-held cache of the words currently sitting on that music. */
export const TEXT2VOICE_WORDS_KEY = 'text2voiceWords';
/**
 * One-shot "compose new music" request. Its OWN key, never part of the config
 * object: as a config field it latched forever when a run threw before the
 * end-of-run clear, and any unrelated `persist()` erased a pending request.
 * The generator deletes it at READ time, before any expensive work.
 */
export const TEXT2VOICE_FORCE_KEY = 'text2voiceForceMelody';

/** Guards a pathological paste; scenes hold at most a page or so of prose. */
export const MAX_TEXT_LENGTH = 20000;

export interface Text2VoiceMeta {
  /** dbId of the anchor (voice 0). */
  groupId: string;
  /** 0 = lead voice; increases downward. */
  voiceIndex: number;
  /** Label shown in the voice row ("lead", "harmony 2"). */
  label: string;
}

export function asText2VoiceMeta(val: unknown): Text2VoiceMeta | null {
  if (!val || typeof val !== 'object') return null;
  const m = val as Partial<Text2VoiceMeta>;
  if (typeof m.groupId !== 'string' || typeof m.voiceIndex !== 'number') return null;
  return {
    groupId: m.groupId,
    voiceIndex: m.voiceIndex,
    label: typeof m.label === 'string' ? m.label : '',
  };
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
  /** Notes per beat: 1 = quarters, 2 = eighths, 3 = triplets, 4 = sixteenths. */
  notesPerBeat: number;
  /** System speech voice for the group. */
  ttsVoice?: string;
  /**
   * The style preset last applied — INFORMATIONAL. The planner reads the
   * concrete axes only; this drives the picker display, prompt pack and lane
   * roles, and goes stale to "Custom" the moment an axis is hand-edited.
   */
  style?: StyleId;
  /**
   * Where the words come from: 'quote' sings a phrase from the pasted text
   * (default, the original behavior); 'write' has the model write ORIGINAL
   * lyrics about `topic`, fitted to the melody's phrases and rhyme scheme.
   */
  sourceMode?: 'quote' | 'write';
  /** Write mode: what the lyrics are about. */
  topic?: string;
  /** Write mode only — rhyme targets are phrase-final syllables. */
  rhymeScheme?: 'none' | 'AABB' | 'ABAB';
  /** Where the melody comes from: composed by the model, or read from a track. */
  melodySource?: 'composed' | 'imported';
  /** The scene track (tracks.id) the melody is read from, when imported. */
  importedTrackDbId?: string;
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
    notesPerBeat:
      c.notesPerBeat === 1 || c.notesPerBeat === 2 || c.notesPerBeat === 3 || c.notesPerBeat === 4
        ? c.notesPerBeat
        : 2,
  };
  if (typeof c.ttsVoice === 'string') config.ttsVoice = c.ttsVoice;
  if (isStyleId(c.style)) config.style = c.style;
  config.sourceMode = c.sourceMode === 'write' ? 'write' : 'quote';
  if (typeof c.topic === 'string') config.topic = c.topic.slice(0, 500);
  config.rhymeScheme =
    c.rhymeScheme === 'AABB' || c.rhymeScheme === 'ABAB' ? c.rhymeScheme : 'none';
  config.melodySource = c.melodySource === 'imported' ? 'imported' : 'composed';
  if (typeof c.importedTrackDbId === 'string') config.importedTrackDbId = c.importedTrackDbId;
  // A composed harmony cannot be jointly written FOR an imported lead — coerce
  // to the nearest derived style so the fan-out still works.
  if (config.melodySource === 'imported' && isComposedHarmony(config.harmony)) {
    config.harmony = 'unison';
  }
  return config;
}

// --- anchor-held caches: MELODY and WORDS are stored SEPARATELY ---------
//
// Composing the music is the expensive step, so it is cached independently of
// the words sitting on it. Replacing the text keeps the melody and costs only
// a small phrase-selection call; changing the character or speech voice costs
// nothing at all.
//
// The melody stores the settings that DEFINED its notes — key, mode, meter,
// tempo, length — and, when it was a joint multi-voice composition, which
// composed style wrote it. It deliberately does NOT store delivery or (for
// derived styles) the harmony fan-out: delivery is pure render-time
// arrangement, and derived harmonies (unison / organum / drone) are always
// re-derived from the cached lead at render time. Without that, flipping
// through styles would cost a full compose per click.

export interface Text2VoiceMelody {
  /**
   * The composed voices. For a COMPOSED harmony (choral / counterpoint /
   * cluster) this is all N jointly-written lines, highest first. For a derived
   * harmony only the LEAD is stored — the fan-out is recomputed at render.
   */
  voices: PluginMidiNote[][];
  /**
   * The composed style that wrote `voices` as a joint texture, or null when
   * only a lead line was composed (derived styles).
   */
  composedHarmony: HarmonyStyle | null;
  /** Scene shape the notes were written against — all of it invalidates. */
  bpm: number;
  bars: number;
  key: string;
  mode: string;
  quarterNotesPerBar: number;
  /** The track this melody was READ from, when imported (else absent). */
  importedFrom?: string;
}

export interface Text2VoiceWords {
  /** The phrase quoted or written. */
  phrase: string;
  /** Its syllable split, in order. */
  syllables: string[];
  /**
   * PROVENANCE — what these words were made with. Without it the planner
   * cannot see that the source mode, topic or rhyme scheme changed, and would
   * happily re-render lyrics written for another request.
   */
  source: 'quote' | 'write';
  topic?: string;
  rhymeScheme?: 'none' | 'AABB' | 'ABAB';
  /** Write mode: the raw per-phrase lines, kept so render-time can rebuild
   * the exact materialization (and its word spans) deterministically. */
  lines?: string[][];
  lineTexts?: string[];
}

export function asText2VoiceMelody(val: unknown): Text2VoiceMelody | null {
  if (!val || typeof val !== 'object') return null;
  const m = val as Partial<Text2VoiceMelody> & { harmony?: unknown };
  if (!Array.isArray(m.voices) || !m.voices.every((v) => Array.isArray(v))) return null;
  if (m.voices.length === 0 || (m.voices[0] as unknown[]).length === 0) return null;

  // Legacy caches (pre key/mode fields) stored `harmony` and derived fan-outs
  // in `voices`. They cannot prove which key they were written in, so they are
  // rejected — one recompose on first touch beats replaying in the wrong key.
  if (typeof m.key !== 'string' || typeof m.mode !== 'string') return null;

  const composedHarmony =
    typeof m.composedHarmony === 'string' && isComposedHarmony(normalizeHarmony(m.composedHarmony))
      ? normalizeHarmony(m.composedHarmony)
      : null;

  const out: Text2VoiceMelody = {
    voices: m.voices as PluginMidiNote[][],
    composedHarmony,
    bpm: typeof m.bpm === 'number' ? m.bpm : 120,
    bars: typeof m.bars === 'number' ? m.bars : 4,
    key: m.key,
    mode: m.mode,
    quarterNotesPerBar: typeof m.quarterNotesPerBar === 'number' ? m.quarterNotesPerBar : 4,
  };
  if (typeof m.importedFrom === 'string') out.importedFrom = m.importedFrom;
  return out;
}

export function asText2VoiceWords(val: unknown): Text2VoiceWords | null {
  if (!val || typeof val !== 'object') return null;
  const w = val as Partial<Text2VoiceWords>;
  if (typeof w.phrase !== 'string' || !Array.isArray(w.syllables)) return null;
  const syllables = w.syllables.filter((s): s is string => typeof s === 'string');
  if (syllables.length === 0) return null;
  const words: Text2VoiceWords = {
    phrase: w.phrase,
    syllables,
    // Legacy rows predate provenance and were all quotes.
    source: w.source === 'write' ? 'write' : 'quote',
  };
  if (typeof w.topic === 'string') words.topic = w.topic;
  if (w.rhymeScheme === 'AABB' || w.rhymeScheme === 'ABAB' || w.rhymeScheme === 'none') {
    words.rhymeScheme = w.rhymeScheme;
  }
  if (Array.isArray(w.lines) && w.lines.every((l) => Array.isArray(l))) {
    words.lines = (w.lines as string[][]).map((l) => l.filter((x): x is string => typeof x === 'string'));
  }
  if (Array.isArray(w.lineTexts)) {
    words.lineTexts = w.lineTexts.filter((x): x is string => typeof x === 'string');
  }
  return words;
}

/**
 * Whether the cached words still serve the current request. Provenance first:
 * quote-words cannot serve a write request and vice versa. Then per mode —
 * quote: the phrase must still occur in the (possibly edited) source text;
 * write: the topic and rhyme scheme must be unchanged.
 */
export function wordsReusable(
  words: Text2VoiceWords | null,
  config: Text2VoiceConfig,
  phraseStillInSource: boolean,
): boolean {
  if (!words) return false;
  const mode = config.sourceMode ?? 'quote';
  if (words.source !== mode) return false;
  if (mode === 'quote') return phraseStillInSource;
  return (
    (words.topic ?? '') === (config.topic ?? '') &&
    (words.rhymeScheme ?? 'none') === (config.rhymeScheme ?? 'none')
  );
}

/** The live scene shape a cached melody must still describe. */
export interface SceneShapeKey {
  bpm: number;
  bars: number;
  key: string;
  mode: string;
  quarterNotesPerBar: number;
}

/**
 * Whether a cached melody still describes the current settings.
 *
 * Two-sided by design:
 * - STRICT about the scene shape (key, mode, meter, tempo, length): the
 *   absolute pitches were baked against them, so any change means the notes
 *   are simply wrong — recompose.
 * - RELAXED about arrangement: delivery NEVER invalidates, and a DERIVED
 *   harmony target (unison / organum / drone) needs only the cached lead —
 *   voice count and derived-style changes re-fan at render time. Only a
 *   COMPOSED target that differs from what was jointly written (or whose
 *   voice count differs) forces a compose.
 */
export function melodyIsReusable(
  melody: Text2VoiceMelody | null,
  config: Text2VoiceConfig,
  scene: SceneShapeKey,
): boolean {
  if (!melody) return false;
  if (melody.bars !== scene.bars) return false;
  if (Math.abs(melody.bpm - scene.bpm) > 0.01) return false;
  if (melody.key !== scene.key || melody.mode !== scene.mode) return false;
  if (melody.quarterNotesPerBar !== scene.quarterNotesPerBar) return false;
  // Source identity: an imported request needs THE melody read from THAT
  // track; a composed request cannot ride an import (and vice versa).
  const wantImported = config.melodySource === 'imported';
  if (wantImported !== (melody.importedFrom !== undefined)) return false;
  if (wantImported && melody.importedFrom !== config.importedTrackDbId) return false;

  if (isComposedHarmony(config.harmony)) {
    return melody.composedHarmony === config.harmony && melody.voices.length === config.voiceCount;
  }
  // Derived target: any melody with a lead will do — the fan-out is render-time.
  return melody.voices[0].length > 0;
}

/** What a generate run actually has to do. */
export type GenerationMode = 'compose' | 'reword' | 'render' | 'import';

/**
 * Decide the cheapest sufficient action.
 *
 *   compose  melody + words          (one full model call)
 *   import   melody read from a track (mechanical, no model) + words refit
 *   reword   words only              (one small call, melody kept)
 *   render   neither                 (no model call at all)
 */
export function planGeneration(params: {
  melody: Text2VoiceMelody | null;
  words: Text2VoiceWords | null;
  config: Text2VoiceConfig;
  scene: SceneShapeKey;
  /** quote mode: the phrase still occurs in the current source text. */
  phraseStillInSource: boolean;
  /** User explicitly asked for a new melody (the one-shot key). */
  forceMelody?: boolean;
}): GenerationMode {
  const { melody, words, config, scene, phraseStillInSource, forceMelody } = params;
  const imported = config.melodySource === 'imported';
  // An imported melody is a mechanical READ — every path that would compose
  // re-imports instead (tempo change, source-track change, even ♪ New music,
  // which for an import means "re-read the track now").
  if (forceMelody) return imported ? 'import' : 'compose';
  if (!melodyIsReusable(melody, config, scene)) return imported ? 'import' : 'compose';
  if (!wordsReusable(words, config, phraseStillInSource)) return 'reword';
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
