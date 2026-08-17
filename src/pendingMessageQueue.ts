// Kept dependency-free for testability.

export class PendingMessageQueue {
  private buffer: Uint8Array[] = []

  push(buf: Uint8Array): void {
    this.buffer.push(buf)
  }

  get size(): number {
    return this.buffer.length
  }

  flush(send: (buf: Uint8Array) => void): void {
    const pending = this.buffer
    this.buffer = []
    for (const buf of pending) {
      send(buf)
    }
  }
}
