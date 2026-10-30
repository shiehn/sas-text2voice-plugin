/**
 * ✍ New words, to the bar budget (S-443, after SynthV S-408/S-432).
 *
 * ONE schema-forced call writes the words: for one scene (Scene view, ✍ with a
 * prompt) or for the whole song (Song view). Each section asks for its lines
 * with their syllable counts, the budget's COUNT over the section's bars
 * (song-budget.ts); a kept melody gives one line per phrase, no melody gives
 * one line per few bars and Sing composes music for the words. The lyric
 * context documents ride along as background (lyric-pack.ts). Then every line
 * is verified against its count and a line over it is cut at a word
 * (`trimToBudget`): the words never overflow the bar.
 *
 * The song: every placed scene with a Text2Voice reading is one section to
 * write (its first placement this reading may sing). Its later placements
 * repeat the same words (`sameAs`): one clip per scene is what Text2Voice
 * renders. Roles come from the song order and the repeats (the model names
 * them). A section another plugin's existing track sings is skipped with that
 * reason; a section whose track is gone is free and re-anchored (S-431). The
 * host has the last word: a write it refuses is reported, not thrown. Then
 * every reading whose box follows the song (Song view, or an empty box) gets
 * its section's lines in the box, ready for Sing.
 */

import type { ArrangementOutline, ArrangementOutlineSection, LLMToolUseRequest, PluginHost, SongLyrics } from '@signalsandsorcery/plugin-sdk';
import { formatSongOrder, hasArrangementOutline, LLM_MODEL, resolveSectionLines } from '@signalsandsorcery/plugin-sdk';
import { foldMelismaRuns } from './compose';
import { melodyCapacity } from './distribute';
import { leadPhrases } from './line-fit';
import { contextExcerpt, loadPack } from './lyric-pack';
import {
  buildSongWordsSystemPrompt,
  buildSongWordsTool,
  buildSongWordsUserPrompt,
  SUBMIT_SONG_WORDS_TOOL_NAME,
  type SongWordsPrompt,
  type SongWordsSection,
} from './prompt';
import { anchorStatus, FOREIGN_TRACK_REASON, isNotOwned, NO_READING_REASON, readingsInScene, reanchorNote } from './reading-anchor';
import {
  budgetLogLine,
  budgetPromptLine,
  budgetSpecFor,
  melodyLineTargets,
  rhymeLetters,
  sectionBudget,
  trimToBudget,
  wordsFirstLines,
  type BudgetSpec,
  type RhymeChoice,
} from './song-budget';
import { labelsFor, lineSyllables, songHostOf, SONG_API_MISSING_MESSAGE, NO_ARRANGEMENT_MESSAGE, wordsForLines } from './song-lyrics';
import { STYLES } from './styles';
import {
  asText2VoiceConfig,
  asText2VoiceMelody,
  TEXT2VOICE_CONFIG_KEY,
  TEXT2VOICE_MELODY_KEY,
  TEXT2VOICE_WORDS_KEY,
  type Text2VoiceConfig,
  type Text2VoiceMelody,
  type Text2VoiceWords,
} from './voice-meta';

export const WRITER_MODEL = LLM_MODEL.BEST;
/** The one generous ceiling (thinking tokens share it; see text2voice-generation.ts). */
export const WRITER_MAX_OUTPUT_TOKENS = 49152;
export const WRITER_TEMPERATURE = 0.9;
/** Scenes written in one song call; more are reported, not written. */
export const SONG_MAX_SECTIONS = 24;

type KeyFor = (dbId: string, suffix: string) => string;
const defaultKeyFor: KeyFor = (dbId, suffix) => `track:${dbId}:${suffix}`;

// ---------------------------------------------------------------------------
// One section's grid
// ---------------------------------------------------------------------------

export interface SectionPlan {
  spec: BudgetSpec;
  /** Syllables per line. */
  targets: number[];
  letters: Array<string | null>;
  effectiveRhyme: RhymeChoice | 'pairs';
  /** Lines from the kept melody's phrases (else words first). */
  fromMelody: boolean;
  /** The melody has more phrases than the budget allows syllables. */
  over: boolean;
}

