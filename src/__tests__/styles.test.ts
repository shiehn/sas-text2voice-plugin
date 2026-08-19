import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';
import { buildAdlibEchoes } from '../adlib';
import { assignSyllables } from '../harmony-styles';
import { detectPhrases } from '../phrases';
import {
  configMatchesStyle,
  laneMixFor,
  laneRolesFor,
  roleLabel,
  styleAxes,
  STYLE_IDS,
  STYLES,
} from '../styles';
import { syllableWordSpans } from '../syllables';

const slot = (pitch: number, startBeat: number, durationBeats = 0.5): PluginMidiNote => ({
  pitch,
  startBeat,
  durationBeats,
  velocity: 90,
});

describe('the style table', () => {
  it('every style resolves to concrete, normalizable axes', () => {
    for (const id of STYLE_IDS) {
      const axes = styleAxes(id);
      expect([1, 2, 3, 4]).toContain(axes.notesPerBeat);
      expect(configMatchesStyle(id, axes)).toBe(true);
    }
  });

  it('detects Custom the moment any axis diverges', () => {
    const axes = styleAxes('choir');
    expect(configMatchesStyle('choir', { ...axes, notesPerBeat: 4 })).toBe(false);
    expect(configMatchesStyle('choir', { ...axes, delivery: 'canon' })).toBe(false);
  });

  it('trap is the triplet-flow style with the adlib lane', () => {
    expect(STYLES.trap.notesPerBeat).toBe(3);
    expect(STYLES.trap.adlibLane).toBe(true);
  });
});

describe('laneRolesFor', () => {
  it('always leads with lane 0 and collapses a single voice to lead', () => {
    expect(laneRolesFor('trap', 'unison', 1)).toEqual(['lead']);
    expect(laneRolesFor(null, 'choral', 3)[0]).toBe('lead');
  });

  it('puts the adlib lane LAST so shrinking the voice count sheds it first', () => {
    expect(laneRolesFor('trap', 'unison', 4)).toEqual(['lead', 'group', 'group', 'adlib']);
    expect(laneRolesFor('trap', 'unison', 2)).toEqual(['lead', 'adlib']);
  });

  it('marks drone-harmony lanes as drone regardless of style', () => {
    expect(laneRolesFor('chant', 'drone', 3)).toEqual(['lead', 'drone', 'drone']);
  });

  it('derives plain harmony lanes as group', () => {
    expect(laneRolesFor('choir', 'choral', 3)).toEqual(['lead', 'group', 'group']);
    expect(laneRolesFor(null, 'unison', 2)).toEqual(['lead', 'group']);
  });
});

describe('laneMixFor', () => {
  it('keeps the lead centered at full volume', () => {
    expect(laneMixFor('lead', 0)).toEqual({ volume: 1.0, pan: 0 });
  });

  it('pushes adlib lanes quiet and wide', () => {
    const mix = laneMixFor('adlib', 3);
    expect(mix.volume).toBeLessThan(0.7);
    expect(Math.abs(mix.pan)).toBeGreaterThanOrEqual(0.5);
  });

  it('labels roles for the voice rows', () => {
    expect(roleLabel('lead', 0)).toBe('lead');
    expect(roleLabel('adlib', 3)).toBe('adlib');
    expect(roleLabel('group', 2)).toBe('harmony 2');
  });
});

