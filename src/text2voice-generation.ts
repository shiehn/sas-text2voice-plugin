/**
 * Text2Voice generation strategy — the brain.
 *
 * ONE schema-forced model call chooses a phrase from the user's text, splits it
 * into syllables, and sets it on a syllable grid (host.generateWithLLMTools,
 * mode 'ANY'). Everything after that is mechanical:
 *
 *   grid -> pitches      compose.ts       (in-scale + monophonic by construction)
 *   harmony              harmony-styles   (derived styles need no model work)
 *   delivery             harmony-styles   (unison / canon / hocket)
 *   syllables <-> notes  syllables.ts     (strict 1:1)
 *   render               host.renderVocalLine -> one WAV per voice
 *   place                createTrack + writeAudioClip
 *
 * The composition is CACHED on the anchor. Character and system voice are
 * render-time settings, so changing either re-renders from the cache with no
 * model call; only editing the text (or harmony / delivery / voice count /
 * scene shape) forces a fresh composition.
 *
 * NOTE: generateWithLLMTools is a raw Gemini passthrough — unlike
 * generateWithLLM it does NOT auto-prefix the musical context, so this strategy
 * assembles key/BPM/bars/chords into the prompt itself.
 */

import type {
  GeneratorTrackState,
  GenerationServices,
  LLMToolUseRequest,
  PluginMidiNote,
  PluginTrackHandle,
} from '@signalsandsorcery/plugin-sdk';
import {
  panelMeter,
  panelQuarterNotesPerBar,
} from '@signalsandsorcery/plugin-sdk';
import {
  assignSyllables,
  deriveHarmonyVoices,
  isComposedHarmony,
} from './harmony-styles';
import {
  CompositionError,
  gridVoiceToNotes,
  parseText2VoiceArgs,
  slotSyllableIndexes,
} from './compose';
import {
  buildSubmitText2VoiceTool,
  buildText2VoiceSystemPrompt,
  buildText2VoiceUserPrompt,
  composedVoiceCount,
  SUBMIT_TEXT2VOICE_TOOL_NAME,
  type PromptContext,
} from './prompt';
import { buildVocalLineRequest } from './render-spec';
import {
  reconcileSyllablesToNotes,
  syllableBudget,
  validatePhraseInSource,
  validateSyllableSplit,
} from './syllables';
import { tonicPcFor } from './music-helpers';
import { asVocalHost, HOST_TOO_OLD_MESSAGE } from './host-vocal';
import {
  asText2VoiceComposition,
  asText2VoiceConfig,
  compositionIsReusable,
  planReconcile,
  TEXT2VOICE_COMPOSITION_KEY,
  TEXT2VOICE_CONFIG_KEY,
  TEXT2VOICE_VOICE_META_KEY,
  type Text2VoiceComposition,
  type Text2VoiceConfig,
  type Text2VoiceMeta,
} from './voice-meta';

export const TEXT2VOICE_MAX_TRACKS = 16;
export const TEXT2VOICE_MODEL = 'gemini-3.1-pro-preview';
export const TEXT2VOICE_MAX_OUTPUT_TOKENS = 49152;
export const TEXT2VOICE_TEMPERATURE = 0.9;

const DEFAULT_CONFIG: Text2VoiceConfig = {
  text: '',
  harmony: 'choral',
  delivery: 'unison',
  character: 'choir',
  voiceCount: 3,
  notesPerBeat: 2,
};

function voiceLabel(index: number): string {
  return index === 0 ? 'lead' : `harmony ${index}`;
}

