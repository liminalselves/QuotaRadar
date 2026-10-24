import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault } from './infrastructure/vault.ts';
import { Store } from './infrastructure/store.ts';
import { RefreshService } from './modules/refresh.ts';
import { Commands } from './modules/commands.ts';
import { MessagePlatforms } from './adapters/messages.ts';
import { Scheduler } from './modules/scheduler.ts';
import { createApp } from './api/app.ts';
import { driverCredentials } from '../../../packages/shared/driver-auth.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const data = resolve(process.env.QR_DATA_DIR || resolve(root, 'data'));
mkdirSync(data, { recursive: true });
const store = new Store(resolve(data, 'quotaradar.sqlite'), new Vault(data));
const refresh = new RefreshService(store);
const commands = new Commands(store, refresh);
const platforms = new MessagePlatforms(store, commands);
const scheduler = new Scheduler(store, refresh, commands, (target, text) => platforms.send(target, text));
const password = process.env.QR_ADMIN_PASSWORD || '';
const app = createApp(store, refresh, platforms, scheduler, { webRoot: resolve(root, 'dist/web'), password,
  driverCredentials: process.env.QR_MANAGED_SNOWLUMA === '1' ? driverCredentials(password) : undefined });
const port = Number(process.env.PORT || 3210);
const host = process.env.HOST || '127.0.0.1';
await app.listen({ port, host });
await platforms.configure(); scheduler.start();
console.log(`QuotaRadar 已启动：http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
let closing = false;
async function close(): Promise<void> {
  if (closing) return; closing = true;
  await scheduler.stop(); await platforms.stop(); await refresh.close(); await app.close(); store.close();
}
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
