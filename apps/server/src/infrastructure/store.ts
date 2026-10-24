import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { ApiKey, Channel, ChannelInput, KeyInput, KeyView, NotificationEvent, Provider, ProviderInput, Quota, RefreshTask, Settings, Snapshot } from '../../../../packages/shared/types.ts';
import { channelDefaults, defaultSettings } from '../../../../packages/shared/types.ts';
import { add, compare, subtract } from '../../../../packages/shared/amount.ts';
import { Vault, mask } from './vault.ts';

const stamp = () => new Date().toISOString();
const read = <T>(row: unknown): T | null => row ? JSON.parse((row as { body: string }).body) as T : null;
const rows = <T>(list: unknown[]): T[] => list.map(row => read<T>(row)!);
export class Store {
  db: DatabaseSync;
  vault: Vault;
  constructor(path: string, vault: Vault) {
    this.vault = vault; this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS providers(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL, secret TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(provider_id,fingerprint));
      CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        sampled_at TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS snapshot_key_time ON snapshots(key_id,sampled_at DESC);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_key_time ON tasks(key_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS channels(platform TEXT PRIMARY KEY,token TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,body TEXT NOT NULL);`);
  }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getValue<T>(id: string, fallback: T): T { return read<T>(this.db.prepare('SELECT body FROM kv WHERE id=?').get(id)) ?? fallback; }
  setValue(id: string, data: unknown): void {
    this.db.prepare('INSERT INTO kv VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id, JSON.stringify(data));
  }
  settings(): Settings { return this.getValue('settings', defaultSettings); }
  providers(): Provider[] { return rows(this.db.prepare('SELECT body FROM providers ORDER BY rowid').all()); }
  provider(id: string): Provider | null { return read(this.db.prepare('SELECT body FROM providers WHERE id=?').get(id)); }
  saveProvider(input: ProviderInput, id?: string): Provider {
    const old = id ? this.provider(id) : null;
    if (id && !old) throw new Error('供应商不存在');
    const item: Provider = { ...input, id: id ?? randomUUID(), version: (old?.version ?? 0) + 1, createdAt: old?.createdAt ?? stamp() };
    this.db.prepare('INSERT INTO providers VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(item.id, JSON.stringify(item));
    return item;
  }
  impact(providerId: string): { keys: number; snapshots: number } {
    const keys = this.keys().filter(k => k.providerId === providerId);
    const snapshots = Number((this.db.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE key_id IN (SELECT id FROM api_keys WHERE provider_id=?)').get(providerId) as { n: number }).n);
    return { keys: keys.length, snapshots };
  }
  deleteProvider(id: string): void { this.db.prepare('DELETE FROM providers WHERE id=?').run(id); }
  keys(): ApiKey[] { return rows(this.db.prepare('SELECT body FROM api_keys ORDER BY rowid').all()); }
  key(id: string): ApiKey | null { return read(this.db.prepare('SELECT body FROM api_keys WHERE id=?').get(id)); }
  secret(id: string): string {
    const row = this.db.prepare('SELECT secret FROM api_keys WHERE id=?').get(id) as { secret: string } | undefined;
    if (!row) throw new Error('Key 不存在'); return this.vault.decrypt(row.secret);
  }
  hasSecret(providerId: string, secret: string, exceptId = ''): boolean {
    return Boolean(this.db.prepare('SELECT id FROM api_keys WHERE provider_id=? AND fingerprint=? AND id<>?').get(providerId, this.vault.fingerprint(secret), exceptId));
  }
  saveKey(input: KeyInput, id?: string): ApiKey {
    const old = id ? this.key(id) : null;
    if (id && !old) throw new Error('Key 不存在');
    if (!this.provider(input.providerId)) throw new Error('供应商不存在');
    const secret = input.secret?.trim() || (old ? this.secret(old.id) : '');
    if (!secret) throw new Error('请输入 Key');
    if (this.hasSecret(input.providerId, secret, id)) throw new Error('该供应商已经有相同 Key');
    const { secret: _, ...safe } = input;
    const changed = Boolean(old && (secret !== this.secret(old.id) || old.providerId !== input.providerId || old.enabled !== input.enabled));
    const item: ApiKey = { ...safe, id: id ?? randomUUID(), revision: old ? old.revision + (changed ? 1 : 0) : 1,
      mask: mask(secret), createdAt: old?.createdAt ?? stamp() };
    this.db.prepare(`INSERT INTO api_keys VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      provider_id=excluded.provider_id, fingerprint=excluded.fingerprint, secret=excluded.secret, body=excluded.body`).run(
        item.id, item.providerId, this.vault.fingerprint(secret), this.vault.encrypt(secret), JSON.stringify(item));
    return item;
  }
  deleteKey(id: string): void { this.db.prepare('DELETE FROM api_keys WHERE id=?').run(id); }
  latest(id: string): Snapshot | null { return read(this.db.prepare('SELECT body FROM snapshots WHERE key_id=? ORDER BY sampled_at DESC,rowid DESC LIMIT 1').get(id)); }
  history(id: string, page = 0, limit = 200): Snapshot[] {
    return rows(this.db.prepare('SELECT body FROM snapshots WHERE key_id=? ORDER BY sampled_at DESC,rowid DESC LIMIT ? OFFSET ?').all(id, limit, page * limit));
  }
  lastTask(id: string): RefreshTask | null { return read(this.db.prepare('SELECT body FROM tasks WHERE key_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id)); }
  tasks(id?: string, page = 0): RefreshTask[] {
    return rows(id ? this.db.prepare('SELECT body FROM tasks WHERE key_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50 OFFSET ?').all(id, page * 50)
      : this.db.prepare('SELECT body FROM tasks ORDER BY created_at DESC,rowid DESC LIMIT 100 OFFSET ?').all(page * 100));
  }
  saveTask(task: RefreshTask): void {
    this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(task.id, task.keyId, task.createdAt, JSON.stringify(task));
  }
  recoverTasks(): void {
    const tasks = rows<RefreshTask>(this.db.prepare(`SELECT body FROM tasks WHERE json_extract(body,'$.state') IN ('running','queued')`).all());
    for (const task of tasks) this.saveTask({ ...task, state: 'cancelled', finishedAt: stamp(), errorKind: 'cancelled', error: '服务重启，请重新刷新' });
  }
  saveSnapshot(key: ApiKey, provider: Provider, quota: Quota): Snapshot {
    const previous = this.latest(key.id);
    const segment = `${key.revision}:${provider.version}${quota.period ? `:${quota.period.start}:${quota.period.end}` : ''}`;
    const snapshot: Snapshot = { ...quota, id: randomUUID(), keyId: key.id, keyRevision: key.revision, providerVersion: provider.version,
      segment, sampledAt: stamp(), delta: previous?.segment === segment && previous.remaining !== null && quota.remaining !== null
        ? subtract(quota.remaining, previous.remaining) : null };
    this.db.prepare('INSERT INTO snapshots VALUES(?,?,?,?)').run(snapshot.id, key.id, snapshot.sampledAt, JSON.stringify(snapshot));
    return snapshot;
  }
  views(): KeyView[] {
    const settings = this.settings();
    return this.keys().map(key => {
      const provider = this.provider(key.providerId)!;
      const candidate = this.latest(key.id);
      const latest = candidate?.keyRevision === key.revision && candidate.providerVersion === provider.version ? candidate : null;
      const task = this.lastTask(key.id);
      const lastTask = task?.keyRevision === key.revision && task.providerVersion === provider.version ? task : null;
      return { ...key, providerName: provider.name, latest, lastTask,
        stale: !latest || Date.now() - Date.parse(latest.sampledAt) > settings.refreshMinutes * 120000,
        low: Boolean(latest && !latest.unlimited && latest.remaining !== null && compare(latest.remaining, key.threshold ?? settings.defaultThreshold) < 0) };
    });
  }
  totals(): { unit: string; remaining: string; count: number }[] {
    const groups = new Map<string, KeyView>();
    for (const key of this.views()) {
      const q = key.latest;
      if (!key.enabled || !this.provider(key.providerId)?.enabled || !q || key.stale || q.unlimited || q.accuracy !== 'confirmed' || q.scope === 'unknown'
        || q.remaining === null || key.aggregation === 'excluded' || q.active === false || (q.expiresAt !== null && q.expiresAt * 1000 < Date.now()) || key.lastTask?.state === 'failed') continue;
      const group = key.aggregation === 'shared' ? `${key.providerId}:${q.unit}:${key.balanceGroup}` : key.id;
      const old = groups.get(group);
      if (!old || old.latest!.sampledAt < q.sampledAt) groups.set(group, key);
    }
    const result = new Map<string, { unit: string; remaining: string; count: number }>();
    for (const key of groups.values()) {
      const q = key.latest!;
      const value = result.get(q.unit) ?? { unit: q.unit, remaining: '0', count: 0 };
      value.remaining = add(value.remaining, q.remaining!); value.count++; result.set(q.unit, value);
    }
    return [...result.values()];
  }
  channel(platform: ChannelInput['platform']): Channel {
    const row = this.db.prepare('SELECT body,token FROM channels WHERE platform=?').get(platform) as { body: string; token: string } | undefined;
    return { ...(row ? JSON.parse(row.body) : channelDefaults(platform)), hasToken: Boolean(row?.token) };
  }
  channelToken(platform: ChannelInput['platform']): string {
    const row = this.db.prepare('SELECT token FROM channels WHERE platform=?').get(platform) as { token: string } | undefined;
    return row?.token ? this.vault.decrypt(row.token) : '';
  }
  saveChannel(input: ChannelInput): void {
    const { token, ...body } = input;
    const value = token === undefined ? this.channelToken(input.platform) : token;
    this.db.prepare('INSERT INTO channels VALUES(?,?,?) ON CONFLICT(platform) DO UPDATE SET token=excluded.token,body=excluded.body').run(input.platform, value ? this.vault.encrypt(value) : '', JSON.stringify(body));
  }
  notifications(): NotificationEvent[] { return rows(this.db.prepare('SELECT body FROM notifications ORDER BY rowid DESC LIMIT 100').all()); }
  pendingNotifications(): NotificationEvent[] {
    return rows(this.db.prepare(`SELECT body FROM notifications WHERE json_extract(body,'$.state')='pending' ORDER BY rowid LIMIT 100`).all());
  }
  saveNotification(event: NotificationEvent): void {
    this.db.prepare('INSERT INTO notifications VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(event.id, JSON.stringify(event));
  }
  prune(): void {
    const settings = this.settings();
    this.db.prepare(`DELETE FROM snapshots WHERE sampled_at < ? AND id NOT IN (SELECT id FROM snapshots AS s
      WHERE s.rowid=(SELECT rowid FROM snapshots WHERE key_id=s.key_id ORDER BY sampled_at DESC,rowid DESC LIMIT 1))`).run(new Date(Date.now() - settings.snapshotDays * 86400000).toISOString());
    this.db.prepare(`DELETE FROM tasks WHERE created_at < ? AND json_extract(body,'$.state') NOT IN ('running','queued')`).run(new Date(Date.now() - settings.taskDays * 86400000).toISOString());
    this.db.prepare(`DELETE FROM notifications WHERE json_extract(body,'$.createdAt') < ? AND json_extract(body,'$.state') <> 'pending'`).run(new Date(Date.now() - settings.taskDays * 86400000).toISOString());
    this.db.prepare(`DELETE FROM kv WHERE id LIKE 'delivered:%' AND NOT EXISTS (SELECT 1 FROM notifications WHERE notifications.id=substr(kv.id,11))`).run();
    this.db.prepare(`DELETE FROM kv WHERE id LIKE 'alert:%' AND NOT EXISTS (SELECT 1 FROM api_keys WHERE api_keys.id=substr(kv.id,7))`).run();
  }
  close(): void { this.db.close(); }
}
