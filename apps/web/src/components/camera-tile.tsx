"use client";
import { useEffect, useRef, useState, memo } from "react";
import { qualityLabels, type Camera, type Quality } from "@homegrid/shared";
import {
  connectCamera,
  type Connection,
  type PlaybackStatus,
} from "@/lib/playback";
import { Icon } from "./icon";

interface Props {
  camera: Camera;
  quality: Quality;
  muted: boolean;
  stopped: boolean;
  paused: boolean;
  focused: boolean;
  onToggle: (id: string) => void;
  onMute: (id: string) => void;
  onQuality: (id: string, quality: Quality) => void;
  onFocus: (id: string) => void;
  onSwap: (from: string, to: string) => void;
  onMove: (id: string, direction: number) => void;
  onLease: (camera: string, id?: string) => void;
  onStatus: (camera: string, status: PlaybackStatus) => void;
}
export const CameraTile = memo(function CameraTile(props: Props) {
  const { camera, quality, muted, stopped, paused, onLease, onStatus } = props;
  const video = useRef<HTMLVideoElement>(null);
  const [connectionStatus, setConnectionStatus] =
    useState<PlaybackStatus>("Connecting");
  const [retry, setRetry] = useState(0);
  const [dropTarget, setDropTarget] = useState(false);
  const status: PlaybackStatus = stopped
    ? "Stopped"
    : paused
      ? "Paused"
      : connectionStatus;
  useEffect(() => {
    onStatus(camera.id, status);
  }, [camera.id, status, onStatus]);
  useEffect(() => {
    if (stopped || paused || !video.current) return;
    const abort = new AbortController();
    let current: Connection | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let lastTime = 0,
      lastProgress = Date.now(),
      retryCount = 0,
      connecting = false;
    function reconnect() {
      if (abort.signal.aborted || retryTimer) return;
      current?.close();
      current = undefined;
      onLease(camera.id);
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
        );
        if (abort.signal.aborted) {
          current.close();
          return;
        }
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
      if (video.current.currentTime !== lastTime) {
        lastTime = video.current.currentTime;
        lastProgress = Date.now();
      } else if (Date.now() - lastProgress > 20000) reconnect();
    }, 5000);
    void start();
    return () => {
      abort.abort();
      current?.close();
      onLease(camera.id);
      clearTimeout(retryTimer);
      clearInterval(stalledTimer);
    };
  }, [camera.id, quality, stopped, paused, retry, onLease]);
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
        <span className={`status status-${status.toLowerCase()}`}>
          <span />
          {status}
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
                : status === "Paused"
                  ? "Paused while tab is hidden"
                  : status === "Reconnecting"
                    ? "Reconnecting to camera…"
                    : "Connecting to camera…"}
            </span>
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
          onChange={(event) =>
            props.onQuality(camera.id, event.target.value as Quality)
          }
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
          onClick={() => props.onMute(camera.id)}
          aria-label={`${muted ? "Unmute" : "Mute"} ${camera.name}`}
          title={muted ? "Unmute" : "Mute"}
          aria-pressed={!muted}
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
      </footer>
    </article>
  );
});
