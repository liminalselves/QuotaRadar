import Fastify from 'fastify';
import serveStatic from '@fastify/static';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Store } from '../infrastructure/store.ts';
import { backupMaxBytes, createBackup, restoreBackup } from '../infrastructure/backup.ts';
import { RefreshService } from '../modules/refresh.ts';
import { Commands } from '../modules/commands.ts';
import { Scheduler } from '../modules/scheduler.ts';
import { MessagePlatforms } from '../adapters/messages.ts';
import { channelSchema, keySchema, providerSchema, settingsSchema } from './schemas.ts';
import { mask } from '../infrastructure/vault.ts';
import { SnowLuma, DriverError } from '../adapters/snowluma.ts';
import { registerDriverRoutes } from './driver.ts';
import type { DriverCredentials } from '../../../../packages/shared/driver-auth.ts';
import type { DriverSettingsInput } from '../../../../packages/shared/driver.ts';

export function createApp(store: Store, refresh: RefreshService, platforms: MessagePlatforms, scheduler: Scheduler, options: { webRoot: string; password: string; driverCredentials?: DriverCredentials; driverConnection?: DriverSettingsInput }) {
  if (options.driverCredentials && !options.password) throw new Error('统一 QQ 管理需要设置 QuotaRadar 管理密码');
  const app = Fastify({ bodyLimit: 25 * 1024 * 1024, logger: false });
  let maintenance = false;
  let changingChannels = false;
  const driver = new SnowLuma(store, options.driverCredentials, options.driverConnection);
  const sign = (text: string) => createHmac('sha256', store.vault.key).update(options.password).update('\0').update(text).digest('hex');
  const equals = (a: string, b: string) => { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); };
  const authorized = (cookie = '') => {
    if (!options.password) return true;
    const token = cookie.split(';').map(x => x.trim()).find(x => x.startsWith('qr_session='))?.slice(11) ?? '';
    const [expires, signature] = token.split('.');
    return Boolean(expires && signature && Number(expires) > Date.now() && equals(sign(expires), signature));
  };
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DriverError) return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: error.issues.map(e => `${e.path.join('.') || '配置'}：${e.message}`).join('；') });
    const safe = error instanceof Error ? error.message : '请求失败';
    const known = ['不存在', '已经有相同', '至少', '正在', '请输入', '备份损坏', '先停用', '不能为空', '导入内容', '启用前', '恢复确认'];
    return reply.code(400).send({ error: known.some(k => safe.includes(k)) ? safe : '操作失败，请检查输入或服务状态' });
  });
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    if (request.method !== 'GET' && request.headers.origin) {
      if (new URL(request.headers.origin).host !== request.headers.host) return reply.code(403).send({ error: '请求来源与当前站点不符' });
    }
    if (request.url.startsWith('/api/auth') || request.url === '/api/health') return;
    if (!authorized(request.headers.cookie)) return reply.code(401).send({ error: '请先登录管理台' });
    if (maintenance && request.method !== 'GET') return reply.code(423).send({ error: '正在维护，请稍后再试' });
  });
  registerDriverRoutes(app, store, platforms, driver, authorized, async work => {
    if (changingChannels || maintenance) throw new DriverError('QQ 驱动或平台设置正在保存，请稍后再试', 409);
    changingChannels = true;
    try { return await work(); } finally { changingChannels = false; }
  });
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/auth', async request => ({ authenticated: authorized(request.headers.cookie), required: Boolean(options.password) }));
  app.post('/api/auth', async (request, reply) => {
    const { password } = z.object({ password: z.string().max(1000) }).parse(request.body);
    if (!equals(password, options.password)) return reply.code(401).send({ error: '管理密码不正确' });
    const expires = String(Date.now() + 7 * 86400000);
    reply.header('Set-Cookie', `qr_session=${expires}.${sign(expires)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`);
    return { ok: true };
  });
  app.delete('/api/auth', async (_request, reply) => { reply.header('Set-Cookie', 'qr_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'); return { ok: true }; });
  app.get('/api/state', async () => ({ providers: store.providers(), keys: store.views(), totals: store.totals(), tasks: store.tasks(),
    settings: store.settings(), notifications: store.notifications(), channels: [store.channel('telegram'), store.channel('qq')], statuses: platforms.status }));
  app.post('/api/providers', async request => store.saveProvider(providerSchema.parse(request.body)));
  app.put<{ Params: { id: string } }>('/api/providers/:id', async request => store.saveProvider(providerSchema.parse(request.body), request.params.id));
  app.get<{ Params: { id: string } }>('/api/providers/:id/impact', async request => store.impact(request.params.id));
  app.delete<{ Params: { id: string } }>('/api/providers/:id', async request => { store.deleteProvider(request.params.id); return { ok: true }; });
  app.post('/api/keys', async request => store.saveKey(keySchema.parse(request.body)));
  app.put<{ Params: { id: string } }>('/api/keys/:id', async request => store.saveKey(keySchema.parse(request.body), request.params.id));
  app.delete<{ Params: { id: string } }>('/api/keys/:id', async request => { store.deleteKey(request.params.id); return { ok: true }; });
  app.post('/api/keys/import', async request => {
    const input = z.object({ providerId: z.string(), preview: z.boolean(), rows: z.array(z.object({ name: z.string().trim().min(1).max(100), secret: z.string().trim().min(1).max(4096) })).min(1).max(500) }).parse(request.body);
    if (!store.provider(input.providerId)) throw new Error('供应商不存在');
    const seen = new Set<string>();
    const result = input.rows.map((row, index) => {
      const duplicate = seen.has(row.secret) || store.hasSecret(input.providerId, row.secret); seen.add(row.secret);
      return { index, name: row.name, mask: mask(row.secret), duplicate };
    });
    if (!input.preview) store.transaction(() => {
      for (const row of result.filter(row => !row.duplicate)) store.saveKey({ providerId: input.providerId, name: row.name,
        secret: input.rows[row.index].secret, enabled: true, tags: [], threshold: null, aggregation: 'excluded', balanceGroup: '' });
    });
    return { rows: result, added: input.preview ? 0 : result.filter(row => !row.duplicate).length };
  });
  app.get<{ Params: { id: string }; Querystring: { page?: string } }>('/api/keys/:id/history', async request => {
    const page = z.coerce.number().int().min(0).parse(request.query.page ?? 0);
    return { snapshots: store.history(request.params.id, page), tasks: store.tasks(request.params.id, page) };
  });
  app.post('/api/refresh', async request => {
    const input = z.object({ ids: z.array(z.string()).max(10000).optional(), providerId: z.string().optional() }).parse(request.body ?? {});
    const ids = input.ids ?? store.keys().filter(k => !input.providerId || k.providerId === input.providerId).map(k => k.id);
    return refresh.start(ids, 'web');
  });
  app.put('/api/settings', async request => { const value = settingsSchema.parse(request.body); store.setValue('settings', value); return value; });
  app.put('/api/channels', async request => {
    const input = channelSchema.parse(request.body);
    if (input.enabled && !(input.token ?? store.channelToken(input.platform))) throw new Error('启用前请填写平台 token');
    if (changingChannels) throw new Error('正在保存平台设置，请稍后再试');
    changingChannels = true;
    try {
      const oldToken = store.channelToken(input.platform);
      await platforms.stop();
      store.saveChannel(input);
      if (input.platform === 'telegram' && input.token !== undefined && input.token !== oldToken) store.setValue('telegramOffset', 0);
      await platforms.configure(); return store.channel(input.platform);
    } finally { changingChannels = false; }
  });
  app.post('/api/channels/test', async request => {
    const { platform } = z.object({ platform: z.enum(['qq', 'telegram']) }).parse(request.body);
    const channel = store.channel(platform);
    if (!channel.enabled || !channel.targets.length) throw new Error('启用前请填写 token 和通知目标；测试需要已启用的平台');
    for (const target of channel.targets) await platforms.send({ platform, ...target }, 'QuotaRadar 测试消息：平台连接与通知目标已生效。');
    return { ok: true };
  });
  const exclusive = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    if (maintenance || changingChannels) throw new Error('正在维护或保存平台设置，请稍后再试');
    maintenance = true;
    try { await scheduler.stop(); await refresh.quiesce(); return await operation(); }
    finally { maintenance = false; refresh.resume(); scheduler.start(); }
  };
  app.post('/api/backup', async request => {
    const { password } = z.object({ password: z.string().min(10).max(200) }).parse(request.body);
    return exclusive(() => ({ filename: `quotaradar-${new Date().toISOString().slice(0, 10)}.qrb`, content: createBackup(store, password) }));
  });
  app.post('/api/restore', async request => {
    const { password, content, confirmation } = z.object({ password: z.string().max(200), content: z.string().max(backupMaxBytes), confirmation: z.literal('恢复并覆盖') }).parse(request.body);
    if (confirmation !== '恢复并覆盖') throw new Error('恢复确认不匹配');
    if (store.channel('qq').enabled || store.channel('telegram').enabled) throw new Error('请先停用两个消息平台，再恢复备份');
    return exclusive(async () => {
      await platforms.stop(); restoreBackup(store, content, password); driver.reset();
      for (const platform of ['qq', 'telegram'] as const) store.saveChannel({ ...store.channel(platform), enabled: false });
      return { ok: true };
    });
  });
  if (existsSync(join(options.webRoot, 'index.html'))) {
    app.register(serveStatic, { root: options.webRoot });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: '接口不存在' }) : reply.sendFile('index.html'));
  }
  return app;
}
