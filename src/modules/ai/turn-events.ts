/** Progress of one generation run, as delivered over SSE. */
export type TurnEvent =
  | { type: 'stage'; stage: string; status: string }
  | { type: 'result'; result: unknown }
  | { type: 'error'; error: { code: string; message: string; [key: string]: unknown } };

type Stream = { events: TurnEvent[]; listeners: Set<(event: TurnEvent) => void>; closed: boolean; expiresAt: number };

/**
 * In-process event bus for asynchronous turns. Late subscribers receive the buffered history first, so a
 * browser that connects after the 202 still sees every stage. Single-instance by design (POC): with several
 * replicas the bus must move to PostgreSQL LISTEN/NOTIFY or another broker; the SSE route already falls back
 * to the persisted run when a stream is unknown.
 */
export class TurnEventBus {
  private readonly streams = new Map<string, Stream>();
  constructor(private readonly retentionMs = 10 * 60 * 1000, private readonly maxEventsPerRun = 200) {}

  open(runId: string): void {
    this.prune();
    if (!this.streams.has(runId)) this.streams.set(runId, { events: [], listeners: new Set(), closed: false, expiresAt: Date.now() + this.retentionMs });
  }

  has(runId: string): boolean { this.prune(); return this.streams.has(runId); }

  publish(runId: string, event: TurnEvent): void {
    const stream = this.streams.get(runId);
    if (!stream || stream.closed) return;
    if (stream.events.length < this.maxEventsPerRun || event.type !== 'stage') stream.events.push(event);
    for (const listener of stream.listeners) listener(event);
    if (event.type !== 'stage') { stream.closed = true; stream.listeners.clear(); }
  }

  /** Replays buffered events, then forwards live ones. Returns an unsubscribe function. */
  subscribe(runId: string, listener: (event: TurnEvent) => void): () => void {
    const stream = this.streams.get(runId);
    if (!stream) return () => {};
    for (const event of stream.events) listener(event);
    if (stream.closed) return () => {};
    stream.listeners.add(listener);
    return () => { stream.listeners.delete(listener); };
  }

  private prune(): void {
    const now = Date.now();
    for (const [runId, stream] of this.streams) if (stream.closed && stream.expiresAt < now) this.streams.delete(runId);
  }
}
