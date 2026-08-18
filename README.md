# @signalsandsorcery/text2voice-generator

Paste prose. Hear it sung by machines.

An LLM quotes a phrase out of the text you supply, sets it over the scene's key
and chord progression on a syllable grid, and then every syllable is spoken by a
system speech voice and its pitch **forced** to the note it was given. The
speaker's mouth is kept; their intonation is thrown away. Realism is not the
goal — this is a deliberately unnatural vocal instrument.

## How it works

```
  paste text
      │
      │  ONE schema-forced model call (submit_text2voice)
      ▼
  phrase (quoted verbatim) + syllable split + shared rhythm + syllable grid
      │
      ├─ compose.ts      grid ──▶ pitches, in-scale and monophonic by construction
      ├─ harmony-styles  derived styles fan out from the lead; composed styles come whole
      ├─ harmony-styles  delivery deals syllables out: unison / canon / hocket
      └─ syllables.ts    strict 1:1 syllables ↔ notes
      │
      ▼
  host.renderVocalLine(…)  per voice
      │   say/SAPI speaks each syllable → WORLD replaces F0 with the note
      ▼
  one WAV per voice → createTrack + writeAudioClip   (role: vocals, spawned muted)
```

Rendering is **offline**, not real-time. That is deliberate: a rendered clip is
an ordinary audio track, so freeze, export and the arranger all behave normally.

## The three intent axes

**Harmony** — how the voices relate in pitch.

| Style | |
|---|---|
| `unison` | Every voice on the same line, spread across octaves — one enormous voice. |
| `choral` | Block harmony; all voices move together on the same syllables. |
| `organum` | Parallel fifths and octaves under the lead. Medieval, hollow, archaic. |
| `drone` | The lead carries the text over voices sustaining the tonic and fifth. |
| `counterpoint` | Independent lines — the words drift apart as the harmony holds. |
| `cluster` | Voices stacked in tight seconds. Harmonically unstable by design. |

`unison`, `organum` and `drone` are **derived mechanically** from the lead line,
so they cost no extra model work and are perfectly reproducible. Only `choral`,
`counterpoint` and `cluster` ask the model to compose several lines at once.

**Delivery** — how the text is spread across the voices.

| Mode | |
|---|---|
| `unison` | Same words, same moment. Most intelligible. |
| `canon` | Voices enter one after another on the same text, overlapping themselves. |
| `hocket` | Consecutive syllables bounce between voices — one line split across mouths. |

**Character** — what each voice sounds like, as WORLD parameters (formant warp,
aperiodicity, F0 jitter). Several characters deliberately *spread* across the
section rather than applying one setting to every lane: `choir` fans the formant
warp from large-headed to small so one melody is sung by bodies of different
sizes.

`natural` · `choir` · `ghost` · `machine` · `menagerie`

## The composition cache

Character and system voice are **render-time** settings: changing either replays
the cached composition with no model call. Only changing the **text**, harmony,
delivery, voice count, or the scene's tempo/length forces a fresh composition.
Auditioning voices is therefore free and fast.

## Requirements

- Host **3.4.0 or newer** — `renderVocalLine` and `listSystemVoices` are optional
  host capabilities and the plugin feature-detects them, reporting clearly rather
  than failing obscurely on an older app.
- The speech voices are the operating system's own (macOS `say`, Windows SAPI).
  Nothing is bundled and nothing is fetched, so **the available voices differ per
  platform** — they are enumerated at runtime and never hardcoded.
- The scene must have a key and a tempo. Chords are used when present.

## Notes and limits

- A 16-bar scene holds roughly 128 syllables per voice at eighth notes, so one
  scene is a sentence, not an article. The model is asked to pick a phrase that
  fits rather than to compress the whole text.
- The phrase is validated against your text before anything is rendered: invented
  words are rejected. The model quotes; it does not write lyrics.
- Surplus notes are absorbed into their predecessor, so a syllable is *held*
  longer. This is a sustain, not a true melisma — the renderer holds one pitch
  per syllable, so a syllable cannot move in pitch while sounding.
- A voice that is almost entirely unvoiced (macOS "Whisper") carries no melody
  and renders as breath. The panel reports this rather than hiding it.

## Development

```sh
npm install
npm test          # jest — pure logic: harmony, syllables, composition, render specs
npm run typecheck
npm run build     # REQUIRED before the app picks up changes — it consumes dist/
```

The panel is a thin `GeneratorPanelAdapter` over the SDK's panel-core, built to
the ensemble plugin's shape. See `src/silent-sound.ts` for the one place that
fights the core: an audio family has no instrument or preset, but panel-core
requires a sound and shuffle adapter and dereferences `sound` unguarded.

## License

MIT
