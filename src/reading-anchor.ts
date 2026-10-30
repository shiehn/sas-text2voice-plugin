/**
 * Which reading a song section's track is (S-443, after SynthV S-431). The
 * song lyric document is shared by every vocal plugin (Synth V and Text2Voice
 * write the same one), and each section names the reading that sings it
 * (`voiceTrackDbId`). The host's rule: a section whose track no longer EXISTS
 * is free; only an existing track of ANOTHER plugin refuses a write.
 *
 * `anchorStatus` asks the host what it can through the listings plugins have:
 * the scene's readings (this plugin's scene data), this plugin's tracks and
 * every track of the ACTIVE scene (getPluginTracks, listSceneTracks,
 * listSceneAudioTracks), and this plugin's tracks in ANY scene
 * (listSceneFamilyTracks). The host stays the judge: a write the plugin thought
 * free is still refused (NOT_OWNED), and the callers say so in those words.
 */

import type { PluginHost } from '@signalsandsorcery/plugin-sdk';
import manifest from '../plugin.json';
import { TEXT2VOICE_CONFIG_KEY } from './voice-meta';

/** This plugin's id, as the host stamps it on the tracks it owns. */
export const TEXT2VOICE_PLUGIN_ID: string = (manifest as { id: string }).id;

export type AnchorStatus =
  /** One of this scene's current readings. */
  | 'current'
  /** A track of this plugin in this scene with no reading config (an orphan lane). */
  | 'ours'
  /** An existing track of another plugin. */
  | 'foreign'
  /** No such track in this scene any more (deleted). */
  | 'gone'
  /** The host offered no listing that could say. */
  | 'unknown';

type AnchorHost = Partial<
  Pick<PluginHost, 'getActiveSceneId' | 'getPluginTracks' | 'listSceneTracks' | 'listSceneAudioTracks' | 'listSceneFamilyTracks' | 'getAllSceneData'>
>;

const CONFIG_SUFFIX = `:${TEXT2VOICE_CONFIG_KEY}`;

/** The Text2Voice readings (anchor dbIds) in a scene, from its plugin data; [] when the host cannot list it. */
export async function readingsInScene(host: unknown, sceneId: string): Promise<string[]> {
  const h = host as AnchorHost;
  if (typeof h.getAllSceneData !== 'function') return [];
  const all = (await h.getAllSceneData(sceneId).catch(() => null)) ?? {};
  return Object.keys(all)
    .filter((k) => k.startsWith('track:') && k.endsWith(CONFIG_SUFFIX))
    .map((k) => k.slice('track:'.length, -CONFIG_SUFFIX.length));
}

/**
 * What the track a section names is to this plugin now. `readings` are the
 * scene's current reading anchors (null = the host could not list them).
 */
export async function anchorStatus(host: unknown, sceneId: string, dbId: string, readings: readonly string[] | null): Promise<AnchorStatus> {
  if (readings && readings.includes(dbId)) return 'current';
  const h = host as AnchorHost;
  const active = typeof h.getActiveSceneId === 'function' && h.getActiveSceneId() === sceneId;
  if (active) {
    const mine = typeof h.getPluginTracks === 'function' ? await h.getPluginTracks().catch(() => null) : null;
    if (mine?.some((t) => t.dbId === dbId)) return 'ours';
    const audio = typeof h.listSceneAudioTracks === 'function' ? await h.listSceneAudioTracks().catch(() => null) : null;
    const a = audio?.find((t) => t.dbId === dbId);
    if (a) return a.pluginId ? (a.pluginId === TEXT2VOICE_PLUGIN_ID ? 'ours' : 'foreign') : 'unknown';
    const midi = typeof h.listSceneTracks === 'function' ? await h.listSceneTracks().catch(() => null) : null;
    if (midi?.some((t) => t.dbId === dbId)) return mine ? 'foreign' : 'unknown';
    if (midi && audio) return 'gone';
  }
  // Any scene: this plugin's own tracks there (the host narrows the family listing to the calling plugin's rows).
  const family = typeof h.listSceneFamilyTracks === 'function' ? await h.listSceneFamilyTracks(sceneId).catch(() => null) : null;
  if (family) return family.some((t) => t.dbId === dbId) ? 'ours' : 'gone';
  return 'unknown';
}

/** The skip reason for a section an existing track of another plugin sings (the host's words). */
export const FOREIGN_TRACK_REASON = "sung by another plugin's track";

/** The skip reason for a placed scene with no Text2Voice reading. */
export const NO_READING_REASON = 'no Text2Voice reading in this scene (instrumental)';

/** What the result says about a section re-anchored to the scene's current reading. */
export function reanchorNote(status: AnchorStatus): string {
  switch (status) {
    case 'gone':
      return 'its reading was deleted: re-anchored to the current reading';
    case 'ours':
      return 'its lane had no reading: re-anchored to the current reading';
    default:
      return 'its reading was not found: re-anchored to the current reading';
  }
}

/** Whether a host error is the ownership refusal. */
export const isNotOwned = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === 'NOT_OWNED';
