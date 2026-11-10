export const MapImportVisibility = Object.freeze({
  Official: 'OFFICIAL',
  Unofficial: 'UNOFFICIAL',
  Public: 'PUBLIC',
})

/** Returns Battle.net hashes followed by ASL hashes, keeping only the first copy of each hash. */
export function orderedOfficialHashes(battleNetHashes, aslHashes) {
  const result = []
  const seen = new Set()
  for (const hash of [...battleNetHashes, ...aslHashes]) {
    if (!seen.has(hash)) {
      seen.add(hash)
      result.push(hash)
    }
  }
  return result
}

/** Official selections take precedence over community selections; everything else is unofficial. */
export function classifyMapHash(hash, officialHashes, communityHashes) {
  if (officialHashes.has(hash)) {
    return MapImportVisibility.Official
  }
  if (communityHashes.has(hash)) {
    return MapImportVisibility.Public
  }
  return MapImportVisibility.Unofficial
}
