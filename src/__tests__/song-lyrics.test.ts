/**
 * S-443: verses through the HOST-owned song lyric document (SDK 3.24.0, the
 * SDK's in-memory reference host): ✍ in Song view writes the whole song in one
 * call (one section per placed scene with a reading, its later placements
 * repeating it), the boxes that follow the song get their section, Sing reads
 * the active scene's section, the take is recorded, and the S-431 anchor
 * rules hold (another plugin's track: skipped with the reason; a deleted
 * track: the section is free).
 */
import { isSectionTakeStale, resolveSectionLines } from '@signalsandsorcery/plugin-sdk';
import { FOREIGN_TRACK_REASON, NO_READING_REASON, anchorStatus } from '../reading-anchor';
import {
  currentSection,
  loadSongSheet,
  NOT_PLACED_MESSAGE,
  pushSectionLines,
  recordRendered,
  wordsForLines,
  wordsMatchLines,
} from '../song-lyrics';
import { planSection, songResultSummary, writeSceneWords, writeSongWords } from '../song-writer';
import { asText2VoiceConfig, asText2VoiceWords, type Text2VoiceConfig, type Text2VoiceMelody } from '../voice-meta';
import { fakeSongHost, outlineOf, putReading } from './helpers/fake-song-host';

const SYNTHV = '@signalsandsorcery/synthv-generator';

const CONFIG: Text2VoiceConfig = { text: '', harmony: 'choral', delivery: 'unison', character: 'choir', voiceCount: 3, notesPerBeat: 2, topic: 'a night crossing', view: 'song' };

/** intro A · verse B · chorus C · verse B · chorus C · outro D (no reading). */
function song(extra: Partial<Parameters<typeof fakeSongHost>[0]> = {}) {
  const fake = fakeSongHost({
    outline: outlineOf(['i1', 'A', 8], ['i2', 'B', 8], ['i3', 'C', 8], ['i4', 'B', 8], ['i5', 'C', 8], ['i6', 'D', 8]),
    activeSceneId: 'B',
    owned: ['r-a', 'r-b', 'r-c'],
    familyByScene: { A: ['r-a'], B: ['r-b'], C: ['r-c'] },
    ...extra,
  });
  putReading(fake, 'A', 'r-a');
  putReading(fake, 'B', 'r-b', { view: 'song' });
  putReading(fake, 'C', 'r-c');
  return fake;
}

