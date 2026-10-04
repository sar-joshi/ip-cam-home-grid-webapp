import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { camerasSchema, type Camera } from '@homegrid/shared';
import { z } from 'zod';

export interface Config {
  appOrigin: string; serviceToken: string; authSecret: string; stateDir: string;
  host: string; port: number; cameras: Camera[]; nvrHost: string; nvrPort: number;
  nvrUser: string; nvrPassword: string; mediaBinary: string; mediaPort: number;
  mediaSecret: string; iceHost: string; icePort: number;
}
const secret = z.string().min(43).max(256);
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const app = new URL(z.string().url().parse(env.HOMEGRID_APP_ORIGIN));
  if (app.origin !== app.href.replace(/\/$/, '') || (app.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(app.hostname))) {
    throw new Error('HOMEGRID_APP_ORIGIN must be an HTTPS origin (HTTP loopback is allowed for development)');
  }
  const nvrHost = z.string().min(1).parse(env.NVR_HOST);
  if (!isIP(nvrHost) && !/^[a-zA-Z0-9.-]+$/.test(nvrHost)) throw new Error('NVR_HOST must be a host without a URL or credentials');
  const iceHost = z.string().min(1).parse(env.GATEWAY_LAN_IP);
  if (!isIP(iceHost)) throw new Error('GATEWAY_LAN_IP must be the gateway LAN address');
  return {
    appOrigin: app.origin, serviceToken: secret.parse(env.GATEWAY_SERVICE_TOKEN), authSecret: secret.parse(env.BETTER_AUTH_SECRET),
    stateDir: resolve(env.HOMEGRID_STATE_DIR ?? 'state'), host: env.GATEWAY_BIND_HOST ?? '127.0.0.1',
    port: z.coerce.number().int().min(1024).max(65535).parse(env.GATEWAY_PORT ?? '8787'),
    cameras: camerasSchema.parse(env.CAMERAS_JSON ? JSON.parse(env.CAMERAS_JSON) : Array.from({length: 6}, (_, i) => ({id: `cam-${i+1}`, name: `Camera ${i+1}`, channel: i+1}))),
    nvrHost, nvrPort: z.coerce.number().int().min(1).max(65535).parse(env.NVR_PORT ?? '554'),
    nvrUser: z.string().min(1).max(256).parse(env.NVR_USERNAME), nvrPassword: z.string().min(1).max(256).parse(env.NVR_PASSWORD),
    mediaBinary: resolve(env.MEDIAMTX_BINARY ?? '.tools/mediamtx'),
    mediaPort: z.coerce.number().int().min(1024).max(65535).parse(env.MEDIAMTX_HTTP_PORT ?? '8889'),
    mediaSecret: secret.parse(env.MEDIAMTX_SECRET ?? env.GATEWAY_SERVICE_TOKEN),
    iceHost, icePort: z.coerce.number().int().min(1024).max(65535).parse(env.GATEWAY_ICE_PORT ?? '8189'),
  };
}
export function rtspUrl(config: Config, channel: number, quality: string): string {
  const host = isIP(config.nvrHost) === 6 ? `[${config.nvrHost}]` : config.nvrHost;
  const url = new URL(`rtsp://${host}:${config.nvrPort}/cam/realmonitor`);
  url.username = encodeURIComponent(config.nvrUser);
  url.password = encodeURIComponent(config.nvrPassword);
  url.searchParams.set('channel', String(channel));
  url.searchParams.set('subtype', quality);
  return url.toString();
}
