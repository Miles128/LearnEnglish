import { useCallback, useEffect, useState } from "react";
import { getTts } from "./tts";

export type SpeakTarget =
  | { kind: "article" }
  | { kind: "paragraph"; index: number }
  | { kind: "word" };

/** Shared speech-synthesis state: subscribes to TTS changes and stops on unmount. */
export function useTts() {
  const [speaking, setSpeaking] = useState(false);
  const [speakTarget, setSpeakTarget] = useState<SpeakTarget | null>(null);

  useEffect(() => {
    const tts = getTts();
    return tts.subscribe((isSpeaking) => {
      setSpeaking(isSpeaking);
      if (!isSpeaking) setSpeakTarget(null);
    });
  }, []);

  useEffect(() => {
    return () => getTts().stop();
  }, []);

  const startSpeak = useCallback((target: SpeakTarget, chunks: string[]) => {
    setSpeakTarget(target);
    getTts().speakChunks(chunks);
  }, []);

  const stopSpeak = useCallback(() => {
    getTts().stop();
    setSpeakTarget(null);
  }, []);

  return { speaking, speakTarget, startSpeak, stopSpeak };
}