import "server-only";
export function gatewayConfigured() {
  return Boolean(
    process.env.GATEWAY_URL &&
    process.env.GATEWAY_SERVICE_TOKEN &&
    process.env.HOMEGRID_APP_ORIGIN,
  );
}
export async function gateway(path: string, init: RequestInit = {}) {
  if (!gatewayConfigured()) throw new Error("Gateway not configured");
  const base = new URL(process.env.GATEWAY_URL!);
  if (
    base.protocol !== "https:" &&
    (process.env.VERCEL || !["localhost", "127.0.0.1"].includes(base.hostname))
  )
    throw new Error("Gateway must use HTTPS");
  if (
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error("Invalid gateway origin");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${process.env.GATEWAY_SERVICE_TOKEN}`);
  headers.set("Origin", process.env.HOMEGRID_APP_ORIGIN!);
  return fetch(new URL(path, base), {
    ...init,
    headers,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(25000),
  });
}
