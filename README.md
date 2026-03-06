# realtime-transcription-demo

A Databricks App for near real-time speech-to-text using **[WhisperLive](https://github.com/collabora/WhisperLive)**.

Built with [apx](https://github.com/databricks-solutions/apx).

## Tech Stack

- **Backend** — Python, FastAPI, WebSocket endpoint for WhisperLive (subprocess + proxy)
- **Frontend** — React, TanStack Router, shadcn/ui; shared mic capture at 16 kHz PCM and WebSocket client
- **Engine** — WhisperLive (faster_whisper, tiny model, CPU-friendly)

## Quick Start

### Development

```bash
apx dev start
```

Then open the app, allow microphone access, and click Start to begin transcribing with WhisperLive.

In development, the frontend tries the app server first, then **automatically** tries the backend on common ports (8127, 8236, 8000, 8080) so WebSocket usually works without extra config. If your backend runs on a different port, set it explicitly:

```bash
VITE_BACKEND_WS_URL=http://localhost:YOUR_PORT apx dev start
```

Or in a `.env` or `.env.local` in the UI package: `VITE_BACKEND_WS_URL=http://localhost:YOUR_PORT`. Use `apx dev status` to see the backend port.

### Logs and status

```bash
apx dev logs -f
apx dev status
apx dev stop
```

### Code quality

```bash
apx dev check
```

## Build and deployment

Build for production:

```bash
apx build
```

Deploy to Databricks using the **aws-sandbox** profile:

```bash
databricks bundle deploy -p aws-sandbox
```

## WhisperLive support

WhisperLive is installed as a regular project dependency. If your environment is missing native build tools or `pkg_resources`, use the steps below and then run `uv sync`:

1. **Fix `pkg_resources`** (setuptools 82+ removed it; needed to build `openai-whisper`):

   ```bash
   uv pip install "setuptools>=70,<82" hatchling editables
   ```

2. **Install PortAudio** (needed for `pyaudio` / whisper-live):
   - **macOS:** `brew install portaudio`
   - **Linux:** `sudo apt-get install portaudio19-dev`

3. **Sync dependencies:**

   ```bash
   uv sync --no-build-isolation
   ```

If you still see `ModuleNotFoundError: No module named 'pkg_resources'`, ensure step 1 is done and use `--no-build-isolation` in step 3.

**If you're using pip** (not uv), pip’s build isolation also uses a setuptools that lacks `pkg_resources`. Use an environment with setuptools &lt; 82, then disable build isolation:

```bash
pip install "setuptools>=70,<82"
pip install whisper-live --no-build-isolation
```

On macOS install PortAudio first: `brew install portaudio`.

The backend uses **CPU-friendly small models** (e.g. `tiny`) by default. WhisperLive pulls in PyTorch and faster_whisper; expect a larger image and longer cold start when dependencies are installed.

### Why does the app say "whisper-live not installed"?

The app reports that when `import whisper_live` fails at startup. Common causes:

1. **Dependencies not synced** — Run `uv sync` (with the setup steps above).
2. **PortAudio missing** — PyAudio (used by whisper-live) needs the PortAudio system library. On macOS: `brew install portaudio`. Without it, the build often fails with `portaudio.h: No such file or directory`.
3. **Build failure (pkg_resources)** — If you see `ModuleNotFoundError: No module named 'pkg_resources'` during install, do step 1 in the list above (setuptools &lt; 82) and use `--no-build-isolation` when running `uv sync`.
4. **Install cancelled or very slow** — The transcribe extra pulls in PyTorch and many large packages; the first install can take several minutes. Let it finish.

**Check if it’s installed:** From the project root, run:

```bash
uv run python -c "import whisper_live; print('whisper-live OK')"
```

If that prints `whisper-live OK`, restart the app (`apx dev restart`); the WhisperLive server should then start on 127.0.0.1:9090.

---

<p align="center">Built with <a href="https://github.com/databricks-solutions/apx">apx</a></p>
