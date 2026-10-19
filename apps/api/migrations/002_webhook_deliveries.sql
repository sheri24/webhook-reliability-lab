CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_event_id uuid NOT NULL REFERENCES webhook_events(id) ON DELETE RESTRICT,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  is_duplicate boolean NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX webhook_deliveries_event_received_idx
  ON webhook_deliveries (webhook_event_id, received_at DESC);
