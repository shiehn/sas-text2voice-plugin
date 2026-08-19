import {
  assignSyllables,
  characterFor,
  deriveHarmonyVoices,
  isComposedHarmony,
  normalizeHarmony,
  normalizeVoiceCount,
  sustainAssignments,
} from '../harmony-styles';
import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';

const note = (pitch: number, startBeat: number, durationBeats = 0.5): PluginMidiNote => ({
  pitch,
  startBeat,
  durationBeats,
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

  it('spreads six drone voices to six DISTINCT pitches', () => {
    // The octave clamp used to fold voices 5/6 back onto 3/4 — two lanes
    // rendered byte-identical audio.
    const voices = deriveHarmonyVoices(lead, 'drone', 6, 2, 16);
    const pitches = voices.slice(1).map((v) => v[0].pitch);
    expect(new Set(pitches).size).toBe(pitches.length);
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

  it('LOOPS the text when the melody holds more slots than syllables', () => {
    // Two syllables on four slots: a mantra, not a silent tail.
    const out = assignSyllables(voices, 2, 'unison');
    expect(out[0].map((a) => a.syllableIndex)).toEqual([0, 1, 0, 1]);
  });

  it('canon delays the voice\'s WHOLE line — pitch and text together', () => {
    const out = assignSyllables(voices, 4, 'canon', { canonOffsetBeats: 1, sceneBeats: 8 });
    // Voice 0 is the untouched lead.
    expect(out[0].map((a) => a.note?.startBeat)).toEqual([0, 0.5, 1, 1.5]);
    expect(out[0].map((a) => a.syllableIndex)).toEqual([0, 1, 2, 3]);
    // Voice 1 sings the SAME syllable sequence, one beat later, same pitches.
    expect(out[1].map((a) => a.syllableIndex)).toEqual([0, 1, 2, 3]);
    expect(out[1].map((a) => a.note?.startBeat)).toEqual([1, 1.5, 2, 2.5]);
    expect(out[1].map((a) => a.note?.pitch)).toEqual(out[0].map((a) => a.note?.pitch));
  });

  it('canon wraps at the scene boundary so the round survives the loop seam', () => {
    const tail = [note(62, 7, 0.5), note(64, 7.5, 0.5)];
    const out = assignSyllables([tail, tail], 2, 'canon', { canonOffsetBeats: 1, sceneBeats: 8 });
    // Voice 1's second slot lands at 7.5+1=8.5 → wraps to 0.5.
    expect(out[1].map((a) => a.note?.startBeat)).toEqual([0, 0.5]);
    expect(out[1].map((a) => a.syllableIndex)).toEqual([0, 1]);
  });

  it('hocket deals each slot to exactly one SOUNDING voice — no word vanishes', () => {
    // Voice 1 rests at slots 1 and 3 (nulls). The rotation must never hand a
    // syllable to a resting voice.
    const resting: Array<typeof lead[number] | null> = [lead[0], null, lead[2], null];
    const out = assignSyllables([lead, resting], 4, 'hocket');
    for (let slot = 0; slot < 4; slot++) {
      const singers = out.filter((v) => v[slot].syllableIndex !== null);
      expect(singers).toHaveLength(1);
    }
    // Slots where voice 1 rests fall to the lead.
    expect(out[0][1].syllableIndex).toBe(1);
    expect(out[0][3].syllableIndex).toBe(3);
  });

  it('never assigns a syllable index at or beyond the count', () => {
    const out = assignSyllables(voices, 2, 'unison');
    out.flat().forEach((a) => {
      expect(a.syllableIndex === null || a.syllableIndex < 2).toBe(true);
    });
  });
});

describe('sustainAssignments', () => {
  it('holds one syllable across a pedal tone — a drone, not a chant', () => {
    const pedal = [note(45, 0, 16)];
    const out = sustainAssignments(pedal, 0);
    expect(out).toHaveLength(1);
    expect(out[0].syllableIndex).toBe(0);
    expect(out[0].note?.durationBeats).toBe(16);
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
