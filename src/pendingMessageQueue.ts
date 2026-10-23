export class PendingMessageQueue<T = Uint8Array> {
  private buffer: T[] = []

  push(buf: T): void {
    this.buffer.push(buf)
  }

  get size(): number {
    return this.buffer.length
  }

  flush(send: (buf: T) => void): void {
    const pending = this.buffer
    this.buffer = []
    for (const buf of pending) {
      send(buf)
    }
  }
}