/** The lines a section asks for: the kept melody's phrases, else words first. */
export function planSection(config: Text2VoiceConfig, melody: Text2VoiceMelody | null, bars: number, rhyme: RhymeChoice): SectionPlan {
  const spec = budgetSpecFor(config);
  let targets: number[];
  let fromMelody = false;
  let over = false;
  const lead = melody && melody.voices[0] && melody.voices[0].length > 0 ? foldMelismaRuns(melody.voices[0]) : null;
  if (lead) {
    const phrases = leadPhrases(lead);
    const durations = phrases.map((p) => p[p.length - 1].startBeat + p[p.length - 1].durationBeats - p[0].startBeat);
    const capacity = phrases.map((p) => melodyCapacity(p, config.notesPerBeat));
    const t = melodyLineTargets(durations, capacity, sectionBudget(spec, bars));
    targets = t.targets;
    over = t.over;
    fromMelody = targets.length > 0;
  } else {
    targets = [];
  }
  if (targets.length === 0) targets = wordsFirstLines(spec, bars);
  const r = rhymeLetters(targets.length, rhyme);
  return { spec, targets, letters: r.letters, effectiveRhyme: r.effective, fromMelody, over };
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

export interface ParsedWordsSection {
  key: string;
  role?: string;
  lines: Array<{ text: string; syllables: string[] }>;
}

/** The tool call's sections, tolerant of a model that does not honour the schema. */
export function parseSongWords(response: unknown): { sections: ParsedWordsSection[]; note?: string } | null {
  const parts =
    (response as { candidates?: Array<{ content?: { parts?: Array<{ functionCall?: { name?: string; args?: unknown } }> } }> })?.candidates?.flatMap(
      (c) => c.content?.parts ?? [],
    ) ?? [];
  const call = parts.find((p) => p.functionCall?.name === SUBMIT_SONG_WORDS_TOOL_NAME)?.functionCall;
  const raw = call?.args as { sections?: unknown; note?: unknown } | undefined;
  if (!raw || !Array.isArray(raw.sections)) return null;
  const sections: ParsedWordsSection[] = [];
  for (const s of raw.sections) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    if (typeof o.key !== 'string') continue;
    const lines = (Array.isArray(o.lines) ? o.lines : [])
      .map((l) => {
        const x = (l ?? {}) as { text?: unknown; syllables?: unknown };
        const syls = Array.isArray(x.syllables) ? x.syllables.filter((y): y is string => typeof y === 'string' && y.trim().length > 0).map((y) => y.trim()) : [];
        const text = typeof x.text === 'string' && x.text.trim() ? x.text.trim().replace(/\s+/g, ' ') : syls.join('');
        return { text, syllables: syls };
      })
      .filter((l) => l.text.length > 0);
    sections.push({ key: o.key, ...(typeof o.role === 'string' && o.role.trim() ? { role: o.role.trim().toLowerCase().slice(0, 40) } : {}), lines });
  }
  const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim().slice(0, 300) : undefined;
  return { sections, ...(note ? { note } : {}) };
}

export interface VerifiedLines {
  lines: Array<{ text: string; syllables: string[] }>;
  written: number;
  trimmed: number;
}

/**
 * The answer's lines against the asked counts: a FIXED line stays as written,
 * a split that does not reassemble is replaced by the plain split, a line over
 * its count is cut at a word. Fewer syllables are kept (Sing holds them longer).
 */
export function verifyLines(targets: number[], fixed: Map<number, string>, answer: Array<{ text: string; syllables: string[] }>): VerifiedLines {
  const lines: VerifiedLines['lines'] = [];
  let written = 0;
  let trimmed = 0;
  targets.forEach((target, i) => {
    const fixedText = fixed.get(i);
    if (fixedText !== undefined) {
      const syllables = lineSyllables(fixedText);
      lines.push({ text: fixedText, syllables });
      written += syllables.length;
      return;
    }
    const a = answer[i];
    if (!a) return;
    let text = a.text;
    let syllables = lineSyllables(a.text, a.syllables);
    if (syllables.length > target) {
      const t = trimToBudget(text, syllables, target);
      if (t.trimmed) {
        text = t.text;
        syllables = t.syllables;
        trimmed += 1;
      }
    }
    if (syllables.length === 0) return;
    lines.push({ text, syllables });
    written += syllables.length;
  });
  return { lines, written, trimmed };
}

