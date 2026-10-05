"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  setupViewSchema,
  preferencesSchema,
  type SetupView,
  type Preferences,
} from "@homegrid/shared";
import { Icon } from "./icon";

export function NvrSettings({
  onClose,
  beforeSave,
  onApplied,
}: {
  onClose: () => void;
  beforeSave: () => Promise<void>;
  onApplied: (settings: SetupView, preferences: Preferences) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const [settings, setSettings] = useState<SetupView | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    const abort = new AbortController();
    void fetch("/api/settings", { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Setup unavailable");
        const value = setupViewSchema.parse(await response.json());
        if (!abort.signal.aborted) setSettings(value);
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setError("Setup unavailable. Unlock HomeGrid again if needed.");
      });
    return () => abort.abort();
  }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings || saving) return;
    const fields = new FormData(event.currentTarget);
    setSaving(true);
    setError("");
    try {
      await beforeSave();
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision: settings.revision,
          nvr: {
            host: fields.get("host"),
            port: Number(fields.get("port")),
            username: fields.get("username"),
            password: fields.get("nvrPassword"),
          },
          cameras: settings.cameras.map((camera) => ({
            ...camera,
            name: String(fields.get(`${camera.id}-name`)),
            channel: Number(fields.get(`${camera.id}-channel`)),
            enabled: fields.has(`${camera.id}-enabled`),
          })),
          householdPassword: fields.get("householdPassword"),
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result.error || "Setup could not be saved.");
        return;
      }
      onApplied(
        setupViewSchema.parse(result),
        preferencesSchema.parse(result.preferences),
      );
      onClose();
    } catch {
      setError("Setup could not be saved. Check the gateway connection.");
    } finally {
      for (const name of ["username", "nvrPassword", "householdPassword"]) {
        const input = form.current?.elements.namedItem(name);
        if (input instanceof HTMLInputElement) input.value = "";
      }
      setSaving(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="capture-dialog nvr-settings"
      aria-labelledby="nvr-settings-title"
      onCancel={(event) => {
        if (saving) event.preventDefault();
        else onClose();
      }}
      onClose={onClose}
    >
      <div className="capture-dialog-heading">
        <h2 id="nvr-settings-title">NVR &amp; cameras</h2>
        <button
          className="icon-button"
          disabled={saving}
          onClick={onClose}
          aria-label="Close NVR setup"
        >
          <Icon name="close" />
        </button>
      </div>
      <p>
        One NVR, up to six cameras. Saved credentials are kept on your home
        gateway and are never displayed. Leave username and NVR password blank
        to keep them. Changing the NVR or account requires both.
      </p>
      {settings ? (
        <form ref={form} onSubmit={save} autoComplete="off">
          <fieldset disabled={saving}>
            <legend className="sr-only">Connection and camera setup</legend>
            <label>
              NVR address
              <input
                name="host"
                defaultValue={settings.nvr.host}
                required
                maxLength={255}
                placeholder="Local IP address"
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
            <label>
              RTSP port
              <input
                name="port"
                type="number"
                defaultValue={settings.nvr.port}
                required
                min={1}
                max={65535}
                inputMode="numeric"
              />
            </label>
            <label>
              Username
              <input
                name="username"
                maxLength={256}
                placeholder="Blank keeps saved username"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
            <label>
              NVR password
              <input
                name="nvrPassword"
                type="password"
                maxLength={256}
                placeholder="Blank keeps saved password"
                autoComplete="new-password"
              />
            </label>
            <div className="setup-camera-heading" aria-hidden="true">
              <span>Camera name</span>
              <span>Channel</span>
              <span>Show</span>
            </div>
            {settings.cameras.map((camera) => (
              <div className="setup-camera-row" key={camera.id}>
                <input
                  aria-label={`Camera ${camera.id.slice(4)} name`}
                  name={`${camera.id}-name`}
                  defaultValue={camera.name}
                  required
                  maxLength={48}
                />
                <input
                  aria-label={`Camera ${camera.id.slice(4)} channel`}
                  name={`${camera.id}-channel`}
                  type="number"
                  defaultValue={camera.channel}
                  required
                  min={1}
                  max={64}
                  inputMode="numeric"
                />
                <input
                  aria-label={`Show Camera ${camera.id.slice(4)}`}
                  name={`${camera.id}-enabled`}
                  type="checkbox"
                  defaultChecked={camera.enabled !== false}
                />
              </div>
            ))}
            <label className="setup-confirm">
              Confirm household password
              <input
                name="householdPassword"
                type="password"
                required
                maxLength={128}
                autoComplete="current-password"
              />
            </label>
            <p className="muted">
              Connection, channel or Show changes reconnect the grid. Camera
              encoding stays under your Dahua settings.
            </p>
            <div className="capture-dialog-actions">
              <button className="secondary" type="button" onClick={onClose}>
                Cancel
              </button>
              <button className="primary" type="submit">
                {saving ? "Applying…" : "Save & apply"}
              </button>
            </div>
          </fieldset>
        </form>
      ) : !error ? (
        <p role="status">Loading setup…</p>
      ) : null}
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
    </dialog>
  );
}
