CREATE TABLE webhook_test_controls (
  webhook_event_id uuid PRIMARY KEY REFERENCES webhook_events(id) ON DELETE CASCADE,
  transient_failures_remaining integer NOT NULL DEFAULT 0 CHECK (transient_failures_remaining BETWEEN 0 AND 5),
  crash_after_claim boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_test_controls_nonempty_check CHECK (
    transient_failures_remaining > 0 OR crash_after_claim
  )
);
