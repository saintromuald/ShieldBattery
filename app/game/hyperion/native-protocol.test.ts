import { describe, expect, it } from 'vitest'
import { makeGameServerRegionId } from '../../../common/game-server-regions'
import { GameSetup, PlayerInfo } from '../../../common/games/game-launch-config'
import { GameType } from '../../../common/games/game-type'
import { NetcodeV2Setup } from '../../../common/games/netcode-v2'
import { getPlayerInfos, Lobby } from '../../../common/lobbies'
import {
  createClosed,
  createComputer,
  createHuman,
  createOpen,
  SlotType,
} from '../../../common/lobbies/slot'
import { MapInfoJson } from '../../../common/maps'
import { RaceChar } from '../../../common/races'
import { makeSbUserId } from '../../../common/users/sb-user-id'
import {
  HyperionCompatibility,
  HyperionNativeManifest,
  HyperionRuleConfiguration,
  hyperionSeedRecord,
  makeHyperionManifest,
  validateHyperionManifest,
} from './native-protocol'

const HOST_USER_ID = makeSbUserId(101)
const GUEST_USER_ID = makeSbUserId(202)
const MAP_HASH = 'a'.repeat(64)
const TOKEN = 'session-token-test-value'
const PRIVATE_KEY = 'private-key-test-value'
const MAP_PATH = '/maps/fighting-spirit.scx'

const COMPATIBILITY: HyperionCompatibility = {
  adapterProtocol: 1,
  engineBuild: 'hyperion-test-build',
  simRevision: 23,
  rules: 'classic',
  modId: 'hyperion-classic',
  modFingerprint: 'b'.repeat(40),
  dataFingerprint: '0123abcd',
  rollback: false,
}

const PLUTO_COMPATIBILITY: HyperionCompatibility = {
  ...COMPATIBILITY,
  features: ['plutoComputer'],
}

function makePlayer(playerId: number, userId: typeof HOST_USER_ID, race: RaceChar): PlayerInfo {
  return {
    id: `player-${playerId}`,
    userId,
    race,
    playerId,
    teamId: playerId,
    type: SlotType.Human,
    typeId: 6,
  }
}

function makeGameSetup(): GameSetup {
  const host = makePlayer(0, HOST_USER_ID, 'z')
  const guest = makePlayer(1, GUEST_USER_ID, 't')
  return {
    gameId: 'game-123',
    name: 'Hyperion test game',
    map: {
      hash: MAP_HASH,
      mapData: { format: 'scx' },
    } as MapInfoJson,
    gameType: GameType.OneVsOne,
    gameSubType: 0,
    slots: [host, guest],
    host,
    users: [
      { id: HOST_USER_ID, name: 'HostPlayer', created: 0 },
      { id: GUEST_USER_ID, name: 'GuestPlayer', created: 0 },
    ],
    disableAllianceChanges: true,
    seed: 0x12345678,
    useNetcodeV2: true,
  }
}

function makeNetcodeSetup(): NetcodeV2Setup {
  return {
    token: TOKEN,
    clientPrivateKey: PRIVATE_KEY,
    clientPubkey: 'client-public-key',
    homeRelay: {
      relayId: 7,
      addrs: ['127.0.0.1:9000'],
      serverName: 'localhost',
      cert: 'relay-certificate',
    },
    roster: [
      { slot: 0, userId: HOST_USER_ID, homeRelayId: 7 },
      { slot: 1, userId: GUEST_USER_ID, homeRelayId: 7 },
    ],
    initialBufferTurns: 3,
    rollback: false,
  }
}

function makeValidManifest(): HyperionNativeManifest {
  return makeHyperionManifest(
    makeGameSetup(),
    makeNetcodeSetup(),
    MAP_PATH,
    COMPATIBILITY,
    HOST_USER_ID,
  )
}

function makeManifestWithRuleConfiguration(
  ruleConfiguration: HyperionRuleConfiguration,
): HyperionNativeManifest {
  return makeHyperionManifest(
    makeGameSetup(),
    makeNetcodeSetup(),
    MAP_PATH,
    COMPATIBILITY,
    HOST_USER_ID,
    ruleConfiguration,
  )
}

function makePlutoGameSetup(gameType = GameType.Melee): GameSetup {
  const setup = makeGameSetup()
  setup.gameType = gameType
  setup.gameSubType = 0
  setup.slots.forEach(slot => {
    slot.teamId = 0
  })
  setup.slots.push({
    id: 'pluto',
    race: 'p',
    playerId: 0,
    teamId: 0,
    type: SlotType.Computer,
    typeId: 0,
    ai: { level: 'pluto' },
  })
  return setup
}

