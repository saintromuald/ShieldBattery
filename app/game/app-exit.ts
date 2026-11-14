export interface AppExitEvent {
  preventDefault(): void
}

export interface AppExitTarget {
  quit(): void
}

export interface AppExitGameManager {
  quitAllGamesOnAppExit(): Array<Promise<void>>
}

/** Holds Electron quit until every native launch, process, and replay write has settled. */
export function createNativeGameQuitHandler(
  app: AppExitTarget,
  activeGameManager: AppExitGameManager,
  onError: (error: unknown) => void,
): (event: AppExitEvent) => void {
  let nativeGamesMayExit = false
  let nativeGamesQuitStarted = false

  return event => {
    if (nativeGamesMayExit) return

    if (!nativeGamesQuitStarted) {
      nativeGamesQuitStarted = true
      const quitting = activeGameManager.quitAllGamesOnAppExit()
      if (quitting.length === 0) {
        nativeGamesMayExit = true
        return
      }
      const finishQuit = () => {
        nativeGamesMayExit = true
        app.quit()
      }
      Promise.allSettled(quitting)
        .then(finishQuit)
        .catch(error => {
          onError(error)
          finishQuit()
        })
    }

    // Electron does not await returned promises. Hold the first and any repeated quit events until
    // every native process has exited, then re-enter quit without requesting termination again.
    event.preventDefault()
  }
}
