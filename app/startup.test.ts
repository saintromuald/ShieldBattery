import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const devState = vi.hoisted(() => ({ isDev: true }))

vi.mock('electron', () => ({ app: { name: '' } }))
vi.mock('electron-is-dev', () => ({
  get default() {
    return devState.isDev
  },
}))
vi.mock('./app', () => ({ notifyNewInstance: vi.fn() }))
vi.mock('./single-instance', () => ({ default: vi.fn() }))
vi.mock('./user-data-path', () => ({ getUserDataPath: () => '/tmp/ShieldBattery' }))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
let originalServer: string | undefined

beforeEach(() => {
  vi.resetModules()
  devState.isDev = true
  originalServer = process.env.SB_SERVER
  delete process.env.SB_SERVER
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  if (originalServer === undefined) {
    delete process.env.SB_SERVER
  } else {
    process.env.SB_SERVER = originalServer
  }
  vi.resetModules()
})

describe('desktop server default', () => {
  it('defaults Linux development to the local HyperShield service', async () => {
    await import('./startup')

    expect(process.env.SB_SERVER).toBe('http://192.168.40.253:5555')
  })

  it('lets packaged Linux builds use their compiled server URL', async () => {
    devState.isDev = false

    await import('./startup')

    expect(process.env.SB_SERVER).toBeUndefined()
  })

  it('preserves an explicit Linux server override', async () => {
    process.env.SB_SERVER = 'https://play.hypershield.example'

    await import('./startup')

    expect(process.env.SB_SERVER).toBe('https://play.hypershield.example')
  })

  it('does not add a server default on Windows', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    await import('./startup')

    expect(process.env.SB_SERVER).toBeUndefined()
  })
})
