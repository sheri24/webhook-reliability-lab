# Local event contract

The lab uses a provider-neutral event envelope. The API accepts it at `POST /webhooks` after validating the request signature and event shape.

```json
{
  "source": "local-sender",
  "eventId": "evt_01J9EXAMPLE",
  "eventType": "order.fulfillment_requested",
  "occurredAt": "2026-10-19T08:00:00.000Z",
  "data": {
    "orderId": "ord_10042"
  }
}
```

`source` and `eventId` identify a delivery for deduplication. `eventType` selects the event shape. `occurredAt` is an ISO 8601 timestamp. The first supported event requests one local fulfillment for an `orderId`.

## Event status model

| Current status | Allowed next status | Meaning |
| --- | --- | --- |
| `pending` | `processing` | Persisted and waiting for work |
| `processing` | `succeeded`, `retry_wait`, `dead_letter` | A worker has claimed it |
| `retry_wait` | `processing` | The scheduled retry becomes eligible |
| `succeeded` | — | Processing completed |
| `dead_letter` | `pending` | An operator requested replay |

These transitions are the contract for the lab. The worker processes pending events and due retries. If a lease expires, a worker records the unfinished attempt as transient failure and reclaims the event. Permanent errors and exhausted retry cycles move to `dead_letter`.

## Local signature and intake behavior

Send `X-Webhook-Signature: sha256=<hex digest>`, where `<hex digest>` is the lowercase hexadecimal HMAC-SHA256 of the exact raw HTTP request body bytes, using `WEBHOOK_LAB_HMAC_SECRET` from the local `.env`. This is a lab-only scheme and is not compatible with a real provider.

The API verifies the signature before validating the parsed envelope. Missing or invalid signatures return 401; invalid event payloads return 400. Neither case writes an inbox event or delivery record. A valid request creates the inbox event and delivery record in one PostgreSQL transaction, then returns 202, for example `{ "status": "accepted", "source": "local-sender", "eventId": "evt_01J9EXAMPLE", "duplicate": false }`. Repeating the same `(source, eventId)` keeps one inbox event and adds another delivery record; the response sets `duplicate` to `true`. The delivery record stores the raw-body SHA-256 and whether that request found an existing event. A database error returns an error response instead of 202.

The dashboard uses the local-only `POST /webhooks/demo` sender. Its API handler creates the event's raw JSON bytes, signs them with the local HMAC secret, verifies the signature, and then uses the same intake service. It can atomically queue up to five transient worker failures or one crash-after-claim control for a newly inserted event. Duplicate event IDs create another delivery but do not replace or add controls. The endpoint returns 403 when `NODE_ENV=production`.

## Worker and fulfillment behavior

Run the API and worker as separate processes. The worker polls for `pending` events, claims one inside a short transaction using `FOR UPDATE SKIP LOCKED`, and assigns a worker ID, unique lease token, and lease expiry. The claim and processing-attempt row commit together. A second transaction verifies the lease, inserts the local fulfillment, marks the event `succeeded`, and completes the attempt atomically.

The local business key is `(order_id, action)`, where the action is `fulfill_order`. Two different event IDs for the same order remain separate inbox events, but the uniqueness constraint allows only one fulfillment. An attempt records whether it created that fulfillment or found the existing one.

Inspect the event, deliveries, processing attempts, replays, and matching fulfillment with `GET /webhooks/timeline?source=<source>&eventId=<eventId>`. The response includes an event summary, ordered delivery, attempt, and replay arrays, and the local fulfillment if one exists.

The dashboard loads up to 100 recent event summaries from `GET /webhooks/events`. It refreshes the event list and selected timeline every 2.5 seconds.

The worker classifies PostgreSQL connection, transaction rollback, resource, operator-intervention, system, and network errors as transient. Data, integrity, syntax, and unknown processing errors are permanent. Transient failures retry up to `RETRY_MAX_ATTEMPTS`, with full jitter from 0 ms through a capped exponential delay: the cap doubles from `RETRY_BASE_DELAY_MS` up to `RETRY_MAX_DELAY_MS`. A failure on the maximum attempt, or any permanent failure, moves the event to dead letter. The event and attempt timeline retains each error, classification, scheduled retry time, worker, and result.

## Dead-letter replay

Replay an event with `POST /webhooks/replay` and a JSON body containing `source`, `eventId`, `requestedBy`, and `reason`. The request is accepted only while the event is `dead_letter`; it returns 202 after the replay audit and state change commit together. Unknown events return 404 and events in other states return 409. A replay increments the event's processing cycle and starts a fresh attempt budget without deleting prior attempts. The unique `(order_id, action)` constraint still prevents a second local fulfillment if the effect already exists.

This endpoint is local-only and has no operator authentication. Do not expose it to an untrusted network.

## Development crash failpoint

For one worker process, set `NODE_ENV=development` and `WEBHOOK_LAB_CRASH_AFTER_CLAIM_EVENT_ID` to the provider event ID. Run `npm run worker`; the process exits with code 86 after committing its claim and attempt, leaving the lease to expire. Start a normal worker after the lease expiry to see it record the abandoned attempt and reclaim the event. The application refuses to enable this failpoint when `NODE_ENV` is not `development`.

The dashboard crash control also exits with code 86 after the selected event's claim commits. Unlike the environment failpoint, it is queued atomically with the local demo event and consumed by one worker claim. The dashboard's transient-failure control injects SQLSTATE `40001` before fulfillment, so the usual classification, retry, and attempt-history path handles it. These unauthenticated controls are intended for local use only.

Worker settings are `WEBHOOK_LAB_WORKER_POLL_INTERVAL_MS` (default 500) and `WEBHOOK_LAB_WORKER_LEASE_DURATION_MS` (default 30000). `WEBHOOK_LAB_WORKER_ID` optionally sets a readable worker label; otherwise the worker uses its hostname and process ID.

## Retry defaults

The shared retry defaults are 5 maximum attempts, 1,000 ms base delay, and 30,000 ms maximum delay. Environment variables `RETRY_MAX_ATTEMPTS`, `RETRY_BASE_DELAY_MS`, and `RETRY_MAX_DELAY_MS` override these settings.
