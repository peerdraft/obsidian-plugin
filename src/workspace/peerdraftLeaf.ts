import * as observable from 'lib0/observable'

type Events = {
  changeIsPreview: (oldMode: boolean, newMode: boolean) => void,
  changePath: (oldPath: string, newPath: string) => void
}

export class PeerdraftLeaf extends observable.ObservableV2<Events> {
  private _isPreview: boolean
  private _path: string

  constructor(path: string, isPreview: boolean) {
    super()
    this._isPreview = isPreview,
    this._path = path
  }

  get isPreview () {
    return this._isPreview
  }

  set isPreview (value: boolean) {
    const old = this._isPreview
    this._isPreview = value
    if (value != old) {
      this.emit('changeIsPreview', [old, value])
    }
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