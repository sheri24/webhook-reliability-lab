import { BadRequestException } from '@nestjs/common';
import type { FulfillmentRequestedEvent } from '../contracts/event-contract.js';
import { validateFulfillmentEvent } from './validate-event.js';

export interface DemoRequest {
  event: FulfillmentRequestedEvent;
  transientFailures: number;
  crashAfterClaim: boolean;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

export function validateDemoRequest(value: unknown): DemoRequest {
  const request = asRecord(value, 'Demo request');
  const transientFailures = request.transientFailures ?? 0;
  const crashAfterClaim = request.crashAfterClaim ?? false;

  if (!Number.isInteger(transientFailures) || (transientFailures as number) < 0 || (transientFailures as number) > 5) {
    throw new BadRequestException('transientFailures must be an integer from 0 to 5');
  }
  if (typeof crashAfterClaim !== 'boolean') {
    throw new BadRequestException('crashAfterClaim must be a boolean');
  }

  return {
    event: validateFulfillmentEvent(request.event),
    transientFailures: transientFailures as number,
    crashAfterClaim,
  };
}
