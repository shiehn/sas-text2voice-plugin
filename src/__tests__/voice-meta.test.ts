import {
  asText2VoiceConfig,
  asText2VoiceMelody,
  asText2VoiceMeta,
  asText2VoiceWords,
  MAX_TEXT_LENGTH,
  melodyIsReusable,
  planGeneration,
  planReconcile,
  type Text2VoiceConfig,
  type Text2VoiceMelody,
  type Text2VoiceWords,
} from '../voice-meta';

const config: Text2VoiceConfig = {
  text: 'the observable universe',
  harmony: 'choral',
  delivery: 'unison',
  character: 'choir',
  voiceCount: 2,
  notesPerBeat: 2,
};

const melody: Text2VoiceMelody = {
  voices: [[], []],
  slotCount: 4,
  bpm: 120,
  bars: 8,
  harmony: 'choral',
  delivery: 'unison',
};

const words: Text2VoiceWords = {
  phrase: 'observable universe',
  syllables: ['ob', 'serv', 'a', 'ble'],
};

/** The default: everything cached and the phrase still present in the text. */
const plan = (over: Partial<Parameters<typeof planGeneration>[0]> = {}) =>
  planGeneration({
    melody,
    words,
    config,
    bpm: 120,
    bars: 8,
    wordsStillInSource: true,
    ...over,
  });

describe('asText2VoiceConfig', () => {
  it('normalizes unknown stored values instead of rejecting the config', () => {
    const c = asText2VoiceConfig({ text: 'hi', harmony: 'bogus', voiceCount: 99 });
    expect(c).not.toBeNull();
    expect(c!.harmony).toBe('choral');
    expect(c!.voiceCount).toBe(6);
    expect(c!.notesPerBeat).toBe(2);
  });

  it('truncates a pathological paste', () => {
    const c = asText2VoiceConfig({ text: 'x'.repeat(MAX_TEXT_LENGTH * 2) });
    expect(c!.text.length).toBe(MAX_TEXT_LENGTH);
  });

  it('rejects non-objects', () => {
    expect(asText2VoiceConfig(null)).toBeNull();
    expect(asText2VoiceConfig('nope')).toBeNull();
  });
});

describe('asText2VoiceMeta', () => {
  it('requires a group id and voice index', () => {
    expect(asText2VoiceMeta({ groupId: 'a', voiceIndex: 0 })).toEqual({
      groupId: 'a',
      voiceIndex: 0,
      label: '',
    });
    expect(asText2VoiceMeta({ voiceIndex: 0 })).toBeNull();
    expect(asText2VoiceMeta({ groupId: 'a' })).toBeNull();
  });
});

describe('asText2VoiceMelody / asText2VoiceWords', () => {
  it('round-trips stored caches', () => {
    expect(asText2VoiceMelody(melody)).toEqual(melody);
    expect(asText2VoiceWords(words)).toEqual(words);
  });

  it('rejects malformed caches rather than replaying garbage', () => {
    expect(asText2VoiceMelody({ voices: 'nope' })).toBeNull();
    expect(asText2VoiceMelody({ voices: [] })).toBeNull();
    expect(asText2VoiceMelody({ voices: [1, 2] })).toBeNull();
    expect(asText2VoiceWords({ phrase: 'x' })).toBeNull();
    expect(asText2VoiceWords({ phrase: 'x', syllables: [] })).toBeNull();
  });

  it('infers slotCount from the lead when an older cache omits it', () => {
    const m = asText2VoiceMelody({ ...melody, slotCount: undefined, voices: [[1, 2, 3], []] });
    expect(m!.slotCount).toBe(3);
  });
});

describe('melodyIsReusable', () => {
  it('ignores the settings the user is expected to churn', () => {
    // Text, character and speech voice must never cost a recompose — that is
    // the entire point of caching the melody separately.
    expect(melodyIsReusable(melody, { ...config, text: 'completely different' }, 120, 8)).toBe(true);
    expect(melodyIsReusable(melody, { ...config, character: 'ghost' }, 120, 8)).toBe(true);
    expect(melodyIsReusable(melody, { ...config, ttsVoice: 'Zarvox' }, 120, 8)).toBe(true);
  });

  it('invalidates when a setting that defines the notes changed', () => {
    expect(melodyIsReusable(melody, { ...config, harmony: 'organum' }, 120, 8)).toBe(false);
    expect(melodyIsReusable(melody, { ...config, delivery: 'canon' }, 120, 8)).toBe(false);
    expect(melodyIsReusable(melody, { ...config, voiceCount: 4 }, 120, 8)).toBe(false);
  });

  it('invalidates when the scene shape changed', () => {
    expect(melodyIsReusable(melody, config, 140, 8)).toBe(false);
    expect(melodyIsReusable(melody, config, 120, 16)).toBe(false);
  });

  it('never reuses an absent or empty melody', () => {
    expect(melodyIsReusable(null, config, 120, 8)).toBe(false);
    expect(melodyIsReusable({ ...melody, slotCount: 0 }, config, 120, 8)).toBe(false);
  });
});

describe('planGeneration', () => {
  it('renders only when nothing that matters changed', () => {
    expect(plan()).toBe('render');
  });

  it('re-words — keeping the melody — when the phrase is no longer in the text', () => {
    expect(plan({ wordsStillInSource: false })).toBe('reword');
  });

  it('re-words when there are no cached words but the melody survives', () => {
    expect(plan({ words: null })).toBe('reword');
  });

  it('composes when there is no melody at all', () => {
    expect(plan({ melody: null })).toBe('compose');
  });

  it('composes when a note-defining setting changed', () => {
    expect(plan({ config: { ...config, harmony: 'cluster' } })).toBe('compose');
    expect(plan({ config: { ...config, voiceCount: 5 } })).toBe('compose');
  });

  it('composes when the user explicitly asks for new music', () => {
    expect(plan({ forceMelody: true })).toBe('compose');
  });

  it('prefers the cheapest sufficient path — editing text never forces a compose', () => {
    // The scenario Steve cares about: swap the source text, keep the music.
    expect(plan({ wordsStillInSource: false, config: { ...config, text: 'new passage' } })).toBe(
      'reword',
    );
  });
});

describe('planReconcile', () => {
  const members = [
    { dbId: 'a', engineId: 'ea', voiceIndex: 0 },
    { dbId: 'b', engineId: 'eb', voiceIndex: 1 },
  ];

  it('reuses existing lanes positionally', () => {
    const plan = planReconcile(members, 2);
    expect(plan.reuse.map((r) => r.dbId)).toEqual(['a', 'b']);
    expect(plan.createBucketIndexes).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it('creates the shortfall and keeps the anchor', () => {
    const plan = planReconcile(members, 4);
    expect(plan.reuse.map((r) => r.dbId)).toEqual(['a', 'b']);
    expect(plan.createBucketIndexes).toEqual([2, 3]);
  });

  it('removes surplus lanes from the end, never the anchor', () => {
    const plan = planReconcile(members, 1);
    expect(plan.reuse.map((r) => r.dbId)).toEqual(['a']);
    expect(plan.remove.map((r) => r.dbId)).toEqual(['b']);
  });

  it('is order-independent on its input', () => {
    const plan = planReconcile([...members].reverse(), 2);
    expect(plan.reuse.map((r) => r.dbId)).toEqual(['a', 'b']);
  });
});
