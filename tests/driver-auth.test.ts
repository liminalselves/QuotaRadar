import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scryptSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { exportDriverAssets } from '../scripts/export-driver.ts';
import { driverCredentials } from '../packages/shared/driver-auth.ts';
import { prepareSnowLuma } from '../scripts/snowluma-start.ts';
import { VncAuthentication, vncResponse } from '../apps/server/src/adapters/vnc.ts';

test('统一驱动凭据：用途隔离、稳定派生、管理员密码变化同步轮换', () => {
  const first = driverCredentials('fixture-admin-one');
  assert.deepEqual(first, driverCredentials('fixture-admin-one'));
  assert.notDeepEqual(first, driverCredentials('fixture-admin-two'));
  assert.match(first.managementPassword, /^Qr![A-Za-z0-9_-]{43}$/);
  assert.match(first.desktopPassword, /^[A-Za-z0-9_-]{8}$/);
  assert.notEqual(first.desktopPassword, first.managementPassword.slice(0, 8));
  assert.notEqual(first.desktopPassword, 'vncpasswd');
  assert.throws(() => driverCredentials(''), /管理密码/);
});

test('驱动启动：认证格式符合固定版本，保留协议和运行配置且不写入明文', () => {
  const directory = mkdtempSync(join(tmpdir(), 'quotaradar-managed-'));
  const config = join(directory, 'config'); mkdirSync(config);
  const runtime = '{"webuiPort":5099,"preserve":true}\n', consent = '{"accepted":false}\n';
  writeFileSync(join(config, 'runtime.json'), runtime); writeFileSync(join(config, 'agreements.json'), consent);
  writeFileSync(join(config, 'webui.json'), JSON.stringify({ generatedAt: 'fixture-date', custom: 'keep', mustChangePassword: true }));
  try {
    const first = prepareSnowLuma(directory, 'fixture-admin-one');
    const file = join(config, 'webui.json'), raw = readFileSync(file, 'utf8'), auth = JSON.parse(raw);
    const hash = scryptSync(first.managementPassword, Buffer.from(auth.passwordSalt, 'hex'), 64, { N: 16384, r: 8, p: 1 }).toString('hex');
    assert.equal(auth.passwordHash, hash); assert.equal(auth.mustChangePassword, false);
    assert.equal(auth.custom, 'keep'); assert.equal(auth.generatedAt, 'fixture-date');
    for (const secret of ['fixture-admin-one', first.managementPassword, first.desktopPassword]) assert.equal(raw.includes(secret), false);
    assert.equal(readFileSync(join(config, 'runtime.json'), 'utf8'), runtime);
    assert.equal(readFileSync(join(config, 'agreements.json'), 'utf8'), consent);
    const second = prepareSnowLuma(directory, 'fixture-admin-two'), changed = JSON.parse(readFileSync(file, 'utf8'));
    assert.notEqual(changed.passwordHash, auth.passwordHash);
    assert.equal(changed.passwordHash, scryptSync(second.managementPassword, Buffer.from(changed.passwordSalt, 'hex'), 64, { N: 16384, r: 8, p: 1 }).toString('hex'));
    assert.equal(readdirSync(config).some(name => name.endsWith('.tmp')), false);
    writeFileSync(file, '{broken');
    assert.throws(() => prepareSnowLuma(directory, 'fixture-admin-two'), /原文件未更改/);
    assert.equal(readFileSync(file, 'utf8'), '{broken');
  } finally { rmSync(directory, { recursive: true }); }
});

test('驱动空卷启动：预创建运行配置，空管理员密码不生成凭据', () => {
  const directory = mkdtempSync(join(tmpdir(), 'quotaradar-empty-'));
  try {
    assert.throws(() => prepareSnowLuma(directory, ''), /管理密码/); assert.deepEqual(readdirSync(directory), []);
    prepareSnowLuma(directory, 'fixture-admin');
    assert.equal(readFileSync(join(directory, 'config/runtime.json'), 'utf8'), '{}\n');
    assert.equal(JSON.parse(readFileSync(join(directory, 'config/webui.json'), 'utf8')).mustChangePassword, false);
  } finally { rmSync(directory, { recursive: true }); }
});

