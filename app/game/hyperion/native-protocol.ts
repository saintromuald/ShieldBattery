import { HYPERION_NATIVE_FEATURES, HyperionNativeFeature } from '../../../common/games/backend'
import { GameSetup } from '../../../common/games/game-launch-config'
import { GameType } from '../../../common/games/game-type'
import { NetcodeV2Setup } from '../../../common/games/netcode-v2'
import { SlotType } from '../../../common/lobbies/slot'
import { RaceChar } from '../../../common/races'
import { SbUserId } from '../../../common/users/sb-user-id'

const UINT32_MAX = 0xffffffff
const MAP_HASH_PATTERN = /^[0-9a-f]{64}$/
const MOD_FINGERPRINT_PATTERN = /^[0-9a-f]{40}$/
const DATA_FINGERPRINT_PATTERN = /^[0-9a-f]{8}$/i
const VALID_RACES: ReadonlySet<string> = new Set(['z', 't', 'p', 'r'])

export interface HyperionManifestSlot {
  rpSlot: number
  stormId: number
  bwPlayerId: number
  userId: SbUserId
  teamId: number
  name: string
  race: RaceChar
  host: boolean
}

export interface HyperionManifestAiSlot {
  stormId: number
  bwPlayerId: number
  name: 'Pluto'
  race: RaceChar
  level: 'pluto'
}

export interface HyperionManifestAi {
  /** The authenticated human's relay slot whose process owns Pluto inference. */
  ownerRpSlot: number
  slots: HyperionManifestAiSlot[]
}

export interface HyperionManifestMap {
  format: 'scm' | 'scx'
  hash: string
  path: string
}

export type HyperionRuleSet = 'classic' | 'hyperion'

export interface HyperionRuleConfiguration {
  ruleSet: HyperionRuleSet
  /** Enables Rule 2's seeded anti-meta starting state. */
  antiMeta: boolean
}

export interface HyperionCompatibility {
  adapterProtocol: 1
  engineBuild: string
  simRevision: 23
  rules: HyperionRuleSet
  modId: string
  modFingerprint: string
  dataFingerprint: string
  rollback: false
  /** Optional native capabilities explicitly reported by this exact engine build. */
  features?: HyperionNativeFeature[]
}

export function parseHyperionCompatibility(value: unknown): HyperionCompatibility {
  const errors: string[] = []
  validateCompatibility(value, errors)
  if (errors.length > 0) {
    throw new Error(`Invalid Hyperion compatibility: ${errors.join('; ')}`)
  }
  return { ...(value as HyperionCompatibility) }
}

export interface HyperionGameManifest {
  protocol: 1
  gameId: string
  name: string
  gameType: 'oneVOne' | 'topVBottom' | 'melee' | 'freeForAll'
  gameSubType: number
  /** An unsigned 32-bit simulation seed. */
  seed: number
  /** StarCraft game speed, from slowest (0) through fastest (6). */
  speed: number
  disableAllianceChanges: true
  localUserId: SbUserId
  /** Authenticated human participants only; computers are described separately by `ai`. */
  slots: HyperionManifestSlot[]
  ai?: HyperionManifestAi
  map: HyperionManifestMap
  compatibility: HyperionCompatibility
  /** Rule 2's seeded anti-meta start; no other mutator is accepted. */
  mutators?: { antiMeta: 1 }
}

function nativeName(value: string, fallback: string): string {
  return value.length > 0 && Buffer.byteLength(value, 'utf8') <= 24 ? value : fallback
}

const UPSTREAM_GAME_NAMES: ReadonlySet<string> = new Set([
  'ShieldBattery Matchmaking',
  'ShieldBattery Lobby',
])

function nativeGameName(value: string): string {
  return UPSTREAM_GAME_NAMES.has(value)
    ? 'HyperShield match'
    : nativeName(value, 'HyperShield match')
}

function expectedPlayerCount(gameType: GameType, gameSubType: number): number | undefined {
  if (gameType === GameType.OneVsOne) {
    return gameSubType === 0 ? 2 : undefined
  }
  if (gameType === GameType.TopVsBottom) {
    if (gameSubType === 2) {
      return 4
    }
    if (gameSubType === 3) {
      return 6
    }
  }
  return undefined
}

