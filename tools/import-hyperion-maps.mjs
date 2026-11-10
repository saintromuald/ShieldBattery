#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  classifyMapHash,
  MapImportVisibility,
  orderedOfficialHashes,
} from './import-hyperion-maps-helpers.mjs'

const serverRoot = process.env.SB_SERVER_ROOT ?? process.cwd()
const require = createRequire(path.join(serverRoot, 'package.json'))
const MAP_EXTENSIONS = new Set(['.scm', '.scx'])
const MANAGED_VISIBILITIES = Object.values(MapImportVisibility)

function usage() {
  console.error(
    `Usage: node tools/import-hyperion-maps.mjs --manifest <manifest.json> [--apply] [--import-only]\n\n` +
      `The manifest contains sourceRoots, battleNetFiles, aslFiles, optional communityFiles, and ` +
      `matchmakingTypes arrays. Official maps are the ordered, content-deduplicated union of ` +
      `battleNetFiles and aslFiles. Other imported maps are UNOFFICIAL unless their content is ` +
      `listed in communityFiles, which makes them PUBLIC. Existing active rows owned by the ` +
      `selected importer are reclassified in place by the same rules. Without --apply, only the ` +
      `inventory and classification are printed. Use --import-only with --apply to leave all map ` +
      `pools unchanged; matchmakingTypes may then be omitted.`,
  )
}

function manifestPaths(manifest, name, optional = false) {
  if (optional && manifest[name] === undefined) {
    return []
  }
  if (!Array.isArray(manifest[name])) {
    throw new Error(`The manifest must specify ${name} as an array`)
  }
  return manifest[name].map(file => path.resolve(file))
}

