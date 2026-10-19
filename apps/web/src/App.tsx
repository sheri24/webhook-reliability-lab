import { useCallback, useEffect, useMemo, useState } from 'react';

const API_BASE = 'http://localhost:3000';
const SOURCE = 'local-sender';

type EventStatus = 'pending' | 'processing' | 'retry_wait' | 'succeeded' | 'dead_letter';
type TestScenario = 'normal' | 'transient' | 'exhaust' | 'crash';

interface Fulfillment {
  id: string;
  orderId: string;
  createdBy?: { source: string; eventId: string };
  createdByEventId?: string;
  createdAt: string;
  action?: string;
}

interface EventSummary {
  source: string;
  eventId: string;
  eventType: string;
  status: EventStatus;
  processingCycle: number;
  orderId: string;
  payload: {
    source: string;
    eventId: string;
    eventType: 'order.fulfillment_requested';
    occurredAt: string;
    data: { orderId: string };
  };
  deliveryCount: number;
  attemptCount: number;
  nextAttemptAt: string | null;
  leaseExpiresAt: string | null;
  lastErrorClass: 'transient' | 'permanent' | null;
  lastError: string | null;
  receivedAt: string;
  updatedAt: string;
  fulfillment: Fulfillment | null;
}

interface Attempt {
  attemptNumber: number;
  cycleNumber: number;
  workerId: string;
  status: 'processing' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  result: 'fulfillment_created' | 'fulfillment_already_exists' | null;
  failureClass: 'transient' | 'permanent' | null;
  errorMessage: string | null;
  retryAt: string | null;
  fulfillmentId: string | null;
}

interface ReplayRecord {
  processingCycle: number;
  requestedBy: string;
  reason: string;
  previousStatus: string;
  requestedAt: string;
}

interface Timeline {
  event: EventSummary;
  deliveries: Array<{ receivedAt: string; payloadSha256: string; duplicate: boolean }>;
  attempts: Attempt[];
  replays: ReplayRecord[];
  fulfillment: Fulfillment | null;
}

interface Health {
  status: 'ok';
  database: 'ok';
}

function eventKey(event: Pick<EventSummary, 'source' | 'eventId'>): string {
  return `${event.source}:${event.eventId}`;
}

