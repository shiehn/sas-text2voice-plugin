/**
 * S-443: the Lyric context section in jsdom (react-dom/client + act, a fake
 * host, no real files): collapsed by default; Choose a file… comes before
 * paste; an empty Add explains itself instead of being disabled; a host with
 * no file picker says why; a chosen file becomes a document named after it.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FILE_HOST_MISSING_MESSAGE } from '../lyric-files';
import { TEXT2VOICE_LYRIC_PACK_KEY, type LyricPack } from '../lyric-pack';
import { ADD_EMPTY_MESSAGE, LyricContextSection } from '../ui/LyricContextSection';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fake(files: Record<string, string> | null, pick: string[] | null = null) {
  const project = new Map<string, unknown>();
  const host: Record<string, unknown> = {
    getProjectData: async (k: string) => project.get(k) ?? null,
    setProjectData: async (k: string, v: unknown) => {
      project.set(k, v);
    },
  };
  if (files) {
    host.showOpenDialog = async () => pick;
    host.readTextFile = async (p: string) => files[p] ?? null;
  }
  return { host, project };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const q = (id: string): HTMLElement => container.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const click = async (id: string): Promise<void> => {
  await act(async () => {
    q(id).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

async function mount(host: Record<string, unknown>, open = false): Promise<void> {
  await act(async () => {
    root.render(<LyricContextSection host={host as never} defaultOpen={open} />);
  });
}

it('is collapsed by default and opens on its header', async () => {
  await mount(fake({}).host);
  expect(q('text2voice-lyric-context-body')).toBeNull();
  expect(q('text2voice-lyric-context-toggle').textContent).toContain('none yet');
  await click('text2voice-lyric-context-toggle');
  expect(q('text2voice-lyric-context-body')).not.toBeNull();
});

it('Choose a file… comes first, paste second; no button is disabled without a reason', async () => {
  await mount(fake({}).host, true);
  const body = q('text2voice-lyric-context-body');
  const choose = q('text2voice-lyric-choose-file');
  const paste = q('text2voice-lyric-paste');
  expect(choose.compareDocumentPosition(paste) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(body.querySelectorAll('button[disabled]')).toHaveLength(0);
  await click('text2voice-lyric-add');
  expect(q('text2voice-lyric-add-status').textContent).toBe(ADD_EMPTY_MESSAGE);
});

it('a host with no file picker says so when Choose a file… is pressed', async () => {
  await mount(fake(null).host, true);
  await click('text2voice-lyric-choose-file');
  expect(q('text2voice-lyric-file-status').textContent).toBe(FILE_HOST_MISSING_MESSAGE);
});

it('a chosen file becomes a document named after the file, with its path kept', async () => {
  const f = fake({ '/notes/harbour_town.md': 'The bell in the square rings at dusk.' }, ['/notes/harbour_town.md']);
  await mount(f.host, true);
  await click('text2voice-lyric-choose-file');
  const pack = f.project.get(TEXT2VOICE_LYRIC_PACK_KEY) as LyricPack;
  expect(pack.documents).toEqual([expect.objectContaining({ title: 'harbour town', source: 'file', path: '/notes/harbour_town.md' })]);
  expect(q('text2voice-lyric-file-status').textContent).toContain('Added 1 document');
});
