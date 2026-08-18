/**
 * Build the render request for one voice: syllable text + target pitch +
 * absolute timing + the character's WORLD parameters.
 *
 * Kept pure and separate from the pipeline so the mapping from
 * (notes, syllables, character, bpm) to a render request is directly testable
 * without a host — this is the layer where an off-by-one silently mis-speaks a
 * word, so it is worth testing on its own.
 */

import type {
  PluginMidiNote,
  RenderVocalLineRequest,
  VocalSyllableSpec as SdkVocalSyllableSpec,
} from '@signalsandsorcery/plugin-sdk';
import { characterFor, type Character } from './harmony-styles';
import type { VoiceSyllableAssignment } from './harmony-styles';

// The wire contract lives in the SDK (@since 3.4.0); these aliases keep the
// local call sites readable without redeclaring — and therefore risking drift
// from — the shape the host actually validates.
export type VocalSyllableSpec = SdkVocalSyllableSpec;
export type VocalLineRequest = RenderVocalLineRequest;

export function beatsToSeconds(beats: number, bpm: number): number {
  return (beats * 60) / bpm;
}

/**
 * Assemble one voice's render request. Assignments carrying a null syllable
 * index are rests and produce nothing — they still occupy their slot in time,
 * which is what makes hocket and canon line up.
 */
export function buildVocalLineRequest(
  assignments: VoiceSyllableAssignment[],
  syllables: string[],
  character: Character,
  voiceIndex: number,
  voiceCount: number,
  bpm: number,
  totalBeats: number,
  ttsVoice?: string,
): VocalLineRequest {
  const params = characterFor(character, voiceIndex, voiceCount);
  const specs: VocalSyllableSpec[] = [];

  for (const a of assignments) {
    if (a.syllableIndex === null) continue;
    const text = syllables[a.syllableIndex];
    if (!text) continue;
    specs.push({
      text,
      midi: a.note.pitch,
      startSec: beatsToSeconds(a.note.startBeat, bpm),
      durSec: beatsToSeconds(a.note.durationBeats, bpm),
      formantWarp: params.formantWarp,
      breath: params.breath,
      jitter: params.jitter,
    });
  }

  const request: VocalLineRequest = {
    syllables: specs,
    // A tail beyond the last note so a long final vowel is not clipped.
    durationSec: beatsToSeconds(totalBeats, bpm) + 0.5,
  };
  if (ttsVoice) request.ttsVoice = ttsVoice;
  return request;
}

/** Notes belonging to one voice, ordered, as the assignment layer expects. */
export function orderedNotes(notes: PluginMidiNote[]): PluginMidiNote[] {
  return [...notes].sort((a, b) => a.startBeat - b.startBeat);
}
