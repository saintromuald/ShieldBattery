import { describe, expect, it, vi } from 'vitest'
import { createNativeGameQuitHandler } from './app-exit'

describe('createNativeGameQuitHandler', () => {
  it('holds initial and repeated quit events until native work settles, then re-enters quit', async () => {
    let finishNativeWork!: () => void
    const nativeWork = new Promise<void>(resolve => {
      finishNativeWork = resolve
    })
    const manager = { quitAllGamesOnAppExit: vi.fn(() => [nativeWork]) }
    const app = { quit: vi.fn() }
    const onError = vi.fn()
    const handler = createNativeGameQuitHandler(app, manager, onError)
    const first = { preventDefault: vi.fn() }
    const repeated = { preventDefault: vi.fn() }

    handler(first)
    handler(repeated)
    expect(first.preventDefault).toHaveBeenCalledTimes(1)
    expect(repeated.preventDefault).toHaveBeenCalledTimes(1)
    expect(manager.quitAllGamesOnAppExit).toHaveBeenCalledTimes(1)
    expect(app.quit).not.toHaveBeenCalled()

    finishNativeWork()
    await nativeWork
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1))

    const reentered = { preventDefault: vi.fn() }
    handler(reentered)
    expect(reentered.preventDefault).not.toHaveBeenCalled()
    expect(manager.quitAllGamesOnAppExit).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it('allows quit immediately when no native work is pending', () => {
    const manager = { quitAllGamesOnAppExit: vi.fn(() => []) }
    const app = { quit: vi.fn() }
    const handler = createNativeGameQuitHandler(app, manager, vi.fn())
    const event = { preventDefault: vi.fn() }

    handler(event)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
    expect(manager.quitAllGamesOnAppExit).toHaveBeenCalledTimes(1)
  })

  it('re-enters quit after all native work has settled even if one task rejects', async () => {
    const manager = {
      quitAllGamesOnAppExit: vi.fn(() => [
        Promise.reject(new Error('quit failed')),
        Promise.resolve(),
      ]),
    }
    const app = { quit: vi.fn() }
    const handler = createNativeGameQuitHandler(app, manager, vi.fn())
    const event = { preventDefault: vi.fn() }

    handler(event)
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1))

    const reentered = { preventDefault: vi.fn() }
    handler(reentered)
    expect(reentered.preventDefault).not.toHaveBeenCalled()
  })
})
