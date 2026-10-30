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
  LLM_MODEL,
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
  buildSubmitText2VoiceTool,
  buildSubmitWordsTool,
  buildText2VoiceSystemPrompt,
  buildText2VoiceUserPrompt,
  buildWordsSystemPrompt,
  buildWordsUserPrompt,
  composedVoiceCount,
  linesNoteRange,
  melodyNoteBudget,
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
import { materializeLines } from './lyrics';
import { alignVoiceToFittedSlots, clampSlotPitches, fitLinesToLead, fittedWordSpans } from './line-fit';
import { budgetSpecFor } from './song-budget';
import { currentSection, NO_SECTION_WORDS_MESSAGE, recordRendered, wordsForLines, wordsMatchLines } from './song-lyrics';
import { songResultSummary, writeSceneWords, writeSongWords } from './song-writer';
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
  melodyIsReusable,
  planGeneration,
  planReconcile,
  TEXT2VOICE_CONFIG_KEY,
  TEXT2VOICE_FORCE_KEY,
  TEXT2VOICE_FORCE_WORDS_KEY,
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
export const TEXT2VOICE_MODEL = LLM_MODEL.BEST;
/**
 * ONE generous ceiling for every model call. Gemini's THINKING tokens share
 * maxOutputTokens (the ensemble 8/8-failure lesson), so a "right-sized"
 * budget for a small reply is a time bomb: the model reasons its way through
 * the budget and dies before emitting the tool call. A ceiling costs nothing
 * unless used — never differentiate budgets per call size again.
 */
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

