import { Bot, GrammyError } from 'grammy';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChannelStatus } from '../../../../packages/shared/types.ts';
import { Store } from '../infrastructure/store.ts';
import { Commands, splitMessage } from '../modules/commands.ts';
import type { DeliveryTarget } from '../modules/scheduler.ts';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export class MessagePlatforms {
  store: Store; commands: Commands;
  status: Record<'qq' | 'telegram', ChannelStatus> = {
    qq: { connected: false, accountOnline: null, error: null },
    telegram: { connected: false, accountOnline: null, error: null },
  };
  bot: Bot | undefined; socket: WebSocket | undefined;
  generation = 0; abort: AbortController | undefined;
  poll: Promise<void> | undefined;
  reconnect: ReturnType<typeof setTimeout> | undefined;
  heartbeat: ReturnType<typeof setInterval> | undefined;
  replies = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  sends = new Map<string, Promise<void>>();
  qqInFlight = new Set<string>();
  lastSend = new Map<string, number>();
  constructor(store: Store, commands: Commands) { this.store = store; this.commands = commands; }
  async configure(): Promise<void> {
    await this.stop();
    const version = this.generation;
    if (this.store.channel('telegram').enabled) {
      const token = this.store.channelToken('telegram');
      this.bot = new Bot(token, { client: { timeoutSeconds: 35 } });
      this.bot.on('message:text', async context => {
        await this.commands.handle({ platform: 'telegram', text: context.message.text, userId: String(context.from.id),
          groupId: context.chat.type === 'private' ? undefined : String(context.chat.id), botUsername: context.me.username },
        text => this.send({ platform: 'telegram', kind: context.chat.type === 'private' ? 'private' : 'group', id: String(context.chat.id) }, text));
      });
      this.abort = new AbortController(); this.poll = this.telegramLoop(version, this.bot, this.abort.signal);
    }
    if (this.store.channel('qq').enabled) this.connectQQ(version);
  }
  async telegramLoop(version: number, bot: Bot, signal: AbortSignal): Promise<void> {
    // grammY's Node declarations use polyfill types; its client accepts native abort events.
    const telegramSignal = signal as unknown as NonNullable<Parameters<Bot['init']>[0]>;
    while (version === this.generation && !signal.aborted) {
      try {
        await bot.init(telegramSignal);
        const webhook = await bot.api.getWebhookInfo(telegramSignal);
        if (webhook.url) throw new Error('该 Bot 已配置 webhook，请先在 Telegram 侧移除 webhook 再启用轮询');
        const offset = this.store.getValue('telegramOffset', 0);
        const updates = await bot.api.getUpdates({ offset, timeout: 25, allowed_updates: ['message'] }, telegramSignal);
        this.status.telegram = { connected: true, accountOnline: true, error: null };
        for (const update of updates) {
          if (signal.aborted || version !== this.generation) break;
          await bot.handleUpdate(update); this.store.setValue('telegramOffset', update.update_id + 1);
        }
      } catch (error) {
        if (signal.aborted || version !== this.generation) break;
        this.status.telegram = { connected: false, accountOnline: null,
          error: error instanceof GrammyError ? `Telegram 返回 ${error.error_code}，请检查 token、网络或轮询冲突` : 'Telegram 轮询失败，请检查网络、token 或已有 webhook' };
        await delay(5000, undefined, { signal }).catch(() => undefined);
      }
    }
  }
  connectQQ(version: number): void {
    if (version !== this.generation) return;
    const config = this.store.channel('qq');
    const socket = new WebSocket(config.endpoint, { headers: { Authorization: `Bearer ${this.store.channelToken('qq')}` }, handshakeTimeout: 10000 });
    this.socket = socket;
    socket.on('open', () => {
      if (version !== this.generation) { socket.close(); return; }
      this.status.qq = { connected: true, accountOnline: null, error: null };
      const check = async () => {
        try {
          const data = await this.action('get_status', {}) as { online?: boolean; good?: boolean };
          this.status.qq.accountOnline = typeof data.online === 'boolean' ? data.online : null;
        } catch { this.status.qq.accountOnline = null; }
      };
      void check(); clearInterval(this.heartbeat); this.heartbeat = setInterval(() => void check(), 30000); this.heartbeat.unref();
    });
    socket.on('message', raw => {
      if (version !== this.generation) return;
      let event: Record<string, any>;
      try { event = JSON.parse(raw.toString()); } catch { return; }
      if (event.echo && this.replies.has(String(event.echo))) {
        const pending = this.replies.get(String(event.echo))!; clearTimeout(pending.timer); this.replies.delete(String(event.echo));
        if (event.retcode === 0) pending.resolve(event.data); else pending.reject(new Error('QQ 驱动拒绝操作'));
        return;
      }
      if (event.post_type === 'meta_event' && event.meta_event_type === 'heartbeat') {
        this.status.qq.accountOnline = typeof event.status?.online === 'boolean' ? event.status.online : null; return;
      }
      if (event.post_type !== 'message' || event.user_id == event.self_id || !['private', 'group'].includes(event.message_type)) return;
      const id = String(event.message_id ?? '');
      const seen = this.store.getValue<string[]>('qqSeen', []);
      if (id && (seen.includes(id) || this.qqInFlight.has(id))) return;
      if (id) this.qqInFlight.add(id);
      const text = Array.isArray(event.message) ? event.message.filter((s: any) => s.type === 'text').map((s: any) => String(s.data?.text ?? '')).join('')
        : String(event.raw_message ?? event.message ?? '').replace(/\[CQ:[^\]]*\]/g, '');
      void this.commands.handle({ platform: 'qq', userId: String(event.user_id), groupId: event.message_type === 'group' ? String(event.group_id) : undefined, text },
        text => this.send({ platform: 'qq', kind: event.message_type, id: String(event.message_type === 'group' ? event.group_id : event.user_id) }, text))
        .then(() => { if (id) this.store.setValue('qqSeen', [...this.store.getValue<string[]>('qqSeen', []), id].slice(-500)); })
        .catch(() => { this.status.qq.error = 'QQ 消息处理或发送失败'; })
        .finally(() => { if (id) this.qqInFlight.delete(id); });
    });
    socket.on('error', () => { if (version === this.generation) this.status.qq.error = '无法连接 QQ 驱动，请检查地址、token 和驱动状态'; });
    socket.on('close', () => {
      if (version !== this.generation) return;
      clearInterval(this.heartbeat); this.status.qq.connected = false; this.status.qq.accountOnline = null;
      this.rejectPending(); this.reconnect = setTimeout(() => this.connectQQ(version), 5000); this.reconnect.unref();
    });
  }
  action(action: string, params: object): Promise<unknown> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('QQ 驱动尚未连接'));
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.replies.delete(echo); reject(new Error('QQ 操作超时')); }, 10000);
      this.replies.set(echo, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ action, params, echo }), error => { if (error) { clearTimeout(timer); this.replies.delete(echo); reject(new Error('QQ 发送失败')); } });
    });
  }
  send(target: DeliveryTarget, text: string): Promise<void> {
    const queueId = `${target.platform}:${target.id}`;
    const previous = this.sends.get(queueId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(async () => {
      for (const part of splitMessage(text)) {
        const minimum = target.kind === 'group' ? 3100 : 1100;
        await sleep(Math.max(0, (this.lastSend.get(queueId) ?? 0) + minimum - Date.now()));
        if (target.platform === 'qq') {
          const id = Number(target.id);
          if (!Number.isSafeInteger(id)) throw new Error('QQ 目标 ID 无效');
          await this.action(target.kind === 'group' ? 'send_group_msg' : 'send_private_msg', {
            [target.kind === 'group' ? 'group_id' : 'user_id']: id, message: [{ type: 'text', data: { text: part } }],
          });
        } else {
          if (!this.bot || !this.store.channel('telegram').enabled) throw new Error('Telegram 未启用');
          try { await this.bot.api.sendMessage(target.id, part); }
          catch (error) {
            if (error instanceof GrammyError && error.error_code === 429 && error.parameters.retry_after) {
              await sleep(error.parameters.retry_after * 1000); await this.bot.api.sendMessage(target.id, part);
            } else throw new Error('Telegram 消息发送失败');
          }
        }
        this.lastSend.set(queueId, Date.now());
      }
    });
    this.sends.set(queueId, result);
    void result.finally(() => { if (this.sends.get(queueId) === result) this.sends.delete(queueId); }).catch(() => undefined);
    return result;
  }
  rejectPending(): void {
    for (const pending of this.replies.values()) { clearTimeout(pending.timer); pending.reject(new Error('QQ 连接已关闭')); }
    this.replies.clear();
  }
  async stop(): Promise<void> {
    this.generation++; this.abort?.abort(); clearTimeout(this.reconnect); clearInterval(this.heartbeat);
    this.socket?.removeAllListeners(); this.socket?.terminate(); this.socket = undefined; this.rejectPending();
    await this.poll; this.bot = undefined;
    this.status.qq = { connected: false, accountOnline: null, error: null };
    this.status.telegram = { connected: false, accountOnline: null, error: null };
  }
}
