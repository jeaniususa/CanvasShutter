/**
 * Local connection between this program and the editor tab in the browser.
 * The editor dials in over a WebSocket on this computer only; commands go out, answers come back.
 */
import { WebSocketServer, type WebSocket } from 'ws';

export interface BridgeOptions { port: number; allowedOrigins: string[]; editorUrl: string }

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export class Bridge {
  private server: WebSocketServer | null = null;
  private editor: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  /** Set when the port could not be opened (for example, another copy is already running). */
  startError: string | null = null;

  constructor(private opts: BridgeOptions, private log: (msg: string) => void) {}

  start() {
    const server = new WebSocketServer({
      host: '127.0.0.1',          // this computer only; never reachable from the network
      port: this.opts.port,
      maxPayload: 32 * 1024 * 1024,
      // Only the editor's own page may connect. Other websites open in the browser are refused.
      verifyClient: ({ origin }: { origin?: string }) => {
        const ok = !!origin && this.opts.allowedOrigins.includes(origin);
        if (!ok) this.log(`refused a connection from origin ${origin ?? '(none)'}`);
        return ok;
      },
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      this.startError = err.code === 'EADDRINUSE'
        ? `Port ${this.opts.port} is already in use, probably by another running copy of this bridge (another Claude Code window?). Close the other one, then reconnect this server.`
        : `The bridge could not start: ${err.message}`;
      this.log(this.startError);
    });
    server.on('listening', () => this.log(`waiting for the editor on ws://127.0.0.1:${this.opts.port}`));
    server.on('connection', (ws) => {
      if (this.editor && this.editor !== ws) this.editor.close(4000, 'replaced by a newer editor tab');
      this.editor = ws;
      this.log('editor tab connected');
      ws.on('message', (data) => this.onMessage(String(data)));
      ws.on('close', () => {
        if (this.editor !== ws) return;
        this.editor = null;
        this.log('editor tab disconnected');
        this.failAll('The editor tab disconnected before answering.');
      });
      ws.on('error', () => ws.close());
    });
    this.server = server;
  }

  get connected() { return this.editor !== null; }

  private onMessage(text: string) {
    let msg: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
    try { msg = JSON.parse(text); } catch { return; }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok === true) p.resolve(msg.result);
    else p.reject(new Error(typeof msg.error === 'string' ? msg.error : 'The editor reported an error.'));
  }

  private failAll(reason: string) {
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(reason)); this.pending.delete(id); }
  }

  /** Sends one command to the editor and waits for its answer. */
  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    if (this.startError) return Promise.reject(new Error(this.startError));
    const editor = this.editor;
    if (!editor) {
      return Promise.reject(new Error(
        `No editor tab is connected. Ask the user to open the editor at ${this.opts.editorUrl} and tick "Let Claude Code control this editor" in its Claude section.`));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The editor did not answer "${method}" within ${Math.round(timeoutMs / 1000)} seconds.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      editor.send(JSON.stringify({ id, method, params }), (err) => {
        if (!err) return;
        clearTimeout(timer); this.pending.delete(id);
        reject(new Error(`Could not reach the editor: ${err.message}`));
      });
    });
  }

  stop() { this.failAll('The bridge is shutting down.'); this.editor?.close(); this.server?.close(); }
}
