/**
 * An intentionally inert sound + shuffle adapter.
 *
 * `GeneratorPanelAdapter` requires `sound` and `shuffle`, and the core
 * dereferences `adapter.sound` unguarded (`useSoundHistory(adapter.sound.applySound…)`
 * runs on every render), so an audio family cannot simply omit them. But a
 * Text2Voice lane has no instrument and no preset: its content is a rendered
 * WAV. There is nothing to capture, apply, shuffle or import.
 *
 * Every method here is therefore either a truthful null/no-op or a clear
 * throw. Nothing silently pretends to succeed. The UI routes that would reach
 * the throwing methods are already switched off by the adapter's feature flags
 * (`instrumentPicker`, `importTracks`, `transitionDesigner` all false), so they
 * exist to fail loudly if a future core change opens a path to them rather
 * than to be called in normal use.
 *
 * FOLLOW-UP for the SDK: `sound` and `shuffle` should become optional with
 * guards in the core, so audio families stop needing this shim. Text2Voice is
 * the first audio panel built on panel-core — stems, loops, recorder and
 * texture all hand-rolled their panels, which is why the gap has not surfaced
 * before.
 */

import type {
  GeneratorTrackState,
  PanelShuffleAdapter,
  PanelSoundAdapter,
  TrackSoundSnapshot,
} from '@signalsandsorcery/plugin-sdk';

const NO_SOUND_MESSAGE =
  'Text2Voice lanes carry rendered audio, not an instrument — there is no sound to change. ' +
  'Use the Character and voice selectors to re-render instead.';

export const silentSoundAdapter: PanelSoundAdapter = {
  // Nothing to re-apply: the lane's content is its audio clip.
  applySound: async (): Promise<void> => {},
  // Truthfully "this track has no instrument" — the core already null-checks.
  captureSoundDescriptor: async (): Promise<{ descriptor: unknown } | null> => null,
  copySnapshot: async (): Promise<string> => {
    throw new Error(NO_SOUND_MESSAGE);
  },
  descriptorFromSnapshot: (_snap: TrackSoundSnapshot): unknown => null,
  acceptedSnapshotKind: 'sample',
  historyMax: 0,
  importSoundLabel: 'Import Sound',
  importNoun: 'sound',
  previousSoundLabel: 'Previous sound',
};

export const silentShuffleAdapter: PanelShuffleAdapter = {
  shuffle: async (_track: GeneratorTrackState, _exclude: string[]): Promise<{ appliedName: string }> => {
    throw new Error(NO_SOUND_MESSAGE);
  },
  // Never an exhausted pool — there is no pool.
  isExhaustedError: (): boolean => false,
};
