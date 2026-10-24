export type AdapterType = 'openai-billing' | 'newapi-cx' | 'newapi-usage';
export type Scope = 'unknown' | 'token' | 'account';
export type Aggregation = 'excluded' | 'independent' | 'shared';
export type ErrorKind = 'unauthorized' | 'rate_limit' | 'not_found' | 'network' | 'server' | 'format' | 'business' | 'cancelled';
export interface ProviderInput {
  name: string; baseUrl: string; adapter: AdapterType; enabled: boolean;
  unit: string; unitsPerDollar: string; timeoutMs: number; windowDays: number;
  billingWindowConfirmed: boolean; scope: Scope;
  paths: { subscription?: string; usage?: string; quota?: string };
  headers: Record<string, string>;
}
export interface Provider extends ProviderInput { id: string; version: number; createdAt: string }
export interface KeyInput {
  providerId: string; name: string; secret?: string; enabled: boolean;
  tags: string[]; threshold: string | null; aggregation: Aggregation; balanceGroup: string;
}
export interface ApiKey extends Omit<KeyInput, 'secret'> {
  id: string; mask: string; revision: number; createdAt: string;
}
export interface Quota {
  total: string | null; used: string | null; remaining: string | null;
  unlimited: boolean; unit: string; scope: Scope; accuracy: 'confirmed' | 'estimated';
  status: string; active: boolean | null; expiresAt: number | null;
  period: { start: string; end: string } | null;
  raw: Record<string, string | boolean | null>;
}
export interface Snapshot extends Quota {
  id: string; keyId: string; keyRevision: number; providerVersion: number; sampledAt: string;
  segment: string; delta: string | null;
}
export interface RefreshTask {
  id: string; batchId: string; keyId: string; keyRevision: number; providerVersion: number; source: string;
  state: 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
  createdAt: string; finishedAt: string | null; errorKind: ErrorKind | null; error: string | null;
}
export interface KeyView extends ApiKey {
  providerName: string; latest: Snapshot | null; lastTask: RefreshTask | null; stale: boolean; low: boolean;
}
export interface Settings {
  refreshMinutes: number; defaultThreshold: string; failureThreshold: number;
  reminderHours: number; snapshotDays: number; taskDays: number;
  dailyEnabled: boolean; dailyTime: string; timezone: string;
}
export interface ChannelInput {
  platform: 'telegram' | 'qq'; enabled: boolean; token?: string; endpoint: string;
  allowedUsers: string[]; allowedGroups: string[];
  targets: { kind: 'private' | 'group'; id: string }[];
}
export interface Channel extends Omit<ChannelInput, 'token'> { hasToken: boolean }
export interface ChannelStatus {
  connected: boolean; accountOnline: boolean | null; error: string | null;
}
export interface NotificationEvent {
  id: string; keyId: string | null; kind: string; text: string; createdAt: string;
  state: 'pending' | 'sent' | 'failed' | 'skipped'; attempts: number; nextAt: string;
}
export const adapterNames: Record<AdapterType, string> = {
  'openai-billing': 'OpenAI Billing', 'newapi-cx': 'New API · CX', 'newapi-usage': 'New API · Token Usage',
};
export const defaultSettings: Settings = {
  refreshMinutes: 15, defaultThreshold: '20', failureThreshold: 3, reminderHours: 12,
  snapshotDays: 180, taskDays: 30, dailyEnabled: false, dailyTime: '18:00', timezone: 'Asia/Shanghai',
};
export function providerDefaults(adapter: AdapterType = 'openai-billing'): ProviderInput {
  return { name: '', baseUrl: '', adapter, enabled: true, unit: 'USD', unitsPerDollar: '500000',
    timeoutMs: 10000, windowDays: 90, billingWindowConfirmed: false, scope: 'unknown', paths: {}, headers: {} };
}
export function channelDefaults(platform: ChannelInput['platform']): ChannelInput {
  return { platform, enabled: false, endpoint: platform === 'qq' ? 'ws://snowluma:3001/' : '',
    allowedUsers: [], allowedGroups: [], targets: [] };
}
