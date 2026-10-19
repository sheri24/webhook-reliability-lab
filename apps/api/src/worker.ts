import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module.js';
import { WebhookWorkerService } from './worker/worker.service.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const worker = app.get(WebhookWorkerService);
  const shutdown = new AbortController();
  const stop = (): void => shutdown.abort();

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    await worker.run(shutdown.signal);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await app.close();
  }
}

void bootstrap().catch((error: unknown) => {
  console.error('Worker failed to start:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
