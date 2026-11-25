/**
 * The headless half of Text2Voice (D-499, S-871 J9): `render_vocal_line`, "set this text to music".
 *
 * The panel's Sing button runs `generateText2Voice(track, services)` with services the panel core
 * builds from React state. This module builds the same services from the PluginHost alone (the
 * plugin's tracks, the scene's plugin data, the group metas) and runs the SAME strategy, so an agent,
 * `sas` or the HTTP API gets exactly what a person gets pressing Sing: one model call composes the
 * melody and splits the words (no syllable or timing spec from the caller), every voice renders
 * through `host.renderVocalLine` and lands on its own audio track through `host.writeAudioClip`.
 *
 * Target: a NEW reading in the active scene (the panel's "Add Reading" then Sing), or an existing
 * reading named by `trackId` (any of its lanes, engine id or DB id), whose words and settings are
 * replaced and which is sung again. The scene is always the active one (the host creates tracks there);
 * a `sceneId` that is not active is refused so the caller can activate it first.
 *
 * The app reaches this through its plugin-skill HANDLERS (`@signalsandsorcery/text2voice-generator:
 * render_vocal_line`), loading this package lazily and feature-detecting `singText`, the way the
 * Synth V `write_song_lyrics` skill is reached.
 */

import type {
  GenerationServices,
  GeneratorTrackState,
  PluginHost,
  PluginSkill,
  PluginTrackHandle,
  ResolvedTrackGroup,
} from '@signalsandsorcery/plugin-sdk';
import {
  newTrackState,
  parseTrackGroups,
  resolveTrackGroups,
  trackDataKey,
} from '@signalsandsorcery/plugin-sdk';
import { generateText2Voice } from './text2voice-generation';
import { asVocalHost, HOST_TOO_OLD_MESSAGE } from './host-vocal';
import { MAX_VOICES, MIN_VOICES, normalizeVoiceCount } from './harmony-styles';
import { isStyleId, STYLE_IDS, STYLES, styleAxes, type StyleId } from './styles';
import { silentSoundAdapter } from './silent-sound';
import {
  asText2VoiceConfig,
  asText2VoiceMeta,
  MAX_TEXT_LENGTH,
  stampText2VoiceAnchor,
  text2voiceGroupIsComplete,
  text2voiceGroupSpec,
  TEXT2VOICE_CONFIG_KEY,
  TEXT2VOICE_FORCE_KEY,
  TEXT2VOICE_MELODY_KEY,
  TEXT2VOICE_VOICE_META_KEY,
  TEXT2VOICE_WORDS_KEY,
  type Text2VoiceConfig,
  type Text2VoiceMeta,
} from './voice-meta';

export const RENDER_VOCAL_LINE_SKILL_ID = 'render_vocal_line';

/** The panel's track name prefix (Text2VoiceGeneratorPanel adapter identity). */
const TRACK_NAME_PREFIX = 'voice';

const NEW_READING_DEFAULTS: Text2VoiceConfig = {
  text: '',
  harmony: 'choral',
  delivery: 'unison',
  character: 'choir',
  voiceCount: 3,
  notesPerBeat: 2,
};

const styleList = STYLE_IDS.map((id) => `${id} (${STYLES[id].hint})`).join('; ');

