import { around } from 'monkey-around'
import { SignalingConn } from 'y-webrtc'

/** Guard lib0's signaling sends until upstream checks the socket state itself. */
export function installSignalingSocketGuard(): () => void {
  return around(SignalingConn.prototype, {
    send(next) {
      return function (this: SignalingConn, message: unknown): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
          next.call(this, message)
        }
      }
    },
    destroy(next) {
      return function (this: SignalingConn): void {
        // A queued ping can outlive prototype guard removal during unload.
        // A destroyed connection must not send through that restored method.
        this.send = () => undefined
        next.call(this)
      }
    },
  })
}
