"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  record,
  snapshot,
  type CaptureFile,
  type Recording,
} from "@/lib/capture";
import { Icon } from "./icon";

export function CaptureControls({
  camera,
  video,
  ready,
  onCapture,
  onRecorder,
  onBusy,
}: {
  camera: { id: string; name: string };
  video: RefObject<HTMLVideoElement | null>;
  ready: boolean;
  onCapture: (file: CaptureFile) => void;
  onRecorder: (id: string, stop?: () => Promise<void>) => void;
  onBusy: (busy: boolean) => void;
}) {
  const recorder = useRef<Recording | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);
  const alive = useRef(true);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordAudio, setRecordAudio] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [message, setMessage] = useState("");
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abort.current?.abort();
      void recorder.current?.stop();
      onRecorder(camera.id);
    };
  }, [camera.id, onRecorder]);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => {
    if (!ready) {
      abort.current?.abort();
      void recorder.current?.stop();
    }
  }, [ready]);
  const error = (value: unknown) => {
    if (alive.current)
      setMessage(
        value instanceof Error && value.name !== "AbortError"
          ? value.message
          : "Capture cancelled.",
      );
  };
  async function start() {
    if (!video.current || busy) return;
    setBusy(true);
    onBusy(true);
    setMessage("Preparing recording…");
    abort.current = new AbortController();
    onRecorder(camera.id, async () => {
      abort.current?.abort();
      await recorder.current?.stop();
    });
    try {
      const current = await record(
        video.current,
        camera.name,
        abort.current.signal,
        (file) => {
          recorder.current = undefined;
          onRecorder(camera.id);
          onCapture(file);
          if (alive.current) {
            setRecording(false);
            onBusy(false);
            setMessage("");
          }
        },
        (message) => error(new Error(message)),
        () => {
          recorder.current = undefined;
          onRecorder(camera.id);
          if (alive.current) {
            setRecording(false);
            onBusy(false);
          }
        },
      );
      if (!alive.current || abort.current.signal.aborted) {
        await current.stop();
        return;
      }
      recorder.current = current;
      onRecorder(camera.id, current.stop);
      setSeconds(0);
      setRecording(true);
      setRecordAudio(current.audio);
      setMessage(
        current.audio ? "Recording video and audio." : "Recording video only.",
      );
    } catch (value) {
      error(value);
      onRecorder(camera.id);
      onBusy(false);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <>
      <button
        className="icon-button"
        disabled={!ready || busy}
        aria-label={`Snapshot ${camera.name}`}
        title="Save a PNG snapshot on this device"
        onClick={async () => {
          if (!video.current) return;
          try {
            onCapture(await snapshot(video.current, camera.name));
            setMessage("");
          } catch (value) {
            error(value);
          }
        }}
      >
        <Icon name="snapshot" />
      </button>
      <button
        className={`icon-button ${recording ? "recording-button" : ""}`}
        disabled={busy || (!ready && !recording)}
        aria-pressed={recording}
        aria-label={`${recording ? "Stop recording" : "Record"} ${camera.name}`}
        title={
          recording
            ? "Stop and save clip"
            : "Record a clip on this device (up to 5 min / 32 MB)"
        }
        onClick={() =>
          recording ? void recorder.current?.stop() : void start()
        }
      >
        <Icon name={recording ? "stop" : "record"} />
      </button>
      {recording || message ? (
        <span
          className="capture-message"
          aria-live={recording ? "off" : "polite"}
        >
          {recording
            ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} · `
            : ""}
          {recording
            ? recordAudio
              ? "Recording video and audio."
              : "Recording video only."
            : message}
        </span>
      ) : null}
    </>
  );
}
