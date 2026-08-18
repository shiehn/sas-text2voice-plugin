import { beatsToSeconds, buildVocalLineRequest } from '../render-spec';
import { assignSyllables } from '../harmony-styles';
import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';

const note = (pitch: number, startBeat: number, durationBeats = 0.5): PluginMidiNote => ({
  pitch,
  startBeat,
  durationBeats,
  velocity: 90,
});

const SYLLABLES = ['all', 'mat', 'ter', 'seen'];
const lead = [note(62, 0), note(65, 1), note(67, 2), note(69, 3)];

describe('beatsToSeconds', () => {
  it('converts at the scene tempo', () => {
    expect(beatsToSeconds(4, 120)).toBe(2);
    expect(beatsToSeconds(1, 60)).toBe(1);
  });
});

describe('buildVocalLineRequest', () => {
  it('pairs each syllable with its own note pitch and time', () => {
    const assignments = assignSyllables([lead], SYLLABLES.length, 'unison')[0];
    const req = buildVocalLineRequest(assignments, SYLLABLES, 'natural', 0, 1, 120, 4);
    expect(req.syllables).toHaveLength(4);
    expect(req.syllables.map((s) => s.text)).toEqual(SYLLABLES);
    expect(req.syllables.map((s) => s.midi)).toEqual([62, 65, 67, 69]);
    expect(req.syllables[1].startSec).toBeCloseTo(0.5);
    expect(req.syllables[0].durSec).toBeCloseTo(0.25);
  });

  it('drops rests without shifting the syllables that remain', () => {
    // Hocket: voice 0 of 2 takes the even slots only.
    const assignments = assignSyllables([lead, lead], SYLLABLES.length, 'hocket')[0];
    const req = buildVocalLineRequest(assignments, SYLLABLES, 'natural', 0, 2, 120, 4);
    expect(req.syllables.map((s) => s.text)).toEqual(['all', 'ter']);
    // "ter" keeps its original slot time — it is not pulled forward.
    expect(req.syllables[1].startSec).toBeCloseTo(1.0);
  });

  it('applies the character parameters to every syllable of the lane', () => {
    const assignments = assignSyllables([lead], SYLLABLES.length, 'unison')[0];
    const req = buildVocalLineRequest(assignments, SYLLABLES, 'ghost', 0, 3, 120, 4);
    expect(req.syllables.length).toBeGreaterThan(0);
    req.syllables.forEach((s) => {
      expect(s.breath).toBeGreaterThan(0);
      expect(s.jitter).toBeGreaterThan(0);
    });
  });

  it('gives different lanes different formant warps under choir', () => {
    const assignments = assignSyllables([lead, lead, lead], SYLLABLES.length, 'unison');
    const a = buildVocalLineRequest(assignments[0], SYLLABLES, 'choir', 0, 3, 120, 4);
    const c = buildVocalLineRequest(assignments[2], SYLLABLES, 'choir', 2, 3, 120, 4);
    expect(a.syllables[0].formantWarp).not.toBeCloseTo(c.syllables[0].formantWarp);
  });

  it('leaves room past the last note so a final vowel is not clipped', () => {
    const assignments = assignSyllables([lead], SYLLABLES.length, 'unison')[0];
    const req = buildVocalLineRequest(assignments, SYLLABLES, 'natural', 0, 1, 120, 4);
    expect(req.durationSec).toBeGreaterThan(beatsToSeconds(4, 120));
  });

  it('yields an empty request when the lane is entirely rests', () => {
    // Voice 2 of a 3-voice canon offset past the end of the phrase.
    const assignments = assignSyllables([lead, lead, lead], SYLLABLES.length, 'canon', 4)[2];
    const req = buildVocalLineRequest(assignments, SYLLABLES, 'natural', 2, 3, 120, 4);
    expect(req.syllables).toHaveLength(0);
  });

  it('passes the chosen system voice through, and omits it when unset', () => {
    const assignments = assignSyllables([lead], SYLLABLES.length, 'unison')[0];
    expect(
      buildVocalLineRequest(assignments, SYLLABLES, 'natural', 0, 1, 120, 4, 'Zarvox').ttsVoice,
    ).toBe('Zarvox');
    expect(buildVocalLineRequest(assignments, SYLLABLES, 'natural', 0, 1, 120, 4).ttsVoice).toBeUndefined();
  });

  it('scales all timing with tempo', () => {
    const assignments = assignSyllables([lead], SYLLABLES.length, 'unison')[0];
    const slow = buildVocalLineRequest(assignments, SYLLABLES, 'natural', 0, 1, 60, 4);
    const fast = buildVocalLineRequest(assignments, SYLLABLES, 'natural', 0, 1, 120, 4);
    expect(slow.syllables[1].startSec).toBeCloseTo(fast.syllables[1].startSec * 2);
  });
});
