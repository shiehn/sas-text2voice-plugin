/**
 * Prompt + schema for the single schema-forced model call.
 *
 * The model does two jobs at once: choose a phrase to QUOTE from the user's
 * text, and write a VOCAL LINE for it.
 *
 * The crucial thing it must understand is that note duration controls TEXT
 * DENSITY, not melisma. Syllables are spread across the melody afterwards at a
 * steady subdivision (see distribute.ts), so:
 *
 *     a long note   → many syllables recited on that one pitch (a chant tone)
 *     a short note  → a single syllable
 *     a rest        → a breath, and the words WAIT for it
 *
 * That makes the melody's shape the thing that composes the speech rhythm,
 * which is why the prompt spends most of its words on vocal writing rather than
 * on the text. Getting this wrong produces the failure this design exists to
 * fix: an even one-syllable-per-note train that talks without pause.
 */

import type { LLMFunctionDeclaration } from '@signalsandsorcery/plugin-sdk';
import type { HarmonyStyle, DeliveryMode } from './harmony-styles';
import { HARMONY_DESCRIPTIONS, DELIVERY_DESCRIPTIONS, isComposedHarmony } from './harmony-styles';

export const SUBMIT_TEXT2VOICE_TOOL_NAME = 'submit_text2voice';

export interface PromptContext {
  text: string;
  harmony: HarmonyStyle;
  delivery: DeliveryMode;
  voiceCount: number;
  /** Style-specific guidance lines, appended verbatim (may be empty). */
  stylePack: string[];
  /** Note lengths this style wants (beats). */
  rhythmRange: { minBeats: number; maxBeats: number };
  /** Where this style's voices live — steers the octave language. */
  register: { top: number; spanSemitones: number };
  syllableBudget: number;
  key: string;
  mode: string;
  bpm: number;
  bars: number;
  timeSignature: string;
  quarterNotesPerBar: number;
  chordSummary: string;
  notesPerBeat: number;
}

/** How many voices the model must actually compose (derived styles need one). */
export function composedVoiceCount(harmony: HarmonyStyle, voiceCount: number): number {
  return isComposedHarmony(harmony) ? voiceCount : 1;
}

/**
 * A singable number of melody notes for a scene of this length — derived from
 * the style's note-length range, so a flow style (short notes) is allowed the
 * density it needs and a chant (long notes) is steered sparse.
 */
export function melodyNoteBudget(
  bars: number,
  quarterNotesPerBar: number,
  rhythmRange: { minBeats: number; maxBeats: number } = { minBeats: 0.5, maxBeats: 4 },
): { min: number; max: number } {
  const beats = bars * quarterNotesPerBar;
  // Leave ~25% of the scene for rests — the breathing is not optional.
  const singable = beats * 0.75;
  const min = Math.max(3, Math.round(singable / rhythmRange.maxBeats));
  const max = Math.max(min + 3, Math.round(singable / Math.max(0.25, rhythmRange.minBeats)));
  return { min, max };
}

