import { randomUUID } from 'node:crypto';
import type { ApiKey, Provider, Quota, RefreshTask } from '../../../../packages/shared/types.ts';
import { queryQuota, QuotaError } from '../adapters/quota.ts';
import { Store } from '../infrastructure/store.ts';
export class RefreshService {
  store: Store;
  query: (provider: Provider, secret: string) => Promise<Quota>;
  queue: { task: RefreshTask; key: ApiKey; provider: Provider; resolve: (task: RefreshTask) => void }[] = [];
  pending = new Map<string, { task: RefreshTask; promise: Promise<RefreshTask> }>();
  activeProviders = new Set<string>();
  cooldown = new Map<string, number>();
  running = 0;
  paused = false;
  timer: ReturnType<typeof setTimeout> | undefined;
  constructor(store: Store, query = queryQuota) { this.store = store; this.query = query; store.recoverTasks(); }
  start(ids: string[], source: string): { batchId: string; tasks: RefreshTask[] } {
    if (this.paused) throw new Error('正在备份或恢复，请稍后再试');
    const batchId = randomUUID();
    const tasks: RefreshTask[] = [];
    for (const id of new Set(ids)) {
      const existing = this.pending.get(id);
      if (existing) { tasks.push(existing.task); continue; }
      const key = this.store.key(id), provider = key ? this.store.provider(key.providerId) : null;
      if (!key?.enabled || !provider?.enabled) continue;
      const task: RefreshTask = { id: randomUUID(), batchId, keyId: id, keyRevision: key.revision, providerVersion: provider.version, source, state: 'queued', createdAt: new Date().toISOString(), finishedAt: null, errorKind: null, error: null };
      let resolve!: (task: RefreshTask) => void;
      const promise = new Promise<RefreshTask>(done => { resolve = done; });
      this.store.saveTask(task); this.pending.set(id, { task, promise });
      this.queue.push({ task, key, provider, resolve }); tasks.push(task);
    }
    this.pump(); return { batchId, tasks };
  }
  wait(ids: string[]): Promise<RefreshTask[]> {
    return Promise.all([...new Set(ids)].map(id => this.pending.get(id)?.promise).filter((p): p is Promise<RefreshTask> => Boolean(p)));
  }
  pump(): void {
    clearTimeout(this.timer);
    while (this.running < 4) {
      const index = this.queue.findIndex(item => !this.activeProviders.has(item.provider.id) && (this.cooldown.get(item.provider.id) ?? 0) <= Date.now());
      if (index < 0) break;
      const [item] = this.queue.splice(index, 1);
      this.running++; this.activeProviders.add(item.provider.id);
      void this.execute(item).finally(() => {
        this.running--; this.activeProviders.delete(item.provider.id); this.pending.delete(item.key.id); this.pump();
      });
    }
    if (this.queue.length && !this.running) {
      const next = Math.min(...this.queue.map(item => this.cooldown.get(item.provider.id) ?? 0));
      this.timer = setTimeout(() => this.pump(), Math.min(Math.max(100, next - Date.now()), 2147483647));
      this.timer.unref();
    }
  }
  valid(key: ApiKey, provider: Provider): boolean {
    const current = this.store.key(key.id), p = this.store.provider(provider.id);
    return Boolean(current?.enabled && p?.enabled && current.revision === key.revision && p.version === provider.version);
  }
  async execute(item: RefreshService['queue'][number]): Promise<void> {
    const { task, key, provider } = item;
    try {
      if (!this.valid(key, provider)) throw new QuotaError('cancelled', '配置已经变化，本次查询已取消');
      task.state = 'running'; this.store.saveTask(task);
      const quota = await this.query(provider, this.store.secret(key.id));
      this.store.transaction(() => {
        if (!this.valid(key, provider)) throw new QuotaError('cancelled', '配置已经变化，丢弃旧查询结果');
        this.store.saveSnapshot(key, provider, quota); task.state = 'success';
      });
    } catch (error) {
      const safe = error instanceof QuotaError ? error : new QuotaError('format', '查询处理失败，请检查供应商配置');
      task.state = safe.kind === 'cancelled' ? 'cancelled' : 'failed'; task.errorKind = safe.kind; task.error = safe.message;
      if (safe.kind === 'rate_limit') this.cooldown.set(provider.id, Date.now() + safe.retryAfterMs);
    } finally {
      task.finishedAt = new Date().toISOString();
      if (this.store.key(key.id)) this.store.saveTask(task);
      item.resolve(task);
    }
  }
  async quiesce(): Promise<void> {
    this.paused = true; clearTimeout(this.timer);
    for (const item of this.queue.splice(0)) {
      item.task.state = 'cancelled'; item.task.finishedAt = new Date().toISOString();
      item.task.errorKind = 'cancelled'; item.task.error = '服务进入维护，排队查询已取消';
      if (this.store.key(item.key.id)) this.store.saveTask(item.task);
      this.pending.delete(item.key.id); item.resolve(item.task);
    }
    await Promise.all([...this.pending.values()].map(item => item.promise));
  }
  resume(): void { this.paused = false; }
  async close(): Promise<void> { await this.quiesce(); clearTimeout(this.timer); }
}