async function callWriter(host: Pick<PluginHost, 'generateWithLLMTools'>, prompt: SongWordsPrompt): Promise<{ sections: ParsedWordsSection[]; note?: string }> {
  const request: LLMToolUseRequest = {
    model: WRITER_MODEL,
    systemInstruction: { parts: [{ text: buildSongWordsSystemPrompt(prompt) }] },
    contents: [{ role: 'user', parts: [{ text: buildSongWordsUserPrompt(prompt) }] }],
    tools: [{ functionDeclarations: [buildSongWordsTool(prompt.sections.map((s) => s.key))] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [SUBMIT_SONG_WORDS_TOOL_NAME] } },
    generationConfig: { temperature: WRITER_TEMPERATURE, maxOutputTokens: WRITER_MAX_OUTPUT_TOKENS },
  };
  const response = await host.generateWithLLMTools(request);
  const parsed = parseSongWords(response);
  if (!parsed) {
    const truncated = (response as { candidates?: Array<{ finishReason?: string }> })?.candidates?.some((c) => c.finishReason === 'MAX_TOKENS');
    throw new Error(
      truncated
        ? `The model used its entire ${WRITER_MAX_OUTPUT_TOKENS}-token budget before submitting. Try again — this is a model hiccup, not your words.`
        : 'The model returned no lyrics — try again, or say more about what it should be about.',
    );
  }
  return parsed;
}

function sectionFor(key: string, label: string, bars: number, plan: SectionPlan, extra: { role?: string; plays: number; fixed: Map<number, string>; current: string[] }): SongWordsSection {
  return {
    key,
    label,
    bars,
    ...(extra.role ? { role: extra.role } : {}),
    plays: extra.plays,
    lines: plan.targets.map((t, i) => ({ syllables: t, rhyme: plan.letters[i] ?? null, ...(extra.fixed.has(i) ? { fixed: extra.fixed.get(i) } : {}) })),
    budget: budgetPromptLine(plan.spec, bars, plan.targets),
    ...(extra.current.length > 0 ? { current: extra.current } : {}),
  };
}

function wordsFrom(lines: VerifiedLines['lines'], config: Text2VoiceConfig, sectionId?: string): Text2VoiceWords | null {
  const w = wordsForLines(
    lines.map((l) => l.text),
    { phrase: '', syllables: [], source: 'write', lines: lines.map((l) => l.syllables), lineTexts: lines.map((l) => l.text) },
    { ...(config.topic?.trim() ? { topic: config.topic.trim() } : {}), rhymeScheme: config.rhymeScheme ?? 'none', ...(sectionId ? { sectionId } : {}) },
  );
  return w;
}

async function backgroundFor(host: Pick<PluginHost, 'getProjectData'>, focus: string): Promise<string> {
  const pack = await loadPack(host).catch(() => null);
  return pack ? contextExcerpt(pack, focus).text : '';
}

// ---------------------------------------------------------------------------
// One scene (Scene view)
// ---------------------------------------------------------------------------

export interface SceneWordsInput {
  sceneId: string;
  config: Text2VoiceConfig;
  /** The melody when it is reusable for this scene (lines then follow its phrases). */
  melody: Text2VoiceMelody | null;
  bars: number;
}

export interface SceneWordsResult {
  words: Text2VoiceWords;
  plan: SectionPlan;
  trimmed: number;
  written: number;
  note?: string;
}

/** ✍ in Scene view: this scene's words, to the budget, the lyric context as background. */
export async function writeSceneWords(
  host: Pick<PluginHost, 'generateWithLLMTools' | 'getProjectData'> & Partial<Pick<PluginHost, 'getArrangementOutline'>>,
  input: SceneWordsInput,
): Promise<SceneWordsResult> {
  const about = (input.config.topic ?? '').trim();
  const plan = planSection(input.config, input.melody, input.bars, input.config.rhymeScheme ?? 'none');
  const outline = hasArrangementOutline(host) ? await host.getArrangementOutline().catch(() => null) : null;
  const placed = (outline?.sections ?? []).filter((s) => s.sceneId === input.sceneId);
  const songOrder = placed.length > 0 ? formatSongOrder(outline, { currentSceneId: input.sceneId }) : '';
  const prompt: SongWordsPrompt = {
    about,
    songOrder,
    background: await backgroundFor(host, about),
    sections: [sectionFor('s1', placed[0]?.label?.trim() || 'This scene', input.bars, plan, { ...(placed[0]?.role ? { role: placed[0].role } : {}), plays: Math.max(1, placed.length), fixed: new Map(), current: [] })],
    stylePack: input.config.style ? STYLES[input.config.style].promptPack : [],
    song: false,
  };
  const parsed = await callWriter(host, prompt);
  const answer = parsed.sections.find((s) => s.key === 's1') ?? parsed.sections[0];
  const v = verifyLines(plan.targets, new Map(), answer?.lines ?? []);
  const words = wordsFrom(v.lines, input.config);
  if (!words) throw new Error('None of the returned lines were usable — try ✍ again.');
  console.log(budgetLogLine('this scene', plan.spec, input.bars, plan.targets, v.written, v.trimmed));
  return { words, plan, trimmed: v.trimmed, written: v.written, ...(parsed.note ? { note: parsed.note } : {}) };
}

