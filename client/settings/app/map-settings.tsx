import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import { TypedIpcRenderer } from '../../../common/ipc'
import { filePathBaseName } from '../../file-browser/file-paths'
import { MaterialIcon } from '../../icons/material/material-icon'
import logger from '../../logging/logger'
import { IconButton, OutlinedButton } from '../../material/button'
import { Tooltip } from '../../material/tooltip'
import { useAppDispatch, useAppSelector } from '../../redux-hooks'
import { bodySmall, singleLine, titleSmall } from '../../styles/typography'
import { mergeLocalSettings } from '../action-creators'
import {
  FormContainer,
  SectionContainer,
  SettingsSectionDescription,
  SettingsSectionHeader,
} from '../settings-content'

const ipcRenderer = new TypedIpcRenderer()

function dedupeFolders(folders: ReadonlyArray<string>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const folder of folders) {
    const key = folder.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      result.push(folder)
    }
  }
  return result
}

const FolderList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
`

const FolderRow = styled.div`
  min-height: 56px;
  padding: 8px 8px 8px 12px;

  display: flex;
  align-items: center;
  gap: 12px;

  border-radius: 8px;

  &:hover {
    background-color: rgb(from var(--theme-on-surface) r g b / 0.08);
  }
`

const FolderIconTile = styled.div`
  flex-shrink: 0;
  width: 40px;
  height: 40px;

  display: flex;
  align-items: center;
  justify-content: center;

  border-radius: 8px;
  background-color: var(--theme-container-high);
  color: var(--theme-on-surface-variant);
`

const FolderText = styled.div`
  flex: 1 1 auto;
  min-width: 0;

  display: flex;
  flex-direction: column;
`

const FolderName = styled.div`
  ${titleSmall};
  ${singleLine};
`

const FolderPath = styled.div`
  ${bodySmall};
  ${singleLine};

  color: var(--theme-on-surface-variant);
`

const AddFolderButton = styled(OutlinedButton)`
  align-self: flex-start;
  margin-top: 12px;
`

export function AppMapSettings() {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const localSettings = useAppSelector(s => s.settings.local)
  const configuredFolders = localSettings.mapLibraryFolders ?? []

  const saveFolders = (folders: ReadonlyArray<string>) => {
    dispatch(
      mergeLocalSettings(
        { mapLibraryFolders: dedupeFolders(folders) },
        { onSuccess: () => {}, onError: () => {} },
      ),
    )
  }

  const onAddFolderClick = () => {
    Promise.resolve()
      .then(async () => {
        const selection = await ipcRenderer.invoke('settingsBrowseForFolder', {
          title: t('settings.app.maps.addFolderTitle', 'Select a map folder'),
          defaultPath:
            configuredFolders[configuredFolders.length - 1] || localSettings.starcraftPath,
        })!
        if (!selection.canceled && selection.filePaths.length > 0) {
          saveFolders([...configuredFolders, selection.filePaths[0]])
        }
      })
      .catch(err => {
        logger.error(`Failed to browse for a map folder: ${err?.stack ?? err}`)
      })
  }

  const removeFolderLabel = t('settings.app.maps.removeFolder', 'Remove folder')

  return (
    <FormContainer>
      <SectionContainer>
        <SettingsSectionHeader>
          {t('settings.app.maps.foldersTitle', 'Map folders')}
        </SettingsSectionHeader>
        <SettingsSectionDescription>
          {t(
            'settings.app.maps.foldersDescription',
            'Folders linked into the Local Maps browser. Add a Hyperion ladder or ASL folder to ' +
              'use its maps in place without copying them. Selecting a map uploads it to ' +
              'HyperShield.',
          )}
        </SettingsSectionDescription>

        <FolderList>
          {configuredFolders.map(folder => (
            <FolderRow key={folder}>
              <FolderIconTile>
                <MaterialIcon icon='folder' />
              </FolderIconTile>
              <FolderText>
                <FolderName title={folder}>{filePathBaseName(folder)}</FolderName>
                <FolderPath title={folder}>{folder}</FolderPath>
              </FolderText>
              <Tooltip text={removeFolderLabel}>
                <IconButton
                  icon={<MaterialIcon icon='delete' />}
                  ariaLabel={removeFolderLabel}
                  onClick={() => saveFolders(configuredFolders.filter(f => f !== folder))}
                />
              </Tooltip>
            </FolderRow>
          ))}
        </FolderList>

        <AddFolderButton
          label={t('settings.app.maps.addFolder', 'Add folder')}
          iconStart='add'
          onClick={onAddFolderClick}
        />
      </SectionContainer>
    </FormContainer>
  )
}
