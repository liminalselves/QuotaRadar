import { createHmac } from 'node:crypto';

export interface DriverCredentials { managementPassword: string; desktopPassword: string }

export function driverCredentials(adminPassword: string): DriverCredentials {
  if (!adminPassword) throw new Error('统一 QQ 管理需要设置 QuotaRadar 管理密码');
  const derive = (purpose: string) => createHmac('sha256', adminPassword).update(`quotaradar:snowluma:v1:${purpose}`).digest('base64url');
  return { managementPassword: `Qr!${derive('management')}`, desktopPassword: derive('desktop').slice(0, 8) };
}
