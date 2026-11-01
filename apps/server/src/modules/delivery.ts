export interface DeliveryTarget { platform: 'qq' | 'telegram'; kind: 'private' | 'group'; id: string }
export class DeliveryError extends Error {
  retryable: boolean; retryAfterMs: number; unconfirmed: boolean;
  constructor(message: string, retryable: boolean, retryAfterMs = 0, unconfirmed = false) {
    super(message); this.retryable = retryable; this.retryAfterMs = retryAfterMs; this.unconfirmed = unconfirmed;
  }
}
