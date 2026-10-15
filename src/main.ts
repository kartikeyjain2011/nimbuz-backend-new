import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody is needed to verify Razorpay and Clerk webhook signatures
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.use(helmet());
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(',').map((s) => s.trim()),
    credentials: true,
  });
  app.setGlobalPrefix('v1', { exclude: ['health', 'docs'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const docs = new DocumentBuilder().setTitle('Nimbus API').setDescription('Cloud gaming backend for Nimbus').setVersion('1.0').addBearerAuth().build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, docs));

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  console.log(`Nimbus API on http://localhost:${port}  ·  docs: http://localhost:${port}/docs`);
}

void bootstrap();