test('驱动资源导出：无需仓库源码也能独立初始化统一认证', () => {
  const directory = mkdtempSync(join(tmpdir(), 'quotaradar-assets-'));
  try {
    const assets = join(directory, 'assets'), data = join(directory, 'data');
    exportDriverAssets(assets);
    const module = pathToFileURL(join(assets, 'scripts/snowluma-start.ts')).href;
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
      `const { prepareSnowLuma } = await import(${JSON.stringify(module)}); const credentials = prepareSnowLuma(${JSON.stringify(data)}, 'FixtureAdmin!'); if (credentials.desktopPassword.length !== 8) throw new Error('Invalid exported assets');`],
    { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(data, 'config/webui.json'), 'utf8')).mustChangePassword, false);
    assert.deepEqual(readdirSync(assets).sort(), ['packages', 'scripts']);
  } finally { rmSync(directory, { recursive: true }); }
});

test('VNC DES 响应：标准已知向量验证位翻转和三重密钥等价性', () => {
  const password = Buffer.from('c82cea9ed93dfb8f', 'hex').toString('latin1');
  const challenge = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
  assert.equal(vncResponse(password, challenge).toString('hex'), '85e813540f0ab40585e813540f0ab405');
  assert.throws(() => vncResponse('too-long-password', challenge));
  assert.throws(() => vncResponse('fixture', Buffer.alloc(15)));
});

test('VNC 代理：后端认证、碎片握手、浏览器无密码及大帧透传', () => {
  const upstream: Buffer[] = [], downstream: Buffer[] = [];
  const bridge = new VncAuthentication('fixture!', data => upstream.push(data), data => downstream.push(data));
  bridge.server(Buffer.from('RFB 0')); bridge.server(Buffer.from('03.008\n'));
  assert.equal(Buffer.concat(downstream).toString(), 'RFB 003.008\n');
  bridge.client(Buffer.from('RFB 003.008\n')); assert.equal(upstream.shift()!.toString(), 'RFB 003.008\n');
  bridge.server(Buffer.from([1])); bridge.server(Buffer.from([2])); assert.deepEqual(upstream.shift(), Buffer.from([2]));
  const challenge = Buffer.from(Array.from({ length: 16 }, (_, index) => index));
  bridge.server(challenge.subarray(0, 7)); bridge.server(challenge.subarray(7));
  assert.deepEqual(upstream.shift(), vncResponse('fixture!', challenge));
  assert.equal(downstream.length, 1);
  bridge.server(Buffer.alloc(4)); assert.deepEqual(downstream[1], Buffer.from([1, 1]));
  bridge.client(Buffer.from([1])); assert.deepEqual(downstream[2], Buffer.alloc(4));
  bridge.client(Buffer.from([1])); assert.deepEqual(upstream.shift(), Buffer.from([1])); assert.equal(bridge.ready, true);
  const frame = Buffer.alloc(8192, 255); bridge.server(frame); assert.deepEqual(downstream[3], frame);
  bridge.client(Buffer.from([9, 8, 7])); assert.deepEqual(upstream.shift(), Buffer.from([9, 8, 7]));
});

test('VNC 代理：拒绝无密码上游、错误认证和握手注入', () => {
  const create = () => new VncAuthentication('fixture!', () => {}, () => {});
  const none = create(); none.server(Buffer.from('RFB 003.008\n')); none.client(Buffer.from('RFB 003.008\n'));
  assert.throws(() => none.server(Buffer.from([1, 1])), /未启用/);
  const failed = create(); failed.server(Buffer.from('RFB 003.008\n')); failed.client(Buffer.from('RFB 003.008\n'));
  failed.server(Buffer.from([1, 2])); failed.server(Buffer.alloc(16)); assert.throws(() => failed.server(Buffer.from([0, 0, 0, 1])), /认证失败/);
  const injected = create(); assert.throws(() => injected.client(Buffer.from('RFB 003.008\n')), /协议/);
  assert.throws(() => create().server(Buffer.alloc(4097)), /超限/);
});
