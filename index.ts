/**
 * @signalsandsorcery/text2voice-generator — plugin entry.
 *
 * Paste prose; a phrase from it is quoted, set to music over the scene's key
 * and chords, spoken syllable-by-syllable by a system speech voice, and each
 * syllable's pitch forced to its note. Rendering is offline — every voice
 * lands on its own audio track. See Text2VoiceGeneratorPanel.tsx and
 * src/text2voice-generation.ts.
 */

import type { ComponentType } from 'react';
import type {
  GeneratorPlugin,
  PluginHost,
  PluginUIProps,
  PluginSettingsSchema,
  PluginSkill,
} from '@signalsandsorcery/plugin-sdk';
import { Text2VoiceGeneratorPanel } from './Text2VoiceGeneratorPanel';
import manifest from './plugin.json';
import { RENDER_VOCAL_LINE_SKILL } from './src/sing-text';

class Text2VoiceGeneratorPlugin implements GeneratorPlugin {
  readonly id = '@signalsandsorcery/text2voice-generator';
  readonly displayName = 'Text2Voice';
  readonly version = '0.2.0';
  readonly description =
    'Text2Voice — paste prose and have it sung: an LLM quotes a phrase and sets it over the scene, ' +
    'then each syllable is spoken by a system voice and forced onto its note. One audio track per voice.';
  readonly generatorType = 'audio' as const;
  readonly minHostVersion = '3.4.0';

  private host: PluginHost | null = null;

  async activate(host: PluginHost): Promise<void> {
    this.host = host;
    console.log('[Text2VoiceGeneratorPlugin] activated');
  }

  async deactivate(): Promise<void> {
    this.host = null;
  }

  getUIComponent(): ComponentType<PluginUIProps> {
    return Text2VoiceGeneratorPanel;
  }

  getSettingsSchema(): PluginSettingsSchema | null {
    return null;
  }

  /** D-499: the headless Sing (`render_vocal_line`); the app's skill handler calls `singText`. */
  getSkills(): PluginSkill[] {
    return [RENDER_VOCAL_LINE_SKILL];
  }
}

export default Text2VoiceGeneratorPlugin;
export { Text2VoiceGeneratorPlugin, Text2VoiceGeneratorPanel };
export const text2voiceManifest = manifest;
export {
  singText,
  singTextFromParams,
  parseSingTextInput,
  SingTextError,
  RENDER_VOCAL_LINE_SKILL,
  RENDER_VOCAL_LINE_SKILL_ID,
} from './src/sing-text';
export type { SingTextInput, SingTextResult, SungLane } from './src/sing-text';
