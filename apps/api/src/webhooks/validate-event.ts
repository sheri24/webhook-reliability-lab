import { BadRequestException } from '@nestjs/common';
import type { FulfillmentRequestedEvent } from '../contracts/event-contract.js';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes('\0') ||
    value.trim() !== value
  ) {
    throw new BadRequestException(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

export function validateFulfillmentEvent(value: unknown): FulfillmentRequestedEvent {
  const envelope = asRecord(value, 'Event envelope');
  const source = requiredText(envelope.source, 'source', 100);
  const eventId = requiredText(envelope.eventId, 'eventId', 255);
  const eventType = requiredText(envelope.eventType, 'eventType', 100);
  if (eventType !== 'order.fulfillment_requested') {
    throw new BadRequestException('eventType must be order.fulfillment_requested');
  }

  const occurredAt = requiredText(envelope.occurredAt, 'occurredAt', 40);
  const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!isoTimestamp.test(occurredAt) || Number.isNaN(Date.parse(occurredAt))) {
    throw new BadRequestException('occurredAt must be an ISO 8601 timestamp with a timezone');
  }

  const data = asRecord(envelope.data, 'data');
  requiredText(data.orderId, 'data.orderId', 255);

  return value as FulfillmentRequestedEvent;
}