function isCustomMelee(gameType: GameType): boolean {
  return gameType === GameType.Melee || gameType === GameType.FreeForAll
}

function nativeGameType(gameType: GameType): HyperionGameManifest['gameType'] {
  if (gameType === GameType.FreeForAll) return 'freeForAll'
  return gameType as HyperionGameManifest['gameType']
}

/** The netcode launch handoff with the additional settings consumed by the native adapter. */
export interface HyperionNativeManifest extends NetcodeV2Setup {
  /** Unlike the optional netcode handoff field, the serialized manifest always includes this. */
  rollback: boolean
  hyperion: HyperionGameManifest
}

/** Returns the formation's stable Pluto owner, retaining the host fallback for older setups. */
export function plutoInferenceOwnerUserId(setup: GameSetup): SbUserId | undefined {
  return setup.plutoOwnerUserId ?? setup.host.userId
}

/**
 * Builds a canonical team lockstep manifest, or a custom Melee/FFA manifest with one Pluto AI.
 *
 * `localUserId` should be supplied from the launch config's local user. It can be omitted only
 * when the personalized netcode roster identifies its recipient with exactly one `homeRegion`.
 * The default configuration uses Hyperion engine QoL with an ordinary starting state.
 */
export function makeHyperionManifest(
  setup: GameSetup,
  netcodeSetup: NetcodeV2Setup,
  mapPath: string,
  compatibility: HyperionCompatibility,
  localUserId?: SbUserId,
  ruleConfiguration: HyperionRuleConfiguration = { ruleSet: 'hyperion', antiMeta: false },
): HyperionNativeManifest {
  const customMelee = isCustomMelee(setup.gameType)
  if (
    setup.gameType !== GameType.OneVsOne &&
    setup.gameType !== GameType.TopVsBottom &&
    !customMelee
  ) {
    throw new Error('Hyperion manifests support only canonical teams and custom Melee/Free for all')
  }
  const expectedPlayers = expectedPlayerCount(setup.gameType, setup.gameSubType)
  if (
    (setup.gameType === GameType.OneVsOne && setup.gameSubType !== 0) ||
    (setup.gameType === GameType.TopVsBottom && ![2, 3].includes(setup.gameSubType)) ||
    (customMelee && setup.gameSubType !== 0)
  ) {
    throw new Error(
      'Hyperion team manifests require 2v2 or 3v3; 1v1 and custom Melee require gameSubType 0',
    )
  }
  if (!setup.disableAllianceChanges) {
    throw new Error('Hyperion manifests require alliance changes to be disabled')
  }
  if (!('mapData' in setup.map)) {
    throw new Error('Hyperion manifests require map information, not a replay')
  }

  const humanPlayers = setup.slots.filter(player => player.type === SlotType.Human)
  const computerPlayers = setup.slots.filter(player => player.type === SlotType.Computer)
  const unoccupiedPlayers = setup.slots.filter(
    player => player.type === SlotType.Open || player.type === SlotType.Closed,
  )
  const accountedSlotCount =
    humanPlayers.length + computerPlayers.length + (customMelee ? unoccupiedPlayers.length : 0)
  if (accountedSlotCount !== setup.slots.length) {
    throw new Error(
      customMelee
        ? 'Hyperion custom Melee accepts humans, one Pluto computer, and unoccupied seats'
        : 'Hyperion GameSetup slots must contain only humans and an optional computer',
    )
  }
  if (unoccupiedPlayers.some(player => player.ai !== undefined)) {
    throw new Error('Hyperion AI profiles belong only to computer slots')
  }
  if (customMelee) {
    if (
      computerPlayers.length !== 1 ||
      computerPlayers[0].ai?.level !== 'pluto' ||
      humanPlayers.length < 2
    ) {
      throw new Error(
        'Hyperion custom Melee manifests require at least two humans and exactly one Pluto computer',
      )
    }
  } else if (computerPlayers.length > 0 || setup.slots.length !== expectedPlayers) {
    throw new Error(`Hyperion manifests require exactly ${expectedPlayers} human GameSetup slots`)
  }
  if (humanPlayers.some(player => player.ai !== undefined)) {
    throw new Error('Hyperion AI profiles belong only to computer slots')
  }
  if (!customMelee && setup.plutoOwnerUserId !== undefined) {
    throw new Error('Hyperion Pluto inference owners require a Pluto computer')
  }

  const resolvedLocalUserId = resolveLocalUserId(netcodeSetup, localUserId)
  const players = humanPlayers.map(player => [player.userId, player] as const)
  if (players.some(([userId]) => userId === undefined)) {
    throw new Error('Hyperion human GameSetup slots must all have user IDs')
  }
  const playerByUserId = new Map(players)
  if (playerByUserId.size !== humanPlayers.length) {
    throw new Error('Hyperion GameSetup slots must have unique user IDs')
  }
  const userById = new Map(setup.users.map(user => [user.id, user]))

  const slots = netcodeSetup.roster
    .map((rosterEntry, index) => {
      const player = playerByUserId.get(rosterEntry.userId)
      const user = userById.get(rosterEntry.userId)
      if (!player || !user) {
        throw new Error('Hyperion netcode roster entries must match GameSetup slots and users')
      }
      if (player.race === undefined) {
        throw new Error('Hyperion GameSetup slots must have races')
      }
      if (setup.gameType === GameType.TopVsBottom && player.teamId === undefined) {
        throw new Error('Hyperion team slots must have team IDs')
      }
      let teamId = index
      if (setup.gameType === GameType.TopVsBottom) {
        teamId = player.teamId!
      } else if (customMelee) {
        teamId = 0
      }

      return {
        rpSlot: rosterEntry.slot,
        stormId: rosterEntry.slot,
        bwPlayerId: rosterEntry.slot,
        userId: rosterEntry.userId,
        teamId,
        name: nativeName(user.name, `Player ${rosterEntry.userId}`),
        race: player.race,
        host: setup.host.userId === rosterEntry.userId,
      }
    })
    .sort((a, b) => a.rpSlot - b.rpSlot)

  let ai: HyperionManifestAi | undefined
  if (customMelee) {
    const computer = computerPlayers[0]
    const ownerUserId = plutoInferenceOwnerUserId(setup)
    const owner = slots.find(slot => slot.userId === ownerUserId)
    if (!owner) {
      throw new Error('Hyperion Pluto inference requires an authenticated human owner')
    }
    if (computer.race === undefined) {
      throw new Error('Hyperion Pluto computers must have a race')
    }
    ai = {
      ownerRpSlot: owner.rpSlot,
      slots: [
        {
          stormId: slots.length,
          bwPlayerId: slots.length,
          name: 'Pluto',
          race: computer.race,
          level: 'pluto',
        },
      ],
    }
  }

  const manifest: HyperionNativeManifest = {
    token: netcodeSetup.token,
    clientPrivateKey: netcodeSetup.clientPrivateKey,
    homeRelay: {
      ...netcodeSetup.homeRelay,
      addrs: [...netcodeSetup.homeRelay.addrs],
    },
    roster: netcodeSetup.roster.map(entry => ({ ...entry })),
    initialBufferTurns: netcodeSetup.initialBufferTurns,
    ...(netcodeSetup.clientPubkey !== undefined ? { clientPubkey: netcodeSetup.clientPubkey } : {}),
    rollback: netcodeSetup.rollback ?? false,
    hyperion: {
      protocol: 1,
      gameId: setup.gameId,
      name: nativeGameName(setup.name),
      gameType: nativeGameType(setup.gameType),
      gameSubType: setup.gameSubType,
      seed: setup.seed,
      speed: 6,
      disableAllianceChanges: true,
      localUserId: resolvedLocalUserId,
      slots,
      ...(ai ? { ai } : {}),
      map: {
        format: setup.map.mapData.format,
        hash: setup.map.hash,
        path: mapPath,
      },
      compatibility: { ...compatibility, rules: ruleConfiguration.ruleSet },
      ...(ruleConfiguration.antiMeta ? { mutators: { antiMeta: 1 as const } } : {}),
    },
  }

  const errors = validateHyperionManifest(manifest)
  if (errors.length > 0) {
    throw new Error(`Invalid Hyperion manifest: ${errors.join('; ')}`)
  }
  return manifest
}

