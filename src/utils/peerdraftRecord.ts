import * as observable from 'lib0/observable'

type Events<Value> = {
  add: (key: string, value: Value) => void,
  update: (key: string, oldValue: Value, newValue: Value) => void,
  delete: (key: string, oldValue: Value) => void
}

export class PeerdraftRecord<Value> extends observable.ObservableV2<Events<Value>> {
  private record: Record<string, Value> = {}

  public set(key: string, value: Value) {
    const oldValue = this.record[key]
    this.record[key] = value
    if (oldValue === undefined) {
      this.emit('add', [key, value])
    } else if (oldValue != value) {
      this.emit('update', [key, oldValue, value])
    }
  }

  public get(key: string) {
    return this.record[key]
  }

  public delete(key: string) {
    const oldValue = this.record[key]
    delete this.record[key]
    this.emit('delete', [key, oldValue])
  }

  public get size() {
    return Object.keys(this.record).length
  }

  public get keys() {
    return Object.keys(this.record)
  }
}