import {parseEnv} from 'node:util';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const env = parseEnv(readFileSync('apps/web/.env.local', 'utf8'));
// An explicit allowlist keeps all NVR keys and the auth database at home.
for (const name of ['HOMEGRID_APP_ORIGIN', 'GATEWAY_URL', 'GATEWAY_SERVICE_TOKEN']) {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name}`);
  const child = spawn('vercel', ['env', 'add', name, 'production', '--sensitive', '--cwd', 'apps/web'], {stdio: ['pipe', 'inherit', 'inherit']});
  child.stdin.end(value);
  await new Promise<void>((resolve, reject) => {child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Could not configure ${name}`)));});
}
console.log('Three frontend variables configured for production only. No NVR credentials were uploaded.');
