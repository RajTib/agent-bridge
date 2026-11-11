import { EventEmitter } from 'node:events';
import type { AgentSession, AuditEvent, Decision, MockCallView, PhoneCall } from '@agentbridge/shared';
import type { NewEvent, Store } from './store.js';

export interface BusEvents {
  'decision.created': Decision;
  'decision.updated': Decision;
  'decision.resolved': Decision;
  session: AgentSession;
  call: PhoneCall;
  audit: AuditEvent;
  'mock-call': MockCallView;
}

/**
 * In-process typed pub/sub. The dashboard SSE stream, the call manager and
 * the Discord notifier all subscribe here, so producers never need to know
 * who is listening. Listener errors are isolated so one faulty subscriber
 * cannot break the approval path.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  on<K extends keyof BusEvents>(event: K, listener: (payload: BusEvents[K]) => void): () => void {
    const wrapped = (payload: BusEvents[K]) => {
      try {
        listener(payload);
      } catch (err) {
        console.error(`[agentbridge] bus listener for "${event}" threw:`, err);
      }
    };
    this.emitter.on(event, wrapped);
    return () => this.emitter.off(event, wrapped);
  }

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    this.emitter.emit(event, payload);
  }
}

/**
 * Append-only audit trail. Every state change worth explaining later goes
 * through here: it is persisted first, then broadcast for the live timeline.
 */
export class Audit {
  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(e: NewEvent): AuditEvent {
    const event = this.store.appendEvent(e, this.now().toISOString());
    this.bus.emit('audit', event);
    return event;
  }
}
