import type { App } from 'obsidian'

interface TextControl {
  inputEl: { onkeydown?: (event: KeyboardEvent) => void }
  setValue: (value: string) => TextControl
  onChange: (callback: (value: string) => void) => TextControl
}
interface ButtonControl {
  setButtonText: (label: string) => ButtonControl
  setCta: () => ButtonControl
  onClick: (callback: () => void) => ButtonControl
}

let modal: { close: () => void }
let changeText: (value: string) => void
let input: TextControl['inputEl']
const buttons = new Map<string, () => void>()

jest.mock('obsidian', () => ({
  Modal: class {
    contentEl = {}
    constructor() { modal = this }
    open(): void { (this as unknown as { onOpen: () => void }).onOpen() }
    // Obsidian calls onClose for button dismissal, Escape and external close.
    close(): void { (this as unknown as { onClose?: () => void }).onClose?.() }
  },
  Setting: class {
    setName(): this { return this }
    setHeading(): this { return this }
    setDesc(): this { return this }
    addText(callback: (control: TextControl) => void): this {
      input = {}
      const control: TextControl = {
        inputEl: input,
        setValue: () => control,
        onChange: handler => { changeText = handler; return control },
      }
      callback(control)
      return this
    }
    addButton(callback: (control: ButtonControl) => void): this {
      let label = ''
      const control: ButtonControl = {
        setButtonText: value => { label = value; return control },
        setCta: () => control,
        onClick: handler => { buttons.set(label, handler); return control },
      }
      callback(control)
      return this
    }
  },
}), { virtual: true })

// An optional baseline target lets the same regression harness exercise the
// pre-fix source, without changing production files during verification.
const { promptForName, promptForText } = require(process.env.PEERDRAFT_TEXT_TEST_MODULE ?? '../ui/enterText') as typeof import('../ui/enterText')

beforeEach(() => buttons.clear())

it.each(['Cancel', 'Escape/close'])('settles a name prompt dismissed with %s', async action => {
  const settled = jest.fn()
  void promptForName({} as App).then(settled)
  changeText('Unconfirmed name')

  if (action === 'Cancel') buttons.get('Cancel')!()
  else modal.close()
  await Promise.resolve()

  expect(settled).toHaveBeenCalledTimes(1)
  expect(settled).toHaveBeenCalledWith(undefined)
})

it.each(['OK', 'Enter'])('keeps the accepted text when confirming with %s', async action => {
  const pending = promptForText({} as App, {
    header: 'Name', description: 'Choose a name', initial: { text: 'Initial' },
  })
  changeText('Dominik')
  if (action === 'OK') buttons.get('OK')!()
  else {
    const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
    input.onkeydown?.(event)
    expect(event.defaultPrevented).toBe(true)
  }

  await expect(pending).resolves.toEqual({ text: 'Dominik' })
})

it('settles once and preserves confirmed text if stale controls fire after close', async () => {
  const settled = jest.fn()
  const pending = promptForName({} as App).then(result => {
    settled(result)
    return result
  })
  changeText('Accepted')
  buttons.get('OK')!()
  changeText('Changed after close')
  modal.close()
  buttons.get('OK')!()

  await expect(pending).resolves.toEqual({ text: 'Accepted' })
  expect(settled).toHaveBeenCalledTimes(1)
})

it('does not turn a canceled prompt into an accepted result on a stale submit', async () => {
  const settled = jest.fn()
  const pending = promptForName({} as App).then(result => {
    settled(result)
    return result
  })
  buttons.get('Cancel')!()
  changeText('Too late')
  buttons.get('OK')!()

  await expect(pending).resolves.toBeUndefined()
  expect(settled).toHaveBeenCalledTimes(1)
})
