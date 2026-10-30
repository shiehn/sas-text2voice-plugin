/**
 * Lyric context documents from FILES (S-443, after SynthV S-423): the host's
 * native file picker (`showOpenDialog`, which needs the manifest's
 * `capabilities.fileDialog`) and its text reader (`readTextFile`: UTF-8, `null`
 * on any read error, no size cap of its own). Both are probed with `typeof`, so
 * the panel still loads on a host without them and the button says why it
 * cannot open a file instead of throwing.
 *
 * Nothing here knows what a file is about: it is text with a name. The pack's
 * limits (lyric-pack.ts) apply after the read, as they do for pasted text.
 */

import type { PluginFileDialogOptions } from '@signalsandsorcery/plugin-sdk';

export interface TextFileHost {
  showOpenDialog(options: PluginFileDialogOptions): Promise<string[] | null>;
  readTextFile(absolutePath: string): Promise<string | null>;
}

/** The host when it can open a file picker and read a text file for plugins; else null. */
export function asTextFileHost(host: unknown): TextFileHost | null {
  if (!host || typeof host !== 'object') return null;
  const h = host as Partial<TextFileHost>;
  if (typeof h.showOpenDialog !== 'function' || typeof h.readTextFile !== 'function') return null;
  return h as TextFileHost;
}

/** Shown in the status line when the host has no file picker or reader. */
export const FILE_HOST_MISSING_MESSAGE =
  'Needs a newer Signals & Sorcery (the app opens the file picker and reads the file for plugins). Paste the text for now.';

/** File types the picker offers first; "All files" is always there too, for a note without an extension. */
export const LYRIC_FILE_EXTENSIONS = ['md', 'markdown', 'txt', 'text'] as const;

export const LYRIC_FILE_FILTERS: NonNullable<PluginFileDialogOptions['filters']> = [
  { name: 'Text documents', extensions: [...LYRIC_FILE_EXTENSIONS] },
  { name: 'All files', extensions: ['*'] },
];

export const LYRIC_FILE_DIALOG_TITLE = 'Choose one or more text files for the lyric context';

/** The native picker, several files at a time; null when it was cancelled. */
export async function chooseLyricFiles(host: TextFileHost): Promise<string[] | null> {
  const paths = await host.showOpenDialog({ title: LYRIC_FILE_DIALOG_TITLE, filters: LYRIC_FILE_FILTERS, multiSelections: true });
  if (!paths || paths.length === 0) return null;
  return paths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
}

/** The file's base name (either separator). */
export function fileName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
}

/** A document title from a path: the file name without its extension, or "Document" when there is none. */
export function titleFromPath(path: string): string {
  const base = fileName(path).trim();
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Document';
}

export type TextFileCheck = { ok: true; text: string } | { ok: false; reason: 'empty' | 'not-text' };

/**
 * Is what `readTextFile` returned text? A binary file read as UTF-8 shows NUL
 * characters, or runs of U+FFFD where bytes were not UTF-8, or other control
 * characters; a little of that (one stray byte) is still text. A BOM is dropped.
 */
export function checkTextFile(raw: string): TextFileCheck {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (text.includes('\u0000')) return { ok: false, reason: 'not-text' };
  const sample = text.slice(0, 64_000);
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0xfffd || (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x0c)) bad++;
  }
  if (sample.length > 0 && bad > 2 && bad / sample.length > 0.01) return { ok: false, reason: 'not-text' };
  if (!text.trim()) return { ok: false, reason: 'empty' };
  return { ok: true, text };
}

export type ReadLyricFile = { path: string; name: string } & (
  | { ok: true; text: string }
  | { ok: false; reason: 'missing' | 'empty' | 'not-text'; message: string }
);

/** Why a file was not taken, in plain words, with its name. */
export function describeFileFailure(name: string, reason: 'missing' | 'empty' | 'not-text'): string {
  switch (reason) {
    case 'missing':
      return `“${name}” could not be read: the file is not there, or it cannot be opened.`;
    case 'empty':
      return `“${name}” is empty.`;
    default:
      return `“${name}” is not a text file. Choose a .md or .txt file, or paste the text.`;
  }
}

/** Read one file through the host and say whether it is usable text. Never throws for a bad file. */
export async function readLyricFile(host: TextFileHost, path: string): Promise<ReadLyricFile> {
  const name = fileName(path) || path;
  const raw = await host.readTextFile(path).catch(() => null);
  if (raw === null || raw === undefined) return { path, name, ok: false, reason: 'missing', message: describeFileFailure(name, 'missing') };
  const check = checkTextFile(raw);
  if (!check.ok) return { path, name, ok: false, reason: check.reason, message: describeFileFailure(name, check.reason) };
  return { path, name, ok: true, text: check.text };
}
