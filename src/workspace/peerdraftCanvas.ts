import * as observable from 'lib0/observable'

type Events = {
  changePath: (oldPath: string, newPath: string) => void
}

export class PeerdraftCanvas extends observable.ObservableV2<Events> {
  private _path: string

  constructor(path: string) {
    super()
    this._path = path
  }

  get path() {
    return this._path
  }

  set path (value: string) {
    const old = this._path
    this._path = value
    if (value != old) {
      this.emit('changePath', [old, value])
    }
  }

}