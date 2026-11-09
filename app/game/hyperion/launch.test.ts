import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GameSetup, PlayerInfo } from '../../../common/games/game-launch-config'
import { GameType } from '../../../common/games/game-type'
import { NetcodeV2Setup } from '../../../common/games/netcode-v2'
import { SlotType } from '../../../common/lobbies/slot'
import { MapInfoJson } from '../../../common/maps'
import { RaceChar } from '../../../common/races'
import { makeSbUserId } from '../../../common/users/sb-user-id'
import {
  HyperionInstall,
  HyperionLaunchOptions,
  HyperionSpawn,
  launchHyperionProcess,
  parseHyperionInstall,
} from './launch'
import { HyperionCompatibility } from './native-protocol'

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}))
vi.mock('../../logger', () => ({ default: { warning: vi.fn() } }))

const HOST_USER_ID = makeSbUserId(101)
const GUEST_USER_ID = makeSbUserId(202)
const MAP_HASH = 'a'.repeat(64)
const RESULT_CODE = 'result-code-kept-out-of-the-native-manifest'
const SERVER_URL = 'https://server.invalid'
const PRIVATE_KEY = 'private-key-test-value'

const COMPATIBILITY: HyperionCompatibility = {
  adapterProtocol: 1,
  engineBuild: 'hyperion-test-build',
  simRevision: 22,
  rules: 'classic',
  modId: '',
  modFingerprint: 'b'.repeat(40),
  dataFingerprint: '0123abcd',
  rollback: false,
}

const INSTALL: HyperionInstall = {
  executablePath: '/opt/hyperion/Hyperion.x86_64',
  dataPath: '/opt/hyperion/data',
  gameDataPath: '/games/StarCraft',
  compatibility: COMPATIBILITY,
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false

  readonly kill = vi.fn(() => {
    this.killed = true
    return true
  })

  spawn() {
    this.emit('spawn')
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.emit('exit', code, signal)
  }
}

function makePlayer(playerId: number, userId: typeof HOST_USER_ID, race: RaceChar): PlayerInfo {
  return {
    id: `player-${playerId}`,
    userId,
    race,
    playerId,
    teamId: playerId,
    type: SlotType.Human,
    typeId: 6,
  }
}

function makeGameSetup(): GameSetup {
  const host = makePlayer(0, HOST_USER_ID, 'z')
  const guest = makePlayer(1, GUEST_USER_ID, 't')
  return {
    gameId: 'game-123',
    name: 'Hyperion test game',
    map: {
      hash: MAP_HASH,
      mapData: { format: 'scx' },
    } as MapInfoJson,
    gameType: GameType.OneVsOne,
    gameSubType: 0,
    slots: [host, guest],
    host,
    users: [
      { id: HOST_USER_ID, name: 'HostPlayer', created: 0 },
      { id: GUEST_USER_ID, name: 'GuestPlayer', created: 0 },
    ],
    disableAllianceChanges: true,
    seed: 0x12345678,
    useNetcodeV2: true,
    resultCode: RESULT_CODE,
  }
}

function makeNetcodeSetup(): NetcodeV2Setup {
  return {
    token: 'session-token-test-value',
    clientPrivateKey: PRIVATE_KEY,
    homeRelay: {
      relayId: 7,
      addrs: ['127.0.0.1:9000'],
      serverName: 'localhost',
      cert: 'relay-certificate',
    },
    roster: [
      { slot: 0, userId: HOST_USER_ID, homeRelayId: 7 },
      { slot: 1, userId: GUEST_USER_ID, homeRelayId: 7 },
    ],
    initialBufferTurns: 3,
    rollback: false,
  }
}

function makeOptions(overrides: Partial<HyperionLaunchOptions> = {}): HyperionLaunchOptions {
  return {
    setup: makeGameSetup(),
    netcodeSetup: makeNetcodeSetup(),
    localUserId: HOST_USER_ID,
    mapPath: '/maps/fighting-spirit.scx',
    install: INSTALL,
    resultContext: { resultCode: RESULT_CODE, serverUrl: SERVER_URL },
    ...overrides,
  }
}

function fakeSpawn(child: FakeChild) {
  const spawn = vi.fn<HyperionSpawn>(() => {
    queueMicrotask(() => child.spawn())
    return child as any
  })
  return spawn
}

function allowWindowsAcl(sid = 'S-1-5-21-100-200-300-1001', aclFailure?: Error) {
  vi.mocked(execFile).mockImplementation((...args: any[]) => {
    const callback = args.at(-1)
    const whoami = String(args[0]).endsWith('whoami.exe')
    const output = whoami
      ? `"test-machine\\\\Player","${sid}","User"\n`
      : 'Successfully processed 1 files\n'
    callback(!whoami ? aclFailure : null, output, '')
    return {} as any
  })
}

