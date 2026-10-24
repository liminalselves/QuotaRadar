import { randomUUID } from 'node:crypto';
import type { NotificationEvent } from '../../../../packages/shared/types.ts';
import { Store } from '../infrastructure/store.ts';
import { RefreshService } from './refresh.ts';
import { Commands } from './commands.ts';
export interface DeliveryTarget { platform: 'qq' | 'telegram'; kind: 'private' | 'group'; id: string }
export class Scheduler {
  store: Store; refresh: RefreshService; commands: Commands;
  deliver: (target: DeliveryTarget, text: string) => Promise<void>;
  timer: ReturnType<typeof setInterval> | undefined;
  busy = false; stopped = false; current: Promise<void> | null = null;
  constructor(store: Store, refresh: RefreshService, commands: Commands, deliver: Scheduler['deliver']) {
    this.store = store; this.refresh = refresh; this.commands = commands; this.deliver = deliver;
  }
  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => { if (!this.stopped && !this.busy) { this.current = this.tick().catch(() => undefined); } }, 10000);
    this.timer.unref();
  }
  async stop(): Promise<void> { this.stopped = true; clearInterval(this.timer); await this.current; }
  event(keyId: string | null, kind: string, text: string): void {
    const now = new Date().toISOString();
    this.store.saveNotification({ id: randomUUID(), keyId, kind, text, createdAt: now, state: 'pending', attempts: 0, nextAt: now });
  }
  async tick(): Promise<void> {
    if (this.busy || this.refresh.paused) return;
    this.busy = true;
    try {
      const settings = this.store.settings(), now = Date.now();
      const last = this.store.getValue('lastScheduled', 0);
      if (now - last >= settings.refreshMinutes * 60000) {
        this.refresh.start(this.store.keys().map(k => k.id), 'schedule'); this.store.setValue('lastScheduled', now);
      }
      this.evaluateAlerts();
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: settings.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
      const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
      const date = `${part('year')}-${part('month')}-${part('day')}`, time = `${part('hour')}:${part('minute')}`;
      if (settings.dailyEnabled && time >= settings.dailyTime && this.store.getValue('lastDaily', '') !== date) {
        const keys = this.store.views().filter(k => k.enabled);
        this.event(null, 'daily', `QuotaRadar 每日摘要 · ${date}\n${keys.length ? keys.map(k => this.commands.line(k)).join('\n\n') : '暂无 Key'}`);
        this.store.setValue('lastDaily', date);
      }
      if (now - this.store.getValue('lastPrune', 0) >= 86400000) { this.store.prune(); this.store.setValue('lastPrune', now); }
      await this.flush();
    } finally { this.busy = false; }
  }
  evaluateAlerts(): void {
    const settings = this.store.settings();
    for (const key of this.store.views()) {
      if (!key.enabled || !this.store.provider(key.providerId)?.enabled) continue;
      const q = key.latest, now = Date.now();
      const failures = this.store.tasks(key.id).filter(t => t.state !== 'cancelled' && t.keyRevision === key.revision && t.providerVersion === this.store.provider(key.providerId)?.version);
      let consecutive = 0;
      for (const task of failures) { if (task.state !== 'failed') break; consecutive++; }
      const state = key.lastTask?.errorKind === 'unauthorized' && key.lastTask.state === 'failed' ? 'unauthorized'
        : q?.active === false ? 'disabled'
        : q?.expiresAt !== null && q?.expiresAt !== undefined && q.expiresAt * 1000 < now ? 'expired'
        : consecutive >= settings.failureThreshold ? 'failure'
        : key.low && !key.stale ? 'low' : 'normal';
      const id = `alert:${key.id}`;
      const old = this.store.getValue(id, { state: 'normal', at: 0 });
      if (state === 'normal') { if (old.state !== state) this.store.setValue(id, { state, at: now }); continue; }
      if (state !== old.state || now - old.at >= settings.reminderHours * 3600000) {
        const labels: Record<string, string> = { unauthorized: '凭据无效或无查询权限', disabled: '令牌已停用', expired: '令牌已过期', failure: `连续 ${consecutive} 次查询失败`, low: '低额度提醒' };
        this.event(key.id, state, `${labels[state]}\n${this.commands.line(key)}`); this.store.setValue(id, { state, at: now });
      }
    }
  }
  async flush(): Promise<void> {
    const targets: DeliveryTarget[] = (['telegram', 'qq'] as const).flatMap(platform => {
      const channel = this.store.channel(platform);
      return channel.enabled ? channel.targets.map(t => ({ ...t, platform })) : [];
    });
    for (const event of this.store.pendingNotifications()) {
      if (Date.parse(event.nextAt) > Date.now()) continue;
      if (!targets.length || (event.keyId && !this.store.key(event.keyId))) { this.store.saveNotification({ ...event, state: 'skipped' }); continue; }
      const delivered = this.store.getValue<string[]>(`delivered:${event.id}`, []);
      let failed = false;
      for (const target of targets) {
        const id = `${target.platform}:${target.kind}:${target.id}`;
        if (delivered.includes(id)) continue;
        try { await this.deliver(target, event.text); delivered.push(id); this.store.setValue(`delivered:${event.id}`, delivered); }
        catch { failed = true; }
      }
      const attempts = event.attempts + 1;
      this.store.saveNotification({ ...event, attempts, state: failed ? (attempts >= 3 ? 'failed' : 'pending') : 'sent', nextAt: new Date(Date.now() + 60000 * attempts).toISOString() });
    }
  }
}
