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

import type {
  PluginSystemVoice,
  RenderVocalLineRequest,
  RenderVocalLineResult,
} from '@signalsandsorcery/plugin-sdk';

// Re-exported under local names so call sites read naturally; the contract
// itself lives in the SDK (@since 3.4.0) so the two cannot drift.
export type VocalLineResult = RenderVocalLineResult;
export type SystemVoice = PluginSystemVoice;

export interface VocalHost {
  renderVocalLine(request: RenderVocalLineRequest): Promise<RenderVocalLineResult>;
  listSystemVoices(): Promise<PluginSystemVoice[]>;
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
