export type FailureClass = 'transient' | 'permanent';

const TRANSIENT_SQLSTATE_PREFIXES = ['08', '40', '53', '55', '57', '58'];
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

export function classifyFailure(error: unknown): FailureClass {
  let current: unknown = error;
  const visited = new Set<object>();
  while (typeof current === 'object' && current !== null) {
    if (visited.has(current)) break;
    visited.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (TRANSIENT_NETWORK_CODES.has(code)) return 'transient';
      if (TRANSIENT_SQLSTATE_PREFIXES.some((prefix) => code.startsWith(prefix))) return 'transient';
      if (code.startsWith('22') || code.startsWith('23') || code.startsWith('42')) return 'permanent';
    }
    current = (current as { cause?: unknown }).cause;
  }
  return 'permanent';
}

export function formatFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const compact = message.replace(/\s+/g, ' ').trim();
  return (compact || 'Unknown processing failure').slice(0, 2000);
}

export function retryDelayMs(attemptNumber: number, baseDelayMs: number, maxDelayMs: number): number {
  let cap = Math.min(baseDelayMs, maxDelayMs);
  for (let attempt = 1; attempt < attemptNumber && cap < maxDelayMs; attempt += 1) {
    cap = Math.min(maxDelayMs, cap * 2);
  }
  return Math.floor(Math.random() * (cap + 1));
}
