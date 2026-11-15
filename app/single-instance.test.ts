import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const network = vi.hoisted(() => {
  const state = {
    errorHandler: undefined as ((error: { code: string }) => void) | undefined,
    client: {
      on: vi.fn(),
    },
    server: {
      on: vi.fn(),
      listen: vi.fn(),
    },
    connect: vi.fn(),
    createServer: vi.fn(),
  }
  state.client.on.mockImplementation(
    (event: string, handler: (error: { code: string }) => void) => {
      if (event === 'error') {
        state.errorHandler = handler
      }
      return state.client
    },
  )
  state.server.on.mockReturnValue(state.server)
  state.server.listen.mockReturnValue(state.server)
  state.connect.mockReturnValue(state.client)
  state.createServer.mockReturnValue(state.server)
  return state
})

vi.mock('net', () => ({
  default: {
    connect: network.connect,
    createServer: network.createServer,
  },
}))
vi.mock('electron', () => ({
  app: { name: 'HyperShield', quit: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  network.errorHandler = undefined
})

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
})

describe('macOS single-instance startup', () => {
  it('uses a Unix socket and loads the app for the first instance', async () => {
    const { default: ensureSingleInstance } = await import('./single-instance')
    const loadNotifier = vi.fn(async () => vi.fn())

    ensureSingleInstance(loadNotifier)

    const socket = path.join(os.tmpdir(), 'HyperShield.sock')
    expect(network.connect).toHaveBeenCalledWith(socket, expect.any(Function))
    expect(network.errorHandler).toBeTypeOf('function')
    network.errorHandler!({ code: 'ENOENT' })
    expect(loadNotifier).toHaveBeenCalledOnce()
    expect(network.createServer).toHaveBeenCalledOnce()
    expect(network.server.listen).toHaveBeenCalledWith(socket)
  })

  it('unlinks and rebinds a refused stale Unix socket', async () => {
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {})
    const { default: ensureSingleInstance } = await import('./single-instance')
    const loadNotifier = vi.fn(async () => vi.fn())

    try {
      ensureSingleInstance(loadNotifier)
      network.errorHandler!({ code: 'ECONNREFUSED' })

      const socket = path.join(os.tmpdir(), 'HyperShield.sock')
      expect(unlink).toHaveBeenCalledExactlyOnceWith(socket)
      expect(network.createServer).toHaveBeenCalledOnce()
      expect(network.server.listen).toHaveBeenCalledWith(socket)
      expect(loadNotifier).toHaveBeenCalledOnce()
    } finally {
      unlink.mockRestore()
    }
  })
})
