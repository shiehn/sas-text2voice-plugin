/**
 * The LYRIC CONTEXT (S-443, after SynthV S-403/S-423, kept simple): a pack of
 * named documents for the whole project (a story draft, a world, style notes),
 * in PROJECT-scoped plugin data so it travels inside the .sas and every
 * reading in every scene shares it. Nothing here knows what the documents are
 * about: they are text with a title.
 *
 * The documents are BACKGROUND for ✍ New words (story, imagery, vocabulary):
 * `contextExcerpt` gives the prompt the whole pack when it is small and, when
 * it is large, each document's opening plus the paragraphs that share the most
 * words with what is being written, inside one character budget. The writer's
 * prompt says never to quote them wholesale. The quote path (Sing on the
 * lyrics box) never sees them.
 */

import type { PluginHost } from '@signalsandsorcery/plugin-sdk';

/** PROJECT-scoped: the document pack. */
export const TEXT2VOICE_LYRIC_PACK_KEY = 'text2voiceLyricPack';

/** All documents together, in characters. */
export const LYRIC_PACK_MAX_CHARS = 300_000;
/** One document, in characters. */
export const LYRIC_DOC_MAX_CHARS = 200_000;
/** How many documents a pack holds. */
export const LYRIC_PACK_MAX_DOCS = 24;
export const LYRIC_DOC_TITLE_MAX_CHARS = 120;
export const LYRIC_DOC_PATH_MAX_CHARS = 4096;
/** A title derived from a file name or the first line is cut at this length. */
export const LYRIC_DOC_DERIVED_TITLE_MAX_CHARS = 60;
/** What one ✍ prompt carries of the pack, in characters (~4k tokens). */
export const CONTEXT_EXCERPT_MAX_CHARS = 16_000;

export type LyricDocSource = 'paste' | 'file';

export interface LyricDocument {
  id: string;
  title: string;
  text: string;
  source: LyricDocSource;
  /** The file it was read from (source 'file'), so it can be read again. */
  path?: string;
  addedAt: number;
  updatedAt?: number;
}

export interface LyricPack {
  version: 1;
  documents: LyricDocument[];
  updatedAt: number;
}

export const emptyPack = (): LyricPack => ({ version: 1, documents: [], updatedAt: 0 });

function cleanTitle(t: unknown, fallback: string): string {
  const s = typeof t === 'string' ? t.replace(/\s+/g, ' ').trim() : '';
  return (s || fallback).slice(0, LYRIC_DOC_TITLE_MAX_CHARS);
}

/**
 * A document's name from its own text when none was given (the name is never
 * mandatory): the first heading, else the first line with words in it, without
 * markdown marks, cut at a word. Empty when no line has letters or digits.
 */
