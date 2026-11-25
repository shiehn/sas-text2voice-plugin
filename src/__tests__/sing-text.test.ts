/**
 * D-499 / S-871 J9: `render_vocal_line` drives the panel's Sing pipeline headlessly. A mock host
 * (in-memory tracks + scene data, a fake model, a fake renderer) stands in for the app: no React,
 * no panel, no network.
 */
import type { LLMToolUseRequest, PluginHost, PluginTrackHandle, RenderVocalLineRequest } from '@signalsandsorcery/plugin-sdk';
import Text2VoiceGeneratorPlugin from '../../index';
import {
  configForRun,
  parseSingTextInput,
  RENDER_VOCAL_LINE_SKILL,
  singText,
  singTextFromParams,
  SingTextError,
} from '../sing-text';
import { SUBMIT_TEXT2VOICE_TOOL_NAME, SUBMIT_WORDS_TOOL_NAME } from '../prompt';

const SCENE = 'scene-1';
const TEXT = 'Under the bridge all matter is light, and the river keeps the time.';

interface MockOptions {
  activeSceneId?: string | null;
  noRenderer?: boolean;
  answer?: (req: LLMToolUseRequest) => unknown;
}

function composeAnswer(phrase: string, syllables: string[]) {
  const notes = syllables.map((_, i) => ({ degree: i % 5, octave: 0, rest: false }));
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              functionCall: {
                name: SUBMIT_TEXT2VOICE_TOOL_NAME,
                args: { phrase, syllables, rhythm: syllables.map(() => 1), voices: [{ label: 'lead', notes }] },
              },
            },
          ],
        },
      },
    ],
  };
}

function defaultAnswer(req: LLMToolUseRequest): unknown {
  const tool = req.toolConfig?.functionCallingConfig?.allowedFunctionNames?.[0];
  const user = req.contents?.map((c) => c.parts.map((p) => ('text' in p ? p.text : '')).join(' ')).join(' ') ?? '';
  // Quote whichever source text the run carries.
  const [phrase, syllables] = user.includes('Under the bridge')
    ? ['all matter is light', ['all', 'mat', 'ter', 'is', 'light']]
    : ['the river keeps the time', ['the', 'ri', 'ver', 'keeps', 'the', 'time']];
  if (tool === SUBMIT_WORDS_TOOL_NAME) {
    return { candidates: [{ content: { parts: [{ functionCall: { name: SUBMIT_WORDS_TOOL_NAME, args: { phrase, syllables } } }] } }] };
  }
  return composeAnswer(phrase, syllables);
}

function mockHost(opts: MockOptions = {}) {
  const tracks: PluginTrackHandle[] = [];
  const data = new Map<string, unknown>();
  const renders: RenderVocalLineRequest[] = [];
  const clips: Array<{ trackId: string; filePath: string }> = [];
  const mutes = new Map<string, boolean>();
  const roles = new Map<string, string>();
  const llm: LLMToolUseRequest[] = [];
  const deleted: string[] = [];
  let n = 0;
  const host: Record<string, unknown> = {
    getActiveSceneId: () => (opts.activeSceneId === undefined ? SCENE : opts.activeSceneId),
    getPluginTracks: async () => tracks.map((t) => ({ ...t })),
    createTrack: async (o: { name?: string }) => {
      n += 1;
      const t = { id: `eng-${n}`, dbId: `db-${n}`, name: o.name ?? `t${n}` };
      tracks.push(t);
      return { ...t };
    },
    deleteTrack: async (id: string) => {
      const i = tracks.findIndex((t) => t.id === id);
      if (i >= 0) tracks.splice(i, 1);
      deleted.push(id);
    },
    getSceneData: async (_s: string, key: string) => (data.has(key) ? JSON.parse(JSON.stringify(data.get(key))) : null),
    setSceneData: async (_s: string, key: string, value: unknown) => {
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
    deleteSceneData: async (_s: string, key: string) => {
      data.delete(key);
    },
    getAllSceneData: async () => Object.fromEntries(data),
    getMusicalContext: async () => ({
      key: 'C',
      mode: 'major',
      bpm: 120,
      bars: 4,
      genre: null,
      timeSignature: '4/4',
      chordProgression: [{ symbol: 'C', startQn: 0, endQn: 16 }],
      contractPrompt: null,
    }),
    generateWithLLMTools: async (req: LLMToolUseRequest) => {
      llm.push(req);
      return (opts.answer ?? defaultAnswer)(req);
    },
    writeAudioClip: async (trackId: string, filePath: string) => {
      clips.push({ trackId, filePath });
    },
    setTrackVolume: async () => {},
    setTrackPan: async () => {},
    setTrackMute: async (id: string, m: boolean) => {
      mutes.set(id, m);
    },
    setTrackRole: async (id: string, r: string) => {
      roles.set(id, r);
    },
    showToast: () => {},
  };
  if (!opts.noRenderer) {
    host.renderVocalLine = async (req: RenderVocalLineRequest) => {
      renders.push(req);
      return { filePath: `/tmp/render-${renders.length}.wav`, durationSec: 8, unvoicedIndices: [] };
    };
    host.listSystemVoices = async () => [];
  }
  return { host: host as unknown as PluginHost, tracks, data, renders, clips, mutes, roles, llm, deleted };
}

describe('render_vocal_line skill declaration', () => {
  it('is declared by the plugin with a small, LLM-friendly schema (no syllable or timing spec)', () => {
    const skills = new Text2VoiceGeneratorPlugin().getSkills();
    expect(skills.map((s) => s.id)).toEqual(['render_vocal_line']);
    const schema = RENDER_VOCAL_LINE_SKILL.inputSchema;
    expect(schema.required).toEqual(['text']);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
      ['newMelody', 'sceneId', 'style', 'text', 'trackId', 'voice', 'voices'].sort(),
    );
    // No property (and no property type) asks the caller for syllables, notes or timing.
    const shapes = Object.entries(schema.properties ?? {}).map(([k, v]) => `${k}:${(v as { type?: string }).type}`);
    expect(shapes.join(' ')).not.toMatch(/syllable|note|beat|duration|pitch|array|object/i);
  });
});

