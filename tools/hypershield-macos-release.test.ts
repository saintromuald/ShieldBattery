import { load } from 'js-yaml'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function read(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
}

describe('HyperShield Apple Silicon packaging', () => {
  it('builds ad-hoc-signed ARM64 DMG and ZIP packages with only the public engine layout', () => {
    const config = load(read('hypershield-mac.yml')) as any
    expect(config.productName).toBe('HyperShield')
    expect(config.publish).toEqual([])
    expect(config.afterPack).toBe('./tools/check-hyperion-package.cjs')
    expect(config.mac.identity).toBeNull()
    expect(config.electronFuses.resetAdHocDarwinSignature).toBe(true)
    expect(config.mac.target).toEqual([
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ])
    expect(config.mac.artifactName).toBe('HyperShield-${version}-${arch}-mac.${ext}')
    expect(config.extraResources[0].filter).toEqual(
      expect.arrayContaining(['Hyperion.app/**/*', 'Data/**/*', 'release.json', 'EDITION.txt']),
    )
    expect(config).not.toHaveProperty('notarize')
    expect(config.mac).not.toHaveProperty('notarize')
    expect(JSON.stringify(config)).not.toContain('Developer ID')
  })

  it('keeps the Windows game DLL build behind a host-platform guard', () => {
    const packageJson = JSON.parse(read('package.json'))
    expect(packageJson.scripts['build:hypershield:release']).toContain(
      'node tools/build-hypershield-game.mjs',
    )
    expect(packageJson.scripts['build:hypershield:release']).not.toContain('&& pnpm run build-game')
    expect(read('tools/build-hypershield-game.mjs')).toContain("process.platform === 'win32'")
  })

  it.skipIf(process.platform === 'win32')(
    'does not invoke the game build on this non-Windows host',
    () => {
      const result = spawnSync(process.execPath, ['tools/build-hypershield-game.mjs'], {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Skipping the Windows game DLL build')
    },
  )
})

describe('HyperShield Mac release workflow', () => {
  it('verifies, smoke-tests, and publishes Mac assets to the existing desktop release', () => {
    const workflow = load(read('.github/workflows/hypershield-release.yml')) as any
    const job = workflow.jobs['macos-arm64']
    expect(job.needs).toBe('linux-x64')
    expect(job['runs-on']).toBe('macos-15-arm64')
    const steps = job.steps.map((step: any) => step.run ?? '').join('\n')

    expect(steps).toContain('gh release download "$HYPERION_TAG"')
    expect(steps).toContain('--repo saintromuald/hyperion-public')
    expect(steps).toContain('*-mac-arm64.zip')
    expect(steps).toContain('asset.digest !== `sha256:${actual}`')
    expect(steps).toContain('Hyperion.app/Contents/MacOS/libSDL3.0.dylib')
    expect(steps).toContain('codesign --verify --deep --strict hyperion/Hyperion.app')
    expect(steps).toContain('codesign --verify --deep --strict "$app"')
    expect(steps).toContain('codesign --verify --deep --strict "$helper"')
    expect(steps).toContain('pnpm run build:hypershield:release')
    expect(steps).toContain('electron-builder build --mac --arm64 -c hypershield-mac.yml')
    expect(steps).toContain('dist/latest-mac.yml')
    expect(steps).toContain('ditto -x -k "$release_zip" "$extracted"')
    expect(steps).toContain('test -L "$framework/Versions/Current"')
    expect(steps).toContain("PlistBuddy -c 'Print :CFBundleExecutable'")
    expect(steps).toContain('hdiutil attach "$PWD/dist/HyperShield-${VERSION}-arm64-mac.dmg"')
    expect(steps).toContain('SB_PACKAGED_SMOKE_TEST=1')
    expect(steps).toContain('HYPERSHIELD_PACKAGED_SMOKE_OK')
    expect(steps).toContain("'--sb-identity'")
    expect(steps).toContain('gh release upload "$TAG"')
    expect(steps).not.toContain('--clobber')
    expect(steps).not.toContain('notarize')
    expect(steps).not.toContain('CSC_LINK')
  })
})
