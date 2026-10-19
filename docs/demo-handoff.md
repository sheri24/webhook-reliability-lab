# Demo handoff and verification

## Current verification status

The Milestone 6 command `npm run verify:e2e` exited successfully on 2026-10-19. It covered all eight listed scenarios and removed its test rows and temporary trigger. This guide records the reproduction commands and observed results; see the [README](../README.md) for project setup.

The dashboard capture was taken after the gate passed: [milestone-6-dashboard.png](./assets/milestone-6-dashboard.png). It shows the dashboard online with a duplicate delivery, two transient failures, a successful third attempt, and one fulfillment. It was captured with headless Microsoft Edge 155.0.4283.62. The capture event rows were removed after the screenshot. The image also shows older M2 and M3 events already present in the local database. For a LinkedIn feed image, use the [4:3 cropped copy](./assets/linkedin-webhook-reliability.png); only empty space below the dashboard was trimmed.

For a LinkedIn feed image, use the [4:3 cropped copy](./assets/linkedin-webhook-reliability.png). It trims only unused space below the captured dashboard; no dashboard content or values were changed.

## Requirements and commands

Use Node.js 24, npm, and Docker Compose. Run from the project root in PowerShell:

```powershell
Copy-Item .env.example .env
npm install
npm run db:up
npm run db:migrate
npm run build
npm run verify:e2e
```

If `.env` already exists, keep it and skip `Copy-Item`. The verifier checks that the dashboard control and worker tables exist, starts its own API and worker processes on available local ports, and uses the database URL and HMAC secret from `.env`. It does not stop the PostgreSQL container.

`npm run verify:e2e` uses Node's built-in runtime and the existing `pg` dependency; it adds no test framework. The runner checks that all six required project tables exist. The database outage case starts a second API pointed at an available but unbound local port. It does not stop or modify the working database. The multiple-worker case briefly installs a PostgreSQL trigger that sleeps only when the verifier's unique source claims work. The trigger is removed in cleanup. Run one verification session at a time; a new run also removes a leftover trigger from an interrupted prior run.

The run prints its unique event source. In ordinary pass or assertion-failure paths, the runner stops its child processes, removes the temporary trigger, and deletes its run's controls, replay records, attempts, deliveries, fulfillment effects, and inbox rows. If the process or machine is forcibly terminated, check that printed source in PostgreSQL for leftover rows before starting another run; the next run removes the fixed-name M6 trigger.

## Scenarios and observed outcomes

| Scenario | Procedure in `npm run verify:e2e` | Expected result | Observed result |
| --- | --- | --- | --- |
| Invalid signature | Submit a valid event body with a wrong HMAC | HTTP 401; no inbox event or delivery | HTTP 401; no inbox event was written |
| Database outage | Send a correctly signed event to an API using an unreachable database port | Health returns 503; intake never returns 202; no event in the working database | Health HTTP 503; intake HTTP 500; never 202; no event in the working database |
| Concurrent duplicates | Send 20 identical signed deliveries at the same time | One inbox row, one non-duplicate delivery, 19 duplicate deliveries | 20 requests returned HTTP 202; 1 inbox row, 20 delivery rows, 19 duplicate deliveries |
| Multiple workers | Queue 12 distinct events, then start two workers while claim transactions are briefly delayed | Both worker IDs appear in attempt history; each event has one successful attempt | Both worker IDs processed the 12-event batch; each event had one successful attempt |
| Transient failure | Queue two injected transient failures | Two failed attempts have retry times; attempt 3 succeeds | Attempts 1 and 2 failed transiently with retry times; attempt 3 succeeded |
| Worker termination | Exit a worker after claim, wait for its lease, then start a normal worker | The first attempt records lease expiry; the restarted worker succeeds on attempt 2 | Failpoint worker exited with code 86 after claim; recovery marked the first attempt lease-expired and succeeded on attempt 2 |
| Retry exhaustion | Queue five transient failures with a five-attempt limit | Event enters dead letter after five failed attempts | Event entered `dead_letter` after five transient failures |
| Replay | Replay the exhausted event with a completed order's ID | Audit reason and cycle 2 remain visible; replay succeeds as `fulfillment_already_exists`; one fulfillment remains | Replay returned HTTP 202; audit reason and cycle 2 were retained; attempt 6 succeeded as `fulfillment_already_exists`; fulfillment count remained 1 |

The runner used a unique source for each run and removed its associated controls, replay records, attempts, deliveries, fulfillment effects, and inbox rows. A follow-up database check found no M6 test rows and no `m6_e2e_claim_delay` trigger. The separate dashboard capture rows were deleted after the screenshot.

## Facts and limits

- The end-to-end results above describe the executed local verification run. They do not claim provider-specific behavior or production readiness.
- The verification is local and PostgreSQL-backed. It does not test provider-specific retry behavior, production authentication, remote effects, throughput, or arbitrary event ordering.
- The worker crash is a deliberate local process exit. Recovery depends on starting another worker after the lease expires; the development file watcher does not automatically restart that crashed process.
- Dashboard demo and replay controls are unauthenticated local tools. Keep the API and dashboard on a trusted machine.
- The dashboard was exercised in headless Edge during the Milestone 5 gate and captured again after the M6 gate; the M6 capture is linked above.
