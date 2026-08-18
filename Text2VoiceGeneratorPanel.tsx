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

import React, { useEffect, useMemo, useState } from 'react';
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
  asText2VoiceComposition,
  asText2VoiceConfig,
  MAX_TEXT_LENGTH,
  stampText2VoiceAnchor,
  text2voiceGroupIsComplete,
  text2voiceGroupSpec,
  TEXT2VOICE_COMPOSITION_KEY,
  TEXT2VOICE_CONFIG_KEY,
  TEXT2VOICE_VOICE_META_KEY,
  type Text2VoiceMeta,
} from './src/voice-meta';
import {
  generateText2Voice,
  TEXT2VOICE_MAX_TRACKS,
} from './src/text2voice-generation';
import { supportsSystemVoices, type SystemVoice } from './src/host-vocal';
import { silentShuffleAdapter, silentSoundAdapter } from './src/silent-sound';

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
  const compositionKey = ctx.services.trackDataKey(anchor.dbId, TEXT2VOICE_COMPOSITION_KEY);

  const [text, setText] = useState('');
  const [harmony, setHarmony] = useState<HarmonyStyle>('choral');
  const [delivery, setDelivery] = useState<DeliveryMode>('unison');
  const [character, setCharacter] = useState<Character>('choir');
  const [voiceCount, setVoiceCount] = useState<number>(3);
  const [ttsVoice, setTtsVoice] = useState<string>('');
  const [systemVoices, setSystemVoices] = useState<SystemVoice[]>([]);
  const [lastPhrase, setLastPhrase] = useState<string>('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Load stored config + the last composition (for the "sang:" caption).
  useEffect(() => {
    let cancelled = false;
    if (!scene) return undefined;
    void host
      .getSceneData(scene, configKey)
      .then((raw) => {
        const cfg = asText2VoiceConfig(raw);
        if (!cfg || cancelled) return;
        setText(cfg.text);
        setHarmony(cfg.harmony);
        setDelivery(cfg.delivery);
        setCharacter(cfg.character);
        setVoiceCount(cfg.voiceCount);
        setTtsVoice(cfg.ttsVoice ?? '');
      })
      .catch(() => {});
    void host
      .getSceneData(scene, compositionKey)
      .then((raw) => {
        const comp = asText2VoiceComposition(raw);
        if (comp && !cancelled) setLastPhrase(comp.phrase);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [host, scene, configKey, compositionKey, group.members.length]);

  // System voices are host-enumerated (they differ per OS), never hardcoded.
  useEffect(() => {
    let cancelled = false;
    if (!supportsSystemVoices(host)) return undefined;
    void (host as unknown as { listSystemVoices(): Promise<SystemVoice[]> })
      .listSystemVoices()
      .then((voices) => {
        if (!cancelled) setSystemVoices(voices);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [host]);

  const persist = (patch: Partial<{
    text: string;
    harmony: HarmonyStyle;
    delivery: DeliveryMode;
    character: Character;
    voiceCount: number;
    ttsVoice: string;
  }>): void => {
    if (!scene) return;
    const next = {
      text,
      harmony,
      delivery,
      character,
      voiceCount,
      ttsVoice,
      notesPerBeat: 2,
      ...patch,
    };
    void host.setSceneData(scene, configKey, next).catch(() => {});
  };

  const memberEngineIds = group.members.map((m) => m.track.handle.id);
  const allMuted = group.members.every((m) => m.track.runtimeState.muted);
  const anySolo = group.members.some((m) => m.track.runtimeState.solo);
  const isGenerating = group.members.some((m) => m.track.isGenerating);
  const generateDisabled = isGenerating || text.trim().length === 0;

  const regenerate = useRegenerateGuard({
    hasMidi: lastPhrase.length > 0,
    onGenerate: () => ctx.handlers.generate(anchorTrack.handle.id),
    subject: 'This reading',
    detail: `All ${group.members.length} ${
      group.members.length === 1 ? 'voice is' : 'voices are'
    } re-rendered.`,
    testIdPrefix: `text2voice-group-regenerate-confirm-${group.groupId}`,
  });

  const handleVoiceDelete = (member: (typeof group.members)[number]): void => {
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
            <option key={h} value={h}>
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

        <button
          onClick={regenerate.request}
          disabled={generateDisabled}
          title={
            text.trim().length === 0
              ? 'Paste some text first'
              : lastPhrase
                ? 'Re-render — replaces the current audio'
                : 'Compose and render'
          }
          className={`px-2 py-0.5 text-[10px] font-medium rounded-sm border transition-colors ${
            generateDisabled
              ? 'bg-sas-panel border-sas-border text-sas-muted/50 cursor-not-allowed'
              : 'bg-sas-accent/10 border-sas-accent/30 text-sas-accent hover:bg-sas-accent/20'
          }`}
          data-testid="text2voice-generate"
        >
          {isGenerating ? 'Rendering…' : 'Generate'}
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
            <textarea
              value={text}
              placeholder="Paste text here — an article, a paragraph, anything. A phrase from it will be quoted and sung."
              maxLength={MAX_TEXT_LENGTH}
              rows={5}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => persist({ text })}
              className="w-full resize-y bg-sas-panel border border-sas-border rounded-sm px-2 py-1.5 text-xs leading-relaxed text-sas-text placeholder:text-sas-muted/50 focus:border-sas-accent focus:outline-none"
              data-testid="text2voice-text"
            />
            <div className="flex items-center justify-between mt-1 gap-2">
              <span className="text-[9px] text-sas-muted truncate">
                {lastPhrase ? (
                  <>
                    sang: <span className="text-sas-text italic">&ldquo;{lastPhrase}&rdquo;</span>
                  </>
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
                      persist({ ttsVoice: e.target.value });
                    }}
                    title="System speech voice. Changing this re-renders without composing again."
                    className={SELECT_CLASS}
                    data-testid="text2voice-tts-voice"
                  >
                    <option value="">Default voice</option>
                    {systemVoices.map((v) => (
                      <option key={v.name} value={v.name}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                )}
                <span className="text-[9px] text-sas-muted tabular-nums">
                  {text.length.toLocaleString()} chars
                </span>
              </div>
            </div>
          </div>

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
                TEXT2VOICE_COMPOSITION_KEY,
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
