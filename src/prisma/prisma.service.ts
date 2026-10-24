import { Global, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PrismaService.name);

  constructor() {
    super({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL,
        max: Number(process.env.DB_POOL_MAX ?? 10),
        // Neon (serverless) can take a few seconds to wake from idle, and us-east-2 is ~250 ms away from India
        connectionTimeoutMillis: 15_000,
        idleTimeoutMillis: 60_000,
        keepAlive: true,
      }),
      // interactive/batch transactions: wait longer to acquire a connection on cold starts
      transactionOptions: { maxWait: 10_000, timeout: 20_000 },
    });
  }

  async onModuleInit() {
    const started = Date.now();
    await this.$connect();
    await this.$queryRaw`SELECT 1`; // warm the pool so the first request doesn't pay the cold start
    this.log.log(`Database ready in ${Date.now() - started} ms`);
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