export async function generateText2Voice(
  track: GeneratorTrackState,
  services: GenerationServices,
): Promise<void> {
  const host = services.host;
  const scene = services.activeSceneId;
  if (!scene) throw new Error('No active scene.');

  const vocalHost = asVocalHost(host);
  if (!vocalHost) throw new Error(HOST_TOO_OLD_MESSAGE);

  // --- resolve the group + anchor ------------------------------------------
  const groups = services.resolvedGroups<Text2VoiceMeta>(TEXT2VOICE_VOICE_META_KEY);
  const group = groups.find((g) => g.members.some((m) => m.track.handle.id === track.handle.id));
  const anchorMember = group
    ? group.members.find((m) => m.meta.voiceIndex === 0) ?? group.members[0]
    : null;
  const anchorDbId = anchorMember ? anchorMember.dbId : services.engineToDbId(track.handle.id);

  const configKey = services.trackDataKey(anchorDbId, TEXT2VOICE_CONFIG_KEY);
  const compositionKey = services.trackDataKey(anchorDbId, TEXT2VOICE_COMPOSITION_KEY);

  const config =
    asText2VoiceConfig(await host.getSceneData(scene, configKey).catch(() => null)) ?? DEFAULT_CONFIG;

  if (!config.text.trim()) {
    throw new Error('Paste some text first — Text2Voice sings words from the text you supply.');
  }

  // --- musical context ------------------------------------------------------
  const musical = await host.getMusicalContext();
  const meter = panelMeter(musical);
  const qnPerBar = panelQuarterNotesPerBar(musical);
  const bars = musical.bars;
  const totalBeats = bars * qnPerBar;
  const bpm = musical.bpm;

  const cached = asText2VoiceComposition(
    await host.getSceneData(scene, compositionKey).catch(() => null),
  );

  let composition: Text2VoiceComposition;

  if (compositionIsReusable(cached, config, bpm, bars) && cached) {
    // Re-render only: character / system voice changed, not the music.
    composition = cached;
  } else {
    composition = await composeFromText(host, config, {
      key: musical.key,
      mode: musical.mode,
      bpm,
      bars,
      timeSignature: meter,
      quarterNotesPerBar: qnPerBar,
      chordSummary: summarizeChords(musical.chordProgression),
      totalBeats,
    });
    await host.setSceneData(scene, compositionKey, composition).catch(() => {});
  }

  // --- delivery: which syllable lands on which note -------------------------
  const assignments = assignSyllables(
    composition.voices,
    composition.syllables.length,
    config.delivery,
  );

  // --- reconcile the track set to the voice count ---------------------------
  const existing = group
    ? group.members.map((m) => ({
        dbId: m.dbId,
        engineId: m.track.handle.id,
        voiceIndex: m.meta.voiceIndex,
      }))
    : [{ dbId: anchorDbId, engineId: track.handle.id, voiceIndex: 0 }];

  const plan = planReconcile(existing, composition.voices.length);

  if (services.tracks.length + plan.createBucketIndexes.length > TEXT2VOICE_MAX_TRACKS) {
    throw new Error(
      `Text2Voice is limited to ${TEXT2VOICE_MAX_TRACKS} tracks — reduce the voice count.`,
    );
  }

  const created: PluginTrackHandle[] = [];
  const lanes: Array<{ dbId: string; engineId: string; voiceIndex: number }> = [];

  try {
    for (const r of plan.reuse) lanes.push({ ...r, voiceIndex: r.bucketIndex });
    for (const bucketIndex of plan.createBucketIndexes) {
      const handle = await services.createFamilyTrack(`-v${bucketIndex}`);
      created.push(handle);
      lanes.push({ dbId: handle.dbId, engineId: handle.id, voiceIndex: bucketIndex });
    }
    lanes.sort((a, b) => a.voiceIndex - b.voiceIndex);

    // --- render + place, one voice at a time -------------------------------
    for (const lane of lanes) {
      const request = buildVocalLineRequest(
        assignments[lane.voiceIndex] ?? [],
        composition.syllables,
        config.character,
        lane.voiceIndex,
        composition.voices.length,
        bpm,
        totalBeats,
        config.ttsVoice,
      );
      if (request.syllables.length === 0) continue;

      const result = await vocalHost.renderVocalLine(request);
      await host.writeAudioClip(lane.engineId, result.filePath);
      // 'vocals' is already a first-class role, so no host change is needed.
      await host.setTrackRole?.(lane.engineId, 'vocals').catch(() => {});
      // Spawn muted, like every other family — the user unmutes deliberately.
      await host.setTrackMute(lane.engineId, true).catch(() => {});

      if (result.unvoicedIndices.length >= request.syllables.length) {
        host.showToast(
          'info',
          `${voiceLabel(lane.voiceIndex)} rendered as breath`,
          'That speech voice is almost entirely unvoiced, so it carries no pitch. Pick another voice for a melodic line.',
        );
      }
    }

    // --- metas + config last ------------------------------------------------
    for (const lane of lanes) {
      const meta: Text2VoiceMeta = {
        groupId: anchorDbId,
        voiceIndex: lane.voiceIndex,
        label: voiceLabel(lane.voiceIndex),
      };
      await host.setSceneData(scene, services.trackDataKey(lane.dbId, TEXT2VOICE_VOICE_META_KEY), meta);
    }
    await host.setSceneData(scene, configKey, { ...config, voiceCount: composition.voices.length });
  } catch (err) {
    // LIFO rollback: only tracks THIS run created.
    for (const handle of [...created].reverse()) {
      await host.deleteTrack(handle.id).catch(() => {});
      await host
        .deleteSceneData(scene, services.trackDataKey(handle.dbId, TEXT2VOICE_VOICE_META_KEY))
        .catch(() => {});
    }
    throw err;
  }

  // --- drop surplus voices --------------------------------------------------
  for (const surplus of plan.remove) {
    await host.deleteTrack(surplus.engineId).catch(() => {});
    await host
      .deleteSceneData(scene, services.trackDataKey(surplus.dbId, TEXT2VOICE_VOICE_META_KEY))
      .catch(() => {});
  }

  services.updateTrack(track.handle.id, (t) => ({ ...t, prompt: composition.phrase }));
  await services.reloadTracks(true);
}

// ---------------------------------------------------------------------------
// Composition — the single model call
// ---------------------------------------------------------------------------

interface SceneShape {
  key: string;
  mode: string;
  bpm: number;
  bars: number;
  timeSignature: string;
  quarterNotesPerBar: number;
  chordSummary: string;
  totalBeats: number;
}

