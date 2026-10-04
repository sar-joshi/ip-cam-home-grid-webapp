"use client";
import { Brand, Icon } from "./icon";
export function GatewayOffline() {
  return (
    <main className="gate">
      <div className="gate-brand">
        <Brand />
      </div>
      <section className="gate-card">
        <span className="gate-icon">
          <Icon name="camera" size={26} />
        </span>
        <h1>Home gateway offline</h1>
        <p className="muted">
          Check that the computer running your gateway is awake and connected to
          your home network.
        </p>
        <button className="primary" onClick={() => window.location.reload()}>
          Try again
          <Icon name="retry" />
        </button>
      </section>
    </main>
  );
}
