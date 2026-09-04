import { useCallback, useRef, useState } from "react";

export type TranscriptionEngine = "whisperlive";

export interface TranscriptSegment {
  text: string;
  isFinal: boolean;
  timestamp?: number;
}

export interface TranscriptionMetrics {
  timeToFirstTokenMs: number | null;
  segmentCount: number;
  lastSegmentAt: number | null;
}

export interface TranscriptionLogEntry {
  message: string;
  timestamp: number;
  level: "info" | "error";
}

/**
 * A single WhisperLive segment. The server sends the last N completed segments
 * plus the current in-progress (incomplete) one on every update. `start`/`end`
 * are stable string timestamps (seconds, 3dp); `completed` marks finalized text.
 */
interface WhisperLiveSegment {
  start?: string;
  end?: string;
  text?: string;
  completed?: boolean;
}

interface WhisperLiveMessage {
  text?: string;
  error?: string;
  status?: string;
  message?: string;
  segments?: WhisperLiveSegment[];
}

const SAMPLE_RATE = 16000;
const CHUNK_MS = 100;
const CHUNK_SAMPLES = (SAMPLE_RATE * CHUNK_MS) / 1000;

const DEBUG = import.meta.env.DEV;
function log(msg: string, ...args: unknown[]) {
  if (DEBUG) console.log(`[transcribe] ${msg}`, ...args);
}

/**
 * Linear-interpolation downsampler from an arbitrary input rate to SAMPLE_RATE.
 * Browsers are not guaranteed to honor the requested AudioContext sampleRate,
 * so we must resample to 16 kHz before tagging the PCM as 16 kHz. A no-op when
 * the context already runs at the target rate.
 */
function resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === SAMPLE_RATE) return input;
  const ratio = inputRate / SAMPLE_RATE;
  const outLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const a = input[idx];
    const b = idx + 1 < input.length ? input[idx + 1] : a;
    output[i] = a + (b - a) * frac;
  }
  return output;
}

const WS_OPEN_TIMEOUT_MS = 10_000;
const WS_TRY_TIMEOUT_MS = 3_000;
const DEV_BACKEND_PORTS = [8949, 8703, 8841, 8705, 8127, 8236, 8000, 8080];

function getWebSocketPath(): string {
  return "/api/transcribe/whisperlive";
}

async function getWebSocketUrls(): Promise<string[]> {
  const path = getWebSocketPath();
  const devBase = import.meta.env.VITE_BACKEND_WS_URL;
  if (devBase) {
    const base = String(devBase).trim().replace(/^http/, "ws");
    return [`${base.replace(/\/$/, "")}${path}`];
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  const sameOrigin = `${proto}//${host}${path}`;
  if (
    import.meta.env.DEV &&
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1" ||
      window.location.hostname === "::1")
  ) {
    const urls: string[] = [];
    try {
      const response = await fetch("/api/transcribe/ws-base");
      if (response.ok) {
        const data = (await response.json()) as { ws_base?: string };
        if (data.ws_base) {
          urls.push(`${String(data.ws_base).replace(/\/$/, "")}${path}`);
        }
      }
    } catch {
      // best effort; fall back to static candidates
    }

    const localHosts = [window.location.hostname, "localhost", "127.0.0.1"];
    const localPort = Number.parseInt(window.location.port, 10);
    const candidatePorts = Number.isFinite(localPort) ? [localPort, ...DEV_BACKEND_PORTS] : DEV_BACKEND_PORTS;
    const dedup = new Set<string>();
    for (const u of urls) dedup.add(u);
    for (const h of localHosts) {
      for (const p of candidatePorts) {
        dedup.add(`ws://${h}:${p}${path}`);
      }
    }
    return Array.from(dedup);
  }
  return [sameOrigin];
}

