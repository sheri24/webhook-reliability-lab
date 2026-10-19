import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import dotenv from 'dotenv';
import { Pool } from 'pg';

const root = process.cwd();
const envPath = resolve(root, '.env');
if (!existsSync(envPath)) {
  throw new Error('Missing .env. Copy .env.example to .env, start PostgreSQL, and apply migrations first.');
}
dotenv.config({ path: envPath });

const tsxCli = resolve(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
if (!existsSync(tsxCli)) throw new Error('tsx is missing. Run npm install from the project root first.');

const databaseUrl = process.env.WEBHOOK_LAB_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgres://webhook_lab:webhook_lab_dev@127.0.0.1:5432/webhook_lab';
const hmacSecret = process.env.WEBHOOK_LAB_HMAC_SECRET ?? 'webhook-lab-local-secret-change-me';
const runToken = randomUUID().replaceAll('-', '').slice(0, 12);
const testSource = `m6-verification-${runToken}`;
const triggerName = 'm6_e2e_claim_delay';
const functionName = 'm6_e2e_claim_delay_fn';
const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3000, max: 8 });
const children = new Set();
const allWorkers = [];
let schemaReady = false;
let apiBase;
let outageApiBase;
let sequence = 0;

function log(message) {
  console.log(`[verify:e2e] ${message}`);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

function startNodeService(label, entryPoint, extraEnvironment = {}) {
  const childEnvironment = { ...process.env };
  delete childEnvironment.WEBHOOK_LAB_CRASH_AFTER_CLAIM_EVENT_ID;
  Object.assign(childEnvironment, {
    NODE_ENV: 'development',
    ...extraEnvironment,
  });

  const child = spawn(
    process.execPath,
    [tsxCli, '--tsconfig', 'apps/api/tsconfig.json', entryPoint],
    { cwd: root, env: childEnvironment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.label = label;
  child.output = '';
  const append = (chunk) => {
    child.output = `${child.output}${chunk.toString()}`.slice(-20_000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.exitResult = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
    child.once('error', (error) => resolveExit({ error }));
  });
  children.add(child);
  return child;
}

function workerEnvironment(workerId, extra = {}) {
  return {
    WEBHOOK_LAB_WORKER_ID: workerId,
    WEBHOOK_LAB_WORKER_POLL_INTERVAL_MS: '25',
    WEBHOOK_LAB_WORKER_LEASE_DURATION_MS: '900',
    RETRY_MAX_ATTEMPTS: '5',
    RETRY_BASE_DELAY_MS: '50',
    RETRY_MAX_DELAY_MS: '100',
    ...extra,
  };
}

function startWorker(workerId, extra = {}) {
  const worker = startNodeService(
    workerId,
    'apps/api/src/worker.ts',
    workerEnvironment(workerId, extra),
  );
  allWorkers.push(worker);
  return worker;
}

async function stopChild(child) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    children.delete(child);
    return;
  }
  child.kill('SIGTERM');
  const stopped = await Promise.race([
    child.exitResult.then(() => true),
    delay(3000).then(() => false),
  ]);
  if (!stopped) {
    child.kill();
    await child.exitResult;
  }
  children.delete(child);
}

async function waitForResponse(url, predicate, label, timeoutMs = 12_000) {
  const stopAt = Date.now() + timeoutMs;
  let lastStatus = 'no response';
  while (Date.now() < stopAt) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      lastStatus = response.status;
      if (predicate(response)) return response;
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`${label} timed out; latest response: ${lastStatus}`);
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

function makeEvent(orderId) {
  sequence += 1;
  const event = {
    source: testSource,
    eventId: `evt_m6_${runToken}_${sequence}`,
    eventType: 'order.fulfillment_requested',
    occurredAt: new Date().toISOString(),
    data: { orderId: orderId ?? `ord_m6_${runToken}_${sequence}` },
  };
  return event;
}

function signature(rawBody) {
  const digest = createHmac('sha256', hmacSecret).update(rawBody).digest('hex');
  return `sha256=${digest}`;
}

async function postSignedEvent(event) {
  const rawBody = JSON.stringify(event);
  return requestJson(`${apiBase}/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-signature': signature(rawBody) },
    body: rawBody,
  });
}

async function postDemoEvent(event, controls) {
  const { response, payload } = await requestJson(`${apiBase}/webhooks/demo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event, ...controls }),
  });
  assert.equal(response.status, 202, `Demo intake failed: ${JSON.stringify(payload)}`);
  return payload;
}

