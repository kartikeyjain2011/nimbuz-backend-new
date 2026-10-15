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

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/**
 * Short-lived HMAC token the browser hands to the streaming agent on the VM.
 * The agent verifies it with the same STREAM_TOKEN_SECRET (format: base64url(json).base64url(hmac)).
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
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as StreamClaims;
    return claims.exp > Date.now() / 1000 ? claims : null;
  }

  /** wss URL for the agent. STREAM_URL_TEMPLATE supports {ip} {vm} {region}, e.g. wss://stream.playnimbuz.com/{vm} behind a gateway. */
  url(vars: { ip: string; vm: string; region: string }) {
    const tpl = this.config.get<string>('STREAM_URL_TEMPLATE') ?? 'wss://{ip}:8443/stream';
    return tpl.replace('{ip}', vars.ip).replace('{vm}', vars.vm).replace('{region}', vars.region);
  }
}
