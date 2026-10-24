import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
export function setup() {
  const target = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(target)) { console.log('保留已有 .env，不覆盖配置。'); return target; }
  const password = randomBytes(18).toString('base64url');
  writeFileSync(target, `QR_ADMIN_PASSWORD=${password}\nQR_BIND_ADDRESS=127.0.0.1\nQR_PORT=3210\nSNOWLUMA_IMAGE=motricseven7/snowluma:v1.10.0\n`, { flag: 'wx', mode: 0o600 });
  console.log('已生成 .env，管理密码保存在 QR_ADMIN_PASSWORD。请用编辑器查看该文件。');
  return target;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) setup();
