/**
 * Prompt + schema for the single schema-forced model call.
 *
 * The model does three jobs at once: choose a phrase to QUOTE from the user's
 * text, split it into syllables, and set it to music. Everything comes back in
 * one `submit_text2voice` call.
 *
 * The note model is a SYLLABLE GRID: every voice gets exactly one slot per
 * syllable, holding either a scale degree or a rest, and one shared rhythm
 * array gives the slots their durations. Alignment between words and notes is
 * therefore structural — it cannot drift — which is why this plugin does not
 * need ensemble-core's `enforceVoice`: the grid is monophonic, in-scale and
 * density-capped by construction. Only the register clamp is left to do.
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

export function buildSubmitText2VoiceTool(
  harmony: HarmonyStyle,
  voiceCount: number,
): LLMFunctionDeclaration {
  const nVoices = composedVoiceCount(harmony, voiceCount);
  return {
    name: SUBMIT_TEXT2VOICE_TOOL_NAME,
    description:
      'Submit the chosen phrase, its syllable split, a shared rhythm, and one ' +
      `syllable-grid line per voice (${nVoices} ${nVoices === 1 ? 'voice' : 'voices'}).`,
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
            'The phrase split into syllables, in order. Concatenated (ignoring ' +
            'spaces and punctuation) these must reproduce the phrase exactly. ' +
            'Example: "observable universe" -> ["ob","serv","a","ble","u","ni","verse"].',
          items: { type: 'string' },
        },
        rhythm: {
          type: 'array',
          description:
            'Duration in quarter-note beats for each syllable slot, same length ' +
            'and order as `syllables`. Use longer values on stressed syllables ' +
            'and at phrase ends.',
          items: { type: 'number' },
        },
        voices: {
          type: 'array',
          description:
            `Exactly ${nVoices} voice line(s), highest first. Each has one note ` +
            'slot per syllable, in the same order.',
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
                  'One slot per syllable, same length and order as `syllables`.',
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
                      description:
                        'Octave offset from the voice register, -1, 0 or 1. Use 0 unless leaping.',
                    },
                    rest: {
                      type: 'boolean',
                      description: 'True to leave this syllable unsung in this voice.',
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
  const lines: string[] = [];

  lines.push(
    'You set found text to music for a psychedelic, deliberately unnatural vocal instrument.',
    'A speech synthesiser speaks each syllable and its pitch is then forced to the note you write,',
    'so the setting must be singable one-syllable-per-note. Realism is NOT the goal; strangeness is.',
    '',
    '## Your job',
    '1. Choose a phrase from the supplied text. QUOTE it exactly — never paraphrase or invent words.',
    `2. Split it into syllables. It must fit ${ctx.syllableBudget} syllables or fewer.`,
    '3. Give each syllable a duration, and write one note slot per syllable for each voice.',
    '',
    '## Choosing the phrase',
    '- Prefer a phrase that is striking, strange, or oddly beautiful out of context.',
    '- Prefer vowel-rich words: they sustain, and sustained vowels are where this instrument sings.',
    '- A complete grammatical clause beats a fragment cut mid-word.',
    `- Aim for roughly ${Math.max(4, Math.floor(ctx.syllableBudget * 0.6))}-${ctx.syllableBudget} syllables.`,
    '',
    '## The music',
    `- Key: ${ctx.key} ${ctx.mode}. Time signature: ${ctx.timeSignature}. Tempo: ${Math.round(ctx.bpm)} BPM.`,
    `- Length: ${ctx.bars} bars (${ctx.quarterNotesPerBar} quarter-note beats per bar).`,
    `- Chords: ${ctx.chordSummary}`,
    `- Total beats available: ${ctx.bars * ctx.quarterNotesPerBar}. The rhythm array must sum to at most this.`,
    `- A comfortable default slot is ${(1 / ctx.notesPerBeat).toFixed(2)} beats; vary it for speech rhythm.`,
    '- Set stressed syllables on strong beats and longer values. Do not let the line become mechanical.',
    '',
    `## Harmony — ${ctx.harmony}`,
    `${HARMONY_DESCRIPTIONS[ctx.harmony]}`,
  );

  if (isComposedHarmony(ctx.harmony)) {
    lines.push(`- Write ${nVoices} voices, highest first. Voice 0 carries the melody.`);
    switch (ctx.harmony) {
      case 'choral':
        lines.push(
          '- All voices sound on the SAME slots — block harmony, no independent rhythm.',
          '- Space the voices as a chord: avoid unisons and avoid gaps wider than an octave.',
        );
        break;
      case 'counterpoint':
        lines.push(
          '- Give each voice its own contour. Favour contrary motion; avoid parallel fifths and octaves.',
          '- Use rests so the voices enter and drop out independently — they should not breathe together.',
        );
        break;
      case 'cluster':
        lines.push(
          '- Stack the voices in tight seconds so they beat against each other.',
          '- Keep the cluster inside a fifth overall; move it as a block.',
        );
        break;
      default:
        break;
    }
  } else {
    lines.push(
      '- Write ONE voice only. The remaining voices are derived mechanically from it.',
    );
  }

  lines.push(
    '',
    `## Delivery — ${ctx.delivery}`,
    `${DELIVERY_DESCRIPTIONS[ctx.delivery]}`,
    '',
    '## Hard rules',
    '- `syllables`, `rhythm`, and every voice\'s `notes` array must all be the SAME length.',
    '- Concatenating `syllables` must reproduce `phrase` exactly.',
    '- Degrees are 0-6. Octave is -1, 0 or 1.',
    `- Call ${SUBMIT_TEXT2VOICE_TOOL_NAME} exactly once. Return nothing else.`,
  );

  return lines.join('\n');
}

export function buildText2VoiceUserPrompt(ctx: PromptContext): string {
  return [
    'Set a phrase from this text to music:',
    '',
    '"""',
    ctx.text.trim(),
    '"""',
    '',
    `Harmony: ${ctx.harmony}. Delivery: ${ctx.delivery}. Voices to compose: ${composedVoiceCount(ctx.harmony, ctx.voiceCount)}.`,
    `Fit within ${ctx.syllableBudget} syllables and ${ctx.bars * ctx.quarterNotesPerBar} quarter-note beats.`,
  ].join('\n');
}
