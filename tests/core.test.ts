import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { add, compare, decimal, divide, subtract } from '../packages/shared/amount.ts';
import { defaultSettings, providerDefaults } from '../packages/shared/types.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import type { KeyInput, Provider, Quota } from '../packages/shared/types.ts';
import { queryQuota, QuotaError } from '../apps/server/src/adapters/quota.ts';
import { Store } from '../apps/server/src/infrastructure/store.ts';
import { Vault, mask } from '../apps/server/src/infrastructure/vault.ts';
import { backupMaxBytes, createBackup, restoreBackup } from '../apps/server/src/infrastructure/backup.ts';
import { RefreshService } from '../apps/server/src/modules/refresh.ts';
import { Commands, splitMessage } from '../apps/server/src/modules/commands.ts';
import { Scheduler } from '../apps/server/src/modules/scheduler.ts';
const secret = 'sk-test-only-not-a-real-api-key-0001';
const provider = (adapter: Provider['adapter'] = 'newapi-cx'): Provider => ({ ...providerDefaults(adapter), id: 'provider', version: 1, createdAt: new Date().toISOString(), baseUrl: 'https://example.invalid', name: '测试站点', scope: 'token' });
const quota = (remaining = '10'): Quota => ({ total: '100', used: '90', remaining, unit: 'USD', scope: 'token', accuracy: 'confirmed', unlimited: false, status: '已启用', active: true, expiresAt: null, period: null, raw: {} });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const fixture = (available = 2598500000) => ({ success: true, data: { status: { is_active: true, description: '已启用' }, quota: { total_granted: 21150500000, total_used: 18552000000, total_available: available, unlimited_quota: false }, time: { expires_at: -1 } } });
function context() {
  const store = new Store(':memory:', new Vault(undefined, randomBytes(32)));
  const p = store.saveProvider({ ...providerDefaults('newapi-cx'), name: '测试站点', baseUrl: 'https://example.invalid', scope: 'token' });
  const keyInput: KeyInput = { providerId: p.id, name: '主用', secret, enabled: true, tags: [], threshold: null, aggregation: 'independent', balanceGroup: '' };
  const key = store.saveKey(keyInput);
  return { store, p, key, keyInput };
}
test('精确金额、单位换算、舍入和非法输入', () => {
  assert.equal(divide('2598500000', '500000'), '5197');
  assert.equal(add('0.1', '0.2'), '0.3'); assert.equal(subtract('0.3', '0.1'), '0.2');
  assert.equal(divide('1', '3'), '0.333333333333'); assert.equal(divide('-2', '3'), '-0.666666666667');
  assert.equal(compare('99999999999999999', '99999999999999998'), 1); assert.equal(decimal('000.0100'), '0.01');
  assert.throws(() => divide('1', '0')); assert.throws(() => decimal('NaN')); assert.throws(() => decimal('1e6'));
});
test('CX 新版响应、鉴权 body 和站点 headers', async () => {
  const p = provider();
  const result = await queryQuota(p, secret, async (url, init) => {
    assert.equal(String(url), 'https://example.invalid/api/token/cx'); assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { token: secret });
    assert.equal((init?.headers as any).Origin, 'https://example.invalid');
    assert.equal((init?.headers as any).Authorization, undefined); return json(fixture());
  });
  assert.equal(result.remaining, '5197'); assert.equal(result.total, '42301'); assert.equal(result.expiresAt, null);
});
test('上游 usage、无限额度和缺失字段', async () => {
  const result = await queryQuota(provider('newapi-usage'), secret, async (_url, init) => {
    assert.equal((init?.headers as any).Authorization, `Bearer ${secret}`);
    return json({ code: true, data: { total_granted: -1, total_used: 500000, total_available: -1, unlimited_quota: true, expires_at: 0 } });
  });
  assert.equal(result.unlimited, true); assert.equal(result.remaining, null); assert.equal(result.total, null); assert.equal(result.used, '1');
  const partial = await queryQuota(provider('newapi-usage'), secret, async () => json({ data: { total_available: 0 } }));
  assert.equal(partial.total, null); assert.equal(partial.used, null); assert.equal(partial.remaining, '0');
});
test('Billing 分转美元且默认估算，查询日期可追溯', async () => {
  let calls = 0;
  const result = await queryQuota(provider('openai-billing'), secret, async url => {
    calls++; if (String(url).includes('subscription')) return json({ soft_limit_usd: 100 });
    assert.match(String(url), /start_date=2026-07-20&end_date=2026-10-18/); return json({ total_usage: 1234 });
  }, new Date('2026-10-18T00:00:00Z'));
  assert.equal(calls, 2); assert.equal(result.used, '12.34'); assert.equal(result.remaining, '87.66'); assert.equal(result.accuracy, 'estimated');
});
test('业务失败、HTML、缺字段、非法数值都不伪造零', async () => {
  for (const response of [json({ success: false }), new Response('<html>login</html>'), json({ data: {} }), json({ data: { quota: { total_available: 'invalid' } } })]) {
    await assert.rejects(queryQuota(provider(), secret, async () => response), QuotaError);
  }
  await assert.rejects(queryQuota(provider('openai-billing'), secret, async () => json({ soft_limit_usd: 10 })), /缺少/);
});
test('HTTP 错误分类，限流遵守 Retry-After，401 不重试', async () => {
  let calls = 0;
  await assert.rejects(queryQuota(provider(), secret, async () => { calls++; return json({}, 401); }), e => e instanceof QuotaError && e.kind === 'unauthorized');
  assert.equal(calls, 1);
  await assert.rejects(queryQuota(provider(), secret, async () => new Response('', { status: 429, headers: { 'retry-after': '12' } })), e => e instanceof QuotaError && e.retryAfterMs === 12000);
  await assert.rejects(queryQuota(provider(), secret, async () => json({}, 404)), e => e instanceof QuotaError && e.kind === 'not_found');
});
test('真实本地 HTTP 请求走 CX 适配器，不接触外站', async () => {
  const server = createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
      assert.equal(request.url, '/prefix/api/token/cx'); assert.equal(JSON.parse(body).token, secret);
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(fixture()));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const q = await queryQuota({ ...provider(), baseUrl: `http://127.0.0.1:${address.port}/prefix` }, secret);
    assert.equal(q.remaining, '5197');
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});
test('凭据加密、掩码、重复检测和凭据更换版本', () => {
  const { store, key, keyInput } = context();
  try {
    assert.equal(store.secret(key.id), secret); assert.equal(key.mask, mask(secret)); assert.equal(JSON.stringify(key).includes(secret), false);
    assert.throws(() => store.saveKey(keyInput), /相同/);
    const saved = store.saveKey({ ...keyInput, secret: `${secret}-new` }, key.id); assert.equal(saved.revision, 2);
    assert.equal(store.saveKey({ ...keyInput, name: '改名', secret: `${secret}-new` }, key.id).revision, 2);
    const encrypted = (store.db.prepare('SELECT secret FROM api_keys').get() as any).secret; assert.notEqual(encrypted, secret);
  } finally { store.close(); }
});
test('密钥文件首次创建、重复使用，已有数据库缺密钥时拒绝重新生成', t => {
  const directory = mkdtempSync(join(tmpdir(), 'quotaradar-密钥-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const keyPath = join(directory, 'vault.key'), databasePath = join(directory, 'quotaradar.sqlite');
  const vault = new Vault(directory);
  assert.equal(vault.key.length, 32); assert.deepEqual(new Vault(directory).key, vault.key);
  rmSync(keyPath); writeFileSync(databasePath, 'existing-database-placeholder');
  assert.throws(() => new Vault(directory), /密钥文件|vault.key/);
  assert.equal(existsSync(keyPath), false); assert.equal(readFileSync(databasePath, 'utf8'), 'existing-database-placeholder');
  writeFileSync(keyPath, Buffer.alloc(3)); assert.throws(() => new Vault(directory), /损坏/);
});
test('共享余额去重、不同单位分开、未知和无限不汇总', () => {
  const { store, p, key, keyInput } = context();
  try {
    store.saveSnapshot(key, p, quota('10'));
    const key2 = store.saveKey({ ...keyInput, secret: `${secret}-two`, name: '备用', aggregation: 'shared', balanceGroup: '账户一' });
    const key3 = store.saveKey({ ...keyInput, secret: `${secret}-three`, name: '第三', aggregation: 'shared', balanceGroup: '账户一' });
    store.saveSnapshot(key2, p, quota('20')); store.saveSnapshot(key3, p, quota('20'));
    assert.equal(store.totals()[0].remaining, '30'); assert.equal(store.totals()[0].count, 2);
    store.saveSnapshot(key, p, { ...quota(), unlimited: true, remaining: null }); assert.equal(store.totals()[0].remaining, '20');
    store.saveSnapshot(key2, p, { ...quota('20'), unit: 'CNY' }); assert.equal(store.totals().length, 2);
  } finally { store.close(); }
});
test('余额增加不是负消费，修改凭据后切分历史', () => {
  const { store, p, key, keyInput } = context();
  try {
    assert.equal(store.saveSnapshot(key, p, quota('10')).delta, null);
    assert.equal(store.saveSnapshot(key, p, quota('15')).delta, '5');
    const changed = store.saveKey({ ...keyInput, secret: `${secret}-changed` }, key.id);
    assert.equal(store.views()[0].latest, null); assert.equal(store.saveSnapshot(changed, p, quota('2')).delta, null);
    assert.equal(store.history(key.id).length, 3);
  } finally { store.close(); }
});
test('同 Key 并发合并、供应商内串行、全局并发有上限', async () => {
  const { store, key, keyInput } = context(); let calls = 0, active = 0, maximum = 0;
  const refresh = new RefreshService(store, async () => { calls++; active++; maximum = Math.max(active, maximum); await new Promise(resolve => setTimeout(resolve, 10)); active--; return quota(); });
  try {
    const key2 = store.saveKey({ ...keyInput, secret: `${secret}-two`, name: '二' });
    refresh.start([key.id, key2.id], 'web'); refresh.start([key.id], 'qq'); refresh.start([key.id], 'schedule');
    await refresh.wait([key.id, key2.id]); assert.equal(calls, 2); assert.equal(maximum, 1); assert.equal(store.history(key.id).length, 1);
  } finally { await refresh.close(); store.close(); }
});
test('查询失败保留旧快照，禁用或修改后迟到结果不覆盖', async () => {
  const { store, p, key, keyInput } = context(); store.saveSnapshot(key, p, quota('42'));
  let resolve!: (q: Quota) => void;
  const refresh = new RefreshService(store, () => new Promise(done => { resolve = done; }));
  try {
    refresh.start([key.id], 'web'); store.saveKey({ ...keyInput, enabled: false }, key.id); resolve(quota('1'));
    await refresh.wait([key.id]); assert.equal(store.latest(key.id)?.remaining, '42'); assert.equal(store.lastTask(key.id)?.state, 'cancelled');
  } finally { await refresh.close(); store.close(); }
});
test('失败记录保留成功数据且不进入合计', async () => {
  const { store, p, key } = context(); store.saveSnapshot(key, p, quota('42'));
  const refresh = new RefreshService(store, async () => { throw new QuotaError('network', '网络故障'); });
  try {
    refresh.start([key.id], 'web'); await refresh.wait([key.id]);
    assert.equal(store.views()[0].latest?.remaining, '42'); assert.equal(store.lastTask(key.id)?.state, 'failed'); assert.deepEqual(store.totals(), []);
  } finally { await refresh.close(); store.close(); }
});
test('重启将未完成任务标记取消', () => {
  const { store, key } = context();
  try {
    store.saveTask({ id: 'unfinished', keyId: key.id, keyRevision: 1, providerVersion: 1, batchId: 'b', source: 'web', state: 'running', createdAt: new Date().toISOString(), finishedAt: null, error: null, errorKind: null });
    store.recoverTasks(); assert.equal(store.lastTask(key.id)?.state, 'cancelled');
  } finally { store.close(); }
});
test('加密备份跨 vault 恢复且错误口令不影响原数据', () => {
  const { store, p, key } = context(); const target = new Store(':memory:', new Vault(undefined, randomBytes(32)));
  try {
    store.saveSnapshot(key, p, quota()); store.saveChannel({ platform: 'qq', enabled: false, token: secret, endpoint: 'ws://localhost:3001/', allowedUsers: [], allowedGroups: [], targets: [] });
    const backup = createBackup(store, 'test-password-123'); assert.equal(backup.includes(secret), false);
    assert.throws(() => restoreBackup(store, backup, 'wrong-password')); assert.equal(store.keys().length, 1);
    restoreBackup(target, backup, 'test-password-123'); assert.equal(target.secret(key.id), secret); assert.equal(target.channelToken('qq'), secret); assert.equal(target.latest(key.id)?.remaining, '10');
  } finally { store.close(); target.close(); }
});
test('较大的逻辑备份压缩后可恢复，超限输入不更改原数据', () => {
  const { store } = context(); const target = new Store(':memory:', new Vault(undefined, randomBytes(32)));
  try {
    const value = 'history-data-'.repeat(Math.ceil(backupMaxBytes / 13));
    assert.ok(Buffer.byteLength(value) >= backupMaxBytes); store.setValue('large-history-fixture', value);
    const backup = createBackup(store, 'test-password-123'); assert.ok(Buffer.byteLength(backup) < backupMaxBytes);
    restoreBackup(target, backup, 'test-password-123'); assert.equal(target.getValue('large-history-fixture', ''), value);
    assert.throws(() => restoreBackup(target, 'x'.repeat(backupMaxBytes + 1), 'test-password-123'), /备份损坏/);
    assert.equal(target.keys().length, 1);
  } finally { store.close(); target.close(); }
});
test('群与发送者均需允许，消息不泄露完整 Key', async () => {
  const { store, p, key } = context(); const refresh = new RefreshService(store, async () => quota());
  try {
    store.saveSnapshot(key, p, quota()); store.saveChannel({ platform: 'qq', enabled: true, endpoint: 'ws://localhost', allowedUsers: ['1'], allowedGroups: ['2'], targets: [] });
    const commands = new Commands(store, refresh), output: string[] = [];
    const reply = async (text: string) => { output.push(text); };
    await commands.handle({ platform: 'qq', userId: '3', groupId: '2', text: '/balance' }, reply); assert.equal(output.length, 0);
    await commands.handle({ platform: 'qq', userId: '1', groupId: '3', text: '/balance' }, reply); assert.equal(output.length, 0);
    await commands.handle({ platform: 'qq', userId: '1', groupId: '2', text: '/balance' }, reply);
    assert.equal(output.length, 1); assert.equal(output[0].includes(secret), false); assert.match(output[0], /\$10/);
    assert.ok(splitMessage('a'.repeat(7000)).every(part => part.length <= 3000));
  } finally { await refresh.close(); store.close(); }
});
test('低额度提醒去重、恢复后可再次触发', async () => {
  const { store, p, key } = context(); const refresh = new RefreshService(store, async () => quota());
  const scheduler = new Scheduler(store, refresh, new Commands(store, refresh), async () => {});
  try {
    store.saveSnapshot(key, p, quota('5')); scheduler.evaluateAlerts(); scheduler.evaluateAlerts(); assert.equal(store.notifications().length, 1);
    store.saveSnapshot(key, p, quota('50')); scheduler.evaluateAlerts();
    store.saveSnapshot(key, p, quota('5')); scheduler.evaluateAlerts(); assert.equal(store.notifications().length, 2);
    await scheduler.flush(); assert.ok(store.notifications().every(e => e.state === 'skipped'));
  } finally { await refresh.close(); store.close(); }
});
test('通知部分失败只重试尚未发送目标', async () => {
  const { store } = context(); const refresh = new RefreshService(store, async () => quota()); let attempts = 0; const calls: string[] = [];
  const scheduler = new Scheduler(store, refresh, new Commands(store, refresh), async target => { calls.push(target.id); if (target.id === '2' && attempts++ === 0) throw new Error(); });
  try {
    store.saveChannel({ platform: 'qq', enabled: true, endpoint: 'ws://localhost', allowedUsers: ['1'], allowedGroups: [], targets: [{ kind: 'private', id: '1' }, { kind: 'private', id: '2' }] });
    scheduler.event(null, 'test', 'message'); await scheduler.flush();
    const event = store.notifications()[0]; store.saveNotification({ ...event, nextAt: new Date(0).toISOString() }); await scheduler.flush();
    assert.deepEqual(calls, ['1', '2', '2']); assert.equal(store.notifications()[0].state, 'sent');
  } finally { await refresh.close(); store.close(); }
});
test('保留期限清理不删除最新快照，供应商删除级联有明确影响计数', () => {
  const { store, p, key } = context();
  try {
    store.saveSnapshot(key, p, quota()); assert.deepEqual(store.impact(p.id), { keys: 1, snapshots: 1 });
    store.prune(); assert.equal(store.history(key.id).length, 1); store.deleteProvider(p.id); assert.equal(store.keys().length, 0); assert.equal(store.history(key.id).length, 0);
  } finally { store.close(); }
});
test('全局最多四个查询，单供应商失败不阻塞其他站点', async () => {
  const { store, keyInput } = context(); let active = 0, maximum = 0;
  const refresh = new RefreshService(store, async p => {
    active++; maximum = Math.max(active, maximum); await sleep(5); active--;
    if (p.name === '失败站') throw new QuotaError('server', '站点故障'); return quota();
  });
  try {
    for (let i = 0; i < 8; i++) {
      const p = store.saveProvider({ ...providerDefaults(), name: i === 0 ? '失败站' : `站点${i}`, baseUrl: 'https://example.invalid' });
      store.saveKey({ ...keyInput, providerId: p.id, secret: `${secret}-${i}` });
    }
    const ids = store.keys().map(k => k.id); refresh.start(ids, 'web'); await refresh.wait(ids);
    assert.equal(maximum, 4); assert.equal(store.tasks().filter(t => t.state === 'success').length, 8);
    assert.equal(store.tasks().filter(t => t.state === 'failed').length, 1);
  } finally { await refresh.close(); store.close(); }
});
test('供应商参数变化、删除 Key 时丢弃迟到结果', async () => {
  for (const mode of ['change', 'delete']) {
    const { store, p, key } = context(); let resolve!: (q: Quota) => void;
    const refresh = new RefreshService(store, () => new Promise(done => { resolve = done; }));
    try {
      refresh.start([key.id], 'web'); const pending = refresh.wait([key.id]);
      if (mode === 'change') store.saveProvider({ ...p, unitsPerDollar: '100' }, p.id); else store.deleteKey(key.id);
      resolve(quota()); await pending;
      assert.equal(store.history(key.id).length, 0);
    } finally { await refresh.close(); store.close(); }
  }
});
test('维护不等待长时间限流排队，取消尚未发出的任务', async () => {
  const { store, key } = context(); const refresh = new RefreshService(store, async () => quota());
  try {
    refresh.cooldown.set(key.providerId, Date.now() + 86400000); refresh.start([key.id], 'web');
    assert.equal(store.lastTask(key.id)?.state, 'queued'); await refresh.quiesce();
    assert.equal(store.lastTask(key.id)?.state, 'cancelled'); assert.equal(refresh.pending.size, 0); refresh.resume();
  } finally { await refresh.close(); store.close(); }
});
test('修改凭据后不复用旧 Key 的失败状态和提醒', async () => {
  const { store, key, keyInput } = context();
  const refresh = new RefreshService(store, async () => { throw new QuotaError('unauthorized', '无查询权限'); });
  try {
    refresh.start([key.id], 'web'); await refresh.wait([key.id]); assert.equal(store.views()[0].lastTask?.state, 'failed');
    store.saveKey({ ...keyInput, secret: `${secret}-new` }, key.id); assert.equal(store.views()[0].lastTask, null);
    const scheduler = new Scheduler(store, refresh, new Commands(store, refresh), async () => {}); scheduler.evaluateAlerts(); assert.equal(store.notifications().length, 0);
  } finally { await refresh.close(); store.close(); }
});
test('Billing 窗口跨日切断差值，不把滚动窗口变化当消费', () => {
  const { store, p, key } = context();
  try {
    const first = store.saveSnapshot(key, p, { ...quota('20'), period: { start: '2026-07-19', end: '2026-10-17' } });
    const second = store.saveSnapshot(key, p, { ...quota('22'), period: { start: '2026-07-20', end: '2026-10-18' } });
    assert.notEqual(first.segment, second.segment); assert.equal(second.delta, null); assert.equal(store.views()[0].latest?.remaining, '22');
  } finally { store.close(); }
});
test('超过一百条通知不会让旧的待发送事件丢失', async () => {
  const { store } = context(); const refresh = new RefreshService(store, async () => quota());
  const scheduler = new Scheduler(store, refresh, new Commands(store, refresh), async () => {});
  try {
    for (let i = 0; i < 120; i++) scheduler.event(null, 'test', `测试${i}`);
    assert.equal(store.pendingNotifications().length, 100); await scheduler.flush(); await scheduler.flush();
    assert.equal(store.pendingNotifications().length, 0);
  } finally { await refresh.close(); store.close(); }
});
test('日报每天仅生成一次，使用设置的时区和持久状态', async () => {
  const { store, key } = context(); const refresh = new RefreshService(store, async () => quota());
  const scheduler = new Scheduler(store, refresh, new Commands(store, refresh), async () => {});
  try {
    store.setValue('settings', { ...defaultSettings, dailyEnabled: true, dailyTime: '00:00', timezone: 'UTC' });
    store.setValue('lastScheduled', Date.now()); await scheduler.tick(); await scheduler.tick();
    assert.equal(store.notifications().filter(n => n.kind === 'daily').length, 1);
  } finally { await refresh.close(); store.close(); }
});
