/**
 * Structural view of the host methods this plugin needs beyond the published
 * PluginHost surface, plus runtime feature detection.
 *
 * `renderVocalLine` and `listSystemVoices` are optional host capabilities
 * (host >= 3.4.0). Declaring them structurally and probing with `typeof` is the
 * codebase's established pattern for optional host methods — the same way the
 * panel shell gates alt-tracks — so this package still compiles and loads
 * against an older host instead of failing at import time.
 */

import type { VocalLineRequest } from './render-spec';

export interface VocalLineResult {
  /** Absolute path to the rendered WAV. */
  filePath: string;
  durationSec: number;
  /**
   * Indices of syllables that carried no pitch. A voice that is mostly
   * unvoiced (macOS "Whisper") reports every syllable here — it renders as
   * breath rather than melody, which is worth surfacing rather than hiding.
   */
  unvoicedIndices: number[];
}

export interface SystemVoice {
  name: string;
  locale?: string;
}

export interface VocalHost {
  renderVocalLine(request: VocalLineRequest): Promise<VocalLineResult>;
  listSystemVoices(): Promise<SystemVoice[]>;
}

export function asVocalHost(host: unknown): VocalHost | null {
  if (!host || typeof host !== 'object') return null;
  const h = host as Partial<VocalHost>;
  if (typeof h.renderVocalLine !== 'function') return null;
  return h as VocalHost;
}

export function supportsSystemVoices(host: unknown): boolean {
  if (!host || typeof host !== 'object') return false;
  return typeof (host as Partial<VocalHost>).listSystemVoices === 'function';
}

export const HOST_TOO_OLD_MESSAGE =
  'This host cannot render voices. Text2Voice needs app support for speech ' +
  'rendering (host 3.4.0 or newer) — update the app and try again.';
