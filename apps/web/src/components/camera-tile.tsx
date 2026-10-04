"use client";
import { useEffect, useRef, useState, memo } from "react";
import {
  qualityLabels,
  fallbackQuality,
  audioFallbackQuality,
  type Camera,
  type Quality,
} from "@homegrid/shared";
import {
  connectCamera,
  type Connection,
  type PlaybackStatus,
} from "@/lib/playback";
import { Icon } from "./icon";
import { CaptureControls } from "./capture-controls";
import type { CaptureFile } from "@/lib/capture";

interface Props {
  camera: Camera;
  quality: Quality;
  muted: boolean;
  stopped: boolean;
  focused: boolean;
  onToggle: (id: string) => void;
  onMute: (id: string) => void;
  onQuality: (id: string, quality: Quality) => void;
  onFocus: (id: string) => void;
  onSwap: (from: string, to: string) => void;
  onMove: (id: string, direction: number) => void;
  onLease: (camera: string, id?: string) => void;
  onStatus: (camera: string, status: PlaybackStatus) => void;
  onCapture: (file: CaptureFile) => void;
  onRecorder: (camera: string, stop?: () => Promise<void>) => void;
}
export const CameraTile = memo(function CameraTile(props: Props) {
  const { camera, quality, muted, stopped, onLease, onStatus, onQuality } =
    props;
  const video = useRef<HTMLVideoElement>(null);
  const connection = useRef<Connection | undefined>(undefined);
  const [connectionStatus, setConnectionStatus] =
    useState<PlaybackStatus>("Connecting");
  const [retry, setRetry] = useState(0);
  const [dropTarget, setDropTarget] = useState(false);
  const [notice, setNotice] = useState("");
  const [audioFallback, setAudioFallback] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const status: PlaybackStatus = stopped ? "Stopped" : connectionStatus;
  useEffect(() => {
    onStatus(camera.id, status);
  }, [camera.id, status, onStatus]);
  useEffect(() => {
    if (stopped || !video.current) return;
    const element = video.current;
    let onscreen = true;
    const abort = new AbortController();
    let current: Connection | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let lastTime = 0,
      lastProgress = Date.now(),
      retryCount = 0,
      connecting = false;
    const observer = new IntersectionObserver((entries) => {
      onscreen = entries[0].isIntersecting;
      lastProgress = Date.now();
      if (onscreen && !document.hidden) current?.resume();
    });
    observer.observe(element);
    const visibility = () => {
      lastProgress = Date.now();
      if (onscreen && !document.hidden) current?.resume();
    };
    document.addEventListener("visibilitychange", visibility);
    function reconnect() {
      if (abort.signal.aborted || retryTimer) return;
      current?.close();
      current = undefined;
      connection.current = undefined;
      onLease(camera.id);
      const fallback = fallbackQuality(camera);
      if (quality !== fallback) {
        setNotice(
          `${qualityLabels[quality]} unavailable. Using ${qualityLabels[fallback]}.`,
        );
        onQuality(camera.id, fallback);
        return;
      }
      setConnectionStatus("Reconnecting");
      const delay =
        Math.min(30000, 1000 * 2 ** Math.min(retryCount++, 5)) +
        Math.random() * 500;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void start();
      }, delay);
    }
    async function start() {
      if (abort.signal.aborted || !video.current || connecting) return;
      connecting = true;
      setConnectionStatus(retryCount ? "Reconnecting" : "Connecting");
      try {
        current = await connectCamera(
          camera.id,
          quality,
          video.current,
          abort.signal,
          (s) => {
            if (!abort.signal.aborted) {
              setConnectionStatus(s);
              if (s === "Live") retryCount = 0;
            }
          },
          reconnect,
          {
            audioFallback: audioFallbackQuality(camera, quality),
            onAudioLease: (id) => onLease(`${camera.id}:audio`, id),
            onAudioFallback: setAudioFallback,
          },
        );
        if (abort.signal.aborted) {
          current.close();
          return;
        }
        connection.current = current;
        onLease(camera.id, current.id);
        lastProgress = Date.now();
      } catch {
        if (!abort.signal.aborted) reconnect();
      } finally {
        connecting = false;
      }
    }
    // Check only active video elements; frame progress stays outside React state.
    const stalledTimer = setInterval(() => {
      if (!video.current || !current) return;
      if (document.hidden || !onscreen || video.current.paused) {
        lastProgress = Date.now();
        return;
      }
      if (video.current.currentTime !== lastTime) {
        lastTime = video.current.currentTime;
        lastProgress = Date.now();
      } else if (Date.now() - lastProgress > 20000) reconnect();
    }, 5000);
    void start();
    return () => {
      abort.abort();
      current?.close();
      connection.current = undefined;
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      onLease(camera.id);
      clearTimeout(retryTimer);
      clearInterval(stalledTimer);
    };
  }, [camera, quality, stopped, retry, onLease, onQuality]);
  return (
    <article
      className={`camera-tile ${props.focused ? "focused-tile" : ""} ${dropTarget ? "drop-target" : ""}`}
      aria-label={camera.name}
      onDragOver={(event) => {
        if (!props.focused) {
          event.preventDefault();
          setDropTarget(true);
        }
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDropTarget(false);
        props.onSwap(
          event.dataTransfer.getData("text/homegrid-camera"),
          camera.id,
        );
      }}
    >
      <header className="tile-header">
        <button
          className="icon-button grip"
          title="Drag to move, or use the arrow keys"
          aria-label={`Move ${camera.name}`}
          draggable={!props.focused}
          onDragStart={(event) => {
            event.dataTransfer.setData("text/homegrid-camera", camera.id);
            event.dataTransfer.effectAllowed = "move";
          }}
          onKeyDown={(event) => {
            if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
              event.preventDefault();
              props.onMove(camera.id, event.key === "ArrowLeft" ? -1 : 1);
            }
          }}
        >
          <Icon name="grip" size={15} />
        </button>
        <h2 onDoubleClick={() => props.onFocus(camera.id)}>{camera.name}</h2>
        <span
          className={`status status-${status.toLowerCase().replaceAll(" ", "-")}`}
        >
          <span />
          <span className="status-label">{status}</span>
        </span>
      </header>
      <div
        className="video-surface"
        onDoubleClick={() => props.onFocus(camera.id)}
      >
        <video
          ref={video}
          autoPlay
          playsInline
          muted={muted}
          aria-label={`${camera.name} live video`}
          disablePictureInPicture
        />
        {status !== "Live" ? (
          <div className="video-message">
            <Icon name={stopped ? "stop" : "camera"} size={30} />
            <span>
              {status === "Stopped"
                ? "Stream stopped"
                : status === "Tap to play"
                  ? "Tap to play video"
                  : status === "Reconnecting"
                    ? "Reconnecting to camera…"
                    : "Connecting to camera…"}
            </span>
            {status === "Tap to play" ? (
              <button
                className="text-button"
                onClick={() => {
                  if (connection.current) connection.current.resume();
                  else void video.current?.play().catch(() => {});
                }}
              >
                Play video
              </button>
            ) : null}
            {stopped ? (
              <button
                className="text-button"
                onClick={() => props.onToggle(camera.id)}
              >
                Start stream
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <footer className="tile-controls">
        <select
          aria-label={`${camera.name} quality`}
          value={quality}
          disabled={capturing}
          onChange={(event) => {
            setNotice("");
            props.onQuality(camera.id, event.target.value as Quality);
          }}
        >
          {Object.entries(qualityLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <span className="tile-control-spacer" />
        <button
          className="icon-button"
          onClick={() => {
            if (video.current) {
              video.current.muted = !muted;
              video.current.defaultMuted = !muted;
            }
            props.onMute(camera.id);
            connection.current?.resume();
          }}
          aria-label={`${muted ? "Unmute" : "Mute"} ${camera.name}`}
          title={`${muted ? "Unmute" : "Mute"}${audioFallback ? " (audio from Sub 1)" : ""}`}
          aria-pressed={!muted}
          disabled={capturing}
        >
          <Icon name={muted ? "mute" : "sound"} />
        </button>
        <button
          className="icon-button"
          onClick={() => props.onToggle(camera.id)}
          aria-label={`${stopped ? "Start" : "Stop"} ${camera.name}`}
          title={stopped ? "Start stream" : "Stop stream"}
        >
          <Icon name={stopped ? "play" : "stop"} />
        </button>
        {status === "Reconnecting" ? (
          <button
            className="icon-button"
            onClick={() => {
              setConnectionStatus("Connecting");
              setRetry((n) => n + 1);
            }}
            aria-label={`Retry ${camera.name}`}
            title="Retry now"
          >
            <Icon name="retry" />
          </button>
        ) : null}
        <button
          className="icon-button"
          onClick={() => props.onFocus(camera.id)}
          aria-label={`${props.focused ? "Restore grid from" : "Focus"} ${camera.name}`}
          title={props.focused ? "Restore grid (Esc)" : "Focus camera"}
        >
          <Icon name={props.focused ? "collapse" : "expand"} />
        </button>
        <CaptureControls
          camera={camera}
          video={video}
          ready={status === "Live"}
          onCapture={props.onCapture}
          onRecorder={props.onRecorder}
          onBusy={setCapturing}
        />
      </footer>
      {notice || audioFallback ? (
        <p className="tile-notice" aria-live="polite">
          {notice}
          {notice && audioFallback ? " " : ""}
          {audioFallback ? "Audio from Sub 1." : ""}
        </p>
      ) : null}
    </article>
  );
});
