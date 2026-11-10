#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const serverRoot = process.env.SB_SERVER_ROOT ?? process.cwd()
const require = createRequire(path.join(serverRoot, 'package.json'))
const MAP_EXTENSIONS = new Set(['.scm', '.scx'])

function usage() {
  console.error(
    `Usage: node tools/import-hyperion-maps.mjs --manifest <manifest.json> [--apply] [--import-only]\n\n` +
      `The manifest contains sourceRoots, ladderFiles, and matchmakingTypes arrays. ` +
      `Without --apply, only the inventory and ranked selection are printed. ` +
      `Use --import-only with --apply to leave all map pools unchanged.`,
  )
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
  const sourceRoots = manifest.sourceRoots.map(root => path.resolve(root))
  const ladderFiles = manifest.ladderFiles.map(file => path.resolve(file))
  const matchmakingTypes = manifest.matchmakingTypes
  if (!sourceRoots.length || !ladderFiles.length || !matchmakingTypes?.length) {
    throw new Error('The manifest must specify sourceRoots, ladderFiles, and matchmakingTypes')
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
  const filesToHash = [...new Set([...uniqueSourceFiles, ...ladderFiles])]

  async function hashMap(filePath) {
    const extension = path.extname(filePath).slice(1).toLowerCase()
    if (!MAP_EXTENSIONS.has(`.${extension}`)) {
      throw new Error(`Unsupported ranked map format: ${filePath}`)
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
  for (const filePath of uniqueSourceFiles) {
    const identity = hashes.get(filePath)
    const existing = byContent.get(identity.hash)
    if (existing) {
      existing.paths.push(filePath)
    } else {
      byContent.set(identity.hash, { ...identity, paths: [filePath] })
    }
  }

  const ladderHashes = []
  const seenLadderHashes = new Set()
  for (const filePath of ladderFiles) {
    const { hash } = hashes.get(filePath)
    if (!seenLadderHashes.has(hash)) {
      seenLadderHashes.add(hash)
      ladderHashes.push(hash)
    }
  }

  console.log(`Standard map files found: ${uniqueSourceFiles.length}`)
  console.log(`Unique map contents: ${byContent.size}`)
  console.log(`Duplicate copies skipped: ${uniqueSourceFiles.length - byContent.size}`)
  console.log(`Ranked maps after content deduplication: ${ladderHashes.length}`)
  for (const filePath of ladderFiles) {
    console.log(`  ranked: ${filePath}`)
  }

  if (!apply) {
    console.log('Dry run only. Pass --apply to import maps and create the ranked pools.')
    return
  }

  // The production image contains the mirrored CommonJS server tree and all runtime dependencies.
  // Reusing these modules keeps parsing, thumbnails, object storage, and database writes identical
  // to uploads through the normal API.
  const { default: AwsStore } = require('./server-dist/server/lib/files/aws.js')
  const { default: LocalFileStore } = require('./server-dist/server/lib/files/local-filesystem.js')
  const { setStore } = require('./server-dist/server/lib/files/index.js')
  const { storeMap } = require('./server-dist/server/lib/maps/store.js')
  const { MapVisibility } = require('./server-dist/common/maps.js')
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

    const existingResult = await client.query(
      `SELECT m.hash, um.id FROM maps m
       INNER JOIN uploaded_maps um ON um.map_hash = m.hash
       WHERE um.visibility = $1 AND um.removed_at IS NULL`,
      [MapVisibility.Official],
    )
    const mapIds = new Map()
    for (const row of existingResult.rows) {
      if (!mapIds.has(row.hash.toString('hex'))) {
        mapIds.set(row.hash.toString('hex'), row.id)
      }
    }
    console.log(`Official maps already present: ${mapIds.size}`)

    let index = 0
    for (const [hash, entry] of byContent) {
      index += 1
      if (mapIds.has(hash)) {
        console.log(`[${index}/${byContent.size}] already imported: ${entry.paths[0]}`)
        continue
      }

      const sourcePath = entry.paths[0]
      try {
        const map = await storeMap(sourcePath, entry.extension, uploadedBy, MapVisibility.Official)
        mapIds.set(hash, map.id)
        console.log(`[${index}/${byContent.size}] imported ${map.name}: ${sourcePath}`)
      } catch (error) {
        failures.push({ path: sourcePath, error: error?.message ?? String(error) })
        console.error(
          `[${index}/${byContent.size}] FAILED ${sourcePath}: ${error?.message ?? error}`,
        )
      }
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

    const missingRankedMaps = ladderHashes.filter(hash => !mapIds.has(hash))
    if (missingRankedMaps.length) {
      throw new Error(
        `${missingRankedMaps.length} ranked maps could not be imported; no map pools were changed`,
      )
    }

    const rankedMapIds = ladderHashes.map(hash => mapIds.get(hash))
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
        maps: rankedMapIds,
        maxVetoCount,
        startDate,
      })
      console.log(
        `Created ${matchmakingType} map pool ${pool.id} with ${rankedMapIds.length} maps ` +
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
      console.log(`Imported every unique standard map successfully.`)
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
