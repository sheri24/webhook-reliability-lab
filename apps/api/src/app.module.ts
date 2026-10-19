import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';

@Module({
  imports: [DatabaseModule, WebhooksModule],
  controllers: [HealthController],
})
export class AppModule {}