describe('parseSingTextInput / configForRun', () => {
  it('refuses empty text and unknown styles', () => {
    expect(() => parseSingTextInput({})).toThrow(SingTextError);
    expect(() => parseSingTextInput({ text: '   ' })).toThrow(/needs `text`/);
    expect(() => parseSingTextInput({ text: 'hi', style: 'opera' })).toThrow(/Unknown style/);
  });

  it('applies a style\'s axes and the voice hints over the reading', () => {
    const input = parseSingTextInput({ text: 'x', style: 'chant', voices: 9, voice: 'Samantha' });
    expect(input.voices).toBe(6); // clamped to MAX_VOICES
    const c = configForRun(null, input);
    expect(c).toMatchObject({ text: 'x', style: 'chant', voiceCount: 6, ttsVoice: 'Samantha', view: 'scene', sourceMode: 'quote' });
  });
});

describe('singText (headless Sing)', () => {
  it('adds a reading, renders every voice through renderVocalLine and places each with writeAudioClip', async () => {
    const m = mockHost();
    const r = await singTextFromParams(m.host, { text: TEXT, voices: 2 });

    expect(r.created).toBe(true);
    expect(r.sceneId).toBe(SCENE);
    expect(r.phrase).toBe('all matter is light');
    expect(r.lanes.map((l) => l.voiceIndex)).toEqual([0, 1]);
    expect(r.readingTrackId).toBe(r.lanes[0].trackId);
    // One render + one clip per voice, the clip being the render's file.
    expect(m.renders).toHaveLength(2);
    expect(m.clips.map((c) => c.trackId).sort()).toEqual(r.lanes.map((l) => l.trackId).sort());
    expect(m.clips.every((c) => /^\/tmp\/render-\d\.wav$/.test(c.filePath))).toBe(true);
    // The panel derived the syllables; the caller sent none.
    expect(m.renders[0].syllables.length).toBeGreaterThan(0);
    // Every lane is a vocal; the lane created by the run spawns muted (panel behaviour), reported.
    expect(r.lanes.every((l) => m.roles.get(l.trackId) === 'vocals')).toBe(true);
    expect(r.mutedTrackIds).toEqual([r.lanes[1].trackId]);
    expect(r.notices.some((x) => x.startsWith('Composed new music and new words'))).toBe(true);
    // The words are the reading's: the config holds them for the panel to show.
    expect(m.data.get(`track:${r.readingDbId}:text2voiceConfig`)).toMatchObject({ text: TEXT, voiceCount: 2, view: 'scene' });
    expect(m.llm).toHaveLength(1);
  });

  it('re-sings an existing reading named by any of its lanes, reusing its tracks', async () => {
    const m = mockHost();
    const first = await singText(m.host, { text: TEXT, voices: 2 });
    const before = m.tracks.length;

    const r = await singText(m.host, { text: 'And the river keeps the time.', trackId: first.lanes[1].dbId });
    expect(r.created).toBe(false);
    expect(r.readingDbId).toBe(first.readingDbId);
    expect(m.tracks.length).toBe(before);
    expect(r.lanes.map((l) => l.trackId)).toEqual(first.lanes.map((l) => l.trackId));
    expect(r.phrase).toBe('the river keeps the time');
    expect(m.renders).toHaveLength(4);
  });

  it('newMelody forces a fresh composition when the cached melody would be reused', async () => {
    const m = mockHost();
    const first = await singText(m.host, { text: TEXT, voices: 1 });
    await singText(m.host, { text: TEXT, voices: 1, trackId: first.readingTrackId });
    const callsAfterRerender = m.llm.length;
    await singText(m.host, { text: TEXT, voices: 1, trackId: first.readingTrackId, newMelody: true });
    expect(m.llm.length).toBe(callsAfterRerender + 1);
    expect(m.llm[m.llm.length - 1].toolConfig?.functionCallingConfig?.allowedFunctionNames).toEqual([SUBMIT_TEXT2VOICE_TOOL_NAME]);
  });

  it('refuses: no renderer, no active scene, another scene, an unknown track', async () => {
    await expect(singText(mockHost({ noRenderer: true }).host, { text: TEXT })).rejects.toMatchObject({ code: 'host_too_old' });
    await expect(singText(mockHost({ activeSceneId: null }).host, { text: TEXT })).rejects.toMatchObject({ code: 'no_active_scene' });
    await expect(singText(mockHost().host, { text: TEXT, sceneId: 'other' })).rejects.toMatchObject({ code: 'scene_not_active' });
    await expect(singText(mockHost().host, { text: TEXT, trackId: 'nope' })).rejects.toMatchObject({ code: 'track_not_found' });
  });

  it('a failed run removes the reading it added and reports render_failed', async () => {
    const m = mockHost({ answer: () => ({ candidates: [] }) });
    await expect(singText(m.host, { text: TEXT })).rejects.toMatchObject({ code: 'render_failed' });
    expect(m.tracks).toHaveLength(0);
    expect([...m.data.keys()]).toEqual([]);
    expect(m.renders).toHaveLength(0);
  });
});