export function buildSubmitText2VoiceTool(
  harmony: HarmonyStyle,
  voiceCount: number,
  noteBudget: { min: number; max: number },
  rhythmRange: { minBeats: number; maxBeats: number } = { minBeats: 0.5, maxBeats: 4 },
): LLMFunctionDeclaration {
  const nVoices = composedVoiceCount(harmony, voiceCount);
  return {
    name: SUBMIT_TEXT2VOICE_TOOL_NAME,
    description:
      'Submit the chosen phrase, its syllable split, and a vocal melody. The melody is ' +
      'NOT one note per syllable — long notes carry many syllables, rests are breaths.',
    parameters: {
      type: 'object',
      properties: {
        phrase: {
          type: 'string',
          description:
            'A phrase copied VERBATIM from the supplied text. Do not paraphrase, ' +
            'summarise or invent words — every word must appear in the source.',
        },
        syllables: {
          type: 'array',
          description:
            'The phrase split into syllables, in order. Concatenated (ignoring spaces ' +
            'and punctuation) these must reproduce the phrase exactly. Example: ' +
            '"observable universe" -> ["ob","serv","a","ble","u","ni","verse"]. The ' +
            'COUNT is independent of the number of melody notes.',
          items: { type: 'string' },
        },
        stress: {
          type: 'array',
          description:
            'Lexical stress per syllable, parallel to `syllables`: 1 for a stressed ' +
            'syllable, 0 otherwise ("ob-SERV-a-ble" -> [0,1,0,0]). Stressed syllables ' +
            'are sung with more weight.',
          items: { type: 'integer' },
        },
        rhythm: {
          type: 'array',
          description:
            `Duration in quarter-note beats of each MELODY note (not each syllable), in ` +
            `order. Length must equal the number of notes in each voice — aim for ` +
            `${noteBudget.min}-${noteBudget.max} notes. A long value means more syllables ` +
            `are recited on that pitch; a short value means one syllable. ` +
            `Use ${rhythmRange.minBeats} to ${rhythmRange.maxBeats}.`,
          items: { type: 'number' },
        },
        voices: {
          type: 'array',
          description:
            `Exactly ${nVoices} voice line(s), highest first, all sharing the rhythm above.`,
          items: {
            type: 'object',
            properties: {
              label: {
                type: 'string',
                description: 'Short role label, e.g. "lead", "harmony", "bass line".',
              },
              notes: {
                type: 'array',
                description:
                  'One entry per rhythm value, same length and order. A rest is a BREATH: ' +
                  'the words pause and resume after it, they are not skipped.',
                items: {
                  type: 'object',
                  properties: {
                    degree: {
                      type: 'integer',
                      description:
                        'Scale degree, 0 = tonic through 6 = leading tone. Ignored when rest is true.',
                    },
                    octave: {
                      type: 'integer',
                      description: 'Octave offset: -1, 0 or 1. Use 0 unless deliberately leaping.',
                    },
                    rest: { type: 'boolean', description: 'True for a breath.' },
                    melisma: {
                      type: 'boolean',
                      description:
                        'True extends the PREVIOUS syllable\'s vowel through this note (a run). ' +
                        'Only meaningful on the LEAD voice, on a non-rest note directly after ' +
                        'another non-rest note. Use sparingly: at most one run per phrase, on ' +
                        'its emotional word.',
                    },
                  },
                  required: ['degree', 'octave', 'rest'],
                },
              },
            },
            required: ['label', 'notes'],
          },
        },
      },
      required: ['phrase', 'syllables', 'rhythm', 'voices'],
    },
  };
}

