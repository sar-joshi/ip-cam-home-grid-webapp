"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="gate">
      <section className="gate-card">
        <h1>HomeGrid is unavailable</h1>
        <p className="muted">Try again when your home gateway is connected.</p>
        <button className="primary" onClick={reset}>
          Try again
        </button>
      </section>
    </main>
  );
}