function makePlutoManifest(gameType = GameType.Melee): HyperionNativeManifest {
  return makeHyperionManifest(
    makePlutoGameSetup(gameType),
    makeNetcodeSetup(),
    MAP_PATH,
    PLUTO_COMPATIBILITY,
    HOST_USER_ID,
  )
}

function expectViolation(manifest: HyperionNativeManifest, message: string): void {
  expect(validateHyperionManifest(manifest)).toContain(message)
}

describe('makeHyperionManifest', () => {
  it('builds Rule 1 by default with Hyperion QoL and no mutators', () => {
    const manifest = makeValidManifest()

    expect(validateHyperionManifest(manifest)).toEqual([])
    expect(manifest).toMatchObject({
      token: TOKEN,
      clientPrivateKey: PRIVATE_KEY,
      clientPubkey: 'client-public-key',
      initialBufferTurns: 3,
      rollback: false,
    })
    expect(manifest.hyperion).toEqual({
      protocol: 1,
      gameId: 'game-123',
      name: 'Hyperion test game',
      gameType: 'oneVOne',
      gameSubType: 0,
      seed: 0x12345678,
      speed: 6,
      disableAllianceChanges: true,
      localUserId: HOST_USER_ID,
      slots: [
        {
          rpSlot: 0,
          stormId: 0,
          bwPlayerId: 0,
          userId: HOST_USER_ID,
          teamId: 0,
          name: 'HostPlayer',
          race: 'z',
          host: true,
        },
        {
          rpSlot: 1,
          stormId: 1,
          bwPlayerId: 1,
          userId: GUEST_USER_ID,
          teamId: 1,
          name: 'GuestPlayer',
          race: 't',
          host: false,
        },
      ],
      map: { format: 'scx', hash: MAP_HASH, path: MAP_PATH },
      compatibility: { ...COMPATIBILITY, rules: 'hyperion' },
    })
    expect(manifest.hyperion).not.toHaveProperty('mutators')
    expect(manifest.hyperion).not.toHaveProperty('ai')
  })

  it('emits the exact Pluto AI object while keeping both human rosters unchanged', () => {
    const netcode = makeNetcodeSetup()
    const originalRoster = structuredClone(netcode.roster)

    const manifest = makeHyperionManifest(
      makePlutoGameSetup(),
      netcode,
      MAP_PATH,
      PLUTO_COMPATIBILITY,
      HOST_USER_ID,
    )

    expect(validateHyperionManifest(manifest)).toEqual([])
    expect(manifest.roster).toEqual(originalRoster)
    expect(manifest.hyperion.slots).toEqual([
      {
        rpSlot: 0,
        stormId: 0,
        bwPlayerId: 0,
        userId: HOST_USER_ID,
        teamId: 0,
        name: 'HostPlayer',
        race: 'z',
        host: true,
      },
      {
        rpSlot: 1,
        stormId: 1,
        bwPlayerId: 1,
        userId: GUEST_USER_ID,
        teamId: 0,
        name: 'GuestPlayer',
        race: 't',
        host: false,
      },
    ])
    expect(manifest.hyperion.ai).toEqual({
      ownerRpSlot: 0,
      slots: [
        {
          stormId: 2,
          bwPlayerId: 2,
          name: 'Pluto',
          race: 'p',
          level: 'pluto',
        },
      ],
    })
    expect(manifest.hyperion.ai!.slots[0]).not.toHaveProperty('userId')
    expect(manifest.hyperion.ai!.slots[0]).not.toHaveProperty('resultCode')
    expect(manifest.hyperion.gameType).toBe('melee')
    expect(manifest.hyperion.compatibility.rules).toBe('hyperion')
  })

  it('selects an explicit Pluto owner deterministically without changing the host', () => {
    const setup = makePlutoGameSetup()
    setup.plutoOwnerUserId = GUEST_USER_ID
    const reversedNetcode = makeNetcodeSetup()
    reversedNetcode.roster.reverse()

    const hostManifest = makeHyperionManifest(
      setup,
      makeNetcodeSetup(),
      MAP_PATH,
      PLUTO_COMPATIBILITY,
      HOST_USER_ID,
    )
    const guestManifest = makeHyperionManifest(
      setup,
      reversedNetcode,
      MAP_PATH,
      PLUTO_COMPATIBILITY,
      GUEST_USER_ID,
    )

    expect(validateHyperionManifest(hostManifest)).toEqual([])
    expect(validateHyperionManifest(guestManifest)).toEqual([])
    expect(hostManifest.hyperion.ai?.ownerRpSlot).toBe(1)
    expect(guestManifest.hyperion.ai).toEqual(hostManifest.hyperion.ai)
    expect(guestManifest.hyperion.slots).toEqual(hostManifest.hyperion.slots)
    expect(hostManifest.hyperion.slots.map(slot => slot.host)).toEqual([true, false])
    expect(hostManifest.hyperion.localUserId).toBe(HOST_USER_ID)
    expect(guestManifest.hyperion.localUserId).toBe(GUEST_USER_ID)
  })

  it('rejects a Pluto owner outside the authenticated roster or without a Pluto computer', () => {
    const unknownOwner = makePlutoGameSetup()
    unknownOwner.plutoOwnerUserId = makeSbUserId(999)
    expect(() =>
      makeHyperionManifest(
        unknownOwner,
        makeNetcodeSetup(),
        MAP_PATH,
        PLUTO_COMPATIBILITY,
        HOST_USER_ID,
      ),
    ).toThrow('Hyperion Pluto inference requires an authenticated human owner')

    const noComputer = makeGameSetup()
    noComputer.plutoOwnerUserId = GUEST_USER_ID
    expect(() =>
      makeHyperionManifest(
        noComputer,
        makeNetcodeSetup(),
        MAP_PATH,
        PLUTO_COMPATIBILITY,
        HOST_USER_ID,
      ),
    ).toThrow('Hyperion Pluto inference owners require a Pluto computer')
  })

  it('ignores open and closed seats from real lobby PlayerInfo output', () => {
    const setup = makePlutoGameSetup()
    const lobby = {
      teams: [
        {
          name: '',
          teamId: 0,
          isObserver: false,
          slots: [
            createOpen(),
            createHuman(HOST_USER_ID, 'z'),
            createClosed(),
            createComputer('p', { level: 'pluto' }),
            createHuman(GUEST_USER_ID, 't'),
            createOpen(),
          ],
          hiddenSlots: [],
        },
      ],
    } as Partial<Lobby> as Lobby
    setup.slots = getPlayerInfos(lobby)
    setup.host = setup.slots.find(slot => slot.userId === HOST_USER_ID)!

    expect(setup.slots.map(slot => slot.type)).toEqual([
      SlotType.Open,
      SlotType.Human,
      SlotType.Closed,
      SlotType.Computer,
      SlotType.Human,
      SlotType.Open,
    ])
    const manifest = makeHyperionManifest(
      setup,
      makeNetcodeSetup(),
      MAP_PATH,
      PLUTO_COMPATIBILITY,
      HOST_USER_ID,
    )

    expect(validateHyperionManifest(manifest)).toEqual([])
    expect(manifest.hyperion.slots.map(slot => slot.userId)).toEqual([HOST_USER_ID, GUEST_USER_ID])
    expect(manifest.hyperion.ai).toMatchObject({
      ownerRpSlot: 0,
      slots: [{ stormId: 2, bwPlayerId: 2, level: 'pluto' }],
    })
    expect(manifest.roster).toHaveLength(2)
  })

  it('maps ShieldBattery FFA to the native freeForAll game type', () => {
    const manifest = makePlutoManifest(GameType.FreeForAll)

    expect(validateHyperionManifest(manifest)).toEqual([])
    expect(manifest.hyperion.gameType).toBe('freeForAll')
    expect(manifest.hyperion.slots.every(slot => slot.teamId === 0)).toBe(true)
  })

  it('rejects Classic or multiple computers instead of silently changing their AI profile', () => {
    const classic = makePlutoGameSetup()
    delete classic.slots.at(-1)!.ai
    expect(() =>
      makeHyperionManifest(classic, makeNetcodeSetup(), MAP_PATH, COMPATIBILITY, HOST_USER_ID),
    ).toThrow('exactly one Pluto computer')

    const multiple = makePlutoGameSetup()
    multiple.slots.push({ ...multiple.slots.at(-1)!, id: 'pluto-2' })
    expect(() =>
      makeHyperionManifest(multiple, makeNetcodeSetup(), MAP_PATH, COMPATIBILITY, HOST_USER_ID),
    ).toThrow('exactly one Pluto computer')
  })

  it.each(['', 'ShieldBattery Matchmaking', 'ShieldBattery Lobby', 'g'.repeat(25), 'é'.repeat(13)])(
    'uses the HyperShield display name for an unusable or upstream game name: %j',
    name => {
      const setup = makeGameSetup()
      setup.name = name
      setup.slots[1].playerId = setup.slots[0].playerId

      const manifest = makeHyperionManifest(
        setup,
        makeNetcodeSetup(),
        MAP_PATH,
        COMPATIBILITY,
        HOST_USER_ID,
      )

      expect(validateHyperionManifest(manifest)).toEqual([])
      expect(manifest.hyperion.name).toBe('HyperShield match')
      expect(manifest.hyperion.slots.map(slot => slot.bwPlayerId)).toEqual([0, 1])
    },
  )

  it('builds Rule 2 with Hyperion QoL and exactly the seeded anti-meta mutator', () => {
    const manifest = makeManifestWithRuleConfiguration({ ruleSet: 'hyperion', antiMeta: true })

    expect(validateHyperionManifest(manifest)).toEqual([])
    expect(manifest.hyperion.compatibility.rules).toBe('hyperion')
    expect(manifest.hyperion.mutators).toEqual({ antiMeta: 1 })
  })

  it('supports classic rules without mutators but rejects classic anti-meta', () => {
    const classic = makeManifestWithRuleConfiguration({ ruleSet: 'classic', antiMeta: false })

    expect(validateHyperionManifest(classic)).toEqual([])
    expect(classic.hyperion.compatibility.rules).toBe('classic')
    expect(classic.hyperion).not.toHaveProperty('mutators')
    expect(() => makeManifestWithRuleConfiguration({ ruleSet: 'classic', antiMeta: true })).toThrow(
      'hyperion.mutators must be absent for classic rules',
    )
  })

  it('builds a canonical 2v2 roster with team IDs', () => {
    const setup = makeGameSetup()
    const thirdUser = makeSbUserId(303)
    const fourthUser = makeSbUserId(404)
    const third = makePlayer(2, thirdUser, 'p')
    const fourth = makePlayer(3, fourthUser, 'z')
    setup.slots[0].teamId = 0
    setup.slots[1].teamId = 0
    third.teamId = 1
    fourth.teamId = 1
    setup.gameType = GameType.TopVsBottom
    setup.gameSubType = 2
    setup.slots.push(third, fourth)
    setup.users.push(
      { id: thirdUser, name: 'ThirdPlayer', created: 0 },
      { id: fourthUser, name: 'FourthPlayer', created: 0 },
    )
    const netcode = makeNetcodeSetup()
    netcode.roster.push(
      { slot: 2, userId: thirdUser, homeRelayId: 7 },
      { slot: 3, userId: fourthUser, homeRelayId: 7 },
    )

    const manifest = makeHyperionManifest(setup, netcode, MAP_PATH, COMPATIBILITY, HOST_USER_ID)

    expect(validateHyperionManifest(manifest)).toEqual([])
    expect(manifest.hyperion.gameType).toBe('topVBottom')
    expect(manifest.hyperion.gameSubType).toBe(2)
    expect(manifest.hyperion.slots.map(slot => slot.teamId)).toEqual([0, 0, 1, 1])
    expect(manifest.hyperion.slots.map(slot => slot.bwPlayerId)).toEqual([0, 1, 2, 3])
  })

  it('can identify the local user from the personalized roster', () => {
    const netcodeSetup = makeNetcodeSetup()
    netcodeSetup.roster[1].homeRegion = makeGameServerRegionId('us-east')

    const manifest = makeHyperionManifest(makeGameSetup(), netcodeSetup, MAP_PATH, COMPATIBILITY)

    expect(manifest.hyperion.localUserId).toBe(GUEST_USER_ID)
    expect(validateHyperionManifest(manifest)).toEqual([])
  })

  it('omits an absent clientPubkey and defaults an absent rollback to false', () => {
    const netcodeSetup = makeNetcodeSetup()
    delete netcodeSetup.clientPubkey
    delete netcodeSetup.rollback

    const manifest = makeHyperionManifest(
      makeGameSetup(),
      netcodeSetup,
      MAP_PATH,
      COMPATIBILITY,
      HOST_USER_ID,
    )

    expect(manifest).not.toHaveProperty('clientPubkey')
    expect(manifest.rollback).toBe(false)
  })

  it('rejects game types outside canonical teams and custom Melee/FFA', () => {
    const setup = makeGameSetup()
    setup.gameType = GameType.TeamMelee

    expect(() =>
      makeHyperionManifest(setup, makeNetcodeSetup(), MAP_PATH, COMPATIBILITY, HOST_USER_ID),
    ).toThrow('Hyperion manifests support only canonical teams and custom Melee/Free for all')
  })

  it('rejects a setup that permits alliance changes', () => {
    const setup = makeGameSetup()
    setup.disableAllianceChanges = false

    expect(() =>
      makeHyperionManifest(setup, makeNetcodeSetup(), MAP_PATH, COMPATIBILITY, HOST_USER_ID),
    ).toThrow('Hyperion manifests require alliance changes to be disabled')
  })

  it('rejects unlocked Melee instead of silently locking it in the native manifest', () => {
    const setup = makePlutoGameSetup()
    setup.disableAllianceChanges = false

    expect(() =>
      makeHyperionManifest(setup, makeNetcodeSetup(), MAP_PATH, COMPATIBILITY, HOST_USER_ID),
    ).toThrow('Hyperion manifests require alliance changes to be disabled')
  })

  it('rejects a rollback session without exposing credentials', () => {
    const netcodeSetup = makeNetcodeSetup()
    netcodeSetup.rollback = true

    let thrown: unknown
    try {
      makeHyperionManifest(makeGameSetup(), netcodeSetup, MAP_PATH, COMPATIBILITY, HOST_USER_ID)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).toContain('rollback must be false')
    expect(message).not.toContain(TOKEN)
    expect(message).not.toContain(PRIVATE_KEY)
  })
})

