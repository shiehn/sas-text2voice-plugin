/**
 * Verses (S-443, after SynthV S-406/S-408): the song's words live in the
 * HOST-owned song lyric document (SDK 3.24.0), one document per arrangement,
 * one section per placement of a scene (keyed by the arrangement's
 * `instanceId`). Synth V writes the same document, so the two plugins share
 * one song: the Lyrics tab in the arrangement row, the agent and both panels
 * read and write this one copy.
 *
 * Text2Voice renders ONE clip per scene (the scene loops wherever it is
 * placed), so a scene sings one section's words: its first placement that this
 * reading claims, else the first one no other plugin's track sings. The writer
 * makes a scene's later placements repeat those words (`sameAs`).
 *
 * This module is the read side and the small writes:
 *   - `currentSection`  the section the ACTIVE scene's reading sings, and its lines;
 *   - `wordsForLines`   those lines as Sing's words (the model's split kept for
 *                       lines it already split, a plain split for edited ones);
 *   - `recordRendered`  after Sing: the take's signature on the scene's
 *                       placements (`renderedSig`), so the Lyrics tab sees staleness;
 *   - `pushSectionLines` Song-view edits of the box, back into the section;
 *   - `loadSongSheet`   the rows the Song view shows, with each section's state.
 */

import type { ArrangementOutline, ArrangementOutlineSection, PluginHost, SongLyrics } from '@signalsandsorcery/plugin-sdk';
import { hasArrangementOutline, hasSongLyrics, isSectionTakeStale, resolveSectionLines, songLinesSignature } from '@signalsandsorcery/plugin-sdk';
import { splitLineSyllables } from './line-fit';
import { anchorStatus, FOREIGN_TRACK_REASON, isNotOwned, NO_READING_REASON, readingsInScene } from './reading-anchor';
import { budgetSpecFor, sectionBudget } from './song-budget';
import { validateSyllableSplit } from './syllables';
import { asText2VoiceConfig, TEXT2VOICE_CONFIG_KEY, type Text2VoiceWords } from './voice-meta';

export type SongHost = Required<Pick<PluginHost, 'getSongLyrics' | 'setSectionLyrics' | 'setSongDescription' | 'onSongLyricsChanged'>> &
  Partial<Pick<PluginHost, 'getArrangementOutline'>>;

/** The host's song-lyrics half, when it has one. */
export function songHostOf(host: unknown): SongHost | null {
  return hasSongLyrics(host as Partial<SongHost>) ? (host as SongHost) : null;
}

export const SONG_API_MISSING_MESSAGE =
  'This Signals & Sorcery keeps no song lyrics yet (it needs SDK 3.24 and an arrangement): use Scene view.';
export const NO_ARRANGEMENT_MESSAGE = 'The project has no arrangement yet: place its scenes in the arrangement to make a song.';
export const NOT_PLACED_MESSAGE = 'This scene is not placed in the arrangement: place it to give it a section, or use Scene view.';
export const NO_SECTION_WORDS_MESSAGE =
  "This scene's section has no words yet: press ✍ New words to write the song, or type its lines in the box.";

const defaultKeyFor = (dbId: string, suffix: string): string => `track:${dbId}:${suffix}`;

/**
 * A section's label: the arrangement's, else its role numbered among its kind
 * ("verse 2"), else the scene's name (with its play number when the scene
 * plays more than once); never a raw id.
 */
export function labelOf(
  section: Pick<ArrangementOutlineSection, 'label' | 'sceneId' | 'sceneName' | 'occurrence'>,
  at: { plays: number; placement: number; role?: string; roleNth?: number },
): string {
  if (section.label?.trim()) return section.label.trim();
  if (at.role) return `${at.role} ${at.roleNth ?? 1}`;
  const name = (section.sceneName ?? '').trim();
  if (!name || name === section.sceneId) return `Scene ${at.placement}`;
  return at.plays > 1 ? `${name} (${section.occurrence})` : name;
}

