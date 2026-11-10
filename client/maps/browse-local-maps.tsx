import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import swallowNonBuiltins from '../../common/async/swallow-non-builtins'
import { TypedIpcRenderer } from '../../common/ipc'
import { SbMapId } from '../../common/maps'
import { FileBrowser } from '../file-browser/file-browser'
import { FileBrowserFileEntry, FileBrowserType } from '../file-browser/file-browser-types'
import { joinFilePath } from '../file-browser/file-paths'
import { MaterialIcon } from '../icons/material/material-icon'
import LoadingIndicator from '../progress/dots'
import { useAppDispatch, useAppSelector } from '../redux-hooks'
import { uploadLocalMap } from './action-creators'
import { forgetServerMapsWindows } from './browse-server-maps'
import { buildLocalMapRootFolders } from './local-map-folders'

const LoadingArea = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  height: 100%;
`

const ipcRenderer = new TypedIpcRenderer()

async function getDocumentsMapsPath() {
  return joinFilePath(await ipcRenderer.invoke('pathsGetDocumentsPath')!, 'Starcraft', 'maps')
}

export function BrowseLocalMaps({ onMapUpload }: { onMapUpload: (mapId: SbMapId) => void }) {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const localStarcraftPath = useAppSelector(s => s.settings.local.starcraftPath)
  const mapLibraryFolders = useAppSelector(s => s.settings.local.mapLibraryFolders) ?? []

  const [documentsPath, setDocumentsPath] = useState<string>('')
  const [isUploading, setIsUploading] = useState(false)

  useEffect(() => {
    getDocumentsMapsPath()
      .then(path => setDocumentsPath(path))
      .catch(swallowNonBuiltins)
  }, [])

  if (!documentsPath) {
    return null
  }

  if (isUploading) {
    return (
      <LoadingArea>
        <LoadingIndicator />
      </LoadingArea>
    )
  }

  const rootFolders = buildLocalMapRootFolders({
    starcraftPath: localStarcraftPath,
    documentsPath,
    mapLibraryFolders,
    programFolderName: t('maps.local.programFolder', 'Program folder'),
    documentsFolderName: t('maps.local.documentsFolder', 'Documents folder'),
  })

  // TODO(tec27): add back button if needed (always?)
  return (
    <FileBrowser
      key={mapLibraryFolders.join('\0')}
      browserType={FileBrowserType.Maps}
      title={t('maps.local.title', 'Local Maps')}
      rootFolders={rootFolders}
      fileEntryConfig={{
        icon: <MaterialIcon icon='map' />,
        allowedExtensions: ['scm', 'scx'],
        onSelect: (map: FileBrowserFileEntry) => {
          setIsUploading(true)
          dispatch(
            uploadLocalMap(map.path, {
              onSuccess: ({ map }) => {
                setIsUploading(false)
                forgetServerMapsWindows()
                onMapUpload(map.id)
              },
              onError: () => {
                setIsUploading(false)
              },
            }),
          )
        },
      }}
    />
  )
}
