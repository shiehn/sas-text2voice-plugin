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
  sustainAssignments,
  type VoiceSyllableAssignment,
} from './harmony-styles';
import {
  CompositionError,
  gridVoiceToNotes,
  normalizeToRegister,
  parseText2VoiceArgs,
  foldMelismaRuns,
} from './compose';
import { alignVoiceToSlots, distributeSyllables, melodyCapacity } from './distribute';
import {
  buildLyricsSystemPrompt,
  buildSubmitLyricsTool,
  buildSubmitText2VoiceTool,
  buildSubmitWordsTool,
  buildText2VoiceSystemPrompt,
  buildText2VoiceUserPrompt,
  buildWordsSystemPrompt,
  buildWordsUserPrompt,
  composedVoiceCount,
  melodyNoteBudget,
  SUBMIT_LYRICS_TOOL_NAME,
  SUBMIT_TEXT2VOICE_TOOL_NAME,
  SUBMIT_WORDS_TOOL_NAME,
  type PromptContext,
} from './prompt';
import { buildVocalLineRequest } from './render-spec';
import {
  syllableBudget,
  syllableWordSpans,
  validatePhraseInSource,
  validateSyllableSplit,
} from './syllables';
import { applyBreathGuard, breathLimitsForBpm, detectPhrases } from './phrases';
import { materializeLines, phraseBudgets } from './lyrics';
import { buildAdlibEchoes, buildInhales } from './adlib';
import {
  DEFAULT_REGISTER,
  DEFAULT_REALISM,
  DEFAULT_RHYTHM_RANGE,
  expressionFor,
  laneMixFor,
  laneRolesFor,
  roleLabel,
  STYLES,
  SUNG_TREATMENT,
  type LaneRole,
} from './styles';
import { tonicPcFor } from './music-helpers';
import { asVocalHost, HOST_TOO_OLD_MESSAGE } from './host-vocal';
import { isPercussiveRole, monophonize, supportsMelodyImport, type ImportHost } from './import-melody';
import {
  asText2VoiceConfig,
  asText2VoiceMelody,
  asText2VoiceWords,
  planGeneration,
  planReconcile,
  TEXT2VOICE_CONFIG_KEY,
  TEXT2VOICE_FORCE_KEY,
  TEXT2VOICE_MELODY_KEY,
  TEXT2VOICE_VOICE_META_KEY,
  TEXT2VOICE_WORDS_KEY,
  type GenerationMode,
  type SceneShapeKey,
  type Text2VoiceConfig,
  type Text2VoiceMelody,
  type Text2VoiceMeta,
  type Text2VoiceWords,
} from './voice-meta';

export const TEXT2VOICE_MAX_TRACKS = 16;
export const TEXT2VOICE_MODEL = 'gemini-3.1-pro-preview';
export const TEXT2VOICE_MAX_OUTPUT_TOKENS = 49152;
export const TEXT2VOICE_TEMPERATURE = 0.9;
/** The reword call returns a phrase and a split — a fraction of a full setting. */
export const TEXT2VOICE_REWORD_TOKENS = 4096;

