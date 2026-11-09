import { ChildProcess, execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GameSetup } from '../../../common/games/game-launch-config'
import { NetcodeV2Setup } from '../../../common/games/netcode-v2'
import { SbUserId } from '../../../common/users/sb-user-id'
import log from '../../logger'
import {
  HyperionCompatibility,
  HyperionNativeManifest,
  HyperionRuleConfiguration,
  makeHyperionManifest,
  parseHyperionCompatibility,
} from './native-protocol'

export interface HyperionInstall {
  executablePath: string
  /** Hyperion's writable settings, replay, and log directory. */
  dataPath?: string
  /** A legally supplied StarCraft installation already configured in ShieldBattery. */
  gameDataPath?: string
  workingDirectory?: string
  compatibility: HyperionCompatibility
}

export interface HyperionResultContext {
  resultCode?: string
  serverUrl: string
}

export interface HyperionLaunchOptions {
  setup: GameSetup
  netcodeSetup: NetcodeV2Setup
  localUserId: SbUserId
  mapPath: string
  install: HyperionInstall
  resultContext: HyperionResultContext
  /** Hyperion engine QoL with an ordinary starting state by default. */
  ruleConfiguration?: HyperionRuleConfiguration
  /** Checks the local map or completes its download before the native process starts. */
  prepareMap?: () => Promise<void>
  onStart?: () => void
  onFinished?: () => void
}

export interface HyperionLaunchResult {
  proc: { waitForExit: () => Promise<number> }
  releaseGpuPreference: () => void
  quit: () => Promise<void>
  resultContext: HyperionResultContext
}

export type HyperionSpawn = (
  executablePath: string,
  args: readonly string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    stdio: ['ignore', 'pipe', 'pipe']
    windowsHide: true
  },
) => ChildProcess

const DEFAULT_SPAWN: HyperionSpawn = (executablePath, args, options) =>
  spawn(executablePath, [...args], options)

const WINDOWS_ACL_TIMEOUT_MS = 10_000
const WINDOWS_ACL_MAX_OUTPUT_BYTES = 16 * 1024

function executeWindowsTool(executablePath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executablePath,
      args,
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: WINDOWS_ACL_TIMEOUT_MS,
        maxBuffer: WINDOWS_ACL_MAX_OUTPUT_BYTES,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error('Windows access-control command failed.', { cause: error }))
        } else {
          resolve(stdout)
        }
      },
    )
  })
}

async function restrictRunDirectory(
  runDirectory: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform !== 'win32') {
    await fs.chmod(runDirectory, 0o700)
    return
  }

  try {
    // chmod does not restrict NTFS access. Remove inherited ACEs before writing the manifest and
    // grant only the current user's SID access to the directory and its children.
    const system32 = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    const identity = await executeWindowsTool(path.win32.join(system32, 'whoami.exe'), [
      '/user',
      '/fo',
      'csv',
      '/nh',
    ])
    const sid = identity.match(/\bS-\d+-\d+(?:-\d+)+\b/i)?.[0]
    if (!sid) {
      throw new Error('Windows did not return the current user SID')
    }
    await executeWindowsTool(path.win32.join(system32, 'icacls.exe'), [
      runDirectory,
      '/inheritance:r',
      '/grant:r',
      `*${sid}:(OI)(CI)F`,
    ])
  } catch (error) {
    throw new Error('HyperShield could not create a private game setup directory.', {
      cause: error,
    })
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`Hyperion install ${field} must be a non-empty string without NULs`)
  }
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requireString(value, field)
}

export function parseHyperionInstall(value: unknown): HyperionInstall {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Hyperion install descriptor must be an object')
  }
  const record = value as Record<string, unknown>
  if (typeof record.compatibility !== 'object' || record.compatibility === null) {
    throw new Error('Hyperion install compatibility must be an object')
  }
  return {
    executablePath: requireString(record.executablePath, 'executablePath'),
    dataPath: optionalString(record.dataPath, 'dataPath'),
    gameDataPath: optionalString(record.gameDataPath, 'gameDataPath'),
    workingDirectory: optionalString(record.workingDirectory, 'workingDirectory'),
    compatibility: parseHyperionCompatibility(record.compatibility),
  }
}

function safeDirectoryPart(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)
  return cleaned || 'game'
}

