import { describe, expect, test } from 'vitest'
import { genResultCode } from './gen-result-code'

describe('genResultCode', () => {
  test('returns eight base-36 characters', () => {
    for (let i = 0; i < 100; i++) {
      expect(genResultCode()).toMatch(/^[0-9a-z]{8}$/)
    }
  })
})
