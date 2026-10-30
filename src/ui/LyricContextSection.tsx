/**
 * "Lyric context" (S-443, after SynthV S-403/S-423): the project's documents,
 * shared by every Text2Voice reading in every scene. They feed ✍ New words as
 * background (story, imagery, vocabulary); they are never sung or quoted.
 *
 * Collapsed by default: one line saying what is there. Open: the documents
 * (size, Reload from file, Remove), then the add area in this order: Choose a
 * file… FIRST (the host's native picker, manifest `capabilities.fileDialog`),
 * or paste text, a name that is optional (it comes from the file name or the
 * first line), and Add.
 *
 * No button is disabled without a reason the user can read: Add with an empty
 * box says so in the status line beside it; a host without a file picker says
 * so when Choose a file… is pressed; the only real gate (a read in flight)
 * shows its reason in the button's title and the status line.
 */

import React, { useCallback, useEffect, useState } from 'react';
import type { PluginHost } from '@signalsandsorcery/plugin-sdk';
import { asTextFileHost, chooseLyricFiles, FILE_HOST_MISSING_MESSAGE, readLyricFile, titleFromPath } from '../lyric-files';
import { addDocument, emptyPack, loadPack, packSummary, removeDocument, replaceDocument, savePack, type LyricPack } from '../lyric-pack';

/** Plain-words status lines (exported for the tests). */
export const ADD_EMPTY_MESSAGE = 'Paste some text first, or choose a file.';
export const NAME_PLACEHOLDER = 'Name (optional, taken from the file or the first line)';
export const READING_MESSAGE = 'Reading the file…';

const BTN =
  'px-1.5 py-0.5 text-[10px] rounded-sm border bg-sas-panel border-sas-border text-sas-muted hover:border-sas-accent hover:text-sas-accent whitespace-nowrap';
const INPUT =
  'bg-sas-panel border border-sas-border rounded-sm px-2 py-1 text-[11px] text-sas-text placeholder:text-sas-muted/50 focus:border-sas-accent focus:outline-none';
const STATUS = 'text-[9px] text-sas-muted';

export interface LyricContextSectionProps {
  host: PluginHost;
  /** Start open (tests). */
  defaultOpen?: boolean;
}

