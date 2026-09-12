import { WS_PATH, type ClientMsg, type ServerMsg } from '../../../shared/net';

type Handler = (msg: ServerMsg) => void;
type OpenHandler = (reconnected: boolean) => void;

const INITIAL_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 5000;

/**
 * Typed WebSocket client. Every failure is soft: send() is a no-op when the
 * socket is down, and a drop mid-race must never reach the game loop as an
 * exception. Reconnects with exponential backoff while `connect()` is wanted.
 */
export class Net {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private openHandlers = new Set<OpenHandler>();
  private wantOpen = false;
  private backoff = INITIAL_BACKOFF_MS;
  private reconnectTimer = 0;
  private everOpened = false;
  private openWaiters: { resolve: () => void; reject: (err: Error) => void }[] = [];
  /** Last id assigned by the server. Changes if we reconnect. */
  id = '';
  connected = false;

  constructor(private url: string = defaultUrl()) {}

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Fires on every successful open. `reconnected` is true after the first. */
  onOpen(handler: OpenHandler): () => void {
    this.openHandlers.add(handler);
    return () => this.openHandlers.delete(handler);
  }

  /** Opens the socket. Rejects only the first attempt; later retries are silent. */
  connect(): Promise<void> {
    this.wantOpen = true;
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.openWaiters.push({ resolve, reject });
      this.open();
    });
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // Fail soft: a send on a half-closed socket must not take down the race.
    }
  }

  close(): void {
    this.wantOpen = false;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = 0;
    this.backoff = INITIAL_BACKOFF_MS;
    const waiters = this.openWaiters.splice(0);
    for (const w of waiters) w.reject(new Error('Disconnected'));
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }

  private open(): void {
    if (!this.wantOpen) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    let settled = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.backoff = INITIAL_BACKOFF_MS;
      settled = true;
      const reconnected = this.everOpened;
      this.everOpened = true;
      const waiters = this.openWaiters.splice(0);
      for (const w of waiters) w.resolve();
      for (const h of this.openHandlers) {
        try {
          h(reconnected);
        } catch (err) {
          console.warn('[net] onOpen failed', err);
        }
      }
    };

    ws.onerror = () => {
      // onclose follows; only the first handshake failure rejects connect().
      if (!settled) {
        settled = true;
        const waiters = this.openWaiters.splice(0);
        const err = new Error('Could not reach the race server');
        for (const w of waiters) w.reject(err);
      }
    };

    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.connected = false;
      if (!this.wantOpen) return;
      this.reconnectTimer = window.setTimeout(() => this.open(), this.backoff);
      this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2);
    };

    ws.onmessage = (e) => {
      const msg = parseServer(e.data);
      if (!msg) return;
      if (msg.type === 'welcome') this.id = msg.id;
      for (const h of this.handlers) {
        try {
          h(msg);
        } catch (err) {
          console.warn('[net] handler failed', err);
        }
      }
    };
  }
}

function defaultUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${WS_PATH}`;
}

function parseServer(raw: unknown): ServerMsg | null {
  try {
    const msg = JSON.parse(String(raw)) as ServerMsg;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return null;
    return msg;
  } catch {
    return null;
  }
}
