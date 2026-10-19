import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { runtimeConfig } from '../config/runtime-config.js';
import type { FulfillmentRequestedEvent } from '../contracts/event-contract.js';
import { DatabaseService } from '../database/database.service.js';
import { classifyFailure, formatFailure, retryDelayMs } from './retry-policy.js';

type EventStatus = 'pending' | 'retry_wait' | 'processing';
type ProcessingResult = 'fulfillment_created' | 'fulfillment_already_exists';

interface ClaimedEvent {
  rowId: string;
  source: string;
  providerEventId: string;
  leaseToken: string;
  cycleNumber: number;
  attemptNumber: number;
  injectTransientFailure: boolean;
  crashAfterClaim: boolean;
}

interface CompletedClaim {
  fulfillmentId: string;
  result: ProcessingResult;
}

interface FailureRecorded {
  status: 'retry_wait' | 'dead_letter';
  retryAt: Date | string | null;
}

function waitForPoll(intervalMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, intervalMs);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

@Injectable()
export class WebhookWorkerService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async run(signal: AbortSignal): Promise<void> {
    console.info(`[worker ${runtimeConfig.workerId}] started; polling every ${runtimeConfig.workerPollIntervalMs} ms`);

    while (!signal.aborted) {
      try {
        const claim = await this.claimNext();
        if (!claim) {
          await waitForPoll(runtimeConfig.workerPollIntervalMs, signal);
          continue;
        }

        console.info(
          `[worker ${runtimeConfig.workerId}] claimed ${claim.source}/${claim.providerEventId} cycle ${claim.cycleNumber} attempt ${claim.attemptNumber}`,
        );

        if (runtimeConfig.crashAfterClaimEventId === claim.providerEventId || claim.crashAfterClaim) {
          console.error(
            `[worker ${runtimeConfig.workerId}] development failpoint: exiting after claim for ${claim.source}/${claim.providerEventId}`,
          );
          process.exit(86);
        }

        let completed: CompletedClaim | null;
        try {
          if (claim.injectTransientFailure) {
            throw Object.assign(new Error('Dashboard control injected a transient worker failure'), { code: '40001' });
          }
          completed = await this.completeClaim(claim);
        } catch (error: unknown) {
          const failure = await this.recordFailure(claim, error);
          if (failure) {
            const retryDetails = failure.retryAt ? `; retry scheduled for ${failure.retryAt}` : '';
            console.warn(
              `[worker ${runtimeConfig.workerId}] ${claim.source}/${claim.providerEventId} attempt ${claim.attemptNumber} failed as ${classifyFailure(error)}; ${failure.status}${retryDetails}`,
            );
          } else {
            console.warn(
              `[worker ${runtimeConfig.workerId}] lease was no longer current after failure for ${claim.source}/${claim.providerEventId}`,
            );
          }
          continue;
        }

        if (!completed) {
          console.warn(
            `[worker ${runtimeConfig.workerId}] lease expired before completion for ${claim.source}/${claim.providerEventId}`,
          );
          continue;
        }

        console.info(
          `[worker ${runtimeConfig.workerId}] succeeded ${claim.source}/${claim.providerEventId}: ${completed.result}, fulfillment ${completed.fulfillmentId}`,
        );
      } catch (error: unknown) {
        console.error(
          `[worker ${runtimeConfig.workerId}] poll or recovery failed:`,
          error instanceof Error ? error.message : error,
        );
        await waitForPoll(runtimeConfig.workerPollIntervalMs, signal);
      }
    }

