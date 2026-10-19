import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  InternalServerErrorException,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { validateFulfillmentEvent } from './validate-event.js';
import { WebhookIntakeService } from './webhook-intake.service.js';
import { WebhookSignatureService } from './webhook-signature.service.js';
import { WebhookReplayService } from './webhook-replay.service.js';
import { WebhookTimelineService } from './webhook-timeline.service.js';
import type { WebhookTimeline } from './webhook-timeline.service.js';
import type { ReplayResult } from './webhook-replay.service.js';
import { validateReplayRequest } from './validate-replay-request.js';
import { validateDemoRequest } from './validate-demo-request.js';
import { runtimeConfig } from '../config/runtime-config.js';

@Controller('webhooks')
export class WebhooksController {
  constructor(
    @Inject(WebhookIntakeService) private readonly intake: WebhookIntakeService,
    @Inject(WebhookSignatureService) private readonly signatures: WebhookSignatureService,
    @Inject(WebhookTimelineService) private readonly timelines: WebhookTimelineService,
    @Inject(WebhookReplayService) private readonly replays: WebhookReplayService,
  ) {}

  @Get('timeline')
  getTimeline(
    @Query('source') source: string | undefined,
    @Query('eventId') eventId: string | undefined,
  ): Promise<WebhookTimeline> {
    return this.timelines.find(source, eventId);
  }

  @Get('events')
  getEvents(): Promise<{ events: Record<string, unknown>[] }> {
    return this.timelines.list();
  }

  @Post('replay')
  @HttpCode(HttpStatus.ACCEPTED)
  replay(@Body() body: unknown): Promise<ReplayResult> {
    return this.replays.replay(validateReplayRequest(body));
  }

  @Post('demo')
  @HttpCode(HttpStatus.ACCEPTED)
  async sendDemo(@Body() body: unknown): Promise<{
    status: 'accepted';
    source: string;
    eventId: string;
    duplicate: boolean;
    controlsConfigured: boolean;
  }> {
    if (!runtimeConfig.demoControlsEnabled) {
      throw new ForbiddenException('Dashboard event controls are disabled in production');
    }
    const demo = validateDemoRequest(body);
    const rawBody = Buffer.from(JSON.stringify(demo.event));
    this.signatures.verify(rawBody, this.signatures.sign(rawBody));
    const result = await this.intake.accept(demo.event, rawBody, {
      transientFailures: demo.transientFailures,
      crashAfterClaim: demo.crashAfterClaim,
    });

    return {
      status: 'accepted',
      source: demo.event.source,
      eventId: demo.event.eventId,
      duplicate: result.duplicate,
      controlsConfigured: result.controlsConfigured,
    };
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async receive(
    @Req() request: RawBodyRequest<IncomingMessage>,
    @Body() body: unknown,
    @Headers('x-webhook-signature') signature: string | undefined,
  ): Promise<{ status: 'accepted'; source: string; eventId: string; duplicate: boolean }> {
    if (!request.rawBody) {
      throw new InternalServerErrorException('Raw request body is unavailable for signature verification');
    }

    this.signatures.verify(request.rawBody, signature);
    const event = validateFulfillmentEvent(body);
    const result = await this.intake.accept(event, request.rawBody);

    return {
      status: 'accepted',
      source: event.source,
      eventId: event.eventId,
      duplicate: result.duplicate,
    };
  }
}
