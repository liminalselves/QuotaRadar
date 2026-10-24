import type { ErrorKind, Provider, Quota } from '../../../../packages/shared/types.ts';
import { decimal, divide, subtract } from '../../../../packages/shared/amount.ts';

export class QuotaError extends Error {
  kind: ErrorKind;
  retryAfterMs: number;
  constructor(kind: ErrorKind, message: string, retryAfterMs = 0) {
    super(message); this.kind = kind; this.retryAfterMs = retryAfterMs;
  }
}
type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new QuotaError('format', '接口结构不符合查询类型，请检查类型和路径');
  return value as Json;
}
function amount(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new QuotaError('format', '接口额度字段不是数值');
  if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw new QuotaError('format', '接口数值超出安全精度，请让接口返回十进制字符串');
  }
  try { return decimal(value); } catch { throw new QuotaError('format', '接口额度精度或格式不受支持'); }
}
function boolean(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw new QuotaError('format', '无限额度或状态字段格式错误');
  return value;
}
function expiry(value: unknown): number | null {
  if (value === undefined || value === null || value === -1 || value === 0) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new QuotaError('format', '有效期字段格式错误');
  return value;
}
function endpoint(base: string, path: string): URL {
  const origin = new URL(base);
  const url = new URL(`${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`);
  if (url.origin !== origin.origin) throw new QuotaError('format', '查询路径必须属于当前供应商');
  return url;
}
function businessError(data: Json): void {
  if (data.success === false || data.code === false || (typeof data.error === 'object' && data.error !== null)) {
    throw new QuotaError('business', '供应商拒绝查询，请检查凭据、令牌状态或接口类型');
  }
}
export type Fetcher = typeof fetch;
export async function queryQuota(provider: Provider, secret: string, fetcher: Fetcher = fetch, now = new Date()): Promise<Quota> {
  const base = new URL(provider.baseUrl);
  const headers: Record<string, string> = { Accept: 'application/json', ...provider.headers };
  const request = async (path: string, method = 'GET', body?: object): Promise<Json> => {
    const url = endpoint(provider.baseUrl, path);
    const h = { ...headers };
    if (body) {
      h['Content-Type'] = 'application/json'; h.Origin = base.origin;
      h.Referer = `${provider.baseUrl.replace(/\/$/, '')}/token-cx`; h['User-Agent'] = 'Mozilla/5.0 QuotaRadar/0.1';
    } else h.Authorization = `Bearer ${secret}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        response = await fetcher(url, { method, headers: h, body: body ? JSON.stringify(body) : undefined,
          redirect: 'error', signal: AbortSignal.timeout(provider.timeoutMs) });
      } catch {
        if (attempt === 0) continue;
        throw new QuotaError('network', '无法连接供应商或请求超时，请检查地址和网络');
      }
      if (response.status === 401 || response.status === 403) throw new QuotaError('unauthorized', '凭据无效或没有查询权限');
      if (response.status === 404) throw new QuotaError('not_found', '查询接口不存在，请检查接口类型和路径');
      if (response.status === 429) {
        const retry = response.headers.get('retry-after');
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : null;
        const wait = seconds !== null ? seconds * 1000 : Math.max(0, Date.parse(retry ?? '') - Date.now());
        throw new QuotaError('rate_limit', '供应商请求限流，稍后再试', Number.isFinite(wait) && wait > 0 ? wait : 60000);
      }
      if (!response.ok) {
        if (response.status >= 500 && attempt === 0) continue;
        throw new QuotaError(response.status >= 500 ? 'server' : 'business', `供应商返回 HTTP ${response.status}`);
      }
      let data: Json;
      try { data = object(await response.json()); }
      catch { throw new QuotaError('format', '接口未返回有效 JSON，请检查站点地址或查询路径'); }
      businessError(data); return data;
    }
    throw new QuotaError('network', '查询未完成');
  };
  const common = { unit: provider.unit, scope: provider.scope, status: '未知', active: null,
    expiresAt: null, period: null } as const;
  if (provider.adapter === 'openai-billing') {
    const end = now.toISOString().slice(0, 10);
    const start = new Date(now.getTime() - provider.windowDays * 86400000).toISOString().slice(0, 10);
    const subscription = await request(provider.paths.subscription || '/v1/dashboard/billing/subscription');
    const usagePath = provider.paths.usage || '/v1/dashboard/billing/usage';
    const params = new URLSearchParams({ start_date: start, end_date: end });
    const usage = await request(`${usagePath}${usagePath.includes('?') ? '&' : '?'}${params}`);
    const total = amount(subscription.soft_limit_usd);
    const rawUsed = amount(usage.total_usage);
    if (total === null || rawUsed === null) throw new QuotaError('format', 'Billing 接口缺少总额度或用量，不能生成余额');
    const used = divide(rawUsed, '100');
    return { ...common, total, used, remaining: subtract(total, used), unlimited: false,
      accuracy: provider.billingWindowConfirmed ? 'confirmed' : 'estimated', period: { start, end },
      raw: { total, total_usage: rawUsed }, status: '查询成功' };
  }
  const root = provider.adapter === 'newapi-cx'
    ? await request(provider.paths.quota || '/api/token/cx', 'POST', { token: secret })
    : await request(provider.paths.quota || '/api/usage/token/');
  const data = object(root.data);
  const cx = provider.adapter === 'newapi-cx';
  const quota = cx ? object(data.quota) : data;
  const unlimited = boolean(quota.unlimited_quota) ?? false;
  const totalRaw = amount(quota.total_granted), usedRaw = amount(quota.total_used), remainingRaw = amount(quota.total_available);
  if (!unlimited && totalRaw === null && usedRaw === null && remainingRaw === null) throw new QuotaError('format', '响应中没有可识别的额度字段');
  const convert = (n: string | null) => n === null ? null : divide(n, provider.unitsPerDollar);
  const status = cx && data.status ? object(data.status) : {};
  const time = cx && data.time ? object(data.time) : {};
  return { ...common, total: unlimited ? null : convert(totalRaw), used: convert(usedRaw),
    remaining: unlimited ? null : convert(remainingRaw), unlimited, accuracy: 'confirmed',
    status: typeof status.description === 'string' ? status.description.slice(0, 80) : '查询成功',
    active: boolean(status.is_active), expiresAt: expiry(cx ? time.expires_at : data.expires_at),
    raw: { total_granted: totalRaw, total_used: usedRaw, total_available: remainingRaw, unlimited_quota: unlimited } };
}
