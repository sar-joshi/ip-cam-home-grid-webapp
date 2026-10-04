"use client";
import { useState, type FormEvent } from "react";
import { Brand, Icon } from "./icon";
export function Login() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const password = String(new FormData(form).get("password") ?? "");
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result.error ?? "Unable to unlock. Try again.");
        return;
      }
      form.reset();
      window.location.replace("/");
    } catch {
      setError("Unable to connect. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="gate">
      <div className="gate-brand">
        <Brand />
      </div>
      <section className="gate-card" aria-labelledby="unlock-title">
        <span className="gate-icon">
          <Icon name="lock" size={26} />
        </span>
        <p className="eyebrow">PRIVATE LIVE VIEW</p>
        <h1 id="unlock-title">Unlock HomeGrid</h1>
        <p className="muted">
          Enter your household password to view your cameras.
        </p>
        <form onSubmit={unlock}>
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
            autoFocus
            disabled={busy}
            aria-describedby={error ? "login-error" : undefined}
          />
          {error ? (
            <p id="login-error" className="error-text" role="alert">
              {error}
            </p>
          ) : null}
          <button className="primary" disabled={busy} type="submit">
            {busy ? "Unlocking…" : "Unlock cameras"}
            <Icon name="lock" size={16} />
          </button>
        </form>
        <p className="gate-note">
          <span className="small-dot" />
          Private camera access
        </p>
      </section>
      <p className="gate-footer">HomeGrid · Home camera viewer</p>
    </main>
  );
}
