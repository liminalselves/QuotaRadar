import { chmodSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = ['scripts/snowluma-start.ts', 'packages/shared/driver-auth.ts'];

export function exportDriverAssets(target: string): void {
  for (const asset of assets) readFileSync(join(root, asset));
  for (const asset of assets) {
    const destination = join(target, asset);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
    copyFileSync(join(root, asset), destination); chmodSync(destination, 0o644);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('请输入驱动启动资源输出目录');
  exportDriverAssets(resolve(process.argv[2]));
  console.log('Managed driver startup assets prepared.');
}
