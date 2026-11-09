import { describe, expect, it } from 'vitest'
import { makeGameServerRegionId } from '../../../common/game-server-regions'
import { GameSetup, PlayerInfo } from '../../../common/games/game-launch-config'
import { GameType } from '../../../common/games/game-type'
import { NetcodeV2Setup } from '../../../common/games/netcode-v2'
import { SlotType } from '../../../common/lobbies/slot'
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
  simRevision: 22,
  rules: 'classic',
  modId: 'hyperion-classic',
  modFingerprint: 'b'.repeat(40),
  dataFingerprint: '0123abcd',
  rollback: false,
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

  it('rejects game types other than GameType.OneVsOne', () => {
    const setup = makeGameSetup()
    setup.gameType = GameType.Melee

    expect(() =>
      makeHyperionManifest(setup, makeNetcodeSetup(), MAP_PATH, COMPATIBILITY, HOST_USER_ID),
    ).toThrow('Hyperion manifests support only GameType.OneVsOne')
  })

  it('rejects a setup that permits alliance changes', () => {
    const setup = makeGameSetup()
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
        m.hyperion.gameType = GameType.Melee
      },
      message: "hyperion.gameType must be 'oneVOne' or 'topVBottom'",
    },
    {
      name: 'game subtype',
      mutate: m => {
        m.hyperion.gameSubType = 1
      },
      message: 'hyperion.gameSubType must be 0 for 1v1 or 2/3 for team play',
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
      name: 'simulation revision',
      mutate: m => {
        m.hyperion.compatibility.simRevision = 21
      },
      message: 'hyperion.compatibility.simRevision must be 22',
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
