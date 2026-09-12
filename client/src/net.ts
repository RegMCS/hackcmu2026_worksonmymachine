export interface PlayerInfo { id: string; name: string; color: number }

export type ServerMsg =
  | { type: 'welcome'; id: string; seed: number; players: PlayerInfo[] }
  | { type: 'players'; players: PlayerInfo[] }
  | { type: 'start'; at: number; seed: number; track?: string }
  | { type: 'state'; id: string; x: number; z: number; h: number; lap: number; progress: number; speed: number }
  | { type: 'event'; id: string; name: string; kind: string; text: string }
  | { type: 'finish'; id: string; name: string; time: number; place: number }
  | { type: 'leave'; id: string }
  | { type: 'error'; message: string };

type Handler = (msg: ServerMsg) => void;

export class Net {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  id = '';
  connected = false;

  connect(): Promise<void> {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => { this.connected = true; resolve(); };
      ws.onerror = () => reject(new Error('Could not reach the race server'));
      ws.onclose = () => { this.connected = false; };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data) as ServerMsg;
        if (msg.type === 'welcome') this.id = msg.id;
        for (const h of this.handlers) h(msg);
      };
      this.ws = ws;
    });
  }

  on(h: Handler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
