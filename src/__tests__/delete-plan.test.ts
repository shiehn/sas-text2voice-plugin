import {
  planVoiceDelete,
  readingDeleteMessage,
  READING_DELETE_CLEANUP_SUFFIXES,
  VOICE_DELETE_CLEANUP_SUFFIXES,
  TEXT2VOICE_CONFIG_KEY,
  TEXT2VOICE_MELODY_KEY,
  TEXT2VOICE_VOICE_META_KEY,
  TEXT2VOICE_WORDS_KEY,
  type VoiceMemberRef,
} from '../voice-meta';

// The midmids "Ab major" reading (2026-08-28): lead + two harmonies. The lead's
// ✕ opened "Delete track?" and then did nothing — the anchor guard bailed.
const lead: VoiceMemberRef = { dbId: 'fc0d9e1f', engineId: '5712', voiceIndex: 0 };
const h1: VoiceMemberRef = { dbId: 'f816c9a5', engineId: '5717', voiceIndex: 1 };
const h2: VoiceMemberRef = { dbId: 'b58ad82c', engineId: '5722', voiceIndex: 2 };
// Deliberately unsorted: resolveTrackGroups sorts, but the plan must not rely on it.
const members = [h1, lead, h2];

describe('planVoiceDelete', () => {
  it('anchor ✕ removes the WHOLE reading, harmonies first and the anchor last', () => {
    const plan = planVoiceDelete(members, lead);
    expect(plan.scope).toBe('reading');
    expect(plan.members.map((m) => m.engineId)).toEqual(['5722', '5717', '5712']);
    expect(plan.members.map((m) => m.dbId)).toEqual(['b58ad82c', 'f816c9a5', 'fc0d9e1f']);
  });

  it('header ✕ (no target) is the same gesture as the anchor ✕', () => {
    expect(planVoiceDelete(members)).toEqual(planVoiceDelete(members, lead));
  });

  it('a harmony ✕ removes ONLY that lane', () => {
    const plan = planVoiceDelete(members, h2);
    expect(plan.scope).toBe('voice');
    expect(plan.members).toEqual([{ engineId: '5722', dbId: 'b58ad82c' }]);
  });

  it('the reading plan sweeps the anchor-held artifacts; the voice plan never does', () => {
    const reading = planVoiceDelete(members, lead).cleanupKeySuffixes;
    for (const k of [TEXT2VOICE_CONFIG_KEY, TEXT2VOICE_MELODY_KEY, TEXT2VOICE_WORDS_KEY]) {
      expect(reading).toContain(k);
    }
    const voice = planVoiceDelete(members, h1).cleanupKeySuffixes;
    for (const k of [TEXT2VOICE_CONFIG_KEY, TEXT2VOICE_MELODY_KEY, TEXT2VOICE_WORDS_KEY]) {
      expect(voice).not.toContain(k);
    }
    // Both drop the membership stamp — a leftover meta would resurrect a ghost row.
    expect(reading).toContain(TEXT2VOICE_VOICE_META_KEY);
    expect(voice).toContain(TEXT2VOICE_VOICE_META_KEY);
    expect(reading).toEqual([...READING_DELETE_CLEANUP_SUFFIXES]);
    expect(voice).toEqual([...VOICE_DELETE_CLEANUP_SUFFIXES]);
  });

  it('returns fresh arrays — callers may mutate without touching the constants', () => {
    const plan = planVoiceDelete(members, lead);
    plan.cleanupKeySuffixes.push('x');
    expect(READING_DELETE_CLEANUP_SUFFIXES).not.toContain('x');
    expect(members).toEqual([h1, lead, h2]);
  });

  it('a reading of one (freshly added, never sung) still plans as a reading', () => {
    const plan = planVoiceDelete([lead], lead);
    expect(plan.scope).toBe('reading');
    expect(plan.members).toEqual([{ engineId: '5712', dbId: 'fc0d9e1f' }]);
  });
});

describe('readingDeleteMessage', () => {
  it('counts the voices honestly', () => {
    expect(readingDeleteMessage(1)).toBe('Removes the voice track and the text.');
    expect(readingDeleteMessage(3)).toBe('Removes all 3 voice tracks and the text.');
  });
});
