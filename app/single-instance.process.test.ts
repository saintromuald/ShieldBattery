import { type ChildProcess, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
const sockets: string[] = []

afterEach(async () => {
  await Promise.all([
    ...temporaryDirectories
      .splice(0)
      .map(directory => fs.rm(directory, { recursive: true, force: true })),
    ...sockets.splice(0).map(socket => fs.rm(socket, { force: true })),
  ])
})

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code))
  })
}

async function waitForFile(filePath: string, child: ChildProcess, output: () => string) {
  const deadline = Date.now() + 8_000
  for (;;) {
    try {
      await fs.access(filePath)
      return
    } catch {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`single-instance child exited before creating ${filePath}: ${output()}`)
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${filePath}: ${output()}`)
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
}

describe('real Unix single-instance processes', () => {
  it.skipIf(process.platform === 'win32')(
    'notifies the live first process and quits the second without replacing its socket',
    async () => {
      const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-single-instance-'))
      temporaryDirectories.push(stateDirectory)
      const session = `process-test-${process.pid}-${Date.now()}`
      const socket = path.join(os.tmpdir(), `HyperShield-${session}.sock`)
      sockets.push(socket)
      const fixture = fileURLToPath(
        new URL('./testing/single-instance-process.cjs', import.meta.url),
      )
      const output = new Map<ChildProcess, string>()
      const start = (role: 'first' | 'second') => {
        const child = spawn(process.execPath, ['-r', '@swc-node/register', fixture, role], {
          env: { ...process.env, SB_SESSION: session, SB_TEST_STATE_DIR: stateDirectory },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        output.set(child, '')
        child.stdout?.on('data', chunk => output.set(child, output.get(child) + chunk))
        child.stderr?.on('data', chunk => output.set(child, output.get(child) + chunk))
        return child
      }

      const outputFor = (child: ChildProcess | undefined) =>
        child ? (output.get(child) ?? '') : ''
      const first = start('first')
      const firstExit = waitForExit(first)
      let second: ChildProcess | undefined
      try {
        await waitForFile(path.join(stateDirectory, 'first.loaded'), first, () => outputFor(first))
        await waitForFile(socket, first, () => outputFor(first))

        const startedSecond = start('second')
        second = startedSecond
        const secondExit = waitForExit(startedSecond)
        expect(await secondExit).toBe(0)
        expect(outputFor(startedSecond)).toBe('')
        await expect(fs.access(path.join(stateDirectory, 'second.loaded'))).rejects.toThrow()
        await waitForFile(path.join(stateDirectory, 'notification.json'), startedSecond, () =>
          outputFor(startedSecond),
        )
        const notification = JSON.parse(
          await fs.readFile(path.join(stateDirectory, 'notification.json'), 'utf8'),
        )
        expect(notification.args.at(-1)).toBe('second')
        expect(first.exitCode).toBeNull()
        expect(first.signalCode).toBeNull()
        await expect(fs.access(path.join(stateDirectory, 'first.quit'))).rejects.toThrow()
        await expect(fs.access(socket)).resolves.toBeUndefined()
      } finally {
        second?.kill()
        first.kill()
        await firstExit
      }
    },
    15_000,
  )
})
