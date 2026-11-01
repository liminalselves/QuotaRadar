import type { Channel, ChannelStatus, KeyView, NotificationEvent, Provider, RefreshTask, Settings, Snapshot } from '../../../packages/shared/types.ts';
export interface AppState {
  providers: Provider[]; keys: KeyView[]; settings: Settings; channels: Channel[];
  statuses: Record<'qq' | 'telegram', ChannelStatus>; tasks: RefreshTask[]; notifications: NotificationEvent[];
  totals: { unit: string; remaining: string; count: number }[];
}
export interface History { snapshots: Snapshot[]; tasks: RefreshTask[] }
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new Error('无法连接 QuotaRadar 服务，请检查服务是否运行'); }
  // Proxies and restarts can answer with HTML or an empty body; never surface a JSON parse error.
  const data = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth') window.dispatchEvent(new Event('qr-unauthorized'));
    throw new Error(data.error ?? (response.status >= 502 ? '服务暂时不可用，请稍后重试' : `请求失败 (${response.status})`));
  }
  return data as T;
}
export function relativeTime(value: string | null | undefined, now = Date.now()): string {
  if (!value) return '尚未查询';
  const seconds = Math.round((now - Date.parse(value)) / 1000);
  if (seconds < 45) return '刚刚';
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`;
  if (seconds < 86400 * 7) return `${Math.round(seconds / 86400)} 天前`;
  return dateTime(value);
}
export function dateTime(value: string | null | undefined): string {
  if (!value) return '尚未查询';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
}
