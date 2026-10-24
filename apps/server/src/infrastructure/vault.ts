import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export class Vault {
  key: Buffer;
  constructor(directory?: string, key?: Buffer) {
    if (key) { this.key = key; return; }
    if (!directory) throw new Error('缺少数据目录');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'vault.key');
    if (!existsSync(path)) {
      if (existsSync(join(directory, 'quotaradar.sqlite'))) throw new Error('数据库已存在但 vault.key 丢失，请恢复原密钥文件或加密备份');
      writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' });
    }
    this.key = readFileSync(path);
    if (this.key.length !== 32) throw new Error('vault.key 损坏，请从备份恢复，不能重新生成');
  }
  encrypt(value: string): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const payload = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), payload]).toString('base64');
  }
  decrypt(value: string): string {
    const b = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    decipher.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString('utf8');
  }
  fingerprint(value: string): string { return createHmac('sha256', this.key).update(value).digest('hex'); }
}
export function mask(value: string): string { return value.length > 16 ? `${value.slice(0, 12)}****${value.slice(-4)}` : '****'; }