export function buildText2VoiceSystemPrompt(ctx: PromptContext): string {
  const nVoices = composedVoiceCount(ctx.harmony, ctx.voiceCount);
  const notes = melodyNoteBudget(ctx.bars, ctx.quarterNotesPerBar, ctx.rhythmRange);
  const totalBeats = ctx.bars * ctx.quarterNotesPerBar;
  const lines: string[] = [];

  lines.push(
    'You write VOCAL LINES for a deliberately unnatural choir. A speech synthesiser speaks',
    'each syllable and its pitch is forced to your note, so what you write is sung by machines.',
    'Realism is not the goal; strangeness is. But it must still be SINGABLE — that is what',
    'makes the strangeness land instead of turning to mush.',
    '',
    '## The one thing to understand',
    'You are NOT writing one note per syllable. Syllables are spread across your melody',
    'afterwards at a steady rate, so a note\'s LENGTH decides how much text sits on it:',
    '',
    '    a long note   →  many syllables recited on that one pitch (a chant tone)',
    '    a short note  →  a single syllable',
    '    a rest        →  a breath; the words PAUSE and continue after it',
    '',
    'So the melody is what composes the speech rhythm. A line of equal short notes will',
    'gabble without pause — the commonest way to make this sound bad. Vary the lengths.',
    '',
    '## Writing for a voice',
    '- BREATHE. Put rests where the sense of the phrase breaks — at commas, clauses, and',
    '  between ideas. A line with no rests is unsingable and exhausting to hear.',
    `- HARD RULE: never more than ${Math.max(2, Math.round((3.5 * ctx.bpm) / 60))} consecutive beats of notes without a rest —`,
    '  that is one lungful. A gap will be carved mid-phrase if you exceed it, wherever it falls.',
    '- Phrase in arcs: 2-4 bars that rise and settle, then a breath. Not one long ribbon.',
    '- Move mostly by STEP. Leaps are expressive precisely because they are rare; after a',
    '  leap, step back in the opposite direction.',
    '- Land STRESSED syllables on strong beats and on the longer notes. Never put a weak',
    '  syllable on the longest note of a phrase — that is the mark of a bad setting.',
    '- Mark the stress array honestly: the renderer leans into stressed syllables.',
    '- Give the phrase\'s most important word the highest note or the longest one.',
    '- MELISMA (optional): on the LEAD voice you may mark a note melisma:true to extend',
    '  the previous syllable\'s vowel through it — a run. At most one run per phrase,',
    '  2-4 notes, on the phrase\'s emotional word. Never after a rest.',
    '- End phrases by settling, usually downward, onto a longer value.',
    '- Keep the whole line inside about an octave and a fifth. Voices sound strained at the',
    '  extremes and this instrument exaggerates that.',
    '',
    '## Using chant',
    'A long note holding many syllables is a RECITING TONE — the psalm-tone move: hold one',
    'pitch through a run of text, then move melodically at the cadence. This is the most',
    'characteristic sound available here. Use it deliberately: a bar or two of recitation on',
    'one pitch, then a short melodic tail, then a breath.',
    '',
    '## Your job',
    `1. Choose a phrase from the supplied text. QUOTE it exactly — never paraphrase or invent.`,
    `2. Split it into syllables. Aim for about ${ctx.syllableBudget} or fewer.`,
    `3. Write ${notes.min}-${notes.max} melody notes with varied durations and real rests,`,
    '   shaped around where that phrase\'s stresses fall.',
    '',
    '## The scene',
    `- Key: ${ctx.key} ${ctx.mode}. Time signature: ${ctx.timeSignature}. Tempo: ${Math.round(ctx.bpm)} BPM.`,
    `- Length: ${ctx.bars} bars = ${totalBeats} quarter-note beats. The rhythm array must sum to`,
    `  at most ${totalBeats} and at least ${Math.max(2, Math.round(totalBeats * 0.8))} — a melody that fills only part of the scene`,
    '  leaves dead air at the end of every loop.',
    `- Chords: ${ctx.chordSummary}`,
    '- Land on chord tones at phrase starts and ends; passing notes between are fine.',
    `- Note lengths: ${ctx.rhythmRange.minBeats} to ${ctx.rhythmRange.maxBeats} beats. ` +
      (ctx.rhythmRange.maxBeats <= 2
        ? 'Short values dominate — this style FLOWS; save length for phrase ends.'
        : ctx.rhythmRange.minBeats >= 1
          ? 'Long values dominate — this style RECITES; save short values for cadences.'
          : 'Mix them; variety is the phrasing.'),
    ctx.register.top <= 56
      ? '- REGISTER: a LOW speech register. Keep the line tight — octave jumps sound like a'
      : ctx.register.spanSemitones >= 20
        ? '- REGISTER: wide and free — the section spans nearly two octaves; use octave'
        : '- REGISTER: a comfortable middle band. Use octave offsets sparingly, for',
    ctx.register.top <= 56
      ? '  different person, not the same rapper reaching.'
      : ctx.register.spanSemitones >= 20
        ? '  offsets (-1/+1) freely for the angular leaps.'
        : '  emphasis at phrase peaks.',
    '',
    `## Harmony — ${ctx.harmony}`,
    HARMONY_DESCRIPTIONS[ctx.harmony],
  );

  if (isComposedHarmony(ctx.harmony)) {
    lines.push(`- Write ${nVoices} voices, highest first. Voice 0 carries the melody and the text.`);
    switch (ctx.harmony) {
      case 'choral':
        lines.push(
          '- All voices move together on the same rhythm — block harmony.',
          '- Space them as chords: no unisons, no gaps wider than an octave, and avoid',
          '  parallel fifths and octaves between adjacent voices.',
        );
        break;
      case 'counterpoint':
        lines.push(
          '- Give each voice its own contour and its own rests, so they breathe at',
          '  different moments and the texture keeps moving when one voice stops.',
          '- Favour contrary motion; avoid parallel fifths and octaves.',
        );
        break;
      case 'cluster':
        lines.push(
          '- Stack the voices in tight seconds so they beat against each other.',
          '- Keep the whole cluster inside a fifth and move it as a block.',
        );
        break;
      default:
        break;
    }
  } else {
    lines.push('- Write ONE voice. The other voices are derived from it mechanically.');
  }

  if (ctx.stylePack.length > 0) {
    lines.push('', ...ctx.stylePack);
  }

  lines.push(
    '',
    `## Delivery — ${ctx.delivery}`,
    DELIVERY_DESCRIPTIONS[ctx.delivery],
  );
  switch (ctx.delivery) {
    case 'canon':
      lines.push(
        '- The line will be sung against a delayed copy of itself, so it must harmonise',
        '  with itself: favour stepwise motion and avoid a rhythm so distinctive that the',
        '  overlap turns to mud.',
      );
      break;
    case 'hocket':
      lines.push(
        '- Consecutive syllables will be dealt to different voices, so the line must survive',
        '  being split: keep it stepwise and avoid long recitations, which fragment badly.',
      );
      break;
    case 'tagteam':
      lines.push(
        '- The crew shouts each phrase-final word, so phrase ends carry the weight: land them',
        '  on strong beats and end phrases on words that can take a punch.',
      );
      break;
    default:
      lines.push('- Every voice lands on the same syllable at the same instant, so the rhythm you write is heard literally.');
      break;
  }

  lines.push(
    '',
    '## Hard rules',
    '- `rhythm` and every voice\'s `notes` array must be the SAME length.',
    '- `syllables` may be a DIFFERENT length — it is spread across the melody, not matched to it.',
    '- Concatenating `syllables` must reproduce `phrase` exactly.',
    '- Degrees are 0-6; octave is -1, 0 or 1.',
    `- The rhythm array must sum to at most ${totalBeats} beats and at least ${Math.max(2, Math.round(totalBeats * 0.8))}.`,
    `- Call ${SUBMIT_TEXT2VOICE_TOOL_NAME} exactly once. Return nothing else.`,
  );

  return lines.join('\n');
}