function resolveLocalUserId(
  netcodeSetup: NetcodeV2Setup,
  localUserId: SbUserId | undefined,
): SbUserId {
  if (localUserId !== undefined) {
    return localUserId
  }

  const localEntries = netcodeSetup.roster.filter(entry => entry.homeRegion !== undefined)
  if (localEntries.length === 1) {
    return localEntries[0].userId
  }
  throw new Error(
    'Hyperion localUserId is required unless exactly one netcode roster entry has homeRegion',
  )
}

/** Returns every schema or cross-field violation, without including field values in the messages. */
export function validateHyperionManifest(manifest: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(manifest)) {
    return ['manifest must be an object']
  }

  validateNonEmptyString(manifest.token, 'token', errors)
  validateNonEmptyString(manifest.clientPrivateKey, 'clientPrivateKey', errors)
  if (manifest.clientPubkey !== undefined) {
    validateNonEmptyString(manifest.clientPubkey, 'clientPubkey', errors)
  }
  validateHomeRelay(manifest.homeRelay, errors)
  if (!isUint32(manifest.initialBufferTurns)) {
    errors.push('initialBufferTurns must be an unsigned 32-bit integer')
  }
  if (manifest.rollback !== false) {
    errors.push('rollback must be false for the Hyperion lockstep protocol')
  }

  if (!isRecord(manifest.hyperion)) {
    errors.push('hyperion must be an object')
    return errors
  }
  const hyperion = manifest.hyperion

  if (hyperion.protocol !== 1) {
    errors.push('hyperion.protocol must be 1')
  }
  validateNonEmptyString(hyperion.gameId, 'hyperion.gameId', errors)
  validateName(hyperion.name, 'hyperion.name', errors)
  const customMelee = hyperion.gameType === 'melee' || hyperion.gameType === 'freeForAll'
  const gameType =
    hyperion.gameType === 'freeForAll' ? GameType.FreeForAll : (hyperion.gameType as GameType)
  if (
    hyperion.gameType !== GameType.OneVsOne &&
    hyperion.gameType !== GameType.TopVsBottom &&
    !customMelee
  ) {
    errors.push("hyperion.gameType must be 'oneVOne', 'topVBottom', 'melee', or 'freeForAll'")
  }
  const expectedPlayers = expectedPlayerCount(gameType, hyperion.gameSubType as number)
  if (
    (!customMelee && expectedPlayers === undefined) ||
    (customMelee && hyperion.gameSubType !== 0)
  ) {
    errors.push('hyperion.gameSubType must be 0 for 1v1/Melee or 2/3 for team play')
  }
  validateRoster(manifest.roster, errors, customMelee ? undefined : expectedPlayers)
  if (!isUint32(hyperion.seed)) {
    errors.push('hyperion.seed must be an unsigned 32-bit integer')
  }
  if (
    !Number.isInteger(hyperion.speed) ||
    (hyperion.speed as number) < 0 ||
    (hyperion.speed as number) > 6
  ) {
    errors.push('hyperion.speed must be an integer from 0 through 6')
  }
  if (hyperion.disableAllianceChanges !== true) {
    errors.push('hyperion.disableAllianceChanges must be true')
  }
  if (!isUint32(hyperion.localUserId)) {
    errors.push('hyperion.localUserId must be an unsigned 32-bit integer')
  } else if (hyperion.localUserId === 0) {
    errors.push('hyperion.localUserId must be positive')
  }

  validateSlots(
    hyperion.slots,
    hyperion.localUserId,
    customMelee ? undefined : expectedPlayers,
    gameType,
    errors,
  )
  validateMap(hyperion.map, errors)
  validateCompatibility(hyperion.compatibility, errors)
  validateRuleConfiguration(hyperion as unknown as HyperionGameManifest, errors)
  validateAi(hyperion.ai, hyperion.slots, customMelee, hyperion.compatibility, errors)
  validateRosterMatchesSlots(manifest.roster, hyperion.slots, errors)

  return errors
}

