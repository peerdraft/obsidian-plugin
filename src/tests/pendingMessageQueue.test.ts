import { PendingMessageQueue } from '../pendingMessageQueue'

describe('PendingMessageQueue', () => {
  test('queues pushed messages instead of sending them', () => {
    const queue = new PendingMessageQueue()
    const buf = new Uint8Array([1, 2, 3])

    queue.push(buf)

    expect(queue.size).toBe(1)
  })

  test('flush sends queued messages in order and clears the queue', () => {
    const queue = new PendingMessageQueue()
    const first = new Uint8Array([1])
    const second = new Uint8Array([2])
    queue.push(first)
    queue.push(second)

    const sent: Uint8Array[] = []
    queue.flush((buf) => sent.push(buf))

    expect(sent).toEqual([first, second])
    expect(queue.size).toBe(0)
  })

  test('flush with nothing queued does not call the sender', () => {
    const queue = new PendingMessageQueue()
    const send = jest.fn()

    queue.flush(send)

    expect(send).not.toHaveBeenCalled()
  })
})
