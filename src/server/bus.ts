import { EventEmitter } from 'node:events';
import type { BoardEvent } from '../shared/types';

/**
 * In-process event bus, one instance per Repo. Every committed mutation
 * publishes its BoardEvent(s) here. Two consumers: the WebSocket broadcaster and
 * the long-poll `await` registry. Driving HITL wakeups off this emitter (not DB
 * polling) keeps resolution order consistent with `seq` order — see
 * docs/04-human-in-the-loop.md §6 and docs/09-concurrency.md.
 */
export class Bus extends EventEmitter {
  constructor() {
    super();
    // Long-poll waiters can be many; lift the default listener cap.
    this.setMaxListeners(0);
  }

  publish(events: BoardEvent[]): void {
    for (const ev of events) this.emit('event', ev);
  }

  /**
   * Resolve when an event matching `predicate` arrives, or null on timeout. The
   * caller must check committed state BEFORE awaiting to avoid the lost-wakeup
   * race (docs/04 §6).
   */
  waitFor(predicate: (ev: BoardEvent) => boolean, timeoutMs: number): Promise<BoardEvent | null> {
    return new Promise((resolve) => {
      const onEvent = (ev: BoardEvent) => {
        if (!predicate(ev)) return;
        cleanup();
        resolve(ev);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off('event', onEvent);
      };
      this.on('event', onEvent);
    });
  }
}
