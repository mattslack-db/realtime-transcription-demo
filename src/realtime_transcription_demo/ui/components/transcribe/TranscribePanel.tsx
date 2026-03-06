import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Mic, Square } from "lucide-react";
import type { TranscriptionEngine } from "@/hooks/useRealtimeTranscription";
import type { TranscriptionMetrics } from "@/hooks/useRealtimeTranscription";
import type { TranscriptionLogEntry } from "@/hooks/useRealtimeTranscription";

const ENGINE_LABELS: Record<TranscriptionEngine, string> = {
  whisperlive: "WhisperLive",
};

interface TranscribePanelProps {
  engine: TranscriptionEngine;
  transcript: string;
  metrics: TranscriptionMetrics;
  logs: TranscriptionLogEntry[];
  isRecording: boolean;
  error: string | null;
  onStart: () => void;
  onStop: () => void;
}

export function TranscribePanel({
  engine,
  transcript,
  metrics,
  logs,
  isRecording,
  error,
  onStart,
  onStop,
}: TranscribePanelProps) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {ENGINE_LABELS[engine]}
            <Badge variant="secondary">{engine}</Badge>
          </CardTitle>
          <CardDescription>
            Real-time speech-to-text using {ENGINE_LABELS[engine]}. Allow microphone access and click Start to begin.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Button
              onClick={onStart}
              disabled={isRecording}
              className="gap-2"
            >
              <Mic className="h-4 w-4" />
              Start
            </Button>
            <Button
              variant="destructive"
              onClick={onStop}
              disabled={!isRecording}
              className="gap-2"
            >
              <Square className="h-4 w-4" />
              Stop
            </Button>
          </div>
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          {logs.length > 0 && (
            <div className="rounded-lg border bg-background p-3 max-h-40 overflow-y-auto">
              <p className="text-xs font-medium text-muted-foreground mb-2">Runtime log</p>
              <div className="space-y-1">
                {logs.slice(-12).map((entry, idx) => (
                  <p
                    key={`${entry.timestamp}-${idx}`}
                    className={`text-xs ${
                      entry.level === "error" ? "text-destructive" : "text-muted-foreground"
                    }`}
                  >
                    [{new Date(entry.timestamp).toLocaleTimeString()}] {entry.message}
                  </p>
                ))}
              </div>
            </div>
          )}
          {(metrics.timeToFirstTokenMs != null || metrics.segmentCount > 0) && (
            <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
              {metrics.timeToFirstTokenMs != null && (
                <span>First token: {metrics.timeToFirstTokenMs} ms</span>
              )}
              <span>Segments: {metrics.segmentCount}</span>
              {metrics.lastSegmentAt != null && (
                <span>Last update: {new Date(metrics.lastSegmentAt).toLocaleTimeString()}</span>
              )}
            </div>
          )}
          <div className="rounded-lg border bg-muted/30 p-4 min-h-[200px]">
            <p className="text-sm whitespace-pre-wrap">
              {transcript || (isRecording ? "Listening…" : "Click Start to begin transcription.")}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