/** Labels for every placed section, in song order (roles from the document first, then the outline). */
export function labelsFor(outline: ArrangementOutline | null, doc: SongLyrics | null): Map<string, string> {
  const sections = outline?.sections ?? [];
  const plays = new Map<string, number>();
  for (const s of sections) plays.set(s.sceneId, (plays.get(s.sceneId) ?? 0) + 1);
  const roleCount = new Map<string, number>();
  const out = new Map<string, string>();
  sections.forEach((s, i) => {
    const role = (doc?.sections[s.instanceId]?.role ?? s.role)?.trim().toLowerCase() || undefined;
    const roleNth = role ? (roleCount.get(role) ?? 0) + 1 : 0;
    if (role) roleCount.set(role, roleNth);
    out.set(s.instanceId, labelOf(s, { plays: plays.get(s.sceneId) ?? 1, placement: i + 1, ...(role ? { role, roleNth } : {}) }));
  });
  return out;
}

export type CurrentSection =
  | {
      ok: true;
      /** The placement whose words the scene sings. */
      instanceId: string;
      label: string;
      /** The words it sings (`sameAs` followed). */
      lines: string[];
      /** Every placement of this scene, in song order. */
      placements: ArrangementOutlineSection[];
      /** Its section is claimed by another plugin's track (the words are shared; this reading cannot write them). */
      foreign: boolean;
      doc: SongLyrics | null;
    }
  | { ok: false; reason: string };

/**
 * The section the scene's reading sings: the first placement this reading
 * claims, else the first one that no other plugin's existing track sings
 * (unclaimed, or its track deleted), else the first placement.
 */
export async function currentSection(host: unknown, sceneId: string, anchorDbId: string): Promise<CurrentSection> {
  const song = songHostOf(host);
  const h = host as Partial<Pick<PluginHost, 'getArrangementOutline'>>;
  if (!song || !hasArrangementOutline(h)) return { ok: false, reason: SONG_API_MISSING_MESSAGE };
  const outline = await h.getArrangementOutline().catch(() => null);
  if (!outline) return { ok: false, reason: NO_ARRANGEMENT_MESSAGE };
  const placements = outline.sections.filter((s) => s.sceneId === sceneId);
  if (placements.length === 0) return { ok: false, reason: NOT_PLACED_MESSAGE };
  const doc = await song.getSongLyrics().catch(() => null);
  const labels = labelsFor(outline, doc);
  const readings = await readingsInScene(host, sceneId);
  let pick: ArrangementOutlineSection | undefined = placements.find((p) => doc?.sections[p.instanceId]?.voiceTrackDbId === anchorDbId);
  let foreign = false;
  if (!pick) {
    for (const p of placements) {
      const claim = doc?.sections[p.instanceId]?.voiceTrackDbId;
      if (!claim || readings.includes(claim)) {
        pick = p;
        break;
      }
      const status = await anchorStatus(host, sceneId, claim, readings);
      if (status !== 'foreign') {
        pick = p;
        break;
      }
    }
  }
  if (!pick) {
    pick = placements[0];
    foreign = true;
  }
  return {
    ok: true,
    instanceId: pick.instanceId,
    label: labels.get(pick.instanceId) ?? pick.sceneName,
    lines: resolveSectionLines(doc, pick.instanceId),
    placements,
    foreign,
    doc,
  };
}

const norm = (l: string): string => l.trim().replace(/\s+/g, ' ').toLowerCase();

/** One line's split: the model's, when it reassembles into the line; else the plain split. */
export function lineSyllables(text: string, given?: string[]): string[] {
  if (given && given.length > 0 && validateSyllableSplit(given, text).ok) return given;
  return splitLineSyllables(text);
}

/**
 * Lines as Sing's words (`fit: 'lines'`): for a line `prior` already holds
 * (same text), its split is kept (the model's); any other line gets the plain
 * split. Empty lines are dropped. Null when no line has a word in it.
 */
