ALTER TABLE webhook_events
  ADD COLUMN processing_cycle integer NOT NULL DEFAULT 1 CHECK (processing_cycle > 0),
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN last_error_class text CHECK (last_error_class IN ('transient', 'permanent')),
  ADD COLUMN last_error text,
  ADD CONSTRAINT webhook_events_retry_schedule_check CHECK (
    (status = 'retry_wait' AND next_attempt_at IS NOT NULL)
    OR
    (status <> 'retry_wait' AND next_attempt_at IS NULL)
  );

CREATE INDEX webhook_events_retry_due_idx
  ON webhook_events (next_attempt_at, received_at, id)
  WHERE status = 'retry_wait';

CREATE INDEX webhook_events_expired_lease_idx
  ON webhook_events (lease_expires_at, received_at, id)
  WHERE status = 'processing';

ALTER TABLE webhook_processing_attempts
  DROP CONSTRAINT webhook_processing_attempts_status_check,
  DROP CONSTRAINT webhook_processing_attempts_event_number_key,
  DROP CONSTRAINT webhook_processing_attempts_completion_check;

DROP INDEX webhook_processing_attempts_event_idx;

ALTER TABLE webhook_processing_attempts
  ADD COLUMN cycle_number integer NOT NULL DEFAULT 1 CHECK (cycle_number > 0),
  ADD COLUMN failure_class text CHECK (failure_class IN ('transient', 'permanent')),
  ADD COLUMN error_message text,
  ADD COLUMN retry_at timestamptz,
  ADD CONSTRAINT webhook_processing_attempts_status_check CHECK (status IN ('processing', 'succeeded', 'failed')),
  ADD CONSTRAINT webhook_processing_attempts_event_cycle_number_key UNIQUE (webhook_event_id, cycle_number, attempt_number),
  ADD CONSTRAINT webhook_processing_attempts_completion_check CHECK (
    (status = 'processing' AND result IS NULL AND fulfillment_id IS NULL AND failure_class IS NULL AND error_message IS NULL AND retry_at IS NULL AND finished_at IS NULL)
    OR
    (status = 'succeeded' AND result IS NOT NULL AND fulfillment_id IS NOT NULL AND failure_class IS NULL AND error_message IS NULL AND retry_at IS NULL AND finished_at IS NOT NULL)
    OR
    (status = 'failed' AND result IS NULL AND fulfillment_id IS NULL AND failure_class IS NOT NULL AND error_message IS NOT NULL AND finished_at IS NOT NULL)
  );

CREATE INDEX webhook_processing_attempts_event_idx
  ON webhook_processing_attempts (webhook_event_id, cycle_number, attempt_number);

CREATE TABLE webhook_replays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_event_id uuid NOT NULL REFERENCES webhook_events(id) ON DELETE RESTRICT,
  processing_cycle integer NOT NULL CHECK (processing_cycle > 1),
  requested_by text NOT NULL CHECK (length(trim(requested_by)) > 0),
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  previous_status text NOT NULL CHECK (previous_status = 'dead_letter'),
  requested_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_replays_event_cycle_key UNIQUE (webhook_event_id, processing_cycle)
);

CREATE INDEX webhook_replays_event_requested_idx
  ON webhook_replays (webhook_event_id, requested_at, id);