async function getTimeline(event) {
  const query = new URLSearchParams({ source: event.source, eventId: event.eventId });
  const { response, payload } = await requestJson(`${apiBase}/webhooks/timeline?${query}`);
  assert.equal(response.status, 200, `Timeline lookup failed for ${event.eventId}: ${JSON.stringify(payload)}`);
  return payload;
}

async function waitForTimeline(event, predicate, label, timeoutMs = 20_000) {
  const stopAt = Date.now() + timeoutMs;
  let latest;
  let workerLogs = '';
  while (Date.now() < stopAt) {
    latest = await getTimeline(event);
    if (predicate(latest)) return latest;
    workerLogs = allWorkers.map((worker) => worker.output).join('\n');
    await delay(100);
  }
  throw new Error(`${label} timed out. Latest timeline: ${JSON.stringify(latest)}\nWorker output:\n${workerLogs}`);
}

async function eventExists(event) {
  const result = await pool.query(
    'SELECT EXISTS (SELECT 1 FROM webhook_events WHERE source = $1 AND event_id = $2) AS present',
    [event.source, event.eventId],
  );
  return result.rows[0].present;
}

async function installClaimDelayTrigger() {
  await removeClaimDelayTrigger();
  const safeSource = testSource.replaceAll("'", "''");
  await pool.query(`
    CREATE FUNCTION ${functionName}() RETURNS trigger
    LANGUAGE plpgsql AS $m6$
    BEGIN
      IF NEW.source = '${safeSource}' AND NEW.status = 'processing' AND OLD.status <> 'processing' THEN
        PERFORM pg_sleep(0.15);
      END IF;
      RETURN NEW;
    END;
    $m6$
  `);
  await pool.query(`
    CREATE TRIGGER ${triggerName}
    BEFORE UPDATE OF status ON webhook_events
    FOR EACH ROW EXECUTE FUNCTION ${functionName}()
  `);
}

