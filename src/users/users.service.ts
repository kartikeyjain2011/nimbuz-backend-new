import { Injectable } from '@nestjs/common';
import { ClerkService } from '../auth/auth';
import { PrismaService } from '../prisma/prisma.service';

type ClerkUserLike = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  imageUrl?: string;
  image_url?: string;
  primaryEmailAddress?: { emailAddress: string } | null;
  email_addresses?: { id: string; email_address: string }[];
  primary_email_address_id?: string;
  first_name?: string | null;
  last_name?: string | null;
};

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clerk: ClerkService,
  ) {}

  /** Normalises both the SDK object and the raw webhook payload. */
  private fromClerk(u: ClerkUserLike) {
    const first = u.firstName ?? u.first_name;
    const last = u.lastName ?? u.last_name;
    const email = u.primaryEmailAddress?.emailAddress ?? u.email_addresses?.find((e) => e.id === u.primary_email_address_id)?.email_address ?? null;
    return {
      email,
      name: [first, last].filter(Boolean).join(' ') || null,
      username: u.username ?? null,
      imageUrl: u.imageUrl ?? u.image_url ?? null,
    };
  }

  async upsertFromClerk(u: ClerkUserLike) {
    const data = this.fromClerk(u);
    return this.prisma.user.upsert({ where: { id: u.id }, create: { id: u.id, ...data, stats: { create: {} } }, update: data });
  }

  /** Make sure a local row exists for this Clerk user (first API call after sign-up). */
  async ensure(userId: string) {
    const existing = await this.prisma.user.findUnique({ where: { id: userId } });
    if (existing) return existing;
    return this.upsertFromClerk(await this.clerk.client.users.getUser(userId));
  }

  async me(userId: string) {
    await this.ensure(userId);
    return this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { subscription: true, stats: true, devices: { orderBy: { lastSeenAt: 'desc' } } } });
  }

  async update(userId: string, dto: { name?: string; username?: string; phone?: string; dateOfBirth?: string }) {
    await this.ensure(userId);
    if (dto.name !== undefined || dto.username !== undefined) {
      const [firstName, ...rest] = (dto.name ?? '').trim().split(/\s+/);
      await this.clerk.client.users.updateUser(userId, {
        ...(dto.name !== undefined && { firstName, lastName: rest.join(' ') }),
        ...(dto.username !== undefined && { username: dto.username }),
      });
    }
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.username !== undefined && { username: dto.username }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.dateOfBirth !== undefined && { dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : null }),
      },
    });
  }

  remove(userId: string) {
    return this.prisma.user.deleteMany({ where: { id: userId } });
  }
}
