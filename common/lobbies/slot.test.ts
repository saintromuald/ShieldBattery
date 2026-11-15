import { describe, expect, test } from 'vitest'
import { makeSbUserId } from '../users/sb-user-id'
import { getPlayerInfos, Lobby } from './index'
import { createComputer, createHuman, SlotType } from './slot'

describe('computer AI profiles', () => {
  test('omits the profile for a backwards-compatible Classic computer', () => {
    const computer = createComputer('z')

    expect(computer).not.toHaveProperty('ai')
    expect(computer.type).toBe(SlotType.Computer)
  })

  test('carries an explicit Pluto profile into launch PlayerInfo without adding a user', () => {
    const human = createHuman(makeSbUserId(1), 't')
    const computer = createComputer('z', { level: 'pluto' })
    const lobby = {
      teams: [
        {
          name: '',
          teamId: 0,
          isObserver: false,
          slots: [human, computer],
          hiddenSlots: [],
        },
      ],
    } as Partial<Lobby> as Lobby

    expect(getPlayerInfos(lobby)).toEqual([
      expect.objectContaining({
        id: human.id,
        userId: human.userId,
        type: SlotType.Human,
        race: 't',
      }),
      {
        id: computer.id,
        userId: undefined,
        race: 'z',
        playerId: 0,
        type: SlotType.Computer,
        typeId: 0,
        ai: { level: 'pluto' },
        teamId: 0,
      },
    ])
  })
})