    console.info(`[worker ${runtimeConfig.workerId}] stopped`);
  }

  private async claimNext(): Promise<ClaimedEvent | null> {
    const leaseToken = randomUUID();

    return this.database.withTransaction(async (client) => {
      const candidateResult = await client.query<{
        id: string;
        source: string;
        event_id: string;
        status: EventStatus;
        lease_token: string | null;
        processing_cycle: number;
      }>(
        `SELECT id, source, event_id, status, lease_token, processing_cycle
         FROM webhook_events
         WHERE status = 'pending'
            OR (status = 'retry_wait' AND next_attempt_at <= clock_timestamp())
            OR (status = 'processing' AND lease_expires_at <= clock_timestamp())
         ORDER BY COALESCE(next_attempt_at, lease_expires_at, received_at), received_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
      );
      const candidate = candidateResult.rows[0];
      if (!candidate) return null;

      if (candidate.status === 'processing') {
        if (!candidate.lease_token) {
          throw new Error(`Expired processing event ${candidate.id} has no lease token`);
        }

        const expiredAttempt = await client.query<{ attempt_number: number }>(
          `UPDATE webhook_processing_attempts
           SET status = 'failed',
               failure_class = 'transient',
               error_message = 'Worker lease expired before the attempt completed',
               finished_at = clock_timestamp()
           WHERE webhook_event_id = $1
             AND lease_token = $2
             AND status = 'processing'
           RETURNING attempt_number`,
          [candidate.id, candidate.lease_token],
        );
        const expiredAttemptNumber = expiredAttempt.rows[0]?.attempt_number;
        if (expiredAttemptNumber === undefined) {
          throw new Error(`Could not close the expired processing attempt for event ${candidate.id}`);
        }

        if (expiredAttemptNumber >= runtimeConfig.retryMaxAttempts) {
          const deadLettered = await client.query(
            `UPDATE webhook_events
             SET status = 'dead_letter',
                 lease_owner = NULL,
                 lease_token = NULL,
                 lease_expires_at = NULL,
                 next_attempt_at = NULL,
                 last_error_class = 'transient',
                 last_error = 'Worker lease expired after the maximum attempt count',
                 updated_at = clock_timestamp()
             WHERE id = $1 AND status = 'processing' AND lease_token = $2`,
            [candidate.id, candidate.lease_token],
          );
          if (deadLettered.rowCount !== 1) {
            throw new Error(`Could not dead-letter exhausted event ${candidate.id} after lease expiry`);
          }
          await client.query('DELETE FROM webhook_test_controls WHERE webhook_event_id = $1', [candidate.id]);
          return null;
        }
      }

      const claimed = await client.query<{ lease_token: string }>(
        `UPDATE webhook_events
         SET status = 'processing',
             next_attempt_at = NULL,
             lease_owner = $2,
             lease_token = $3,
             lease_expires_at = clock_timestamp() + ($4::integer * interval '1 millisecond'),
             updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING lease_token`,
        [candidate.id, runtimeConfig.workerId, leaseToken, runtimeConfig.workerLeaseDurationMs],
      );
      if (claimed.rowCount !== 1) {
        throw new Error(`Could not claim event ${candidate.id}`);
      }

      const attempt = await client.query<{ attempt_number: number }>(
        `INSERT INTO webhook_processing_attempts (
           webhook_event_id, cycle_number, attempt_number, worker_id, lease_token
         )
         SELECT $1, $2, COALESCE(MAX(attempt_number), 0) + 1, $3, $4
         FROM webhook_processing_attempts
         WHERE webhook_event_id = $1 AND cycle_number = $2
         RETURNING attempt_number`,
        [candidate.id, candidate.processing_cycle, runtimeConfig.workerId, leaseToken],
      );
      const attemptNumber = attempt.rows[0]?.attempt_number;
      if (attemptNumber === undefined) {
        throw new Error(`Could not record a processing attempt for event ${candidate.id}`);
      }

      let injectTransientFailure = false;
      let crashAfterClaim = runtimeConfig.crashAfterClaimEventId === candidate.event_id;
      const controlResult = runtimeConfig.demoControlsEnabled
        ? await client.query<{
            transient_failures_remaining: number;
            crash_after_claim: boolean;
          }>(
            `SELECT transient_failures_remaining, crash_after_claim
             FROM webhook_test_controls
             WHERE webhook_event_id = $1
             FOR UPDATE`,
            [candidate.id],
          )
        : null;
      const testControl = controlResult?.rows[0];
      if (testControl) {
        crashAfterClaim ||= testControl.crash_after_claim;
        injectTransientFailure = !crashAfterClaim && testControl.transient_failures_remaining > 0;
        const remainingFailures = testControl.transient_failures_remaining - (injectTransientFailure ? 1 : 0);

        if (remainingFailures === 0) {
          await client.query('DELETE FROM webhook_test_controls WHERE webhook_event_id = $1', [candidate.id]);
        } else {
          await client.query(
            `UPDATE webhook_test_controls
             SET transient_failures_remaining = $2,
                 crash_after_claim = false
             WHERE webhook_event_id = $1`,
            [candidate.id, remainingFailures],
          );
        }
      }

      return {
        rowId: candidate.id,
        source: candidate.source,
        providerEventId: candidate.event_id,
        leaseToken: claimed.rows[0].lease_token,
        cycleNumber: candidate.processing_cycle,
        attemptNumber,
        injectTransientFailure,
        crashAfterClaim,
      };
    });
  }

  private async completeClaim(claim: ClaimedEvent): Promise<CompletedClaim | null> {
    return this.database.withTransaction(async (client) => {
      const current = await client.query<{ payload: FulfillmentRequestedEvent }>(
        `SELECT payload
         FROM webhook_events
         WHERE id = $1
           AND status = 'processing'
           AND lease_token = $2
           AND lease_expires_at > clock_timestamp()
         FOR UPDATE`,
        [claim.rowId, claim.leaseToken],
      );
      const event = current.rows[0];
      if (!event) return null;

      const orderId = event.payload.data.orderId;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO fulfillments (order_id, action, webhook_event_id)
         VALUES ($1, 'fulfill_order', $2)
         ON CONFLICT (order_id, action) DO NOTHING
         RETURNING id`,
        [orderId, claim.rowId],
      );

      const effectCreated = inserted.rows.length > 0;
      let fulfillmentId = inserted.rows[0]?.id;
      if (!fulfillmentId) {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM fulfillments WHERE order_id = $1 AND action = 'fulfill_order'`,
          [orderId],
        );
        fulfillmentId = existing.rows[0]?.id;
      }
      if (!fulfillmentId) {
        throw new Error(`Could not find the fulfillment effect for order ${orderId}`);
      }

      const eventUpdate = await client.query(
        `UPDATE webhook_events
         SET status = 'succeeded',
             lease_owner = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             next_attempt_at = NULL,
             updated_at = clock_timestamp()
         WHERE id = $1 AND status = 'processing' AND lease_token = $2`,
        [claim.rowId, claim.leaseToken],
      );
      if (eventUpdate.rowCount !== 1) {
        throw new Error(`Could not mark event ${claim.rowId} as succeeded while holding its lease`);
      }

      const result: ProcessingResult = effectCreated ? 'fulfillment_created' : 'fulfillment_already_exists';
      const attemptUpdate = await client.query(
        `UPDATE webhook_processing_attempts
         SET status = 'succeeded',
             result = $3,
             fulfillment_id = $4,
             finished_at = clock_timestamp()
         WHERE webhook_event_id = $1
           AND lease_token = $2
           AND status = 'processing'`,
        [claim.rowId, claim.leaseToken, result, fulfillmentId],
      );
      if (attemptUpdate.rowCount !== 1) {
        throw new Error(`Could not complete the processing attempt for event ${claim.rowId}`);
      }

      return { fulfillmentId, result };
    });
  }

  private async recordFailure(claim: ClaimedEvent, error: unknown): Promise<FailureRecorded | null> {
    const failureClass = classifyFailure(error);
    const message = formatFailure(error);
    const terminal = failureClass === 'permanent' || claim.attemptNumber >= runtimeConfig.retryMaxAttempts;
    const nextStatus = terminal ? 'dead_letter' : 'retry_wait';
    const delayMs = terminal
      ? null
      : retryDelayMs(claim.attemptNumber, runtimeConfig.retryBaseDelayMs, runtimeConfig.retryMaxDelayMs);

    return this.database.withTransaction(async (client) => {
      const eventUpdate = await client.query<{ next_attempt_at: Date | string | null }>(
        `UPDATE webhook_events
         SET status = $3,
             next_attempt_at = CASE
               WHEN $3 = 'retry_wait' THEN clock_timestamp() + ($4::integer * interval '1 millisecond')
               ELSE NULL
             END,
             last_error_class = $5,
             last_error = $6,
             lease_owner = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             updated_at = clock_timestamp()
         WHERE id = $1 AND status = 'processing' AND lease_token = $2
         RETURNING next_attempt_at`,
        [claim.rowId, claim.leaseToken, nextStatus, delayMs ?? 0, failureClass, message],
      );
      if (eventUpdate.rowCount !== 1) return null;

      const attemptUpdate = await client.query(
        `UPDATE webhook_processing_attempts
         SET status = 'failed',
             failure_class = $3,
             error_message = $4,
             retry_at = $5,
             finished_at = clock_timestamp()
         WHERE webhook_event_id = $1
           AND lease_token = $2
           AND status = 'processing'`,
        [claim.rowId, claim.leaseToken, failureClass, message, eventUpdate.rows[0].next_attempt_at],
      );
      if (attemptUpdate.rowCount !== 1) {
        throw new Error(`Could not record the failed processing attempt for event ${claim.rowId}`);
      }
      if (terminal) {
        await client.query('DELETE FROM webhook_test_controls WHERE webhook_event_id = $1', [claim.rowId]);
      }

      return { status: nextStatus, retryAt: eventUpdate.rows[0].next_attempt_at };
    });
  }
}
