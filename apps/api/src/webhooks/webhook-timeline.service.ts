import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

export type WebhookTimeline = Record<string, unknown>;

@Injectable()
export class WebhookTimelineService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(): Promise<{ events: Record<string, unknown>[] }> {
    const result = await this.database.query<{ event: Record<string, unknown> }>(
      `SELECT jsonb_build_object(
         'source', e.source,
         'eventId', e.event_id,
         'eventType', e.event_type,
         'status', e.status,
         'processingCycle', e.processing_cycle,
         'orderId', e.payload #>> '{data,orderId}',
         'payload', e.payload,
         'deliveryCount', (
           SELECT count(*)::integer
           FROM webhook_deliveries AS delivery
           WHERE delivery.webhook_event_id = e.id
         ),
         'attemptCount', (
           SELECT count(*)::integer
           FROM webhook_processing_attempts AS attempt
           WHERE attempt.webhook_event_id = e.id
         ),
         'nextAttemptAt', e.next_attempt_at,
         'lastErrorClass', e.last_error_class,
         'lastError', e.last_error,
         'leaseExpiresAt', e.lease_expires_at,
         'receivedAt', e.received_at,
         'updatedAt', e.updated_at,
         'fulfillment', (
           SELECT jsonb_build_object(
             'id', fulfillment.id,
             'orderId', fulfillment.order_id,
             'createdByEventId', fulfillment.webhook_event_id,
             'createdAt', fulfillment.created_at
           )
           FROM fulfillments AS fulfillment
           WHERE fulfillment.order_id = e.payload #>> '{data,orderId}'
             AND fulfillment.action = 'fulfill_order'
         )
       ) AS event
       FROM webhook_events AS e
       ORDER BY e.updated_at DESC, e.received_at DESC
       LIMIT 100`,
    );
    return { events: result.rows.map((row) => row.event) };
  }

  async find(source: string | undefined, eventId: string | undefined): Promise<WebhookTimeline> {
    if (!source || !eventId) {
      throw new BadRequestException('Both source and eventId query parameters are required');
    }

    const result = await this.database.query<{ timeline: WebhookTimeline }>(
      `SELECT jsonb_build_object(
         'event', jsonb_build_object(
           'source', e.source,
           'eventId', e.event_id,
           'eventType', e.event_type,
           'status', e.status,
           'processingCycle', e.processing_cycle,
           'nextAttemptAt', e.next_attempt_at,
           'lastErrorClass', e.last_error_class,
           'lastError', e.last_error,
           'leaseExpiresAt', e.lease_expires_at,
           'receivedAt', e.received_at,
           'updatedAt', e.updated_at,
           'payload', e.payload
         ),
         'deliveries', COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'receivedAt', delivery.received_at,
             'payloadSha256', delivery.payload_sha256,
             'duplicate', delivery.is_duplicate
           ) ORDER BY delivery.received_at, delivery.id)
           FROM webhook_deliveries AS delivery
           WHERE delivery.webhook_event_id = e.id
         ), '[]'::jsonb),
         'attempts', COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'attemptNumber', attempt.attempt_number,
             'cycleNumber', attempt.cycle_number,
             'workerId', attempt.worker_id,
             'status', attempt.status,
             'startedAt', attempt.started_at,
             'finishedAt', attempt.finished_at,
             'result', attempt.result,
             'failureClass', attempt.failure_class,
             'errorMessage', attempt.error_message,
             'retryAt', attempt.retry_at,
             'fulfillmentId', attempt.fulfillment_id
           ) ORDER BY attempt.cycle_number, attempt.attempt_number)
           FROM webhook_processing_attempts AS attempt
           WHERE attempt.webhook_event_id = e.id
         ), '[]'::jsonb),
         'replays', COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'processingCycle', replay.processing_cycle,
             'requestedBy', replay.requested_by,
             'reason', replay.reason,
             'previousStatus', replay.previous_status,
             'requestedAt', replay.requested_at
           ) ORDER BY replay.requested_at, replay.id)
           FROM webhook_replays AS replay
           WHERE replay.webhook_event_id = e.id
         ), '[]'::jsonb),
         'fulfillment', (
           SELECT jsonb_build_object(
             'id', fulfillment.id,
             'orderId', fulfillment.order_id,
             'action', fulfillment.action,
             'createdBy', jsonb_build_object(
               'source', creator.source,
               'eventId', creator.event_id
             ),
             'createdAt', fulfillment.created_at
           )
           FROM fulfillments AS fulfillment
           JOIN webhook_events AS creator ON creator.id = fulfillment.webhook_event_id
           WHERE fulfillment.order_id = e.payload #>> '{data,orderId}'
             AND fulfillment.action = 'fulfill_order'
         )
       ) AS timeline
       FROM webhook_events AS e
       WHERE e.source = $1 AND e.event_id = $2`,
      [source, eventId],
    );

    const timeline = result.rows[0]?.timeline;
    if (!timeline) {
      throw new NotFoundException(`No webhook event found for ${source}/${eventId}`);
    }
    return timeline;
  }
}