export function wordsForLines(
  lines: string[],
  prior: Text2VoiceWords | null,
  extra: Pick<Text2VoiceWords, 'topic' | 'rhymeScheme' | 'sectionId'> = {},
): Text2VoiceWords | null {
  const known = new Map<string, string[]>();
  if (prior?.lines && prior.lineTexts) prior.lineTexts.forEach((t, i) => prior.lines?.[i] && known.set(norm(t), prior.lines[i]));
  const lineTexts: string[] = [];
  const split: string[][] = [];
  for (const raw of lines) {
    const text = raw.trim();
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    const syls = lineSyllables(text, known.get(norm(text)));
    if (syls.length === 0) continue;
    lineTexts.push(text);
    split.push(syls);
  }
  if (split.length === 0) return null;
  return {
    phrase: lineTexts.join(' / '),
    syllables: split.flat(),
    source: 'write',
    lines: split,
    lineTexts,
    fit: 'lines',
    ...(extra.topic ? { topic: extra.topic } : {}),
    ...(extra.rhymeScheme ? { rhymeScheme: extra.rhymeScheme } : {}),
    ...(extra.sectionId ? { sectionId: extra.sectionId } : {}),
  };
}

/** Do `words` already say exactly these lines? */
export function wordsMatchLines(words: Text2VoiceWords | null, lines: string[]): boolean {
  const want = lines.map(norm).filter(Boolean);
  const have = (words?.fit === 'lines' ? words.lineTexts ?? [] : []).map(norm);
  return want.length > 0 && want.length === have.length && want.every((l, i) => l === have[i]);
}

/**
 * After a Sing in Song view: the take's signature (`renderedSig`) on every
 * placement of the scene that sings these words, claimed by this reading.
 * Failures only warn: a render never fails on the song document.
 */