function validateHomeRelay(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('homeRelay must be an object')
    return
  }
  if (!isNonNegativeSafeInteger(value.relayId)) {
    errors.push('homeRelay.relayId must be a non-negative safe integer')
  }
  if (
    !Array.isArray(value.addrs) ||
    value.addrs.length === 0 ||
    value.addrs.some(address => !isNonEmptyString(address))
  ) {
    errors.push('homeRelay.addrs must contain at least one non-empty string')
  }
  validateNonEmptyString(value.serverName, 'homeRelay.serverName', errors)
  validateNonEmptyString(value.cert, 'homeRelay.cert', errors)
}

function validateRoster(value: unknown, errors: string[], expectedPlayers?: number): void {
  if (!Array.isArray(value)) {
    errors.push('roster must be an array')
    return
  }
  if (expectedPlayers !== undefined && value.length !== expectedPlayers) {
    errors.push(`roster must contain exactly ${expectedPlayers} entries`)
  }
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      errors.push(`roster[${index}] must be an object`)
      continue
    }
    if (!isUint32(entry.slot)) {
      errors.push(`roster[${index}].slot must be an unsigned 32-bit integer`)
    }
    if (!isUint32(entry.userId)) {
      errors.push(`roster[${index}].userId must be an unsigned 32-bit integer`)
    }
    if (!isNonNegativeSafeInteger(entry.homeRelayId)) {
      errors.push(`roster[${index}].homeRelayId must be a non-negative safe integer`)
    }
    if (entry.homeRegion !== undefined && !isNonEmptyString(entry.homeRegion)) {
      errors.push(`roster[${index}].homeRegion must be a non-empty string when present`)
    }
  }
}