const DEFAULT_CONFIG: Text2VoiceConfig = {
  text: '',
  harmony: 'choral',
  delivery: 'unison',
  character: 'choir',
  voiceCount: 3,
  notesPerBeat: 2,
};

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
  const melodyKey = services.trackDataKey(anchorDbId, TEXT2VOICE_MELODY_KEY);
  const wordsKey = services.trackDataKey(anchorDbId, TEXT2VOICE_WORDS_KEY);

  const config =
    asText2VoiceConfig(await host.getSceneData(scene, configKey).catch(() => null)) ?? DEFAULT_CONFIG;

  const writeMode = config.sourceMode === 'write';
  if (writeMode) {
    if (!(config.topic ?? '').trim()) {
      throw new Error('Give it a topic first — Write mode invents lyrics about something.');
    }
  } else if (!config.text.trim()) {
    throw new Error('Paste some text first — Text2Voice sings words from the text you supply.');
  }

  // --- musical context ------------------------------------------------------
  const musical = await host.getMusicalContext();
  const meter = panelMeter(musical);
  const qnPerBar = panelQuarterNotesPerBar(musical);
  const bars = musical.bars;
  const totalBeats = bars * qnPerBar;
  const bpm = musical.bpm;

  const melody = asText2VoiceMelody(
    await host.getSceneData(scene, melodyKey).catch(() => null),
  );
  const words = asText2VoiceWords(await host.getSceneData(scene, wordsKey).catch(() => null));

  // The one-shot "compose new music" request lives under its OWN key and is
  // consumed HERE, before any expensive work — as a config field it used to
  // latch forever when a run threw, silently recomposing on every later press.
  const forceKey = services.trackDataKey(anchorDbId, TEXT2VOICE_FORCE_KEY);
  const forceMelody =
    (await host.getSceneData(scene, forceKey).catch(() => null)) === true;
  if (forceMelody) {
    await host.deleteSceneData(scene, forceKey).catch(() => {});
  }

  // Quote mode: a phrase no longer present in the (edited) text has to be
  // replaced; one still present is kept. Write mode ignores the pasted text
  // entirely — its reusability is provenance (topic/rhyme), checked in
  // wordsReusable via the planner.
  const phraseStillInSource =
    !writeMode && words ? validatePhraseInSource(words.phrase, config.text).ok : false;

  const sceneShape: SceneShapeKey = {
    bpm,
    bars,
    key: musical.key,
    mode: musical.mode,
    quarterNotesPerBar: qnPerBar,
  };

  const mode: GenerationMode = planGeneration({
    melody,
    words,
    config,
    scene: sceneShape,
    phraseStillInSource,
    forceMelody,
  });

  let finalMelody: Text2VoiceMelody;
  let finalWords: Text2VoiceWords;

  if (mode === 'import') {
    // A mechanical read, no model: the chosen track's MIDI becomes the lead.
    if (!supportsMelodyImport(host)) {
      throw new Error('This host cannot read other tracks — update the app to sing an existing track.');
    }
    const sourceDbId = config.importedTrackDbId;
    if (!sourceDbId) {
      throw new Error('Pick a track to sing first.');
    }
    const importHost = host as unknown as Required<ImportHost>;
    const midi = await importHost.readImportableTrackMidi(sourceDbId);
    const lead = monophonize(midi.clips ?? [], totalBeats);
    if (lead.length === 0) {
      throw new Error('That track has no MIDI in this scene — pick one with notes.');
    }
    const summaries = await importHost.listSceneTracks().catch(() => []);
    const source = summaries.find((t) => t.dbId === sourceDbId);
    if (isPercussiveRole(source?.role)) {
      host.showToast(
        'info',
        'Singing a drum line',
        'A percussive track monophonizes to a one-pitch chant — deliberate weirdness, but a melodic track sings better.',
      );
    }
    finalMelody = {
      voices: [lead],
      composedHarmony: null,
      bpm,
      bars,
      key: musical.key,
      mode: musical.mode,
      quarterNotesPerBar: qnPerBar,
      importedFrom: sourceDbId,
    };
    await host.setSceneData(scene, melodyKey, finalMelody).catch(() => {});
    // Fresh melody, fresh capacity — the words always refit after an import.
    finalWords = writeMode
      ? await writeLyricsOntoMelody(host, config, finalMelody, bpm, totalBeats)
      : await rewordOntoMelody(
          host,
          config,
          melodyCapacity(finalMelody.voices[0], config.notesPerBeat),
        );
    await host.setSceneData(scene, wordsKey, finalWords).catch(() => {});
  } else if (mode === 'compose') {
    const composed = await composeFromText(host, config, {
      key: musical.key,
      mode: musical.mode,
      bpm,
      bars,
      timeSignature: meter,
      quarterNotesPerBar: qnPerBar,
      chordSummary: summarizeChords(musical.chordProgression),
      totalBeats,
    });
    finalMelody = composed.melody;
    finalWords = composed.words;
    await host.setSceneData(scene, melodyKey, finalMelody).catch(() => {});
    await host.setSceneData(scene, wordsKey, finalWords).catch(() => {});
  } else if (mode === 'reword') {
    // The melody survives; only the words are re-chosen. The capacity target is
    // computed LIVE at the current pace — a stored count went stale the moment
    // the user touched the Pace control.
    finalMelody = melody as Text2VoiceMelody;
    finalWords = writeMode
      ? await writeLyricsOntoMelody(host, config, finalMelody, bpm, totalBeats)
      : await rewordOntoMelody(
          host,
          config,
          melodyCapacity(finalMelody.voices[0], config.notesPerBeat),
        );
    await host.setSceneData(scene, wordsKey, finalWords).catch(() => {});
  } else {
    finalMelody = melody as Text2VoiceMelody;
    finalWords = words as Text2VoiceWords;
  }

  // Octave-normalize into the ACTIVE style's register first: cached melodies
  // survive style flips by design, so a choir-era lead (centred high) must
  // land in trap's speech register mechanically — key- and interval-preserving,
  // no model call.
  const register = config.style ? STYLES[config.style].register : DEFAULT_REGISTER;
  const registeredVoices = normalizeToRegister(finalMelody.voices, register);

  // Spread the phrase across the melody. The LEAD's subdivided slots become
  // the syllable timeline; every other voice supplies pitch at those moments,
  // so unison and choral stay locked together.
  const syllables = finalWords.syllables;
  // Melisma runs fold FIRST: a marked continuation note merges into its head
  // as extra pitch targets, and the folded note is one indivisible slot.
  const leadLine = foldMelismaRuns(registeredVoices[0]);
  const spread = distributeSyllables(
    leadLine,
    syllables.length,
    config.notesPerBeat,
  );

  // Breath guard: nobody sings longer than a lungful. Carves catch-breath
  // gaps INSIDE over-long runs (durations only — the slots↔syllables mapping
  // is untouched). Carved boundaries are 'breath', invisible to phrase-final
  // machinery like shouts, echoes and rhymes.
  const { maxBreathBeats, breathBeats } = breathLimitsForBpm(bpm);
  const guard = applyBreathGuard(spread.notes, maxBreathBeats, breathBeats);
  const leadSlots = guard.slots;
  const phrases = detectPhrases(leadSlots, totalBeats, guard.breathAfterSlot);
  if (guard.carved > 0) {
    host.showToast(
      'info',
      `${guard.carved} breath${guard.carved === 1 ? '' : 's'} carved`,
      'A phrase ran longer than a singer could hold — short catch-breath gaps were opened mid-line.',
    );
  }

  // Harmony voices are RENDER-TIME for derived styles: the cache holds only
  // the composed lead, and the fan-out (unison / organum / drone) is recomputed
  // here — which is what makes flipping styles free.
  const composed = isComposedHarmony(config.harmony);
  const harmonyVoices: PluginMidiNote[][] = composed
    ? registeredVoices.slice(1)
    : deriveHarmonyVoices(
        leadLine,
        config.harmony,
        config.voiceCount,
        tonicPcFor(musical.key) ?? 0,
        totalBeats,
      ).slice(1);
  const laneCount = 1 + harmonyVoices.length;

  // Drone lanes SUSTAIN — one syllable held across the pedal tone. Aligning
  // them to the slot grid would chop the pedal into per-syllable re-attacks.
  const sustainLane = (v: PluginMidiNote[]): boolean =>
    !composed && config.harmony === 'drone' && v.length === 1;

  const voices: Array<Array<PluginMidiNote | null>> = [
    leadSlots,
    ...harmonyVoices.map((v) => (sustainLane(v) ? [] : alignVoiceToSlots(v, leadSlots))),
  ];

  // --- lane roles: derived fresh every run, stored nowhere ------------------
  const roles: LaneRole[] = laneRolesFor(config.style ?? null, config.harmony, laneCount);
  // Write-mode words rebuild their materialization against THESE phrases (the
  // deterministic same layout), yielding exact spans; quote mode recovers
  // spans from the validated split.
  const wordSpans =
    finalWords.source === 'write' && finalWords.lines
      ? materializeLines(finalWords.lines, finalWords.lineTexts ?? [], phrases).wordSpans
      : syllableWordSpans(finalWords.phrase, syllables);

  // --- delivery: which syllable lands on which note -------------------------
  const syllableCount = syllables.length;
  const assignments: VoiceSyllableAssignment[][] = assignSyllables(
    voices,
    syllableCount,
    config.delivery,
    {
      canonOffsetBeats: 2,
      sceneBeats: totalBeats,
      phrases,
      wordSpans,
      shoutLanes: roles.map((r) => r === 'group'),
    },
  );
  // Sustain lanes bypass the grid: their one long note holds the first syllable.
  harmonyVoices.forEach((v, i) => {
    if (sustainLane(v)) assignments[i + 1] = sustainAssignments(v, 0);
  });
  // Adlib lanes ignore the delivery entirely: they echo phrase-final words
  // into the gaps, quieter and panned wide (mix carried by the TRACK, since
  // each rendered lane is peak-normalized).
  roles.forEach((role, i) => {
    if (role === 'adlib') {
      assignments[i] = buildAdlibEchoes(leadSlots, phrases, wordSpans, syllableCount);
    }
  });
  // Tag-team shouts hit harder than the lane's verse: an intra-lane accent
  // (per-lane loudness itself rides track volume — lanes peak-normalize).
  if (config.delivery === 'tagteam') {
    roles.forEach((role, i) => {
      if (role !== 'group') return;
      assignments[i] = assignments[i].map((a) =>
        a.syllableIndex === null ? a : { ...a, treatment: { ...a.treatment, gain: 1.6 } },
      );
    });
  }
  // Breathy styles inhale audibly before phrases with room for it — the
  // reversed-exhale trick through the renderer's raw path.
  if (config.style && STYLES[config.style].audibleInhales) {
    assignments[0] = [...assignments[0], ...buildInhales(phrases)];
  }

  if (spread.dropped > 0) {
    host.showToast(
      'info',
      'Phrase trimmed to fit',
      `${spread.dropped} syllable(s) did not fit the melody. Use a longer scene, a denser ` +
        'rate, or a shorter phrase.',
    );
  }

  // --- reconcile the track set to the voice count ---------------------------
  const existing = group
    ? group.members.map((m) => ({
        dbId: m.dbId,
        engineId: m.track.handle.id,
        voiceIndex: m.meta.voiceIndex,
      }))
    : [{ dbId: anchorDbId, engineId: track.handle.id, voiceIndex: 0 }];

  const plan = planReconcile(existing, laneCount);

  if (services.tracks.length + plan.createBucketIndexes.length > TEXT2VOICE_MAX_TRACKS) {
    throw new Error(
      `Text2Voice is limited to ${TEXT2VOICE_MAX_TRACKS} tracks — reduce the voice count.`,
    );
  }

  const created: PluginTrackHandle[] = [];
  const lanes: Array<{ dbId: string; engineId: string; voiceIndex: number }> = [];
  const silentLanes: string[] = [];
  const laneName = (i: number): string => roleLabel(roles[i] ?? 'group', i);

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
        syllables,
        config.character,
        lane.voiceIndex,
        laneCount,
        bpm,
        totalBeats,
        config.ttsVoice,
        config.style ? STYLES[config.style].treatment : SUNG_TREATMENT,
        {
          expression: expressionFor(config.style ?? null),
          realism: config.realism ?? DEFAULT_REALISM,
          // Distinct prime-spaced seeds per lane: unison clones decorrelate
          // into a section; the same lane re-renders bit-identically.
          laneSeed: lane.voiceIndex * 7919 + 1,
          wordSpans,
          stress: finalWords.stress ?? null,
        },
      );
      const mix = laneMixFor(roles[lane.voiceIndex] ?? 'group', lane.voiceIndex);
      // Mix is applied to EVERY lane EVERY run, resets included: reconcile
      // reuses tracks positionally, so a lane that was an adlib last run
      // would otherwise keep its wide pan into its new life as a chorister.
      await host.setTrackVolume(lane.engineId, mix.volume).catch(() => {});
      await host.setTrackPan(lane.engineId, mix.pan).catch(() => {});

      if (request.syllables.length === 0) {
        // A lane that falls silent this run (canon offset past the phrase,
        // hocket with more voices than syllables) must not keep LAST run's
        // audio playing. There is no clear-clip host call, so mute it and say
        // so — an honest silence.
        await host.setTrackMute(lane.engineId, true).catch(() => {});
        await host.setTrackRole?.(lane.engineId, 'vocals').catch(() => {});
        silentLanes.push(laneName(lane.voiceIndex));
        continue;
      }

      const result = await vocalHost.renderVocalLine(request);
      await host.writeAudioClip(lane.engineId, result.filePath);
      // 'vocals' is already a first-class role, so no host change is needed.
      await host.setTrackRole?.(lane.engineId, 'vocals').catch(() => {});
      // Only lanes CREATED this run spawn muted — re-muting a reused lane the
      // user deliberately unmuted reads as "the render failed".
      if (created.some((c) => c.id === lane.engineId)) {
        await host.setTrackMute(lane.engineId, true).catch(() => {});
      }

      if (result.unvoicedIndices.length >= request.syllables.length) {
        host.showToast(
          'info',
          `${laneName(lane.voiceIndex)} rendered as breath`,
          'That speech voice is almost entirely unvoiced, so it carries no pitch. Pick another voice for a melodic line.',
        );
      }
    }

    if (silentLanes.length > 0) {
      host.showToast(
        'info',
        `${silentLanes.length} lane(s) silent this arrangement`,
        `${silentLanes.join(', ')} had nothing to sing and were muted.`,
      );
    }

    // --- metas + config last ------------------------------------------------
    for (const lane of lanes) {
      const meta: Text2VoiceMeta = {
        groupId: anchorDbId,
        voiceIndex: lane.voiceIndex,
        label: laneName(lane.voiceIndex),
      };
      await host.setSceneData(scene, services.trackDataKey(lane.dbId, TEXT2VOICE_VOICE_META_KEY), meta);
    }
    await host.setSceneData(scene, configKey, { ...config, voiceCount: laneCount });
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

  services.updateTrack(track.handle.id, (t) => ({ ...t, prompt: finalWords.phrase }));

  // Say what ACTUALLY happened — the button predicted it; this confirms it.
  const roleSummary = roles.map((r, i) => roleLabel(r, i)).join(' · ');
  const RAN: Record<GenerationMode, string> = {
    compose: 'Composed new music and new words',
    import: 'Read the track as the melody and fitted words to it',
    reword: 'Kept the melody — new words fitted to it',
    render: 'Re-rendered the voices only (no model call)',
  };
  host.showToast('success', RAN[mode], `Lanes: ${roleSummary}`);

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

