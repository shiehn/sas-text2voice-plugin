/**
 * S-443: composing music FOR written lines. The melody is sized by its rhythm
 * (a syllable may hold through several notes), a slow budget asks for two to
 * three notes per syllable, and the prompt sets the lines one phrase each.
 * Without pinned lines nothing changes.
 */
import { parseText2VoiceArgs } from '../compose';
import { buildText2VoiceSystemPrompt, buildText2VoiceUserPrompt, linesNoteRange, melodyNoteBudget, type PromptContext } from '../prompt';

const args = {
  phrase: 'cold light / falls',
  syllables: ['cold', 'light', 'falls'],
  rhythm: [2, 2, 2, 2, 2, 2, 4, 4],
  voices: [{ label: 'lead', notes: [0, 1, 2, 3, 4, 3, 2, 0].map((degree) => ({ degree, octave: 0, rest: false })) }],
};

it('the default parse reads one note per syllable, as always', () => {
  const p = parseText2VoiceArgs(args);
  expect(p.rhythm).toHaveLength(3);
  expect(p.voices[0].notes).toHaveLength(3);
});

it('sizeBy rhythm reads every rhythm value as a note', () => {
  const p = parseText2VoiceArgs(args, { sizeBy: 'rhythm' });
  expect(p.rhythm).toHaveLength(8);
  expect(p.voices[0].notes).toHaveLength(8);
});

it('a slow budget asks for 2-3 notes per syllable inside the style range; a dense one keeps the range', () => {
  const base = melodyNoteBudget(8, 4, { minBeats: 0.5, maxBeats: 4 });
  expect(base).toEqual({ min: 6, max: 48 });
  expect(linesNoteRange(4, base)).toEqual({ min: 8, max: 12 });
  expect(linesNoteRange(40, { min: 12, max: 96 })).toEqual({ min: 12, max: 96 });
});

const ctx: PromptContext = {
  text: 'cold light\nfalls',
  harmony: 'choral',
  delivery: 'unison',
  voiceCount: 3,
  stylePack: [],
  rhythmRange: { minBeats: 0.5, maxBeats: 4 },
  register: { top: 67, spanSemitones: 24 },
  syllableBudget: 3,
  key: 'C',
  mode: 'major',
  bpm: 140,
  bars: 8,
  timeSignature: '4/4',
  quarterNotesPerBar: 4,
  chordSummary: 'C → G',
  notesPerBeat: 2,
};

it('pinned lines: one phrase per line, the note range, the lines named', () => {
  const pinned = { ...ctx, pinnedLines: [{ text: 'cold light', syllables: 2 }, { text: 'falls', syllables: 1 }], noteRange: { min: 6, max: 9 } };
  const system = buildText2VoiceSystemPrompt(pinned);
  expect(system).toContain('The words are ALREADY WRITTEN');
  expect(system).toContain('- Line 1 (2 syllables): cold light');
  expect(system).toContain('Write 6-9 melody notes in all');
  expect(buildText2VoiceUserPrompt(pinned)).toContain('Compose the music for these 2 written line(s)');
});

it('without pinned lines the prompts are the old ones', () => {
  expect(buildText2VoiceSystemPrompt(ctx)).not.toContain('ALREADY WRITTEN');
  expect(buildText2VoiceUserPrompt(ctx)).toContain('Set a phrase from this text as a vocal line');
});
