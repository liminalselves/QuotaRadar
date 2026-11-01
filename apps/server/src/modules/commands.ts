import { formatAmount } from '../../../../packages/shared/amount.ts';
import type { KeyView } from '../../../../packages/shared/types.ts';
import { Store } from '../infrastructure/store.ts';
import { RefreshService } from './refresh.ts';
import { DeliveryError } from './delivery.ts';
export interface Incoming {
  platform: 'qq' | 'telegram'; userId: string; groupId?: string; text: string; botUsername?: string;
}
export function allowed(store: Store, message: Incoming): boolean {
  const channel = store.channel(message.platform);
  return channel.enabled && channel.allowedUsers.includes(message.userId)
    && (!message.groupId || channel.allowedGroups.includes(message.groupId));
}
export function splitMessage(text: string, max = 3000): string[] {
  const output: string[] = []; let current = '';
  for (const line of text.split('\n')) {
    for (let offset = 0; offset < line.length || offset === 0; offset += max) {
      const part = line.slice(offset, offset + max);
      if (current.length + part.length + 1 > max) { output.push(current); current = ''; }
      current += `${current ? '\n' : ''}${part}`;
    }
  }
  if (current) output.push(current); return output;
}
export class Commands {
  store: Store; refresh: RefreshService;
  constructor(store: Store, refresh: RefreshService) { this.store = store; this.refresh = refresh; }
  async handle(message: Incoming, reply: (text: string) => Promise<void>): Promise<void> {
    if (!allowed(this.store, message)) return;
    const match = message.text.trim().match(/^(\/balance|\/refresh|\/low|\/status|\/help|刷新额度|额度)(?:@([\w_]+))?(?:\s+(.+))?$/i);
    if (!match || (match[2] && match[2].toLowerCase() !== message.botUsername?.toLowerCase())) return;
    const command = ({ '额度': '/balance', '刷新额度': '/refresh' } as Record<string, string>)[match[1]] ?? match[1].toLowerCase();
    // A slow or unconfirmed reply must not abort the command; the final result is still worth sending.
    const send = async (text: string) => {
      for (const part of splitMessage(text)) {
        try { await reply(part); } catch (error) { if (!(error instanceof DeliveryError && error.unconfirmed)) throw error; }
      }
    };
    if (command === '/help') return send('/balance 或「额度」[别名或供应商] 查看快照\n/refresh 或「刷新额度」[别名或供应商或 all] 实时刷新\n/low 低额度与异常\n/status 服务状态\n完整 Key 只在管理台设置');
    if (command === '/status') {
      const views = this.store.views(), enabled = views.filter(k => k.enabled && this.store.provider(k.providerId)?.enabled);
      const failed = enabled.filter(k => k.lastTask?.state === 'failed').length, low = enabled.filter(k => k.low).length;
      const last = views.map(k => k.latest?.sampledAt).filter((t): t is string => Boolean(t)).sort().at(-1);
      return send(`QuotaRadar 正在运行\n供应商 ${this.store.providers().length}，Key ${enabled.length}/${views.length} 启用\n低额度 ${low}，查询失败 ${failed}，查询中 ${this.refresh.pending.size}\n最近采样：${last ? this.time(last) : '尚无'}`);
    }
    const target = match[3]?.trim();
    let keys = this.store.views().filter(k => k.enabled && this.store.provider(k.providerId)?.enabled);
    if (target && target.toLowerCase() !== 'all') {
      const exact = keys.filter(k => k.id === target || k.name === target || k.providerName === target);
      const candidates = exact.length ? exact : keys.filter(k => k.name.toLowerCase().includes(target.toLowerCase()) || k.providerName.toLowerCase().includes(target.toLowerCase()));
      const suppliers = new Set(candidates.map(k => k.providerName));
      if (candidates.length > 1 && !(suppliers.size === 1 && candidates.every(k => k.providerName === target))) {
        return send(`名称不唯一，请使用 Key ID 或完整供应商名：\n${candidates.map(k => `${k.providerName} / ${k.name} (${k.id})`).join('\n')}`);
      }
      keys = candidates;
    }
    if (command === '/low') keys = keys.filter(k => k.low || k.lastTask?.state === 'failed' || k.latest?.active === false || (k.latest?.expiresAt != null && k.latest.expiresAt * 1000 < Date.now()));
    if (!keys.length) return send('没有匹配的 Key，请在管理台添加或检查名称。');
    if (command === '/refresh') {
      if (this.refresh.paused) return send('服务正在维护，请稍后刷新。');
      this.refresh.start(keys.map(k => k.id), message.platform);
      // Send the ack while the queries run, so a slow platform does not delay the result.
      const ack = send(`正在刷新 ${keys.length} 个 Key，完成后返回结果。`).catch(() => undefined);
      await this.refresh.wait(keys.map(k => k.id)); await ack;
      const ids = new Set(keys.map(k => k.id)); keys = this.store.views().filter(k => ids.has(k.id));
    }
    await send(keys.map(k => this.line(k)).join('\n\n'));
  }
  time(iso: string): string {
    const zone = this.store.settings().timezone;
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
    const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
  }
  line(key: KeyView): string {
    const q = key.latest;
    const total = q && !q.unlimited && q.total !== null ? ` / 总 ${formatAmount(q.total, q.unit)}` : '';
    return `${key.providerName} / ${key.name}\n${key.mask}\n剩余：${q?.unlimited ? '无限' : formatAmount(q?.remaining ?? null, q?.unit)}${total}${q?.accuracy === 'estimated' ? '（估算）' : ''}${key.low ? ' ⚠ 低额度' : ''}\n`
      + `${q ? `更新：${this.time(q.sampledAt)}${key.stale ? '（已过期）' : ''}` : '尚未成功查询'}${key.lastTask?.state === 'failed' ? `\n最近失败：${key.lastTask.error}` : ''}`;
  }
}
