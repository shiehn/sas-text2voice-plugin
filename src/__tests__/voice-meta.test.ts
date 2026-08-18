import {
  asText2VoiceComposition,
  asText2VoiceConfig,
  asText2VoiceMeta,
  compositionIsReusable,
  MAX_TEXT_LENGTH,
  planReconcile,
  type Text2VoiceComposition,
  type Text2VoiceConfig,
} from '../voice-meta';

const config: Text2VoiceConfig = {
  text: 'the observable universe',
  harmony: 'choral',
  delivery: 'unison',
  character: 'choir',
  voiceCount: 2,
  notesPerBeat: 2,
};

const composition: Text2VoiceComposition = {
  phrase: 'observable universe',
  syllables: ['ob', 'serv', 'a', 'ble'],
  voices: [[], []],
  bpm: 120,
  bars: 8,
  harmony: 'choral',
  delivery: 'unison',
};

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

describe('asText2VoiceComposition', () => {
  it('round-trips a stored composition', () => {
    expect(asText2VoiceComposition(composition)).toEqual(composition);
  });

  it('rejects a malformed cache rather than replaying garbage', () => {
    expect(asText2VoiceComposition({ phrase: 'x' })).toBeNull();
    expect(asText2VoiceComposition({ ...composition, voices: 'nope' })).toBeNull();
    expect(asText2VoiceComposition({ ...composition, voices: [1, 2] })).toBeNull();
  });
});

describe('compositionIsReusable', () => {
  it('reuses the cache when only render-time settings changed', () => {
    // Character and system voice are render-time: no new model call needed.
    expect(compositionIsReusable(composition, { ...config, character: 'ghost' }, 120, 8)).toBe(true);
    expect(compositionIsReusable(composition, { ...config, ttsVoice: 'Zarvox' }, 120, 8)).toBe(true);
  });

  it('invalidates when a compose-time setting changed', () => {
    expect(compositionIsReusable(composition, { ...config, harmony: 'organum' }, 120, 8)).toBe(false);
    expect(compositionIsReusable(composition, { ...config, delivery: 'canon' }, 120, 8)).toBe(false);
    expect(compositionIsReusable(composition, { ...config, voiceCount: 4 }, 120, 8)).toBe(false);
  });

  it('invalidates when the scene shape changed', () => {
    expect(compositionIsReusable(composition, config, 140, 8)).toBe(false);
    expect(compositionIsReusable(composition, config, 120, 16)).toBe(false);
  });

  it('never reuses an absent or empty cache', () => {
    expect(compositionIsReusable(null, config, 120, 8)).toBe(false);
    expect(compositionIsReusable({ ...composition, syllables: [] }, config, 120, 8)).toBe(false);
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
