import { BadRequestException } from '@nestjs/common';

export interface ReplayRequest {
  source: string;
  eventId: string;
  requestedBy: string;
  reason: string;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Replay request must be an object');
  }
  return value as UnknownRecord;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    value.includes('\0')
  ) {
    throw new BadRequestException(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value.trim();
}

export function validateReplayRequest(value: unknown): ReplayRequest {
  const request = asRecord(value);
  return {
    source: requiredText(request.source, 'source', 100),
    eventId: requiredText(request.eventId, 'eventId', 255),
    requestedBy: requiredText(request.requestedBy, 'requestedBy', 100),
    reason: requiredText(request.reason, 'reason', 1000),
  };
}
