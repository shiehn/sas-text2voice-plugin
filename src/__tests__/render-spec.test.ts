import { beatsToSeconds, buildVocalLineRequest, type VocalSyllableSpec } from '../render-spec';
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
    expect(req.syllables.map((s: VocalSyllableSpec) => s.text)).toEqual(SYLLABLES);
    expect(req.syllables.map((s: VocalSyllableSpec) => s.midi)).toEqual([62, 65, 67, 69]);
    expect(req.syllables[1].startSec).toBeCloseTo(0.5);
    expect(req.syllables[0].durSec).toBeCloseTo(0.25);
  });

  it('drops rests without shifting the syllables that remain', () => {
    // Hocket: voice 0 of 2 takes the even slots only.
    const assignments = assignSyllables([lead, lead], SYLLABLES.length, 'hocket')[0];
    const req = buildVocalLineRequest(assignments, SYLLABLES, 'natural', 0, 2, 120, 4);
    expect(req.syllables.map((s: VocalSyllableSpec) => s.text)).toEqual(['all', 'ter']);
    // "ter" keeps its original slot time — it is not pulled forward.
    expect(req.syllables[1].startSec).toBeCloseTo(1.0);
  });

  it('applies the character parameters to every syllable of the lane', () => {
    const assignments = assignSyllables([lead], SYLLABLES.length, 'unison')[0];
    const req = buildVocalLineRequest(assignments, SYLLABLES, 'ghost', 0, 3, 120, 4);
    expect(req.syllables.length).toBeGreaterThan(0);
    req.syllables.forEach((s: VocalSyllableSpec) => {
      expect(s.breath).toBeGreaterThan(0);
      expect(s.jitter).toBeGreaterThan(0);
    });
  });

  it('gives different lanes different formant warps under choir', () => {
    const assignments = assignSyllables([lead, lead, lead], SYLLABLES.length, 'unison');
    const a = buildVocalLineRequest(assignments[0], SYLLABLES, 'choir', 0, 3, 120, 4);
    const c = buildVocalLineRequest(assignments[2], SYLLABLES, 'choir', 2, 3, 120, 4);
    // The SDK marks these optional (the host defaults them), but the builder
    // always supplies all three — a lane rendering with host defaults instead
    // of its character would silently lose the effect.
    expect(a.syllables[0].formantWarp).toBeDefined();
    expect(c.syllables[0].formantWarp).toBeDefined();
    expect(a.syllables[0].formantWarp!).not.toBeCloseTo(c.syllables[0].formantWarp!);
  });

  it('always populates every character parameter, never leaving them to host defaults', () => {
    const assignments = assignSyllables([lead], SYLLABLES.length, 'unison')[0];
    const req = buildVocalLineRequest(assignments, SYLLABLES, 'natural', 0, 1, 120, 4);
    req.syllables.forEach((s: VocalSyllableSpec) => {
      expect(s.formantWarp).toBeDefined();
      expect(s.breath).toBeDefined();
      expect(s.jitter).toBeDefined();
    });
  });

  it('leaves room past the last note so a final vowel is not clipped', () => {
    const assignments = assignSyllables([lead], SYLLABLES.length, 'unison')[0];
    const req = buildVocalLineRequest(assignments, SYLLABLES, 'natural', 0, 1, 120, 4);
    expect(req.durationSec).toBeGreaterThan(beatsToSeconds(4, 120));
  });

  it('yields an empty request when the lane is entirely rests', () => {
    const silent: Array<(typeof lead)[number] | null> = [null, null, null, null];
    const assignments = assignSyllables([lead, silent], SYLLABLES.length, 'unison')[1];
    const req = buildVocalLineRequest(assignments, SYLLABLES, 'natural', 1, 2, 120, 4);
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

describe('treatments flow into the render request', () => {
  const SY = ['ver', 'sa'];
  const notes = [note(62, 0), note(64, 1)];

  it('applies the lane treatment to every ordinary syllable', () => {
    const assignments = assignSyllables([notes], SY.length, 'unison')[0];
    const req = buildVocalLineRequest(assignments, SY, 'machine', 0, 1, 120, 4, undefined, {
      pitchMode: 'contour',
      contourDepth: 0.5,
      timeMode: 'natural',
    });
    req.syllables.forEach((s: VocalSyllableSpec) => {
      expect(s.pitchMode).toBe('contour');
      expect(s.contourDepth).toBe(0.5);
      expect(s.timeMode).toBe('natural');
      expect(s.kind).toBe('syllable');
    });
  });

  it('per-entry treatment overrides the lane treatment', () => {
    const assignments = assignSyllables([notes], SY.length, 'unison')[0];
    assignments[1] = { ...assignments[1], treatment: { pitchMode: 'lock', gain: 1.6 } };
    const req = buildVocalLineRequest(assignments, SY, 'machine', 0, 1, 120, 4, undefined, {
      pitchMode: 'contour',
      contourDepth: 0.5,
      timeMode: 'natural',
    });
    expect(req.syllables[0].pitchMode).toBe('contour');
    expect(req.syllables[1].pitchMode).toBe('lock');
    expect(req.syllables[1].gain).toBe(1.6);
    // Unset override fields still inherit the lane's.
    expect(req.syllables[1].timeMode).toBe('natural');
  });

  it('inhale entries render with an overridden text and no syllable', () => {
    const inhale = {
      syllableIndex: 0,
      note: note(60, 3.5),
      treatment: { kind: 'inhale' as const, reverse: true, gain: 0.35, textOverride: 'haaah' },
    };
    const req = buildVocalLineRequest([inhale], SY, 'ghost', 0, 1, 120, 4);
    expect(req.syllables).toHaveLength(1);
    expect(req.syllables[0].text).toBe('haaah');
    expect(req.syllables[0].kind).toBe('inhale');
    expect(req.syllables[0].reverse).toBe(true);
  });

  it('defaults to fully sung when no lane treatment is given', () => {
    const assignments = assignSyllables([notes], SY.length, 'unison')[0];
    const req = buildVocalLineRequest(assignments, SY, 'natural', 0, 1, 120, 4);
    req.syllables.forEach((s: VocalSyllableSpec) => {
      expect(s.pitchMode).toBe('lock');
      expect(s.timeMode).toBe('fill');
    });
  });
});