export function titleFromText(text: string, max = LYRIC_DOC_DERIVED_TITLE_MAX_CHARS): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const heading = lines.find((l) => /^\s{0,3}#{1,6}\s+\S/.test(l));
  const line = heading ?? lines.find((l) => /[\p{L}\p{N}]/u.test(l));
  if (!line) return '';
  const words = line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/[*_`~>#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (words.length <= max) return words;
  const cut = words.slice(0, max);
  const atWord = cut.lastIndexOf(' ');
  return `${(atWord > max / 2 ? cut.slice(0, atWord) : cut).replace(/[\s,;:.!?-]+$/, '')}…`;
}

/** Tolerant read of a stored pack: drops malformed documents, enforces every limit. */
export function asLyricPack(val: unknown): LyricPack | null {
  if (!val || typeof val !== 'object') return null;
  const p = val as Partial<LyricPack>;
  if (!Array.isArray(p.documents)) return null;
  const docs: LyricDocument[] = [];
  const ids = new Set<string>();
  let total = 0;
  for (const raw of p.documents) {
    if (docs.length >= LYRIC_PACK_MAX_DOCS) break;
    if (!raw || typeof raw !== 'object') continue;
    const d = raw as Partial<LyricDocument>;
    if (typeof d.id !== 'string' || !d.id || ids.has(d.id) || typeof d.text !== 'string') continue;
    const room = LYRIC_PACK_MAX_CHARS - total;
    if (room <= 0) break;
    const text = d.text.slice(0, Math.min(LYRIC_DOC_MAX_CHARS, room));
    total += text.length;
    ids.add(d.id);
    const doc: LyricDocument = {
      id: d.id,
      title: cleanTitle(d.title, `Document ${docs.length + 1}`),
      text,
      source: d.source === 'file' ? 'file' : 'paste',
      addedAt: typeof d.addedAt === 'number' ? d.addedAt : 0,
    };
    if (typeof d.path === 'string' && d.path.trim()) doc.path = d.path.trim().slice(0, LYRIC_DOC_PATH_MAX_CHARS);
    if (typeof d.updatedAt === 'number') doc.updatedAt = d.updatedAt;
    docs.push(doc);
  }
  return { version: 1, documents: docs, updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0 };
}

export async function loadPack(host: Pick<PluginHost, 'getProjectData'>): Promise<LyricPack> {
  return asLyricPack(await host.getProjectData(TEXT2VOICE_LYRIC_PACK_KEY).catch(() => null)) ?? emptyPack();
}

export async function savePack(host: Pick<PluginHost, 'setProjectData'>, pack: LyricPack): Promise<void> {
  await host.setProjectData(TEXT2VOICE_LYRIC_PACK_KEY, { ...pack, updatedAt: Date.now() });
}

export function packChars(pack: LyricPack): number {
  return pack.documents.reduce((n, d) => n + d.text.length, 0);
}

export function packHasText(pack: LyricPack): boolean {
  return pack.documents.some((d) => d.text.trim().length > 0);
}

const n = (x: number): string => x.toLocaleString('en-US');

/** "2 documents · 12,345 characters", or "none yet". */
export function packSummary(pack: LyricPack): string {
  const docs = pack.documents.length;
  if (docs === 0) return 'none yet';
  return `${docs} document${docs === 1 ? '' : 's'} · ${n(packChars(pack))} characters`;
}

// ---------------------------------------------------------------------------
// Edits (pure: each returns the next pack and, when a limit cut text, a note)
// ---------------------------------------------------------------------------

export interface PackEdit {
  pack: LyricPack;
  /** Set when a limit trimmed or refused something: show it to the user. */
  note?: string;
  docId?: string;
}

function newId(pack: LyricPack, now: number): string {
  let i = pack.documents.length + 1;
  let id = `doc-${now.toString(36)}-${i}`;
  while (pack.documents.some((d) => d.id === id)) id = `doc-${now.toString(36)}-${++i}`;
  return id;
}

function room(pack: LyricPack, exceptId?: string): number {
  const others = pack.documents.filter((d) => d.id !== exceptId).reduce((s, d) => s + d.text.length, 0);
  return Math.max(0, Math.min(LYRIC_DOC_MAX_CHARS, LYRIC_PACK_MAX_CHARS - others));
}

function limitNote(title: string, had: number, kept: number): string | undefined {
  if (kept >= had) return undefined;
  if (kept === 0) return `“${title}” was not added: the context is full (${n(LYRIC_PACK_MAX_CHARS)} characters in all). Remove a document first.`;
  const cap =
    had > LYRIC_DOC_MAX_CHARS && kept === LYRIC_DOC_MAX_CHARS
      ? `a document holds at most ${n(LYRIC_DOC_MAX_CHARS)} characters`
      : `the context holds ${n(LYRIC_PACK_MAX_CHARS)} characters in all`;
  return `“${title}” is ${n(had)} characters; ${cap}, so only the first ${n(kept)} were kept.`;
}

/** Add a document; the title is optional (from the text's first line when none is given). */
export function addDocument(pack: LyricPack, input: { title?: string; text: string; source?: LyricDocSource; path?: string }, now = Date.now()): PackEdit {
  const text = input.text.replace(/\r\n?/g, '\n');
  const fallback = titleFromText(text) || `Document ${pack.documents.length + 1}`;
  const title = cleanTitle(input.title, fallback);
  if (pack.documents.length >= LYRIC_PACK_MAX_DOCS) {
    return { pack, note: `The lyric context holds at most ${LYRIC_PACK_MAX_DOCS} documents. Remove one to add “${title}”.` };
  }
  if (!text.trim()) return { pack, note: 'Nothing to add: the document is empty.' };
  const keep = Math.min(text.length, room(pack));
  const note = limitNote(title, text.length, keep);
  if (keep === 0) return { pack, ...(note ? { note } : {}) };
  const doc: LyricDocument = { id: newId(pack, now), title, text: text.slice(0, keep), source: input.source ?? 'paste', addedAt: now };
  if (input.path && input.path.trim()) doc.path = input.path.trim().slice(0, LYRIC_DOC_PATH_MAX_CHARS);
  return { pack: { ...pack, documents: [...pack.documents, doc], updatedAt: now }, docId: doc.id, ...(note ? { note } : {}) };
}

export function removeDocument(pack: LyricPack, id: string, now = Date.now()): PackEdit {
  return { pack: { ...pack, documents: pack.documents.filter((d) => d.id !== id), updatedAt: now } };
}

/** New text for a document (a re-read of its file); the title stays. */
export function replaceDocument(pack: LyricPack, id: string, text: string, now = Date.now()): PackEdit {
  const cur = pack.documents.find((d) => d.id === id);
  if (!cur) return { pack, note: 'That document is gone.' };
  const clean = text.replace(/\r\n?/g, '\n');
  if (!clean.trim()) return { pack, note: `“${cur.title}” is empty now: remove the document instead.` };
  const keep = Math.min(clean.length, room(pack, id));
  const note = limitNote(cur.title, clean.length, keep);
  const next: LyricDocument = { ...cur, text: clean.slice(0, keep), updatedAt: now };
  return { pack: { ...pack, documents: pack.documents.map((d) => (d.id === id ? next : d)), updatedAt: now }, docId: id, ...(note ? { note } : {}) };
}

// ---------------------------------------------------------------------------
// The prompt's share of the pack
// ---------------------------------------------------------------------------

const STOP = new Set(
  'the a an and or but of to in on at for with from by as is are was were be been it its this that these those i you he she we they me my your our their his her not no so if then than there here what when where who how all any some into out up down over under about'.split(' '),
);

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).map((w) => w.replace(/'/g, '')).filter((w) => w.length > 2 && !STOP.has(w));
}

function paragraphs(text: string): string[] {
  const byBlank = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  // Plain-text documents often hold one paragraph per line, with no blank lines.
  return byBlank.length > 1 ? byBlank : text.split('\n').map((p) => p.trim()).filter(Boolean);
}

export interface ContextExcerpt {
  /** The background block for the prompt; '' when the pack is empty. */
  text: string;
  /** Whether the whole pack fit, or passages were picked. */
  mode: 'none' | 'whole' | 'passages';
  documents: number;
}

/**
 * What one ✍ prompt carries of the pack. Small packs go whole (titled).
 * Large ones give each document its opening paragraph, then the paragraphs
 * sharing the most content words with `focus` (the prompt, the song's
 * description, the section labels), in each document's own order, until
 * `maxChars`.
 */
export function contextExcerpt(pack: LyricPack, focus: string, maxChars = CONTEXT_EXCERPT_MAX_CHARS): ContextExcerpt {
  const docs = pack.documents.filter((d) => d.text.trim());
  if (docs.length === 0) return { text: '', mode: 'none', documents: 0 };
  const whole = docs.map((d) => `### ${d.title}\n${d.text.trim()}`).join('\n\n');
  if (whole.length <= maxChars) return { text: whole, mode: 'whole', documents: docs.length };

  const want = new Set(contentWords(focus));
  type Para = { doc: number; idx: number; text: string; score: number };
  const all: Para[] = [];
  docs.forEach((d, di) =>
    paragraphs(d.text).forEach((p, pi) => {
      const words = contentWords(p);
      const hits = words.filter((w) => want.has(w)).length;
      all.push({ doc: di, idx: pi, text: p, score: hits / Math.sqrt(Math.max(1, words.length)) });
    }),
  );
  const chosen = new Set<Para>();
  let used = docs.reduce((s, d) => s + d.title.length + 18, 0);
  const take = (p: Para): void => {
    const cost = Math.min(p.text.length, 1601) + 3;
    if (chosen.has(p) || used + cost > maxChars) return;
    chosen.add(p);
    used += cost;
  };
  // Each document's opening first (what it is), then the best matches.
  docs.forEach((_, di) => {
    const first = all.find((p) => p.doc === di);
    if (first) take(first);
  });
  [...all].sort((a, b) => b.score - a.score || a.doc - b.doc || a.idx - b.idx).forEach(take);
  const blocks = docs
    .map((d, di) => {
      const paras = all.filter((p) => p.doc === di && chosen.has(p)).sort((a, b) => a.idx - b.idx);
      if (paras.length === 0) return '';
      return `### ${d.title} (passages)\n${paras.map((p) => (p.text.length > 1600 ? `${p.text.slice(0, 1600)}…` : p.text)).join('\n…\n')}`;
    })
    .filter(Boolean);
  return { text: blocks.join('\n\n'), mode: 'passages', documents: docs.length };
}