function validateSlots(
  value: unknown,
  localUserId: unknown,
  expectedPlayers: number | undefined,
  gameType: GameType,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push('hyperion.slots must be an array')
    return
  }
  if (expectedPlayers !== undefined && value.length !== expectedPlayers) {
    errors.push(`hyperion.slots must contain exactly ${expectedPlayers} entries`)
  }
  if (isCustomMelee(gameType) && (value.length < 2 || value.length > 7)) {
    errors.push('hyperion.slots must contain 2 through 7 authenticated humans for Pluto Melee')
  }

  const validSlots = value.filter(isRecord)
  for (const [index, slot] of value.entries()) {
    if (!isRecord(slot)) {
      errors.push(`hyperion.slots[${index}] must be an object`)
      continue
    }

    for (const field of ['rpSlot', 'stormId', 'bwPlayerId', 'userId', 'teamId'] as const) {
      if (!isUint32(slot[field])) {
        errors.push(`hyperion.slots[${index}].${field} must be an unsigned 32-bit integer`)
      }
    }
    if (isUint32(slot.rpSlot) && isUint32(slot.teamId)) {
      let expectedTeam: number | undefined
      if (isCustomMelee(gameType)) {
        expectedTeam = 0
      } else if (expectedPlayers !== undefined) {
        const teamSize = gameType === GameType.TopVsBottom ? expectedPlayers / 2 : 1
        expectedTeam = Math.floor(slot.rpSlot / teamSize)
      }
      if (expectedTeam !== undefined && slot.teamId !== expectedTeam) {
        errors.push(`hyperion.slots[${index}].teamId does not match the canonical team layout`)
      }
    }
    if (isUint32(slot.userId) && slot.userId === 0) {
      errors.push(`hyperion.slots[${index}].userId must be positive`)
    }
    for (const field of ['rpSlot', 'stormId', 'bwPlayerId'] as const) {
      const upperBound = expectedPlayers ?? 8
      if (isUint32(slot[field]) && slot[field] >= upperBound) {
        errors.push(`hyperion.slots[${index}].${field} must be between 0 and ${upperBound - 1}`)
      }
      if (isUint32(slot[field]) && slot[field] !== index) {
        errors.push(`hyperion.slots[${index}].${field} must equal its contiguous slot index`)
      }
    }
    if (
      isUint32(slot.rpSlot) &&
      isUint32(slot.stormId) &&
      isUint32(slot.bwPlayerId) &&
      (slot.rpSlot !== slot.stormId || slot.rpSlot !== slot.bwPlayerId)
    ) {
      errors.push(`hyperion.slots[${index}] rpSlot, stormId, and bwPlayerId must be equal`)
    }

    validateName(slot.name, `hyperion.slots[${index}].name`, errors)
    if (typeof slot.race !== 'string' || !VALID_RACES.has(slot.race)) {
      errors.push(`hyperion.slots[${index}].race must be one of z, t, p, or r`)
    }
    if (typeof slot.host !== 'boolean') {
      errors.push(`hyperion.slots[${index}].host must be a boolean`)
    }
  }

  for (const field of ['userId', 'rpSlot', 'stormId', 'bwPlayerId'] as const) {
    const seen = new Set<unknown>()
    for (const slot of validSlots) {
      if (seen.has(slot[field])) {
        errors.push(`hyperion.slots ${field} values must be unique`)
        break
      }
      seen.add(slot[field])
    }
  }

  const hosts = validSlots.filter(slot => slot.host === true)
  if (hosts.length !== 1) {
    errors.push('hyperion.slots must contain exactly one host')
  }
  if (hosts.some(slot => slot.rpSlot !== 0)) {
    errors.push('hyperion.slots host must have rpSlot 0')
  }
  const slotZero = validSlots.find(slot => slot.rpSlot === 0)
  if (slotZero && slotZero.host !== true) {
    errors.push('hyperion.slots rpSlot 0 must be the host')
  }

  if (
    isUint32(localUserId) &&
    validSlots.length > 0 &&
    !validSlots.some(slot => slot.userId === localUserId)
  ) {
    errors.push('hyperion.localUserId must belong to one of hyperion.slots')
  }
}

