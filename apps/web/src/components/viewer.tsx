"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  swapSlots,
  type Camera,
  type Preferences,
  type Quality,
} from "@homegrid/shared";
import { CameraTile } from "./camera-tile";
import { Brand, Icon } from "./icon";
import type { PlaybackStatus } from "@/lib/playback";

export function Viewer({
  cameras,
  initialPreferences,
}: {
  cameras: Camera[];
  initialPreferences: Preferences;
}) {
  const [preferences, setPreferences] = useState(initialPreferences);
  const [focused, setFocused] = useState<string | null>(null);
  const [chooser, setChooser] = useState(false);
  const [locked, setLocked] = useState(false);
  const [saveStatus, setSaveStatus] = useState("Saved");
  const [statuses, setStatuses] = useState<Record<string, PlaybackStatus>>({});
  const leases = useRef(new Map<string, string>());
  const prefsRef = useRef(preferences);
  const savedRef = useRef(JSON.stringify(initialPreferences));
  const alive = useRef(true);
  const saveQueue = useRef(Promise.resolve());
  const pendingWrites = useRef(0);
  const onLease = useCallback((camera: string, id?: string) => {
    if (id) leases.current.set(camera, id);
    else leases.current.delete(camera);
  }, []);
  const onStatus = useCallback(
    (camera: string, status: PlaybackStatus) =>
      setStatuses((previous) =>
        previous[camera] === status
          ? previous
          : { ...previous, [camera]: status },
      ),
    [],
  );
  const toggle = useCallback(
    (id: string) =>
      setPreferences((previous) => ({
        ...previous,
        cameras: {
          ...previous.cameras,
          [id]: {
            ...previous.cameras[id],
            stopped: !previous.cameras[id].stopped,
          },
        },
      })),
    [],
  );
  const mute = useCallback(
    (id: string) =>
      setPreferences((previous) => ({
        ...previous,
        cameras: {
          ...previous.cameras,
          [id]: { ...previous.cameras[id], muted: !previous.cameras[id].muted },
        },
      })),
    [],
  );
  const quality = useCallback(
    (id: string, next: Quality) =>
      setPreferences((previous) => ({
        ...previous,
        cameras: {
          ...previous.cameras,
          [id]: { ...previous.cameras[id], quality: next },
        },
      })),
    [],
  );
  const focus = useCallback(
    (id: string) => setFocused((previous) => (previous === id ? null : id)),
    [],
  );
  const swap = useCallback(
    (from: string, to: string) =>
      setPreferences((previous) => ({
        ...previous,
        slots: swapSlots(previous.slots, from, to),
      })),
    [],
  );
  const move = useCallback(
    (id: string, direction: number) =>
      setPreferences((previous) => {
        const index = previous.slots.indexOf(id),
          next = previous.slots[index + direction];
        return next
          ? { ...previous, slots: swapSlots(previous.slots, id, next) }
          : previous;
      }),
    [],
  );
  const select = (id: string) => {
    setPreferences((previous) => ({
      ...previous,
      slots: previous.slots.includes(id)
        ? previous.slots.filter((s) => s !== id)
        : [...previous.slots, id],
    }));
    if (focused === id) setFocused(null);
  };
  useEffect(() => {
    prefsRef.current = preferences;
    const value = JSON.stringify(preferences);
    if (value === savedRef.current && pendingWrites.current === 0) {
      setSaveStatus("Saved");
      return;
    }
    setSaveStatus("Saving…");
    const timer = setTimeout(() => {
      pendingWrites.current++;
      // Serialize writes so a slower earlier request cannot overwrite newer choices.
      saveQueue.current = saveQueue.current
        .catch(() => {})
        .then(async () => {
          try {
            const response = await fetch("/api/preferences", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: value,
            });
            if (response.status === 401) {
              setLocked(true);
              window.location.replace("/login");
              return;
            }
            if (!response.ok) throw new Error("Save failed");
            savedRef.current = value;
            if (alive.current && value === JSON.stringify(prefsRef.current))
              setSaveStatus("Saved");
          } catch {
            if (alive.current) setSaveStatus("Could not save");
          } finally {
            pendingWrites.current--;
          }
        });
    }, 450);
    return () => clearTimeout(timer);
  }, [preferences]);
  useEffect(() => {
    alive.current = true;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFocused(null);
        setChooser(false);
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "l"
      ) {
        event.preventDefault();
        void lock();
      }
    };
    const pageHide = () => {
      const value = JSON.stringify(prefsRef.current);
      if (value !== savedRef.current)
        void fetch("/api/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: value,
          keepalive: true,
        }).catch(() => {});
    };
    window.addEventListener("keydown", key);
    window.addEventListener("pagehide", pageHide);
    const pageShow = (event: PageTransitionEvent) => {
      // Restored page snapshots contain closed peers and possibly expired auth.
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", pageShow);
    return () => {
      alive.current = false;
      window.removeEventListener("keydown", key);
      window.removeEventListener("pagehide", pageHide);
      window.removeEventListener("pageshow", pageShow);
    };
  }, []);
  useEffect(() => {
    if (locked) return;
    const heartbeat = async () => {
      try {
        const response = await fetch("/api/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: [...leases.current.values()] }),
          keepalive: true,
        });
        if (response.status === 401) {
          setLocked(true);
          window.location.replace("/login");
        }
      } catch {
        /* Leases expire at the gateway if it cannot be reached. */
      }
    };
    const visibility = () => {
      void heartbeat();
    };
    document.addEventListener("visibilitychange", visibility);
    const timer = setInterval(() => {
      void heartbeat();
    }, 15000);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [locked]);
  async function lock() {
    setLocked(true);
    await saveQueue.current.catch(() => {});
    try {
      await fetch("/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prefsRef.current),
      });
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.replace("/login");
    }
  }
  const visible = focused ? [focused] : preferences.slots;
  const liveCount = visible.filter(
    (id) =>
      !locked && !preferences.cameras[id].stopped && statuses[id] === "Live",
  ).length;
  const allStopped =
    preferences.slots.length > 0 &&
    preferences.slots.every((id) => preferences.cameras[id].stopped);
  return (
    <div className="viewer-shell">
      <header className="app-header">
        <Brand />
        <span className="header-divider" />
        <span className="header-label">LIVE VIEW</span>
        <span className="header-spacer" />
        <span className="private-label">
          <Icon name="lock" size={13} />
          Private
        </span>
        <button
          className="secondary small"
          onClick={() => {
            void lock();
          }}
          disabled={locked}
        >
          <Icon name="lock" size={15} />
          Lock
        </button>
      </header>
      <main className="workspace">
        <div className="view-toolbar">
          <div className="view-title">
            <h1>
              {focused
                ? cameras.find((c) => c.id === focused)?.name
                : "Your cameras"}
            </h1>
            <span className="live-summary">
              <span className={liveCount ? "small-dot" : "small-dot idle"} />
              {liveCount} live
              <span className="subtle"> / {visible.length}</span>
            </span>
          </div>
          <div className="toolbar-controls">
            {focused ? (
              <button className="secondary" onClick={() => setFocused(null)}>
                <Icon name="grid" />
                Back to grid<span className="keycap">Esc</span>
              </button>
            ) : (
              <>
                <label className="columns-label">
                  Columns
                  <select
                    aria-label="Grid columns"
                    value={preferences.columns}
                    onChange={(event) =>
                      setPreferences((previous) => ({
                        ...previous,
                        columns: Number(event.target.value) as 1 | 2 | 3,
                      }))
                    }
                  >
                    <option value="1">1</option>
                    <option value="2">2</option>
                    <option value="3">3</option>
                  </select>
                </label>
                <div className="chooser-wrap">
                  <button
                    className="secondary"
                    aria-expanded={chooser}
                    aria-controls="camera-chooser"
                    onClick={() => setChooser((v) => !v)}
                  >
                    <Icon name="camera" />
                    Cameras
                    <span className="count">{preferences.slots.length}</span>
                  </button>
                  {chooser ? (
                    <section
                      id="camera-chooser"
                      className="camera-chooser"
                      aria-label="Camera selection"
                    >
                      <div className="chooser-heading">
                        <strong>Show cameras</strong>
                        <button
                          className="icon-button"
                          aria-label="Close camera selection"
                          onClick={() => setChooser(false)}
                        >
                          <Icon name="close" size={16} />
                        </button>
                      </div>
                      {cameras.map((camera) => (
                        <label key={camera.id}>
                          <input
                            type="checkbox"
                            checked={preferences.slots.includes(camera.id)}
                            onChange={() => select(camera.id)}
                          />
                          <span>{camera.name}</span>
                          <span className="subtle">
                            {camera.channel.toString().padStart(2, "0")}
                          </span>
                        </label>
                      ))}
                    </section>
                  ) : null}
                </div>
              </>
            )}
            <button
              className="secondary"
              disabled={!preferences.slots.length}
              onClick={() =>
                setPreferences((previous) => ({
                  ...previous,
                  cameras: Object.fromEntries(
                    Object.entries(previous.cameras).map(([id, prefs]) => [
                      id,
                      previous.slots.includes(id)
                        ? { ...prefs, stopped: !allStopped }
                        : prefs,
                    ]),
                  ),
                }))
              }
            >
              <Icon name={allStopped ? "play" : "stop"} size={15} />
              {allStopped ? "Start all" : "Stop all"}
            </button>
          </div>
        </div>
        {!locked && visible.length ? (
          <div
            className={`camera-grid columns-${focused ? 1 : preferences.columns} ${focused ? "focus-grid" : ""}`}
          >
            {visible.map((id) => {
              const camera = cameras.find((c) => c.id === id)!;
              return (
                <CameraTile
                  key={id}
                  camera={camera}
                  {...preferences.cameras[id]}
                  focused={focused === id}
                  onToggle={toggle}
                  onMute={mute}
                  onQuality={quality}
                  onFocus={focus}
                  onSwap={swap}
                  onMove={move}
                  onLease={onLease}
                  onStatus={onStatus}
                />
              );
            })}
          </div>
        ) : (
          <section className="empty-grid">
            <Icon name={locked ? "lock" : "camera"} size={32} />
            <h2>{locked ? "Locking cameras…" : "Choose your cameras"}</h2>
            <p className="muted">
              {locked
                ? "Closing your video connections."
                : "Select a camera to start your live view."}
            </p>
            {!locked ? (
              <button className="secondary" onClick={() => setChooser(true)}>
                Choose cameras
              </button>
            ) : null}
          </section>
        )}
        <footer className="workspace-footer">
          <span>
            Double-click to focus<span className="footer-separator">·</span>Esc
            to return<span className="footer-separator">·</span>Drag to arrange
          </span>
          <span
            className={saveStatus === "Could not save" ? "error-text" : ""}
            role="status"
          >
            {saveStatus === "Saved" ? <Icon name="check" size={13} /> : null}
            {saveStatus}
          </span>
        </footer>
      </main>
    </div>
  );
}
