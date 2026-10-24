import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Bot } from 'grammy';
import { Store } from '../apps/server/src/infrastructure/store.ts';
import { Vault } from '../apps/server/src/infrastructure/vault.ts';
import { RefreshService } from '../apps/server/src/modules/refresh.ts';
import { Commands } from '../apps/server/src/modules/commands.ts';
import { MessagePlatforms } from '../apps/server/src/adapters/messages.ts';

async function within<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Telegram cancellation timed out')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

for (const phase of ['getMe', 'getWebhookInfo', 'getUpdates']) {
  test(`Telegram 原生取消信号：停止时中断 ${phase} 请求`, { timeout: 10000 }, async () => {
    let started!: () => void, disconnected!: () => void;
    const pending = new Promise<void>(resolve => { started = resolve; });
    const closed = new Promise<void>(resolve => { disconnected = resolve; });
    const calls: string[] = [];
    const server = createServer((request, response) => {
      request.resume();
      const method = request.url?.split('/').pop() || '';
      calls.push(method);
      if (method === phase) {
        response.once('close', disconnected);
        started();
        return;
      }
      response.setHeader('Content-Type', 'application/json');
      const result = method === 'getMe' ? { id: 100001, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' }
        : method === 'getWebhookInfo' ? { url: '', pending_update_count: 0 } : [];
      response.end(JSON.stringify({ ok: true, result }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const store = new Store(':memory:', new Vault(undefined, randomBytes(32)));
    const refresh = new RefreshService(store), platforms = new MessagePlatforms(store, new Commands(store, refresh));
    const controller = new AbortController();
    const bot = new Bot('100001:fixture-only', { client: { apiRoot: `http://127.0.0.1:${(server.address() as { port: number }).port}`, timeoutSeconds: 5 } });
    platforms.bot = bot; platforms.abort = controller;
    try {
      platforms.poll = platforms.telegramLoop(platforms.generation, bot, controller.signal);
      await within(pending);
      await within(platforms.stop());
      await within(closed);
      assert.equal(controller.signal.aborted, true);
      assert.deepEqual(calls, ['getMe', 'getWebhookInfo', 'getUpdates'].slice(0, ['getMe', 'getWebhookInfo', 'getUpdates'].indexOf(phase) + 1));
      assert.equal(platforms.bot, undefined);
      assert.deepEqual(platforms.status.telegram, { connected: false, accountOnline: null, error: null });
    } finally {
      controller.abort(); server.closeAllConnections();
      await platforms.stop(); await refresh.close(); store.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}