function newEventId(): string {
  return window.crypto?.randomUUID?.() ?? `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as { message?: string | string[] } | null;
  if (!response.ok) {
    const message = Array.isArray(payload?.message) ? payload.message.join(', ') : payload?.message;
    throw new Error(message || `Request failed with HTTP ${response.status}`);
  }
  return payload as T;
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [selectedKey, setSelectedKey] = useState('');
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [orderId, setOrderId] = useState('');
  const [eventId, setEventId] = useState('');
  const [scenario, setScenario] = useState<TestScenario>('normal');
  const [replayReason, setReplayReason] = useState('Corrected the simulated dependency failure');

  const selectedEvent = useMemo(
    () => events.find((event) => eventKey(event) === selectedKey) ?? null,
    [events, selectedKey],
  );

  const refreshDashboard = useCallback(async (signal?: AbortSignal) => {
    try {
      const [healthResponse, eventsResponse] = await Promise.all([
        fetch(`${API_BASE}/health`, { signal }),
        fetch(`${API_BASE}/webhooks/events`, { signal }),
      ]);
      const nextHealth = await readJson<Health>(healthResponse);
      const nextEvents = await readJson<{ events: EventSummary[] }>(eventsResponse);
      setHealth(nextHealth);
      setEvents(nextEvents.events);
      setConnectionError('');
      setSelectedKey((current) => {
        if (current && nextEvents.events.some((event) => eventKey(event) === current)) return current;
        return nextEvents.events[0] ? eventKey(nextEvents.events[0]) : '';
      });
    } catch (error) {
      if (!signal?.aborted) {
        setHealth(null);
        setConnectionError(error instanceof Error ? error.message : 'Could not reach the API');
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshDashboard(controller.signal);
    const timer = window.setInterval(() => void refreshDashboard(controller.signal), 2500);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refreshDashboard, refreshToken]);

  useEffect(() => {
    if (!selectedEvent) {
      setTimeline(null);
      return;
    }

    setTimeline(null);
    let active = true;
    const load = async () => {
      try {
        const query = new URLSearchParams({ source: selectedEvent.source, eventId: selectedEvent.eventId });
        const response = await fetch(`${API_BASE}/webhooks/timeline?${query}`);
        const nextTimeline = await readJson<Timeline>(response);
        if (active) setTimeline(nextTimeline);
      } catch {
        if (active) setTimeline(null);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 2500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [selectedEvent?.source, selectedEvent?.eventId, refreshToken]);

  const submitEvent = async (repeat?: EventSummary) => {
    const chosenOrderId = repeat?.orderId ?? orderId.trim();
    if (!chosenOrderId) {
      setActionError('Enter an order ID before sending an event.');
      return;
    }

    const chosenEventId = repeat?.eventId ?? (eventId.trim() || newEventId());
    const event = repeat?.payload ?? {
      source: SOURCE,
      eventId: chosenEventId,
      eventType: 'order.fulfillment_requested' as const,
      occurredAt: new Date().toISOString(),
      data: { orderId: chosenOrderId },
    };

    setBusy(true);
    setActionError('');
    setActionMessage('');
    try {
      const response = await fetch(`${API_BASE}/webhooks/demo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event,
          transientFailures: repeat ? 0 : scenario === 'transient' ? 2 : scenario === 'exhaust' ? 5 : 0,
          crashAfterClaim: !repeat && scenario === 'crash',
        }),
      });
      const result = await readJson<{
        source: string;
        eventId: string;
        duplicate: boolean;
        controlsConfigured: boolean;
      }>(response);
      setEventId('');
      setSelectedKey(`${result.source}:${result.eventId}`);
      setRefreshToken((current) => current + 1);
      if (repeat) {
        setActionMessage('Repeated delivery accepted. The event keeps the same ID and the delivery count increased.');
      } else if (result.duplicate) {
        setActionMessage('That event ID already exists, so the API recorded another delivery. Choose a fresh ID to inject behavior.');
      } else if (scenario === 'crash') {
        setActionMessage('Crash-after-claim queued. The worker will exit after claiming this event; restart it if your worker process does not auto-restart.');
      } else if (scenario === 'transient' && result.controlsConfigured) {
        setActionMessage('Two transient failures queued for the worker. Watch the attempt history and retry time below.');
      } else if (scenario === 'exhaust' && result.controlsConfigured) {
        setActionMessage('Five transient failures queued. With the default five-attempt retry limit, this event will enter dead letter and can be replayed here.');
      } else {
        setActionMessage('Event accepted by the local sender.');
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not send the event');
    } finally {
      setBusy(false);
    }
  };

  const replaySelected = async () => {
    if (!selectedEvent) return;
    setBusy(true);
    setActionError('');
    setActionMessage('');
    try {
      const response = await fetch(`${API_BASE}/webhooks/replay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: selectedEvent.source,
          eventId: selectedEvent.eventId,
          requestedBy: 'local-operator',
          reason: replayReason.trim() || 'Manual replay from the operations dashboard',
        }),
      });
      await readJson(response);
      setActionMessage('Replay queued. A new processing cycle will appear in this event history.');
      setRefreshToken((current) => current + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not queue replay');
    } finally {
      setBusy(false);
    }
  };

  const retryCount = events.filter((event) => event.status === 'retry_wait').length;
  const deadLetterCount = events.filter((event) => event.status === 'dead_letter').length;

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Webhook Reliability Lab home">
          <span className="brand-symbol" aria-hidden="true"><i /><i /><i /></span>
          <span><b>HOOKLINE</b><small>RELIABILITY LAB</small></span>
        </a>
        <div className="topbar-center"><span className="live-indicator" />LOCAL OPERATIONS</div>
        <div className="health-pills" aria-label="Service health">
          <HealthPill name="API" value={health ? 'Online' : connectionError ? 'Offline' : 'Checking'} ok={Boolean(health)} />
          <HealthPill name="DATABASE" value={health?.database === 'ok' ? 'Connected' : connectionError ? 'Offline' : 'Checking'} ok={health?.database === 'ok'} />
        </div>
      </header>

      <section className="page-heading" id="top">
        <div>
          <p className="eyebrow">ENGINEERING LAB <span>/</span> EVENT OPERATIONS</p>
          <h1>Webhook activity</h1>
          <p className="heading-copy">Follow each delivery from durable intake through retries, recovery, and fulfillment.</p>
        </div>
        <div className="summary-counters" aria-label="Event totals">
          <Metric label="VISIBLE EVENTS" value={events.length} />
          <Metric label="RETRYING" value={retryCount} accent="amber" />
          <Metric label="DEAD LETTER" value={deadLetterCount} accent="rose" />
        </div>
      </section>

      {connectionError && (
        <div className="banner banner-error" role="alert">
          <strong>API unavailable</strong><span>{connectionError}. Start PostgreSQL and the API, then this view will reconnect automatically.</span>
        </div>
      )}
      {actionMessage && <div className="banner banner-success" role="status">{actionMessage}</div>}
      {actionError && <div className="banner banner-error" role="alert">{actionError}</div>}

      <section className="workbench-grid">
        <aside className="panel send-panel">
          <div className="panel-heading">
            <div><p className="eyebrow">LOCAL SENDER</p><h2>Send an event</h2></div>
            <span className="step-number">01</span>
          </div>
          <form onSubmit={(event) => { event.preventDefault(); void submitEvent(); }}>
            <label htmlFor="order-id">Order ID</label>
            <input id="order-id" value={orderId} onChange={(event) => setOrderId(event.target.value)} placeholder="ord_10042" maxLength={255} />
            <label htmlFor="event-id">Event ID <span className="label-note">leave blank to generate</span></label>
            <input id="event-id" value={eventId} onChange={(event) => setEventId(event.target.value)} placeholder="evt_…" maxLength={255} />
            <label htmlFor="scenario">Worker scenario</label>
            <select id="scenario" value={scenario} onChange={(event) => setScenario(event.target.value as TestScenario)}>
              <option value="normal">Process normally</option>
              <option value="transient">Inject two transient failures</option>
              <option value="exhaust">Exhaust retries to dead letter</option>
              <option value="crash">Crash worker after claim</option>
            </select>
            <p className="field-help">
              {scenario === 'transient' && 'The next two worker claims will fail transiently, then retry normally.'}
              {scenario === 'exhaust' && 'Inject five transient failures to exhaust the default five-attempt retry limit and enable replay.'}
              {scenario === 'crash' && 'The worker exits after its claim commits. Restart it to recover if your runner does not restart automatically.'}
              {scenario === 'normal' && 'The local sender signs and submits a normal fulfillment request.'}
            </p>
            <button className="button button-primary send-button" type="submit" disabled={busy || !health}>
              <span aria-hidden="true">↗</span>{busy ? 'Working…' : 'Send event'}
            </button>
          </form>
          <div className="panel-divider" />
          <div className="local-note"><span className="note-icon">i</span><p>Demo controls are local-only. The sender signs the event with the lab secret before using the normal intake path.</p></div>
        </aside>

        <section className="panel event-panel" aria-labelledby="events-title">
          <div className="panel-heading event-list-heading">
            <div><p className="eyebrow">INBOX <span>/</span> LAST 100</p><h2 id="events-title">Recent events</h2></div>
            <span className="refresh-label"><span className="refresh-dot" />Refreshes every 2.5 sec</span>
          </div>
          {events.length === 0 ? (
            <div className="empty-state">
              <span className="empty-glyph" aria-hidden="true">⌁</span>
              <h3>{health ? 'No events yet' : 'Waiting for the API'}</h3>
              <p>{health ? 'Send a local event to start following the delivery lifecycle.' : 'The event inbox will appear when the API is reachable.'}</p>
            </div>
          ) : (
            <div className="table-scroll">
              <table className="event-table">
                <thead><tr><th>EVENT / ORDER</th><th>STATE</th><th>DELIVERIES</th><th>ATTEMPTS</th><th>RETRY / LEASE</th><th>FULFILLMENT</th></tr></thead>
                <tbody>
                  {events.map((event) => (
                    <tr
                      key={eventKey(event)}
                      className={selectedKey === eventKey(event) ? 'is-selected' : ''}
                      onClick={() => setSelectedKey(eventKey(event))}
                      tabIndex={0}
                      onKeyDown={(keyEvent) => { if (keyEvent.key === 'Enter' || keyEvent.key === ' ') setSelectedKey(eventKey(event)); }}
                    >
                      <td><strong className="event-id">{event.eventId}</strong><span className="sub-cell">{event.orderId}</span></td>
                      <td><StatusBadge status={event.status} /></td>
                      <td className="numeric-cell">{event.deliveryCount}</td>
                      <td className="numeric-cell">{event.attemptCount}<span className="sub-cell">cycle {event.processingCycle}</span></td>
                      <td className="time-cell">{event.status === 'retry_wait' ? formatTime(event.nextAttemptAt) : event.status === 'processing' ? `Lease ${formatTime(event.leaseExpiresAt)}` : '—'}</td>
                      <td>{event.fulfillment ? <span className="effect-yes"><span />Created</span> : <span className="effect-no">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </section>

      <section className="panel detail-panel" aria-labelledby="detail-title">
        {!selectedEvent ? (
          <div className="detail-empty"><div className="detail-empty-icon">↳</div><div><h2 id="detail-title">Event timeline</h2><p>Select an event above to inspect its deliveries, attempts, replay history, and fulfillment.</p></div></div>
        ) : (
          <>
            <div className="detail-header">
              <div className="detail-title-group">
                <p className="eyebrow">EVENT TIMELINE <span>/</span> {selectedEvent.source}</p>
                <div className="title-line"><h2 id="detail-title">{selectedEvent.eventId}</h2><StatusBadge status={selectedEvent.status} /></div>
                <p className="detail-subtitle">{selectedEvent.eventType} <span>·</span> Order {selectedEvent.orderId}</p>
              </div>
              <div className="detail-actions">
                <button className="button button-secondary" onClick={() => void submitEvent(selectedEvent)} disabled={busy || !health}>↻ <span>Resend same ID</span></button>
                {selectedEvent.status === 'dead_letter' && (
                  <button className="button button-replay" onClick={() => void replaySelected()} disabled={busy}>↻ <span>Replay event</span></button>
                )}
              </div>
            </div>

            {selectedEvent.status === 'dead_letter' && (
              <div className="replay-reason-row">
                <label htmlFor="replay-reason">Replay reason</label>
                <input id="replay-reason" value={replayReason} onChange={(event) => setReplayReason(event.target.value)} maxLength={1000} />
              </div>
            )}

            <div className="detail-metrics">
              <DetailMetric label="DELIVERIES" value={String(selectedEvent.deliveryCount)} detail="received by API" />
              <DetailMetric label="PROCESSING ATTEMPTS" value={String(selectedEvent.attemptCount)} detail={`cycle ${selectedEvent.processingCycle}`} />
              <DetailMetric
                label={selectedEvent.status === 'processing' ? 'LEASE EXPIRES' : 'NEXT RETRY'}
                value={selectedEvent.status === 'processing' ? formatTime(selectedEvent.leaseExpiresAt) : selectedEvent.status === 'retry_wait' ? formatTime(selectedEvent.nextAttemptAt) : 'Not scheduled'}
                detail={selectedEvent.status === 'processing' ? 'worker can recover after expiry' : selectedEvent.status === 'retry_wait' ? 'worker will reclaim when due' : 'no retry waiting'}
              />
              <DetailMetric label="LOCAL EFFECT" value={timeline?.fulfillment ? 'Created' : 'Not created'} detail={timeline?.fulfillment ? `order ${timeline.fulfillment.orderId}` : 'no fulfillment recorded'} />
            </div>

            {selectedEvent.lastError && (
              <div className={`last-error ${selectedEvent.lastErrorClass === 'permanent' ? 'permanent' : ''}`}>
                <span className="error-mark">!</span><div><small>LAST {selectedEvent.lastErrorClass?.toUpperCase() ?? ''} ERROR</small><p>{selectedEvent.lastError}</p></div>
              </div>
            )}

            <div className="timeline-columns">
              <section className="timeline-block">
                <div className="timeline-block-title"><h3>Processing attempts</h3><span>{timeline?.attempts.length ?? selectedEvent.attemptCount} total</span></div>
                {!timeline?.attempts.length ? <p className="quiet-empty">The worker has not claimed this event yet.</p> : (
                  <div className="attempt-list">
                    {timeline.attempts.map((attempt) => (
                      <article className="attempt-row" key={`${attempt.cycleNumber}-${attempt.attemptNumber}`}>
                        <span className={`attempt-marker ${attempt.status}`} aria-hidden="true">{attempt.status === 'succeeded' ? '✓' : attempt.status === 'failed' ? '!' : '·'}</span>
                        <div className="attempt-main">
                          <div className="attempt-heading"><strong>Cycle {attempt.cycleNumber} <span>/</span> Attempt {attempt.attemptNumber}</strong><span className={`attempt-state ${attempt.status}`}>{attempt.status.replace('_', ' ')}</span></div>
                          <p className="attempt-meta">{attempt.workerId} <span>·</span> Started {formatTime(attempt.startedAt)}</p>
                          {attempt.errorMessage && <p className="attempt-error">{attempt.failureClass}: {attempt.errorMessage}</p>}
                          {attempt.retryAt && <p className="attempt-retry">Retry scheduled {formatTime(attempt.retryAt)}</p>}
                          {attempt.result && <p className="attempt-result">{attempt.result.replaceAll('_', ' ')}</p>}
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>

              <section className="timeline-block side-timeline">
                <div className="timeline-block-title"><h3>Deliveries & replays</h3></div>
                <div className="compact-list">
                  {(timeline?.deliveries ?? []).map((delivery, index) => (
                    <div className="compact-row" key={`${delivery.receivedAt}-${index}`}>
                      <span className="compact-icon delivery-icon">↙</span><div><strong>{delivery.duplicate ? 'Duplicate delivery' : 'First delivery'}</strong><small>{formatTime(delivery.receivedAt)}</small></div>
                    </div>
                  ))}
                  {(timeline?.replays ?? []).map((replay) => (
                    <div className="compact-row" key={`replay-${replay.processingCycle}`}>
                      <span className="compact-icon replay-icon">↻</span><div><strong>Replay queued · cycle {replay.processingCycle}</strong><small>{replay.requestedBy} · {formatTime(replay.requestedAt)}</small><small>{replay.reason}</small></div>
                    </div>
                  ))}
                  {timeline?.fulfillment && (
                    <div className="compact-row">
                      <span className="compact-icon fulfillment-icon">✓</span><div><strong>Fulfillment recorded</strong><small>Order {timeline.fulfillment.orderId} · {formatTime(timeline.fulfillment.createdAt)}</small><small>Created by {timeline.fulfillment.createdBy?.eventId ?? timeline.fulfillment.createdByEventId}</small></div>
                    </div>
                  )}
                  {timeline && !timeline.deliveries.length && !timeline.replays.length && !timeline.fulfillment && <p className="quiet-empty">No deliveries, replays, or effects yet.</p>}
                </div>
              </section>
            </div>
          </>
        )}
      </section>

      <footer className="page-footer"><span>HOOKLINE / LOCAL WEBHOOK LAB</span><span>Events refresh automatically · Replay and demo controls are unauthenticated local tools</span></footer>
    </main>
  );
}

function HealthPill({ name, value, ok }: { name: string; value: string; ok: boolean }) {
  return <span className={`health-pill${ok ? ' is-ok' : ''}`}><i />{name}<b>{value}</b></span>;
}

function Metric({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return <div className={`summary-metric${accent ? ` ${accent}` : ''}`}><small>{label}</small><strong>{value.toString().padStart(2, '0')}</strong></div>;
}

function DetailMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="detail-metric"><small>{label}</small><strong>{value}</strong><span>{detail}</span></div>;
}

function StatusBadge({ status }: { status: EventStatus }) {
  return <span className={`status-badge ${status}`}><i />{status.replace('_', ' ')}</span>;
}
