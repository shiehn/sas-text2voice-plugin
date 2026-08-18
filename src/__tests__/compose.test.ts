import {
  CompositionError,
  gridVoiceToNotes,
  parseText2VoiceArgs,
  PITCH_CEIL,
  PITCH_FLOOR,
  voiceBasePitch,
} from '../compose';

const validArgs = {
  phrase: 'all matter',
  syllables: ['all', 'mat', 'ter'],
  rhythm: [1, 0.5, 0.5],
  voices: [
    {
      label: 'lead',
      notes: [
        { degree: 0, octave: 0, rest: false },
        { degree: 2, octave: 0, rest: false },
        { degree: 4, octave: 0, rest: false },
      ],
    },
  ],
};

describe('parseText2VoiceArgs', () => {
  it('parses a well-formed response', () => {
    const p = parseText2VoiceArgs(validArgs);
    expect(p.phrase).toBe('all matter');
    expect(p.syllables).toEqual(['all', 'mat', 'ter']);
    expect(p.rhythm).toEqual([1, 0.5, 0.5]);
    expect(p.voices[0].notes).toHaveLength(3);
  });

  it('throws on structurally unusable responses', () => {
    expect(() => parseText2VoiceArgs(null)).toThrow(CompositionError);
    expect(() => parseText2VoiceArgs({ ...validArgs, phrase: '' })).toThrow(/no phrase/);
    expect(() => parseText2VoiceArgs({ ...validArgs, syllables: [] })).toThrow(/no syllables/);
    expect(() => parseText2VoiceArgs({ ...validArgs, voices: [] })).toThrow(/no voices/);
  });

  it('pads a short rhythm array rather than failing the whole setting', () => {
    const p = parseText2VoiceArgs({ ...validArgs, rhythm: [1] });
    expect(p.rhythm).toHaveLength(3);
    expect(p.rhythm[1]).toBe(0.5);
  });

  it('rests any missing note slot instead of inventing a pitch', () => {
    const p = parseText2VoiceArgs({
      ...validArgs,
      voices: [{ label: 'lead', notes: [{ degree: 0, octave: 0, rest: false }] }],
    });
    expect(p.voices[0].notes).toHaveLength(3);
    expect(p.voices[0].notes[1].rest).toBe(true);
    expect(p.voices[0].notes[2].rest).toBe(true);
  });

  it('clamps out-of-range degrees, octaves and durations', () => {
    const p = parseText2VoiceArgs({
      ...validArgs,
      rhythm: [999, -5, 0.5],
      voices: [
        {
          label: 'lead',
          notes: [
            { degree: 42, octave: 9, rest: false },
            { degree: -3, octave: -9, rest: false },
            { degree: 1, octave: 0, rest: false },
          ],
        },
      ],
    });
    expect(p.rhythm[0]).toBeLessThanOrEqual(8);
    expect(p.rhythm[1]).toBeGreaterThanOrEqual(0.125);
    expect(p.voices[0].notes[0].degree).toBe(6);
    expect(p.voices[0].notes[0].octave).toBe(1);
    expect(p.voices[0].notes[1].degree).toBe(0);
    expect(p.voices[0].notes[1].octave).toBe(-1);
  });
});

describe('voiceBasePitch', () => {
  it('puts voice 0 highest and descends', () => {
    expect(voiceBasePitch(0, 4)).toBeGreaterThan(voiceBasePitch(3, 4));
  });

  it('keeps a six-voice spread inside the renderable range', () => {
    for (let i = 0; i < 6; i++) {
      const p = voiceBasePitch(i, 6);
      expect(p).toBeGreaterThanOrEqual(PITCH_FLOOR);
      expect(p).toBeLessThanOrEqual(PITCH_CEIL);
    }
  });
});

describe('gridVoiceToNotes', () => {
  const voice = validArgs.voices[0];

  it('resolves scale degrees against the key', () => {
    const notes = gridVoiceToNotes(voice, [1, 1, 1], 'C', 'major', 0, 1, 8);
    expect(notes).toHaveLength(3);
    // Degrees 0/2/4 of C major = C, E, G.
    const pcs = notes.map((n) => n.pitch % 12);
    expect(pcs).toEqual([0, 4, 7]);
  });

  it('honours the mode', () => {
    const notes = gridVoiceToNotes(voice, [1, 1, 1], 'C', 'minor', 0, 1, 8);
    // Minor third instead of major.
    expect(notes[1].pitch % 12).toBe(3);
  });

  it('positions notes cumulatively on the shared rhythm', () => {
    const notes = gridVoiceToNotes(voice, [1, 0.5, 0.5], 'C', 'major', 0, 1, 8);
    expect(notes.map((n) => n.startBeat)).toEqual([0, 1, 1.5]);
  });

  it('advances the cursor through rests so voices stay aligned', () => {
    const withRest = {
      label: 'x',
      notes: [
        { degree: 0, octave: 0, rest: true },
        { degree: 2, octave: 0, rest: false },
      ],
    };
    const notes = gridVoiceToNotes(withRest, [1, 1], 'C', 'major', 0, 1, 8);
    expect(notes).toHaveLength(1);
    // The rest still consumed its beat.
    expect(notes[0].startBeat).toBe(1);
  });

  it('never writes past the end of the scene', () => {
    const notes = gridVoiceToNotes(voice, [4, 4, 4], 'C', 'major', 0, 1, 5);
    notes.forEach((n) => {
      expect(n.startBeat + n.durationBeats).toBeLessThanOrEqual(5);
    });
  });

  it('keeps every pitch inside the renderable range', () => {
    for (let v = 0; v < 6; v++) {
      const notes = gridVoiceToNotes(
        { label: 'x', notes: [{ degree: 6, octave: 1, rest: false }] },
        [1],
        'B',
        'major',
        v,
        6,
        8,
      );
      notes.forEach((n) => {
        expect(n.pitch).toBeGreaterThanOrEqual(PITCH_FLOOR);
        expect(n.pitch).toBeLessThanOrEqual(PITCH_CEIL);
      });
    }
  });

  it('throws on an unparseable key', () => {
    expect(() => gridVoiceToNotes(voice, [1, 1, 1], 'H', 'major', 0, 1, 8)).toThrow(CompositionError);
  });
});
