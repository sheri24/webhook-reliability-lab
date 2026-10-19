export const EVENT_STATUSES = [
  'pending',
  'processing',
  'retry_wait',
  'succeeded',
  'dead_letter',
] as const;

export type EventStatus = (typeof EVENT_STATUSES)[number];

export interface EventEnvelope<TData = unknown> {
  source: string;
  eventId: string;
  eventType: string;
  occurredAt: string;
  data: TData;
}

export interface FulfillmentRequestedData {
  orderId: string;
}

export type FulfillmentRequestedEvent = EventEnvelope<FulfillmentRequestedData> & {
  eventType: 'order.fulfillment_requested';
};

export const EVENT_STATUS_TRANSITIONS: Readonly<Record<EventStatus, readonly EventStatus[]>> = {
  pending: ['processing'],
  processing: ['succeeded', 'retry_wait', 'dead_letter'],
  retry_wait: ['processing'],
  succeeded: [],
  dead_letter: ['pending'],
};

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
};
