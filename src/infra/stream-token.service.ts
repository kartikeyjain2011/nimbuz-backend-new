import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type StreamClaims = {
  sid: string; // session id
  uid: string; // clerk user id
  vm: string; // VM name
  res: string; // max resolution for the plan
  fps: number; // max fps for the plan
  exp: number; // unix seconds
};

export type StreamVars = { vm: string; region: string; ip: string; publicIp?: string };

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/**
 * Short-lived HMAC ticket the browser hands to the streaming agent / signaling server.
 * STREAM_TOKEN_SECRET must be the same "stream ticket secret" the agent reads from the vault.
 * Format: base64url(json).base64url(hmac-sha256(secret, part1)).
 */
@Injectable()
export class StreamTokenService {
  constructor(private readonly config: ConfigService) {}

  private get secret() {
    return this.config.getOrThrow<string>('STREAM_TOKEN_SECRET');
  }

  issue(claims: Omit<StreamClaims, 'exp'>, ttlSeconds = 120) {
    const body = b64url(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
    return `${body}.${b64url(createHmac('sha256', this.secret).update(body).digest())}`;
  }

  verify(token: string): StreamClaims | null {
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = createHmac('sha256', this.secret).update(body).digest();
    const given = Buffer.from(sig, 'base64url');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as StreamClaims;
      return claims.exp > Date.now() / 1000 ? claims : null;
    } catch {
      return null;
    }
  }

  /**
   * Placeholders: {vm} {region} {ip} (pod IP) {public_ip} {dashed_ip} (public IP with dots → dashes).
   * Direct-to-VM on this cluster: wss://ip-{dashed_ip}.stream.playnimbuz.com:8443/ws
   */
  private fill(tpl: string, v: StreamVars) {
    const pub = v.publicIp ?? v.ip;
    return tpl
      .replaceAll('{vm}', v.vm)
      .replaceAll('{region}', v.region)
      .replaceAll('{ip}', v.ip)
      .replaceAll('{public_ip}', pub)
      .replaceAll('{dashed_ip}', pub.replaceAll('.', '-'));
  }

  /** Direct agent URL (needs the VM's public IP for {dashed_ip}). Null if the template needs a public IP we don't have. */
  directUrl(v: StreamVars) {
    const tpl = this.config.get<string>('STREAM_DIRECT_URL_TEMPLATE') ?? 'wss://ip-{dashed_ip}.stream.playnimbuz.com:8443/ws';
    if (/\{(dashed_ip|public_ip)\}/.test(tpl) && !v.publicIp) return null;
    return this.fill(tpl, v);
  }

  /** Shared signaling server (live: wss://signal.playnimbuz.com). */
  signalingUrl(v: StreamVars) {
    const tpl = this.config.get<string>('STREAM_SIGNALING_URL') ?? 'wss://signal.playnimbuz.com';
    return this.fill(tpl, v);
  }
}