describe('the song document round-trip', () => {
  it('one call writes every scene with a reading; repeats share; the instrumental is skipped with its reason', async () => {
    const fake = song();
    const r = await writeSongWords(fake.host, { sceneId: 'B', anchorDbId: 'r-b', config: CONFIG, melody: null });
    expect(fake.requests).toHaveLength(1);
    const doc = fake.song.document();
    expect(doc?.description).toBe('a night crossing');
    // A, B, C written (2 lines of 2 syllables for 8 bars of the default choir); the repeats mirror them.
    for (const id of ['i1', 'i2', 'i3']) {
      expect(doc?.sections[id].lines).toHaveLength(2);
      expect(doc?.sections[id].lines.every((l) => l.split(' ').length === 2)).toBe(true);
    }
    expect(doc?.sections.i4.sameAs).toBe('i2');
    expect(resolveSectionLines(doc, 'i4')).toEqual(doc?.sections.i2.lines);
    expect(doc?.sections.i5.sameAs).toBe('i3');
    expect(doc?.sections.i6).toBeUndefined();
    expect(r.skipped).toEqual([{ instanceId: 'i6', label: 'Scene D', reason: NO_READING_REASON }]);
    // Each section is claimed by its scene's reading.
    expect([doc?.sections.i1.voiceTrackDbId, doc?.sections.i2.voiceTrackDbId, doc?.sections.i3.voiceTrackDbId]).toEqual(['r-a', 'r-b', 'r-c']);
    expect(r.sections.map((s) => s.repeats)).toEqual([[], ['i4'], ['i5']]);
    expect(songResultSummary(r)).toMatch(/3 sections written · 2 repeats share their words · skipped: Scene D/);
  });

  it('the boxes that follow the song get their section, ready for Sing; a box with its own words keeps them', async () => {
    const fake = song();
    putReading(fake, 'C', 'r-c', { text: 'my own words for this scene' });
    const r = await writeSongWords(fake.host, { sceneId: 'B', anchorDbId: 'r-b', config: CONFIG, melody: null });
    const doc = fake.song.document();
    const cfgB = asText2VoiceConfig(fake.data('B').get('track:r-b:text2voiceConfig'));
    expect(cfgB?.text).toBe(doc?.sections.i2.lines.join('\n'));
    expect(cfgB?.view).toBe('song');
    const wordsB = asText2VoiceWords(fake.data('B').get('track:r-b:text2voiceWords'));
    expect(wordsB?.fit).toBe('lines');
    expect(wordsB?.sectionId).toBe('i2');
    expect(wordsMatchLines(wordsB, doc?.sections.i2.lines ?? [])).toBe(true);
    // A's box was empty: it follows the song now. C's box had words of its own: kept.
    expect(asText2VoiceConfig(fake.data('A').get('track:r-a:text2voiceConfig'))?.view).toBe('song');
    expect(asText2VoiceConfig(fake.data('C').get('track:r-c:text2voiceConfig'))?.text).toBe('my own words for this scene');
    expect(r.keptBox).toEqual(['Scene C (1)']);
  });

  it('Sing reads the active scene section; the take is recorded; a later edit makes it stale', async () => {
    const fake = song();
    await writeSongWords(fake.host, { sceneId: 'B', anchorDbId: 'r-b', config: CONFIG, melody: null });
    const cur = await currentSection(fake.host, 'B', 'r-b');
    expect(cur.ok).toBe(true);
    if (!cur.ok) return;
    expect(cur.instanceId).toBe('i2');
    expect(cur.placements.map((p) => p.instanceId)).toEqual(['i2', 'i4']);
    const prior = asText2VoiceWords(fake.data('B').get('track:r-b:text2voiceWords'));
    const words = wordsForLines(cur.lines, prior, { sectionId: cur.instanceId });
    expect(words?.lines).toEqual(prior?.lines);
    expect(await recordRendered(fake.host, cur.placements, cur.lines, 'r-b')).toBe(2);
    let doc = fake.song.document();
    expect(isSectionTakeStale(doc, 'i2')).toBe(false);
    expect(doc?.sections.i4.renderedSig).toBe(doc?.sections.i2.renderedSig);
    fake.song.hostWrite('i2', { lines: ['bright water', 'falls'] });
    doc = fake.song.document();
    expect(isSectionTakeStale(doc, 'i2')).toBe(true);
  });

  it('lines edited outside the plugin get a plain split (no model call)', () => {
    const w = wordsForLines(['under the silver rain', '', 'home'], null);
    expect(w?.lineTexts).toEqual(['under the silver rain', 'home']);
    expect(w?.lines).toEqual([['un', 'der', 'the', 'sil', 'ver', 'rain'], ['home']]);
    expect(w?.fit).toBe('lines');
  });

  it('Song-view edits go into the section; a repeat becomes its own first', async () => {
    const fake = song();
    await writeSongWords(fake.host, { sceneId: 'B', anchorDbId: 'r-b', config: CONFIG, melody: null });
    expect(await pushSectionLines(fake.host, 'i4', ['a second verse', 'of its own'], 'r-b')).toEqual({ ok: true });
    const doc = fake.song.document();
    expect(doc?.sections.i4.sameAs).toBeUndefined();
    expect(doc?.sections.i4.lines).toEqual(['a second verse', 'of its own']);
  });

  it('a scene that is not placed says so', async () => {
    const fake = song();
    expect(await currentSection(fake.host, 'Z', 'r-z')).toEqual({ ok: false, reason: NOT_PLACED_MESSAGE });
  });
});

