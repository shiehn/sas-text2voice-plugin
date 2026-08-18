import {
  assignSyllables,
  characterFor,
  deriveHarmonyVoices,
  isComposedHarmony,
  normalizeHarmony,
  normalizeVoiceCount,
} from '../harmony-styles';
import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';

const note = (pitch: number, startBeat: number): PluginMidiNote => ({
  pitch,
  startBeat,
  durationBeats: 0.5,
  velocity: 90,
});

const lead = [note(62, 0), note(65, 0.5), note(67, 1), note(69, 1.5)];

describe('characterFor', () => {
  it('fans the formant warp across the section for choir', () => {
    const first = characterFor('choir', 0, 4);
    const last = characterFor('choir', 3, 4);
    expect(first.formantWarp).toBeLessThan(1);
    expect(last.formantWarp).toBeGreaterThan(1);
    // The whole point of the character: bodies of different sizes.
    expect(last.formantWarp - first.formantWarp).toBeGreaterThan(0.4);
  });

  it('leaves a single voice in the middle of the fan, not at an extreme', () => {
    const solo = characterFor('menagerie', 0, 1);
    expect(solo.formantWarp).toBeGreaterThan(0.9);
    expect(solo.formantWarp).toBeLessThan(1.2);
  });

  it('keeps every character inside the renderer’s legal ranges', () => {
    for (const c of ['natural', 'choir', 'ghost', 'machine', 'menagerie'] as const) {
      for (let n = 1; n <= 6; n++) {
        for (let i = 0; i < n; i++) {
          const p = characterFor(c, i, n);
          expect(p.formantWarp).toBeGreaterThanOrEqual(0.25);
          expect(p.formantWarp).toBeLessThanOrEqual(4);
          expect(p.breath).toBeGreaterThanOrEqual(0);
          expect(p.breath).toBeLessThanOrEqual(1);
          expect(p.jitter).toBeGreaterThanOrEqual(0);
          expect(p.jitter).toBeLessThanOrEqual(12);
        }
      }
    }
  });

  it('gives machine no breath and no jitter', () => {
    const p = characterFor('machine', 1, 3);
    expect(p.breath).toBe(0);
    expect(p.jitter).toBe(0);
  });
});

describe('deriveHarmonyVoices', () => {
  it('stacks octaves for unison', () => {
    const voices = deriveHarmonyVoices(lead, 'unison', 3, 2, 8);
    expect(voices).toHaveLength(3);
    expect(voices[1][0].pitch).toBe(50);
    expect(voices[2][0].pitch).toBe(62 - 24);
  });

  it('moves organum in strict parallel fifths', () => {
    const voices = deriveHarmonyVoices(lead, 'organum', 2, 2, 8);
    voices[1].forEach((n, i) => {
      expect(n.pitch).toBe(voices[0][i].pitch - 7);
    });
  });

  it('gives drone voices one sustained note spanning the scene', () => {
    const voices = deriveHarmonyVoices(lead, 'drone', 3, 2, 16);
    expect(voices[1]).toHaveLength(1);
    expect(voices[1][0].durationBeats).toBe(16);
    expect(voices[2]).toHaveLength(1);
  });

  it('keeps derived pitches inside the renderable range', () => {
    const high = [note(84, 0)];
    const voices = deriveHarmonyVoices(high, 'unison', 6, 0, 8);
    voices.flat().forEach((n) => {
      expect(n.pitch).toBeGreaterThanOrEqual(36);
      expect(n.pitch).toBeLessThanOrEqual(84);
    });
  });

  it('returns the lead alone for a single voice', () => {
    expect(deriveHarmonyVoices(lead, 'unison', 1, 2, 8)).toEqual([lead]);
  });
});

describe('assignSyllables', () => {
  const voices = [lead, lead, lead];

  it('gives every voice the same syllable at the same moment in unison', () => {
    const out = assignSyllables(voices, 4, 'unison');
    expect(out[0].map((a) => a.syllableIndex)).toEqual([0, 1, 2, 3]);
    expect(out[2].map((a) => a.syllableIndex)).toEqual([0, 1, 2, 3]);
  });

  it('staggers the reading position per voice in canon', () => {
    const out = assignSyllables(voices, 4, 'canon', 2);
    expect(out[0].map((a) => a.syllableIndex)).toEqual([0, 1, 2, 3]);
    // Voice 1 starts two syllables late, so its first slots are silent.
    expect(out[1].map((a) => a.syllableIndex)).toEqual([null, null, 0, 1]);
    expect(out[2].map((a) => a.syllableIndex)).toEqual([null, null, null, null]);
  });

  it('deals consecutive syllables to different voices in hocket', () => {
    const out = assignSyllables(voices, 4, 'hocket');
    expect(out[0].map((a) => a.syllableIndex)).toEqual([0, null, null, 3]);
    expect(out[1].map((a) => a.syllableIndex)).toEqual([null, 1, null, null]);
    expect(out[2].map((a) => a.syllableIndex)).toEqual([null, null, 2, null]);
  });

  it('never assigns a syllable index beyond the phrase', () => {
    const out = assignSyllables(voices, 2, 'unison');
    out.flat().forEach((a) => {
      expect(a.syllableIndex === null || a.syllableIndex < 2).toBe(true);
    });
  });
});

describe('normalizers', () => {
  it('falls back on unknown stored values', () => {
    expect(normalizeHarmony('nonsense')).toBe('choral');
    expect(normalizeHarmony(undefined)).toBe('choral');
    expect(normalizeVoiceCount(99)).toBe(6);
    expect(normalizeVoiceCount(0)).toBe(1);
    expect(normalizeVoiceCount('x')).toBe(3);
  });

  it('marks only the model-composed styles as composed', () => {
    expect(isComposedHarmony('choral')).toBe(true);
    expect(isComposedHarmony('counterpoint')).toBe(true);
    expect(isComposedHarmony('cluster')).toBe(true);
    expect(isComposedHarmony('unison')).toBe(false);
    expect(isComposedHarmony('organum')).toBe(false);
    expect(isComposedHarmony('drone')).toBe(false);
  });
});
