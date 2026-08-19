/**
 * Sing an existing track — the scene's own synth line becomes the vocal lead.
 *
 * The MIDI comes via `host.readImportableTrackMidi(sourceTrackDbId)` (DB-read,
 * deliberately NOT ownership-gated — `host.readMidiNotes` is engine-read and
 * ownership-gated, so it can never see another panel's track) and the picker
 * via `host.listSceneTracks()`. Both are optional host methods: feature-detect
 * and degrade with a clear message.
 *
 * A vocal line is monophonic; arbitrary track MIDI is not. `monophonize` keeps
 * the TOP note at each moment (melody lives on top of a voicing), truncates
 * notes at the next onset, clamps everything into the scene, and merges all
 * clips onto one timeline. A percussive source technically works — it
 * monophonizes to a one-pitch chant — but the caller warns, because that is
 * rarely what anyone meant.
 *
 * Importing costs NO model call: melody invalidations (tempo, bars, source
 * edits) re-run this mechanical read instead of composing.
 */

import type { PluginMidiNote, ReadMidiResult } from '@signalsandsorcery/plugin-sdk';

export interface ImportHost {
  listSceneTracks?(): Promise<Array<{ dbId: string; name: string; role?: string }>>;
  readImportableTrackMidi?(sourceTrackDbId: string): Promise<ReadMidiResult>;
}

export function supportsMelodyImport(host: unknown): boolean {
  if (!host || typeof host !== 'object') return false;
  const h = host as ImportHost;
  return (
    typeof h.listSceneTracks === 'function' && typeof h.readImportableTrackMidi === 'function'
  );
}

/** Roles that monophonize to a one-pitch chant — allowed, but say so. */
const PERCUSSIVE_ROLES = new Set([
  'kicks',
  'snares',
  'hats',
  'claps',
  'percussion',
  'drums',
  '808s',
  'toms',
  'cymbals',
]);

export function isPercussiveRole(role: string | undefined): boolean {
  return !!role && PERCUSSIVE_ROLES.has(role);
}

/**
 * Collapse arbitrary track MIDI into a monophonic lead line.
 *
 * At any moment the TOP sounding note wins; a lower note that outlives the
 * top one resumes when it ends. Implemented as an onset/offset sweep so
 * chords, overlaps and nested notes all resolve deterministically.
 */
export function monophonize(clips: ReadMidiResult['clips'], sceneBeats: number): PluginMidiNote[] {
  // Flatten clips onto one beat timeline, clamped to the scene.
  const notes: PluginMidiNote[] = [];
  for (const clip of clips ?? []) {
    for (const n of clip.notes ?? []) {
      const start = Math.max(0, n.startBeat);
      const end = Math.min(sceneBeats, n.startBeat + n.durationBeats);
      if (end - start < 1e-6) continue;
      notes.push({ ...n, startBeat: start, durationBeats: end - start });
    }
  }
  if (notes.length === 0) return [];

  // Sweep: at every boundary, the highest sounding pitch owns the segment.
  const boundaries = new Set<number>();
  for (const n of notes) {
    boundaries.add(n.startBeat);
    boundaries.add(n.startBeat + n.durationBeats);
  }
  const points = [...boundaries].sort((a, b) => a - b);

  const segments: PluginMidiNote[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const t0 = points[i];
    const t1 = points[i + 1];
    if (t1 - t0 < 1e-6) continue;
    const mid = (t0 + t1) / 2;
    let top: PluginMidiNote | null = null;
    for (const n of notes) {
      if (mid >= n.startBeat && mid < n.startBeat + n.durationBeats) {
        if (!top || n.pitch > top.pitch) top = n;
      }
    }
    if (!top) continue;
    const prev = segments[segments.length - 1];
    // Merge contiguous segments of the same source note (same pitch+velocity
    // and touching in time) so a held note isn't shattered by other voices'
    // boundaries beneath it.
    if (
      prev &&
      prev.pitch === top.pitch &&
      Math.abs(prev.startBeat + prev.durationBeats - t0) < 1e-6
    ) {
      prev.durationBeats = t1 - prev.startBeat;
    } else {
      segments.push({
        pitch: top.pitch,
        startBeat: t0,
        durationBeats: t1 - t0,
        velocity: top.velocity,
      });
    }
  }
  return segments;
}
