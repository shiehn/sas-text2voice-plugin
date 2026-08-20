/**
 * Text2Voice panel — a thin GeneratorPanelAdapter over the SDK panel-core,
 * built to the ensemble panel's shape: one voice-group per reading, the anchor
 * (voice 0) holding the group's config, and a group header carrying the intent
 * controls.
 *
 * The one structural departure from ensemble is the TEXT AREA. Ensemble's
 * intent fits in a single-line prompt; here the user pastes paragraphs, so the
 * text lives in the anchor's scene-data config (not the track prompt, which is
 * a single line and is instead used to display the phrase the model quoted)
 * and gets its own full-width row under the header.
 *
 * Because the text is not in `track.prompt`, the adapter sets
 * `promptlessGeneration` — otherwise the core's empty-prompt gate would
 * silently no-op the Generate button.
 *
 * Newborn tracks are stamped as a voice-group of ONE (`onTrackCreated`) so all
 * the controls exist BEFORE the first expensive generation.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  PluginUIProps,
  PluginHost,
  GeneratorPanelAdapter,
  GeneratorTrackState,
  GroupRenderContext,
  ResolvedTrackGroup,
} from '@signalsandsorcery/plugin-sdk';
import {
  GeneratorPanelShell,
  useGeneratorPanelCore,
  ConfirmDialog,
  GroupCollapseChevron,
  panelQuarterNotesPerBar,
  useRegenerateGuard,
} from '@signalsandsorcery/plugin-sdk';
import {
  CHARACTERS,
  DELIVERY_MODES,
  DELIVERY_DESCRIPTIONS,
  HARMONY_STYLES,
  HARMONY_DESCRIPTIONS,
  MAX_VOICES,
  MIN_VOICES,
  normalizeCharacter,
  normalizeDelivery,
  normalizeHarmony,
  normalizeVoiceCount,
  type Character,
  type DeliveryMode,
  type HarmonyStyle,
} from './src/harmony-styles';
import {
  asText2VoiceConfig,
  asText2VoiceMelody,
  asText2VoiceWords,
  MAX_TEXT_LENGTH,
  planGeneration,
  type Text2VoiceWords,
  stampText2VoiceAnchor,
  text2voiceGroupIsComplete,
  text2voiceGroupSpec,
  TEXT2VOICE_CONFIG_KEY,
  TEXT2VOICE_FORCE_KEY,
  TEXT2VOICE_MELODY_KEY,
  TEXT2VOICE_VOICE_META_KEY,
  TEXT2VOICE_WORDS_KEY,
  type GenerationMode,
  type SceneShapeKey,
  type Text2VoiceMelody,
  type Text2VoiceMeta,
} from './src/voice-meta';
import { validatePhraseInSource } from './src/syllables';
import {
  generateText2Voice,
  TEXT2VOICE_MAX_TRACKS,
} from './src/text2voice-generation';
import { supportsSystemVoices, type SystemVoice } from './src/host-vocal';
import { supportsMelodyImport } from './src/import-melody';

import { silentShuffleAdapter, silentSoundAdapter } from './src/silent-sound';
import { configMatchesStyle, DEFAULT_REALISM, isStyleId, STYLE_IDS, STYLES, styleAxes, type StyleId } from './src/styles';

interface VocalModelRow {
  id: string;
  label: string;
  family: string;
  sizeMB: number;
  license: string;
  state: 'not_installed' | 'downloading' | 'installed' | 'error';
  progressPct?: number;
  error?: string;
  voices: Array<{ id: string; label: string }>;
}

interface VocalModelHost {
  listVocalModels(): Promise<VocalModelRow[]>;
  installVocalModel(modelId: string): Promise<void>;
  uninstallVocalModel(modelId: string): Promise<void>;
}

function vocalModelHost(host: unknown): VocalModelHost | null {
  if (!host || typeof host !== 'object') return null;
  const h = host as Partial<VocalModelHost>;
  return typeof h.listVocalModels === 'function' &&
    typeof h.installVocalModel === 'function' &&
    typeof h.uninstallVocalModel === 'function'
    ? (h as VocalModelHost)
    : null;
}

// Rendering is the slow part: one speech spawn per syllable, then one render
// per voice. Comfortably longer than the model call that precedes it.
const ESTIMATED_GENERATION_MS = 60000;

const SELECT_CLASS =
  'text-xs bg-sas-panel border border-sas-border rounded-sm px-1 py-0.5 text-sas-text';

// ============================================================================
// Group row — header (controls + Generate + M/S/✕), text area, voice rows
// ============================================================================

function Text2VoiceGroupRow({
  group,
  ctx,
}: {
  group: ResolvedTrackGroup<Text2VoiceMeta, GeneratorTrackState>;
  ctx: GroupRenderContext;
}): React.ReactElement {
  const anchor = group.members.find((m) => m.meta.voiceIndex === 0) ?? group.members[0];
  const anchorTrack = anchor.track;
  const scene = ctx.services.activeSceneId;
  const host = ctx.services.host;
  const configKey = ctx.services.trackDataKey(anchor.dbId, TEXT2VOICE_CONFIG_KEY);
  const melodyKey = ctx.services.trackDataKey(anchor.dbId, TEXT2VOICE_MELODY_KEY);
  const wordsKey = ctx.services.trackDataKey(anchor.dbId, TEXT2VOICE_WORDS_KEY);

  const [text, setText] = useState('');
  const [harmony, setHarmony] = useState<HarmonyStyle>('choral');
  const [delivery, setDelivery] = useState<DeliveryMode>('unison');
  const [character, setCharacter] = useState<Character>('choir');
  const [voiceCount, setVoiceCount] = useState<number>(3);
  const [ttsVoice, setTtsVoice] = useState<string>('');
  // How densely syllables sit on the melody: 1 = quarters, 2 = eighths,
  // 4 = sixteenths. Now that a note carries MANY syllables, this is the
  // "how fast do the words go" control.
  const [pace, setPace] = useState<number>(2);
  const [realism, setRealism] = useState<number>(DEFAULT_REALISM);
  const [styleId, setStyleId] = useState<StyleId | ''>('');
  const [systemVoices, setSystemVoices] = useState<SystemVoice[]>([]);
  const [showVoiceManager, setShowVoiceManager] = useState(false);
  const [vocalModels, setVocalModels] = useState<VocalModelRow[]>([]);
  const [installBusy, setInstallBusy] = useState<string | null>(null);
  const [words, setWords] = useState<Text2VoiceWords | null>(null);
  const [melody, setMelody] = useState<Text2VoiceMelody | null>(null);
  const [sourceMode, setSourceMode] = useState<'quote' | 'write'>('quote');
  const [topic, setTopic] = useState('');
  const [rhymeScheme, setRhymeScheme] = useState<'none' | 'AABB' | 'ABAB'>('none');
  const [importedTrackDbId, setImportedTrackDbId] = useState<string>('');
  const [sceneTracks, setSceneTracks] = useState<Array<{ dbId: string; name: string; role?: string }>>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The scene shape the GENERATOR will compare against — fetched live, because
  // predicting reusability from the melody's own bpm/bars compares the melody
  // with itself and can never foresee a compose caused by a tempo change.
  const [sceneShape, setSceneShape] = useState<SceneShapeKey | null>(null);
  // Guards the pasted text against the load effect: once the user has typed,
  // background re-reads (a run finishing, a member count change) must never
  // clobber the textarea.
  const textDirty = useRef(false);
  const seededAnchor = useRef<string | null>(null);

  const isGenerating = group.members.some((m) => m.track.isGenerating);

  // Load stored config + the last composition (for the "sang:" caption).
  useEffect(() => {
    let cancelled = false;
    if (!scene) return undefined;
    void host
      .getSceneData(scene, configKey)
      .then((raw) => {
        const cfg = asText2VoiceConfig(raw);
        if (!cfg || cancelled) return;
        // The TEXT seeds once per anchor and never overwrites typing-in-flight;
        // the dropdowns are cheap to resync and never hold unsaved keystrokes.
        if (seededAnchor.current !== anchor.dbId && !textDirty.current) {
          seededAnchor.current = anchor.dbId;
          setText(cfg.text);
        }
        setHarmony(cfg.harmony);
        setDelivery(cfg.delivery);
        setCharacter(cfg.character);
        setVoiceCount(cfg.voiceCount);
        setTtsVoice(cfg.ttsVoice ?? '');
        setPace(cfg.notesPerBeat);
        setRealism(cfg.realism ?? DEFAULT_REALISM);
        setStyleId(cfg.style ?? '');
        setSourceMode(cfg.sourceMode ?? 'quote');
        setTopic(cfg.topic ?? '');
        setRhymeScheme(cfg.rhymeScheme ?? 'none');
        setImportedTrackDbId(cfg.melodySource === 'imported' ? (cfg.importedTrackDbId ?? '') : '');
      })
      .catch(() => {});
    void host
      .getSceneData(scene, melodyKey)
      .then((raw) => {
        if (!cancelled) setMelody(asText2VoiceMelody(raw));
      })
      .catch(() => {});
    void host
      .getSceneData(scene, wordsKey)
      .then((raw) => {
        if (!cancelled) setWords(asText2VoiceWords(raw));
      })
      .catch(() => {});
    void host
      .getMusicalContext()
      .then((mc) => {
        if (cancelled) return;
        setSceneShape({
          bpm: mc.bpm,
          bars: mc.bars,
          key: mc.key,
          mode: mc.mode,
          quarterNotesPerBar: panelQuarterNotesPerBar(mc),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // isGenerating: re-read the caches when a run finishes, so the plan label
    // and the "sang:" caption reflect what was just written.
  }, [host, scene, configKey, melodyKey, wordsKey, group.members.length, isGenerating]);

  // Scene tracks for the melody-source picker (host-gated; a run adding lanes
  // refreshes the list via isGenerating).
  useEffect(() => {
    let cancelled = false;
    if (!supportsMelodyImport(host)) return undefined;
    void (host as unknown as { listSceneTracks(): Promise<Array<{ dbId: string; name: string; role?: string }>> })
      .listSceneTracks()
      .then((tracks) => {
        if (!cancelled) setSceneTracks(tracks);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [host, scene, isGenerating]);

  // System voices are host-enumerated (they differ per OS), never hardcoded.
  // Installed model voices arrive in the same roster, prefixed — so the picker
  // updates the moment an install lands or an uninstall completes.
  const refreshVoices = useCallback((): void => {
    if (!supportsSystemVoices(host)) return;
    void (host as unknown as { listSystemVoices(): Promise<SystemVoice[]> })
      .listSystemVoices()
      .then(setSystemVoices)
      .catch(() => {});
  }, [host]);

  const refreshModels = useCallback((): void => {
    const mh = vocalModelHost(host);
    if (!mh) return;
    void mh.listVocalModels().then(setVocalModels).catch(() => {});
  }, [host]);

  useEffect(() => {
    refreshVoices();
    refreshModels();
  }, [refreshVoices, refreshModels]);

  // Live progress while a download is in flight.
  useEffect(() => {
    if (!vocalModels.some((m) => m.state === 'downloading')) return undefined;
    const timer = setInterval(refreshModels, 1500);
    return () => clearInterval(timer);
  }, [vocalModels, refreshModels]);

  const persist = useCallback(
    (patch: Partial<{
      text: string;
      harmony: HarmonyStyle;
      delivery: DeliveryMode;
      character: Character;
      voiceCount: number;
      ttsVoice: string;
      notesPerBeat: number;
      realism: number;
      style: StyleId | undefined;
      sourceMode: 'quote' | 'write';
      topic: string;
      rhymeScheme: 'none' | 'AABB' | 'ABAB';
      melodySource: 'composed' | 'imported';
      importedTrackDbId: string;
    }>): Promise<void> => {
      if (!scene) return Promise.resolve();
      const next = {
        text,
        harmony,
        delivery,
        character,
        voiceCount,
        ttsVoice,
        notesPerBeat: pace,
        realism,
        style: styleId || undefined,
        sourceMode,
        topic,
        rhymeScheme,
        melodySource: importedTrackDbId ? ('imported' as const) : ('composed' as const),
        importedTrackDbId: importedTrackDbId || undefined,
        ...patch,
      };
      if (patch.text !== undefined) textDirty.current = false;
      return host.setSceneData(scene, configKey, next).catch(() => {});
    },
    [scene, host, configKey, text, harmony, delivery, character, voiceCount, ttsVoice, pace, realism, styleId, sourceMode, topic, rhymeScheme, importedTrackDbId],
  );

  // The first Generate used to race the textarea's blur-persist: the run read
  // the OLD config and threw "Paste some text first" with text visibly present.
  // Persisting explicitly before dispatch closes that window.
  const generateNow = useCallback((): void => {
    void persist({ text }).then(() => ctx.handlers.generate(anchorTrack.handle.id));
  }, [persist, text, ctx.handlers, anchorTrack.handle.id]);

  const memberEngineIds = group.members.map((m) => m.track.handle.id);
  const allMuted = group.members.every((m) => m.track.runtimeState.muted);
  const anySolo = group.members.some((m) => m.track.runtimeState.solo);
  const generateDisabled =
    isGenerating || (sourceMode === 'write' ? topic.trim().length === 0 : text.trim().length === 0);

  // What will pressing Generate actually cost? Composing the music is the slow
  // step, so the button says which of the three paths it will take rather than
  // making the user find out by waiting.
  const plannedMode: GenerationMode = planGeneration({
    melody,
    words,
    config: {
      text,
      harmony,
      delivery,
      character,
      voiceCount,
      notesPerBeat: pace,
      sourceMode,
      topic,
      rhymeScheme,
      melodySource: importedTrackDbId ? ('imported' as const) : ('composed' as const),
      importedTrackDbId: importedTrackDbId || undefined,
    },
    scene: sceneShape ?? {
      bpm: melody?.bpm ?? 0,
      bars: melody?.bars ?? 0,
      key: melody?.key ?? '',
      mode: melody?.mode ?? '',
      quarterNotesPerBar: melody?.quarterNotesPerBar ?? 4,
    },
    phraseStillInSource:
      sourceMode === 'quote' && words ? validatePhraseInSource(words.phrase, text).ok : false,
  });

  // The style is a fingerprint, not a lock: hand-editing any axis shows Custom.
  const displayedStyle: StyleId | '' =
    styleId && configMatchesStyle(styleId, { harmony, delivery, character, notesPerBeat: pace })
      ? styleId
      : '';

  // Applying a style writes ALL its axes in ONE persist — per-axis writes open
  // a window where a generate reads a half-applied style.
  const applyStyle = (id: StyleId): void => {
    const axes = styleAxes(id);
    setStyleId(id);
    setHarmony(axes.harmony);
    setDelivery(axes.delivery);
    setCharacter(axes.character);
    setPace(axes.notesPerBeat);
    void persist({ ...axes, style: id });
  };

  const MODE_LABEL: Record<GenerationMode, string> = {
    compose: 'Compose',
    import: 'Import + Word',
    reword: 'Re-word',
    render: 'Re-render',
  };
  const NEXT_SUMMARY: Record<GenerationMode, string> = {
    compose: 'new music + new words',
    import: 'read the track + fit words',
    reword: 'keep melody · new words',
    render: 're-render voices only',
  };
  const MODE_HINT: Record<GenerationMode, string> = {
    compose: 'Writes new music and new words. The slow path.',
    import: 'Reads the chosen track\'s MIDI as the melody (no composing), then fits words to it.',
    reword: 'Keeps the melody; finds new words to fit it. Much faster than composing.',
    render: 'Nothing to compose — re-renders the existing music and words with the current voice.',
  };

  const regenerate = useRegenerateGuard({
    hasMidi: !!words,
    onGenerate: generateNow,
    subject: 'This reading',
    detail: `All ${group.members.length} ${
      group.members.length === 1 ? 'voice is' : 'voices are'
    } re-rendered.`,
    testIdPrefix: `text2voice-group-regenerate-confirm-${group.groupId}`,
  });

  const handleVoiceDelete = (member: (typeof group.members)[number]): void => {
    // The anchor (voice 0) holds ALL the group's scene-data — text, melody,
    // words. Deleting it orphans the reading, so its row never offers delete;
    // removing the whole reading goes through the group ✕.
    if (member.meta.voiceIndex === 0) return;
    void ctx.deleteGroup(
      [{ engineId: member.track.handle.id, dbId: member.dbId }],
      [TEXT2VOICE_VOICE_META_KEY, 'prompt', 'role', 'groupUi'],
    );
  };

  return (
    <div
      data-testid={`text2voice-group-${group.groupId}`}
      className="rounded-sm border border-sas-border bg-sas-panel-alt overflow-hidden"
      style={{ borderLeftColor: '#14B8A6', borderLeftWidth: '3px' }}
    >
      {/* --- header: intent controls ------------------------------------- */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-sas-border">
        <GroupCollapseChevron
          collapsed={ctx.collapsed}
          onToggle={ctx.onToggleCollapse}
          what="reading"
        />
        <span className="text-[9px] uppercase tracking-wide text-sas-muted whitespace-nowrap">
          Text2Voice · {group.members.length} {group.members.length === 1 ? 'voice' : 'voices'}
        </span>

        <div className="flex-1" />

        <select
          value={displayedStyle}
          onChange={(e) => {
            if (isStyleId(e.target.value)) applyStyle(e.target.value);
          }}
          title={displayedStyle ? STYLES[displayedStyle].hint : 'Style preset — sets harmony, delivery, character and pace together. Editing any of them afterwards shows Custom.'}
          className={SELECT_CLASS}
          data-testid="text2voice-style"
        >
          <option value="" disabled>
            {styleId && !displayedStyle ? 'Custom' : 'Style…'}
          </option>
          {STYLE_IDS.map((id) => (
            <option key={id} value={id}>
              {STYLES[id].label}
            </option>
          ))}
        </select>

        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={realism}
          onChange={(e) => setRealism(Number(e.target.value))}
          onMouseUp={() => void persist({ realism })}
          onTouchEnd={() => void persist({ realism })}
          title={`Realism ${Math.round(realism * 100)}% — scoops, vibrato, glides, ensemble looseness. 0 is the pure machine; changing it re-renders voices without recomposing.`}
          className="w-16 accent-sas-accent"
          data-testid="text2voice-realism"
        />

        {supportsMelodyImport(host) && (
          <select
            value={importedTrackDbId}
            onChange={(e) => {
              setImportedTrackDbId(e.target.value);
              void persist({
                melodySource: e.target.value ? 'imported' : 'composed',
                importedTrackDbId: e.target.value,
              });
            }}
            title="Melody source — compose new music, or SING an existing track: its MIDI becomes the lead line and the words spread across it."
            className={SELECT_CLASS}
            data-testid="text2voice-melody-source"
          >
            <option value="">Compose melody</option>
            {sceneTracks.map((t) => (
              <option key={t.dbId} value={t.dbId}>
                Sing: {t.name}
              </option>
            ))}
          </select>
        )}

        <select
          value={harmony}
          onChange={(e) => {
            const next = normalizeHarmony(e.target.value);
            setHarmony(next);
            persist({ harmony: next });
          }}
          title={HARMONY_DESCRIPTIONS[harmony]}
          className={SELECT_CLASS}
          data-testid="text2voice-harmony"
        >
          {HARMONY_STYLES.map((h) => (
            <option
              key={h}
              value={h}
              // A composed harmony cannot be jointly written FOR an imported
              // lead — derived styles only while singing an existing track.
              disabled={!!importedTrackDbId && ['choral', 'counterpoint', 'cluster'].includes(h)}
            >
              {h.charAt(0).toUpperCase() + h.slice(1)}
            </option>
          ))}
        </select>

        <select
          value={delivery}
          onChange={(e) => {
            const next = normalizeDelivery(e.target.value);
            setDelivery(next);
            persist({ delivery: next });
          }}
          title={DELIVERY_DESCRIPTIONS[delivery]}
          className={SELECT_CLASS}
          data-testid="text2voice-delivery"
        >
          {DELIVERY_MODES.map((d) => (
            <option key={d} value={d}>
              {d.charAt(0).toUpperCase() + d.slice(1)}
            </option>
          ))}
        </select>

        <select
          value={character}
          onChange={(e) => {
            const next = normalizeCharacter(e.target.value);
            setCharacter(next);
            persist({ character: next });
          }}
          title="Voice character — formant size, breath and pitch instability. Changing this re-renders without composing again."
          className={SELECT_CLASS}
          data-testid="text2voice-character"
        >
          {CHARACTERS.map((c) => (
            <option key={c} value={c}>
              {c.charAt(0).toUpperCase() + c.slice(1)}
            </option>
          ))}
        </select>

        <select
          value={voiceCount}
          onChange={(e) => {
            const next = normalizeVoiceCount(parseInt(e.target.value, 10));
            setVoiceCount(next);
            persist({ voiceCount: next });
          }}
          title="Voices"
          className={SELECT_CLASS}
          data-testid="text2voice-voice-count"
        >
          {Array.from({ length: MAX_VOICES - MIN_VOICES + 1 }, (_, i) => MIN_VOICES + i).map((n) => (
            <option key={n} value={n}>
              {n} {n === 1 ? 'voice' : 'voices'}
            </option>
          ))}
        </select>

        <select
          value={pace}
          onChange={(e) => {
            const next = parseInt(e.target.value, 10);
            setPace(next);
            persist({ notesPerBeat: next });
          }}
          title="How densely the words sit on the melody. A long note holds this many syllables per beat — so slower paces recite fewer words on each note."
          className={SELECT_CLASS}
          data-testid="text2voice-pace"
        >
          <option value={1}>Slow</option>
          <option value={2}>Medium</option>
          <option value={3}>Triplet</option>
          <option value={4}>Fast</option>
        </select>

        <button
          onClick={regenerate.request}
          disabled={generateDisabled}
          title={text.trim().length === 0 ? 'Paste some text first' : MODE_HINT[plannedMode]}
          className={`px-2 py-0.5 text-[10px] font-medium rounded-sm border transition-colors ${
            generateDisabled
              ? 'bg-sas-panel border-sas-border text-sas-muted/50 cursor-not-allowed'
              : 'bg-sas-accent/10 border-sas-accent/30 text-sas-accent hover:bg-sas-accent/20'
          }`}
          data-testid="text2voice-generate"
        >
          {isGenerating ? 'Working…' : MODE_LABEL[plannedMode]}
        </button>

        {/* Composing is the slow step, so asking for different music is an
            explicit act rather than a side effect of editing anything else. */}
        <button
          onClick={() => {
            if (!scene) return;
            // The request rides its OWN one-shot key: as a config field it
            // latched on failed runs and was erased by any dropdown persist.
            void host
              .setSceneData(scene, ctx.services.trackDataKey(anchor.dbId, TEXT2VOICE_FORCE_KEY), true)
              .then(() => persist({ text }))
              .then(() => ctx.handlers.generate(anchorTrack.handle.id))
              .catch(() => {});
          }}
          disabled={generateDisabled || !melody}
          title={
            importedTrackDbId
              ? 'Re-read the source track now — the melody re-imports and the words refit'
              : 'Compose different music — discards the current melody (the words refit to the new one)'
          }
          className={`px-1.5 py-0.5 text-[10px] rounded-sm border transition-colors whitespace-nowrap ${
            generateDisabled || !melody
              ? 'bg-sas-panel border-sas-border text-sas-muted/40 cursor-not-allowed'
              : 'bg-sas-panel border-sas-border text-sas-muted hover:border-sas-accent hover:text-sas-accent'
          }`}
          data-testid="text2voice-new-melody"
        >
          ♪ New music
        </button>

        <button
          onClick={() => ctx.setGroupMute(memberEngineIds, !allMuted)}
          title="Mute group"
          className={`px-1.5 py-0.5 text-[10px] font-bold rounded-sm border transition-colors ${
            allMuted
              ? 'bg-red-500/20 border-red-500/40 text-red-400'
              : 'bg-sas-panel border-sas-border text-sas-muted hover:border-sas-accent'
          }`}
        >
          M
        </button>
        <button
          onClick={() => ctx.setGroupSolo(memberEngineIds, !anySolo)}
          title="Solo group"
          className={`px-1.5 py-0.5 text-[10px] font-bold rounded-sm border transition-colors ${
            anySolo
              ? 'bg-yellow-500/20 border-yellow-500/40 text-yellow-400'
              : 'bg-sas-panel border-sas-border text-sas-muted hover:border-sas-accent'
          }`}
        >
          S
        </button>
        <button
          onClick={() => setConfirmDelete(true)}
          title="Delete reading"
          className="px-1.5 py-0.5 text-[10px] rounded-sm border border-sas-border text-sas-muted hover:border-red-500/60 hover:text-red-400 transition-colors"
        >
          ✕
        </button>
      </div>

      {!ctx.collapsed && (
        <>
          {/* --- the text area: the panel's whole point ------------------- */}
          <div className="px-2 pt-2 pb-1">
            <div className="flex items-center gap-2 mb-1.5">
              {(['quote', 'write'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    setSourceMode(m);
                    void persist({ sourceMode: m });
                  }}
                  className={`px-2 py-0.5 text-[10px] rounded-sm border transition-colors ${
                    sourceMode === m
                      ? 'bg-sas-accent/20 border-sas-accent text-sas-accent'
                      : 'bg-sas-panel border-sas-border text-sas-muted hover:border-sas-accent'
                  }`}
                  data-testid={`text2voice-source-${m}`}
                >
                  {m === 'quote' ? 'Quote my text' : 'Write lyrics'}
                </button>
              ))}
              {sourceMode === 'write' && (
                <select
                  value={rhymeScheme}
                  onChange={(e) => {
                    const next = e.target.value === 'AABB' || e.target.value === 'ABAB' ? e.target.value : 'none';
                    setRhymeScheme(next);
                    void persist({ rhymeScheme: next });
                  }}
                  title="Rhyme scheme — targets the phrase-final syllables. Degrades to pairs when the melody has fewer than four phrases."
                  className={SELECT_CLASS}
                  data-testid="text2voice-rhyme"
                >
                  <option value="none">No rhyme</option>
                  <option value="AABB">AABB</option>
                  <option value="ABAB">ABAB</option>
                </select>
              )}
            </div>
            {sourceMode === 'write' ? (
              <input
                type="text"
                value={topic}
                placeholder="What should the lyrics be about? e.g. a robot falling in love"
                maxLength={500}
                onChange={(e) => setTopic(e.target.value)}
                onBlur={() => void persist({ topic })}
                className="w-full bg-sas-panel border border-sas-border rounded-sm px-2 py-1.5 text-xs text-sas-text placeholder:text-sas-muted/50 focus:border-sas-accent focus:outline-none"
                data-testid="text2voice-topic"
              />
            ) : (
            <textarea
              value={text}
              placeholder="Paste text here — an article, a paragraph, anything. A phrase from it will be quoted and sung."
              maxLength={MAX_TEXT_LENGTH}
              rows={5}
              onChange={(e) => {
                textDirty.current = true;
                setText(e.target.value);
              }}
              onBlur={() => void persist({ text })}
              className="w-full resize-y bg-sas-panel border border-sas-border rounded-sm px-2 py-1.5 text-xs leading-relaxed text-sas-text placeholder:text-sas-muted/50 focus:border-sas-accent focus:outline-none"
              data-testid="text2voice-text"
            />
            )}
            <div className="flex items-center justify-between mt-1 gap-2">
              <span className="text-[9px] text-sas-muted truncate">
                <span className="text-sas-muted/80" data-testid="text2voice-next">
                  Next: {NEXT_SUMMARY[plannedMode]}
                </span>
                {' · '}
                {words ? (
                  <>
                    sang: <span className="text-sas-text italic">&ldquo;{words.phrase}&rdquo;</span>
                    {melody && plannedMode !== 'compose' && (
                      <span className="text-sas-accent"> · melody kept</span>
                    )}
                  </>
                ) : sourceMode === 'write' ? (
                  'Original lyrics about your topic will be written to fit the melody.'
                ) : (
                  'A phrase that fits the scene will be chosen from this text.'
                )}
              </span>
              <div className="flex items-center gap-2 shrink-0">
                {systemVoices.length > 0 && (
                  <select
                    value={ttsVoice}
                    onChange={(e) => {
                      setTtsVoice(e.target.value);
                      void persist({ ttsVoice: e.target.value });
                    }}
                    title="Voice. System voices are the default; downloaded model voices join this list when installed. Changing re-renders without composing again."
                    className={SELECT_CLASS}
                    data-testid="text2voice-tts-voice"
                  >
                    <option value="">Default voice</option>
                    <optgroup label="System">
                      {systemVoices
                        .filter((v) => !v.name.includes(':'))
                        .map((v) => (
                          <option key={v.name} value={v.name}>
                            {v.name}
                          </option>
                        ))}
                    </optgroup>
                    {systemVoices.some((v) => v.name.startsWith('piper:')) && (
                      <optgroup label="Piper (downloaded)">
                        {systemVoices
                          .filter((v) => v.name.startsWith('piper:'))
                          .map((v) => (
                            <option key={v.name} value={v.name}>
                              {v.name.slice('piper:'.length)}
                            </option>
                          ))}
                      </optgroup>
                    )}
                    {systemVoices.some((v) => v.name.startsWith('kokoro:')) && (
                      <optgroup label="Kokoro (downloaded)">
                        {systemVoices
                          .filter((v) => v.name.startsWith('kokoro:'))
                          .map((v) => (
                            <option key={v.name} value={v.name}>
                              {v.name.slice('kokoro:'.length)}
                            </option>
                          ))}
                      </optgroup>
                    )}
                    {ttsVoice && !systemVoices.some((v) => v.name === ttsVoice) && (
                      <option value={ttsVoice}>{ttsVoice} (not installed — uses default)</option>
                    )}
                  </select>
                )}
                {vocalModelHost(host) && (
                  <button
                    onClick={() => {
                      setShowVoiceManager((v) => !v);
                      refreshModels();
                    }}
                    title="Download or remove third-party voice models (Piper, Kokoro). Nothing is bundled — models come from their official releases."
                    className={`px-1.5 py-0.5 text-[10px] rounded-sm border transition-colors ${
                      showVoiceManager
                        ? 'bg-sas-accent/20 border-sas-accent text-sas-accent'
                        : 'bg-sas-panel border-sas-border text-sas-muted hover:border-sas-accent'
                    }`}
                    data-testid="text2voice-voice-manager-toggle"
                  >
                    Voices…
                  </button>
                )}
                {sourceMode === 'quote' && (
                  <span className="text-[9px] text-sas-muted tabular-nums">
                    {text.length.toLocaleString()} chars
                  </span>
                )}
              </div>
            </div>
          </div>

          {showVoiceManager && (
            <div className="px-2 pb-1 space-y-1" data-testid="text2voice-voice-manager">
              {vocalModels.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center gap-2 px-2 py-1 rounded-sm border border-sas-border bg-sas-panel"
                >
                  <span className="text-[10px] text-sas-text whitespace-nowrap">{m.label}</span>
                  <span className="text-[9px] text-sas-muted">{m.sizeMB} MB</span>
                  <span className="text-[9px] text-sas-muted truncate flex-1" title={m.license}>
                    {m.license}
                  </span>
                  {m.state === 'downloading' ? (
                    <span className="text-[10px] text-sas-accent tabular-nums">
                      {m.progressPct ?? 0}%
                    </span>
                  ) : m.state === 'installed' ? (
                    <button
                      onClick={() => {
                        const mh = vocalModelHost(host);
                        if (!mh) return;
                        void mh
                          .uninstallVocalModel(m.id)
                          .then(() => {
                            refreshModels();
                            refreshVoices();
                          })
                          .catch(() => refreshModels());
                      }}
                      className="px-1.5 py-0.5 text-[10px] rounded-sm border border-sas-border text-sas-muted hover:border-red-500/60 hover:text-red-400 transition-colors"
                      data-testid={`text2voice-uninstall-${m.id}`}
                    >
                      Uninstall
                    </button>
                  ) : (
                    <button
                      disabled={installBusy !== null}
                      onClick={() => {
                        const mh = vocalModelHost(host);
                        if (!mh) return;
                        setInstallBusy(m.id);
                        refreshModels();
                        void mh
                          .installVocalModel(m.id)
                          .then(() => {
                            host.showToast('success', `${m.label} installed`, 'Its voices are now in the voice list.');
                          })
                          .catch((err: unknown) => {
                            host.showToast('error', `${m.label} install failed`, err instanceof Error ? err.message : String(err));
                          })
                          .finally(() => {
                            setInstallBusy(null);
                            refreshModels();
                            refreshVoices();
                          });
                      }}
                      className="px-1.5 py-0.5 text-[10px] rounded-sm border border-sas-border text-sas-muted hover:border-sas-accent hover:text-sas-accent transition-colors disabled:opacity-40"
                      data-testid={`text2voice-install-${m.id}`}
                    >
                      {m.state === 'error' ? 'Retry' : 'Install'}
                    </button>
                  )}
                </div>
              ))}
              {vocalModels.length === 0 && (
                <div className="text-[9px] text-sas-muted px-2">No downloadable voices on this host.</div>
              )}
            </div>
          )}

          {/* --- voice rows ---------------------------------------------- */}
          <div className="p-1 space-y-1">
            {group.members.map((m) =>
              ctx.renderDefaultTrackRow(m.track, {
                // The intent lives in the group header; the row shows the
                // mechanical voice label. Per-voice generate/copy are off —
                // the group owns them, because one render rewrites every lane.
                prompt: m.meta.label || 'voice',
                onPromptChange: undefined,
                onGenerate: undefined,
                onCopy: undefined,
                onDelete: () => handleVoiceDelete(m),
              }),
            )}
          </div>
        </>
      )}

      {confirmDelete && (
        <ConfirmDialog
          open={confirmDelete}
          title="Delete reading?"
          message={`Removes all ${group.members.length} voice tracks and the text.`}
          confirmLabel="Delete"
          onConfirm={() => {
            setConfirmDelete(false);
            void ctx.deleteGroup(
              group.members.map((m) => ({ engineId: m.track.handle.id, dbId: m.dbId })),
              [
                TEXT2VOICE_VOICE_META_KEY,
                TEXT2VOICE_CONFIG_KEY,
                TEXT2VOICE_MELODY_KEY,
                TEXT2VOICE_WORDS_KEY,
                'prompt',
                'role',
                'groupUi',
              ],
            );
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
      {regenerate.dialog}
    </div>
  );
}

// ============================================================================
// Adapter + panel
// ============================================================================

function createText2VoiceAdapter(host: PluginHost): GeneratorPanelAdapter<Text2VoiceMeta> {
  return {
    identity: {
      familyKey: 'text2voice',
      familyLabel: 'Text2Voice',
      trackNamePrefix: 'voice',
      logTag: 'Text2VoiceGeneratorPanel',
      accentColor: '#14B8A6',
      transitionAccentColor: '#0D9488',
      placeholderAccentColor: '#2DD4BF',
      maxTracks: TEXT2VOICE_MAX_TRACKS,
      estimatedGenerationMs: ESTIMATED_GENERATION_MS,
      addTrackLabel: 'Add Reading',
    },
    features: {
      // The source text lives in the group config, not `track.prompt`, so the
      // core's empty-prompt gate must be waived or Generate silently no-ops.
      promptlessGeneration: true,
      // Composition is a model call, so the sign-in gate stays ON.
      localGeneration: false,
      // Voices are AUDIO tracks: no instrument, no piano roll, no MIDI export.
      instrumentPicker: false,
      bulkComposePlaceholders: false,
      exportMidi: false,
      transitionDesigner: false,
      importTracks: false,
      // Bus-strip DSP on the panel's summed output: duck the choir against the
      // scene's kicks, and tempo-locked filter motion. Both are host-gated, so
      // they stay inert on older hosts.
      busSidechain: true,
      busMotion: true,
    },
    // Audio tracks: no synth is loaded, the rendered WAV is the content.
    createTrackOptions: () => ({ loadSynth: false }),
    // A lane has no instrument or preset, but the core requires both adapters
    // and dereferences `sound` unguarded — see src/silent-sound.ts.
    sound: silentSoundAdapter,
    shuffle: silentShuffleAdapter,
    applyPortedTrackSound: async (): Promise<void> => {},
    // Only reached by core-owned crossfade/fade generation, which needs
    // `transitionDesigner` — off here. Present to satisfy the interface.
    buildSystemPrompt: () =>
      'Text2Voice composes through its own schema-forced call; this prompt is unused.',
    parseNotesResponse: () => null,
    onTrackCreated: async (handle, ctx) => {
      await stampText2VoiceAnchor(host, ctx.activeSceneId, ctx.trackDataKey, handle.dbId);
    },
    generation: { generate: generateText2Voice },
    groupExtensions: [
      {
        ...text2voiceGroupSpec,
        isComplete: text2voiceGroupIsComplete,
        renderGroup: (group, ctx) => <Text2VoiceGroupRow group={group} ctx={ctx} />,
      },
    ],
  };
}

export function Text2VoiceGeneratorPanel(props: PluginUIProps): React.ReactElement {
  const adapter = useMemo(() => createText2VoiceAdapter(props.host), [props.host]);
  const core = useGeneratorPanelCore({ ui: props, adapter: adapter as GeneratorPanelAdapter });
  return <GeneratorPanelShell core={core} />;
}

export default Text2VoiceGeneratorPanel;