/** Pull the one expected function call out of a tool-use response. */
function extractCall(
  response: { candidates?: Array<{ content?: { parts?: Array<{ functionCall?: { name?: string; args?: unknown } }> }; finishReason?: string }> },
  name: string,
  budget: number,
): unknown {
  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.functionCall && part.functionCall.name === name) return part.functionCall.args;
    }
  }
  // Truncation is a STRUCTURAL signal the host already carries; it needs the
  // opposite advice from "the model declined", so read it rather than guessing
  // from the message text.
  if (response.candidates?.some((c) => c.finishReason === 'MAX_TOKENS')) {
    throw new Error(
      `The model used its entire ${budget}-token budget before submitting. ` +
        'Try fewer voices or a shorter scene — rephrasing will not help.',
    );
  }
  return null;
}

/**
 * Choose new words for a melody that already exists.
 *
 * This is the cheap path: no harmony, no rhythm, no registers — just a phrase
 * of the right length. It is what makes editing the source text affordable once
 * the music is written.
 */
async function rewordOntoMelody(
  host: GenerationServices['host'],
  config: Text2VoiceConfig,
  slotCount: number,
): Promise<Text2VoiceWords> {
  const request: LLMToolUseRequest = {
    model: TEXT2VOICE_MODEL,
    systemInstruction: { parts: [{ text: buildWordsSystemPrompt(slotCount) }] },
    contents: [{ role: 'user', parts: [{ text: buildWordsUserPrompt(config.text, slotCount) }] }],
    tools: [{ functionDeclarations: [buildSubmitWordsTool(slotCount)] }],
    toolConfig: {
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [SUBMIT_WORDS_TOOL_NAME] },
    },
    generationConfig: { temperature: TEXT2VOICE_TEMPERATURE, maxOutputTokens: TEXT2VOICE_REWORD_TOKENS },
  };

  const response = await host.generateWithLLMTools(request);
  const args = extractCall(response, SUBMIT_WORDS_TOOL_NAME, TEXT2VOICE_REWORD_TOKENS);
  if (!args || typeof args !== 'object') {
    throw new Error('The model returned no phrase — try different text.');
  }
  const a = args as Record<string, unknown>;
  const phrase = typeof a.phrase === 'string' ? a.phrase.trim() : '';
  const syllables = (Array.isArray(a.syllables) ? a.syllables : [])
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);

  if (!phrase || syllables.length === 0) {
    throw new Error('The model returned an empty phrase — try different text.');
  }
  const inSource = validatePhraseInSource(phrase, config.text);
  if (!inSource.ok) {
    throw new Error(`The model did not quote your text (${inSource.reason}). Try again.`);
  }
  const splitOk = validateSyllableSplit(syllables, phrase);
  if (!splitOk.ok) {
    throw new Error(`The syllable split was unusable (${splitOk.reason}). Try generating again.`);
  }
  // A length mismatch is NOT fatal — a short phrase loops onto the melody, a
  // long one is trimmed and reported — so it is left to the distribution layer
  // rather than failing the whole run.
  let stress: number[] | undefined;
  if (Array.isArray(a.stress) && a.stress.length === syllables.length) {
    const cleaned = a.stress.map((v: unknown) => (v === 1 || v === true ? 1 : 0));
    if (cleaned.some((v: number) => v === 1)) stress = cleaned;
  }
  return { phrase, syllables, source: 'quote', ...(stress ? { stress } : {}) };
}

