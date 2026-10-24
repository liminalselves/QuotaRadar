import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Store } from '../apps/server/src/infrastructure/store.ts';
import { Vault } from '../apps/server/src/infrastructure/vault.ts';
import { RefreshService } from '../apps/server/src/modules/refresh.ts';
import { Commands } from '../apps/server/src/modules/commands.ts';
import { Scheduler } from '../apps/server/src/modules/scheduler.ts';
import { MessagePlatforms } from '../apps/server/src/adapters/messages.ts';
import { createApp } from '../apps/server/src/api/app.ts';
import { providerDefaults, channelDefaults } from '../packages/shared/types.ts';
const fakeQuota = { total: '100', used: '10', remaining: '90', unlimited: false, unit: 'USD', scope: 'token' as const, accuracy: 'confirmed' as const, status: '已启用', active: true, expiresAt: null, period: null, raw: {} };
function setup(password = '') {
  const store = new Store(':memory:', new Vault(undefined, randomBytes(32)));
  const refresh = new RefreshService(store, async () => fakeQuota), commands = new Commands(store, refresh);
  const platforms = new MessagePlatforms(store, commands), scheduler = new Scheduler(store, refresh, commands, async () => {});
  const app = createApp(store, refresh, platforms, scheduler, { webRoot: '/does-not-exist-quotaradar', password });
  return { store, refresh, platforms, scheduler, app, close: async () => { await scheduler.stop(); await platforms.stop(); await refresh.close(); await app.close(); store.close(); } };
}
test('API 真实路由：供应商、批量预览、Key、刷新、历史、删除影响', async () => {
  const context = setup(); const { app, refresh } = context;
  try {
    const providerResponse = await app.inject({ method: 'POST', url: '/api/providers', payload: { ...providerDefaults('newapi-cx'), name: '本地测试', baseUrl: 'https://example.invalid', scope: 'token' } });
    assert.equal(providerResponse.statusCode, 200); const provider = providerResponse.json();
    const payload = { providerId: provider.id, preview: true, rows: [{ name: '一', secret: 'test-secret-one' }, { name: '重复', secret: 'test-secret-one' }] };
    const preview = await app.inject({ method: 'POST', url: '/api/keys/import', payload });
    assert.equal(preview.statusCode, 200); assert.equal(preview.json().rows[1].duplicate, true);
    assert.equal(preview.body.includes('test-secret-one'), false);
    const imported = await app.inject({ method: 'POST', url: '/api/keys/import', payload: { ...payload, preview: false } }); assert.equal(imported.json().added, 1);
    let state = (await app.inject('/api/state')).json(); assert.equal(state.keys.length, 1);
    const key = state.keys[0];
    assert.equal((await app.inject({ method: 'POST', url: '/api/refresh', payload: { ids: [key.id] } })).statusCode, 200);
    await refresh.wait([key.id]); state = (await app.inject('/api/state')).json(); assert.equal(state.keys[0].latest.remaining, '90');
    assert.equal((await app.inject(`/api/keys/${key.id}/history`)).json().snapshots.length, 1);
    assert.deepEqual((await app.inject(`/api/providers/${provider.id}/impact`)).json(), { keys: 1, snapshots: 1 });
    assert.equal(state.keys[0].secret, undefined);
    await app.inject({ method: 'DELETE', url: `/api/providers/${provider.id}` }); assert.equal((await app.inject('/api/state')).json().keys.length, 0);
  } finally { await context.close(); }
});
test('管理员登录、错误口令、同源校验和字段校验', async () => {
  const context = setup('test-admin-password'); const { app } = context;
  try {
    assert.equal((await app.inject('/api/state')).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth', payload: { password: 'wrong' } })).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/auth', payload: { password: 'test-admin-password' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    assert.equal((await app.inject({ url: '/api/state', headers: { cookie } })).statusCode, 200);
    const badOrigin = await app.inject({ method: 'POST', url: '/api/providers', headers: { cookie, origin: 'https://other.invalid' }, payload: {} }); assert.equal(badOrigin.statusCode, 403);
    const invalid = await app.inject({ method: 'POST', url: '/api/providers', headers: { cookie }, payload: { ...providerDefaults(), name: 'bad', baseUrl: 'file:///etc/passwd' } }); assert.equal(invalid.statusCode, 400);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: {} })).statusCode, 400);
  } finally { await context.close(); }
});
test('OneBot 本地 WebSocket：状态、文本收发、echo、重复事件只处理一次', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const context = setup(); const { store, platforms } = context;
  let sends = 0;
  let finish!: () => void;
  const received = new Promise<void>(resolve => { finish = resolve; });
  const timeout = setTimeout(() => finish(), 5000);
  try {
    store.saveChannel({ ...channelDefaults('qq'), enabled: true, token: 'test-only', endpoint: `ws://127.0.0.1:${port}/`, allowedUsers: ['123'] });
    server.on('connection', (socket, request) => {
      assert.equal(request.headers.authorization, 'Bearer test-only');
      socket.on('message', raw => {
        const action = JSON.parse(raw.toString());
        socket.send(JSON.stringify({ echo: action.echo, retcode: 0, status: 'ok', data: action.action === 'get_status' ? { online: true } : { message_id: 2 } }));
        if (action.action === 'send_private_msg') { sends++; assert.match(action.params.message[0].data.text, /QuotaRadar/); finish(); }
      });
      const event = { post_type: 'message', message_type: 'private', self_id: 999, user_id: 123, message_id: 100, message: [{ type: 'text', data: { text: '/status' } }] };
      socket.send(JSON.stringify(event)); socket.send(JSON.stringify(event));
    });
    await platforms.configure(); await received; clearTimeout(timeout);
    assert.equal(sends, 1); assert.equal(platforms.status.qq.connected, true);
  } finally { clearTimeout(timeout); await context.close(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
