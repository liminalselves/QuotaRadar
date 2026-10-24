import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Store } from './store.ts';
import { Vault } from './vault.ts';
const tables = ['providers', 'api_keys', 'snapshots', 'tasks', 'channels', 'kv', 'notifications'] as const;
export const backupMaxBytes = 24 * 1024 * 1024;
type Backup = { version: 1; vault: string; tables: Record<typeof tables[number], Record<string, string>[]> };
export function createBackup(store: Store, password: string): string {
  if (password.length < 10) throw new Error('备份口令至少 10 位');
  const data: Backup = { version: 1, vault: store.vault.key.toString('base64'), tables: {} as Backup['tables'] };
  for (const table of tables) data.tables[table] = store.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, string>[];
  const salt = randomBytes(16), iv = randomBytes(12), key = scryptSync(password, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(gzipSync(JSON.stringify(data))), cipher.final()]);
  const content = JSON.stringify({ format: 'quotaradar-backup-v1', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
  if (Buffer.byteLength(content) > backupMaxBytes) throw new Error('备份压缩后仍超过 24 MiB，请停机复制完整数据目录或数据卷');
  return content;
}
export function restoreBackup(store: Store, text: string, password: string): void {
  let data: Backup;
  try {
    if (Buffer.byteLength(text) > backupMaxBytes) throw new Error();
    const envelope = JSON.parse(text);
    if (envelope.format !== 'quotaradar-backup-v1') throw new Error();
    const key = scryptSync(password, Buffer.from(envelope.salt, 'base64'), 32);
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    data = JSON.parse(gunzipSync(Buffer.concat([cipher.update(Buffer.from(envelope.data, 'base64')), cipher.final()])).toString('utf8'));
    if (data.version !== 1 || !data.tables || Buffer.from(data.vault, 'base64').length !== 32) throw new Error();
    for (const table of tables) {
      if (!Array.isArray(data.tables[table]) || data.tables[table].some(row => !row || typeof row.body !== 'string' || !JSON.parse(row.body))) throw new Error();
    }
  } catch { throw new Error('备份损坏、格式不支持或口令错误，原数据未更改'); }
  const oldVault = new Vault(undefined, Buffer.from(data.vault, 'base64'));
  store.transaction(() => {
    for (const table of [...tables].reverse()) store.db.prepare(`DELETE FROM ${table}`).run();
    for (const table of tables) {
      const fields = table === 'api_keys' ? ['id', 'provider_id', 'fingerprint', 'secret', 'body']
        : table === 'snapshots' ? ['id', 'key_id', 'sampled_at', 'body']
        : table === 'tasks' ? ['id', 'key_id', 'created_at', 'body']
        : table === 'channels' ? ['platform', 'token', 'body'] : ['id', 'body'];
      const insert = store.db.prepare(`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`);
      for (const original of data.tables[table]) {
        const row = { ...original };
        if (table === 'api_keys') {
          const secret = oldVault.decrypt(row.secret); row.secret = store.vault.encrypt(secret); row.fingerprint = store.vault.fingerprint(secret);
        }
        if (table === 'channels' && row.token) row.token = store.vault.encrypt(oldVault.decrypt(row.token));
        if (table === 'kv' && row.id === 'qq-driver') {
          const settings = JSON.parse(row.body);
          if (settings.password) settings.password = store.vault.encrypt(oldVault.decrypt(settings.password));
          row.body = JSON.stringify(settings);
        }
        insert.run(...fields.map(field => row[field]));
      }
    }
    store.recoverTasks();
  });
}
