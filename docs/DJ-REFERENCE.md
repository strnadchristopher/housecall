# Steve Forever local speech and prior art

Read-only prior art: `vendor-ref/steve-forever` at commit `46eadc10b0c02ccaad3db245af55875493ed75d8` from `strnadchristopher/steve-forever`. No vendor code or media was changed, executed, or imported. `main.py` uses command objects in a shared queue, converts Spotify metadata into a YouTube search, and inserts commentary after tracks. `gpt.py` used a hosted text completion and hosted FakeYou voice synthesis with polling; Chriscord replaces both with the specified local Switchboard and a local speech interface. Its bundled speech recordings were not treated as Christopher's supplied reference or used to clone a voice.

The intended voice is a synthetic Steve Harvey-inspired performance for Christopher's private group, never public and never represented as a real endorsement or live appearance. Until Christopher supplies reference audio, use the clearly identified **generic eSpeak placeholder**. The Rust `Tts` trait is object-safe and pluggable: `PlaceholderTts` executes local `espeak-ng`; `CloneTts` executes an operator-owned local wrapper. No hosted clone API is implemented. Both pass arguments directly without a shell, validate WAV files, suppress potentially sensitive subprocess stderr, kill timed-out children and bound captured output.

## Exact reference and installation contract

Supply one clean reference WAV: 6–30 seconds (aim for 10–20), one speaker only, natural conversational delivery, no music/crowd/other voices, mono PCM signed 16-bit at 24,000 Hz. Do not include a compilation, applause or long silence. Keep the original and generated files on the private server. The pipeline does not fetch reference clips. Put it outside the repository, for example `/run/secrets/dj-reference.wav`, read-only in the worker.

An operator may normalize a **supplied** clip locally:

```sh
ffmpeg -i supplied-reference.wav -ac 1 -ar 24000 -c:a pcm_s16le reference.wav
```

`crates/activities/tools/xtts_cpu.py` is a concrete offline XTTS-v2 inference wrapper. It validates the reference format/duration, loads preinstalled `config.json`, `model.pth`, `vocab.json` and `speakers_xtts.pth`, computes reference conditioning, and writes a 24 kHz WAV. Supply an isolated Python environment with a mutually compatible `coqui-tts`, CPU PyTorch and torchaudio installation; install and pin those dependencies and model hashes before production. This environment/model is **not installed or runtime-verified** in this sprint evidence. XTTS weights use the Coqui Public Model License and need operator review. The adapter follows the [official XTTS manual inference API](https://docs.coqui.ai/en/latest/models/xtts.html).

Example after operator installation:

```sh
DJ_REFERENCE_WAV=/run/secrets/dj-reference.wav
DJ_XTTS_MODEL_DIR=/models/xtts-v2
/path/to/python-env/bin/python crates/activities/tools/xtts_cpu.py \
  --reference "$DJ_REFERENCE_WAV" --model-dir "$DJ_XTTS_MODEL_DIR" \
  --output /private-cache/banter.wav --text 'Here comes the next track.'
```

Configure `CloneTts.executable` as a local launcher using that Python environment, `reference_wav` as the supplied WAV, and `model_dir` as the installed weights directory. The wrapper disables CUDA, runs at most two CPU inference threads, sets offline model flags and never accesses Archie. Deploy the clone worker without networking for a stronger enforcement boundary. Rust limits generation to 180 seconds and validates the resulting WAV. No GPU is required, but CPU real-time performance is unmeasured; pre-generate short links during the preceding song and fall back to the generic local voice if generation misses its deadline. That scheduling/fallback worker remains to be integrated.

Evidence currently covers source compilation and mocked provider protocol tests. Reference-based cloning and subjective voice similarity cannot be marked complete until the supplied clip, local model and real inference have been tested. Python syntax validation is recorded separately; it is not inference evidence.
