import type { Channel, ChannelStatus, KeyView, NotificationEvent, Provider, RefreshTask, Settings, Snapshot } from '../../../packages/shared/types.ts';
export interface AppState {
  providers: Provider[]; keys: KeyView[]; settings: Settings; channels: Channel[];
  statuses: Record<'qq' | 'telegram', ChannelStatus>; tasks: RefreshTask[]; notifications: NotificationEvent[];
  totals: { unit: string; remaining: string; count: number }[];
}
export interface History { snapshots: Snapshot[]; tasks: RefreshTask[] }
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth') window.dispatchEvent(new Event('qr-unauthorized'));
    throw new Error(data.error ?? `请求失败 (${response.status})`);
  }
  return data as T;
}
export function dateTime(value: string | null | undefined): string {
  if (!value) return '尚未查询';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
}