export function useRealtimeTranscription() {
  const [transcript, setTranscript] = useState<string>("");
  const [interim, setInterim] = useState<string>("");
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [logs, setLogs] = useState<TranscriptionLogEntry[]>([]);
  const [metrics, setMetrics] = useState<TranscriptionMetrics>({
    timeToFirstTokenMs: null,
    segmentCount: 0,
    lastSegmentAt: null,
  });
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<AudioNode | null>(null);
  const startTimeRef = useRef<number>(0);
  const firstTokenTimeRef = useRef<number | null>(null);
  const isIntentionalStopRef = useRef(false);
  // Completed segments keyed by their (stable) start timestamp. Preserves text
  // even after a segment scrolls out of WhisperLive's send_last_n_segments window.
  const committedSegmentsRef = useRef<Map<string, string>>(new Map());

  const appendLog = useCallback(
    (message: string, level: "info" | "error" = "info") => {
      setLogs((prev) => [...prev.slice(-50), { message, level, timestamp: Date.now() }]);
    },
    [],
  );

  const stopRecording = useCallback(() => {
    isIntentionalStopRef.current = true;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.close();
    }
    wsRef.current = null;
    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch {
        // ignore
      }
      processorRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    const ctx = contextRef.current;
    if (ctx && ctx.state !== "closed") {
      ctx.close();
    }
    contextRef.current = null;
    setIsRecording(false);
    appendLog("Recording stopped");
  }, [appendLog]);

  const applySegments = useCallback(
    (incoming: WhisperLiveSegment[]) => {
      const committed = committedSegmentsRef.current;
      let interimText = "";
      let sawContent = false;
      incoming.forEach((seg, i) => {
        const text = (seg.text ?? "").trim();
        if (!text) return;
        sawContent = true;
        if (seg.completed) {
          // Key on the stable start timestamp so refinements replace, not duplicate.
          committed.set(seg.start ?? `pos-${i}`, text);
        } else {
          interimText = interimText ? `${interimText} ${text}` : text;
        }
      });
      if (!sawContent) return;

      // First token latency is only meaningful once audio has started flowing.
      if (startTimeRef.current > 0 && firstTokenTimeRef.current === null) {
        firstTokenTimeRef.current = Date.now();
      }

      const orderedCommitted = Array.from(committed.entries()).sort(
        (a, b) => Number.parseFloat(a[0]) - Number.parseFloat(b[0]),
      );
      const finalText = orderedCommitted.map(([, t]) => t).join(" ");

      setTranscript(finalText);
      setInterim(interimText);
      setSegments([
        ...orderedCommitted.map(([, t]) => ({ text: t, isFinal: true })),
        ...(interimText ? [{ text: interimText, isFinal: false }] : []),
      ]);
      setMetrics((m) => ({
        ...m,
        timeToFirstTokenMs:
          firstTokenTimeRef.current !== null && startTimeRef.current > 0
            ? firstTokenTimeRef.current - startTimeRef.current
            : m.timeToFirstTokenMs,
        // Count distinct real segments, not raw messages: WhisperLive re-sends the
        // rolling window plus the in-progress segment on every update.
        segmentCount: committed.size + (interimText ? 1 : 0),
        lastSegmentAt: Date.now(),
      }));

      // Detect the spoken "stop recording" command on the newest segment only,
      // so a stale earlier mention in the accumulated transcript can't re-trigger it.
      const latest = (incoming[incoming.length - 1]?.text ?? "").trim();
      if (/\bstop\s+recording\b/i.test(latest)) {
        appendLog("Detected spoken 'stop recording' command, ending session");
        stopRecording();
      }
    },
    [appendLog, stopRecording],
  );

  const startRecording = useCallback(async () => {
    try {
      isIntentionalStopRef.current = false;
      setError(null);
      setTranscript("");
      setInterim("");
      setSegments([]);
      setLogs([]);
      setMetrics({ timeToFirstTokenMs: null, segmentCount: 0, lastSegmentAt: null });
      firstTokenTimeRef.current = null;
      committedSegmentsRef.current = new Map();
      // Sentinel: the "clock" starts when the first audio chunk is actually sent,
      // so time-to-first-token excludes mic-permission and WS-connect latency.
      startTimeRef.current = 0;
      appendLog("Starting whisperlive transcription");

      log("requesting microphone");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      log("microphone granted", { tracks: stream.getTracks().length });
      appendLog("Microphone access granted");

      const context = new AudioContext({ sampleRate: SAMPLE_RATE });
      contextRef.current = context;
      if (context.state === "suspended") {
        log("AudioContext suspended at start, resuming");
        await context.resume();
      }
      log("AudioContext ready", { state: context.state, sampleRate: context.sampleRate });

      setIsRecording(true);

      const urls = await getWebSocketUrls();
      const tryTimeout = urls.length > 1 ? WS_TRY_TIMEOUT_MS : WS_OPEN_TIMEOUT_MS;

      const openWebSocket = (url: string): Promise<WebSocket> =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(url);
          const cleanup = () => {
            clearTimeout(tid);
            ws.onopen = null;
            ws.onclose = null;
            ws.onerror = null;
          };
          const tid = setTimeout(() => {
            cleanup();
            try {
              ws.close();
            } catch {
              // ignore
            }
            reject(new Error("timeout"));
          }, tryTimeout);
          ws.onopen = () => {
            cleanup();
            resolve(ws);
          };
          ws.onclose = () => {
            cleanup();
            reject(new Error("closed"));
          };
          ws.onerror = () => {
            cleanup();
            reject(new Error("error"));
          };
        });

      let ws: WebSocket | null = null;
      let lastErr: Error | null = null;
      for (const url of urls) {
        try {
          appendLog(`Connecting to ${url}`);
          ws = await openWebSocket(url);
          break;
        } catch (e) {
          lastErr = e instanceof Error ? e : new Error(String(e));
          continue;
        }
      }
      if (ws == null) {
        throw lastErr ?? new Error("Failed to connect");
      }
      log("WebSocket connected", { url: (ws as WebSocket).url });
      appendLog(`Connected to ${ws.url}`);

      wsRef.current = ws;
      ws.binaryType = "arraybuffer";

      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        let data: WhisperLiveMessage;
        try {
          data = JSON.parse(event.data) as WhisperLiveMessage;
        } catch {
          appendLog("Received non-JSON transcription message", "error");
          return;
        }
        if (data.error) {
          setError(data.error);
          appendLog(data.error, "error");
          return;
        }
        if (data.status === "ERROR" && data.message) {
          setError(data.message);
          appendLog(data.message, "error");
          return;
        }
        if (Array.isArray(data.segments) && data.segments.length > 0) {
          applySegments(data.segments);
        }
      };

      ws.onerror = () => {
        log("WebSocket error");
        setError("WebSocket error");
        appendLog("WebSocket error", "error");
      };
      ws.onclose = (ev) => {
        log("WebSocket closed", { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
        if (!isIntentionalStopRef.current) {
          const closeMsg = `WebSocket closed unexpectedly (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ""})`;
          setError(closeMsg);
          appendLog(closeMsg, "error");
        }
        stopRecording();
      };

      log("WebSocket open, starting audio pipeline", { url: ws.url });

      // WhisperLive config is sent by backend proxy. We stream 16-bit PCM after,
      // resampled to 16 kHz mono. Buffer so we send full CHUNK_SAMPLES chunks.
      const inputRate = context.sampleRate;
      log("audio pipeline started", { inputRate, targetRate: SAMPLE_RATE });
      const source = context.createMediaStreamSource(stream);
      const chunkBuffer = new ArrayBuffer(CHUNK_SAMPLES * 2);
      const chunkView = new Int16Array(chunkBuffer);
      const leftover: number[] = [];
      const MAX_LEFTOVER = SAMPLE_RATE * 5; // cap at 5 seconds of audio
      let chunksSent = 0;
      let lastLogAt = 0;

      // Sends exactly one CHUNK_SAMPLES chunk; callers guarantee that length.
      const flushChunk = (samples: number[]) => {
        for (let i = 0; i < CHUNK_SAMPLES; i++) {
          const s = Math.max(-1, Math.min(1, samples[i]));
          chunkView[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        if (ws.readyState === WebSocket.OPEN) {
          // Start the time-to-first-token clock when the first audio actually ships.
          if (startTimeRef.current === 0) startTimeRef.current = Date.now();
          ws.send(chunkBuffer);
          chunksSent++;
          const now = Date.now();
          if (now - lastLogAt >= 5000) {
            log("audio streaming", { chunksSent, contextState: context.state });
            lastLogAt = now;
          }
        }
      };

      const processor = context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        if (context.state === "suspended") {
          log("AudioContext suspended; call context.resume() after a user gesture");
          context.resume().catch(() => {});
          return;
        }
        if (context.state === "closed") return;
        if (ws.readyState !== WebSocket.OPEN) return;

        // Resample to 16 kHz before buffering so chunk timing/labeling is correct
        // even when the browser opens the context at its own hardware rate.
        const input = resampleTo16k(e.inputBuffer.getChannelData(0), inputRate);
        for (let i = 0; i < input.length; i++) leftover.push(input[i]);
        // Drop oldest samples if buffer grows too large (e.g. WS stalled)
        if (leftover.length > MAX_LEFTOVER) {
          leftover.splice(0, leftover.length - MAX_LEFTOVER);
        }
        while (leftover.length >= CHUNK_SAMPLES) {
          const chunk = leftover.splice(0, CHUNK_SAMPLES);
          flushChunk(chunk);
        }
      };

      context.addEventListener("statechange", () => log("AudioContext state", context.state));

      // Use GainNode(0) so the graph runs but we don't play mic back to speakers
      const gain = context.createGain();
      gain.gain.value = 0;
      source.connect(processor);
      processor.connect(gain);
      gain.connect(context.destination);
      processorRef.current = processor;
      appendLog("Audio stream started");
      log("audio pipeline started", { contextState: context.state });
    } catch (err) {
      log("Transcription start failed", err);
      const msg =
        err instanceof Error
          ? err.message === "timeout" || err.message === "closed" || err.message === "error"
            ? "Could not connect to transcription service. In dev, check apx dev status and VITE_BACKEND_WS_URL."
            : err.message
          : "Failed to start transcription";
      setError(msg);
      appendLog(msg, "error");
      stopRecording();
    }
  }, [appendLog, stopRecording, applySegments]);

  const displayTranscript = [transcript, interim].filter(Boolean).join(" ");

  return {
    transcript: displayTranscript,
    segments,
    logs,
    metrics,
    isRecording,
    error,
    startRecording,
    stopRecording,
  };
}
