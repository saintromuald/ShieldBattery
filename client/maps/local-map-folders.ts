import { FileBrowserRootFolder, FileBrowserRootFolderId } from '../file-browser/file-browser-types'
import { filePathBaseName, joinFilePath } from '../file-browser/file-paths'

export interface LocalMapRootOptions {
  starcraftPath: string
  documentsPath: string
  mapLibraryFolders: ReadonlyArray<string>
  programFolderName: string
  documentsFolderName: string
}

/** Builds the built-in and linked roots shown by the Local Maps browser. */
export function buildLocalMapRootFolders({
  starcraftPath,
  documentsPath,
  mapLibraryFolders,
  programFolderName,
  documentsFolderName,
}: LocalMapRootOptions): Record<string, FileBrowserRootFolder> & {
  default: FileBrowserRootFolder
} {
  const documentsRoot: FileBrowserRootFolder = {
    id: FileBrowserRootFolderId.Documents,
    name: documentsFolderName,
    path: documentsPath,
  }
  const customRoots = mapLibraryFolders.map((folder, index) => ({
    id: `custom:${index}`,
    name: filePathBaseName(folder) || folder,
    path: folder,
  }))
  const programRoot = starcraftPath
    ? {
        id: FileBrowserRootFolderId.Default,
        name: programFolderName,
        path: joinFilePath(starcraftPath, 'Maps'),
      }
    : undefined
  const defaultRoot = customRoots[0] ?? programRoot ?? documentsRoot
  const rootFolders: Record<string, FileBrowserRootFolder> & {
    default: FileBrowserRootFolder
  } = {
    default: { ...defaultRoot, id: FileBrowserRootFolderId.Default },
  }
  if (programRoot && defaultRoot.path !== programRoot.path) {
    rootFolders.program = { ...programRoot, id: 'program' }
  }
  if (defaultRoot.path !== documentsRoot.path) {
    rootFolders[FileBrowserRootFolderId.Documents] = documentsRoot
  }
  for (const root of customRoots) {
    if (root.path !== defaultRoot.path) {
      rootFolders[root.id] = root
    }
  }
  return rootFolders
}
