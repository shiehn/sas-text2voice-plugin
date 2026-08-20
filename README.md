# @signalsandsorcery/text2voice-generator

Paste prose — or just a topic — and hear it sung, chanted, or rapped by machines.

**Styles**: Choir · Chant · Tag-Team Rap (the crew shouts each phrase-final
word) · Trap (triplet flow with an adlib lane echoing into the gaps) ·
Sprechgesang. A style is a preset over the axes, applied in one write and
freely overridable ("Custom").

**Sources**: Quote my text (a phrase is quoted verbatim and sung) · Write
lyrics (original lines about a topic, fitted to the melody's phrases with an
AABB/ABAB rhyme scheme landing on phrase-final notes) · Sing an existing track
(any MIDI track in the scene becomes the lead line — monophonized, top note
wins — at zero model cost).

**Pitch treatments** (host ≥ 3.5.0): locked (sung) · natural (spoken, the
speech contour kept) · contour (the shape survives, recentered on the note —
"rap but audibly in key"). Breath is enforced: nobody sings longer than a
lungful, catch-breath gaps are carved mid-line, and breathy styles inhale
audibly (a reversed exhale) before phrases.

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

## How the words sit on the melody

The melody is **not** one note per syllable. It supplies the pitch contour and,
just as importantly, the **breathing** — and then the phrase is spread across it
at a steady subdivision:

```
melody:    quarter        (rest)        half
sung as:   2 eighths      (breath)      4 eighths
```

One uniform rate, so it reads as a flowing line rather than a metronome, while
long notes still linger and rests still breathe.

That makes note length a **text-density** control:

| | |
|---|---|
| long note | many syllables recited on one pitch — a chant tone |
| short note | a single syllable |
| rest | a breath; the words pause and continue after it |

Holding a run of text on one pitch and then moving at the cadence is the psalm-tone
move, and it is the most characteristic sound this instrument makes. The prompt
asks for it deliberately.

**Pace** (Slow / Medium / Fast) sets the subdivision — quarters, eighths or
sixteenths. If a phrase cannot fit even at the fastest pace, the overflow is
dropped and reported rather than crushed into inaudible clicks.

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

## The expression engine (Realism dial)

Every style carries an *expression pack* — what a throat does that a
synthesizer doesn't — and the **Realism dial** (next to the style picker)
scales the whole pack from 0 (the pure machine lock, exactly the original
renderer) to 1 (full expression):

- **Scoops** into phrase entries, **legato glides** between adjacent notes,
  and a **retune time-constant** that runs the whole spectrum from natural
  singer to hard autotune (trap's pack sits at the T-Pain end on purpose).
- **Vibrato** that onsets late into sustained notes, with a loudness wobble
  coupled to the pitch wobble; slow seeded **intonation drift**.
- **Phrase endings fall and aspirate**; long entries swell.
- **Vowels land on the beat** (consonants lean in early) and long notes
  stretch the vowel, never the consonants.
- **Whole-word synthesis**: consecutive syllables of one word are spoken as
  one utterance and sliced at f0 gaps, so words stop sounding spelled out.
- **A singer's formant** (~2.9 kHz resonance) and brightness tilt, per style.
- **Humanize**: every lane gets its own seed — pitch, timing and vibrato
  phase decorrelate, which is the difference between one voice cloned N
  times and a choir. Identical seeds render bit-identically.
- **Melisma**: the composer may extend an important vowel through a short
  run of notes (marked per note, folded into one indivisible syllable slot).
- **Stress**: the model marks lexical stress; stressed syllables lean in,
  unstressed back off.

Changing the dial re-renders voices without recomposing. All of it rides
`sas-audio-tool vox` spec v3; on an older host the fields are simply absent
and the voices render as before.

## The melody survives

Composing the music is by far the slowest step, so the **melody and the words
are cached separately** on the anchor. Editing the text does not throw the music
away.

Pressing Generate takes the cheapest sufficient path, and the button says which
one it will be before you press it:

| Button | What happens | Cost |
|---|---|---|
| **Re-render** | Nothing that matters changed — re-renders the existing music and words. | no model call |
| **Re-word** | The melody is kept; a new phrase of exactly the right length is found in your text. | one small call |
| **Compose** | New music and new words. | one full call |

So:

- **Change the character or the speech voice** → Re-render. Auditioning voices is free.
- **Replace the text** → Re-word. The melody you liked stays exactly as it was; only
  the words on it change. The caption reads *"melody kept"*.
- **Change harmony, delivery, voice count, tempo or bar count** → Compose. These
  define the notes, so the melody genuinely cannot survive them.
- **Want different music for the same text?** The **♪+** button asks for it
  explicitly, so you never lose a melody as a side effect of editing something else.

A re-worded phrase is reconciled against the existing notes: a short phrase holds
its syllables longer, a long one is trimmed, and the panel says how many
syllables did not fit.

## Requirements

- Host **3.4.0 or newer** — `renderVocalLine` and `listSystemVoices` are optional
  host capabilities and the plugin feature-detects them, reporting clearly rather
  than failing obscurely on an older app.
- The speech voices are the operating system's own (macOS `say`, Windows SAPI).
  Nothing is bundled and nothing is fetched, so **the available voices differ per
  platform** — they are enumerated at runtime and never hardcoded.
- The scene must have a key and a tempo. Chords are used when present.

## Standard track features

- **Track FX** works normally — the drawer's FX tab is on the track row, so
  third-party VST3/AU inserts behave exactly as on any other track.
- **Bus sidechain and motion** are enabled: the panel's summed output can duck
  against the scene's kicks and take tempo-locked filter motion.
- **Freeze does not apply, by design.** A Text2Voice lane already *is* a rendered
  stem, so the host declines freeze on audio rows and the ❄ badge does not render.
  There is nothing to bounce that has not been bounced.

## Notes and limits

- A 16-bar scene holds roughly 128 syllables per voice at eighth notes, so one
  scene is a sentence, not an article. The model is asked to pick a phrase that
  fits rather than to compress the whole text.
- The phrase is validated against your text before anything is rendered: invented
  words are rejected. The model quotes; it does not write lyrics.
- When the phrase is shorter than the melody, the TEXT LOOPS to fill it (a
  mantra) — every note sounds. When it is longer, the overflow is dropped from
  the end and reported.
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
