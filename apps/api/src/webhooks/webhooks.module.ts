import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { WebhooksController } from './webhooks.controller.js';
import { WebhookIntakeService } from './webhook-intake.service.js';
import { WebhookSignatureService } from './webhook-signature.service.js';
import { WebhookTimelineService } from './webhook-timeline.service.js';
import { WebhookReplayService } from './webhook-replay.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [WebhooksController],
  providers: [WebhookIntakeService, WebhookSignatureService, WebhookTimelineService, WebhookReplayService],
})
export class WebhooksModule {}
