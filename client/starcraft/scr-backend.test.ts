import { describe, expect, it } from 'vitest'
import { isScrBackendSupported } from './scr-backend'

describe('isScrBackendSupported', () => {
  it('retains SC:R support for Windows clients', () => {
    expect(isScrBackendSupported('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(true)
  })

  it('marks the Windows-only backend unsupported on Linux', () => {
    expect(isScrBackendSupported('Mozilla/5.0 (X11; Linux x86_64)')).toBe(false)
  })
})