/**
 * Write mode's words call: original lyrics about the topic, fitted to the
 * melody's phrase structure with rhyme targets on phrase-final syllables.
 *
 * The provisional pass runs the SAME pipeline the render will (distribute at
 * live capacity → breath guard → detect phrases), so the materialized 1:1
 * syllable list lines up slot-for-slot when the render recomputes it.
 */
async function writeLyricsOntoMelody(
  host: GenerationServices['host'],
  config: Text2VoiceConfig,
  melody: Text2VoiceMelody,
  bpm: number,
  totalBeats: number,
): Promise<Text2VoiceWords> {
  const capacity = melodyCapacity(melody.voices[0], config.notesPerBeat);
  const provisional = distributeSyllables(melody.voices[0], capacity, config.notesPerBeat);
  const { maxBreathBeats, breathBeats } = breathLimitsForBpm(bpm);
  const guarded = applyBreathGuard(provisional.notes, maxBreathBeats, breathBeats);
  const phrases = detectPhrases(guarded.slots, totalBeats, guarded.breathAfterSlot);

  const scheme = config.rhymeScheme ?? 'none';
  const { budgets, effectiveScheme } = phraseBudgets(phrases, scheme);
  if (scheme !== 'none' && effectiveScheme !== scheme) {
    host.showToast(
      'info',
      `Rhyme degraded to ${effectiveScheme === 'pairs' ? 'pairs' : 'none'}`,
      `${scheme} needs at least four phrases; this melody has ${phrases.filter((p) => p.boundary === 'rest').length}. Use ♪ New music for a melody with more phrases.`,
    );
  }

  const request: LLMToolUseRequest = {
    model: TEXT2VOICE_MODEL,
    systemInstruction: {
      parts: [
        {
          text: buildLyricsSystemPrompt(
            (config.topic ?? '').trim(),
            budgets,
            effectiveScheme,
            config.style ? STYLES[config.style].promptPack : [],
          ),
        },
      ],
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: `Write the ${budgets.length} lines about: ${(config.topic ?? '').trim()}` }],
      },
    ],
    tools: [{ functionDeclarations: [buildSubmitLyricsTool(budgets)] }],
    toolConfig: {
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [SUBMIT_LYRICS_TOOL_NAME] },
    },
    generationConfig: { temperature: TEXT2VOICE_TEMPERATURE, maxOutputTokens: TEXT2VOICE_REWORD_TOKENS },
  };

  const response = await host.generateWithLLMTools(request);
  const args = extractCall(response, SUBMIT_LYRICS_TOOL_NAME, TEXT2VOICE_REWORD_TOKENS);
  if (!args || typeof args !== 'object') {
    throw new Error('The model returned no lyrics — try a different topic.');
  }
  const rawLines = (args as { lines?: unknown }).lines;
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw new Error('The model returned no lyric lines — try a different topic.');
  }
  const lines: string[][] = [];
  const lineTexts: string[] = [];
  for (const rl of rawLines) {
    if (!rl || typeof rl !== 'object') continue;
    const l = rl as { text?: unknown; syllables?: unknown };
    const syls = Array.isArray(l.syllables)
      ? l.syllables.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : [];
    if (syls.length === 0) continue;
    const text = typeof l.text === 'string' && l.text.trim() ? l.text.trim() : syls.join('');
    // The split must reassemble into its line — same honesty rule as quotes.
    if (!validateSyllableSplit(syls, text).ok) continue;
    lines.push(syls);
    lineTexts.push(text);
  }
  if (lines.length === 0) {
    throw new Error('None of the returned lines were usable — try generating again.');
  }

  const materialized = materializeLines(lines, lineTexts, phrases);
  return {
    phrase: materialized.phrase,
    syllables: materialized.syllables,
    source: 'write',
    topic: (config.topic ?? '').trim(),
    rhymeScheme: scheme,
    lines,
    lineTexts,
  };
}