function validateAi(
  value: unknown,
  humanSlots: unknown,
  customMelee: boolean,
  compatibility: unknown,
  errors: string[],
): void {
  if (value === undefined) {
    if (customMelee) {
      errors.push('hyperion.ai must contain exactly one Pluto computer for custom Melee')
    }
    return
  }
  if (!customMelee) {
    errors.push('hyperion.ai is supported only for custom Melee and Free for all')
  }
  if (!isRecord(value)) {
    errors.push('hyperion.ai must be an object')
    return
  }
  if (!isUint32(value.ownerRpSlot)) {
    errors.push('hyperion.ai.ownerRpSlot must be an unsigned 32-bit integer')
  } else if (
    !Array.isArray(humanSlots) ||
    !humanSlots.some(slot => isRecord(slot) && slot.rpSlot === value.ownerRpSlot)
  ) {
    errors.push('hyperion.ai.ownerRpSlot must identify an authenticated human slot')
  }

  if (!Array.isArray(value.slots) || value.slots.length !== 1) {
    errors.push('hyperion.ai.slots must contain exactly one Pluto computer')
    return
  }
  const computer = value.slots[0]
  if (!isRecord(computer)) {
    errors.push('hyperion.ai.slots[0] must be an object')
    return
  }
  for (const field of ['stormId', 'bwPlayerId'] as const) {
    if (!isUint32(computer[field])) {
      errors.push(`hyperion.ai.slots[0].${field} must be an unsigned 32-bit integer`)
    }
  }
  const firstFreeSlot = Array.isArray(humanSlots) ? humanSlots.length : -1
  if (
    firstFreeSlot < 0 ||
    firstFreeSlot >= 8 ||
    computer.stormId !== firstFreeSlot ||
    computer.bwPlayerId !== firstFreeSlot
  ) {
    errors.push('hyperion.ai.slots[0] must occupy the first free classic slot below 8')
  }
  if (computer.name !== 'Pluto') {
    errors.push("hyperion.ai.slots[0].name must be 'Pluto'")
  }
  if (typeof computer.race !== 'string' || !VALID_RACES.has(computer.race)) {
    errors.push('hyperion.ai.slots[0].race must be one of z, t, p, or r')
  }
  if (computer.level !== 'pluto') {
    errors.push("hyperion.ai.slots[0].level must be 'pluto'")
  }
  if (isRecord(compatibility) && compatibility.rules !== 'hyperion') {
    errors.push('hyperion.ai requires Hyperion rules so the AI level is retained in replays')
  }
  if (
    isRecord(compatibility) &&
    (!Array.isArray(compatibility.features) || !compatibility.features.includes('plutoComputer'))
  ) {
    errors.push('hyperion.ai requires explicit plutoComputer engine compatibility')
  }
}

function validateMap(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('hyperion.map must be an object')
    return
  }
  if (value.format !== 'scm' && value.format !== 'scx') {
    errors.push("hyperion.map.format must be 'scm' or 'scx'")
  }
  if (typeof value.hash !== 'string' || !MAP_HASH_PATTERN.test(value.hash)) {
    errors.push('hyperion.map.hash must be exactly 64 lowercase hexadecimal characters')
  }
  validateNonEmptyString(value.path, 'hyperion.map.path', errors)
}