export function buildText2VoiceUserPrompt(ctx: PromptContext): string {
  const notes = melodyNoteBudget(ctx.bars, ctx.quarterNotesPerBar, ctx.rhythmRange);
  return [
    'Set a phrase from this text as a vocal line:',
    '',
    '"""',
    ctx.text.trim(),
    '"""',
    '',
    `Harmony: ${ctx.harmony}. Delivery: ${ctx.delivery}. Voices to compose: ${composedVoiceCount(ctx.harmony, ctx.voiceCount)}.`,
    `Around ${ctx.syllableBudget} syllables or fewer, on ${notes.min}-${notes.max} melody notes`,
    `within ${ctx.bars * ctx.quarterNotesPerBar} quarter-note beats. Remember: long notes recite, rests breathe.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Re-word: new text onto an EXISTING melody
// ---------------------------------------------------------------------------
//
// Composing the music is the slow, expensive half. When only the source text
// has changed, the notes are still good — all that is needed is a new phrase of
// roughly the right length to spread across them. That is a much smaller ask:
// no harmony, no rhythm, no register, so it returns fast and cheap.

export const SUBMIT_WORDS_TOOL_NAME = 'submit_text2voice_words';

export function buildSubmitWordsTool(targetSyllables: number): LLMFunctionDeclaration {
  return {
    name: SUBMIT_WORDS_TOOL_NAME,
    description: `Submit a phrase quoted from the text, split into about ${targetSyllables} syllables.`,
    parameters: {
      type: 'object',
      properties: {
        phrase: {
          type: 'string',
          description:
            'A phrase copied VERBATIM from the supplied text. Do not paraphrase, ' +
            'summarise or invent words — every word must appear in the source.',
        },
        syllables: {
          type: 'array',
          description:
            `The phrase split into syllables, in order — aim for ${targetSyllables}. ` +
            'Concatenated (ignoring spaces and punctuation) they must reproduce the phrase.',
          items: { type: 'string' },
        },
        stress: {
          type: 'array',
          description:
            'Lexical stress per syllable, parallel to `syllables`: 1 for a stressed ' +
            'syllable, 0 otherwise. Stressed syllables are sung with more weight.',
          items: { type: 'integer' },
        },
      },
      required: ['phrase', 'syllables'],
    },
  };
}

export function buildWordsSystemPrompt(targetSyllables: number): string {
  return [
    'You choose words to be sung by a deliberately unnatural choir.',
    'A melody already exists and will not change; your phrase is spread across it.',
    '',
    '## Your job',
    `1. Choose a phrase from the supplied text with about ${targetSyllables} syllables.`,
    '2. Return it quoted verbatim, plus its syllable split.',
    '',
    '## Rules',
    '- QUOTE the text. Never paraphrase, summarise, or invent a word that is not there.',
    `- Aim for ${targetSyllables} syllables. A little over or under is fine — the setting`,
    '  stretches or compresses to fit — but a wildly different length will not sit well.',
    '- Prefer vowel-rich words: they sustain, and sustained vowels are where this sings.',
    '- Prefer a phrase that is striking or strange out of context.',
    '- Prefer a complete clause over a fragment cut mid-thought.',
    '- Concatenating the syllables must reproduce the phrase exactly.',
    `- Call ${SUBMIT_WORDS_TOOL_NAME} exactly once. Return nothing else.`,
  ].join('\n');
}

export function buildWordsUserPrompt(text: string, targetSyllables: number): string {
  return [
    `Find a phrase of about ${targetSyllables} syllables in this text:`,
    '',
    '"""',
    text.trim(),
    '"""',
  ].join('\n');
}


// ---------------------------------------------------------------------------
// Write mode: ORIGINAL lyrics fitted to an existing melody's phrases
// ---------------------------------------------------------------------------

export const SUBMIT_LYRICS_TOOL_NAME = 'submit_text2voice_lyrics';

export interface LyricPhraseBudget {
  syllables: number;
  rhyme: string | null;
}

export function buildSubmitLyricsTool(budgets: LyricPhraseBudget[]): LLMFunctionDeclaration {
  return {
    name: SUBMIT_LYRICS_TOOL_NAME,
    description:
      `Submit exactly ${budgets.length} lyric lines, one per musical phrase, each with its ` +
      'syllable split. Lines sharing a rhyme letter must END on rhyming syllables.',
    parameters: {
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          description:
            `Exactly ${budgets.length} entries, in phrase order. Line i must aim for its ` +
            'phrase\'s syllable budget; the LAST syllable of each line lands on the ' +
            'phrase-final note, which is where rhymes are heard.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The line as plain words.' },
              syllables: {
                type: 'array',
                description:
                  'The line split into syllables, in order; concatenated they must ' +
                  'reproduce the text.',
                items: { type: 'string' },
              },
            },
            required: ['text', 'syllables'],
          },
        },
      },
      required: ['lines'],
    },
  };
}

export function buildLyricsSystemPrompt(
  topic: string,
  budgets: LyricPhraseBudget[],
  effectiveScheme: string,
  stylePack: string[],
): string {
  const lines: string[] = [
    'You write ORIGINAL LYRICS for a deliberately unnatural vocal instrument. A melody',
    'already exists; your words are fitted to its phrases. Strangeness is welcome;',
    'the fit is not negotiable.',
    '',
    `## Topic`,
    topic,
    '',
    '## The phrases',
  ];
  budgets.forEach((b, i) => {
    lines.push(
      `- Phrase ${i + 1}: ${b.syllables} syllables${b.rhyme ? ` — end rhyme ${b.rhyme}` : ''}`,
    );
  });
  lines.push(
    '',
    '## Rules',
    '- One line per phrase, in order. Hit each syllable budget as exactly as you can —',
    '  a miss of one is survivable, more than that mangles the line.',
    effectiveScheme === 'none'
      ? '- No rhyme constraint.'
      : `- Lines sharing a rhyme letter must END on syllables that genuinely rhyme (${effectiveScheme}).`,
    '- The LAST syllable of each line lands on the phrase-final note — put the weight there.',
    '- Prefer vowel-rich words; sustained vowels are where this instrument sings.',
    '- Each line\'s syllables, concatenated, must reproduce its text exactly.',
    `- Call ${SUBMIT_LYRICS_TOOL_NAME} exactly once. Return nothing else.`,
  );
  if (stylePack.length > 0) lines.push('', ...stylePack);
  return lines.join('\n');
}
