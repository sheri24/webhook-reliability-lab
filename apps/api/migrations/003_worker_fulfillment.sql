ALTER TABLE webhook_events
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_token uuid UNIQUE,
  ADD COLUMN lease_expires_at timestamptz,
  ADD CONSTRAINT webhook_events_lease_state_check CHECK (
    (status = 'processing' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status <> 'processing' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
  );

CREATE INDEX webhook_events_pending_claim_idx
  ON webhook_events (received_at, id)
  WHERE status = 'pending';

CREATE TABLE fulfillments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id text NOT NULL,
  action text NOT NULL CHECK (action = 'fulfill_order'),
  webhook_event_id uuid NOT NULL REFERENCES webhook_events(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fulfillments_order_action_key UNIQUE (order_id, action)
);

CREATE TABLE webhook_processing_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_event_id uuid NOT NULL REFERENCES webhook_events(id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  worker_id text NOT NULL,
  lease_token uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'succeeded')),
  result text CHECK (result IN ('fulfillment_created', 'fulfillment_already_exists')),
  fulfillment_id uuid REFERENCES fulfillments(id) ON DELETE RESTRICT,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT webhook_processing_attempts_event_number_key UNIQUE (webhook_event_id, attempt_number),
  CONSTRAINT webhook_processing_attempts_completion_check CHECK (
    (status = 'processing' AND result IS NULL AND fulfillment_id IS NULL AND finished_at IS NULL)
    OR
    (status = 'succeeded' AND result IS NOT NULL AND fulfillment_id IS NOT NULL AND finished_at IS NOT NULL)
  )
);

CREATE INDEX webhook_processing_attempts_event_idx
  ON webhook_processing_attempts (webhook_event_id, attempt_number);
