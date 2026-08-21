import {
  asText2VoiceConfig,
  asText2VoiceMelody,
  asText2VoiceMeta,
  asText2VoiceWords,
  MAX_TEXT_LENGTH,
  melodyIsReusable,
  planGeneration,
  planReconcile,
  type SceneShapeKey,
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

const scene: SceneShapeKey = {
  bpm: 120,
  bars: 8,
  key: 'C',
  mode: 'major',
  quarterNotesPerBar: 4,
};

const note = { pitch: 60, startBeat: 0, durationBeats: 1, velocity: 90 };

const melody: Text2VoiceMelody = {
  voices: [[note], [note]],
  composedHarmony: 'choral',
  bpm: 120,
  bars: 8,
  key: 'C',
  mode: 'major',
  quarterNotesPerBar: 4,
};

/** A derived-style melody: only the lead is cached; fan-out is render-time. */
const leadOnly: Text2VoiceMelody = { ...melody, voices: [[note]], composedHarmony: null };

const words: Text2VoiceWords = {
  phrase: 'observable universe',
  syllables: ['ob', 'serv', 'a', 'ble'],
  source: 'quote',
};

/** The default: everything cached and the phrase still present in the text. */
const plan = (over: Partial<Parameters<typeof planGeneration>[0]> = {}) =>
  planGeneration({
    melody,
    words,
    config,
    scene,
    phraseStillInSource: true,
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

  it('carries no forceMelody — the one-shot request rides its own key', () => {
    // As a config field the flag latched forever when a run threw, and any
    // dropdown persist erased a pending request.
    const c = asText2VoiceConfig({ text: 'hi', forceMelody: true });
    expect(c).not.toBeNull();
    expect('forceMelody' in (c as object)).toBe(false);
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
    expect(asText2VoiceMelody({ ...melody, voices: [[]] })).toBeNull();
    expect(asText2VoiceWords({ phrase: 'x' })).toBeNull();
    expect(asText2VoiceWords({ phrase: 'x', syllables: [] })).toBeNull();
  });

  it('rejects legacy caches that cannot prove their key', () => {
    // Pre-key/mode caches replayed verbatim after a key change — audibly out
    // of key with no signal. One recompose on first touch is the cheaper cost.
    const legacy = { voices: [[note]], slotCount: 4, bpm: 120, bars: 8, harmony: 'choral' };
    expect(asText2VoiceMelody(legacy)).toBeNull();
  });

  it('treats a derived-style harmony as NOT composed', () => {
    const m = asText2VoiceMelody({ ...melody, composedHarmony: 'unison' });
    expect(m!.composedHarmony).toBeNull();
  });
});

describe('melodyIsReusable', () => {
  it('ignores the settings the user is expected to churn', () => {
    expect(melodyIsReusable(melody, { ...config, text: 'completely different' }, scene)).toBe(true);
    expect(melodyIsReusable(melody, { ...config, character: 'ghost' }, scene)).toBe(true);
    expect(melodyIsReusable(melody, { ...config, ttsVoice: 'Zarvox' }, scene)).toBe(true);
    // Pace is a render/reword-time knob — never a recompose.
    expect(melodyIsReusable(melody, { ...config, notesPerBeat: 4 }, scene)).toBe(true);
  });

  it('never reuses notes written against a different key, mode, or meter', () => {
    expect(melodyIsReusable(melody, config, { ...scene, key: 'F#' })).toBe(false);
    expect(melodyIsReusable(melody, config, { ...scene, mode: 'minor' })).toBe(false);
    expect(melodyIsReusable(melody, config, { ...scene, quarterNotesPerBar: 3 })).toBe(false);
    expect(melodyIsReusable(melody, config, { ...scene, bpm: 140 })).toBe(false);
    expect(melodyIsReusable(melody, config, { ...scene, bars: 16 })).toBe(false);
  });

  it('lets DELIVERY change without invalidating — arrangement is render-time', () => {
    expect(melodyIsReusable(melody, { ...config, delivery: 'canon' }, scene)).toBe(true);
    expect(melodyIsReusable(leadOnly, { ...config, harmony: 'drone', delivery: 'hocket' }, scene)).toBe(true);
  });

  it('reuses ANY melody for a derived harmony target — the fan-out is recomputed', () => {
    // Flipping through derived styles must be free, or exploring styles costs
    // a full compose per click.
    for (const h of ['unison', 'organum', 'drone'] as const) {
      expect(melodyIsReusable(leadOnly, { ...config, harmony: h, voiceCount: 5 }, scene)).toBe(true);
      expect(melodyIsReusable(melody, { ...config, harmony: h }, scene)).toBe(true);
    }
  });

  it('requires a matching joint composition for a composed target', () => {
    expect(melodyIsReusable(melody, { ...config, harmony: 'choral', voiceCount: 2 }, scene)).toBe(true);
    expect(melodyIsReusable(melody, { ...config, harmony: 'counterpoint' }, scene)).toBe(false);
    expect(melodyIsReusable(melody, { ...config, harmony: 'choral', voiceCount: 4 }, scene)).toBe(false);
    // A lead-only cache cannot serve a composed target.
    expect(melodyIsReusable(leadOnly, { ...config, harmony: 'choral', voiceCount: 2 }, scene)).toBe(false);
  });

  it('never reuses an absent melody', () => {
    expect(melodyIsReusable(null, config, scene)).toBe(false);
  });
});

describe('planGeneration', () => {
  it('renders only when nothing that matters changed', () => {
    expect(plan()).toBe('render');
  });

  it('re-words — keeping the melody — when the phrase is no longer in the text', () => {
    expect(plan({ phraseStillInSource: false })).toBe('reword');
  });

  it('re-words when there are no cached words but the melody survives', () => {
    expect(plan({ words: null })).toBe('reword');
  });

  it('composes when there is no melody at all', () => {
    expect(plan({ melody: null })).toBe('compose');
  });

  it('composes when the scene key changed — the notes are simply wrong', () => {
    expect(plan({ scene: { ...scene, key: 'F#' } })).toBe('compose');
    expect(plan({ scene: { ...scene, quarterNotesPerBar: 3 } })).toBe('compose');
  });

  it('composes only for a MISMATCHED composed target, not for derived flips', () => {
    expect(plan({ config: { ...config, harmony: 'cluster' } })).toBe('compose');
    expect(plan({ config: { ...config, harmony: 'organum', voiceCount: 6 } })).toBe('render');
    expect(plan({ config: { ...config, delivery: 'canon' } })).toBe('render');
  });

  it('composes when the user explicitly asks for new music', () => {
    expect(plan({ forceMelody: true })).toBe('compose');
  });

  it('prefers the cheapest sufficient path — editing text never forces a compose', () => {
    expect(plan({ phraseStillInSource: false, config: { ...config, text: 'new passage' } })).toBe(
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


describe('the lyrics box is the single source of truth (wordsReusable + \u270d)', () => {
  const writeConfig: Text2VoiceConfig = {
    ...config,
    sourceMode: 'write',
    topic: 'a robot falling in love',
    rhymeScheme: 'AABB',
  };
  const writtenWords: Text2VoiceWords = {
    phrase: 'circuits hum / systems love',
    syllables: ['cir', 'cuits', 'hum', 'sys', 'tems', 'love'],
    source: 'write',
    topic: 'a robot falling in love',
    rhymeScheme: 'AABB',
  };

  it('cached words survive exactly as long as their phrase is in the box', () => {
    expect(plan({ words: writtenWords, phraseStillInSource: true })).toBe('render');
    expect(plan({ words: writtenWords, phraseStillInSource: false })).toBe('reword');
  });

  it('prompt and rhyme are BUTTON parameters — editing them never invalidates', () => {
    // The old model re-worded the moment topic/rhyme/sourceMode changed under
    // it; now nothing happens until \u270d is actually pressed.
    expect(
      plan({
        config: { ...writeConfig, topic: 'the heat death of the universe', rhymeScheme: 'ABAB' },
        words: writtenWords,
        phraseStillInSource: true,
      }),
    ).toBe('render');
    expect(plan({ config: writeConfig, words, phraseStillInSource: true })).toBe('render');
  });

  // \u270d New words is now a WORDS-ONLY act handled BEFORE planning (it
  // updates the words and stops — nothing renders), so the planner has no
  // force-words input anymore; its behavior lives in generateText2Voice.


  it('legacy words rows read as quotes', () => {
    const w = asText2VoiceWords({ phrase: 'x y', syllables: ['x', 'y'] });
    expect(w!.source).toBe('quote');
  });
});
