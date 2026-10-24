export interface DriverSettings { apiUrl: string; desktopUrl: string; hasPassword: boolean; managed: boolean }
export interface DriverSettingsInput { apiUrl: string; desktopUrl: string }
export interface DriverProcess { pid: number; name: string; uin: string; loggedIn: boolean; connected: boolean; status: string }
export interface DriverAccount { uin: string; nickname: string }
export interface DriverDocument { id: string; title: string; text: string }
export interface DriverState {
  settings: DriverSettings; authenticated: boolean; mustChangePassword: boolean; consentRequired: boolean;
  agreementVersion: string; documents: DriverDocument[]; accounts: DriverAccount[]; processes: DriverProcess[];
}
export interface DriverNetwork { index: number; name: string; port: number; path: string; enabled: boolean }
export interface DriverLog { id: number; time: string; level: string; message: string }