export const RENDER_VOCAL_LINE_SKILL: PluginSkill = {
  id: RENDER_VOCAL_LINE_SKILL_ID,
  description:
    'Set text to music and sing it: Text2Voice quotes a phrase from `text`, composes a vocal line over the active ' +
    "scene's key, chords and length, splits it into syllables itself, and renders each voice with a system speech " +
    'voice forced onto the notes; every voice lands on its own audio track (role vocals). Without `trackId` it adds a ' +
    'new reading to the active scene; with `trackId` (any lane of an existing reading) it replaces that reading\'s words ' +
    'and sings it again (the melody is kept when it still fits, unless `newMelody`). Newly created lanes start MUTED, as ' +
    'in the panel: unmute them to hear the line. Use for "sing this", "make a vocal out of this text", "set these words ' +
    'to music". Needs a signed-in model and an active scene.',
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The words or prose to sing (a line of lyrics or a paragraph; a phrase is quoted from it).',
      },
      sceneId: {
        type: 'string',
        description: 'The scene to sing in; it must be the active scene (omitted = the active scene).',
      },
      trackId: {
        type: 'string',
        description: 'An existing Text2Voice track (engine or DB id) whose reading is re-sung; omitted = a new reading.',
      },
      style: {
        type: 'string',
        enum: [...STYLE_IDS],
        description: `Vocal style preset (sets harmony, delivery, character and pace): ${styleList}. Omitted = the reading's current setting (choral choir for a new one).`,
      },
      voices: {
        type: 'integer',
        minimum: MIN_VOICES,
        maximum: MAX_VOICES,
        description: 'How many voices (lanes) to sing in harmony. Omitted = the style or reading default.',
      },
      voice: {
        type: 'string',
        description: 'A system speech voice name to sing with (omitted = the reading\'s voice or the host default).',
      },
      newMelody: {
        type: 'boolean',
        description: 'Compose fresh music even when the reading\'s melody would be reused (default false).',
      },
    },
    required: ['text'],
  },
};

export interface SingTextInput {
  text: string;
  sceneId?: string;
  trackId?: string;
  style?: StyleId;
  voices?: number;
  voice?: string;
  newMelody?: boolean;
}

export interface SungLane {
  trackId: string;
  dbId: string;
  voiceIndex: number;
  label: string;
}

export interface SingTextResult {
  sceneId: string;
  /** The reading's anchor (voice 0). */
  readingTrackId: string;
  readingDbId: string;
  /** True when this call added the reading. */
  created: boolean;
  /** The words actually sung (the phrase quoted from `text`). */
  phrase: string;
  lanes: SungLane[];
  /** Lanes this call muted (new lanes spawn muted, silent lanes are muted). */
  mutedTrackIds: string[];
  /** What the panel would have toasted, in order ("Composed new music and new words", trims, breaths). */
  notices: string[];
}

/** A refusal the caller can act on; `code` is stable. */
export class SingTextError extends Error {
  constructor(
    readonly code: 'bad_input' | 'host_too_old' | 'no_active_scene' | 'scene_not_active' | 'track_not_found' | 'render_failed',
    message: string,
  ) {
    super(message);
    this.name = 'SingTextError';
  }
}