async function main() {
  const args = process.argv.slice(2)
  const manifestFlag = args.indexOf('--manifest')
  const apply = args.includes('--apply')
  const importOnly = args.includes('--import-only')
  if (manifestFlag < 0 || !args[manifestFlag + 1]) {
    usage()
    process.exitCode = 2
    return
  }

  const manifestPath = path.resolve(args[manifestFlag + 1])
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.ladderFiles !== undefined) {
    throw new Error('Replace ladderFiles with explicit battleNetFiles and aslFiles arrays')
  }

  const sourceRoots = manifestPaths(manifest, 'sourceRoots').map(root => path.resolve(root))
  const battleNetFiles = manifestPaths(manifest, 'battleNetFiles')
  const aslFiles = manifestPaths(manifest, 'aslFiles')
  const communityFiles = manifestPaths(manifest, 'communityFiles', true)
  const matchmakingTypes = manifest.matchmakingTypes ?? []
  if (!sourceRoots.length || (!battleNetFiles.length && !aslFiles.length)) {
    throw new Error('The manifest must specify sourceRoots and at least one official map file')
  }
  if (!Array.isArray(matchmakingTypes) || (!importOnly && !matchmakingTypes.length)) {
    throw new Error('The manifest must specify matchmakingTypes unless --import-only is used')
  }

  async function collectMapFiles(root) {
    const result = []
    async function visit(directory) {
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          await visit(entryPath)
        } else if (entry.isFile() && MAP_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          result.push(entryPath)
        }
      }
    }
    await visit(root)
    return result.sort()
  }

  const sourceFiles = (await Promise.all(sourceRoots.map(collectMapFiles))).flat()
  const uniqueSourceFiles = [...new Set(sourceFiles)]
  const sourceFileSet = new Set(uniqueSourceFiles)
  const filesToHash = [
    ...new Set([...uniqueSourceFiles, ...battleNetFiles, ...aslFiles, ...communityFiles]),
  ]

  async function hashMap(filePath) {
    const extension = path.extname(filePath).slice(1).toLowerCase()
    if (!MAP_EXTENSIONS.has(`.${extension}`)) {
      throw new Error(`Unsupported official or community map format: ${filePath}`)
    }
    const hash = createHash('sha256')
    hash.update(extension)
    for await (const chunk of createReadStream(filePath)) {
      hash.update(chunk)
    }
    return { hash: hash.digest('hex'), extension }
  }

  const hashes = new Map()
  for (const filePath of filesToHash) {
    await stat(filePath)
    hashes.set(filePath, await hashMap(filePath))
  }

  const byContent = new Map()
  for (const filePath of filesToHash) {
    const identity = hashes.get(filePath)
    const existing = byContent.get(identity.hash)
    if (existing) {
      existing.paths.push(filePath)
    } else {
      byContent.set(identity.hash, { ...identity, paths: [filePath] })
    }
  }

  const battleNetHashes = battleNetFiles.map(filePath => hashes.get(filePath).hash)
  const aslHashes = aslFiles.map(filePath => hashes.get(filePath).hash)
  const officialHashes = orderedOfficialHashes(battleNetHashes, aslHashes)
  const officialHashSet = new Set(officialHashes)
  const communityHashSet = new Set(communityFiles.map(filePath => hashes.get(filePath).hash))

  console.log(`Source-root map files found: ${uniqueSourceFiles.length}`)
  console.log(
    `Explicit map files outside source roots: ${filesToHash.filter(file => !sourceFileSet.has(file)).length}`,
  )
  console.log(`Unique map contents to reconcile: ${byContent.size}`)
  console.log(`Duplicate copies skipped: ${filesToHash.length - byContent.size}`)
  console.log(`Official maps after ordered content deduplication: ${officialHashes.length}`)
  console.log(`Explicit community map contents: ${communityHashSet.size}`)
  for (const filePath of battleNetFiles) {
    console.log(`  Battle.net: ${filePath} [${hashes.get(filePath).hash}]`)
  }
  for (const filePath of aslFiles) {
    console.log(`  ASL: ${filePath} [${hashes.get(filePath).hash}]`)
  }
  for (const filePath of communityFiles) {
    console.log(`  Community: ${filePath} [${hashes.get(filePath).hash}]`)
  }

  const plannedVisibilities = new Map()
  for (const [hash, entry] of byContent) {
    const visibility = classifyMapHash(hash, officialHashSet, communityHashSet)
    plannedVisibilities.set(hash, visibility)
    const aliases = entry.paths.length > 1 ? ` (+ ${entry.paths.length - 1} copies)` : ''
    console.log(`  ${visibility}: ${entry.paths[0]} [${hash}]${aliases}`)
  }

  if (!apply) {
    console.log('Dry run only. Pass --apply to import and reclassify maps.')
    return
  }

  // The production image contains the mirrored CommonJS server tree and all runtime dependencies.
  // Reusing these modules keeps parsing, thumbnails, object storage, and database writes identical
  // to uploads through the normal API.
  const { default: AwsStore } = require('./server-dist/server/lib/files/aws.js')
  const { default: LocalFileStore } = require('./server-dist/server/lib/files/local-filesystem.js')
  const { setStore } = require('./server-dist/server/lib/files/index.js')
  const { storeMap } = require('./server-dist/server/lib/maps/store.js')
  const {
    addMapPool,
  } = require('./server-dist/server/lib/matchmaking/matchmaking-map-pools-models.js')
  const { Client } = require('pg')

  const fileStoreSettings = JSON.parse(process.env.SB_FILE_STORE ?? '{}')
  if (fileStoreSettings.doSpaces) {
    setStore(new AwsStore(fileStoreSettings.doSpaces))
  } else if (fileStoreSettings.filesystem) {
    setStore(new LocalFileStore(fileStoreSettings.filesystem))
  } else {
    throw new Error('SB_FILE_STORE does not contain a supported file store')
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  const failures = []
  try {
    const adminResult = await client.query(
      `SELECT user_id FROM permissions
       WHERE manage_maps = TRUE AND manage_map_pools = TRUE
       ORDER BY user_id LIMIT 1`,
    )
    if (!adminResult.rowCount) {
      throw new Error('No user has both map-management and map-pool-management permissions')
    }
    const uploadedBy = adminResult.rows[0].user_id

    // UNLISTED rows are deliberately absent: ordinary user uploads are never importer state.
    const existingResult = await client.query(
      `SELECT um.id, um.map_hash AS hash, um.visibility, um.removed_at
       FROM uploaded_maps um
       WHERE um.uploaded_by = $1 AND um.visibility = ANY($2::map_visibility[])
       ORDER BY um.map_hash, um.id`,
      [uploadedBy, MANAGED_VISIBILITIES],
    )
    const existingRows = existingResult.rows.map(row => ({
      ...row,
      hash: row.hash.toString('hex'),
    }))
    const activeRows = existingRows.filter(row => row.removed_at === null)
    const activeByHash = new Map()
    for (const row of activeRows) {
      const rows = activeByHash.get(row.hash) ?? []
      rows.push(row)
      activeByHash.set(row.hash, rows)
    }
    const duplicateHashes = [...activeByHash.entries()].filter(([, rows]) => rows.length > 1)
    if (duplicateHashes.length) {
      const details = duplicateHashes
        .map(
          ([hash, rows]) =>
            `${hash}: ${rows.map(row => `${row.id} (${row.visibility})`).join(', ')}`,
        )
        .join('\n')
      throw new Error(
        `Unexpected duplicate active map rows for importer ${uploadedBy}; aborting without writes:\n${details}`,
      )
    }

    const rowByHashAndVisibility = new Map()
    for (const row of existingRows) {
      rowByHashAndVisibility.set(`${row.hash}:${row.visibility}`, row)
    }

    // Preflight every update before the first write. A removed row in the destination category
    // participates in the table's uniqueness constraint and must not be revived or overwritten.
    for (const row of activeRows) {
      const visibility = classifyMapHash(row.hash, officialHashSet, communityHashSet)
      if (visibility === row.visibility) {
        continue
      }
      const conflictingRow = rowByHashAndVisibility.get(`${row.hash}:${visibility}`)
      if (conflictingRow && conflictingRow.id !== row.id) {
        throw new Error(
          `Cannot reclassify ${row.id} (${row.hash}) to ${visibility}: row ${conflictingRow.id} ` +
            `already occupies that category${conflictingRow.removed_at === null ? '' : ' and is removed'}. ` +
            `Aborting without writes rather than modifying another row.`,
        )
      }
    }

    const mapIds = new Map()
    let reclassifiedCount = 0
    let unchangedCount = 0
    for (const row of activeRows) {
      const visibility = classifyMapHash(row.hash, officialHashSet, communityHashSet)
      if (visibility !== row.visibility) {
        const updateResult = await client.query(
          `UPDATE uploaded_maps
           SET visibility = $1
           WHERE id = $2 AND uploaded_by = $3 AND removed_at IS NULL AND visibility = $4
           RETURNING id`,
          [visibility, row.id, uploadedBy, row.visibility],
        )
        if (updateResult.rowCount !== 1) {
          throw new Error(
            `Map ${row.id} changed during import; aborting rather than overwriting it`,
          )
        }
        reclassifiedCount += 1
        console.log(`Reclassified ${row.id}: ${row.visibility} -> ${visibility} [${row.hash}]`)
      } else {
        unchangedCount += 1
      }
      mapIds.set(row.hash, row.id)
    }
    console.log(
      `Existing importer rows: ${reclassifiedCount} reclassified in place, ${unchangedCount} already categorized`,
    )

    let index = 0
    let skippedRemovedCount = 0
    for (const [hash, entry] of byContent) {
      index += 1
      const visibility = plannedVisibilities.get(hash)
      if (mapIds.has(hash)) {
        console.log(
          `[${index}/${byContent.size}] already active as ${visibility}: ${entry.paths[0]}`,
        )
        continue
      }

      const removedTarget = rowByHashAndVisibility.get(`${hash}:${visibility}`)
      if (removedTarget) {
        skippedRemovedCount += 1
        console.log(
          `[${index}/${byContent.size}] skipped removed ${visibility} row ${removedTarget.id}: ${entry.paths[0]}`,
        )
        continue
      }

      const sourcePath = entry.paths[0]
      try {
        const map = await storeMap(sourcePath, entry.extension, uploadedBy, visibility)
        mapIds.set(hash, map.id)
        console.log(
          `[${index}/${byContent.size}] imported ${map.name} as ${visibility}: ${sourcePath}`,
        )
      } catch (error) {
        failures.push({ path: sourcePath, error: error?.message ?? String(error) })
        console.error(
          `[${index}/${byContent.size}] FAILED ${sourcePath}: ${error?.message ?? error}`,
        )
      }
    }
    if (skippedRemovedCount) {
      console.log(`Removed map rows left untouched: ${skippedRemovedCount}`)
    }

    if (importOnly) {
      console.log(
        `Import-only run complete with ${failures.length} failures; no map pools changed.`,
      )
      for (const failure of failures) {
        console.error(`  ${failure.path}: ${failure.error}`)
      }
      process.exitCode = failures.length ? 1 : 0
      return
    }

    const missingOfficialMaps = officialHashes.filter(hash => !mapIds.has(hash))
    if (missingOfficialMaps.length) {
      throw new Error(
        `${missingOfficialMaps.length} official maps could not be imported; no map pools were changed. ` +
          `Missing hashes: ${missingOfficialMaps.join(', ')}`,
      )
    }

    const officialMapIds = officialHashes.map(hash => mapIds.get(hash))
    const startDate = new Date(Date.now() + 15_000)
    for (const matchmakingType of matchmakingTypes) {
      const previousPool = await client.query(
        `SELECT max_veto_count FROM matchmaking_map_pools
         WHERE matchmaking_type = $1
         ORDER BY start_date DESC LIMIT 1`,
        [matchmakingType],
      )
      const maxVetoCount = previousPool.rows[0]?.max_veto_count ?? 3
      const pool = await addMapPool({
        matchmakingType,
        maps: officialMapIds,
        maxVetoCount,
        startDate,
      })
      console.log(
        `Created ${matchmakingType} map pool ${pool.id} with ${officialMapIds.length} maps ` +
          `(max vetoes: ${maxVetoCount}, starts: ${startDate.toISOString()})`,
      )
    }

    if (failures.length) {
      console.error(`Completed with ${failures.length} unsupported or invalid map files:`)
      for (const failure of failures) {
        console.error(`  ${failure.path}: ${failure.error}`)
      }
      process.exitCode = 1
    } else {
      console.log(`Imported and classified every unique map successfully.`)
    }
  } finally {
    await client.end()
  }
}

main()
  .then(() => {
    // Server modules keep their shared database pool open; all import work is complete at this point.
    setImmediate(() => process.exit(process.exitCode ?? 0))
  })
  .catch(error => {
    console.error(error?.stack ?? error)
    process.exit(1)
  })
