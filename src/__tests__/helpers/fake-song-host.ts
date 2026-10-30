/**
 * A fake host for the S-443 song tests: the SDK's in-memory song lyric host
 * (the reference behaviour of the four song methods, ownership included),
 * scene- and project-scoped plugin data, the track listings reading-anchor.ts
 * asks, and a fake model that answers the words call with as many generic
 * one-syllable words as each line asks for. No network, no real data.
 */
import type { ArrangementOutline, LLMToolUseRequest, LLMToolUseResponse, PluginHost, SongLyrics } from '@signalsandsorcery/plugin-sdk';
import { createSongLyricsTestHost } from '@signalsandsorcery/plugin-sdk';
import { TEXT2VOICE_PLUGIN_ID } from '../../reading-anchor';
import { SUBMIT_SONG_WORDS_TOOL_NAME } from '../../prompt';

export const WORDS = ['stone', 'light', 'rain', 'bell', 'sea', 'road', 'wind', 'glass', 'night', 'snow', 'fire', 'bone'];

export interface FakeOptions {
  outline: ArrangementOutline;
  activeSceneId: string;
  /** Track DB ids this plugin owns (readings' anchors). */
  owned: string[];
  /** Other plugins' tracks: id → plugin id. */
  others?: Record<string, string>;
  /** The ACTIVE scene's MIDI/instrument tracks (listSceneTracks). */
  activeSceneTracks?: string[];
  /** This plugin's tracks per scene (listSceneFamilyTracks). */
  familyByScene?: Record<string, string[]>;
  doc?: SongLyrics | null;
  /** Override the model's answer. */
  answer?: (req: LLMToolUseRequest) => unknown;
}

/** One line per "- Line k: N syllables" in each section block of the system prompt. */
export function defaultAnswer(req: LLMToolUseRequest): unknown {
  const system = req.systemInstruction?.parts?.map((p) => p.text).join('\n') ?? '';
  const sections: Array<{ key: string; role: string; lines: Array<{ text: string; syllables: string[] }> }> = [];
  let cur: (typeof sections)[number] | null = null;
  let w = 0;
  for (const line of system.split('\n')) {
    const head = /^### (s\d+): /.exec(line);
    if (head) {
      cur = { key: head[1], role: 'verse', lines: [] };
      sections.push(cur);
      continue;
    }
    const m = /^- Line \d+: (\d+) syllables?/.exec(line);
    const fixed = /^- Line \d+: FIXED — "(.*)"$/.exec(line);
    if (cur && fixed) {
      cur.lines.push({ text: fixed[1], syllables: [fixed[1]] });
    } else if (cur && m) {
      const n = Number(m[1]);
      const syls = Array.from({ length: n }, () => WORDS[w++ % WORDS.length]);
      cur.lines.push({ text: syls.join(' '), syllables: syls });
    }
  }
  return { candidates: [{ content: { parts: [{ functionCall: { name: SUBMIT_SONG_WORDS_TOOL_NAME, args: { sections } } }] } }] };
}

export function fakeSongHost(opts: FakeOptions) {
  const song = createSongLyricsTestHost({
    pluginId: TEXT2VOICE_PLUGIN_ID,
    outline: opts.outline,
    ownedTrackDbIds: opts.owned,
    otherTrackOwners: opts.others ?? {},
    doc: opts.doc ?? null,
  });
  const scenes = new Map<string, Map<string, unknown>>();
  const project = new Map<string, unknown>();
  const requests: LLMToolUseRequest[] = [];
  const data = (sceneId: string): Map<string, unknown> => {
    if (!scenes.has(sceneId)) scenes.set(sceneId, new Map());
    return scenes.get(sceneId) as Map<string, unknown>;
  };
  const host = {
    ...song.host,
    getSceneData: async (sceneId: string, key: string) => data(sceneId).get(key) ?? null,
    setSceneData: async (sceneId: string, key: string, value: unknown) => {
      data(sceneId).set(key, JSON.parse(JSON.stringify(value)));
    },
    getAllSceneData: async (sceneId: string) => Object.fromEntries(data(sceneId)),
    getProjectData: async (key: string) => project.get(key) ?? null,
    setProjectData: async (key: string, value: unknown) => {
      project.set(key, value);
    },
    getActiveSceneId: () => opts.activeSceneId,
    getPluginTracks: async () =>
      (opts.familyByScene?.[opts.activeSceneId] ?? []).map((dbId) => ({ id: `e-${dbId}`, name: 'voice', dbId })),
    listSceneTracks: async () =>
      [...(opts.familyByScene?.[opts.activeSceneId] ?? []), ...(opts.activeSceneTracks ?? [])].map((dbId) => ({ dbId, name: 't', hasMidi: true })),
    listSceneAudioTracks: async () => [],
    listSceneFamilyTracks: async (sceneId: string) => (opts.familyByScene?.[sceneId] ?? []).map((dbId) => ({ dbId, name: 'voice' })),
    generateWithLLMTools: async (req: LLMToolUseRequest): Promise<LLMToolUseResponse> => {
      requests.push(req);
      return (opts.answer ?? defaultAnswer)(req) as LLMToolUseResponse;
    },
    showToast: () => {},
  };
  // The fake answers what the song code calls; typed as the host so it passes every narrowed Pick.
  return { host: host as unknown as PluginHost, song, scenes, project, requests, data };
}

/** A reading's config in a scene (what makes the scene "have a reading"). */
export function putReading(fake: ReturnType<typeof fakeSongHost>, sceneId: string, dbId: string, config: Record<string, unknown> = {}): void {
  fake.data(sceneId).set(`track:${dbId}:text2voiceConfig`, {
    text: '',
    harmony: 'choral',
    delivery: 'unison',
    character: 'choir',
    voiceCount: 3,
    notesPerBeat: 2,
    ...config,
  });
}

export function outlineOf(...sections: Array<[instanceId: string, sceneId: string, bars: number, extra?: Record<string, unknown>]>): ArrangementOutline {
  const seen = new Map<string, number>();
  let bar = 1;
  return {
    sections: sections.map(([instanceId, sceneId, bars, extra]) => {
      const occurrence = (seen.get(sceneId) ?? 0) + 1;
      seen.set(sceneId, occurrence);
      const s = { instanceId, sceneId, sceneName: `Scene ${sceneId}`, startBar: bar, bars, occurrence, ...(extra ?? {}) };
      bar += bars;
      return s;
    }),
  };
}