// ---------------------------------------------------------------------------
// The whole song (Song view)
// ---------------------------------------------------------------------------

export interface SongWordsInput {
  /** The active scene and the reading ✍ was pressed in. */
  sceneId: string;
  anchorDbId: string;
  /** Its config (the ✍ prompt is the song's description when given). */
  config: Text2VoiceConfig;
  /** The active scene's bars per the musical context, and a melody reusable there. */
  melody: Text2VoiceMelody | null;
  keyFor?: KeyFor;
}

export interface WrittenSection {
  instanceId: string;
  sceneId: string;
  label: string;
  role?: string;
  lines: string[];
  /** The scene's later placements, which repeat these words. */
  repeats: string[];
  asked: number;
  written: number;
  trimmed: number;
  reanchored?: string;
}

export interface WriteSongResult {
  sections: WrittenSection[];
  skipped: Array<{ instanceId: string; label: string; reason: string }>;
  /** Scenes whose reading's box now holds their section (ready for Sing). */
  projected: string[];
  /** Readings that kept their own box (Scene view with words of their own). */
  keptBox: string[];
  calls: number;
  note?: string;
}

type SongWriterHost = Pick<PluginHost, 'generateWithLLMTools' | 'getProjectData' | 'getSceneData' | 'setSceneData'> &
  Partial<
    Pick<
      PluginHost,
      | 'getArrangementOutline'
      | 'getSongLyrics'
      | 'setSectionLyrics'
      | 'setSongDescription'
      | 'onSongLyricsChanged'
      | 'getAllSceneData'
      | 'getActiveSceneId'
      | 'getPluginTracks'
      | 'listSceneTracks'
      | 'listSceneAudioTracks'
      | 'listSceneFamilyTracks'
    >
  >;

interface ScenePlan {
  sceneId: string;
  key: string;
  first: ArrangementOutlineSection;
  others: ArrangementOutlineSection[];
  label: string;
  anchor: string;
  config: Text2VoiceConfig;
  plan: SectionPlan;
  role?: string;
  fixed: Map<number, string>;
  current: string[];
  reanchored?: string;
}

