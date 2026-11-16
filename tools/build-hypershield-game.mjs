import { spawnSync } from 'node:child_process'

if (process.platform === 'win32') {
  const pnpmPath = process.env.npm_execpath
  if (!pnpmPath) {
    throw new Error('The HyperShield release build must be started with pnpm.')
  }
  // pnpm 12 can expose its native executable here rather than a JavaScript module path.
  const nativeExecutable = pnpmPath.toLowerCase().endsWith('.exe')
  const result = spawnSync(
    nativeExecutable ? pnpmPath : process.execPath,
    nativeExecutable ? ['run', 'build-game'] : [pnpmPath, 'run', 'build-game'],
    {
      stdio: 'inherit',
      env: process.env,
    },
  )
  if (result.error) {
    throw result.error
  }
  process.exitCode = result.status ?? 1
} else {
  console.log(`Skipping the Windows game DLL build on ${process.platform}.`)
}
