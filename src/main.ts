import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

// Prisma returns BigInt for installBytes; JSON can't serialise BigInt natively
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function (this: bigint) {
  return Number(this);
};

const prod = process.env.NODE_ENV === 'production';

/** Fail fast in production instead of booting with secrets that break payments or streaming at runtime. */
function checkEnv() {
  const required = ['DATABASE_URL', 'CLERK_SECRET_KEY', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'STREAM_TOKEN_SECRET', 'INVENTORY_SECRET', 'CORS_ORIGINS'];
  const missing = required.filter((k) => !process.env[k]?.trim());
  const weak = ['STREAM_TOKEN_SECRET', 'INVENTORY_SECRET'].filter((k) => {
    const v = process.env[k] ?? '';
    return v && (v.length < 32 || /placeholder|change.?me/i.test(v));
  });
  if (missing.length || weak.length) {
    throw new Error(`Refusing to start: ${[...missing.map((k) => `${k} missing`), ...weak.map((k) => `${k} is a placeholder / too short`)].join(', ')}`);
  }
  if (/localhost/.test(process.env.CORS_ORIGINS ?? '')) new Logger('Bootstrap').warn('CORS_ORIGINS contains localhost in production');
}

async function bootstrap() {
  if (prod) checkEnv();

  // rawBody is needed to verify Razorpay and Clerk webhook signatures
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  // behind a load balancer / ingress: real client IPs for rate limiting
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
  app.enableShutdownHooks();
  app.use(helmet());
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(',').map((s) => s.trim()),
    credentials: true,
  });
  app.setGlobalPrefix('v1', { exclude: ['health', 'docs'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  if (!prod || process.env.ENABLE_DOCS === 'true') {
    const docs = new DocumentBuilder().setTitle('Nimbus API').setDescription('Cloud gaming backend for Nimbus').setVersion('1.0').addBearerAuth().build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, docs));
  }

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`Nimbus API listening on :${port}${prod ? '' : `  ·  docs: http://localhost:${port}/docs`}`);
}

void bootstrap();
