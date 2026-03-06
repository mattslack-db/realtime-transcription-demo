import { createFileRoute } from "@tanstack/react-router";
import { TranscribePanel } from "@/components/transcribe/TranscribePanel";
import { useRealtimeTranscription } from "@/hooks/useRealtimeTranscription";

export const Route = createFileRoute("/_sidebar/whisperlive")({
  component: () => <WhisperLivePage />,
});

function WhisperLivePage() {
  const {
    transcript,
    metrics,
    logs,
    isRecording,
    error,
    startRecording,
    stopRecording,
  } = useRealtimeTranscription();

  return (
    <TranscribePanel
      engine="whisperlive"
      transcript={transcript}
      metrics={metrics}
      logs={logs}
      isRecording={isRecording}
      error={error}
      onStart={startRecording}
      onStop={stopRecording}
    />
  );
}