function summarizeChords(
  progression: Array<{ symbol: string; startQn: number; endQn: number }> | undefined,
): string {
  if (!progression || progression.length === 0) return 'none supplied — stay in key';
  const seen: string[] = [];
  for (const c of progression) {
    if (seen[seen.length - 1] !== c.symbol) seen.push(c.symbol);
  }
  return seen.slice(0, 16).join(' → ');
}

async function composeFromText(
  host: GenerationServices['host'],
  config: Text2VoiceConfig,
  shape: SceneShape,
): Promise<Text2VoiceComposition> {
  const budget = syllableBudget(shape.bars, shape.quarterNotesPerBar, config.notesPerBeat);
  const ctx: PromptContext = {
    text: config.text,
    harmony: config.harmony,
    delivery: config.delivery,
    voiceCount: config.voiceCount,
    syllableBudget: budget,
    key: shape.key,
    mode: shape.mode,
    bpm: shape.bpm,
    bars: shape.bars,
    timeSignature: shape.timeSignature,
    quarterNotesPerBar: shape.quarterNotesPerBar,
    chordSummary: shape.chordSummary,
    notesPerBeat: config.notesPerBeat,
  };

  const request: LLMToolUseRequest = {
    model: TEXT2VOICE_MODEL,
    systemInstruction: { parts: [{ text: buildText2VoiceSystemPrompt(ctx) }] },
    contents: [{ role: 'user', parts: [{ text: buildText2VoiceUserPrompt(ctx) }] }],
    tools: [{ functionDeclarations: [buildSubmitText2VoiceTool(config.harmony, config.voiceCount)] }],
    toolConfig: {
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [SUBMIT_TEXT2VOICE_TOOL_NAME] },
    },
    generationConfig: {
      temperature: TEXT2VOICE_TEMPERATURE,
      maxOutputTokens: TEXT2VOICE_MAX_OUTPUT_TOKENS,
    },
  };

  const response = await host.generateWithLLMTools(request);
  let args: unknown = null;
  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.functionCall && part.functionCall.name === SUBMIT_TEXT2VOICE_TOOL_NAME) {
        args = part.functionCall.args;
      }
    }
  }
  if (args === null) {
    // Truncation is a STRUCTURAL signal the host already carries; it needs the
    // opposite advice from "the model declined", so read it rather than
    // guessing from the message text.
    if (response.candidates?.some((c) => c.finishReason === 'MAX_TOKENS')) {
      throw new Error(
        `The model used its entire ${TEXT2VOICE_MAX_OUTPUT_TOKENS}-token budget before submitting. ` +
          'Try fewer voices or a shorter scene — rephrasing will not help.',
      );
    }
    throw new Error('The model returned no setting — try different text or another harmony style.');
  }

  const parsed = parseText2VoiceArgs(args);

  // The phrase must be QUOTED from the user's text, not written about it.
  const inSource = validatePhraseInSource(parsed.phrase, config.text);
  if (!inSource.ok) {
    throw new Error(
      `The model did not quote your text (${inSource.reason}). Try again, or use a longer passage.`,
    );
  }
  const splitOk = validateSyllableSplit(parsed.syllables, parsed.phrase);
  if (!splitOk.ok) {
    throw new Error(`The syllable split was unusable (${splitOk.reason}). Try generating again.`);
  }

  // --- grid -> notes --------------------------------------------------------
  const wanted = composedVoiceCount(config.harmony, config.voiceCount);
  const composedVoices: PluginMidiNote[][] = [];
  const composedSyllableIdx: number[][] = [];
  for (let v = 0; v < wanted; v++) {
    const gv = parsed.voices[v] ?? parsed.voices[0];
    if (!gv) throw new CompositionError('no voice lines returned');
    composedVoices.push(
      gridVoiceToNotes(gv, parsed.rhythm, shape.key, shape.mode, v, config.voiceCount, shape.totalBeats),
    );
    composedSyllableIdx.push(slotSyllableIndexes(gv, parsed.rhythm, shape.totalBeats));
  }

  // --- harmony: derived styles fan out from the lead ------------------------
  const tonicPc = tonicPcFor(shape.key) ?? 0;
  let voices: PluginMidiNote[][];
  if (isComposedHarmony(config.harmony)) {
    voices = composedVoices;
  } else {
    voices = deriveHarmonyVoices(
      composedVoices[0],
      config.harmony,
      config.voiceCount,
      tonicPc,
      shape.totalBeats,
    );
  }

  // --- strict 1:1 syllables <-> notes on the LEAD ---------------------------
  // The lead defines how much text actually fits; the other voices follow its
  // note count through the delivery assignment.
  const leadSyllables = composedSyllableIdx[0].map((i) => parsed.syllables[i]).filter(Boolean);
  const reconciled = reconcileSyllablesToNotes(leadSyllables, voices[0]);
  voices[0] = reconciled.notes;

  return {
    phrase: parsed.phrase,
    syllables: reconciled.syllables,
    voices,
    bpm: shape.bpm,
    bars: shape.bars,
    harmony: config.harmony,
    delivery: config.delivery,
  };
}
