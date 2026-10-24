import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { SnowLuma } from '../adapters/snowluma.ts';
import { VncAuthentication } from '../adapters/vnc.ts';
import type { Store } from '../infrastructure/store.ts';
import type { MessagePlatforms } from '../adapters/messages.ts';
const address = z.string().url().refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'; }, '请输入不带路径或凭据的 HTTP(S) 驱动地址');
const account = z.string().regex(/^\d{5,12}$/);
export function registerDriverRoutes(app: FastifyInstance, store: Store, platforms: MessagePlatforms, driver: SnowLuma, authorized: (cookie?: string) => boolean, changeChannels: (work: () => Promise<unknown>) => Promise<unknown>) {
  const mutate = (work: () => unknown | Promise<unknown>) => changeChannels(async () => work());
  app.get('/api/qq/driver', async () => driver.state());
  app.get('/api/qq/driver/settings', async () => driver.settings());
  app.put('/api/qq/driver/settings', async request => mutate(() => {
    driver.saveSettings(z.object({ apiUrl: address, desktopUrl: address }).parse(request.body)); return driver.settings();
  }));
  app.post('/api/qq/driver/login', async request => mutate(async () => {
    const { password } = z.object({ password: z.string().min(1).max(1000) }).parse(request.body);
    await driver.login(password); return { ok: true };
  }));
  app.post('/api/qq/driver/consent', async request => mutate(async () => {
    const { version } = z.object({ version: z.string().min(1).max(100), confirmed: z.literal(true) }).parse(request.body);
    await driver.consent(version); return { ok: true };
  }));
  app.post('/api/qq/driver/password', async request => mutate(async () => {
    const { password } = z.object({ password: z.string().min(1).max(1000) }).parse(request.body);
    const strength = await driver.strength(password);
    if (!strength.valid) return { ok: false, rules: strength.rules };
    await driver.changePassword(password); return { ok: true };
  }));
  app.get<{ Params: { uin: string } }>('/api/qq/driver/networks/:uin', async request => ({ networks: await driver.networks(account.parse(request.params.uin)) }));
  app.post('/api/qq/driver/connect', async request => mutate(async () => {
    const input = z.object({ uin: account, index: z.number().int().min(-1).max(100) }).parse(request.body);
    const prepared = await driver.prepareConnection(input.uin, input.index);
    await platforms.stop();
    try { store.saveChannel({ ...store.channel('qq'), endpoint: prepared.endpoint, token: prepared.token }); }
    finally { await platforms.configure(); }
    return { ok: true, reloaded: prepared.reloaded };
  }));
  app.post('/api/qq/driver/process', async request => mutate(async () => {
    const { pid, action } = z.object({ pid: z.number().int().min(1).max(4194304), action: z.enum(['load', 'refresh']) }).parse(request.body);
    await driver.process(pid, action); return { ok: true };
  }));
  app.get('/api/qq/driver/logs', async () => ({ logs: await driver.logs() }));

  const prefix = '/api/qq/desktop/';
  app.get<{ Params: { '*': string } }>(`${prefix}*`, async (request, reply) => {
    const target = new URL(driver.settings().desktopUrl), incoming = new URL(request.url, 'http://quotaradar.local');
    target.pathname = incoming.pathname.slice(prefix.length) || 'vnc.html'; target.search = incoming.search;
    let response: Response;
    try { response = await fetch(target, { signal: AbortSignal.timeout(15000), redirect: 'manual' }); }
    catch { return reply.code(502).type('text/plain; charset=utf-8').send('QQ 登录桌面无法连接，请检查 SnowLuma 是否启动以及登录桌面地址。'); }
    const location = response.headers.get('location');
    if (location && response.status >= 300 && response.status < 400) {
      const redirected = new URL(location, target);
      if (redirected.origin !== target.origin) return reply.code(502).send({ error: 'QQ 登录桌面返回了不同站点的重定向' });
      return reply.redirect(`${prefix}${redirected.pathname.slice(1)}${redirected.search}`);
    }
    reply.code(response.status).header('Content-Type', response.headers.get('content-type') || 'application/octet-stream').header('Cache-Control', 'no-store');
    return response.body ? reply.send(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)) : reply.send();
  });
  const sockets = new Set<WebSocket>(), pendingSockets = new Set<import('node:stream').Duplex>();
  const server = new WebSocketServer({ noServer: true });
  const upgrade = (request: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    const path = new URL(request.url || '/', 'http://quotaradar.local').pathname;
    if (path !== `${prefix}websockify`) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    let sameOrigin = true;
    try { sameOrigin = !request.headers.origin || new URL(request.headers.origin).host === request.headers.host; } catch { sameOrigin = false; }
    if (!authorized(request.headers.cookie) || !sameOrigin) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const target = new URL(driver.settings().desktopUrl); target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'; target.pathname = '/websockify';
    const protocols = (request.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim()).filter(Boolean);
    const upstream = new WebSocket(target, protocols, { handshakeTimeout: 10000 }); sockets.add(upstream); pendingSockets.add(socket);
    socket.once('close', () => { pendingSockets.delete(socket); upstream.terminate(); });
    const handshakeError = () => { if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); };
    upstream.on('error', handshakeError);
    upstream.once('close', () => sockets.delete(upstream));
    upstream.once('open', () => {
      if (socket.destroyed) { upstream.terminate(); return; }
      server.handleUpgrade(request, socket, head, downstream => {
        pendingSockets.delete(socket); sockets.add(downstream); upstream.removeListener('error', handshakeError);
        const password = driver.desktopPassword();
        const bridge = password ? new VncAuthentication(password,
          data => { if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: true }); },
          data => { if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary: true }); }) : undefined;
        const timer = bridge ? setTimeout(() => { downstream.close(1008, 'QQ 登录桌面认证超时'); upstream.terminate(); }, 10000) : undefined;
        const relay = (side: 'server' | 'client', data: import('ws').RawData, binary: boolean) => {
          try {
            if (bridge) {
              if (!binary) throw new Error('VNC 需要二进制数据');
              bridge[side](Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data));
              if (bridge.ready) clearTimeout(timer);
            } else {
              const target = side === 'server' ? downstream : upstream;
              if (target.readyState === WebSocket.OPEN) target.send(data, { binary });
            }
          } catch { clearTimeout(timer); downstream.close(1008, 'QQ 登录桌面内部认证失败'); upstream.terminate(); }
        };
        upstream.on('message', (data, binary) => relay('server', data, binary));
        downstream.on('message', (data, binary) => relay('client', data, binary));
        downstream.once('close', () => clearTimeout(timer)); upstream.once('close', () => clearTimeout(timer));
        downstream.on('error', () => upstream.terminate()); upstream.on('error', () => downstream.terminate());
        downstream.once('close', () => { sockets.delete(downstream); upstream.terminate(); });
        upstream.once('close', () => downstream.close());
      });
    });
  };
  app.server.on('upgrade', upgrade);
  app.addHook('preClose', async () => {
    app.server.removeListener('upgrade', upgrade);
    for (const socket of pendingSockets) socket.destroy();
    for (const socket of sockets) socket.terminate();
    server.close();
  });
}
