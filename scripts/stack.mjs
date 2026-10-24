import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setup } from './setup.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const action = process.argv[2] ?? 'up';
const qq = !process.argv.includes('--without-qq');
const commands = {
  up: ['up', '-d', '--build'], down: ['stop'], status: ['ps'], logs: ['logs', '--tail', '80'],
};
if (!Object.hasOwn(commands, action)) { console.error('用法：node scripts/stack.mjs up|down|status|logs [--without-qq]'); process.exit(1); }
const envFile = action === 'up' ? setup() : fileURLToPath(new URL('../.env', import.meta.url));
const args = ['compose', '--env-file', envFile, '-f', fileURLToPath(new URL('../compose.yaml', import.meta.url)), ...(action === 'up' ? ['-f', fileURLToPath(new URL('../compose.build.yaml', import.meta.url))] : []), ...(qq ? ['--profile', 'qq'] : []), ...commands[action]];
const child = spawn('docker', args, { cwd: root, stdio: 'inherit' });
child.on('error', () => { console.error('无法运行 Docker，请确认 Docker 已安装并启动。'); process.exitCode = 1; });
child.on('exit', code => {
  process.exitCode = code ?? 1;
  if (!code && action === 'up') {
    console.log('管理台：http://localhost:3210/ （端口若已修改，以 .env 为准）');
    if (qq) console.log('QQ 接入：进入管理台 → 消息平台 → QQ，确认驱动协议、扫码登录并自动配置连接。\n驱动和桌面认证由 QuotaRadar 统一管理，不需要额外密码；原始驱动端口不对宿主机开放。');
  }
});
