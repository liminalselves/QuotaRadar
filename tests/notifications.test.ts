import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../apps/server/src/infrastructure/store.ts';
import { Vault } from '../apps/server/src/infrastructure/vault.ts';
import { RefreshService } from '../apps/server/src/modules/refresh.ts';
import { Commands, splitMessage } from '../apps/server/src/modules/commands.ts';
import { DeliveryError, Scheduler } from '../apps/server/src/modules/scheduler.ts';
import { QuotaError } from '../apps/server/src/adapters/quota.ts';
import { channelDefaults, defaultSettings, providerDefaults } from '../packages/shared/types.ts';
import type { Quota } from '../packages/shared/types.ts';

const quota = (remaining: string | null): Quota => ({ total: '100', used: null, remaining, unit: 'USD', scope: 'token', accuracy: 'confirmed', unlimited: false, status: 'active', active: true, expiresAt: null, period: null, raw: {} });
function context(deliver: Scheduler['deliver'] = async () => {}) {
  const store = new Store(':memory:', new Vault(undefined, randomBytes(32)));
  const provider = store.saveProvider({ ...providerDefaults('newapi-cx'), name: 'Fixture', baseUrl: 'https://example.invalid' });
  const key = store.saveKey({ providerId: provider.id, name: 'Fixture', secret: 'fixture-only-secret', enabled: true, tags: [], threshold: null, aggregation: 'excluded', balanceGroup: '' });
  const refresh = new RefreshService(store, async () => quota('5'));
  const commands = new Commands(store, refresh);
  const scheduler = new Scheduler(store, refresh, commands, deliver);
  store.saveChannel({ ...channelDefaults('qq'), enabled: true, targets: [{ kind: 'private', id: '1' }] });
  return { store, provider, key, refresh, commands, scheduler, close: async () => { await scheduler.stop(); await refresh.close(); store.close(); } };
}

test('持续低额度超过重复提醒间隔也只提醒一次，真实恢复后才能再次提醒', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 30) });
  const c = context(); const { store, provider, key, scheduler } = c;
  try {
    store.saveSnapshot(key, provider, quota('5')); scheduler.evaluateAlerts();
    t.mock.timers.tick(13 * 3600000);
    store.saveSnapshot(key, provider, quota('4')); scheduler.evaluateAlerts();
    assert.equal(store.notifications().filter(n => n.kind === 'low').length, 1);
    store.saveSnapshot(key, provider, quota('20')); scheduler.evaluateAlerts();
    store.saveSnapshot(key, provider, quota('5')); scheduler.evaluateAlerts();
    assert.equal(store.notifications().filter(n => n.kind === 'low').length, 2);
  } finally { await c.close(); }
});

test('快照过期和未知余额都不是低额度恢复，重新查到低额度不重复提醒', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 30) });
  const c = context(); const { store, provider, key, scheduler } = c;
  try {
    store.saveSnapshot(key, provider, quota('5')); scheduler.evaluateAlerts();
    t.mock.timers.tick(defaultSettings.refreshMinutes * 120000 + 1);
    scheduler.evaluateAlerts();
    store.saveSnapshot(key, provider, quota('4')); scheduler.evaluateAlerts();
    store.saveSnapshot(key, provider, quota(null)); scheduler.evaluateAlerts();
    store.saveSnapshot(key, provider, quota('3')); scheduler.evaluateAlerts();
    assert.equal(store.notifications().filter(n => n.kind === 'low').length, 1);
  } finally { await c.close(); }
});

test('失败和刷新中状态不解除低额度去重，更换凭据则独立提醒', async () => {
  const c = context(); const { store, key, refresh, scheduler } = c;
  try {
    refresh.start([key.id], 'test'); await refresh.wait([key.id]); scheduler.evaluateAlerts();
    refresh.query = async () => { throw new QuotaError('network', 'Fixture failure'); };
    for (let i = 0; i < 3; i++) { refresh.start([key.id], 'test'); await refresh.wait([key.id]); }
    scheduler.evaluateAlerts();
    let finish!: (value: Quota) => void;
    refresh.query = () => new Promise(resolve => { finish = resolve; });
    refresh.start([key.id], 'test'); scheduler.evaluateAlerts(); finish(quota('4'));
    await refresh.wait([key.id]); scheduler.evaluateAlerts();
    assert.equal(store.notifications().filter(n => n.kind === 'low').length, 1);
    store.saveKey({ ...key, secret: 'changed-fixture-only-secret' }, key.id);
    refresh.query = async () => quota('3');
    refresh.start([key.id], 'test'); await refresh.wait([key.id]); scheduler.evaluateAlerts();
    assert.equal(store.notifications().filter(n => n.kind === 'low').length, 2);
  } finally { await c.close(); }
});

test('长播报后段失败后只重试失败段，重新创建调度器也不重发成功段', async () => {
  const parts = splitMessage(`${'a'.repeat(2000)}\n${'b'.repeat(2000)}`), calls: string[] = [];
  let fail = true;
  const c = context(async (_target, text) => {
    for (const part of splitMessage(text)) {
      calls.push(part);
      if (part === parts[1] && fail) { fail = false; throw new Error('Fixture rejected'); }
    }
  });
  try {
    c.scheduler.event(null, 'daily', parts.join('\n'));
    await c.scheduler.flush();
    const event = c.store.notifications()[0];
    assert.equal(event.state, 'pending');
    c.store.saveNotification({ ...event, nextAt: new Date(0).toISOString() });
    const restarted = new Scheduler(c.store, c.refresh, c.commands, c.scheduler.deliver);
    await restarted.flush();
    assert.deepEqual(calls, [parts[0], parts[1], parts[1]]);
    assert.equal(c.store.notifications()[0].state, 'sent');
    await restarted.flush(); assert.equal(calls.length, 3);
  } finally { await c.close(); }
});

test('结果未确认时不自动重发已交给平台的消息', async () => {
  let calls = 0;
  const c = context(async () => { calls++; throw new DeliveryError('Fixture unknown result', false); });
  try {
    c.scheduler.event(null, 'daily', 'one message'); await c.scheduler.flush();
    const event = c.store.notifications()[0];
    assert.equal(event.state, 'failed'); assert.equal(calls, 1);
    c.store.saveNotification({ ...event, nextAt: new Date(0).toISOString() }); await c.scheduler.flush();
    assert.equal(calls, 1);
  } finally { await c.close(); }
});

test('播报发送跨过多次调度时只生成一份日报，每个目标只发送一次', async () => {
  let finish!: () => void, calls = 0;
  const c = context(async () => { calls++; await new Promise<void>(resolve => { finish = resolve; }); });
  try {
    c.store.setValue('settings', { ...defaultSettings, dailyEnabled: true, dailyTime: '00:00', timezone: 'UTC' });
    c.store.setValue('lastScheduled', Date.now());
    const pending = c.scheduler.tick();
    await c.scheduler.tick(); await c.scheduler.tick();
    assert.equal(calls, 1); finish(); await pending;
    const restarted = new Scheduler(c.store, c.refresh, c.commands, c.scheduler.deliver);
    await restarted.tick();
    assert.equal(c.store.notifications().filter(n => n.kind === 'daily').length, 1);
    assert.equal(calls, 1);
  } finally { await c.close(); }
});
