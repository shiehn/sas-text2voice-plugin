import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';
import { MIN_SLOT_BEATS } from '../distribute';
import {
  applyBreathGuard,
  breathLimitsForBpm,
  detectPhrases,
  BREATH_GAP_SEC,
  MAX_BREATH_SEC,
} from '../phrases';
import { syllableWordSpans } from '../syllables';

const slot = (startBeat: number, durationBeats: number): PluginMidiNote => ({
  pitch: 62,
  startBeat,
  durationBeats,
  velocity: 90,
});

/** Contiguous slots from a shape spec: [dur, dur, GAP, dur, ...]. */
function timeline(parts: Array<number | 'gap'>, gapBeats = 1): PluginMidiNote[] {
  const out: PluginMidiNote[] = [];
  let t = 0;
  for (const p of parts) {
    if (p === 'gap') {
      t += gapBeats;
    } else {
      out.push(slot(t, p));
      t += p;
    }
  }
  return out;
}

describe('detectPhrases', () => {
  it('splits at time gaps and reports each span and its trailing silence', () => {
    const slots = timeline([1, 1, 'gap', 1, 1], 2);
    const phrases = detectPhrases(slots, 8);
    expect(phrases).toHaveLength(2);
    expect(phrases[0]).toMatchObject({ startSlot: 0, endSlot: 2, startBeat: 0, endBeat: 2, gapBeats: 2, boundary: 'rest' });
    // Scene is 8 beats; the second span ends at 6 → 2 beats of tail silence.
    expect(phrases[1]).toMatchObject({ startSlot: 2, endSlot: 4, endBeat: 6, gapBeats: 2, boundary: 'rest' });
  });

  it('treats one unbroken line as a single phrase ending at the scene tail', () => {
    const phrases = detectPhrases(timeline([1, 1, 1, 1]), 4);
    expect(phrases).toHaveLength(1);
    expect(phrases[0].gapBeats).toBe(0);
  });

  it('tags carved boundaries as breath, composed ones as rest', () => {
    const slots = timeline([1, 1, 'gap', 1, 1], 2);
    // Pretend the guard carved after slot 0.
    slots[0] = { ...slots[0], durationBeats: 0.8 };
    const phrases = detectPhrases(slots, 8, new Set([0]));
    expect(phrases.map((p) => p.boundary)).toEqual(['breath', 'rest', 'rest']);
  });

  it('returns nothing for an empty timeline', () => {
    expect(detectPhrases([], 8)).toEqual([]);
  });
});

describe('applyBreathGuard', () => {
  it('carves INSIDE an over-long run, not just at its end', () => {
    // 10 beats of continuous singing with a 4-beat lung: gaps must appear
    // mid-run so no remaining stretch exceeds the limit.
    const slots = timeline([2, 2, 2, 2, 2]);
    const { slots: out, carved, breathAfterSlot } = applyBreathGuard(slots, 4, 0.5);
    expect(carved).toBeGreaterThanOrEqual(2);
    // Verify the RESULT property: no continuous stretch exceeds the limit.
    const phrases = detectPhrases(out, 10, breathAfterSlot);
    for (const p of phrases) {
      expect(p.endBeat - p.startBeat).toBeLessThanOrEqual(4 + 1e-9);
    }
  });

  it('changes ONLY durations — count, order and starts survive', () => {
    const slots = timeline([2, 2, 2, 2, 2]);
    const { slots: out } = applyBreathGuard(slots, 4, 0.5);
    expect(out).toHaveLength(slots.length);
    out.forEach((s, i) => {
      expect(s.startBeat).toBe(slots[i].startBeat);
      expect(s.durationBeats).toBeLessThanOrEqual(slots[i].durationBeats);
      expect(s.durationBeats).toBeGreaterThanOrEqual(MIN_SLOT_BEATS - 1e-9);
    });
  });

  it('leaves runs inside the limit untouched', () => {
    const slots = timeline([1, 1, 'gap', 1, 1], 1);
    const { slots: out, carved } = applyBreathGuard(slots, 4, 0.5);
    expect(carved).toBe(0);
    expect(out).toEqual(slots);
  });

  it('resets its accumulator at composed rests', () => {
    // Two 3-beat runs separated by a rest, 4-beat lung: neither run exceeds
    // the limit on its own, so nothing is carved even though 6 > 4 in total.
    const slots = timeline([1.5, 1.5, 'gap', 1.5, 1.5], 1);
    expect(applyBreathGuard(slots, 4, 0.5).carved).toBe(0);
  });

  it('falls back to the previous slot when the current one cannot give', () => {
    // A long slot followed by a floor-width one that crosses the limit.
    const slots = [slot(0, 4), slot(4, MIN_SLOT_BEATS)];
    const { carved, breathAfterSlot, slots: out } = applyBreathGuard(slots, 4, 0.5);
    expect(carved).toBe(1);
    expect(breathAfterSlot.has(0)).toBe(true);
    expect(out[1].durationBeats).toBe(MIN_SLOT_BEATS); // untouched
  });

  it('counts runs it cannot carve instead of crushing slots below the floor', () => {
    const slots = [slot(0, MIN_SLOT_BEATS), slot(MIN_SLOT_BEATS, MIN_SLOT_BEATS)];
    const { carved, uncarvable } = applyBreathGuard(slots, 0.1, 0.5);
    expect(carved).toBe(0);
    expect(uncarvable).toBeGreaterThan(0);
  });
});

describe('breathLimitsForBpm', () => {
  it('converts the second-domain limits to beats at the scene tempo', () => {
    const { maxBreathBeats, breathBeats } = breathLimitsForBpm(120);
    expect(maxBreathBeats).toBeCloseTo(MAX_BREATH_SEC * 2);
    expect(breathBeats).toBeCloseTo(BREATH_GAP_SEC * 2);
  });
});

describe('syllableWordSpans', () => {
  it('recovers word boundaries from a validated split', () => {
    const spans = syllableWordSpans('all matter observed', ['all', 'mat', 'ter', 'ob', 'served']);
    expect(spans).toEqual([
      { word: 'all', startSyl: 0, endSyl: 1 },
      { word: 'matter', startSyl: 1, endSyl: 3 },
      { word: 'observed', startSyl: 3, endSyl: 5 },
    ]);
  });

  it('ignores case and punctuation, like the validator does', () => {
    const spans = syllableWordSpans('The Universe,', ['the', 'u', 'ni', 'verse']);
    expect(spans).toHaveLength(2);
    expect(spans[1]).toMatchObject({ startSyl: 1, endSyl: 4 });
  });

  it('stops at a disagreement instead of guessing onward', () => {
    const spans = syllableWordSpans('all matter', ['all', 'mat']);
    expect(spans).toEqual([{ word: 'all', startSyl: 0, endSyl: 1 }]);
  });
});
