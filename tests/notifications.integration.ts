import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { Bot } from 'grammy';
import { WebSocketServer } from 'ws';
import { Store } from '../apps/server/src/infrastructure/store.ts';
import { Vault } from '../apps/server/src/infrastructure/vault.ts';
import { RefreshService } from '../apps/server/src/modules/refresh.ts';
import { Commands } from '../apps/server/src/modules/commands.ts';
import { Scheduler } from '../apps/server/src/modules/scheduler.ts';
import { MessagePlatforms } from '../apps/server/src/adapters/messages.ts';
import { channelDefaults } from '../packages/shared/types.ts';

function context() {
  const store = new Store(':memory:', new Vault(undefined, randomBytes(32)));
  const refresh = new RefreshService(store), commands = new Commands(store, refresh);
  const platforms = new MessagePlatforms(store, commands);
  const scheduler = new Scheduler(store, refresh, commands, (target, text) => platforms.send(target, text));
  return { store, platforms, scheduler, close: async () => { await scheduler.stop(); await platforms.stop(); await refresh.close(); store.close(); } };
}

for (const mode of ['partial', 'unconfirmed'] as const) {
  test(`QQ 通知实际 WebSocket：${mode === 'partial' ? '长消息从失败段继续' : '发出后断线不自动重发'}`, { timeout: 15000 }, async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>(resolve => server.once('listening', resolve));
    const c = context(), calls: string[] = [];
    let ready!: () => void, rejected = false;
    const connected = new Promise<void>(resolve => { ready = resolve; });
    server.on('connection', socket => {
      socket.on('message', raw => {
        const action = JSON.parse(raw.toString());
        if (action.action === 'get_status') {
          socket.send(JSON.stringify({ echo: action.echo, retcode: 0, data: { online: true } })); ready(); return;
        }
        const text = action.params.message[0].data.text;
        calls.push(text[0]);
        if (mode === 'unconfirmed') { socket.terminate(); return; }
        if (text[0] === 'b' && !rejected) {
          rejected = true; socket.send(JSON.stringify({ echo: action.echo, retcode: 100, status: 'failed' })); return;
        }
        socket.send(JSON.stringify({ echo: action.echo, retcode: 0, data: { message_id: calls.length } }));
      });
    });
    try {
      c.store.saveChannel({ ...channelDefaults('qq'), enabled: true, token: 'fixture-only', endpoint: `ws://127.0.0.1:${(server.address() as { port: number }).port}/`, targets: [{ kind: 'private', id: '1' }] });
      await c.platforms.configure(); await connected;
      c.scheduler.event(null, 'daily', mode === 'partial' ? ['a', 'b', 'c'].map(letter => letter.repeat(2000)).join('\n') : 'a single message');
      await c.scheduler.flush();
      const event = c.store.notifications()[0];
      assert.equal(event.state, mode === 'partial' ? 'pending' : 'failed');
      c.store.saveNotification({ ...event, nextAt: new Date(0).toISOString() });
      await c.scheduler.flush();
      assert.deepEqual(calls, mode === 'partial' ? ['a', 'b', 'b', 'c'] : ['a']);
      assert.equal(c.store.notifications()[0].state, mode === 'partial' ? 'sent' : 'failed');
    } finally {
      await c.close(); for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}

for (const mode of ['rate_limit', 'unconfirmed'] as const) {
  test(`Telegram 通知实际 HTTP：${mode === 'rate_limit' ? '遵守限流后重试' : '发出后连接中断不自动重发'}`, { timeout: 10000 }, async () => {
    const calls: string[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        calls.push(JSON.parse(body).text);
        if (mode === 'unconfirmed') { response.destroy(); return; }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(calls.length === 1 ? { ok: false, error_code: 429, description: 'Fixture rate limit', parameters: { retry_after: 120 } }
          : { ok: true, result: { message_id: 1 } }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const c = context();
    try {
      c.store.saveChannel({ ...channelDefaults('telegram'), enabled: true, targets: [{ kind: 'private', id: '1' }] });
      c.platforms.bot = new Bot('100001:fixture-only', { client: { apiRoot: `http://127.0.0.1:${(server.address() as { port: number }).port}`, timeoutSeconds: 2 } });
      const before = Date.now();
      c.scheduler.event(null, 'daily', 'Fixture daily'); await c.scheduler.flush();
      const event = c.store.notifications()[0];
      assert.equal(event.state, mode === 'rate_limit' ? 'pending' : 'failed');
      if (mode === 'rate_limit') assert.ok(Date.parse(event.nextAt) >= before + 120000);
      c.store.saveNotification({ ...event, nextAt: new Date(0).toISOString() }); await c.scheduler.flush();
      assert.equal(calls.length, mode === 'rate_limit' ? 2 : 1);
      assert.equal(c.store.notifications()[0].state, mode === 'rate_limit' ? 'sent' : 'failed');
    } finally {
      await c.close(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
