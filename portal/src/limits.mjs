import { randomBytes, createHmac } from 'node:crypto';
import { isIP } from 'node:net';
export class Limits {
  constructor(now = () => performance.now()) { this.now = now; this.reset(); }
  reset() { this.salt = randomBytes(32); this.until = this.now() + 60000; this.buckets = new Map(); this.global = 0; }
  allow(ip) {
    if (this.now() >= this.until) this.reset();
    if (++this.global > 300) return false;
    const key = createHmac('sha256', this.salt).update(ip).digest('hex');
    if (!this.buckets.has(key) && this.buckets.size >= 2048) return false;
    const count = (this.buckets.get(key) || 0) + 1; this.buckets.set(key, count);
    return count <= 30;
  }
}
export function peerIP(req, proxy) {
  const peer = req.socket.remoteAddress || '';
  if (!proxy) return peer; // Ignore every forwarding header in direct mode.
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) throw new Error('Untrusted proxy');
  const ip = req.headers['x-forwarded-for'];
  if (typeof ip !== 'string' || ip.length > 64 || !isIP(ip)) throw new Error('Invalid proxy address');
  return ip;
}