function nativeArguments(
  manifestPath: string,
  options: HyperionLaunchOptions,
  manifest: HyperionNativeManifest,
): string[] {
  const local = manifest.hyperion.slots.find(slot => slot.userId === options.localUserId)!
  const args = [
    '--sb-setup',
    manifestPath,
    '--sb-map',
    options.mapPath,
    '--sb-role',
    local.host ? 'create' : 'join',
    '--sb-name',
    local.name,
    '--sb-type',
    manifest.hyperion.gameType,
    '--sb-speed',
    String(manifest.hyperion.speed),
    '--rules',
    manifest.hyperion.compatibility.rules,
  ]
  if (options.install.dataPath) {
    args.push('--data', options.install.dataPath)
  }
  if (options.install.gameDataPath) {
    args.push('--install-folder', options.install.gameDataPath)
  }
  return args
}

function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) {
    return code
  }
  const signals: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGABRT: 6,
    SIGKILL: 9,
    SIGTERM: 15,
  }
  return 128 + (signal ? (signals[signal] ?? 1) : 1)
}

function forwardLifecycleEvents(
  child: ChildProcess,
  onStart: (() => void) | undefined,
  onFinished: (() => void) | undefined,
): void {
  if (!child.stdout) {
    return
  }
  let started = false
  let finished = false
  let buffered = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffered += chunk
    for (;;) {
      const newline = buffered.indexOf('\n')
      if (newline < 0) {
        // Native events are small. Never retain an unbounded or unterminated line.
        if (buffered.length > 64 * 1024) {
          buffered = ''
        }
        return
      }
      const line = buffered.slice(0, newline).trim()
      buffered = buffered.slice(newline + 1)
      if (!line.startsWith('{')) {
        continue
      }
      try {
        const event = JSON.parse(line) as { type?: unknown }
        if (event.type === 'start' && !started) {
          started = true
          onStart?.()
        } else if (event.type === 'finished' && !finished) {
          finished = true
          onFinished?.()
        }
      } catch {
        // Other native stdout is diagnostic text, not a sidecar event.
      }
    }
  })
}

export async function launchHyperionProcess(
  options: HyperionLaunchOptions,
  spawnProcess: HyperionSpawn = DEFAULT_SPAWN,
): Promise<HyperionLaunchResult> {
  await options.prepareMap?.()
  const manifest = makeHyperionManifest(
    options.setup,
    options.netcodeSetup,
    options.mapPath,
    options.install.compatibility,
    options.localUserId,
    options.ruleConfiguration,
  )
  const runDirectory = await fs.mkdtemp(
    path.join(
      os.tmpdir(),
      `sb-hyperion-${safeDirectoryPart(options.localUserId.toString())}-${safeDirectoryPart(
        options.setup.gameId,
      )}-${manifest.hyperion.compatibility.rules}-`,
    ),
  )
  const manifestPath = path.join(runDirectory, 'setup.json')
  let child: ChildProcess | undefined
  let removeRunDirectory: Promise<void> | undefined
  const cleanup = () => {
    removeRunDirectory ??= fs.rm(runDirectory, { recursive: true, force: true }).then(() => {})
    return removeRunDirectory
  }

  try {
    await restrictRunDirectory(runDirectory, process.platform)
    await fs.writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600, flag: 'wx' })
    const args = nativeArguments(manifestPath, options, manifest)
    child = spawnProcess(options.install.executablePath, args, {
      cwd: options.install.workingDirectory ?? path.dirname(options.install.executablePath),
      env: {
        ...process.env,
        HYPERION_SB_EVENTS: '1',
        // The relay report needs this per-seat credential, but it must not enter
        // the manifest, command line, lifecycle events, or native logs.
        ...(options.resultContext.resultCode
          ? { HYPERION_SB_RESULT_CODE: options.resultContext.resultCode }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let exited = false
    const exit = new Promise<number>((resolve, reject) => {
      child!.once('error', reject)
      child!.once('exit', (code, signal) => {
        exited = true
        resolve(exitCode(code, signal))
      })
    })
    const waitForExit = async () => {
      try {
        return await exit
      } finally {
        await cleanup()
      }
    }

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', chunk => {
      const text = chunk.trim()
      if (text) {
        log.warning(`HyperShield ${options.setup.gameId}: ${text}`)
      }
    })

    try {
      await new Promise<void>((resolve, reject) => {
        child!.once('spawn', resolve)
        child!.once('error', reject)
      })
    } catch (error) {
      await waitForExit().catch(() => {})
      throw error
    }

    forwardLifecycleEvents(child, options.onStart, options.onFinished)
    let quitting: Promise<void> | undefined
    const quit = () => {
      quitting ??= (async () => {
        if (!exited) {
          child!.kill()
        }
        await waitForExit()
      })()
      return quitting
    }
    return {
      proc: { waitForExit },
      releaseGpuPreference: () => {},
      quit,
      resultContext: { ...options.resultContext },
    }
  } catch (error) {
    if (child && !child.killed) {
      child.kill()
    }
    await cleanup()
    throw error
  }
}
