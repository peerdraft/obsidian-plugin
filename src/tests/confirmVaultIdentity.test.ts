import type { App } from 'obsidian'

let modal: { close: () => void }
const buttons: Map<string, () => void> = new Map()
jest.mock('obsidian', () => ({
  Modal: class {
    contentEl = { createEl: () => ({ setText: () => undefined }) }
    constructor() { modal = this }
    open() { (this as unknown as { onOpen: () => void }).onOpen() }
    close() { (this as unknown as { onClose: () => void }).onClose() }
  },
  Setting: class {
    setName() { return this }
    setHeading() { return this }
    setDesc() { return this }
    addButton(cb: (button: unknown) => void) {
      let label = ''
      const button = {
        setButtonText(text: string) { label = text; return button },
        setCta() { return button }, setWarning() { return button },
        onClick(fn: () => void) { buttons.set(label, fn); return button }
      }
      cb(button); return this
    }
  }
}), { virtual: true })
import { confirmVaultCopied } from '../ui/confirmVaultIdentity'

beforeEach(() => buttons.clear())
it.each([
  ['This vault is a copy', { copied: true }],
  ['It was moved or renamed', { copied: false }]
])('resolves the explicit choice: %s', async (label, expected) => {
  const result = confirmVaultCopied({} as App, '/old', '/new')
  buttons.get(label as string)!()
  await expect(result).resolves.toEqual(expected)
})
it('resolves dismissal without resetting identity or hanging startup', async () => {
  const result = confirmVaultCopied({} as App, '/old', '/new')
  modal.close()
  await expect(result).resolves.toBeUndefined()
})
