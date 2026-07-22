// Swarm board v2 — transport. One multiplexed SSE stream with epoch+seq;
// snapshot REST for boot/resync; visibility-aware polling fallback.
// Contract: docs/design/SWARM-BOARD-V2.md Addendum A.

const POLL_VISIBLE_MS = 2_000;
const POLL_HIDDEN_MS = 20_000;
const SSE_WATCHDOG_MS = 45_000;

export function readToken(doc = document) {
  return doc.querySelector('meta[name="swarm-token"]')?.content ?? '';
}

export async function fetchSnapshot(token, signal) {
  const response = await fetch('/api/board', {
    headers: { 'x-swarm-token': token },
    signal,
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`snapshot ${response.status}`);
  return response.json();
}

export async function postFocusAgent(token, agent) {
  const response = await fetch('/api/focus-agent', {
    method: 'POST',
    headers: { 'x-swarm-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ agent }),
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok && body.ok === true, message: body.message ?? `HTTP ${response.status}` };
}

/**
 * Keep the store fed. SSE primary; falls back to polling when the stream
 * errors terminally (e.g. proxy buffering) — but EventSource CONNECTING
 * retries are left alone per the reconnect contract.
 */
export function connectLive({ token, onBoard, onStatus }) {
  let source = null;
  let stopped = false;
  let lastMessageAt = Date.now();
  let pollTimer = null;
  let pollAbort = null;
  let watchdog = null;
  let streamId = null;

  const stop = () => {
    stopped = true;
    source?.close();
    clearInterval(watchdog);
    clearTimeout(pollTimer);
    pollAbort?.abort();
  };

  const startSse = () => {
    if (stopped) return;
    source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    onStatus('connecting');

    source.addEventListener('snapshot', event => {
      lastMessageAt = Date.now();
      try {
        const payload = JSON.parse(event.data);
        if (streamId && payload.streamId && payload.streamId !== streamId) {
          // Daemon restarted: epoch changed; the payload is already a full
          // snapshot so just adopt the new epoch.
          streamId = payload.streamId;
        } else if (payload.streamId) {
          streamId = payload.streamId;
        }
        onBoard(payload.board, payload.seq ?? 0);
        onStatus('live');
      } catch { /* malformed frame; next snapshot heals */ }
    });

    source.addEventListener('error', () => {
      // readyState CONNECTING means native retry is in progress — leave it.
      if (source.readyState === EventSource.CLOSED && !stopped) {
        onStatus('polling');
        startPolling();
      } else {
        onStatus('connecting');
      }
    });

    watchdog = setInterval(() => {
      if (stopped) return;
      if (Date.now() - lastMessageAt > SSE_WATCHDOG_MS) {
        source.close();
        onStatus('polling');
        startPolling();
        clearInterval(watchdog);
      }
    }, 10_000);
  };

  const startPolling = () => {
    if (stopped) return;
    const tick = async () => {
      if (stopped) return;
      pollAbort?.abort();
      pollAbort = new AbortController();
      try {
        const board = await fetchSnapshot(token, pollAbort.signal);
        onBoard(board, 0);
        onStatus('polling');
      } catch {
        onStatus('stale');
      }
      const interval = document.visibilityState === 'hidden' ? POLL_HIDDEN_MS : POLL_VISIBLE_MS;
      pollTimer = setTimeout(tick, interval + Math.random() * 500);
    };
    tick();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !stopped) {
        clearTimeout(pollTimer);
        tick();
      }
    });
  };

  startSse();
  return { stop };
}
