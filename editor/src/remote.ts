/**
 * Link between this editor tab and the local Claude Code bridge (the editor-mcp program).
 * The tab dials out to the bridge on this computer, receives commands, runs them through the
 * shared command layer (commands.ts), and answers. Off unless the user switches it on.
 */
import type { EditorCommands } from './commands';

/** The bridge's local port. Change both sides together: VITE_BRIDGE_PORT here (at build time) and EDITOR_BRIDGE_PORT for the bridge. */
const BRIDGE_PORT = Number(import.meta.env.VITE_BRIDGE_PORT) || 8765;
export const BRIDGE_URL = `ws://127.0.0.1:${BRIDGE_PORT}`;
const RETRY_MS = 4000;

export type LinkState = 'off' | 'waiting' | 'connected';

export class Remote {
  private ws: WebSocket | null = null;
  private timer = 0;
  private enabled = false;

  constructor(private commands: EditorCommands, private onState: (s: LinkState) => void) {}

  setEnabled(on: boolean) {
    this.enabled = on;
    clearTimeout(this.timer);
    if (on) this.connect();
    else { this.ws?.close(); this.ws = null; this.onState('off'); }
  }

  private connect() {
    if (!this.enabled || this.ws) return;
    this.onState('waiting');
    let ws: WebSocket;
    try { ws = new WebSocket(BRIDGE_URL); } catch { this.retry(); return; }
    this.ws = ws;
    ws.onopen = () => { if (this.ws === ws) this.onState('connected'); };
    ws.onmessage = (e) => { void this.handle(ws, String(e.data)); };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.retry(); } };
    ws.onerror = () => ws.close();
  }

  private retry() {
    if (!this.enabled) return;
    this.onState('waiting');
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.connect(), RETRY_MS);
  }

  private async handle(ws: WebSocket, text: string) {
    let msg: { id?: unknown; method?: unknown; params?: unknown };
    try { msg = JSON.parse(text); } catch { return; }
    if (typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
    const { id, method } = msg;
    try { ws.send(JSON.stringify({ id, ok: true, result: await this.commands.run(method, (msg.params ?? {}) as Record<string, unknown>) })); }
    catch (err) { ws.send(JSON.stringify({ id, ok: false, error: err instanceof Error ? err.message : String(err) })); }
  }
}