async function removeClaimDelayTrigger() {
  await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON webhook_events`);
  await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
}

async function cleanupTestRows() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM webhook_test_controls WHERE webhook_event_id IN (SELECT id FROM webhook_events WHERE source = $1)', [testSource]);
    await client.query('DELETE FROM webhook_replays WHERE webhook_event_id IN (SELECT id FROM webhook_events WHERE source = $1)', [testSource]);
    await client.query('DELETE FROM webhook_processing_attempts WHERE webhook_event_id IN (SELECT id FROM webhook_events WHERE source = $1)', [testSource]);
    await client.query('DELETE FROM webhook_deliveries WHERE webhook_event_id IN (SELECT id FROM webhook_events WHERE source = $1)', [testSource]);
    await client.query('DELETE FROM fulfillments WHERE webhook_event_id IN (SELECT id FROM webhook_events WHERE source = $1)', [testSource]);
    await client.query('DELETE FROM webhook_events WHERE source = $1', [testSource]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function verifyMigrations() {
  const result = await pool.query(
    `SELECT to_regclass('public.webhook_events') AS events,
            to_regclass('public.webhook_deliveries') AS deliveries,
            to_regclass('public.fulfillments') AS fulfillments,
            to_regclass('public.webhook_processing_attempts') AS attempts,
            to_regclass('public.webhook_replays') AS replays,
            to_regclass('public.webhook_test_controls') AS controls`,
  );
  const missingTables = Object.entries(result.rows[0])
    .filter(([, table]) => !table)
    .map(([table]) => table);
  assert.equal(
    missingTables.length,
    0,
    `Required project tables are missing (${missingTables.join(', ')}); run npm run db:migrate`,
  );
  schemaReady = true;
}

async function runVerification() {
  log(`Run-specific event source: ${testSource}`);
  await verifyMigrations();
  const apiPort = await availablePort();
  apiBase = `http://127.0.0.1:${apiPort}`;
  const api = startNodeService('m6-api', 'apps/api/src/main.ts', { API_PORT: String(apiPort) });
  const health = await waitForResponse(`${apiBase}/health`, (response) => response.status === 200, 'Main API health');
  assert.deepEqual(await health.json(), { status: 'ok', database: 'ok' });
  log('PASS API starts and reports PostgreSQL healthy');

  const invalidSignatureEvent = makeEvent();
  const invalidRawBody = JSON.stringify(invalidSignatureEvent);
  const invalid = await requestJson(`${apiBase}/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-signature': `sha256=${'0'.repeat(64)}` },
    body: invalidRawBody,
  });
  assert.equal(invalid.response.status, 401, 'Invalid signatures must be rejected with HTTP 401');
  assert.equal(await eventExists(invalidSignatureEvent), false, 'Invalid signature wrote an inbox event');
  log('PASS invalid signature returned 401 and wrote no event');

  const outageApiPort = await availablePort();
  outageApiBase = `http://127.0.0.1:${outageApiPort}`;
  const unavailablePort = await availablePort();
  const unavailableDatabaseUrl = new URL(databaseUrl);
  unavailableDatabaseUrl.port = String(unavailablePort);
  const outageApi = startNodeService('m6-api-database-outage', 'apps/api/src/main.ts', {
    API_PORT: String(outageApiPort),
    WEBHOOK_LAB_DATABASE_URL: unavailableDatabaseUrl.toString(),
    WEBHOOK_LAB_DATABASE_CONNECTION_TIMEOUT_MS: '300',
  });
  const outageHealth = await waitForResponse(`${outageApiBase}/health`, (response) => response.status === 503, 'Unavailable-database API health');
  assert.equal(outageHealth.status, 503);
  const outageEvent = makeEvent();
  const outageRawBody = JSON.stringify(outageEvent);
  const outageResult = await requestJson(`${outageApiBase}/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-signature': signature(outageRawBody) },
    body: outageRawBody,
  });
  assert.notEqual(outageResult.response.status, 202, 'API acknowledged an event while PostgreSQL was unreachable');
  assert.equal(await eventExists(outageEvent), false, 'Unreachable-database API unexpectedly wrote the event');
  log(`PASS database outage returned health ${outageHealth.status} and intake ${outageResult.response.status}, never 202`);
  await stopChild(outageApi);

  const concurrentEvent = makeEvent();
  const duplicateRequests = await Promise.all(
    Array.from({ length: 20 }, () => postSignedEvent(concurrentEvent)),
  );
  for (const result of duplicateRequests) assert.equal(result.response.status, 202);
  const duplicateFlags = duplicateRequests.map(({ payload }) => payload.duplicate);
  assert.equal(duplicateFlags.filter((duplicate) => duplicate === false).length, 1);
  assert.equal(duplicateFlags.filter((duplicate) => duplicate === true).length, 19);
  const duplicateCounts = await pool.query(
    `SELECT count(DISTINCT event.id)::integer AS events,
            count(delivery.id)::integer AS deliveries,
            count(*) FILTER (WHERE delivery.is_duplicate)::integer AS duplicate_deliveries
     FROM webhook_events AS event
     JOIN webhook_deliveries AS delivery ON delivery.webhook_event_id = event.id
     WHERE event.source = $1 AND event.event_id = $2`,
    [concurrentEvent.source, concurrentEvent.eventId],
  );
  assert.deepEqual(duplicateCounts.rows[0], { events: 1, deliveries: 20, duplicate_deliveries: 19 });
  log('PASS 20 concurrent deliveries produced one inbox event and 19 recorded duplicates');

  const workerEvents = Array.from({ length: 12 }, (_, index) => makeEvent(`ord_m6_${runToken}_parallel_${index + 1}`));
  for (const event of workerEvents) {
    const { response } = await postSignedEvent(event);
    assert.equal(response.status, 202);
  }
  await installClaimDelayTrigger();
  const firstWorker = startWorker(`m6-${runToken}-worker-a`);
  const secondWorker = startWorker(`m6-${runToken}-worker-b`);
  const parallelTimelines = await Promise.all(
    [concurrentEvent, ...workerEvents].map((event) => waitForTimeline(
      event,
      (timeline) => timeline.event.status === 'succeeded',
      `Multiple workers to process ${event.eventId}`,
    )),
  );
  const workerIds = new Set(parallelTimelines.slice(1).flatMap((timeline) => timeline.attempts.map((attempt) => attempt.workerId)));
  assert(workerIds.has(firstWorker.label), 'First worker processed no test events');
  assert(workerIds.has(secondWorker.label), 'Second worker processed no test events');
  for (const timeline of parallelTimelines) {
    assert.equal(timeline.attempts.length, 1, `${timeline.event.eventId} should have one processing attempt`);
    assert.equal(timeline.attempts[0].status, 'succeeded');
  }
  log(`PASS two workers processed the 12-event batch; both worker IDs appear in its attempt history`);
  await removeClaimDelayTrigger();

  const transientEvent = makeEvent();
  const transientControl = await postDemoEvent(transientEvent, { transientFailures: 2, crashAfterClaim: false });
  assert.equal(transientControl.controlsConfigured, true);
  const transientTimeline = await waitForTimeline(
    transientEvent,
    (timeline) => timeline.event.status === 'succeeded',
    'Transient failure recovery',
  );
  assert.equal(transientTimeline.attempts.length, 3);
  assert.deepEqual(transientTimeline.attempts.slice(0, 2).map((attempt) => attempt.failureClass), ['transient', 'transient']);
  assert(transientTimeline.attempts.slice(0, 2).every((attempt) => attempt.retryAt));
  assert.equal(transientTimeline.attempts[2].status, 'succeeded');
  log('PASS two transient failures recorded retry times and recovered on attempt 3');

  await stopChild(firstWorker);
  await stopChild(secondWorker);
  const crashEvent = makeEvent();
  const crashControl = await postDemoEvent(crashEvent, { transientFailures: 0, crashAfterClaim: true });
  assert.equal(crashControl.controlsConfigured, true);
  const crashingWorker = startWorker(`m6-${runToken}-crasher`, {
    WEBHOOK_LAB_CRASH_AFTER_CLAIM_EVENT_ID: crashEvent.eventId,
  });
  const crashExit = await Promise.race([
    crashingWorker.exitResult,
    delay(12_000).then(() => null),
  ]);
  if (!crashExit) throw new Error(`Crash failpoint did not terminate its worker. Output:\n${crashingWorker.output}`);
  assert.equal(crashExit.code, 86, `Expected crash failpoint exit code 86; got ${JSON.stringify(crashExit)}`);
  children.delete(crashingWorker);
  const leasedTimeline = await waitForTimeline(
    crashEvent,
    (timeline) => timeline.event.status === 'processing' && timeline.attempts.length === 1,
    'Crash to leave one claimed attempt',
  );
  assert(leasedTimeline.event.leaseExpiresAt, 'Crash left no visible lease expiry');
  log('PASS worker exited with code 86 after claim, leaving a processing attempt and expiring lease');

  const leaseExpiry = Date.parse(leasedTimeline.event.leaseExpiresAt);
  await delay(Math.max(0, leaseExpiry - Date.now()) + 75);
  const recoveryWorker = startWorker(`m6-${runToken}-recovery`);
  const recoveredTimeline = await waitForTimeline(
    crashEvent,
    (timeline) => timeline.event.status === 'succeeded' && timeline.attempts.length === 2,
    'Expired lease recovery',
  );
  assert.equal(recoveredTimeline.attempts[0].status, 'failed');
  assert.match(recoveredTimeline.attempts[0].errorMessage, /lease expired/i);
  assert.equal(recoveredTimeline.attempts[1].workerId, recoveryWorker.label);
  assert.equal(recoveredTimeline.attempts[1].status, 'succeeded');
  log('PASS restarted worker reclaimed the expired lease and completed attempt 2');

  const alreadyFulfilledOrder = workerEvents[0].data.orderId;
  const exhaustionEvent = makeEvent(alreadyFulfilledOrder);
  const exhaustionControl = await postDemoEvent(exhaustionEvent, { transientFailures: 5, crashAfterClaim: false });
  assert.equal(exhaustionControl.controlsConfigured, true);
  const deadLetterTimeline = await waitForTimeline(
    exhaustionEvent,
    (timeline) => timeline.event.status === 'dead_letter',
    'Retry exhaustion to enter dead letter',
  );
  assert.equal(deadLetterTimeline.attempts.length, 5);
  assert(deadLetterTimeline.attempts.every((attempt) => attempt.status === 'failed'));
  assert.equal(deadLetterTimeline.event.lastErrorClass, 'transient');
  log('PASS five transient failures exhausted the retry budget and entered dead letter');

  const replayReason = `M6 end-to-end replay ${runToken}`;
  const replayRequest = await requestJson(`${apiBase}/webhooks/replay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: exhaustionEvent.source,
      eventId: exhaustionEvent.eventId,
      requestedBy: 'm6-verification',
      reason: replayReason,
    }),
  });
  assert.equal(replayRequest.response.status, 202, `Replay failed: ${JSON.stringify(replayRequest.payload)}`);
  const replayedTimeline = await waitForTimeline(
    exhaustionEvent,
    (timeline) => timeline.event.status === 'succeeded' && timeline.event.processingCycle === 2,
    'Audited replay to succeed',
  );
  assert.equal(replayedTimeline.attempts.length, 6);
  assert.equal(replayedTimeline.attempts[5].cycleNumber, 2);
  assert.equal(replayedTimeline.attempts[5].result, 'fulfillment_already_exists');
  assert.equal(replayedTimeline.replays.length, 1);
  assert.equal(replayedTimeline.replays[0].reason, replayReason);
  assert.equal(replayedTimeline.fulfillment.createdBy.eventId, workerEvents[0].eventId);
  const effectCount = await pool.query(
    "SELECT count(*)::integer AS count FROM fulfillments WHERE order_id = $1 AND action = 'fulfill_order'",
    [alreadyFulfilledOrder],
  );
  assert.equal(effectCount.rows[0].count, 1);
  log('PASS replay recorded its reason, retained prior attempts, and did not duplicate the fulfillment');

  log('All Milestone 6 backend scenarios passed. Test data and the temporary claim-delay trigger will now be removed.');
}

let failure;
try {
  await runVerification();
} catch (error) {
  failure = error;
  console.error('[verify:e2e] FAIL', error instanceof Error ? error.stack : error);
} finally {
  for (const child of [...children]) {
    try {
      await stopChild(child);
    } catch (error) {
      console.error(`[verify:e2e] Could not stop ${child.label}:`, error);
      failure ??= error;
    }
  }

  try {
    if (schemaReady) {
      try {
        await removeClaimDelayTrigger();
      } catch (error) {
        console.error('[verify:e2e] Could not remove the temporary claim-delay trigger:', error);
        failure ??= error;
      }
      try {
        await cleanupTestRows();
        log(`Cleanup complete for source ${testSource}`);
      } catch (error) {
        console.error('[verify:e2e] Could not clean test rows for source', testSource, error);
        failure ??= error;
      }
    } else {
      log('Database schema was not ready; no test records or trigger had been created.');
    }
  } catch (error) {
    console.error('[verify:e2e] Cleanup failed; inspect test source', testSource, error);
    failure ??= error;
  }
  await pool.end().catch((error) => {
    console.error('[verify:e2e] Could not close database pool:', error);
    failure ??= error;
  });
}

if (failure) process.exitCode = 1;
