import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { vncResponse } from '../../apps/server/src/adapters/vnc.ts';

export async function fakeSnowLuma(options: { desktopPassword?: string } = {}) {
  const state = {
    password: 'FixtureInitial!', token: 'fixture-management-session', consentRequired: true, mustChangePassword: true,
    reloaded: true, logins: 0, writes: 0, desktopLogins: 0, desktopFailures: 0, calls: [] as string[],
    config: { custom: { preserve: true }, networks: { httpServers: [{ port: 3000, name: 'keep-http' }], wsServers: [] as Record<string, any>[], wsClients: [{ url: 'ws://example.invalid/keep' }] } },
    loginWait: null as Promise<void> | null,
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://fixture.local'); state.calls.push(`${request.method} ${url.pathname}`);
    const json = (status: number, body: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (!url.pathname.startsWith('/api/')) {
      if (url.pathname === '/redirect') { response.writeHead(302, { Location: '/vnc.html' }); response.end(); return; }
      if (url.pathname === '/external-redirect') { response.writeHead(302, { Location: 'https://example.invalid/' }); response.end(); return; }
      if (url.pathname === '/core/fixture.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(`const path = new URLSearchParams(location.search).get('path') || 'websockify'; const url = new URL(path, location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; const socket = new WebSocket(url); socket.onopen = () => socket.send(new Uint8Array([1,2,3])); socket.onmessage = () => document.getElementById('connection').textContent = '模拟桌面 WebSocket 已连通（未接入 QQ）';`); return;
      }
      if (url.pathname === '/vnc.html') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>模拟登录桌面</title><body><h1>模拟 QQ 登录桌面</h1><p id="connection">正在连接模拟桌面…</p><p>此页面只验证站内转发，没有连接真实 QQ。</p><script src="core/fixture.js"></script></body></html>'); return;
      }
      response.writeHead(404); response.end(); return;
    }
    let body: any = {};
    try { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString()); }
    catch { json(400, { success: false }); return; }
    if (url.pathname === '/api/login') {
      state.logins++; if (state.loginWait) await state.loginWait;
      if (body.password !== state.password) { json(401, { message: `never expose password=${state.password}` }); return; }
      json(200, { success: true, token: state.token, mustChangePassword: state.mustChangePassword }); return;
    }
    if (request.headers.authorization !== `Bearer ${state.token}`) { json(401, { success: false }); return; }
    if (url.pathname === '/api/auth/state') { json(200, { mustChangePassword: state.mustChangePassword }); return; }
    if (url.pathname === '/api/agreements') { json(200, { version: 'fixture-version', consentRequired: state.consentRequired, documents: [{ id: 'eula', title: '模拟使用协议', text: '# 本地协议夹具\n仅验证明确确认流程。' }, { id: 'privacy', title: '模拟隐私说明', text: '仅使用合成测试数据。' }] }); return; }
    if (url.pathname === '/api/agreements/record-consent') {
      if (body.version !== 'fixture-version') { json(409, { currentVersion: 'fixture-version' }); return; }
      state.consentRequired = false; json(200, { success: true }); return;
    }
    if (state.consentRequired) { json(403, { consentRequired: true }); return; }
    if (url.pathname === '/api/auth/check-strength') {
      const rules = [{ id: 'length', label: '长度不少于 10 位', ok: body.password?.length >= 10 }, { id: 'lower', label: '包含小写字母', ok: /[a-z]/.test(body.password) }, { id: 'upper', label: '包含大写字母', ok: /[A-Z]/.test(body.password) }, { id: 'special', label: '包含特殊符号 (!@#$%…)', ok: /[^A-Za-z0-9\s]/.test(body.password) }, { id: 'no-space', label: '不包含空格', ok: Boolean(body.password) && !/\s/.test(body.password) }];
      json(200, { rules, valid: rules.every(rule => rule.ok) }); return;
    }
    if (url.pathname === '/api/auth/change-password') {
      if (body.oldPassword !== state.password || body.newPassword === state.password) { json(400, { success: false }); return; }
      state.password = body.newPassword; state.token += '-changed'; state.mustChangePassword = false; json(200, { success: true, requireRelogin: true }); return;
    }
    if (state.mustChangePassword) { json(403, { mustChangePassword: true }); return; }
    if (url.pathname === '/api/qq-list') { json(200, { list: [{ uin: '100001', nickname: '本地模拟账号' }] }); return; }
    if (url.pathname === '/api/processes') { json(200, { list: [{ pid: 1234, name: 'QQ fixture', path: '/not-exposed', uin: '100001', connected: true, loggedIn: true, status: 'online' }] }); return; }
    if (/^\/api\/processes\/1234\/(load|refresh)$/.test(url.pathname)) { json(200, { success: true, process: { status: 'online' } }); return; }
    if (url.pathname === '/api/config/100001') {
      if (request.method === 'POST') { state.config = body; state.writes++; json(200, { success: true, reloaded: state.reloaded }); }
      else json(200, { config: state.config }); return;
    }
    if (url.pathname === '/api/logs') { json(200, { list: [{ id: 1, time: '2026-10-18T12:00:00.000Z', level: 'info', message: `password=${state.password} Bearer ${state.token} accessToken=${state.config.networks.wsServers[0]?.accessToken || 'fixture-onebot'}`, line: 'not exposed' }] }); return; }
    json(404, { success: false });
  });
  const sockets = new WebSocketServer({ server, path: '/websockify' });
  sockets.on('connection', socket => {
    if (!options.desktopPassword) { socket.on('message', (data, binary) => socket.send(data, { binary })); return; }
    const challenge = Buffer.from(Array.from({ length: 16 }, (_, index) => index));
    let phase = 0;
    socket.send(Buffer.from('RFB 003.008\n'));
    socket.on('message', data => {
      const value = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (phase === 0 && value.toString() === 'RFB 003.008\n') { phase++; socket.send(Buffer.from([1, 2])); }
      else if (phase === 1 && value.equals(Buffer.from([2]))) { phase++; socket.send(challenge); }
      else if (phase === 2) {
        if (value.equals(vncResponse(options.desktopPassword!, challenge))) { phase++; socket.send(Buffer.alloc(4)); }
        else { state.desktopFailures++; socket.send(Buffer.from([0, 0, 0, 1])); }
      } else if (phase === 3 && value.length === 1) { phase++; state.desktopLogins++; socket.send(Buffer.from('fixture-desktop')); }
      else if (phase === 4) socket.send(value);
      else socket.close(1008);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  return { state, url, close: async () => { for (const socket of sockets.clients) socket.terminate(); await new Promise<void>(resolve => sockets.close(() => resolve())); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
