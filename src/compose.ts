/**
 * Turn the model's syllable grid into real notes.
 *
 * Every voice arrives as one slot per syllable holding a scale degree (or a
 * rest), plus one shared rhythm array. Resolving that against the scene key
 * gives absolute pitches that are in-scale and monophonic by construction —
 * the two things ensemble-core's `enforceVoice` exists to repair — so the only
 * mechanical work left here is the register clamp and defensive validation of
 * a model response that may not honour the schema.
 */

import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';
import { scaleStepsFor, tonicPcFor } from './music-helpers';

/** Comfortable range for WORLD resynthesis of a speech source. */
export const PITCH_FLOOR = 43;
export const PITCH_CEIL = 74;

export interface GridSlot {
  degree: number;
  octave: number;
  rest: boolean;
}

export interface GridVoice {
  label: string;
  notes: GridSlot[];
}

export interface ParsedComposition {
  phrase: string;
  syllables: string[];
  rhythm: number[];
  voices: GridVoice[];
}

export class CompositionError extends Error {}

function asFiniteNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Validate and normalise the model's tool arguments. Anything structurally
 * unusable throws; anything merely out of range is clamped, because a single
 * bad slot should not discard an otherwise good setting.
 */
export function parseText2VoiceArgs(args: unknown): ParsedComposition {
  if (!args || typeof args !== 'object') throw new CompositionError('empty tool arguments');
  const a = args as Record<string, unknown>;

  const phrase = typeof a.phrase === 'string' ? a.phrase.trim() : '';
  if (!phrase) throw new CompositionError('no phrase returned');

  const rawSyllables = Array.isArray(a.syllables) ? a.syllables : [];
  const syllables = rawSyllables
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (syllables.length === 0) throw new CompositionError('no syllables returned');

  const rawRhythm = Array.isArray(a.rhythm) ? a.rhythm : [];
  const rhythm: number[] = [];
  for (let i = 0; i < syllables.length; i++) {
    // Clamp to a musically sane slot; default to an eighth when absent.
    const v = asFiniteNumber(rawRhythm[i], 0.5);
    rhythm.push(Math.max(0.125, Math.min(8, v)));
  }

  const rawVoices = Array.isArray(a.voices) ? a.voices : [];
  const voices: GridVoice[] = [];
  for (const rv of rawVoices) {
    if (!rv || typeof rv !== 'object') continue;
    const v = rv as Record<string, unknown>;
    const rawNotes = Array.isArray(v.notes) ? v.notes : [];
    const notes: GridSlot[] = [];
    for (let i = 0; i < syllables.length; i++) {
      const rn = rawNotes[i];
      if (!rn || typeof rn !== 'object') {
        // Missing slot — rest rather than inventing a pitch.
        notes.push({ degree: 0, octave: 0, rest: true });
        continue;
      }
      const n = rn as Record<string, unknown>;
      const degree = Math.max(0, Math.min(6, Math.round(asFiniteNumber(n.degree, 0))));
      const octave = Math.max(-1, Math.min(1, Math.round(asFiniteNumber(n.octave, 0))));
      notes.push({ degree, octave, rest: n.rest === true });
    }
    voices.push({ label: typeof v.label === 'string' ? v.label : '', notes });
  }
  if (voices.length === 0) throw new CompositionError('no voices returned');

  return { phrase, syllables, rhythm, voices };
}

/**
 * Base MIDI note for a voice: voice 0 at the style's `top`, each subsequent
 * one lower across the style's span. Register is style-domain because contour
 * mode recenters the SPEECH on the target note — a trap lead centred at G4
 * is a chipmunk; centred at 52-53 it raps.
 */
export function voiceBasePitch(
  voiceIndex: number,
  voiceCount: number,
  register: { top: number; spanSemitones: number } = { top: 67, spanSemitones: 24 },
): number {
  const top = Math.max(PITCH_FLOOR + 4, Math.min(PITCH_CEIL, register.top));
  if (voiceCount <= 1) return top;
  const span = Math.min(register.spanSemitones, 5 * (voiceCount - 1), top - PITCH_FLOOR);
  const step = span / (voiceCount - 1);
  return Math.round(top - voiceIndex * step);
}

/**
 * Octave-normalize a melody into a register: shift ALL voices by the same
 * whole octaves until the LEAD's median sits nearest the register's centre.
 * Key- and interval-preserving, mechanical, free — this is what keeps style
 * flips cheap (the cached melody survives) while still landing every style
 * in its own tessitura.
 */
export function normalizeToRegister(
  voices: PluginMidiNote[][],
  register: { top: number; spanSemitones: number },
): PluginMidiNote[][] {
  const lead = voices[0] ?? [];
  if (lead.length === 0) return voices;
  const pitches = lead.map((n) => n.pitch).sort((a, b) => a - b);
  const median = pitches[Math.floor(pitches.length / 2)];
  const centre = register.top - register.spanSemitones / 4;
  const shift = Math.round((centre - median) / 12) * 12;
  if (shift === 0) return voices;
  return voices.map((v) =>
    v.map((n) => {
      let p = n.pitch + shift;
      while (p < PITCH_FLOOR) p += 12;
      while (p > PITCH_CEIL) p -= 12;
      return { ...n, pitch: p };
    }),
  );
}

function clampToRange(pitch: number): number {
  let p = pitch;
  while (p < PITCH_FLOOR) p += 12;
  while (p > PITCH_CEIL) p -= 12;
  return p;
}

/**
 * Resolve one voice's grid into notes positioned on the shared rhythm.
 * Rests consume their slot's time without producing a note, so every voice
 * stays aligned to the same syllable timeline.
 */
export function gridVoiceToNotes(
  voice: GridVoice,
  rhythm: number[],
  key: string,
  mode: string,
  voiceIndex: number,
  voiceCount: number,
  maxBeats: number,
  register: { top: number; spanSemitones: number } = { top: 67, spanSemitones: 24 },
): PluginMidiNote[] {
  const steps = scaleStepsFor(mode) ?? scaleStepsFor('major');
  const tonic = tonicPcFor(key);
  if (!steps || tonic === null) {
    throw new CompositionError(`unsupported key/mode: ${key} ${mode}`);
  }
  const base = voiceBasePitch(voiceIndex, voiceCount, register);
  // Anchor the register on the tonic nearest this voice's base.
  const anchor = base - ((((base % 12) - tonic) % 12) + 12) % 12;

  const notes: PluginMidiNote[] = [];
  let cursor = 0;
  for (let i = 0; i < voice.notes.length; i++) {
    const dur = rhythm[i] ?? 0.5;
    if (cursor >= maxBeats) break;
    const slot = voice.notes[i];
    if (!slot.rest) {
      const pitch = clampToRange(anchor + steps[slot.degree] + 12 * slot.octave);
      notes.push({
        pitch,
        startBeat: cursor,
        // Never let a note run past the end of the scene.
        durationBeats: Math.max(0.05, Math.min(dur, maxBeats - cursor)),
        velocity: 88,
      });
    }
    cursor += dur;
  }
  return notes;
}