describe('tagteam delivery', () => {
  // Two phrases: "put your left leg" | rest | "down down" — the shout word of
  // phrase 1 is "leg" (slot 3), of phrase 2 "down" (slots 4-5 loop the word).
  const SYLLABLES = ['put', 'your', 'left', 'leg', 'down', 'down'];
  const lead = [
    slot(62, 0),
    slot(62, 0.5),
    slot(64, 1),
    slot(65, 1.5),
    slot(60, 3),
    slot(60, 3.5),
  ];
  const phrases = detectPhrases(lead, 8);
  const wordSpans = syllableWordSpans('put your left leg down down', SYLLABLES);
  const voices: Array<Array<PluginMidiNote | null>> = [lead, [...lead], [...lead]];

  it('the lead carries the whole line', () => {
    const out = assignSyllables(voices, SYLLABLES.length, 'tagteam', {
      phrases,
      wordSpans,
      shoutLanes: [false, true, true],
    });
    expect(out[0].map((a) => a.syllableIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('the crew shouts ONLY each phrase-final word', () => {
    const out = assignSyllables(voices, SYLLABLES.length, 'tagteam', {
      phrases,
      wordSpans,
      shoutLanes: [false, true, true],
    });
    // "leg" is slot 3; the second phrase's final word covers its tail slot(s).
    expect(out[1][3].syllableIndex).toBe(3);
    expect(out[1][0].syllableIndex).toBeNull();
    expect(out[1][1].syllableIndex).toBeNull();
    expect(out[1][2].syllableIndex).toBeNull();
    // Phrase 2 (slots 4-5, 2 slots → clamp = 1 shout slot): the last one.
    expect(out[1][4].syllableIndex).toBeNull();
    expect(out[1][5].syllableIndex).toBe(5);
    // Both crew voices shout the same slots — that is the unison punch.
    expect(out[2][3].syllableIndex).toBe(3);
  });

  it('a resting crew member still shouts, on the lead note', () => {
    const resting: Array<PluginMidiNote | null> = lead.map(() => null);
    const out = assignSyllables([lead, resting], SYLLABLES.length, 'tagteam', {
      phrases,
      wordSpans,
      shoutLanes: [false, true],
    });
    expect(out[1][3].syllableIndex).toBe(3);
    expect(out[1][3].note?.pitch).toBe(lead[3].pitch);
  });

  it('carved breath boundaries never take a shout', () => {
    const breathPhrases = detectPhrases(lead, 8, new Set([1]));
    const out = assignSyllables(voices, SYLLABLES.length, 'tagteam', {
      phrases: breathPhrases,
      wordSpans,
      shoutLanes: [false, true, true],
    });
    // The breath after slot 1 ends a span whose final word ("your") must NOT
    // be shouted; the rest-final words still are.
    expect(out[1][1].syllableIndex).toBeNull();
    expect(out[1][3].syllableIndex).toBe(3);
  });
});

describe('buildAdlibEchoes', () => {
  const SYLLABLES = ['ver', 'sa', 'ce', 'gold'];
  const lead = [slot(62, 0), slot(62, 0.5), slot(64, 1), slot(65, 4)];
  const phrases = detectPhrases(lead, 8); // phrase 1 ends at 1.5 (gap 2.5), phrase 2 at 4.5 (tail 3.5)
  const wordSpans = syllableWordSpans('versace gold', SYLLABLES);

  it('echoes each rest-phrase final word into its gap, on the lead pitch', () => {
    const echoes = buildAdlibEchoes(lead, phrases, wordSpans, SYLLABLES.length);
    // Phrase 1's final word is "versace" (syllables 0-2) → 3 echo entries;
    // phrase 2's is "gold" → 1 entry.
    expect(echoes).toHaveLength(4);
    const first = echoes[0];
    expect(first.syllableIndex).toBe(0);
    expect(first.note!.pitch).toBe(64); // the phrase's last slot pitch
    // Placed INSIDE the gap after phrase 1 (ends at 1.5, next starts 4).
    expect(first.note!.startBeat).toBeGreaterThan(1.5);
    const lastOfFirstWord = echoes[2];
    expect(lastOfFirstWord.note!.startBeat + lastOfFirstWord.note!.durationBeats).toBeLessThanOrEqual(4);
  });

  it('skips gaps too short to hold an echo', () => {
    const tight = [slot(62, 0, 1), slot(64, 1.2, 1)]; // 0.2-beat gap
    const tightPhrases = detectPhrases(tight, 2.4);
    const echoes = buildAdlibEchoes(tight, tightPhrases, syllableWordSpans('one two', ['one', 'two']), 2);
    expect(echoes.filter((e) => e.note!.startBeat < 1.2)).toHaveLength(0);
  });

  it('applies the loop-fill modulo before the word lookup', () => {
    // 6 slots, 4 syllables: slot 5 sings syllable 1 ("sa" of versace)... the
    // final slot of the one phrase is slot 5 → syllable 5 % 4 = 1 → word
    // "versace". The echo must be that word, not an out-of-range index.
    const looped = [slot(62, 0), slot(62, 0.5), slot(62, 1), slot(62, 1.5), slot(62, 2), slot(64, 2.5)];
    const echoes = buildAdlibEchoes(looped, detectPhrases(looped, 8), wordSpans, SYLLABLES.length);
    expect(echoes.length).toBeGreaterThan(0);
    echoes.forEach((e) => expect(e.syllableIndex).toBeLessThan(SYLLABLES.length));
  });
});