/** ✍ in Song view: the whole song, section by section, in one call. */
export async function writeSongWords(host: SongWriterHost, input: SongWordsInput): Promise<WriteSongResult> {
  const song = songHostOf(host);
  if (!song || !hasArrangementOutline(host)) throw new Error(SONG_API_MISSING_MESSAGE);
  const keyFor = input.keyFor ?? defaultKeyFor;
  const outline: ArrangementOutline | null = await host.getArrangementOutline().catch(() => null);
  const placed = outline?.sections ?? [];
  if (placed.length === 0) throw new Error(NO_ARRANGEMENT_MESSAGE);
  let doc: SongLyrics | null = await song.getSongLyrics().catch(() => null);

  // The ✍ prompt is the song's description; an empty prompt uses the stored one.
  const topic = (input.config.topic ?? '').trim();
  if (topic && topic !== (doc?.description ?? '')) {
    await song.setSongDescription(topic.slice(0, 2000)).catch((err: unknown) => console.warn(`[Text2Voice] song description not saved: ${err instanceof Error ? err.message : String(err)}`));
    doc = await song.getSongLyrics().catch(() => doc);
  }
  const about = topic || (doc?.description ?? '').trim();
  const pack = await loadPack(host).catch(() => null);
  const labels = labelsFor(outline, doc);
  const label = (s: ArrangementOutlineSection): string => labels.get(s.instanceId) ?? s.sceneName;
  if (!about && !(pack && pack.documents.some((d) => d.text.trim()))) {
    throw new Error('Say what the song is about in the ✍ prompt, or add a document to the lyric context first.');
  }

  // --- one section per placed scene with a reading --------------------------
  const skipped: WriteSongResult['skipped'] = [];
  const plans: ScenePlan[] = [];
  const scenesInOrder: string[] = [];
  for (const s of placed) if (!scenesInOrder.includes(s.sceneId)) scenesInOrder.push(s.sceneId);
  for (const sceneId of scenesInOrder) {
    const placements = placed.filter((p) => p.sceneId === sceneId);
    const readings = await readingsInScene(host, sceneId);
    if (readings.length === 0) {
      for (const p of placements) skipped.push({ instanceId: p.instanceId, label: label(p), reason: NO_READING_REASON });
      continue;
    }
    // The scene's reading: the one ✍ was pressed in, else one a placement already names, else the first.
    const preferred = sceneId === input.sceneId && readings.includes(input.anchorDbId) ? input.anchorDbId : undefined;
    const named = placements.map((p) => doc?.sections[p.instanceId]?.voiceTrackDbId).find((id): id is string => !!id && readings.includes(id));
    const anchor = preferred ?? named ?? readings[0];
    // S-431: a placement another plugin's existing track sings is skipped; a gone track frees it.
    const free: ArrangementOutlineSection[] = [];
    let reanchored: string | undefined;
    for (const p of placements) {
      const claim = doc?.sections[p.instanceId]?.voiceTrackDbId;
      if (claim && !readings.includes(claim)) {
        const status = await anchorStatus(host, sceneId, claim, readings);
        if (status === 'foreign') {
          skipped.push({ instanceId: p.instanceId, label: label(p), reason: FOREIGN_TRACK_REASON });
          continue;
        }
        reanchored = reanchored ?? reanchorNote(status);
      }
      free.push(p);
    }
    if (free.length === 0) continue;
    const first = free[0];
    const config =
      (sceneId === input.sceneId && anchor === input.anchorDbId
        ? input.config
        : asText2VoiceConfig(await host.getSceneData(sceneId, keyFor(anchor, TEXT2VOICE_CONFIG_KEY)).catch(() => null))) ?? null;
    if (!config) {
      for (const p of free) skipped.push({ instanceId: p.instanceId, label: label(p), reason: 'the reading has no settings yet' });
      continue;
    }
    const stored =
      sceneId === input.sceneId && anchor === input.anchorDbId
        ? input.melody
        : asText2VoiceMelody(await host.getSceneData(sceneId, keyFor(anchor, TEXT2VOICE_MELODY_KEY)).catch(() => null));
    const melody = stored && stored.bars === first.bars ? stored : null;
    const plan = planSection(config, melody, first.bars, input.config.rhymeScheme ?? config.rhymeScheme ?? 'none');
    const sec = doc?.sections[first.instanceId];
    const current = resolveSectionLines(doc, first.instanceId);
    const fixed = new Map<number, string>();
    for (const i of sec?.locks ?? []) if (i < plan.targets.length && current[i]) fixed.set(i, current[i]);
    plans.push({
      sceneId,
      key: '',
      first,
      others: free.slice(1),
      label: label(first),
      anchor,
      config,
      plan,
      ...((sec?.role ?? first.role) ? { role: sec?.role ?? first.role } : {}),
      fixed,
      current,
      ...(reanchored ? { reanchored } : {}),
    });
  }
  if (plans.length === 0) {
    throw new Error(skipped.length > 0 ? `No section to write: ${skipped.map((s) => `${s.label} (${s.reason})`).join('; ')}.` : 'No section to write.');
  }
  const over = plans.slice(SONG_MAX_SECTIONS);
  for (const o of over) skipped.push({ instanceId: o.first.instanceId, label: o.label, reason: `more than ${SONG_MAX_SECTIONS} scenes in one song call` });
  const writing = plans.slice(0, SONG_MAX_SECTIONS);
  writing.forEach((p, i) => {
    p.key = `s${i + 1}`;
  });

  // --- the call ---------------------------------------------------------------
  const styles = new Set(writing.map((p) => p.config.style ?? ''));
  const oneStyle = styles.size === 1 ? writing[0].config.style : undefined;
  const prompt: SongWordsPrompt = {
    about,
    songOrder: formatSongOrder(outline, { currentSceneId: input.sceneId }),
    background: pack ? contextExcerpt(pack, [about, ...writing.map((p) => p.label)].join(' ')).text : '',
    sections: writing.map((p) =>
      sectionFor(p.key, p.label, p.first.bars, p.plan, { ...(p.role ? { role: p.role } : {}), plays: 1 + p.others.length, fixed: p.fixed, current: p.current }),
    ),
    stylePack: oneStyle ? STYLES[oneStyle].promptPack : [],
    song: true,
  };
  const parsed = await callWriter(host, prompt);
  const answered = new Map(parsed.sections.map((s) => [s.key, s]));

  // --- verify, then write back: the document, then the boxes -----------------
  const sections: WrittenSection[] = [];
  const projected: string[] = [];
  const keptBox: string[] = [];
  for (const p of writing) {
    const a = answered.get(p.key);
    if (!a || a.lines.length === 0) {
      skipped.push({ instanceId: p.first.instanceId, label: p.label, reason: 'the model gave no words for it' });
      continue;
    }
    const v = verifyLines(p.plan.targets, p.fixed, a.lines);
    if (v.lines.length === 0) {
      skipped.push({ instanceId: p.first.instanceId, label: p.label, reason: 'none of its lines were usable' });
      continue;
    }
    const role = a.role ?? p.role;
    const texts = v.lines.map((l) => l.text);
    const existing = doc?.sections[p.first.instanceId];
    const claim = existing?.voiceTrackDbId === p.anchor ? {} : { voiceTrackDbId: p.anchor };
    try {
      await song.setSectionLyrics(p.first.instanceId, { ...(existing?.sameAs ? { sameAs: null } : {}), lines: texts, ...(role ? { role } : {}), ...claim });
    } catch (err) {
      if (!isNotOwned(err)) throw err;
      skipped.push({ instanceId: p.first.instanceId, label: p.label, reason: FOREIGN_TRACK_REASON });
      continue;
    }
    const repeats: string[] = [];
    for (const o of p.others) {
      const oc = doc?.sections[o.instanceId]?.voiceTrackDbId === p.anchor ? {} : { voiceTrackDbId: p.anchor };
      try {
        await song.setSectionLyrics(o.instanceId, { sameAs: p.first.instanceId, ...(role ? { role } : {}), ...oc });
        repeats.push(o.instanceId);
      } catch (err) {
        if (!isNotOwned(err)) throw err;
        skipped.push({ instanceId: o.instanceId, label: label(o), reason: FOREIGN_TRACK_REASON });
      }
    }
    console.log(budgetLogLine(p.label, p.plan.spec, p.first.bars, p.plan.targets, v.written, v.trimmed));
    sections.push({
      instanceId: p.first.instanceId,
      sceneId: p.sceneId,
      label: p.label,
      ...(role ? { role } : {}),
      lines: texts,
      repeats,
      asked: p.plan.targets.reduce((s, t) => s + t, 0),
      written: v.written,
      trimmed: v.trimmed,
      ...(p.reanchored ? { reanchored: p.reanchored } : {}),
    });

    // The reading's box follows the song when it is in Song view or empty; else it keeps its own words.
    const follows = p.config.view === 'song' || !p.config.text.trim() || (p.sceneId === input.sceneId && p.anchor === input.anchorDbId);
    if (!follows) {
      keptBox.push(p.label);
      continue;
    }
    const words = wordsFrom(v.lines, p.config, p.first.instanceId);
    if (!words) continue;
    await host.setSceneData(p.sceneId, keyFor(p.anchor, TEXT2VOICE_WORDS_KEY), words).catch(() => {});
    await host
      .setSceneData(p.sceneId, keyFor(p.anchor, TEXT2VOICE_CONFIG_KEY), { ...p.config, text: texts.join('\n'), view: 'song', sourceMode: 'quote' })
      .catch(() => {});
    projected.push(p.sceneId);
  }
  return { sections, skipped, projected, keptBox, calls: 1, ...(parsed.note ? { note: parsed.note } : {}) };
}

/** The toast's one line about a song write. */
export function songResultSummary(r: WriteSongResult): string {
  const parts: string[] = [];
  const n = r.sections.length;
  parts.push(`${n} section${n === 1 ? '' : 's'} written`);
  const reps = r.sections.reduce((s, x) => s + x.repeats.length, 0);
  if (reps > 0) parts.push(`${reps} repeat${reps === 1 ? '' : 's'} share their words`);
  if (r.skipped.length > 0) parts.push(`skipped: ${r.skipped.map((s) => `${s.label} (${s.reason})`).join('; ')}`);
  if (r.keptBox.length > 0) parts.push(`kept their own box (Scene view): ${r.keptBox.join(', ')}`);
  return `${parts.join(' · ')}. Press Sing in each scene.`;
}