export async function generateText2Voice(
  track: GeneratorTrackState,
  services: GenerationServices,
): Promise<void> {
  const host = services.host;
  // Progress reporting (SDK 3.11.0): the render loop reports before the first
  // lane and after every lane, with an honest bar floor of base + span·(done/total).
  const loopStep = (stage: string, label: string, done: number, total: number, base: number, span: number): void =>
    services.reportStep?.({
      stage,
      label,
      done,
      total,
      percentFloor: base + Math.round((span * done) / Math.max(total, 1)),
    });
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

  const storedConfig =
    asText2VoiceConfig(await host.getSceneData(scene, configKey).catch(() => null)) ?? DEFAULT_CONFIG;

  // The one-shot "✍ New words" request — delete-at-read, like force-melody.
  // Its `write` flag decides the FLAVOR of the next words operation: model
  // writes fresh lyrics from the prompt, or picks a fresh quote from the box.
  const forceWordsKey = services.trackDataKey(anchorDbId, TEXT2VOICE_FORCE_WORDS_KEY);
  const forceWordsRaw = await host.getSceneData(scene, forceWordsKey).catch(() => null);
  const forceWords =
    !!forceWordsRaw && typeof forceWordsRaw === 'object' && 'write' in forceWordsRaw;
  const forcedWrite = forceWords && (forceWordsRaw as { write?: unknown }).write === true;
  // S-443: ✍ in Song view writes the WHOLE song (the host's song lyric document).
  const forcedSong = forceWords && (forceWordsRaw as { song?: unknown }).song === true;
  if (forceWordsRaw !== null) {
    await host.deleteSceneData(scene, forceWordsKey).catch(() => {});
  }

  // The lyrics box is the standing source of truth; the write flavor exists
  // only inside the ✍ words-only branch below. The stored sourceMode field
  // survives for config compatibility but the pipeline is always quote.
  let config: typeof storedConfig = {
    ...storedConfig,
    sourceMode: forcedWrite ? 'write' : 'quote',
  };
  // S-443: Song view sings this scene's section of the song; the box is filled from it below.
  const songView = config.view === 'song';

  if (forcedSong) {
    // The writer checks what the song is about (the prompt, the song's description, the lyric context).
  } else if (forcedWrite) {
    if (!(config.topic ?? '').trim()) {
      throw new Error('Give ✍ a prompt first — it writes lyrics about something.');
    }
  } else if (!songView && !config.text.trim()) {
    throw new Error(
      'The lyrics box is empty — type words to sing, or use ✍ with a prompt to write some.',
    );
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
  let words = asText2VoiceWords(await host.getSceneData(scene, wordsKey).catch(() => null));

  // The one-shot "compose new music" request lives under its OWN key and is
  // consumed HERE, before any expensive work — as a config field it used to
  // latch forever when a run threw, silently recomposing on every later press.
  const forceKey = services.trackDataKey(anchorDbId, TEXT2VOICE_FORCE_KEY);
  const forceMelody =
    (await host.getSceneData(scene, forceKey).catch(() => null)) === true;
  if (forceMelody) {
    await host.deleteSceneData(scene, forceKey).catch(() => {});
  }

  // S-443 Song view: the box is this scene's section of the song. The host's
  // document is the truth (the Lyrics tab, the agent and Synth V write it too),
  // so its lines are read now and become the words (the model's split kept
  // for lines it wrote, a plain split for edited ones).
  let songSection: Extract<Awaited<ReturnType<typeof currentSection>>, { ok: true }> | null = null;
  // (A ✍ write is words-only and never sings: it does not read the section first.)
  if (songView && !forceWords) {
    const cur = await currentSection(host, scene, anchorDbId);
    if (!cur.ok) throw new Error(cur.reason);
    if (cur.lines.length === 0) throw new Error(NO_SECTION_WORDS_MESSAGE);
    const synced = wordsMatchLines(words, cur.lines)
      ? words
      : wordsForLines(cur.lines, words, { sectionId: cur.instanceId, rhymeScheme: config.rhymeScheme ?? 'none' });
    if (!synced) throw new Error(NO_SECTION_WORDS_MESSAGE);
    if (synced !== words) {
      words = synced;
      await host.setSceneData(scene, wordsKey, words).catch(() => {});
    }
    const sectionText = cur.lines.join('\n');
    if (config.text !== sectionText) {
      config = { ...config, text: sectionText };
      await host.setSceneData(scene, configKey, { ...storedConfig, text: sectionText }).catch(() => {});
    }
    if (cur.foreign) {
      host.showToast('info', 'Shared words', `${cur.label} is sung by another plugin's track too: Text2Voice sings the same words but cannot change them.`);
    }
    songSection = cur;
  }

  // The lyrics box is the source of truth: cached words survive exactly as
  // long as their phrase still occurs in it. Model-written lyrics were
  // populated INTO the box when generated, so one rule covers both origins.
  const phraseStillInSource =
    words !== null && validatePhraseInSource(words.phrase, config.text).ok;

  const sceneShape: SceneShapeKey = {
    bpm,
    bars,
    key: musical.key,
    mode: musical.mode,
    quarterNotesPerBar: qnPerBar,
  };

  // ✍ New words is a WORDS-ONLY act: it refreshes the words — and, when
  // written from a prompt, the lyrics box — then STOPS. Nothing renders;
  // Sing is the only button that sings. A stale melody is never fitted
  // against: words fall back to a scene-shaped grid and the next Sing
  // composes music around them.
  if (forceWords) {
    const usableMelody =
      melody && melodyIsReusable(melody, config, sceneShape) ? melody : null;
    if (forcedSong) {
      services.reportStep?.({ stage: 'compose', label: 'WRITING THE SONG...' });
      const result = await writeSongWords(host, {
        sceneId: scene,
        anchorDbId,
        config: { ...storedConfig, view: 'song' },
        melody: usableMelody,
        keyFor: services.trackDataKey,
      });
      host.showToast('success', 'Song written', songResultSummary(result));
      return;
    }
    const wordsMelody = usableMelody ?? syntheticWordsMelody(sceneShape, totalBeats);
    services.reportStep?.({ stage: 'compose', label: 'WRITING WORDS...' });
    // S-443: written words follow the bar budget (song-budget.ts), the lyric context as background.
    const newWords = forcedWrite
      ? (await writeSceneWords(host, { sceneId: scene, config, melody: usableMelody, bars })).words
      : await rewordOntoMelody(
          host,
          config,
          melodyCapacity(wordsMelody.voices[0], config.notesPerBeat),
        );
    await host.setSceneData(scene, wordsKey, newWords).catch(() => {});
    if (forcedWrite) {
      const lyricText = (
        newWords.lineTexts && newWords.lineTexts.length > 0
          ? newWords.lineTexts.join('\n')
          : newWords.phrase
      ).trim();
      if (lyricText) {
        await host
          .setSceneData(scene, configKey, {
            ...storedConfig,
            text: lyricText,
            sourceMode: 'quote' as const,
          })
          .catch(() => {});
      }
      host.showToast(
        'success',
        'Lyrics written',
        'They are in the lyrics box — edit freely, then press Sing.',
      );
    } else {
      const preview =
        newWords.phrase.length > 70 ? `${newWords.phrase.slice(0, 70)}…` : newWords.phrase;
      host.showToast('success', 'New words picked', `“${preview}” — press Sing to hear it.`);
    }
    return;
  }

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
    if (words && words.fit === 'lines' && phraseStillInSource) {
      // S-443: written lines sit on any melody phrase by phrase (line-fit.ts): no refit.
      finalWords = words;
    } else {
      // Fresh melody, fresh capacity — the words always refit after an import.
      services.reportStep?.({ stage: 'compose', label: 'FITTING WORDS...' });
      finalWords = await rewordOntoMelody(
        host,
        config,
        melodyCapacity(finalMelody.voices[0], config.notesPerBeat),
      );
      await host.setSceneData(scene, wordsKey, finalWords).catch(() => {});
    }
  } else if (mode === 'compose') {
    services.reportStep?.({ stage: 'compose', label: 'WRITING MELODY...' });
    const composed = await composeFromText(
      host,
      config,
      {
        key: musical.key,
        mode: musical.mode,
        bpm,
        bars,
        timeSignature: meter,
        quarterNotesPerBar: qnPerBar,
        chordSummary: summarizeChords(musical.chordProgression),
        totalBeats,
      },
      // Words the user already chose (✍ or an earlier run) survive a compose:
      // the model writes music FOR them instead of picking a fresh phrase.
      phraseStillInSource && words ? words.phrase : null,
      // S-443: bar-budget lines: music for those lines, one phrase per line, the lines kept.
      phraseStillInSource && words && words.fit === 'lines' ? words : null,
    );
    finalMelody = composed.melody;
    finalWords = composed.words;
    await host.setSceneData(scene, melodyKey, finalMelody).catch(() => {});
    await host.setSceneData(scene, wordsKey, finalWords).catch(() => {});
  } else if (mode === 'reword') {
    // The melody survives; only the words are re-chosen. The capacity target is
    // computed LIVE at the current pace — a stored count went stale the moment
    // the user touched the Pace control.
    finalMelody = melody as Text2VoiceMelody;
    services.reportStep?.({ stage: 'compose', label: 'FITTING WORDS...' });
    finalWords = await rewordOntoMelody(
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
  // Melisma runs fold FIRST: a marked continuation note merges into its head
  // as extra pitch targets, and the folded note is one indivisible slot.
  const leadLine = foldMelismaRuns(registeredVoices[0]);
  // S-443: bar-budget lines sit on the melody phrase by phrase; a line shorter
  // than its phrase holds a syllable through several notes (line-fit.ts).
  // Anything else spreads one phrase over the whole melody, as always.
  const fittedLines = finalWords.fit === 'lines' && finalWords.lines && finalWords.lines.length > 0 ? finalWords.lines : null;
  const lineFit = fittedLines
    ? fitLinesToLead(leadLine, fittedLines.map((l) => l.length), config.notesPerBeat)
    : null;
  const syllables = lineFit && fittedLines
    ? lineFit.syllableIndex.map((i) => fittedLines.flat()[i])
    : finalWords.syllables;
  const spread = lineFit
    ? { notes: lineFit.slots, dropped: lineFit.dropped }
    : distributeSyllables(leadLine, syllables.length, config.notesPerBeat);
  if (lineFit) {
    console.log(
      `[Text2Voice] lines: ${fittedLines?.length ?? 0} line(s), ${syllables.length} syllable(s) on ${leadLine.length} note(s) in ${lineFit.phrases} phrase(s)` +
        `${lineFit.aligned ? ', line by phrase' : ', shared over the phrases'}${lineFit.heldNotes > 0 ? `, ${lineFit.heldNotes} note(s) held under a syllable` : ''}`,
    );
  }

  // Breath guard: nobody sings longer than a lungful. Carves catch-breath
  // gaps INSIDE over-long runs (durations only — the slots↔syllables mapping
  // is untouched). Carved boundaries are 'breath', invisible to phrase-final
  // machinery like shouts, echoes and rhymes. S-443: the slow sung styles hold
  // a few words through long notes, so their lungful is longer (SynthV's 6 s).
  const limits = breathLimitsForBpm(bpm);
  const maxBreathBeats = lineFit && budgetSpecFor(config).multiplier <= 2 ? (6 * bpm) / 60 : limits.maxBreathBeats;
  const breathBeats = limits.breathBeats;
  const guard = applyBreathGuard(spread.notes, maxBreathBeats, breathBeats);
  const leadSlots = lineFit ? clampSlotPitches(guard.slots) : guard.slots;
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
    ...harmonyVoices.map((v) =>
      sustainLane(v) ? [] : lineFit ? clampSlotPitches(alignVoiceToFittedSlots(v, leadSlots)) : alignVoiceToSlots(v, leadSlots),
    ),
  ];

  // --- lane roles: derived fresh every run, stored nowhere ------------------
  const roles: LaneRole[] = laneRolesFor(config.style ?? null, config.harmony, laneCount);
  // Write-mode words rebuild their materialization against THESE phrases (the
  // deterministic same layout), yielding exact spans; quote mode recovers
  // spans from the validated split.
  const wordSpans =
    lineFit && fittedLines
      ? fittedWordSpans(finalWords.lineTexts ?? [], fittedLines, lineFit.syllableIndex, lineFit.dropped)
      : finalWords.source === 'write' && finalWords.lines
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
  // S-443: a canon shift can split a held syllable at the loop seam: its run is cut to each piece.
  if (lineFit) {
    for (let i = 0; i < assignments.length; i++) {
      assignments[i] = assignments[i].map((a) => (a.note ? { ...a, note: clampSlotPitches([a.note])[0] } : a));
    }
  }
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

  // The renderer's group snapshot can be STALE: tracks deleted by an agent,
  // another window, or a raced load leave members pointing at engine tracks
  // that no longer exist — reusing one died mid-run on 'Track not found'
  // (midmids, 2026-08-20, Sing pressed on a pre-cleanup panel). The main
  // process is the truth: verify every member against the live plugin tracks
  // and let dead ones fall out — planReconcile recreates their buckets.
  const liveIds = new Set((await host.getPluginTracks()).map((h) => h.id));
  const liveExisting = existing.filter((m) => liveIds.has(m.engineId));
  if (liveExisting.length < existing.length) {
    console.warn(
      `[Text2Voice] ${existing.length - liveExisting.length} group member(s) no longer exist — recreating`,
    );
  }

  const plan = planReconcile(liveExisting, laneCount);

  if (services.tracks.length + plan.createBucketIndexes.length > TEXT2VOICE_MAX_TRACKS) {
    throw new Error(
      `Text2Voice is limited to ${TEXT2VOICE_MAX_TRACKS} tracks — reduce the voice count.`,
    );
  }

  const created: PluginTrackHandle[] = [];
  let renderedAnchor = anchorDbId;
  const lanes: Array<{ dbId: string; engineId: string; voiceIndex: number }> = [];
  const silentLanes: string[] = [];
  const laneName = (i: number): string => roleLabel(roles[i] ?? 'group', i);

  try {
    for (const r of plan.reuse) lanes.push({ ...r, voiceIndex: r.bucketIndex });
    const createTotal = plan.createBucketIndexes.length;
    let createDone = 0;
    if (createTotal > 0) loopStep('create-tracks', 'CREATING VOICE LANES', 0, createTotal, 15, 5);
    for (const bucketIndex of plan.createBucketIndexes) {
      const handle = await services.createFamilyTrack(`-v${bucketIndex}`);
      created.push(handle);
      lanes.push({ dbId: handle.dbId, engineId: handle.id, voiceIndex: bucketIndex });
      loopStep('create-tracks', 'CREATING VOICE LANES', ++createDone, createTotal, 15, 5);
    }
    lanes.sort((a, b) => a.voiceIndex - b.voiceIndex);

    // If the ANCHOR track itself died (deleted out from under the panel),
    // bucket 0 now lives on a different dbId — but the reading's config,
    // melody and words are keyed by the OLD anchor's dbId. Migrate them so
    // the reading survives the loss of every one of its tracks: the data is
    // the reading; the tracks are just its current voices.
    let groupAnchorDbId = anchorDbId;
    renderedAnchor = anchorDbId;
    const bucket0 = lanes.find((l) => l.voiceIndex === 0);
    if (bucket0 && bucket0.dbId !== anchorDbId) {
      for (const key of [TEXT2VOICE_CONFIG_KEY, TEXT2VOICE_MELODY_KEY, TEXT2VOICE_WORDS_KEY]) {
        const val = await host
          .getSceneData(scene, services.trackDataKey(anchorDbId, key))
          .catch(() => null);
        if (val !== null && val !== undefined) {
          await host
            .setSceneData(scene, services.trackDataKey(bucket0.dbId, key), val)
            .catch(() => {});
        }
      }
      groupAnchorDbId = bucket0.dbId;
      renderedAnchor = bucket0.dbId;
      console.log(`[Text2Voice] Anchor moved ${anchorDbId} → ${bucket0.dbId}; reading data migrated`);
    }

    // --- render + place, one voice at a time -------------------------------
    let renderDone = 0;
    for (const lane of lanes) {
      loopStep('render-voices', 'RENDERING VOICES', renderDone++, lanes.length, 25, 65);
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

    loopStep('render-voices', 'RENDERING VOICES', lanes.length, lanes.length, 25, 65);

    if (silentLanes.length > 0) {
      host.showToast(
        'info',
        `${silentLanes.length} lane(s) silent this arrangement`,
        `${silentLanes.join(', ')} had nothing to sing and were muted.`,
      );
    }

    // --- metas + config last ------------------------------------------------
    services.reportStep?.({ stage: 'save', label: 'SAVING LANES...', percentFloor: 92 });
    for (const lane of lanes) {
      const meta: Text2VoiceMeta = {
        groupId: groupAnchorDbId,
        voiceIndex: lane.voiceIndex,
        label: laneName(lane.voiceIndex),
      };
      await host.setSceneData(scene, services.trackDataKey(lane.dbId, TEXT2VOICE_VOICE_META_KEY), meta);
    }
    await host.setSceneData(
      scene,
      services.trackDataKey(groupAnchorDbId, TEXT2VOICE_CONFIG_KEY),
      { ...config, voiceCount: laneCount },
    );
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

  // S-443: the take's signature on the scene's placements, so the Lyrics tab sees when the words move on.
  if (songSection) {
    await recordRendered(host, songSection.placements, songSection.lines, renderedAnchor).catch(() => 0);
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
    // The "fewer voices / shorter scene" advice is only true for the full
    // COMPOSE call; a words-only call has neither voices nor scene length.
    const hint =
      name === SUBMIT_TEXT2VOICE_TOOL_NAME
        ? 'Try fewer voices or a shorter scene — rephrasing will not help.'
        : 'Try again — this is a model hiccup, not something in your text.';
    throw new Error(
      `The model used its entire ${budget}-token budget before submitting. ${hint}`,
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
/**
 * A scene-shaped stand-in melody for fitting words BEFORE any music exists:
 * three sung beats then a rest, over the whole scene, so phrase detection
 * finds real phrases and rhyme budgets have something to budget against.
 * Never persisted, never rendered — the next Sing composes real music
 * around the words it helped shape.
 */
function syntheticWordsMelody(
  shape: SceneShapeKey,
  totalBeats: number,
): Text2VoiceMelody {
  const notes: PluginMidiNote[] = [];
  for (let b = 0; b < Math.max(4, Math.floor(totalBeats)); b++) {
    if (b % 4 === 3) continue; // the rest that ends each mini-phrase
    notes.push({ pitch: 60, startBeat: b, durationBeats: 1, velocity: 88 });
  }
  return {
    voices: [notes],
    composedHarmony: null,
    bpm: shape.bpm,
    bars: shape.bars,
    key: shape.key,
    mode: shape.mode,
    quarterNotesPerBar: shape.quarterNotesPerBar,
  };
}

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
    generationConfig: { temperature: TEXT2VOICE_TEMPERATURE, maxOutputTokens: TEXT2VOICE_MAX_OUTPUT_TOKENS },
  };

  const response = await host.generateWithLLMTools(request);
  const args = extractCall(response, SUBMIT_WORDS_TOOL_NAME, TEXT2VOICE_MAX_OUTPUT_TOKENS);
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

async function composeFromText(
  host: GenerationServices['host'],
  config: Text2VoiceConfig,
  shape: SceneShape,
  pinnedPhrase?: string | null,
  pinnedWords?: Text2VoiceWords | null,
): Promise<{ melody: Text2VoiceMelody; words: Text2VoiceWords }> {
  const rhythmRange = config.style ? STYLES[config.style].rhythmRange : DEFAULT_RHYTHM_RANGE;
  // S-443: music FOR bar-budget lines: one phrase per line, notes sized so a
  // syllable may hold through a short run; the lines themselves are kept.
  const pinnedLines =
    pinnedWords && pinnedWords.fit === 'lines' && pinnedWords.lines && pinnedWords.lineTexts
      ? pinnedWords.lineTexts.map((text, i) => ({ text, syllables: pinnedWords.lines?.[i]?.length ?? 1 }))
      : null;
  const pinnedTotal = pinnedLines ? pinnedLines.reduce((n, l) => n + l.syllables, 0) : 0;
  const baseNotes = melodyNoteBudget(shape.bars, shape.quarterNotesPerBar, rhythmRange);
  const noteRange = pinnedLines ? linesNoteRange(pinnedTotal, baseNotes) : baseNotes;
  const budget = pinnedLines ? pinnedTotal : syllableBudget(shape.bars, shape.quarterNotesPerBar, config.notesPerBeat);
  const ctx: PromptContext = {
    text: config.text,
    ...(pinnedPhrase ? { pinnedPhrase } : {}),
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
    ...(pinnedLines ? { pinnedLines, noteRange } : {}),
  };

  const request: LLMToolUseRequest = {
    model: TEXT2VOICE_MODEL,
    systemInstruction: { parts: [{ text: buildText2VoiceSystemPrompt(ctx) }] },
    contents: [{ role: 'user', parts: [{ text: buildText2VoiceUserPrompt(ctx) }] }],
    tools: [
      {
        functionDeclarations: [
          buildSubmitText2VoiceTool(config.harmony, config.voiceCount, noteRange, rhythmRange),
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

  // Pinned lines: the notes are the rhythm's (a syllable may hold through
  // several); the words are ours, so the model's phrase and split are not used.
  const parsed = parseText2VoiceArgs(args, pinnedLines ? { sizeBy: 'rhythm' } : {});

  // Quote mode: the phrase must be QUOTED, not written about. Write mode
  // INVENTS by design, so the in-source gate would reject exactly the output
  // we asked for.
  if (!pinnedLines && config.sourceMode !== 'write') {
    const inSource = validatePhraseInSource(parsed.phrase, config.text);
    if (!inSource.ok) {
      throw new Error(
        `The model did not quote your text (${inSource.reason}). Try again, or use a longer passage.`,
      );
    }
  }
  const splitOk = pinnedLines ? { ok: true } : validateSyllableSplit(parsed.syllables, parsed.phrase);
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
    words:
      pinnedLines && pinnedWords
        ? pinnedWords
        : {
            phrase: parsed.phrase,
            syllables: parsed.syllables,
            ...(parsed.stress ? { stress: parsed.stress } : {}),
            source: 'quote',
          },
  };
}
