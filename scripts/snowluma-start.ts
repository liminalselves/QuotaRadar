import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { driverCredentials } from '../packages/shared/driver-auth.ts';

export function prepareSnowLuma(directory: string, adminPassword: string) {
  const credentials = driverCredentials(adminPassword);
  const config = join(directory, 'config'); mkdirSync(config, { recursive: true });
  const authPath = join(config, 'webui.json');
  let previous: Record<string, unknown> = {};
  if (existsSync(authPath)) {
    try {
      previous = JSON.parse(readFileSync(authPath, 'utf8'));
      if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new Error();
    } catch { throw new Error('SnowLuma 管理配置无法解析，原文件未更改'); }
  }
  const salt = randomBytes(16), now = new Date().toISOString();
  const auth = { ...previous,
    passwordHash: scryptSync(credentials.managementPassword, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex'),
    passwordSalt: salt.toString('hex'), mustChangePassword: false,
    generatedAt: previous.generatedAt || now, updatedAt: now,
  };
  const temporary = `${authPath}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(auth, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); renameSync(temporary, authPath);
  const runtime = join(config, 'runtime.json');
  if (!existsSync(runtime)) writeFileSync(runtime, '{}\n', { flag: 'wx', mode: 0o600 });
  return credentials;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const credentials = prepareSnowLuma(process.env.SNOWLUMA_DATA || '/app/snowluma-data', process.env.QR_ADMIN_PASSWORD || '');
    const env: NodeJS.ProcessEnv = { ...process.env, VNC_PASSWD: credentials.desktopPassword };
    delete env.QR_ADMIN_PASSWORD;
    // Development mode bypasses persisted WebUI authentication.
    delete env.SNOWLUMA_DEV_MODE;
    const child = spawn('/root/start.sh', [], { stdio: 'inherit', env });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
    child.once('error', () => { console.error('无法启动 SnowLuma 官方启动脚本'); process.exitCode = 1; });
    child.once('exit', code => { process.exitCode = code ?? 1; });
  } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
