import { randomBytes } from 'node:crypto';
import { Store } from '../infrastructure/store.ts';
import type { DriverCredentials } from '../../../../packages/shared/driver-auth.ts';
import type { DriverSettings, DriverSettingsInput, DriverState, DriverNetwork, DriverLog } from '../../../../packages/shared/driver.ts';

type StoredSettings = DriverSettingsInput & { password: string };
type Json = Record<string, any>;
export class DriverError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 502) { super(message); this.statusCode = statusCode; }
}
export class SnowLuma {
  store: Store;
  private session: { identity: string; token: string } | null = null;
  private loginPending: Promise<string> | null = null;
  private credentials: DriverCredentials | undefined;
  private defaults: StoredSettings;
  constructor(store: Store, credentials?: DriverCredentials, connection?: DriverSettingsInput) {
    this.store = store; this.credentials = credentials;
    this.defaults = { ...(connection || { apiUrl: process.env.QR_SNOWLUMA_API_URL || 'http://127.0.0.1:5099/', desktopUrl: process.env.QR_SNOWLUMA_DESKTOP_URL || 'http://127.0.0.1:6081/' }), password: '' };
  }
  private stored(): StoredSettings { return this.credentials ? this.defaults : this.store.getValue('qq-driver', this.defaults); }
  settings(): DriverSettings {
    const { password, ...settings } = this.stored(); return { ...settings, hasPassword: Boolean(this.credentials || password), managed: Boolean(this.credentials) };
  }
  desktopPassword(): string | undefined { return this.credentials?.desktopPassword; }
  private requireExternal(): void {
    if (this.credentials) throw new DriverError('QQ 驱动认证由 QuotaRadar 统一管理，请通过部署配置调整', 409);
  }
  reset(): void { this.session = null; this.loginPending = null; }
  saveSettings(input: DriverSettingsInput): void {
    this.requireExternal();
    const previous = this.stored();
    this.store.setValue('qq-driver', { ...input, password: input.apiUrl === previous.apiUrl ? previous.password : '' }); this.reset();
  }
  private identity(settings: StoredSettings): string { return `${settings.apiUrl}:${this.credentials?.managementPassword || settings.password}`; }
  private async exchange(path: string, method = 'GET', body?: unknown, token?: string, settings = this.stored()): Promise<Json> {
    let response: Response;
    try {
      response = await fetch(new URL(`api/${path}`, settings.apiUrl.endsWith('/') ? settings.apiUrl : `${settings.apiUrl}/`), {
        method, redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new DriverError('QQ 驱动无法连接，请检查 SnowLuma 是否运行及后端连接地址'); }
    let data: Json;
    try { data = await response.json() as Json; if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); }
    catch { throw new DriverError('QQ 驱动响应格式不正确，请核对版本与管理地址'); }
    if (!response.ok || data.success === false) {
      if (response.status === 401) throw new DriverError('QQ 驱动密码不正确或认证已失效，请重新认证', 409);
      if (response.status === 429) throw new DriverError('QQ 驱动暂时限制认证尝试，请稍后再试', 429);
      if (data.consentRequired) throw new DriverError('QQ 驱动需要先阅读并确认使用协议', 409);
      if (data.mustChangePassword) throw new DriverError('QQ 驱动需要先修改初始密码', 409);
      if (response.status === 404) throw new DriverError('QQ 驱动不提供所需管理接口，请核对 SnowLuma 版本');
      if (path === 'auth/change-password') throw new DriverError('QQ 驱动未接受新密码，请检查密码强度规则', 400);
      throw new DriverError('QQ 驱动操作未成功，请刷新状态后重试', response.status === 409 ? 409 : 502);
    }
    return data;
  }
  async login(password: string): Promise<void> {
    this.requireExternal();
    const settings = this.stored(), identity = this.identity(settings);
    const data = await this.exchange('login', 'POST', { password }, undefined, settings);
    if (typeof data.token !== 'string' || !data.token) throw new DriverError('QQ 驱动没有返回管理会话');
    if (identity !== this.identity(this.stored())) throw new DriverError('QQ 驱动地址已经改变，请重新认证', 409);
    const saved = { ...settings, password: this.store.vault.encrypt(password) };
    this.store.setValue('qq-driver', saved); this.session = { identity: this.identity(saved), token: data.token };
  }
  private async token(): Promise<string> {
    const settings = this.stored(), identity = this.identity(settings);
    if (this.session?.identity === identity) return this.session.token;
    if (!this.credentials && !settings.password) throw new DriverError('QQ 驱动尚未认证，请填写首次启动日志中的管理密码', 409);
    if (!this.loginPending) {
      const password = this.credentials?.managementPassword || this.store.vault.decrypt(settings.password);
      const pending = this.exchange('login', 'POST', { password }, undefined, settings).then(data => {
        if (typeof data.token !== 'string' || !data.token) throw new DriverError('QQ 驱动没有返回管理会话');
        if (identity !== this.identity(this.stored())) throw new DriverError('QQ 驱动配置已经改变，请重试', 409);
        this.session = { identity, token: data.token }; return data.token;
      }).finally(() => { if (this.loginPending === pending) this.loginPending = null; });
      this.loginPending = pending;
    }
    return this.loginPending;
  }
  async request(path: string, method = 'GET', body?: unknown): Promise<Json> {
    const settings = this.stored(), identity = this.identity(settings), token = await this.token();
    if (identity !== this.identity(this.stored())) throw new DriverError('QQ 驱动配置已经改变，请重试', 409);
    try { return await this.exchange(path, method, body, token, settings); }
    catch (error) {
      if (error instanceof DriverError && error.message.includes('认证已失效')) this.reset();
      throw error;
    }
  }
  async state(): Promise<DriverState> {
    const state: DriverState = { settings: this.settings(), authenticated: false, mustChangePassword: false, consentRequired: false, agreementVersion: '', documents: [], accounts: [], processes: [] };
    if (!state.settings.hasPassword) return state;
    const [auth, agreements] = await Promise.all([this.request('auth/state'), this.request('agreements')]);
    state.authenticated = true; state.mustChangePassword = auth.mustChangePassword === true; state.consentRequired = agreements.consentRequired === true;
    state.agreementVersion = typeof agreements.version === 'string' ? agreements.version : '';
    state.documents = Array.isArray(agreements.documents) ? agreements.documents.map((doc: Json) => ({ id: String(doc.id), title: String(doc.title || doc.id), text: String(doc.text || '') })) : [];
    if (state.consentRequired || state.mustChangePassword) return state;
    const [accounts, processes] = await Promise.all([this.request('qq-list'), this.request('processes')]);
    if (!Array.isArray(accounts.list) || !Array.isArray(processes.list)) throw new DriverError('QQ 驱动账号响应不符合 v1.10.0 管理协议');
    state.accounts = accounts.list.map((a: Json) => ({ uin: String(a.uin), nickname: String(a.nickname || a.uin) }));
    state.processes = processes.list.map((p: Json) => ({ pid: Number(p.pid), name: String(p.name || 'QQ'), uin: String(p.uin || ''), status: String(p.status || 'unknown'), connected: p.connected === true, loggedIn: p.loggedIn === true }));
    return state;
  }
  async agreements(): Promise<Json> { return this.request('agreements'); }
  async consent(version: string): Promise<void> { await this.request('agreements/record-consent', 'POST', { version }); }
  async changePassword(newPassword: string): Promise<void> {
    this.requireExternal();
    const settings = this.stored();
    await this.request('auth/change-password', 'POST', { oldPassword: this.store.vault.decrypt(settings.password), newPassword });
    this.store.setValue('qq-driver', { ...settings, password: this.store.vault.encrypt(newPassword) }); this.reset();
  }
  async strength(password: string): Promise<Json> { this.requireExternal(); return this.request('auth/check-strength', 'POST', { password }); }
  private async config(uin: string): Promise<Json> {
    const data = await this.request(`config/${uin}`);
    if (!data.config || !Array.isArray(data.config.networks?.wsServers)) throw new DriverError('QQ 驱动的 WebSocket 配置格式不正确');
    return data.config;
  }
  async networks(uin: string): Promise<DriverNetwork[]> {
    const config = await this.config(uin);
    return config.networks.wsServers.flatMap((network: Json, index: number) => !network.role || network.role === 'Universal' ? [{ index, name: String(network.name), port: Number(network.port), path: String(network.path || '/'), enabled: network.enabled !== false }] : []);
  }
  async prepareConnection(uin: string, index: number): Promise<{ endpoint: string; token: string; reloaded: boolean }> {
    const config = await this.config(uin);
    let network: Json;
    if (index === -1 && config.networks.wsServers.length === 0) {
      network = { name: 'QuotaRadar', host: '0.0.0.0', port: 3001, path: '/', role: 'Universal', enabled: true, messageFormat: 'array', reportSelfMessage: false, accessToken: randomBytes(24).toString('base64url') };
      config.networks.wsServers.push(network);
    } else {
      network = config.networks.wsServers[index];
      if (!network || (network.role && network.role !== 'Universal')) throw new DriverError('QQ 驱动请选择支持消息与动作的 WebSocket 入口', 400);
    }
    if (!Number.isInteger(network.port) || network.port < 1 || network.port > 65535 || (network.path && (!network.path.startsWith('/') || network.path.startsWith('//') || /[?#]/.test(network.path)))) throw new DriverError('QQ 驱动 WebSocket 端口或路径不正确', 400);
    const endpoint = new URL(this.settings().apiUrl); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    endpoint.port = String(network.port); endpoint.pathname = network.path || '/'; endpoint.search = ''; endpoint.hash = '';
    const token = network.accessToken || randomBytes(24).toString('base64url');
    const changed = network.enabled === false || network.accessToken !== token || index === -1;
    let reloaded = true;
    if (changed) { network.enabled = true; network.accessToken = token; const saved = await this.request(`config/${uin}`, 'POST', config); reloaded = saved.reloaded === true; }
    return { endpoint: endpoint.href, token, reloaded };
  }
  async process(pid: number, action: 'load' | 'refresh'): Promise<void> { await this.request(`processes/${pid}/${action}`, 'POST'); }
  async logs(): Promise<DriverLog[]> {
    const data = await this.request('logs?limit=100');
    if (!Array.isArray(data.list)) throw new DriverError('QQ 驱动日志响应格式不正确');
    const secrets = [this.store.channelToken('qq'), this.credentials?.managementPassword || '', this.credentials?.desktopPassword || '', this.stored().password ? this.store.vault.decrypt(this.stored().password) : '', this.session?.token || ''].filter(Boolean);
    const redact = (text: string) => secrets.reduce((value, secret) => value.split(secret).join('[已隐藏]'), text).replace(/(Bearer\s+)[^\s"',]+/gi, '$1[已隐藏]').replace(/((?:access[_-]?token|password|token)\s*[=:]\s*["']?)[^\s"',}]+/gi, '$1[已隐藏]');
    return data.list.slice(-100).map((log: Json) => ({ id: Number(log.id), time: String(log.time || ''), level: String(log.level || 'info'), message: redact(String(log.message || log.line || '')) }));
  }
}
