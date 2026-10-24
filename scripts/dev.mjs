import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const env = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(env)) process.loadEnvFile(env);
const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
if (!existsSync(vite)) { console.error('依赖尚未安装。取得安装许可后，在项目目录执行 npm install。'); process.exit(1); }
const children = [
  spawn(process.execPath, ['--import', 'tsx', '--watch', 'apps/server/src/main.ts'], { cwd: root, stdio: 'inherit', env: { ...process.env, HOST: '127.0.0.1' } }),
  spawn(process.execPath, [vite, '--config', 'apps/web/vite.config.ts'], { cwd: root, stdio: 'inherit' }),
];
let stopping = false;
const stop = () => { if (stopping) return; stopping = true; for (const child of children) child.kill(); };
for (const child of children) { child.on('error', stop); child.on('exit', code => { if (!stopping) { process.exitCode = code ?? 1; stop(); } }); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
