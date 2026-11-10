import { describe, expect, test } from 'vitest'
import {
  classifyMapHash,
  MapImportVisibility,
  orderedOfficialHashes,
} from './import-hyperion-maps-helpers.mjs'

describe('orderedOfficialHashes', () => {
  test('keeps Battle.net maps first, then ASL maps, with first-seen content deduplication', () => {
    expect(
      orderedOfficialHashes(['b1', 'shared', 'b1', 'b2'], ['a1', 'shared', 'b2', 'a2']),
    ).toEqual(['b1', 'shared', 'b2', 'a1', 'a2'])
  })
})

describe('classifyMapHash', () => {
  test('selects current Battle.net and ASL content as official', () => {
    expect(classifyMapHash('official', new Set(['official']), new Set())).toBe(
      MapImportVisibility.Official,
    )
  })

  test('selects explicitly listed community content as public', () => {
    expect(classifyMapHash('community', new Set(), new Set(['community']))).toBe(
      MapImportVisibility.Public,
    )
  })

  test('defaults all remaining imported content to unofficial', () => {
    expect(classifyMapHash('old-ladder', new Set(), new Set())).toBe(MapImportVisibility.Unofficial)
  })

  test('gives official selection precedence over community selection', () => {
    expect(classifyMapHash('shared', new Set(['shared']), new Set(['shared']))).toBe(
      MapImportVisibility.Official,
    )
  })
})
