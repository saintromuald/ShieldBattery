import { describe, expect, test } from 'vitest'
import { filePathBaseName, getFileDirectory, isPathWithin, joinFilePath } from './file-paths'

describe('file browser paths', () => {
  test('joins POSIX paths without introducing Windows separators', () => {
    expect(joinFilePath('/home/user/Games/hyperion', 'Data', 'maps')).toBe(
      '/home/user/Games/hyperion/Data/maps',
    )
    expect(joinFilePath('/', 'home', 'user')).toBe('/home/user')
    expect(joinFilePath('/home/user/maps', '..')).toBe('/home/user/maps/..')
  })

  test('joins Windows paths with backslashes', () => {
    expect(joinFilePath('C:\\StarCraft', 'Maps', 'ladder')).toBe('C:\\StarCraft\\Maps\\ladder')
    expect(joinFilePath('C:\\', 'StarCraft', 'Maps')).toBe('C:\\StarCraft\\Maps')
  })

  test('returns parent directories on both path styles', () => {
    expect(getFileDirectory('/home/user/maps/ASL')).toBe('/home/user/maps')
    expect(getFileDirectory('/home')).toBe('/')
    expect(getFileDirectory('C:\\StarCraft\\Maps')).toBe('C:\\StarCraft')
    expect(getFileDirectory('C:\\StarCraft')).toBe('C:\\')
  })

  test('returns useful folder labels', () => {
    expect(filePathBaseName('/home/user/maps/ASL/')).toBe('ASL')
    expect(filePathBaseName('C:\\StarCraft\\Maps\\ladder\\')).toBe('ladder')
  })

  test('checks descendants with the host path case semantics and a segment boundary', () => {
    expect(isPathWithin('/home/user/maps', '/home/user/maps/ASL')).toBe(true)
    expect(isPathWithin('/home/user/maps', '/home/user/maps-other')).toBe(false)
    expect(isPathWithin('/home/user/Maps', '/home/user/maps')).toBe(false)
    expect(isPathWithin('C:\\StarCraft\\Maps', 'c:\\starcraft\\maps\\ladder')).toBe(true)
  })
})