async function composeFromText(
  host: GenerationServices['host'],
  config: Text2VoiceConfig,
  shape: SceneShape,
): Promise<{ melody: Text2VoiceMelody; words: Text2VoiceWords }> {
  const budget = syllableBudget(shape.bars, shape.quarterNotesPerBar, config.notesPerBeat);
  const writeMode = config.sourceMode === 'write';
  const ctx: PromptContext = {
    text: writeMode
      ? `WRITE ORIGINAL LYRICS about this topic (do not quote anything): ${(config.topic ?? '').trim()}` +
        (config.rhymeScheme && config.rhymeScheme !== 'none'
          ? `\nWrite at least four phrases (rest-separated) so an ${config.rhymeScheme} rhyme scheme can land; favor end-rhyme.`
          : '')
      : config.text,
    harmony: config.harmony,
    delivery: config.delivery,
    voiceCount: config.voiceCount,
    stylePack: config.style ? STYLES[config.style].promptPack : [],
    rhythmRange: config.style ? STYLES[config.style].rhythmRange : DEFAULT_RHYTHM_RANGE,
    register: config.style ? STYLES[config.style].register : DEFAULT_REGISTER,
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
    tools: [
      {
        functionDeclarations: [
          buildSubmitText2VoiceTool(
            config.harmony,
            config.voiceCount,
            melodyNoteBudget(
              shape.bars,
              shape.quarterNotesPerBar,
              config.style ? STYLES[config.style].rhythmRange : DEFAULT_RHYTHM_RANGE,
            ),
            config.style ? STYLES[config.style].rhythmRange : DEFAULT_RHYTHM_RANGE,
          ),
        ],
      },
    ],
    toolConfig: {
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [SUBMIT_TEXT2VOICE_TOOL_NAME] },
    },
    generationConfig: {
      temperature: TEXT2VOICE_TEMPERATURE,
      maxOutputTokens: TEXT2VOICE_MAX_OUTPUT_TOKENS,
    },
  };

  const response = await host.generateWithLLMTools(request);
  const args = extractCall(response, SUBMIT_TEXT2VOICE_TOOL_NAME, TEXT2VOICE_MAX_OUTPUT_TOKENS);
  if (args === null) {
    throw new Error('The model returned no setting — try different text or another harmony style.');
  }

  const parsed = parseText2VoiceArgs(args);

  // Quote mode: the phrase must be QUOTED, not written about. Write mode
  // INVENTS by design, so the in-source gate would reject exactly the output
  // we asked for.
  if (config.sourceMode !== 'write') {
    const inSource = validatePhraseInSource(parsed.phrase, config.text);
    if (!inSource.ok) {
      throw new Error(
        `The model did not quote your text (${inSource.reason}). Try again, or use a longer passage.`,
      );
    }
  }
  const splitOk = validateSyllableSplit(parsed.syllables, parsed.phrase);
  if (!splitOk.ok) {
    throw new Error(`The syllable split was unusable (${splitOk.reason}). Try generating again.`);
  }

  // --- grid -> melody notes -------------------------------------------------
  // These are MELODY notes now, not syllable slots: the phrase is spread over
  // them later, so a long note simply carries more text.
  const wanted = composedVoiceCount(config.harmony, config.voiceCount);
  const styleRegister = config.style ? STYLES[config.style].register : DEFAULT_REGISTER;
  const composedVoices: PluginMidiNote[][] = [];
  for (let v = 0; v < wanted; v++) {
    const gv = parsed.voices[v] ?? parsed.voices[0];
    if (!gv) throw new CompositionError('no voice lines returned');
    composedVoices.push(
      gridVoiceToNotes(
        gv,
        parsed.rhythm,
        shape.key,
        shape.mode,
        v,
        config.voiceCount,
        shape.totalBeats,
        styleRegister,
      ),
    );
  }
  if (composedVoices[0].length === 0) {
    throw new CompositionError('the melody was entirely rests');
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

  // Derived styles cache ONLY the lead: the fan-out is recomputed at every
  // render, so stale derived lines can never shadow a harmony change.
  const composed = isComposedHarmony(config.harmony);
  return {
    melody: {
      voices: composed ? voices : [voices[0]],
      composedHarmony: composed ? config.harmony : null,
      bpm: shape.bpm,
      bars: shape.bars,
      key: shape.key,
      mode: shape.mode,
      quarterNotesPerBar: shape.quarterNotesPerBar,
    },
    words: {
      phrase: parsed.phrase,
      syllables: parsed.syllables,
      ...(parsed.stress ? { stress: parsed.stress } : {}),
      source: config.sourceMode === 'write' ? 'write' : 'quote',
      ...(config.sourceMode === 'write'
        ? { topic: (config.topic ?? '').trim(), rhymeScheme: config.rhymeScheme ?? 'none' }
        : {}),
    },
  };
}
