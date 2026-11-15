import { promises as fs, constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { computeFileSha256 } from '../../releases/storage'

const PLUTO_PAYLOAD_SHA256: Readonly<Record<string, string>> = {
  'pluto.dll': '603fea2f77a4b652f29b832c2977cf5bc9d83bbcb927febd04499220020ce3bc',
  'pluto/pluto_infer.exe': '3f2814a51034b9817b396e52b38d30341ede506a2baedc7cbc11cb6ebcece2cc',
  'pluto/pluto_weights.bin': 'c53a559b4910777dc0e1c561c0d89d243091f465d8e9fc0f5f72e56597067d86',
}

const RUNTIME_ERROR =
  'Pluto AI must be installed and verified on the lobby host. Install or repair Pluto AI in Release Center, then rejoin the lobby.'

/** Verifies only the inference owner's local runtime; guests never call this check. */
export async function assertPlutoRuntimeReady(
  hyperionDataPath: string,
  hashFile: (filePath: string) => Promise<string> = computeFileSha256,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const installRoot = path.join(hyperionDataPath, 'pluto')
  try {
    for (const [name, expectedHash] of Object.entries(PLUTO_PAYLOAD_SHA256)) {
      const filePath = path.join(installRoot, ...name.split('/'))
      const stat = await fs.lstat(filePath)
      if (!stat.isFile() || stat.isSymbolicLink() || (await hashFile(filePath)) !== expectedHash) {
        throw new Error(`Pluto payload is missing or invalid: ${name}`)
      }
    }

    const bridgePath = path.join(installRoot, 'pluto-bridge.exe')
    const bridge = await fs.lstat(bridgePath)
    if (!bridge.isFile() || bridge.isSymbolicLink() || bridge.size === 0) {
      throw new Error('The Hyperion Pluto bridge is missing or invalid')
    }
    if (platform === 'linux') {
      await fs.access(path.join(installRoot, 'pluto', 'pluto_infer.exe'), fsConstants.X_OK)
    }
  } catch (error) {
    throw new Error(RUNTIME_ERROR, { cause: error })
  }
}