export async function recordRendered(host: unknown, placements: ArrangementOutlineSection[], lines: string[], anchorDbId: string): Promise<number> {
  const song = songHostOf(host);
  if (!song) return 0;
  const doc = await song.getSongLyrics().catch(() => null);
  const sig = songLinesSignature(lines);
  let written = 0;
  for (const p of placements) {
    const sung = resolveSectionLines(doc, p.instanceId);
    if (songLinesSignature(sung) !== sig) continue;
    const s = doc?.sections[p.instanceId];
    if (s?.renderedSig === sig && s.voiceTrackDbId === anchorDbId) continue;
    try {
      await song.setSectionLyrics(p.instanceId, { renderedSig: sig, ...(s?.voiceTrackDbId === anchorDbId ? {} : { voiceTrackDbId: anchorDbId }) });
      written += 1;
    } catch (err) {
      console.warn(`[Text2Voice] song: take not recorded on ${p.instanceId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return written;
}

/**
 * Song view: the box's lines into the scene's section, claimed by this
 * reading. A section that repeats another becomes its own first (the host
 * refuses lines on a `sameAs` section).
 */
export async function pushSectionLines(
  host: unknown,
  instanceId: string,
  lines: string[],
  anchorDbId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const song = songHostOf(host);
  if (!song) return { ok: false, reason: SONG_API_MISSING_MESSAGE };
  const doc = await song.getSongLyrics().catch(() => null);
  const s = doc?.sections[instanceId];
  const clean = lines.map((l) => l.trim()).filter(Boolean);
  try {
    await song.setSectionLyrics(instanceId, {
      ...(s?.sameAs ? { sameAs: null } : {}),
      lines: clean,
      ...(s?.voiceTrackDbId === anchorDbId ? {} : { voiceTrackDbId: anchorDbId }),
    });
    return { ok: true };
  } catch (err) {
    if (isNotOwned(err)) return { ok: false, reason: `Not saved to the song: this section is ${FOREIGN_TRACK_REASON}.` };
    return { ok: false, reason: `Not saved to the song: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// The Song view's rows
// ---------------------------------------------------------------------------

export type SheetStatus = 'ours' | 'free' | 'repeat' | 'foreign' | 'no-reading';

export interface SongSheetRow {
  instanceId: string;
  sceneId: string;
  label: string;
  bars: number;
  role?: string;
  lines: string[];
  /** The label of the section it repeats. */
  repeats?: string;
  /** One of the ACTIVE scene's placements. */
  current: boolean;
  status: SheetStatus;
  /** Why a section is skipped (foreign, no reading). */
  reason?: string;
  /** "~4 syllables (3-6)" from the scene's reading's style. */
  budget?: string;
  /** Rendered, and its words changed since. */
  stale: boolean;
}

export type SongSheet =
  | { ok: true; rows: SongSheetRow[]; description: string; doc: SongLyrics | null }
  | { ok: false; reason: string };

export async function loadSongSheet(
  host: unknown,
  opts: { activeSceneId: string | null; keyFor?: (dbId: string, suffix: string) => string },
): Promise<SongSheet> {
  const song = songHostOf(host);
  const h = host as Partial<Pick<PluginHost, 'getArrangementOutline'>>;
  if (!song || !hasArrangementOutline(h)) return { ok: false, reason: SONG_API_MISSING_MESSAGE };
  const outline = await h.getArrangementOutline().catch(() => null);
  if (!outline || outline.sections.length === 0) return { ok: false, reason: NO_ARRANGEMENT_MESSAGE };
  const keyFor = opts.keyFor ?? defaultKeyFor;
  const doc = await song.getSongLyrics().catch(() => null);
  const labels = labelsFor(outline, doc);
  const readingsByScene = new Map<string, string[]>();
  const budgetByScene = new Map<string, (bars: number) => string>();
  const rows: SongSheetRow[] = [];
  for (const s of outline.sections) {
    if (!readingsByScene.has(s.sceneId)) {
      const readings = await readingsInScene(host, s.sceneId);
      readingsByScene.set(s.sceneId, readings);
      const data = host as Partial<Pick<PluginHost, 'getSceneData'>>;
      const config =
        readings.length > 0 && typeof data.getSceneData === 'function'
          ? asText2VoiceConfig(await data.getSceneData(s.sceneId, keyFor(readings[0], TEXT2VOICE_CONFIG_KEY)).catch(() => null))
          : null;
      if (config) {
        const spec = budgetSpecFor(config);
        budgetByScene.set(s.sceneId, (bars) => {
          const b = sectionBudget(spec, bars);
          return `~${b.centre} syllables (${b.min}-${b.max})`;
        });
      }
    }
    const readings = readingsByScene.get(s.sceneId) ?? [];
    const sec = doc?.sections[s.instanceId];
    const row: SongSheetRow = {
      instanceId: s.instanceId,
      sceneId: s.sceneId,
      label: labels.get(s.instanceId) ?? s.sceneName,
      bars: s.bars,
      ...((sec?.role ?? s.role) ? { role: sec?.role ?? s.role } : {}),
      lines: resolveSectionLines(doc, s.instanceId),
      current: s.sceneId === opts.activeSceneId,
      status: 'free',
      stale: isSectionTakeStale(doc, s.instanceId),
    };
    const budget = budgetByScene.get(s.sceneId);
    if (budget) row.budget = budget(s.bars);
    const claim = sec?.voiceTrackDbId;
    if (claim && !readings.includes(claim) && (await anchorStatus(host, s.sceneId, claim, readings)) === 'foreign') {
      row.status = 'foreign';
      row.reason = FOREIGN_TRACK_REASON;
    } else if (sec?.sameAs) {
      row.status = 'repeat';
      row.repeats = labels.get(sec.sameAs) ?? sec.sameAs;
    } else if (readings.length === 0) {
      row.status = 'no-reading';
      row.reason = NO_READING_REASON;
    } else if (claim && readings.includes(claim)) {
      row.status = 'ours';
    }
    rows.push(row);
  }
  return { ok: true, rows, description: doc?.description ?? '', doc };
}
