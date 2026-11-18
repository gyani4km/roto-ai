/** A growing list of sentences with change notification: the LLM stream pushes, the TTS pipeline consumes. */
export class Feed {
  constructor(items = [], closed = false) {
    this.items = [...items];
    this.closed = closed;
    this.waiters = new Set();
    this.onPush = null; // (index, text) -> void, called as soon as a sentence arrives
  }
  push(text) {
    this.items.push(text);
    this.onPush?.(this.items.length - 1, text);
    this.wake();
  }
  end() {
    this.closed = true;
    this.wake();
  }
  wake() {
    for (const w of this.waiters) w();
    this.waiters.clear();
  }
  /** Resolves once item k exists or the feed is closed (then check k < items.length). */
  until(k) {
    if (k < this.items.length || this.closed) return Promise.resolve();
    return new Promise((resolve) => this.waiters.add(resolve));
  }
}
