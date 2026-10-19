import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { WebhookWorkerService } from './worker.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [WebhookWorkerService],
})
export class WorkerModule {}
