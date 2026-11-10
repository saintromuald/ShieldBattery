import { describe, expect, test } from 'vitest'
import { buildLocalMapRootFolders } from './local-map-folders'

const OPTIONS = {
  starcraftPath: '/games/StarCraft',
  documentsPath: '/home/user/Documents/Starcraft/maps',
  programFolderName: 'Program folder',
  documentsFolderName: 'Documents folder',
}

describe('buildLocalMapRootFolders', () => {
  test('uses the first linked folder as the initial root and preserves built-in roots', () => {
    const roots = buildLocalMapRootFolders({
      ...OPTIONS,
      mapLibraryFolders: ['/games/hyperion/Maps/ladder', '/games/hyperion/Maps/ASL'],
    })

    expect(roots.default).toEqual({
      id: 'default',
      name: 'ladder',
      path: '/games/hyperion/Maps/ladder',
    })
    expect(roots['custom:1']).toEqual({
      id: 'custom:1',
      name: 'ASL',
      path: '/games/hyperion/Maps/ASL',
    })
    expect(roots.program.path).toBe('/games/StarCraft/Maps')
    expect(roots.documents.path).toBe(OPTIONS.documentsPath)
  })

  test('uses the program folder when no linked folders are configured', () => {
    const roots = buildLocalMapRootFolders({ ...OPTIONS, mapLibraryFolders: [] })

    expect(roots.default.path).toBe('/games/StarCraft/Maps')
    expect(roots.program).toBeUndefined()
    expect(roots.documents.path).toBe(OPTIONS.documentsPath)
  })

  test('linked folders work without a usable StarCraft path', () => {
    const roots = buildLocalMapRootFolders({
      ...OPTIONS,
      starcraftPath: '',
      mapLibraryFolders: ['/games/hyperion/Maps/ASL'],
    })

    expect(roots.default.path).toBe('/games/hyperion/Maps/ASL')
    expect(roots.program).toBeUndefined()
    expect(roots.documents.path).toBe(OPTIONS.documentsPath)
  })

  test('uses POSIX and Windows separators for their respective installations', () => {
    const roots = buildLocalMapRootFolders({
      ...OPTIONS,
      starcraftPath: 'C:\\StarCraft',
      mapLibraryFolders: [],
    })

    expect(roots.default.path).toBe('C:\\StarCraft\\Maps')
  })
})
