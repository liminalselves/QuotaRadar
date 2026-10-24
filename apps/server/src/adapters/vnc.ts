import { createCipheriv } from 'node:crypto';

export function vncResponse(password: string, challenge: Buffer): Buffer {
  if (challenge.length !== 16 || !password || password.length > 8 || [...password].some(char => char.charCodeAt(0) > 255)) throw new Error('VNC 认证参数无效');
  const key = Buffer.alloc(8);
  for (let i = 0; i < password.length; i++) {
    let value = password.charCodeAt(i), reversed = 0;
    for (let bit = 0; bit < 8; bit++) { reversed = (reversed << 1) | (value & 1); value >>= 1; }
    key[i] = reversed;
  }
  // Repeating the DES key three times is equivalent to VNC's single DES operation.
  const cipher = createCipheriv('des-ede3', Buffer.concat([key, key, key]), null); cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

type ServerPhase = 'version' | 'security' | 'challenge' | 'result' | 'ready';
type ClientPhase = 'version' | 'selection' | 'initialization' | 'ready';
export class VncAuthentication {
  private password: string;
  private toServer: (data: Buffer) => void;
  private toClient: (data: Buffer) => void;
  private serverPhase: ServerPhase = 'version';
  private clientPhase: ClientPhase = 'version';
  private serverQueue = Buffer.alloc(0);
  private clientQueue = Buffer.alloc(0);
  constructor(password: string, toServer: (data: Buffer) => void, toClient: (data: Buffer) => void) {
    this.password = password; this.toServer = toServer; this.toClient = toClient;
  }
  get ready(): boolean { return this.serverPhase === 'ready' && this.clientPhase === 'ready'; }
  server(data: Buffer): void {
    if (this.ready) { this.toClient(data); return; }
    if (this.serverQueue.length + data.length > 4096) throw new Error('VNC 握手数据超限');
    this.serverQueue = Buffer.concat([this.serverQueue, data]);
    while (true) {
      if (this.serverPhase === 'version') {
        if (this.serverQueue.length < 12) return;
        const version = this.takeServer(12);
        if (version.toString() !== 'RFB 003.008\n') throw new Error('VNC 协议版本不支持');
        this.serverPhase = 'security'; this.toClient(version);
      } else if (this.serverPhase === 'security') {
        if (!this.serverQueue.length || this.serverQueue.length < this.serverQueue[0] + 1) return;
        const types = this.takeServer(this.serverQueue[0] + 1).subarray(1);
        if (!types.includes(2)) throw new Error('VNC 服务未启用受支持的密码认证');
        this.serverPhase = 'challenge'; this.toServer(Buffer.from([2]));
      } else if (this.serverPhase === 'challenge') {
        if (this.serverQueue.length < 16) return;
        const response = vncResponse(this.password, this.takeServer(16));
        this.serverPhase = 'result'; this.toServer(response);
      } else if (this.serverPhase === 'result') {
        if (this.serverQueue.length < 4) return;
        if (this.takeServer(4).readUInt32BE() !== 0) throw new Error('VNC 内部认证失败，请检查驱动部署');
        this.serverPhase = 'ready'; this.password = ''; this.toClient(Buffer.from([1, 1]));
      } else {
        if (this.serverQueue.length) throw new Error('VNC 握手顺序不正确');
        return;
      }
    }
  }
  client(data: Buffer): void {
    if (this.ready) { this.toServer(data); return; }
    if (this.clientQueue.length + data.length > 4096) throw new Error('VNC 握手数据超限');
    this.clientQueue = Buffer.concat([this.clientQueue, data]);
    while (true) {
      if (this.clientPhase === 'version') {
        if (this.clientQueue.length < 12) return;
        const version = this.takeClient(12);
        if (this.serverPhase === 'version' || version.toString() !== 'RFB 003.008\n') throw new Error('VNC 协议版本不支持');
        this.clientPhase = 'selection'; this.toServer(version);
      } else if (this.clientPhase === 'selection') {
        if (!this.clientQueue.length) return;
        if (this.serverPhase !== 'ready' || this.takeClient(1)[0] !== 1) throw new Error('VNC 握手顺序不正确');
        this.clientPhase = 'initialization'; this.toClient(Buffer.alloc(4));
      } else if (this.clientPhase === 'initialization') {
        if (!this.clientQueue.length) return;
        const initialization = this.takeClient(1);
        if (initialization[0] > 1) throw new Error('VNC 初始化参数无效');
        this.clientPhase = 'ready'; this.toServer(initialization);
        if (this.clientQueue.length) { const remaining = this.clientQueue; this.clientQueue = Buffer.alloc(0); this.toServer(remaining); }
        return;
      } else return;
    }
  }
  private takeServer(length: number): Buffer { const data = this.serverQueue.subarray(0, length); this.serverQueue = this.serverQueue.subarray(length); return data; }
  private takeClient(length: number): Buffer { const data = this.clientQueue.subarray(0, length); this.clientQueue = this.clientQueue.subarray(length); return data; }
}