/** Narrow raw tool params into a SingTextInput (throws SingTextError('bad_input')). */
export function parseSingTextInput(params: Record<string, unknown>): SingTextInput {
  const text = typeof params.text === 'string' ? params.text.trim() : '';
  if (!text) throw new SingTextError('bad_input', 'render_vocal_line needs `text`: the words to sing.');
  if (text.length > MAX_TEXT_LENGTH) {
    throw new SingTextError('bad_input', `\`text\` is longer than ${MAX_TEXT_LENGTH} characters.`);
  }
  if (params.style !== undefined && !isStyleId(params.style)) {
    throw new SingTextError('bad_input', `Unknown style "${String(params.style)}"; use one of ${STYLE_IDS.join(', ')}.`);
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const input: SingTextInput = { text };
  const sceneId = str(params.sceneId);
  const trackId = str(params.trackId);
  const voice = str(params.voice);
  if (sceneId) input.sceneId = sceneId;
  if (trackId) input.trackId = trackId;
  if (voice) input.voice = voice;
  if (isStyleId(params.style)) input.style = params.style;
  if (typeof params.voices === 'number' && Number.isFinite(params.voices)) input.voices = normalizeVoiceCount(params.voices);
  if (params.newMelody === true) input.newMelody = true;
  return input;
}

/** The config the run sings with: the reading's own (or the defaults), the caller's words and hints over it. */
export function configForRun(existing: Text2VoiceConfig | null, input: SingTextInput): Text2VoiceConfig {
  const base = existing ?? NEW_READING_DEFAULTS;
  const next: Text2VoiceConfig = { ...base, text: input.text, sourceMode: 'quote', view: 'scene' };
  // The caller's text is the scene's own words: the Song view's aside copy has nothing to keep.
  delete next.sceneText;
  // Explicit words replace an imported melody's source: a quote is composed for, not read from a track.
  next.melodySource = 'composed';
  delete next.importedTrackDbId;
  if (input.style) Object.assign(next, styleAxes(input.style), { style: input.style });
  if (input.voices !== undefined) next.voiceCount = input.voices;
  if (input.voice) next.ttsVoice = input.voice;
  return next;
}

/** Wrap the host: toasts become notices, mutes are recorded; every other member is the host's own, bound. */
function observedHost(host: PluginHost, notices: string[], muted: Map<string, boolean>): PluginHost {
  return new Proxy(host, {
    get(target, prop, receiver) {
      if (prop === 'showToast') {
        return (_type: string, title: string, message?: string): void => {
          notices.push(message ? `${title}: ${message}` : title);
        };
      }
      if (prop === 'setTrackMute') {
        return async (trackId: string, value: boolean): Promise<void> => {
          await target.setTrackMute(trackId, value);
          muted.set(trackId, value);
        };
      }
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** Headless GenerationServices over the host: the panel core's makeServices without React. */
async function headlessServices(
  host: PluginHost,
  sceneId: string,
  onUpdate: (trackId: string, patch: Partial<GeneratorTrackState> | ((t: GeneratorTrackState) => GeneratorTrackState)) => void,
): Promise<{ services: GenerationServices; tracks: GeneratorTrackState[] }> {
  const handles = await host.getPluginTracks();
  const tracks = handles.map((h) => newTrackState(h));
  const sceneData = await host.getAllSceneData(sceneId).catch(() => ({}) as Record<string, unknown>);
  const parsed = parseTrackGroups<Text2VoiceMeta>(sceneData, text2voiceGroupSpec);
  const groups = resolveTrackGroups(parsed, tracks, (t) => t.handle.dbId, { isComplete: text2voiceGroupIsComplete }).resolved;
  const byEngine = new Map(handles.map((h) => [h.id, h.dbId]));
  const services: GenerationServices = {
    host,
    activeSceneId: sceneId,
    tracks,
    updateTrack: onUpdate,
    setTracks: () => {},
    reloadTracks: async () => {},
    // Never reached by the Text2Voice strategy (its lanes have no sound history).
    soundHistory: {} as GenerationServices['soundHistory'],
    engineToDbId: (id) => byEngine.get(id) ?? id,
    trackDataKey,
    markEditLoaded: () => {},
    createFamilyTrack: (nameSuffix = '') =>
      host.createTrack({ name: `${TRACK_NAME_PREFIX}-${Date.now()}${nameSuffix}`, loadSynth: false }),
    resolvedGroups: <M,>(metaKey: string) =>
      (metaKey === TEXT2VOICE_VOICE_META_KEY ? groups : []) as unknown as ResolvedTrackGroup<M, GeneratorTrackState>[],
    sound: silentSoundAdapter,
  };
  return { services, tracks };
}

/** The anchor dbId of the reading a track belongs to (its own dbId when it carries no meta). */
async function anchorOf(host: PluginHost, sceneId: string, dbId: string): Promise<string> {
  const meta = asText2VoiceMeta(await host.getSceneData(sceneId, trackDataKey(dbId, TEXT2VOICE_VOICE_META_KEY)).catch(() => null));
  return meta ? meta.groupId : dbId;
}

/**
 * Sing `input.text` in the active scene. Throws SingTextError for refusals; errors from the
 * pipeline (the model declined, the render failed) arrive as SingTextError('render_failed').
 */
export async function singText(host: PluginHost, input: SingTextInput): Promise<SingTextResult> {
  if (!asVocalHost(host)) throw new SingTextError('host_too_old', HOST_TOO_OLD_MESSAGE);
  const active = host.getActiveSceneId();
  if (!active) throw new SingTextError('no_active_scene', 'No scene is active: activate a scene first.');
  if (input.sceneId && input.sceneId !== active) {
    throw new SingTextError('scene_not_active', `Scene ${input.sceneId} is not the active scene (${active}): activate it first.`);
  }
  const sceneId = active;
  const notices: string[] = [];
  const muted = new Map<string, boolean>();
  const h = observedHost(host, notices, muted);

  // --- the target reading ---------------------------------------------------
  let anchor: PluginTrackHandle;
  let created = false;
  if (input.trackId) {
    const handles = await h.getPluginTracks();
    const hit = handles.find((t) => t.id === input.trackId || t.dbId === input.trackId);
    if (!hit) {
      throw new SingTextError('track_not_found', `No Text2Voice track ${input.trackId} in the active scene.`);
    }
    const anchorDbId = await anchorOf(h, sceneId, hit.dbId);
    anchor = handles.find((t) => t.dbId === anchorDbId) ?? hit;
  } else {
    anchor = await h.createTrack({ name: `${TRACK_NAME_PREFIX}-${Date.now()}`, loadSynth: false });
    created = true;
    await stampText2VoiceAnchor(h, sceneId, trackDataKey, anchor.dbId);
  }

  const rollbackCreated = async (): Promise<void> => {
    if (!created) return;
    await h.deleteTrack(anchor.id).catch(() => {});
    for (const suffix of [TEXT2VOICE_VOICE_META_KEY, TEXT2VOICE_CONFIG_KEY, TEXT2VOICE_MELODY_KEY, TEXT2VOICE_WORDS_KEY, TEXT2VOICE_FORCE_KEY]) {
      await h.deleteSceneData(sceneId, trackDataKey(anchor.dbId, suffix)).catch(() => {});
    }
  };

  let phrase = '';
  try {
    // --- the words and hints, ONE merged persist (the panel's applyStyle rule) ---
    const configKey = trackDataKey(anchor.dbId, TEXT2VOICE_CONFIG_KEY);
    const existing = asText2VoiceConfig(await h.getSceneData(sceneId, configKey).catch(() => null));
    await h.setSceneData(sceneId, configKey, configForRun(existing, input));
    if (input.newMelody) await h.setSceneData(sceneId, trackDataKey(anchor.dbId, TEXT2VOICE_FORCE_KEY), true);

    // --- Sing --------------------------------------------------------------
    const { services, tracks } = await headlessServices(h, sceneId, (trackId, patch) => {
      const t = tracks.find((x) => x.handle.id === trackId);
      if (!t) return;
      const next = typeof patch === 'function' ? patch(t) : { ...t, ...patch };
      if (next.prompt) phrase = next.prompt;
    });
    const track = tracks.find((t) => t.handle.id === anchor.id) ?? newTrackState(anchor);
    await generateText2Voice(track, services);
  } catch (err: unknown) {
    await rollbackCreated();
    if (err instanceof SingTextError) throw err;
    throw new SingTextError('render_failed', err instanceof Error ? err.message : String(err));
  }

  // --- what was sung: the reading's lanes now --------------------------------
  const handles = await h.getPluginTracks();
  const sceneData = await h.getAllSceneData(sceneId).catch(() => ({}) as Record<string, unknown>);
  const group = parseTrackGroups<Text2VoiceMeta>(sceneData, text2voiceGroupSpec);
  // The anchor may have moved (its track died mid-run): the group holding any lane we know wins.
  const lanes: SungLane[] = [];
  const reading =
    group.find((g) => g.groupId === anchor.dbId) ??
    group.find((g) => g.members.some((m) => m.dbId === anchor.dbId));
  for (const m of reading?.members ?? []) {
    const handle = handles.find((t) => t.dbId === m.dbId);
    if (handle) lanes.push({ trackId: handle.id, dbId: m.dbId, voiceIndex: m.meta.voiceIndex, label: m.meta.label });
  }
  const lead = lanes.find((l) => l.voiceIndex === 0);
  return {
    sceneId,
    readingTrackId: lead?.trackId ?? anchor.id,
    readingDbId: lead?.dbId ?? anchor.dbId,
    created,
    phrase,
    lanes,
    mutedTrackIds: lanes.filter((l) => muted.get(l.trackId) === true).map((l) => l.trackId),
    notices,
  };
}

/** Raw params in, result out: what the app's skill handler calls (feature-detected as `singText`). */
export async function singTextFromParams(host: PluginHost, params: Record<string, unknown>): Promise<SingTextResult> {
  return singText(host, parseSingTextInput(params));
}
