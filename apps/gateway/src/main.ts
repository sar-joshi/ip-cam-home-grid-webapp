import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { readConfig } from './config.ts';
import { openDatabase } from './database.ts';
import { makeAuth, migrateAuth } from './auth.ts';
import { Media } from './media.ts';
import { makeServer } from './server.ts';

if (existsSync('gateway.env')) loadEnvFile('gateway.env');
process.umask(0o077);
let stop: (() => Promise<void>) | undefined;
try {
  const config = readConfig();
  const db = openDatabase(config.stateDir);
  await migrateAuth(makeAuth(config, db));
  if (!(db.prepare('SELECT id FROM user LIMIT 1').get())) throw new Error('Run npm run setup to create the household password first');
  const media = new Media(config, db);
  const server = makeServer(config, db, media);
  stop = async () => {await server.close(); await media.close(); db.close();};
  await media.start();
  await server.listen({host: config.host, port: config.port});
  console.log(`HomeGrid gateway ready on ${config.host}:${config.port}. Camera connections start on demand.`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {void stop?.().then(() => process.exit(0));});
} catch {
  console.error('HomeGrid gateway could not start. Check private environment settings, setup, and media binary/ports. Secrets are not logged.');
  await stop?.();
  process.exitCode = 1;
}
