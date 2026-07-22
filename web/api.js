// Swarm board v2 — transport. Snapshot-stream contract: every SSE frame is a
// FULL self-superseding board snapshot (no replay cursor — reconnect
// correctness is "adopt the next snapshot"); streamId detects daemon restart;
// per-connection seq orders frames within one stream. Falls back to
// visibility-aware polling when EventSource is unavailable or goes stale.
// The stream authenticates via the HttpOnly cookie set by the / page, so the
// token never appears in a URL.

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

export function connectLive({ token, onBoard, onStatus }) {
  let stopped = false;
  let source = null;
  let watchdog = null;
  let lastMessageAt = Date.now();
  let lastSeq = 0;
  let streamId = null;

  // Exactly one polling chain may exist (finding: a visibilitychange during an
  // in-flight poll used to fork a second chain). A generation counter kills
  // superseded chains; inFlight prevents overlap within a generation.
  let pollGeneration = 0;
  let pollTimer = null;
  let pollAbort = null;
  let pollInFlight = false;

  const onVisibility = () => {
    if (stopped) return;
    if (document.visibilityState === 'visible' && pollGeneration > 0) {
      clearTimeout(pollTimer);
      pollTick(pollGeneration);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  const stop = () => {
    stopped = true;
    source?.close();
    clearInterval(watchdog);
    pollGeneration += 1;
    clearTimeout(pollTimer);
    pollAbort?.abort();
    document.removeEventListener('visibilitychange', onVisibility);
  };

  const pollTick = async generation => {
    if (stopped || generation !== pollGeneration || pollInFlight) return;
    pollInFlight = true;
    pollAbort = new AbortController();
    try {
      const board = await fetchSnapshot(token, pollAbort.signal);
      if (generation === pollGeneration && !stopped) {
        onBoard(board);
        onStatus('polling');
      }
    } catch {
      if (generation === pollGeneration && !stopped) onStatus('stale');
    } finally {
      pollInFlight = false;
    }
    if (generation !== pollGeneration || stopped) return;
    const interval = document.visibilityState === 'hidden' ? POLL_HIDDEN_MS : POLL_VISIBLE_MS;
    pollTimer = setTimeout(() => pollTick(generation), interval + Math.random() * 500);
  };

  const startPolling = () => {
    if (stopped) return;
    pollGeneration += 1;
    clearTimeout(pollTimer);
    pollTick(pollGeneration);
  };

  const startSse = () => {
    if (stopped) return;
    if (typeof EventSource !== 'function') {
      startPolling();
      return;
    }
    try {
      source = new EventSource('/api/events');
    } catch {
      startPolling();
      return;
    }
    onStatus('connecting');

    source.addEventListener('snapshot', event => {
      if (typeof window !== 'undefined') window.__frames = (window.__frames ?? 0) + 1;
      lastMessageAt = Date.now();
      try {
        const payload = JSON.parse(event.data);
        if (payload.streamId !== streamId) {
          // New server epoch (first frame or daemon restart): the frame is a
          // full snapshot, so adopting it IS the resync.
          streamId = payload.streamId;
          lastSeq = 0;
        }
        if (typeof payload.seq === 'number' && payload.seq <= lastSeq) return; // stale duplicate
        lastSeq = payload.seq ?? lastSeq;
        onBoard(payload.board);
        onStatus('live');
      } catch (error) {
        // A malformed frame is superseded by the next snapshot — but a
        // THROWING CONSUMER is a bug, not a transport problem; surface it.
        console.error('board snapshot handler failed:', error);
        if (typeof window !== 'undefined') window.__snapErr = String((error && error.stack) || error);
      }
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
        clearInterval(watchdog);
        onStatus('polling');
        startPolling();
      }
    }, 10_000);
  };

  startSse();
  return { stop };
}