function validateCompatibility(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('hyperion.compatibility must be an object')
    return
  }
  if (value.adapterProtocol !== 1) {
    errors.push('hyperion.compatibility.adapterProtocol must be 1')
  }
  validateNonEmptyString(value.engineBuild, 'hyperion.compatibility.engineBuild', errors)
  if (value.simRevision !== 23) {
    errors.push('hyperion.compatibility.simRevision must be 23')
  }
  if (value.rules !== 'classic' && value.rules !== 'hyperion') {
    errors.push("hyperion.compatibility.rules must be 'classic' or 'hyperion'")
  }
  // The built-in Brood War data has no mod id; its fingerprint still identifies it exactly.
  if (typeof value.modId !== 'string') {
    errors.push('hyperion.compatibility.modId must be a string')
  }
  if (
    typeof value.modFingerprint !== 'string' ||
    !MOD_FINGERPRINT_PATTERN.test(value.modFingerprint)
  ) {
    errors.push(
      'hyperion.compatibility.modFingerprint must be exactly 40 lowercase hexadecimal characters',
    )
  }
  if (
    typeof value.dataFingerprint !== 'string' ||
    !DATA_FINGERPRINT_PATTERN.test(value.dataFingerprint)
  ) {
    errors.push('hyperion.compatibility.dataFingerprint must be exactly 8 hexadecimal characters')
  }
  if (value.rollback !== false) {
    errors.push('hyperion.compatibility.rollback must be false')
  }
  if (
    value.features !== undefined &&
    (!Array.isArray(value.features) ||
      value.features.some(
        feature =>
          typeof feature !== 'string' ||
          !(HYPERION_NATIVE_FEATURES as readonly string[]).includes(feature),
      ) ||
      new Set(value.features).size !== value.features.length)
  ) {
    errors.push('hyperion.compatibility.features must contain unique known native features')
  }
}

function validateRuleConfiguration(value: HyperionGameManifest, errors: string[]): void {
  if (value.compatibility.rules === 'classic') {
    if (value.mutators !== undefined) {
      errors.push('hyperion.mutators must be absent for classic rules')
    }
  } else if (
    value.compatibility.rules === 'hyperion' &&
    value.mutators !== undefined &&
    (!isRecord(value.mutators) ||
      Object.keys(value.mutators).length !== 1 ||
      value.mutators.antiMeta !== 1)
  ) {
    errors.push('hyperion.mutators must contain exactly antiMeta: 1 when present')
  }
}

function validateRosterMatchesSlots(roster: unknown, slots: unknown, errors: string[]): void {
  if (!Array.isArray(roster) || !Array.isArray(slots)) {
    return
  }
  if (roster.length !== slots.length) {
    errors.push('roster and hyperion.slots must contain the same authenticated humans')
  }
  const rosterEntries = roster.filter(isRecord)
  for (const [index, slot] of slots.entries()) {
    if (!isRecord(slot) || !isUint32(slot.rpSlot) || !isUint32(slot.userId)) {
      continue
    }
    const rosterEntry = rosterEntries.find(entry => entry.slot === slot.rpSlot)
    if (!rosterEntry || rosterEntry.userId !== slot.userId) {
      errors.push(`hyperion.slots[${index}] must match the netcode roster slot and user ID`)
    }
  }
}

function validateName(value: unknown, path: string, errors: string[]): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 24
  ) {
    errors.push(`${path} must be a non-empty string of at most 24 UTF-8 bytes without NULs`)
  }
}

function validateNonEmptyString(value: unknown, path: string, errors: string[]): void {
  if (!isNonEmptyString(value)) {
    errors.push(`${path} must be a non-empty string`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isUint32(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= UINT32_MAX
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/** Serializes the native seed command: 0x48, little-endian uint32 seed, then eight 0x08 bytes. */
export function hyperionSeedRecord(manifest: HyperionNativeManifest): number[] {
  const seed = manifest.hyperion.seed >>> 0
  return [
    0x48,
    seed & 0xff,
    (seed >>> 8) & 0xff,
    (seed >>> 16) & 0xff,
    (seed >>> 24) & 0xff,
    ...Array<number>(8).fill(8),
  ]
}
