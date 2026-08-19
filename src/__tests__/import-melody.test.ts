import type { ReadMidiResult } from '@signalsandsorcery/plugin-sdk';
import { isPercussiveRole, monophonize, supportsMelodyImport } from '../import-melody';
import { planGeneration, type Text2VoiceConfig, type Text2VoiceMelody } from '../voice-meta';

const clip = (notes: Array<[number, number, number]>): ReadMidiResult['clips'][number] => ({
  startTime: 0,
  endTime: 8,
  notes: notes.map(([pitch, startBeat, durationBeats]) => ({
    pitch,
    startBeat,
    durationBeats,
    velocity: 90,
  })),
});

describe('monophonize', () => {
  it('keeps the TOP note of a chord — melody lives on top of a voicing', () => {
    const out = monophonize([clip([[60, 0, 1], [64, 0, 1], [67, 0, 1]])], 8);
    expect(out).toHaveLength(1);
    expect(out[0].pitch).toBe(67);
  });

  it('resumes a lower held note when the top one ends', () => {
    // A pad holds C while a lead pops above it.
    const out = monophonize([clip([[60, 0, 4], [72, 1, 1]])], 8);
    expect(out.map((n) => n.pitch)).toEqual([60, 72, 60]);
    expect(out[2].startBeat).toBeCloseTo(2);
    expect(out[2].durationBeats).toBeCloseTo(2);
  });

  it('does not shatter a held top note at boundaries beneath it', () => {
    const out = monophonize([clip([[72, 0, 4], [60, 1, 1], [62, 2, 1]])], 8);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ pitch: 72, startBeat: 0, durationBeats: 4 });
  });

  it('clamps to the scene and merges multiple clips onto one timeline', () => {
    const out = monophonize([clip([[60, 6, 4]]), clip([[64, 0, 1]])], 8);
    expect(out.map((n) => n.pitch)).toEqual([64, 60]);
    const last = out[out.length - 1];
    expect(last.startBeat + last.durationBeats).toBeLessThanOrEqual(8);
  });

  it('returns nothing for an empty or out-of-scene track', () => {
    expect(monophonize([], 8)).toEqual([]);
    expect(monophonize([clip([[60, 9, 2]])], 8)).toEqual([]);
  });

  it('flags percussive roles', () => {
    expect(isPercussiveRole('kicks')).toBe(true);
    expect(isPercussiveRole('pads')).toBe(false);
    expect(isPercussiveRole(undefined)).toBe(false);
  });

  it('feature-detects the host pair', () => {
    expect(supportsMelodyImport({})).toBe(false);
    expect(
      supportsMelodyImport({ listSceneTracks: () => [], readImportableTrackMidi: () => null }),
    ).toBe(true);
  });
});

describe('the import planner mode', () => {
  const scene = { bpm: 120, bars: 8, key: 'C', mode: 'major', quarterNotesPerBar: 4 };
  const config: Text2VoiceConfig = {
    text: 'x',
    harmony: 'unison',
    delivery: 'unison',
    character: 'choir',
    voiceCount: 2,
    notesPerBeat: 2,
    melodySource: 'imported',
    importedTrackDbId: 'track-A',
  };
  const imported: Text2VoiceMelody = {
    voices: [[{ pitch: 60, startBeat: 0, durationBeats: 1, velocity: 90 }]],
    composedHarmony: null,
    bpm: 120,
    bars: 8,
    key: 'C',
    mode: 'major',
    quarterNotesPerBar: 4,
    importedFrom: 'track-A',
  };
  const words = { phrase: 'x', syllables: ['x'], source: 'quote' as const };

  it('renders while the imported melody still matches', () => {
    expect(
      planGeneration({ melody: imported, words, config, scene, phraseStillInSource: true }),
    ).toBe('render');
  });

  it('IMPORTS (never composes) when the source track changed', () => {
    expect(
      planGeneration({
        melody: imported,
        words,
        config: { ...config, importedTrackDbId: 'track-B' },
        scene,
        phraseStillInSource: true,
      }),
    ).toBe('import');
  });

  it('IMPORTS on a tempo change — the read is mechanical, not a model call', () => {
    expect(
      planGeneration({
        melody: imported,
        words,
        config,
        scene: { ...scene, bpm: 140 },
        phraseStillInSource: true,
      }),
    ).toBe('import');
  });

  it('♪ New music on an import means re-read the track now', () => {
    expect(
      planGeneration({
        melody: imported,
        words,
        config,
        scene,
        phraseStillInSource: true,
        forceMelody: true,
      }),
    ).toBe('import');
  });

  it('switching back to composed cannot ride the imported melody', () => {
    expect(
      planGeneration({
        melody: imported,
        words,
        config: { ...config, melodySource: 'composed', importedTrackDbId: undefined },
        scene,
        phraseStillInSource: true,
      }),
    ).toBe('compose');
  });

  it('the normalizer coerces composed harmonies to unison while imported', () => {
    // Round-trip through the normalizer, as the generator reads it.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { asText2VoiceConfig } = require('../voice-meta') as typeof import('../voice-meta');
    const c = asText2VoiceConfig({ ...config, harmony: 'choral' });
    expect(c!.harmony).toBe('unison');
  });
});
