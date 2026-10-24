import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { once, on } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { Store } from '../apps/server/src/infrastructure/store.ts';
import { Vault } from '../apps/server/src/infrastructure/vault.ts';
import { createBackup, restoreBackup } from '../apps/server/src/infrastructure/backup.ts';
import { SnowLuma } from '../apps/server/src/adapters/snowluma.ts';
import { RefreshService } from '../apps/server/src/modules/refresh.ts';
import { Commands } from '../apps/server/src/modules/commands.ts';
import { Scheduler } from '../apps/server/src/modules/scheduler.ts';
import { MessagePlatforms } from '../apps/server/src/adapters/messages.ts';
import { createApp } from '../apps/server/src/api/app.ts';
import { channelDefaults } from '../packages/shared/types.ts';
import { driverCredentials, type DriverCredentials } from '../packages/shared/driver-auth.ts';
import { fakeSnowLuma } from './fixtures/snowluma.ts';
function setup(url: string, password = '', credentials?: DriverCredentials) {
  const store = new Store(':memory:', new Vault(undefined, randomBytes(32)));
  store.setValue('qq-driver', { apiUrl: url, desktopUrl: url, password: '' });
  const refresh = new RefreshService(store), commands = new Commands(store, refresh);
  const platforms = new MessagePlatforms(store, commands), scheduler = new Scheduler(store, refresh, commands, async () => {});
  const connection = { apiUrl: url, desktopUrl: url };
  const app = createApp(store, refresh, platforms, scheduler, { webRoot: '/no-web-fixture', password, driverCredentials: credentials, driverConnection: connection });
  const driver = new SnowLuma(store, credentials, connection);
  return { store, app, driver, refresh, platforms, scheduler, close: async () => { await scheduler.stop(); await platforms.stop(); await refresh.close(); await app.close(); store.close(); } };
}
async function until(condition: () => boolean) { for (let i = 0; i < 200; i++) { if (condition()) return; await delay(10); } throw new Error('fixture did not reach expected state'); }
test('驱动管理：首次认证、显式同意、改密、自动同步和凭据不出站', async () => {
  const fake = await fakeSnowLuma(), context = setup(fake.url), { app, store } = context;
  const post = (path: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/qq/driver/${path}`, payload });
  try {
    assert.equal((await app.inject('/api/qq/driver')).json().authenticated, false);
    assert.equal(fake.state.logins, 0);
    const wrong = await post('login', { password: 'wrong' }); assert.equal(wrong.statusCode, 409); assert.equal(wrong.body.includes(fake.state.password), false);
    assert.equal((await post('login', { password: fake.state.password })).statusCode, 200);
    const state = (await app.inject('/api/qq/driver')).json(); assert.equal(state.consentRequired, true); assert.equal(state.documents.length, 2); assert.equal(state.mustChangePassword, true);
    assert.equal(fake.state.calls.includes('GET /api/qq-list'), false);
    assert.equal((await post('consent', { version: 'fixture-version' })).statusCode, 400);
    assert.equal((await post('consent', { version: 'stale', confirmed: true })).statusCode, 409);
    assert.equal((await post('consent', { version: 'fixture-version', confirmed: true })).statusCode, 200);
    const weak = await post('password', { password: 'weak' }); assert.equal(weak.json().ok, false); assert.equal(weak.json().rules[0].ok, false);
    assert.equal(fake.state.mustChangePassword, true);
    const newPassword = 'SyntheticChanged!'; assert.equal((await post('password', { password: newPassword })).json().ok, true);
    const ready = await app.inject('/api/qq/driver'); assert.equal(ready.json().accounts[0].uin, '100001'); assert.equal(ready.json().processes[0].path, undefined);
    assert.equal(ready.body.includes(fake.state.token), false); assert.equal(ready.body.includes(newPassword), false);
    assert.equal(fake.state.logins, 3);
    store.saveChannel({ ...channelDefaults('qq'), allowedUsers: ['100002'], targets: [{ kind: 'private', id: '100002' }] });
    const linked = await post('connect', { uin: '100001', index: -1 }); assert.equal(linked.statusCode, 200); assert.equal(linked.json().reloaded, true);
    const saved = store.channel('qq'); assert.equal(saved.enabled, false); assert.deepEqual(saved.allowedUsers, ['100002']); assert.equal(saved.targets.length, 1);
    assert.match(saved.endpoint, /^ws:\/\/127.0.0.1:3001\/$/); assert.ok(store.channelToken('qq').length > 20);
    assert.deepEqual(fake.state.config.custom, { preserve: true }); assert.equal(fake.state.config.networks.httpServers[0].name, 'keep-http'); assert.equal(fake.state.config.networks.wsClients.length, 1);
    const networkResponse = await app.inject('/api/qq/driver/networks/100001'); assert.equal(networkResponse.json().networks[0].index, 0); assert.equal(networkResponse.body.includes(store.channelToken('qq')), false);
    assert.equal(linked.body.includes(store.channelToken('qq')), false);
    const logs = await app.inject('/api/qq/driver/logs'); assert.equal(logs.body.includes(newPassword), false); assert.equal(logs.body.includes(fake.state.token), false); assert.equal(logs.body.includes(store.channelToken('qq')), false); assert.match(logs.json().logs[0].message, /已隐藏/);
    assert.equal((await post('process', { pid: 1234, action: 'refresh' })).statusCode, 200);
    assert.equal((await post('process', { pid: 1234, action: 'unload' })).statusCode, 400);
    assert.equal((await app.inject('/api/state')).body.includes(newPassword), false);
  } finally { await context.close(); await fake.close(); }
});
test('连接同步保留现有 token，仅在需要时改配置，拒绝单向入口并报告未重载', async () => {
  const fake = await fakeSnowLuma(), context = setup(fake.url), { driver } = context;
  fake.state.consentRequired = false; fake.state.mustChangePassword = false;
  fake.state.config.networks.wsServers = [{ name: 'event only', role: 'Event', port: 3002 }, { name: 'existing', role: 'Universal', port: 3001, path: '/onebot', accessToken: 'fixture-existing-token', enabled: true, custom: 'keep' }];
  try {
    await driver.login(fake.state.password);
    assert.equal((await driver.networks('100001')).length, 1);
    await assert.rejects(driver.prepareConnection('100001', 0), /请选择/);
    const prepared = await driver.prepareConnection('100001', 1); assert.equal(prepared.token, 'fixture-existing-token'); assert.match(prepared.endpoint, /:3001\/onebot$/); assert.equal(fake.state.writes, 0);
    fake.state.config.networks.wsServers[1].enabled = false; fake.state.reloaded = false;
    assert.equal((await driver.prepareConnection('100001', 1)).reloaded, false); assert.equal(fake.state.writes, 1); assert.equal(fake.state.config.networks.wsServers[1].custom, 'keep');
    fake.state.config.networks.wsServers[1].path = '//bad'; await assert.rejects(driver.prepareConnection('100001', 1), /路径不正确/);
  } finally { await context.close(); await fake.close(); }
});
test('驱动密码跨 Vault 备份恢复后可重新认证，地址变化清密码', async () => {
  const fake = await fakeSnowLuma(), source = setup(fake.url), target = setup(fake.url);
  fake.state.consentRequired = false; fake.state.mustChangePassword = false;
  try {
    await source.driver.login(fake.state.password);
    const content = createBackup(source.store, 'synthetic-backup-pass'); restoreBackup(target.store, content, 'synthetic-backup-pass');
    const stored = target.store.getValue('qq-driver', { password: '' }); assert.notEqual(stored.password, source.store.getValue('qq-driver', { password: '' }).password);
    assert.equal(target.store.vault.decrypt(stored.password), fake.state.password); assert.equal((await target.driver.state()).authenticated, true);
    target.driver.saveSettings({ apiUrl: 'http://127.0.0.1:5098/', desktopUrl: fake.url }); assert.equal(target.driver.settings().hasPassword, false);
    assert.equal(content.includes(fake.state.password), false);
  } finally { await source.close(); await target.close(); await fake.close(); }
});
test('驱动写操作与备份互斥，驱动错误不登出 QuotaRadar', async () => {
  const fake = await fakeSnowLuma(), context = setup(fake.url, 'fixture-admin'), { app } = context;
  let release!: () => void; fake.state.loginWait = new Promise<void>(resolve => { release = resolve; });
  try {
    assert.equal((await app.inject('/api/qq/driver')).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/auth', payload: { password: 'fixture-admin' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const pending = app.inject({ method: 'POST', url: '/api/qq/driver/login', headers: { cookie }, payload: { password: 'wrong' } });
    const result = Promise.resolve(pending); await until(() => fake.state.logins === 1);
    const backup = await app.inject({ method: 'POST', url: '/api/backup', headers: { cookie }, payload: { password: 'fixture-backup' } }); assert.equal(backup.statusCode, 400); assert.match(backup.json().error, /正在/);
    const settings = await app.inject({ method: 'PUT', url: '/api/qq/driver/settings', headers: { cookie }, payload: { apiUrl: fake.url, desktopUrl: fake.url } }); assert.equal(settings.statusCode, 409);
    release(); assert.equal((await result).statusCode, 409); assert.equal((await app.inject({ url: '/api/state', headers: { cookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/qq/driver/login', headers: { cookie, origin: 'https://other.invalid' }, payload: { password: fake.state.password } })).statusCode, 403);
  } finally { release(); await context.close(); await fake.close(); }
});
test('地址切换期间的登录结果丢弃，不把旧管理 token 发给新地址', async () => {
  const fake = await fakeSnowLuma(), other = await fakeSnowLuma(), context = setup(fake.url);
  let release!: () => void; fake.state.loginWait = new Promise<void>(resolve => { release = resolve; });
  try {
    const pending = context.driver.login(fake.state.password); const rejected = assert.rejects(pending, /已经改变/);
    await until(() => fake.state.logins === 1);
    context.driver.saveSettings({ apiUrl: other.url, desktopUrl: other.url }); release(); await rejected;
    assert.equal(context.driver.settings().hasPassword, false); assert.equal(other.state.calls.length, 0);
  } finally { release(); await context.close(); await fake.close(); await other.close(); }
});
test('站内桌面代理：认证、相对资源、重定向、WebSocket 二进制和关闭清理', { timeout: 10000 }, async () => {
  const fake = await fakeSnowLuma(), context = setup(fake.url, 'fixture-admin'), { app } = context;
  let socket: WebSocket | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    assert.equal((await app.inject('/api/qq/desktop/vnc.html')).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/auth', payload: { password: 'fixture-admin' } }); const cookie = String(login.headers['set-cookie']).split(';')[0];
    const source = readFileSync(new URL('../apps/web/src/components/qq-driver.tsx', import.meta.url), 'utf8');
    const iframePath = source.match(/src="([^"]*vnc\.html\?[^"]+)"/)?.[1]; assert.ok(iframePath);
    const desktop = new URL(iframePath, address), path = desktop.searchParams.get('path'); assert.ok(path);
    const socketUrl = new URL(path, desktop); socketUrl.protocol = 'ws:';
    assert.equal(socketUrl.pathname, '/api/qq/desktop/websockify');
    assert.equal(desktop.searchParams.get('host'), '');
    const page = await app.inject({ url: `${desktop.pathname}${desktop.search}`, headers: { cookie } }); assert.equal(page.statusCode, 200); assert.match(page.body, /core\/fixture.js/); assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal((await app.inject({ url: '/api/qq/desktop/core/fixture.js', headers: { cookie } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/qq/desktop/redirect', headers: { cookie } })).headers.location, '/api/qq/desktop/vnc.html');
    assert.equal((await app.inject({ url: '/api/qq/desktop/external-redirect', headers: { cookie } })).statusCode, 502);
    const denied = async (headers: Record<string, string>) => {
      const rejected = new WebSocket(`${address.replace('http', 'ws')}/api/qq/desktop/websockify`, { headers });
      await assert.rejects(once(rejected, 'open'), /403/); rejected.terminate();
    };
    await denied({}); await denied({ cookie, origin: 'https://other.invalid' });
    socket = new WebSocket(socketUrl, ['binary'], { headers: { cookie, origin: address } });
    await once(socket, 'open'); const message = once(socket, 'message'); socket.send(Buffer.from([0, 1, 127, 255]));
    const [data, binary] = await message; assert.equal(binary, true); assert.deepEqual(Buffer.from(data), Buffer.from([0, 1, 127, 255]));
    const closed = once(socket, 'close'); await context.close(); await closed; socket = undefined;
  } finally { socket?.terminate(); if (app.server.listening) await context.close(); await fake.close(); }
});

test('管理员密码轮换：同一数据密钥下旧登录会话失效', async () => {
  const fake = await fakeSnowLuma(), context = setup(fake.url, 'fixture-admin-before');
  const rotated = createApp(context.store, context.refresh, context.platforms, context.scheduler, { webRoot: '/no-web-fixture', password: 'fixture-admin-after' });
  try {
    const login = await context.app.inject({ method: 'POST', url: '/api/auth', payload: { password: 'fixture-admin-before' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    assert.equal((await context.app.inject({ url: '/api/state', headers: { cookie } })).statusCode, 200);
    assert.equal((await rotated.inject({ url: '/api/state', headers: { cookie } })).statusCode, 401);
    const next = await rotated.inject({ method: 'POST', url: '/api/auth', payload: { password: 'fixture-admin-after' } });
    const fresh = String(next.headers['set-cookie']).split(';')[0];
    assert.equal((await rotated.inject({ url: '/api/state', headers: { cookie: fresh } })).statusCode, 200);
  } finally { await rotated.close(); await context.close(); await fake.close(); }
});

test('统一驱动认证：只登录 QuotaRadar，仍需明确同意协议且不能覆盖内部凭据', async () => {
  const credentials = driverCredentials('fixture-managed-admin'), fake = await fakeSnowLuma();
  fake.state.password = credentials.managementPassword; fake.state.mustChangePassword = false;
  const context = setup(fake.url, 'fixture-managed-admin', credentials), { app, store } = context;
  store.setValue('qq-driver', { apiUrl: 'http://example.invalid/', desktopUrl: 'http://example.invalid/', password: store.vault.encrypt('old-external-password') });
  try {
    assert.equal((await app.inject('/api/qq/driver')).statusCode, 401); assert.equal(fake.state.logins, 0);
    const login = await app.inject({ method: 'POST', url: '/api/auth', payload: { password: 'fixture-managed-admin' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const state = await app.inject({ url: '/api/qq/driver', headers: { cookie } });
    assert.equal(state.statusCode, 200); assert.equal(state.json().settings.managed, true);
    assert.equal(state.json().authenticated, true); assert.equal(state.json().consentRequired, true); assert.equal(state.json().mustChangePassword, false);
    assert.equal(fake.state.calls.includes('GET /api/qq-list'), false);
    for (const secret of Object.values(credentials)) assert.equal(state.body.includes(secret), false);
    for (const [url, payload] of [
      ['/api/qq/driver/login', { password: 'override' }], ['/api/qq/driver/password', { password: 'OverrideStrong!' }],
      ['/api/qq/driver/settings', { apiUrl: 'http://example.invalid/', desktopUrl: 'http://example.invalid/' }],
    ] as const) {
      const result = await app.inject({ method: url.endsWith('settings') ? 'PUT' : 'POST', url, headers: { cookie }, payload });
      assert.equal(result.statusCode, 409);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/api/qq/driver/consent', headers: { cookie }, payload: { version: 'fixture-version' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/qq/driver/consent', headers: { cookie }, payload: { version: 'fixture-version', confirmed: true } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/qq/driver', headers: { cookie } })).json().accounts.length, 1);
    const logs = await app.inject({ url: '/api/qq/driver/logs', headers: { cookie } });
    assert.equal(logs.body.includes(credentials.managementPassword), false);
    assert.equal(fake.state.password, credentials.managementPassword);
  } finally { await context.close(); await fake.close(); }
});

test('统一桌面认证：内部完成 VNC 密码握手，浏览器仅需管理员会话', { timeout: 10000 }, async () => {
  const credentials = driverCredentials('fixture-managed-admin');
  const fake = await fakeSnowLuma({ desktopPassword: credentials.desktopPassword });
  const context = setup(fake.url, 'fixture-managed-admin', credentials), { app } = context;
  let socket: WebSocket | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const denied = new WebSocket(`${address.replace('http', 'ws')}/api/qq/desktop/websockify`);
    await assert.rejects(once(denied, 'open'), /403/); denied.terminate(); assert.equal(fake.state.desktopLogins, 0);
    const login = await app.inject({ method: 'POST', url: '/api/auth', payload: { password: 'fixture-managed-admin' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    socket = new WebSocket(`${address.replace('http', 'ws')}/api/qq/desktop/websockify`, ['binary'], { headers: { cookie, origin: address } });
    const messages = on(socket, 'message');
    const next = async () => Buffer.from((await messages.next()).value![0]);
    await once(socket, 'open');
    assert.equal((await next()).toString(), 'RFB 003.008\n'); socket.send(Buffer.from('RFB 003.008\n'));
    assert.deepEqual(await next(), Buffer.from([1, 1])); socket.send(Buffer.from([1]));
    assert.deepEqual(await next(), Buffer.alloc(4)); socket.send(Buffer.from([1]));
    assert.equal((await next()).toString(), 'fixture-desktop'); assert.equal(fake.state.desktopLogins, 1); assert.equal(fake.state.desktopFailures, 0);
    const frame = Buffer.from([0, 1, 127, 255]); socket.send(frame); assert.deepEqual(await next(), frame);
    await messages.return?.();
    assert.equal(fake.state.consentRequired, true);
  } finally { socket?.terminate(); await context.close(); await fake.close(); }
});

test('统一桌面认证失败时关闭连接，不向浏览器降级为直接认证', { timeout: 10000 }, async () => {
  const credentials = driverCredentials('fixture-managed-admin'), fake = await fakeSnowLuma({ desktopPassword: 'wrong123' });
  const context = setup(fake.url, 'fixture-managed-admin', credentials), { app } = context;
  let socket: WebSocket | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 }); const address = app.listeningOrigin;
    const login = await app.inject({ method: 'POST', url: '/api/auth', payload: { password: 'fixture-managed-admin' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    socket = new WebSocket(`${address.replace('http', 'ws')}/api/qq/desktop/websockify`, { headers: { cookie, origin: address } });
    socket.once('message', () => socket!.send(Buffer.from('RFB 003.008\n')));
    const [code] = await once(socket, 'close'); assert.equal(code, 1008); assert.equal(fake.state.desktopFailures, 1);
  } finally { socket?.terminate(); await context.close(); await fake.close(); }
});
