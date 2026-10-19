import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import type { ReplayRequest } from './validate-replay-request.js';

export interface ReplayResult {
  status: 'queued';
  source: string;
  eventId: string;
  processingCycle: number;
  replayId: string;
}

@Injectable()
export class WebhookReplayService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async replay(request: ReplayRequest): Promise<ReplayResult> {
    return this.database.withTransaction(async (client) => {
      const existing = await client.query<{
        id: string;
        source: string;
        event_id: string;
        status: string;
        processing_cycle: number;
      }>(
        `SELECT id, source, event_id, status, processing_cycle
         FROM webhook_events
         WHERE source = $1 AND event_id = $2
         FOR UPDATE`,
        [request.source, request.eventId],
      );
      const event = existing.rows[0];
      if (!event) {
        throw new NotFoundException(`No webhook event found for ${request.source}/${request.eventId}`);
      }
      if (event.status !== 'dead_letter') {
        throw new ConflictException(`Only dead-letter events can be replayed; current status is ${event.status}`);
      }

      const processingCycle = event.processing_cycle + 1;
      await client.query('DELETE FROM webhook_test_controls WHERE webhook_event_id = $1', [event.id]);
      const audit = await client.query<{ id: string }>(
        `INSERT INTO webhook_replays (
           webhook_event_id, processing_cycle, requested_by, reason, previous_status
         ) VALUES ($1, $2, $3, $4, 'dead_letter')
         RETURNING id`,
        [event.id, processingCycle, request.requestedBy, request.reason],
      );
      const replayId = audit.rows[0]?.id;
      if (!replayId) throw new Error(`Could not audit the replay for event ${event.id}`);

      const updated = await client.query(
        `UPDATE webhook_events
         SET status = 'pending',
             processing_cycle = $2,
             next_attempt_at = NULL,
             lease_owner = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             updated_at = clock_timestamp()
         WHERE id = $1 AND status = 'dead_letter'`,
        [event.id, processingCycle],
      );
      if (updated.rowCount !== 1) {
        throw new ConflictException('The event changed state before replay could be queued');
      }

      return {
        status: 'queued',
        source: event.source,
        eventId: event.event_id,
        processingCycle,
        replayId,
      };
    });
  }
}
