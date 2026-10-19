import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import type { FulfillmentRequestedEvent } from '../contracts/event-contract.js';

export interface WebhookTestControls {
  transientFailures: number;
  crashAfterClaim: boolean;
}

@Injectable()
export class WebhookIntakeService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async accept(
    event: FulfillmentRequestedEvent,
    rawBody: Buffer,
    testControls?: WebhookTestControls,
  ): Promise<{ duplicate: boolean; controlsConfigured: boolean }> {
    const payload = JSON.stringify(event);
    const payloadSha256 = createHash('sha256').update(rawBody).digest('hex');

    return this.database.withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO webhook_events (source, event_id, event_type, payload)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (source, event_id) DO NOTHING
         RETURNING id`,
        [event.source, event.eventId, event.eventType, payload],
      );

      const duplicate = inserted.rowCount === 0;
      let eventRow = inserted.rows[0];
      if (!eventRow) {
        const existing = await client.query<{ id: string }>(
          'SELECT id FROM webhook_events WHERE source = $1 AND event_id = $2',
          [event.source, event.eventId],
        );
        eventRow = existing.rows[0];
      }

      if (!eventRow) {
        throw new InternalServerErrorException('Could not locate the accepted webhook event');
      }

      await client.query(
        `INSERT INTO webhook_deliveries (webhook_event_id, payload_sha256, is_duplicate)
         VALUES ($1, $2, $3)`,
        [eventRow.id, payloadSha256, duplicate],
      );

      const configureControls = !duplicate && Boolean(
        testControls && (testControls.transientFailures > 0 || testControls.crashAfterClaim),
      );
      if (configureControls && testControls) {
        await client.query(
          `INSERT INTO webhook_test_controls (
             webhook_event_id, transient_failures_remaining, crash_after_claim
           ) VALUES ($1, $2, $3)`,
          [eventRow.id, testControls.transientFailures, testControls.crashAfterClaim],
        );
      }

      return { duplicate, controlsConfigured: configureControls };
    });
  }
}
