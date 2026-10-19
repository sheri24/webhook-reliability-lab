import { resolve } from 'node:path';
import { hostname } from 'node:os';
import dotenv from 'dotenv';
import { DEFAULT_RETRY_POLICY } from '../contracts/event-contract.js';

dotenv.config({ path: resolve(process.cwd(), '.env') });

const crashAfterClaimEventId = process.env.WEBHOOK_LAB_CRASH_AFTER_CLAIM_EVENT_ID?.trim() || undefined;
if (crashAfterClaimEventId && process.env.NODE_ENV !== 'development') {
  throw new Error('WEBHOOK_LAB_CRASH_AFTER_CLAIM_EVENT_ID is available only when NODE_ENV=development');
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export const runtimeConfig = {
  databaseUrl:
    process.env.WEBHOOK_LAB_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgres://webhook_lab:webhook_lab_dev@127.0.0.1:5432/webhook_lab',
  databaseConnectionTimeoutMs: positiveInteger('WEBHOOK_LAB_DATABASE_CONNECTION_TIMEOUT_MS', 3000),
  webhookHmacSecret: process.env.WEBHOOK_LAB_HMAC_SECRET ?? 'webhook-lab-local-secret-change-me',
  apiPort: positiveInteger('API_PORT', 3000),
  workerId: process.env.WEBHOOK_LAB_WORKER_ID?.trim() || `${hostname()}-${process.pid}`,
  workerPollIntervalMs: positiveInteger('WEBHOOK_LAB_WORKER_POLL_INTERVAL_MS', 500),
  workerLeaseDurationMs: positiveInteger('WEBHOOK_LAB_WORKER_LEASE_DURATION_MS', 30_000),
  crashAfterClaimEventId,
  demoControlsEnabled: process.env.NODE_ENV !== 'production',
  retryMaxAttempts: positiveInteger('RETRY_MAX_ATTEMPTS', DEFAULT_RETRY_POLICY.maxAttempts),
  retryBaseDelayMs: positiveInteger('RETRY_BASE_DELAY_MS', DEFAULT_RETRY_POLICY.baseDelayMs),
  retryMaxDelayMs: positiveInteger('RETRY_MAX_DELAY_MS', DEFAULT_RETRY_POLICY.maxDelayMs),
} as const;
