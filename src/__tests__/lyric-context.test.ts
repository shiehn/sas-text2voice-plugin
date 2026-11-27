/**
 * S-443: the lyric context (after SynthV S-403/S-423). Documents are generic
 * fixture text here. They are kept in project data, read from files through
 * the host's picker, and fed to ✍ as BACKGROUND (never sung, never quoted
 * wholesale); the manifest declares the file picker.
 */
import { asTextFileHost, checkTextFile, chooseLyricFiles, FILE_HOST_MISSING_MESSAGE, readLyricFile, titleFromPath } from '../lyric-files';
import {
  addDocument,
  asLyricPack,
  contextExcerpt,
  emptyPack,
  LYRIC_DOC_MAX_CHARS,
  LYRIC_PACK_MAX_DOCS,
  packSummary,
  removeDocument,
  replaceDocument,
  TEXT2VOICE_LYRIC_PACK_KEY,
  titleFromText,
} from '../lyric-pack';
import { buildSongWordsSystemPrompt } from '../prompt';
import { writeSceneWords } from '../song-writer';
import { fakeSongHost, outlineOf } from './helpers/fake-song-host';

const STORY = [
  '# The Lighthouse Keeper',
  '',
  'A keeper lives alone on a cold coast and counts the ships that pass in the fog.',
  '',
  'Every night she climbs the iron stairs and lights the lamp for strangers.',
].join('\n');
const WORLD = 'The harbour town is built of grey stone. The bell in the square rings at dusk.';

describe('the pack', () => {
  it('adds with an optional title (from the first heading or line), removes, re-reads', () => {
    let pack = addDocument(emptyPack(), { text: STORY }, 1).pack;
    expect(pack.documents[0].title).toBe('The Lighthouse Keeper');
    pack = addDocument(pack, { title: 'World', text: WORLD, source: 'file', path: '/notes/world.md' }, 2).pack;
    expect(pack.documents.map((d) => [d.title, d.source, d.path])).toEqual([
      ['The Lighthouse Keeper', 'paste', undefined],
      ['World', 'file', '/notes/world.md'],
    ]);
    const id = pack.documents[1].id;
    pack = replaceDocument(pack, id, 'The bell rings twice.', 3).pack;
    expect(pack.documents[1].text).toBe('The bell rings twice.');
    pack = removeDocument(pack, pack.documents[0].id).pack;
    expect(pack.documents).toHaveLength(1);
    expect(packSummary(pack)).toBe('1 document · 21 characters');
  });

  it('refuses an empty document and cuts an over-long one, saying so', () => {
    expect(addDocument(emptyPack(), { text: '   ' }).note).toMatch(/empty/);
    const big = addDocument(emptyPack(), { title: 'Big', text: 'x'.repeat(LYRIC_DOC_MAX_CHARS + 10) });
    expect(big.pack.documents[0].text.length).toBe(LYRIC_DOC_MAX_CHARS);
    expect(big.note).toMatch(/only the first/);
  });

  it('holds a limited number of documents', () => {
    let pack = emptyPack();
    for (let i = 0; i < LYRIC_PACK_MAX_DOCS; i++) pack = addDocument(pack, { text: `note ${i}` }, i).pack;
    expect(addDocument(pack, { text: 'one more' }).note).toMatch(/at most/);
  });

  it('reads a stored pack tolerantly', () => {
    expect(asLyricPack({ documents: [{ id: 'a', text: 'x' }, { id: 'a', text: 'dup' }, { nope: 1 }] })?.documents).toHaveLength(1);
    expect(asLyricPack(null)).toBeNull();
    expect(TEXT2VOICE_LYRIC_PACK_KEY).toBe('text2voiceLyricPack');
  });

  it('titles from text and paths', () => {
    expect(titleFromText('\n\n- first item here\nmore')).toBe('first item here');
    expect(titleFromPath('/a/b/my_story.draft.md')).toBe('my story.draft');
  });
});