beforeEach(() => {
  vi.mocked(execFile).mockReset()
  allowWindowsAcl()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseHyperionInstall', () => {
  it('parses an install descriptor and optional paths', () => {
    expect(parseHyperionInstall(INSTALL)).toEqual(INSTALL)
  })

  it('rejects malformed descriptors without executing anything', () => {
    expect(() => parseHyperionInstall(null)).toThrow('must be an object')
    expect(() =>
      parseHyperionInstall({ executablePath: '', compatibility: COMPATIBILITY }),
    ).toThrow('executablePath')
    expect(() =>
      parseHyperionInstall({
        executablePath: '/hyperion',
        compatibility: COMPATIBILITY,
        dataPath: 4,
      }),
    ).toThrow('dataPath')
    expect(() =>
      parseHyperionInstall({
        executablePath: '/hyperion',
        compatibility: { ...COMPATIBILITY, simRevision: 21 },
      }),
    ).toThrow('simRevision must be 22')
  })
})

describe('launchHyperionProcess', () => {
  it('writes a restricted manifest, launches with native arguments, and cleans up on exit', async () => {
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const options = makeOptions()
    const launched = await launchHyperionProcess(options, spawn)

    expect(spawn).toHaveBeenCalledOnce()
    const [executable, args, spawnOptions] = spawn.mock.calls[0]
    expect(executable).toBe(INSTALL.executablePath)
    expect(args).toEqual(
      expect.arrayContaining([
        '--sb-map',
        options.mapPath,
        '--sb-role',
        'create',
        '--sb-name',
        'HostPlayer',
        '--rules',
        'hyperion',
        '--data',
        INSTALL.dataPath!,
        '--install-folder',
        INSTALL.gameDataPath!,
      ]),
    )
    expect(spawnOptions.cwd).toBe('/opt/hyperion')
    expect(spawnOptions.env.HYPERION_SB_EVENTS).toBe('1')
    expect(spawnOptions.env.HYPERION_SB_RESULT_CODE).toBe(RESULT_CODE)
    expect(spawnOptions.env).not.toHaveProperty('HYPERION_SB_SERVER_URL')
    expect(spawnOptions.windowsHide).toBe(true)

    const manifestPath = args[args.indexOf('--sb-setup') + 1]
    const manifestBytes = await fs.readFile(manifestPath, 'utf8')
    const manifest = JSON.parse(manifestBytes)
    expect(manifest.hyperion.localUserId).toBe(HOST_USER_ID)
    expect(manifest.hyperion.map.path).toBe(options.mapPath)
    expect(manifest.hyperion.compatibility.rules).toBe('hyperion')
    expect(manifest.hyperion).not.toHaveProperty('mutators')
    expect(manifestBytes).toContain(PRIVATE_KEY)
    expect(manifestBytes).not.toContain(RESULT_CODE)
    expect(manifestBytes).not.toContain(SERVER_URL)
    expect(launched.resultContext).toEqual({ resultCode: RESULT_CODE, serverUrl: SERVER_URL })

    child.exit(0)
    await expect(launched.proc.waitForExit()).resolves.toBe(0)
    await expect(fs.stat(manifestPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses a current-user ACL and native argument arrays for a hidden Windows launch', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    allowWindowsAcl()
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const install: HyperionInstall = {
      ...INSTALL,
      executablePath: 'C:\\Hyperion\\Hyperion.exe',
      dataPath: 'C:\\Users\\Player\\AppData\\Roaming\\HyperShield\\hyperion',
      gameDataPath: 'C:\\Games\\StarCraft',
      workingDirectory: 'C:\\Hyperion',
    }
    const mapPath = 'C:\\Maps\\Fighting Spirit.scx'

    const launched = await launchHyperionProcess(makeOptions({ install, mapPath }), spawn)

    expect(execFile).toHaveBeenCalledTimes(2)
    const system32 = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    expect(vi.mocked(execFile).mock.calls[0].slice(0, 2)).toEqual([
      path.win32.join(system32, 'whoami.exe'),
      ['/user', '/fo', 'csv', '/nh'],
    ])
    const [, args, spawnOptions] = spawn.mock.calls[0]
    const manifestPath = args[args.indexOf('--sb-setup') + 1]
    expect(vi.mocked(execFile).mock.calls[1].slice(0, 2)).toEqual([
      path.win32.join(system32, 'icacls.exe'),
      [
        path.dirname(manifestPath),
        '/inheritance:r',
        '/grant:r',
        '*S-1-5-21-100-200-300-1001:(OI)(CI)F',
      ],
    ])
    for (const [, , options] of vi.mocked(execFile).mock.calls) {
      expect(options).toMatchObject({ windowsHide: true })
    }

    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      'C:\\Hyperion\\Hyperion.exe',
      expect.arrayContaining([
        '--sb-map',
        mapPath,
        '--data',
        install.dataPath!,
        '--install-folder',
        install.gameDataPath!,
      ]),
      expect.objectContaining({
        cwd: 'C:\\Hyperion',
        windowsHide: true,
      }),
    )
    expect(spawnOptions.stdio).toEqual(['ignore', 'pipe', 'pipe'])

    child.exit(0xc0000005)
    await expect(launched.proc.waitForExit()).resolves.toBe(0xc0000005)
  })

  it('omits the native result credential when the seat cannot report', async () => {
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const launched = await launchHyperionProcess(
      makeOptions({ resultContext: { resultCode: undefined, serverUrl: SERVER_URL } }),
      spawn,
    )

    const [, args, spawnOptions] = spawn.mock.calls[0]
    expect(spawnOptions.env).not.toHaveProperty('HYPERION_SB_RESULT_CODE')
    const manifestBytes = await fs.readFile(args[args.indexOf('--sb-setup') + 1], 'utf8')
    expect(manifestBytes).not.toContain(SERVER_URL)
    child.exit(0)
    await launched.proc.waitForExit()
  })

  it.each([
    {
      name: 'Rule 1',
      ruleConfiguration: { ruleSet: 'hyperion', antiMeta: false },
      mutators: undefined,
    },
    {
      name: 'Rule 2',
      ruleConfiguration: { ruleSet: 'hyperion', antiMeta: true },
      mutators: { antiMeta: 1 },
    },
  ] as const)('carries $name through the manifest and process arguments', async testCase => {
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const launched = await launchHyperionProcess(
      makeOptions({ ruleConfiguration: testCase.ruleConfiguration }),
      spawn,
    )

    const [, args] = spawn.mock.calls[0]
    expect(args.slice(args.indexOf('--rules') + 1, args.indexOf('--rules') + 2)).toEqual([
      'hyperion',
    ])
    const manifest = JSON.parse(await fs.readFile(args[args.indexOf('--sb-setup') + 1], 'utf8'))
    expect(manifest.hyperion.compatibility.rules).toBe('hyperion')
    expect(Object.hasOwn(manifest.hyperion, 'mutators')).toBe(testCase.mutators !== undefined)
    expect(manifest.hyperion.mutators).toEqual(testCase.mutators)
    child.exit(0)
    await launched.proc.waitForExit()
  })

  it('prepares the map before spawning and does not spawn when preparation fails', async () => {
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const prepareMap = vi.fn(async () => {})
    await launchHyperionProcess(makeOptions({ prepareMap }), spawn)
    expect(prepareMap).toHaveBeenCalledBefore(spawn)

    const failure = new Error('map unavailable')
    await expect(
      launchHyperionProcess(
        makeOptions({ prepareMap: async () => Promise.reject(failure) }),
        spawn,
      ),
    ).rejects.toBe(failure)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('cleans up the manifest and reports a spawn error without exposing its contents', async () => {
    const child = new FakeChild()
    const spawn = vi.fn<HyperionSpawn>(() => {
      queueMicrotask(() => child.emit('error', new Error('native executable missing')))
      return child as any
    })
    const error = await launchHyperionProcess(makeOptions(), spawn).catch(error => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('native executable missing')
    expect(String(error)).not.toContain(RESULT_CODE)
    expect(String(error)).not.toContain(PRIVATE_KEY)
    const args = spawn.mock.calls[0][1]
    const manifestPath = args[args.indexOf('--sb-setup') + 1]
    await expect(fs.stat(manifestPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not write a manifest or spawn when Windows ACL restriction fails', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    allowWindowsAcl(undefined, new Error('icacls denied access'))
    const spawn = vi.fn<HyperionSpawn>()

    await expect(launchHyperionProcess(makeOptions(), spawn)).rejects.toThrow(
      'could not create a private game setup directory',
    )
    expect(spawn).not.toHaveBeenCalled()
    const [, aclArguments] = vi.mocked(execFile).mock.calls[1] as any[]
    const runDirectory = aclArguments[0] as string
    await expect(fs.stat(runDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('maps signal exits and makes quit and cleanup idempotent', async () => {
    const child = new FakeChild()
    const launched = await launchHyperionProcess(makeOptions(), fakeSpawn(child))
    const firstWait = launched.proc.waitForExit()
    const secondWait = launched.proc.waitForExit()
    const quitting = launched.quit()
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(launched.quit()).toBe(quitting)

    child.exit(null, 'SIGTERM')
    await expect(quitting).resolves.toBeUndefined()
    await expect(firstWait).resolves.toBe(143)
    await expect(secondWait).resolves.toBe(143)
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it.each([1, 0x7fffffff, -1073741819])(
    'preserves the numeric process exit code %i',
    async code => {
      const child = new FakeChild()
      const launched = await launchHyperionProcess(makeOptions(), fakeSpawn(child))
      child.exit(code)
      await expect(launched.proc.waitForExit()).resolves.toBe(code)
    },
  )

  it('forwards only secret-free lifecycle events and forwards each one once', async () => {
    const child = new FakeChild()
    const onStart = vi.fn()
    const onFinished = vi.fn()
    const launched = await launchHyperionProcess(
      makeOptions({ onStart, onFinished }),
      fakeSpawn(child),
    )
    child.stdout.write(`diagnostic ${RESULT_CODE}\n`)
    child.stdout.write('{"type":"start"}\n{"type":"start"}\n')
    child.stdout.write('{"type":"finished"}\r\n{"type":"finished"}\n')
    child.stdout.write('{"type":"unknown"}\nnot json\n')

    await vi.waitFor(() => {
      expect(onStart).toHaveBeenCalledTimes(1)
      expect(onFinished).toHaveBeenCalledTimes(1)
    })
    child.exit(0)
    await launched.proc.waitForExit()
  })
})
