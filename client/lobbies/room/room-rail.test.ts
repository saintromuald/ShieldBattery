import { TFunction } from 'i18next'
import { describe, expect, test, vi } from 'vitest'
import { GameplayBackendPolicy } from '../../../common/games/backend'
import { GameType } from '../../../common/games/game-type'
import { Lobby } from '../../../common/lobbies'
import { createComputer, createOpen } from '../../../common/lobbies/slot'
import { canAddPlutoComputer, hostActionsFor, SlotAction } from './room-rail'

const t = ((_: string, fallback: string) => fallback) as unknown as TFunction
const limits = {
  lobbyTakesComputers: true,
  lobbyTakesPlutoComputers: true,
  canMakeObserver: false,
  canRemoveObserver: false,
}

describe('lobby computer selection', () => {
  test('offers a distinct Pluto action alongside the existing Classic computer action', () => {
    const slot = createOpen()
    const onSlotAction = vi.fn()
    const actions = hostActionsFor(slot, false, limits, onSlotAction, t)

    expect(actions.map(([label]) => label)).toEqual([
      'Close slot',
      'Add computer',
      'Add Pluto computer',
    ])
    actions.find(([label]) => label === 'Add computer')![1]()
    actions.find(([label]) => label === 'Add Pluto computer')![1]()
    expect(onSlotAction).toHaveBeenNthCalledWith(1, SlotAction.AddComputer, slot.id)
    expect(onSlotAction).toHaveBeenNthCalledWith(2, SlotAction.AddPlutoComputer, slot.id)
  })

  test('honors the ordinary-lobby Hyperion rollout before offering Pluto', () => {
    const lobby = {
      gameType: GameType.Melee,
      backendPolicy: GameplayBackendPolicy.HyperionFirst,
      teams: [{ name: '', teamId: 0, isObserver: false, slots: [createOpen()], hiddenSlots: [] }],
    } as Partial<Lobby> as Lobby

    expect(canAddPlutoComputer(lobby, false)).toBe(false)
    expect(canAddPlutoComputer(lobby, true)).toBe(true)
    expect(
      canAddPlutoComputer(
        { ...lobby, backendPolicy: GameplayBackendPolicy.ScrCompatibility },
        true,
      ),
    ).toBe(false)
    expect(canAddPlutoComputer({ ...lobby, gameType: GameType.OneVsOne }, true)).toBe(false)
  })

  test('does not offer Pluto when any computer already occupies a seat', () => {
    const lobby = {
      gameType: GameType.FreeForAll,
      backendPolicy: GameplayBackendPolicy.HyperionFirst,
      teams: [
        { name: '', teamId: 0, isObserver: false, slots: [createComputer()], hiddenSlots: [] },
      ],
    } as Partial<Lobby> as Lobby

    expect(canAddPlutoComputer(lobby, true)).toBe(false)
  })

  test('does not offer Pluto outside an eligible custom formation', () => {
    const actions = hostActionsFor(
      createOpen(),
      false,
      { ...limits, lobbyTakesPlutoComputers: false },
      vi.fn(),
      t,
    )

    expect(actions.map(([label]) => label)).toContain('Add computer')
    expect(actions.map(([label]) => label)).not.toContain('Add Pluto computer')
  })
})