export function LyricContextSection({ host, defaultOpen = false }: LyricContextSectionProps): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const [pack, setPack] = useState<LyricPack>(emptyPack());
  const [paste, setPaste] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [fileStatus, setFileStatus] = useState('');
  const [addStatus, setAddStatus] = useState('');

  useEffect(() => {
    let cancelled = false;
    void loadPack(host).then((p) => {
      if (!cancelled) setPack(p);
    });
    return () => {
      cancelled = true;
    };
  }, [host]);

  const commit = useCallback(
    async (next: LyricPack): Promise<void> => {
      setPack(next);
      await savePack(host, next).catch(() => {});
    },
    [host],
  );

  const chooseFiles = useCallback(async (): Promise<void> => {
    const files = asTextFileHost(host);
    if (!files) {
      setFileStatus(FILE_HOST_MISSING_MESSAGE);
      return;
    }
    let paths: string[] | null;
    try {
      paths = await chooseLyricFiles(files);
    } catch (err) {
      setFileStatus(`The file picker did not open: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!paths) return;
    setBusy(true);
    setFileStatus(READING_MESSAGE);
    let next = pack;
    const notes: string[] = [];
    let added = 0;
    for (const path of paths) {
      const r = await readLyricFile(files, path);
      if (!r.ok) {
        notes.push(r.message);
        continue;
      }
      const edit = addDocument(next, { title: titleFromPath(path), text: r.text, source: 'file', path });
      if (edit.note) notes.push(edit.note);
      if (edit.docId) added += 1;
      next = edit.pack;
    }
    await commit(next);
    setBusy(false);
    setFileStatus([added > 0 ? `Added ${added} document${added === 1 ? '' : 's'}.` : '', ...notes].filter(Boolean).join(' '));
  }, [host, pack, commit]);

  const addPasted = useCallback(async (): Promise<void> => {
    if (!paste.trim()) {
      setAddStatus(ADD_EMPTY_MESSAGE);
      return;
    }
    const edit = addDocument(pack, { title: name.trim() || undefined, text: paste, source: 'paste' });
    if (edit.docId) {
      await commit(edit.pack);
      setPaste('');
      setName('');
    }
    setAddStatus(edit.note ?? (edit.docId ? 'Added.' : ''));
  }, [paste, name, pack, commit]);

  const reload = useCallback(
    async (id: string, path: string): Promise<void> => {
      const files = asTextFileHost(host);
      if (!files) {
        setFileStatus(FILE_HOST_MISSING_MESSAGE);
        return;
      }
      setBusy(true);
      setFileStatus(READING_MESSAGE);
      const r = await readLyricFile(files, path);
      if (!r.ok) {
        setBusy(false);
        setFileStatus(r.message);
        return;
      }
      const edit = replaceDocument(pack, id, r.text);
      await commit(edit.pack);
      setBusy(false);
      setFileStatus(edit.note ?? 'Read again.');
    },
    [host, pack, commit],
  );

  return (
    <div className="mt-1.5 rounded-sm border border-sas-border/60" data-testid="text2voice-lyric-context">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Documents ✍ writes from: a story, a world, notes. Used as background for the words, never sung or quoted. Shared by every scene."
        className="w-full flex items-center gap-1.5 px-2 py-1 text-left text-[9px] uppercase tracking-wide text-sas-muted hover:text-sas-accent"
        data-testid="text2voice-lyric-context-toggle"
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>Lyric context</span>
        <span className="normal-case tracking-normal text-sas-muted/80">· {packSummary(pack)}</span>
      </button>
      {open && (
        <div className="px-2 pb-2 space-y-1.5" data-testid="text2voice-lyric-context-body">
          {pack.documents.map((d) => (
            <div key={d.id} className="flex items-center gap-1.5" data-testid={`text2voice-lyric-doc-${d.id}`}>
              <span className="text-[10px] text-sas-text truncate flex-1 min-w-0" title={d.path ?? d.title}>
                {d.title}
              </span>
              <span className={STATUS}>{d.text.length.toLocaleString('en-US')} chars</span>
              {d.source === 'file' && d.path && (
                <button
                  type="button"
                  className={BTN}
                  disabled={busy}
                  title={busy ? READING_MESSAGE : `Read ${d.path} again`}
                  onClick={() => void reload(d.id, d.path as string)}
                >
                  Reload from file
                </button>
              )}
              <button type="button" className={BTN} onClick={() => void commit(removeDocument(pack, d.id).pack)} data-testid={`text2voice-lyric-remove-${d.id}`}>
                Remove
              </button>
            </div>
          ))}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className={BTN}
              disabled={busy}
              title={busy ? READING_MESSAGE : 'Choose one or more .md or .txt files'}
              onClick={() => void chooseFiles()}
              data-testid="text2voice-lyric-choose-file"
            >
              Choose a file…
            </button>
            <span className={`flex-1 min-w-0 ${STATUS}`} data-testid="text2voice-lyric-file-status">
              {fileStatus}
            </span>
          </div>
          <div className="text-[9px] uppercase tracking-wide text-sas-muted/70">or paste text</div>
          <textarea
            value={paste}
            rows={3}
            placeholder="Paste a story, notes, a world — background for ✍, never sung."
            onChange={(e) => setPaste(e.target.value)}
            className={`w-full resize-y ${INPUT}`}
            data-testid="text2voice-lyric-paste"
          />
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={name}
              placeholder={NAME_PLACEHOLDER}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              className={`flex-1 min-w-0 ${INPUT}`}
              data-testid="text2voice-lyric-name"
            />
            <button type="button" className={BTN} onClick={() => void addPasted()} data-testid="text2voice-lyric-add">
              Add
            </button>
          </div>
          <div className={STATUS} data-testid="text2voice-lyric-add-status">
            {addStatus}
          </div>
        </div>
      )}
    </div>
  );
}

export default LyricContextSection;