describe('anchors (S-431): skipped with the reason, or free', () => {
  it("a section an existing track of another plugin sings is skipped; the scene's free placement sings instead", async () => {
    const fake = song({
      others: { 'synthv-1': SYNTHV },
      activeSceneTracks: ['synthv-1'],
      doc: null,
    });
    fake.song.hostWrite('i2', { lines: ['their words'], voiceTrackDbId: 'synthv-1' });
    expect(await anchorStatus(fake.host, 'B', 'synthv-1', ['r-b'])).toBe('foreign');
    const r = await writeSongWords(fake.host, { sceneId: 'B', anchorDbId: 'r-b', config: CONFIG, melody: null });
    expect(r.skipped).toContainEqual({ instanceId: 'i2', label: 'Scene B (1)', reason: FOREIGN_TRACK_REASON });
    const doc = fake.song.document();
    expect(doc?.sections.i2.lines).toEqual(['their words']);
    expect(doc?.sections.i4.voiceTrackDbId).toBe('r-b');
    expect(doc?.sections.i4.lines).toHaveLength(2);
    const cur = await currentSection(fake.host, 'B', 'r-b');
    expect(cur.ok && cur.instanceId).toBe('i4');
    // The Song view shows the skip and its reason.
    const sheet = await loadSongSheet(fake.host, { activeSceneId: 'B' });
    expect(sheet.ok && sheet.rows.find((x) => x.instanceId === 'i2')).toEqual(expect.objectContaining({ status: 'foreign', reason: FOREIGN_TRACK_REASON }));
    expect(sheet.ok && sheet.rows.find((x) => x.instanceId === 'i6')).toEqual(expect.objectContaining({ status: 'no-reading', reason: NO_READING_REASON }));
  });

  it('in another scene the host has the last word: its refusal is reported, not thrown', async () => {
    const fake = song({ others: { 'synthv-2': SYNTHV } });
    fake.song.hostWrite('i3', { lines: ['theirs'], voiceTrackDbId: 'synthv-2' });
    const r = await writeSongWords(fake.host, { sceneId: 'B', anchorDbId: 'r-b', config: CONFIG, melody: null });
    expect(r.skipped).toContainEqual({ instanceId: 'i3', label: 'Scene C (1)', reason: FOREIGN_TRACK_REASON });
    expect(fake.song.document()?.sections.i3.lines).toEqual(['theirs']);
  });

  it('a section whose reading was deleted is free: re-anchored to the current reading', async () => {
    const fake = song();
    fake.song.hostWrite('i1', { lines: ['old words'], voiceTrackDbId: 'deleted-1' });
    expect(await anchorStatus(fake.host, 'A', 'deleted-1', ['r-a'])).toBe('gone');
    const r = await writeSongWords(fake.host, { sceneId: 'B', anchorDbId: 'r-b', config: CONFIG, melody: null });
    const a = r.sections.find((s) => s.instanceId === 'i1');
    expect(a?.reanchored).toMatch(/deleted: re-anchored/);
    const doc = fake.song.document();
    expect(doc?.sections.i1.voiceTrackDbId).toBe('r-a');
    expect(doc?.sections.i1.lines).not.toEqual(['old words']);
  });
});

describe('the grid a section asks for', () => {
  const melody: Text2VoiceMelody = {
    voices: [
      [
        { pitch: 60, startBeat: 0, durationBeats: 4, velocity: 88 },
        { pitch: 62, startBeat: 4, durationBeats: 4, velocity: 88 },
        { pitch: 64, startBeat: 16, durationBeats: 2, velocity: 88 },
        { pitch: 62, startBeat: 18, durationBeats: 2, velocity: 88 },
        { pitch: 60, startBeat: 20, durationBeats: 2, velocity: 88 },
      ],
    ],
    composedHarmony: null,
    bpm: 140,
    bars: 8,
    key: 'C',
    mode: 'major',
    quarterNotesPerBar: 4,
  };

  it('a kept melody: one line per phrase, the budget shared by length', () => {
    const plan = planSection(CONFIG, melody, 8, 'none');
    expect(plan.fromMelody).toBe(true);
    expect(plan.targets).toEqual([2, 2]);
  });

  it('no melody: words first, by the style', () => {
    expect(planSection(CONFIG, null, 16, 'AABB')).toEqual(expect.objectContaining({ targets: [2, 2, 2, 2], letters: ['A', 'A', 'B', 'B'], fromMelody: false }));
    const trap = { ...CONFIG, style: 'trap' as const, harmony: 'unison' as const, character: 'machine' as const, notesPerBeat: 3 };
    expect(planSection(trap, null, 8, 'none').targets).toEqual([6, 6, 6, 6, 6, 6, 6, 6]);
  });

  it('a line over its count is cut at a word: the words never overflow the bar', async () => {
    const fake = fakeSongHost({
      outline: outlineOf(),
      activeSceneId: 'A',
      owned: [],
      answer: () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'submit_text2voice_song',
                    args: { sections: [{ key: 's1', role: 'verse', lines: [{ text: 'under the silver rain', syllables: ['un', 'der', 'the', 'sil', 'ver', 'rain'] }, { text: 'home', syllables: ['home'] }] }] },
                  },
                },
              ],
            },
          },
        ],
      }),
    });
    const r = await writeSceneWords(fake.host, { sceneId: 'A', config: CONFIG, melody: null, bars: 8 });
    expect(r.trimmed).toBe(1);
    expect(r.words.lineTexts).toEqual(['under', 'home']);
    expect(r.words.lines?.map((l) => l.length)).toEqual([2, 1]);
  });
});
