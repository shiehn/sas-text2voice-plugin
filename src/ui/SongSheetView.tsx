/**
 * The Song view's sheet (S-443): the song's sections in play order, from the
 * host's song lyric document. Each row says what it is (label, bars, the
 * budget its reading's style gives), its words, and its state: this scene, a
 * repeat of another section, skipped with the reason (another plugin's track
 * sings it, or no Text2Voice reading in that scene), or its take stale.
 *
 * Read-only on purpose: the box under it is THIS scene's section (what Sing
 * sings), the Lyrics tab in the arrangement row edits any section, and ✍
 * writes them all.
 */

import React from 'react';
import type { SongSheetRow } from '../song-lyrics';

export interface SongSheetViewProps {
  rows: SongSheetRow[] | null;
  /** Why there is no sheet (no song API, no arrangement). */
  reason?: string | null;
}

export function SongSheetView({ rows, reason }: SongSheetViewProps): React.ReactElement {
  if (!rows) {
    return (
      <div className="text-[9px] text-sas-muted px-1 py-1" data-testid="text2voice-song-sheet-reason">
        {reason ?? 'Reading the song…'}
      </div>
    );
  }
  return (
    <div className="space-y-0.5 mb-1 max-h-48 overflow-y-auto" data-testid="text2voice-song-sheet">
      {rows.map((r) => (
        <div
          key={r.instanceId}
          className={`px-1.5 py-0.5 rounded-sm border text-[10px] ${
            r.current ? 'border-sas-accent/60 bg-sas-accent/5' : 'border-sas-border/50'
          } ${r.status === 'foreign' || r.status === 'no-reading' ? 'opacity-60' : ''}`}
          data-testid={`text2voice-song-row-${r.instanceId}`}
        >
          <div className="flex items-center gap-1.5">
            <span className="text-sas-text font-medium capitalize">{r.label}</span>
            <span className="text-[9px] text-sas-muted">
              {r.bars} bar{r.bars === 1 ? '' : 's'}
              {r.budget ? ` · ${r.budget}` : ''}
            </span>
            {r.current && <span className="text-[9px] text-sas-accent">← this scene</span>}
            {r.stale && <span className="text-[9px] text-yellow-400" title="Sung before its words changed: press Sing in its scene">stale take</span>}
          </div>
          {r.status === 'repeat' ? (
            <div className="text-[9px] text-sas-muted italic">repeats {r.repeats}</div>
          ) : r.reason ? (
            <div className="text-[9px] text-sas-muted italic" data-testid={`text2voice-song-row-reason-${r.instanceId}`}>
              skipped: {r.reason}
            </div>
          ) : r.lines.length > 0 ? (
            <div className="text-[10px] text-sas-text/80 italic leading-snug">{r.lines.join(' / ')}</div>
          ) : (
            <div className="text-[9px] text-sas-muted">no words yet</div>
          )}
        </div>
      ))}
    </div>
  );
}

export default SongSheetView;
