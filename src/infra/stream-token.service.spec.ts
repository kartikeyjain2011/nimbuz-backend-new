import { createHmac } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { InventoryService } from './inventory.service';
import { StreamTokenService } from './stream-token.service';

const config = (env: Record<string, string>) => ({ get: (k: string) => env[k], getOrThrow: (k: string) => env[k] }) as unknown as ConfigService;
const secret = 'x'.repeat(40);
const claims = { sid: 's1', uid: 'u1', vm: 'vm1', res: '1080', fps: 60 };

describe('StreamTokenService', () => {
  const tokens = new StreamTokenService(config({ STREAM_TOKEN_SECRET: secret }));

  it('round-trips a ticket', () => {
    expect(tokens.verify(tokens.issue(claims))).toMatchObject(claims);
  });

  it('rejects tampered, expired, foreign and garbage tickets', () => {
    const [body, sig] = tokens.issue(claims).split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, uid: 'attacker', exp: 9e9 })).toString('base64url');
    expect(tokens.verify(`${forged}.${sig}`)).toBeNull();
    expect(tokens.verify(tokens.issue(claims, -1))).toBeNull();
    expect(new StreamTokenService(config({ STREAM_TOKEN_SECRET: 'y'.repeat(40) })).verify(`${body}.${sig}`)).toBeNull();
    const junk = 'not-json';
    expect(tokens.verify(`${junk}.${createHmac('sha256', secret).update(junk).digest('base64url')}`)).toBeNull();
    expect(tokens.verify('nodot')).toBeNull();
  });

  it('builds the direct URL from the public IP only', () => {
    expect(tokens.directUrl({ vm: 'vm1', region: 'mumbai', ip: '10.0.0.5', publicIp: '1.2.3.4' })).toBe('wss://ip-1-2-3-4.stream.playnimbuz.com:8443/ws');
    expect(tokens.directUrl({ vm: 'vm1', region: 'mumbai', ip: '10.0.0.5' })).toBeNull();
  });
});

describe('InventoryService.verify', () => {
  const inv = new InventoryService(null as never, null as never, config({ INVENTORY_SECRET: secret }));
  const body = Buffer.from('{"vm":"vm1","games":[]}');
  const good = createHmac('sha256', secret).update(body).digest('hex');

  it('accepts a correct signature with or without the sha256= prefix', () => {
    expect(() => inv.verify(body, `sha256=${good}`)).not.toThrow();
    expect(() => inv.verify(body, good.toUpperCase())).not.toThrow();
  });

  it('rejects missing or wrong signatures', () => {
    expect(() => inv.verify(body, undefined)).toThrow(UnauthorizedException);
    expect(() => inv.verify(Buffer.from('{}'), good)).toThrow(UnauthorizedException);
  });
});
