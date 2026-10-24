import { randomBytes } from 'node:crypto';
import { Store } from '../apps/server/src/infrastructure/store.ts';
import { Vault } from '../apps/server/src/infrastructure/vault.ts';
import { RefreshService } from '../apps/server/src/modules/refresh.ts';
import { Commands } from '../apps/server/src/modules/commands.ts';
import { Scheduler } from '../apps/server/src/modules/scheduler.ts';
import { MessagePlatforms } from '../apps/server/src/adapters/messages.ts';
import { createApp } from '../apps/server/src/api/app.ts';
import { fakeSnowLuma } from './fixtures/snowluma.ts';

const fake = await fakeSnowLuma();
const store = new Store(':memory:', new Vault(undefined, randomBytes(32)));
store.setValue('qq-driver', { apiUrl: fake.url, desktopUrl: fake.url, password: '' });
const refresh = new RefreshService(store), commands = new Commands(store, refresh), platforms = new MessagePlatforms(store, commands);
const scheduler = new Scheduler(store, refresh, commands, async () => {});
const app = createApp(store, refresh, platforms, scheduler, { webRoot: '/no-web-fixture', password: '' });
await app.listen({ host: '127.0.0.1', port: Number(process.env.QR_FIXTURE_PORT || 3211) });
console.log(`Isolated browser fixture: ${app.listeningOrigin}; synthetic driver password: ${fake.state.password}`);
let closing = false;
async function close() {
  if (closing) return; closing = true; clearTimeout(lifetime);
  await scheduler.stop(); await platforms.stop(); await refresh.close(); await app.close(); store.close(); await fake.close();
}
const lifetime = setTimeout(() => { void close(); }, 15 * 60 * 1000);
process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