describe('files', () => {
  const host = (files: Record<string, string>, pick: string[] | null) => ({
    showOpenDialog: jest.fn(async () => pick),
    readTextFile: jest.fn(async (p: string) => files[p] ?? null),
  });

  it('opens the picker for text documents, several at a time', async () => {
    const h = host({}, ['/x/a.md']);
    expect(await chooseLyricFiles(h)).toEqual(['/x/a.md']);
    expect(h.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ multiSelections: true }));
  });

  it('reads text, refuses binary or missing files in plain words', async () => {
    const h = host({ '/x/a.md': STORY, '/x/b.bin': 'ab\u0000cd' }, null);
    expect(await readLyricFile(h, '/x/a.md')).toEqual(expect.objectContaining({ ok: true, name: 'a.md' }));
    expect(await readLyricFile(h, '/x/b.bin')).toEqual(expect.objectContaining({ ok: false, reason: 'not-text' }));
    expect(await readLyricFile(h, '/x/gone.txt')).toEqual(expect.objectContaining({ ok: false, reason: 'missing' }));
    expect(checkTextFile('﻿hello').ok).toBe(true);
  });

  it('a host without the file methods is detected (and the message says why)', () => {
    expect(asTextFileHost({})).toBeNull();
    expect(FILE_HOST_MISSING_MESSAGE).toMatch(/newer Signals & Sorcery Studio/);
  });

  it('plugin.json declares the file picker capability (registered at app start)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const manifest = require('../../plugin.json');
    expect(manifest.capabilities.fileDialog).toBe(true);
    // The song lyric document and the arrangement outline are SDK 3.24.0 surface.
    const [maj, min] = String(manifest.minHostVersion).split('.').map(Number);
    expect(maj > 3 || (maj === 3 && min >= 24)).toBe(true);
  });
});

describe('the context feeds the prompt as background', () => {
  it('a small pack goes whole, titled', () => {
    let pack = addDocument(emptyPack(), { text: STORY }, 1).pack;
    pack = addDocument(pack, { title: 'World', text: WORLD }, 2).pack;
    const ex = contextExcerpt(pack, 'ships');
    expect(ex.mode).toBe('whole');
    expect(ex.text).toContain('### The Lighthouse Keeper');
    expect(ex.text).toContain('### World');
  });

  it('a large pack sends openings plus the paragraphs that match the focus, inside the budget', () => {
    const filler = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} is about grain prices and ledgers.`).join('\n\n');
    let pack = addDocument(emptyPack(), { title: 'Ledger', text: `${filler}\n\nThe lighthouse lamp burns over the fog.` }, 1).pack;
    pack = addDocument(pack, { title: 'World', text: WORLD }, 2).pack;
    const ex = contextExcerpt(pack, 'lighthouse fog lamp', 2000);
    expect(ex.mode).toBe('passages');
    expect(ex.text.length).toBeLessThanOrEqual(2200);
    expect(ex.text).toContain('The lighthouse lamp burns over the fog.');
    expect(ex.text).toContain('Paragraph 0 is about grain prices');
    expect(ex.text).toContain('### World');
  });

  it('the writer prompt carries the background and says never to quote it', () => {
    const prompt = buildSongWordsSystemPrompt({
      about: 'a night at sea',
      songOrder: '',
      background: STORY,
      sections: [],
      stylePack: [],
      song: false,
    });
    expect(prompt).toContain("## Background (the songwriter's documents)");
    expect(prompt).toContain('counts the ships that pass in the fog');
    expect(prompt).toMatch(/NEVER quote them wholesale/);
  });

  it('✍ in Scene view sends the project documents with the call', async () => {
    const fake = fakeSongHost({ outline: outlineOf(), activeSceneId: 'A', owned: [] });
    fake.project.set(TEXT2VOICE_LYRIC_PACK_KEY, addDocument(emptyPack(), { text: STORY }, 1).pack);
    const r = await writeSceneWords(fake.host, {
      sceneId: 'A',
      config: { text: '', harmony: 'choral', delivery: 'unison', character: 'choir', voiceCount: 3, notesPerBeat: 2, topic: 'the fog' },
      melody: null,
      bars: 8,
    });
    const system = fake.requests[0].systemInstruction?.parts?.[0]?.text ?? '';
    expect(system).toContain('Every night she climbs the iron stairs');
    expect(r.words.fit).toBe('lines');
    expect(r.words.lines?.map((l) => l.length)).toEqual([2, 2]);
  });
});