describe('hyperionSeedRecord', () => {
  it('returns the exact 0x48 record with a little-endian seed and eight 0x08 bytes', () => {
    expect(hyperionSeedRecord(makeValidManifest())).toEqual([
      0x48, 0x78, 0x56, 0x34, 0x12, 8, 8, 8, 8, 8, 8, 8, 8,
    ])
    expect(hyperionSeedRecord(makeValidManifest())).toHaveLength(13)
  })

  it('encodes the uint32 upper boundary without signed bytes', () => {
    const manifest = makeValidManifest()
    manifest.hyperion.seed = 0xffffffff

    expect(hyperionSeedRecord(manifest)).toEqual([
      0x48, 0xff, 0xff, 0xff, 0xff, 8, 8, 8, 8, 8, 8, 8, 8,
    ])
  })
})

describe('validateHyperionManifest', () => {
  it('accepts Hyperion rules without a mutator object', () => {
    const manifest = makeValidManifest()

    expect(manifest.hyperion).not.toHaveProperty('mutators')
    expect(validateHyperionManifest(manifest)).toEqual([])
  })

  it.each([22, 24])('rejects unsupported simulation revision %i', simRevision => {
    const manifest = makeValidManifest()
    manifest.hyperion.compatibility.simRevision = simRevision as 23

    expectViolation(manifest, 'hyperion.compatibility.simRevision must be 23')
  })

  it('accepts uppercase hexadecimal in the 8-character data fingerprint', () => {
    const manifest = makeValidManifest()
    manifest.hyperion.compatibility.dataFingerprint = 'ABCD0123'

    expect(validateHyperionManifest(manifest)).toEqual([])
  })

  it('accepts an empty mod id for the built-in Brood War data', () => {
    const manifest = makeValidManifest()
    manifest.hyperion.compatibility.modId = ''

    expect(validateHyperionManifest(manifest)).toEqual([])
  })

  it('validates optional engine feature advertisements without requiring them', () => {
    const manifest = makeValidManifest()
    expect(validateHyperionManifest(manifest)).toEqual([])

    manifest.hyperion.compatibility.features = ['plutoComputer']
    expect(validateHyperionManifest(manifest)).toEqual([])

    manifest.hyperion.compatibility.features = ['plutoComputer', 'plutoComputer']
    expectViolation(
      manifest,
      'hyperion.compatibility.features must contain unique known native features',
    )
  })

  it('requires the engine to explicitly advertise Pluto for an AI manifest', () => {
    const manifest = makePlutoManifest()
    delete manifest.hyperion.compatibility.features

    expectViolation(manifest, 'hyperion.ai requires explicit plutoComputer engine compatibility')
  })

  it('rejects mutators with classic rules', () => {
    const classic = makeValidManifest()
    classic.hyperion.compatibility.rules = 'classic'
    classic.hyperion.mutators = { antiMeta: 1 }

    expectViolation(classic, 'hyperion.mutators must be absent for classic rules')
  })

  it.each([
    { name: 'antiMeta: 0', mutators: { antiMeta: 0 } },
    { name: 'extra mutators', mutators: { antiMeta: 1, minerals: 200 } },
    { name: 'an empty mutator object', mutators: {} },
  ])('rejects $name with Hyperion rules', ({ mutators }) => {
    const manifest = makeValidManifest()
    manifest.hyperion.mutators = mutators as any

    expectViolation(manifest, 'hyperion.mutators must contain exactly antiMeta: 1 when present')
  })

  it('accepts another authenticated human as the stable Pluto inference owner', () => {
    const manifest = makePlutoManifest()
    manifest.hyperion.ai!.ownerRpSlot = 1

    expect(validateHyperionManifest(manifest)).toEqual([])
  })

  it.each([
    {
      name: 'multiple AI slots',
      mutate: (manifest: HyperionNativeManifest) => {
        manifest.hyperion.ai!.slots.push({
          ...manifest.hyperion.ai!.slots[0],
          stormId: 3,
          bwPlayerId: 3,
        })
      },
      message: 'hyperion.ai.slots must contain exactly one Pluto computer',
    },
    {
      name: 'an AI owner outside the human roster',
      mutate: (manifest: HyperionNativeManifest) => {
        manifest.hyperion.ai!.ownerRpSlot = 2
      },
      message: 'hyperion.ai.ownerRpSlot must identify an authenticated human slot',
    },
    {
      name: 'an AI slot that is not first free',
      mutate: (manifest: HyperionNativeManifest) => {
        manifest.hyperion.ai!.slots[0].stormId = 3
        manifest.hyperion.ai!.slots[0].bwPlayerId = 3
      },
      message: 'hyperion.ai.slots[0] must occupy the first free classic slot below 8',
    },
    {
      name: 'mismatched AI slot identifiers',
      mutate: (manifest: HyperionNativeManifest) => {
        manifest.hyperion.ai!.slots[0].stormId = 3
      },
      message: 'hyperion.ai.slots[0] must occupy the first free classic slot below 8',
    },
    {
      name: 'a non-Pluto AI level',
      mutate: (manifest: HyperionNativeManifest) => {
        ;(manifest.hyperion.ai!.slots[0] as any).level = 'classic'
      },
      message: "hyperion.ai.slots[0].level must be 'pluto'",
    },
    {
      name: 'Classic rules that would discard the AI level',
      mutate: (manifest: HyperionNativeManifest) => {
        manifest.hyperion.compatibility.rules = 'classic'
      },
      message: 'hyperion.ai requires Hyperion rules so the AI level is retained in replays',
    },
    {
      name: 'an AI credential in the authenticated roster',
      mutate: (manifest: HyperionNativeManifest) => {
        manifest.roster.push({ slot: 2, userId: makeSbUserId(999), homeRelayId: 7 })
      },
      message: 'roster and hyperion.slots must contain the same authenticated humans',
    },
  ])('rejects $name', ({ mutate, message }) => {
    const manifest = makePlutoManifest()
    mutate(manifest)

    expectViolation(manifest, message)
  })

  it('rejects an AI object on a canonical human-only formation', () => {
    const manifest = makeValidManifest()
    manifest.hyperion.ai = structuredClone(makePlutoManifest().hyperion.ai)

    expectViolation(manifest, 'hyperion.ai is supported only for custom Melee and Free for all')
  })

  it('returns an error rather than throwing for a non-object input', () => {
    expect(validateHyperionManifest(null)).toEqual(['manifest must be an object'])
  })

  const invalidCases: Array<{
    name: string
    mutate: (manifest: any) => void
    message: string
  }> = [
    {
      name: 'protocol',
      mutate: m => {
        m.hyperion.protocol = 2
      },
      message: 'hyperion.protocol must be 1',
    },
    {
      name: 'game type',
      mutate: m => {
        m.hyperion.gameType = GameType.TeamMelee
      },
      message: "hyperion.gameType must be 'oneVOne', 'topVBottom', 'melee', or 'freeForAll'",
    },
    {
      name: 'game subtype',
      mutate: m => {
        m.hyperion.gameSubType = 1
      },
      message: 'hyperion.gameSubType must be 0 for 1v1/Melee or 2/3 for team play',
    },
    {
      name: 'negative seed',
      mutate: m => {
        m.hyperion.seed = -1
      },
      message: 'hyperion.seed must be an unsigned 32-bit integer',
    },
    {
      name: 'seed above uint32',
      mutate: m => {
        m.hyperion.seed = 0x100000000
      },
      message: 'hyperion.seed must be an unsigned 32-bit integer',
    },
    {
      name: 'fractional seed',
      mutate: m => {
        m.hyperion.seed = 1.5
      },
      message: 'hyperion.seed must be an unsigned 32-bit integer',
    },
    {
      name: 'negative speed',
      mutate: m => {
        m.hyperion.speed = -1
      },
      message: 'hyperion.speed must be an integer from 0 through 6',
    },
    {
      name: 'speed above 6',
      mutate: m => {
        m.hyperion.speed = 7
      },
      message: 'hyperion.speed must be an integer from 0 through 6',
    },
    {
      name: 'fractional speed',
      mutate: m => {
        m.hyperion.speed = 5.5
      },
      message: 'hyperion.speed must be an integer from 0 through 6',
    },
    {
      name: 'alliance changes enabled',
      mutate: m => {
        m.hyperion.disableAllianceChanges = false
      },
      message: 'hyperion.disableAllianceChanges must be true',
    },
    {
      name: 'slot count',
      mutate: m => {
        m.hyperion.slots.pop()
      },
      message: 'hyperion.slots must contain exactly 2 entries',
    },
    {
      name: 'missing host',
      mutate: m => {
        m.hyperion.slots[0].host = false
      },
      message: 'hyperion.slots must contain exactly one host',
    },
    {
      name: 'multiple hosts',
      mutate: m => {
        m.hyperion.slots[1].host = true
      },
      message: 'hyperion.slots must contain exactly one host',
    },
    {
      name: 'host outside rpSlot 0',
      mutate: m => {
        m.hyperion.slots[0].host = false
        m.hyperion.slots[1].host = true
      },
      message: 'hyperion.slots host must have rpSlot 0',
    },
    {
      name: 'local user outside the slots',
      mutate: m => {
        m.hyperion.localUserId = 999
      },
      message: 'hyperion.localUserId must belong to one of hyperion.slots',
    },
    {
      name: 'zero local user ID',
      mutate: m => {
        m.hyperion.localUserId = 0
      },
      message: 'hyperion.localUserId must be positive',
    },
    {
      name: 'zero slot user ID',
      mutate: m => {
        m.hyperion.slots[1].userId = 0
      },
      message: 'hyperion.slots[1].userId must be positive',
    },
    {
      name: 'duplicate user IDs',
      mutate: m => {
        m.hyperion.slots[1].userId = m.hyperion.slots[0].userId
      },
      message: 'hyperion.slots userId values must be unique',
    },
    {
      name: 'duplicate rpSlots',
      mutate: m => {
        m.hyperion.slots[1].rpSlot = m.hyperion.slots[0].rpSlot
      },
      message: 'hyperion.slots rpSlot values must be unique',
    },
    {
      name: 'duplicate storm IDs',
      mutate: m => {
        m.hyperion.slots[1].stormId = m.hyperion.slots[0].stormId
      },
      message: 'hyperion.slots stormId values must be unique',
    },
    {
      name: 'duplicate BW player IDs',
      mutate: m => {
        m.hyperion.slots[1].bwPlayerId = m.hyperion.slots[0].bwPlayerId
      },
      message: 'hyperion.slots bwPlayerId values must be unique',
    },
    {
      name: 'rpSlot outside the MVP range',
      mutate: m => {
        m.hyperion.slots[1].rpSlot = 2
      },
      message: 'hyperion.slots[1].rpSlot must be between 0 and 1',
    },
    {
      name: 'mismatched slot identifiers',
      mutate: m => {
        m.hyperion.slots[0].stormId = 1
      },
      message: 'hyperion.slots[0] rpSlot, stormId, and bwPlayerId must be equal',
    },
    {
      name: 'empty player name',
      mutate: m => {
        m.hyperion.slots[0].name = ''
      },
      message:
        'hyperion.slots[0].name must be a non-empty string of at most 24 UTF-8 bytes without NULs',
    },
    {
      name: 'player name over 24 characters',
      mutate: m => {
        m.hyperion.slots[0].name = 'n'.repeat(25)
      },
      message:
        'hyperion.slots[0].name must be a non-empty string of at most 24 UTF-8 bytes without NULs',
    },
    {
      name: 'player name over 24 UTF-8 bytes',
      mutate: m => {
        m.hyperion.slots[0].name = '한'.repeat(9)
      },
      message:
        'hyperion.slots[0].name must be a non-empty string of at most 24 UTF-8 bytes without NULs',
    },
    {
      name: 'player name with a NUL',
      mutate: m => {
        m.hyperion.slots[0].name = 'Host\0Player'
      },
      message:
        'hyperion.slots[0].name must be a non-empty string of at most 24 UTF-8 bytes without NULs',
    },
    {
      name: 'empty game name',
      mutate: m => {
        m.hyperion.name = ''
      },
      message: 'hyperion.name must be a non-empty string of at most 24 UTF-8 bytes without NULs',
    },
    {
      name: 'game name over 24 characters',
      mutate: m => {
        m.hyperion.name = 'g'.repeat(25)
      },
      message: 'hyperion.name must be a non-empty string of at most 24 UTF-8 bytes without NULs',
    },
    {
      name: 'invalid race',
      mutate: m => {
        m.hyperion.slots[0].race = 'x'
      },
      message: 'hyperion.slots[0].race must be one of z, t, p, or r',
    },
    {
      name: 'map format',
      mutate: m => {
        m.hyperion.map.format = 'rep'
      },
      message: "hyperion.map.format must be 'scm' or 'scx'",
    },
    {
      name: 'uppercase map hash',
      mutate: m => {
        m.hyperion.map.hash = 'A'.repeat(64)
      },
      message: 'hyperion.map.hash must be exactly 64 lowercase hexadecimal characters',
    },
    {
      name: 'short map hash',
      mutate: m => {
        m.hyperion.map.hash = 'a'.repeat(63)
      },
      message: 'hyperion.map.hash must be exactly 64 lowercase hexadecimal characters',
    },
    {
      name: 'empty map path',
      mutate: m => {
        m.hyperion.map.path = ''
      },
      message: 'hyperion.map.path must be a non-empty string',
    },
    {
      name: 'adapter protocol',
      mutate: m => {
        m.hyperion.compatibility.adapterProtocol = 2
      },
      message: 'hyperion.compatibility.adapterProtocol must be 1',
    },
    {
      name: 'empty engine build',
      mutate: m => {
        m.hyperion.compatibility.engineBuild = ''
      },
      message: 'hyperion.compatibility.engineBuild must be a non-empty string',
    },
    {
      name: 'rules',
      mutate: m => {
        m.hyperion.compatibility.rules = 'modern'
      },
      message: "hyperion.compatibility.rules must be 'classic' or 'hyperion'",
    },
    {
      name: 'non-string mod ID',
      mutate: m => {
        m.hyperion.compatibility.modId = null as unknown as string
      },
      message: 'hyperion.compatibility.modId must be a string',
    },
    {
      name: 'uppercase mod fingerprint',
      mutate: m => {
        m.hyperion.compatibility.modFingerprint = 'B'.repeat(40)
      },
      message:
        'hyperion.compatibility.modFingerprint must be exactly 40 lowercase hexadecimal characters',
    },
    {
      name: 'short mod fingerprint',
      mutate: m => {
        m.hyperion.compatibility.modFingerprint = 'b'.repeat(39)
      },
      message:
        'hyperion.compatibility.modFingerprint must be exactly 40 lowercase hexadecimal characters',
    },
    {
      name: 'non-hex data fingerprint',
      mutate: m => {
        m.hyperion.compatibility.dataFingerprint = 'gggggggg'
      },
      message: 'hyperion.compatibility.dataFingerprint must be exactly 8 hexadecimal characters',
    },
    {
      name: 'long data fingerprint',
      mutate: m => {
        m.hyperion.compatibility.dataFingerprint = '0123abcd0'
      },
      message: 'hyperion.compatibility.dataFingerprint must be exactly 8 hexadecimal characters',
    },
    {
      name: 'compatibility rollback',
      mutate: m => {
        m.hyperion.compatibility.rollback = true
      },
      message: 'hyperion.compatibility.rollback must be false',
    },
    {
      name: 'netcode rollback',
      mutate: m => {
        m.rollback = true
      },
      message: 'rollback must be false for the Hyperion lockstep protocol',
    },
    {
      name: 'empty token',
      mutate: m => {
        m.token = ''
      },
      message: 'token must be a non-empty string',
    },
    {
      name: 'empty private key',
      mutate: m => {
        m.clientPrivateKey = ''
      },
      message: 'clientPrivateKey must be a non-empty string',
    },
    {
      name: 'roster mismatch',
      mutate: m => {
        m.roster[0].userId = 999
      },
      message: 'hyperion.slots[0] must match the netcode roster slot and user ID',
    },
  ]

  it.each(invalidCases)('rejects $name', ({ mutate, message }) => {
    const manifest = makeValidManifest()
    mutate(manifest)

    expectViolation(manifest, message)
  })

  it('never includes token or private key values in validation errors', () => {
    const manifest = makeValidManifest()
    ;(manifest as any).hyperion.protocol = 2

    const messages = validateHyperionManifest(manifest).join('\n')
    expect(messages).not.toContain(TOKEN)
    expect(messages).not.toContain(PRIVATE_KEY)
  })
})
