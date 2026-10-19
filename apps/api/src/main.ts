import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { runtimeConfig } from './config/runtime-config.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableCors({ origin: 'http://localhost:5173' });
  app.enableShutdownHooks();
  await app.listen(runtimeConfig.apiPort);
  console.info(`Webhook Reliability Lab API listening at http://localhost:${runtimeConfig.apiPort}`);
}

void bootstrap();
