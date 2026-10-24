import { z } from 'zod';
import { compare } from '../../../../packages/shared/amount.ts';
const amount = z.string().regex(/^\d+(\.\d{1,12})?$/).max(60);
const positive = amount.refine(n => { try { return compare(n, '0') > 0; } catch { return false; } }, '必须大于 0');
const url = z.string().url().refine(text => { const u = new URL(text); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; }, '请输入无凭据、查询参数的 HTTP(S) 地址');
const path = z.string().max(500).refine(p => p.startsWith('/') && !p.startsWith('//') && !p.includes('://') && !p.includes('#'), '请输入站点内以 / 开头的路径');
export const providerSchema = z.object({
  name: z.string().trim().min(1).max(100), baseUrl: url, adapter: z.enum(['openai-billing', 'newapi-cx', 'newapi-usage']),
  enabled: z.boolean(), unit: z.string().trim().min(1).max(12), unitsPerDollar: positive,
  timeoutMs: z.number().int().min(1000).max(60000), windowDays: z.number().int().min(1).max(3660),
  billingWindowConfirmed: z.boolean(), scope: z.enum(['unknown', 'token', 'account']),
  paths: z.object({ subscription: path.optional(), usage: path.optional(), quota: path.optional() }),
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]+$/), z.string().max(1000).refine(s => !/[\r\n]/.test(s))).refine(h => !Object.keys(h).some(k => ['authorization', 'host', 'cookie'].includes(k.toLowerCase())), '鉴权由查询类型负责，不要设置 Authorization、Cookie 或 Host'),
}).refine(p => p.adapter !== 'openai-billing' || p.unit === 'USD', 'Billing 接口金额单位是 USD，不能直接改成其他货币');
export const keySchema = z.object({
  providerId: z.string().min(1), name: z.string().trim().min(1).max(100), secret: z.string().trim().min(1).max(4096).optional(),
  enabled: z.boolean(), tags: z.array(z.string().trim().min(1).max(30)).max(20), threshold: amount.nullable(),
  aggregation: z.enum(['excluded', 'independent', 'shared']), balanceGroup: z.string().trim().max(100),
}).refine(k => k.aggregation !== 'shared' || k.balanceGroup.length > 0, '共享余额必须填写分组名');
export const settingsSchema = z.object({
  refreshMinutes: z.number().int().min(1).max(1440), defaultThreshold: amount, failureThreshold: z.number().int().min(1).max(20),
  reminderHours: z.number().min(1).max(168), snapshotDays: z.number().int().min(1).max(3650), taskDays: z.number().int().min(1).max(365),
  dailyEnabled: z.boolean(), dailyTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().refine(zone => { try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; } }, '无效的 IANA 时区'),
});
const ids = z.array(z.string().regex(/^-?\d+$/)).max(100);
export const channelSchema = z.object({
  platform: z.enum(['telegram', 'qq']), enabled: z.boolean(), token: z.string().max(4096).optional(),
  endpoint: z.string(), allowedUsers: ids, allowedGroups: ids,
  targets: z.array(z.object({ kind: z.enum(['private', 'group']), id: z.string().regex(/^-?\d+$/) })).max(50),
}).refine(c => !c.enabled || c.allowedUsers.length > 0, '启用前至少填写一个允许的个人 ID')
  .refine(c => c.platform !== 'qq' || (() => { try { const u = new URL(c.endpoint); return ['ws:', 'wss:'].includes(u.protocol) && !u.username && !u.password && !u.search; } catch { return false; } })(), 'QQ 地址必须是无凭据的 ws:// 或 wss:// 地址');
