const SANITIZED_NATIVE_ENVIRONMENT = [
  'HYPERION_SB_RESULT_CODE',
  'HYPERION_SB_SERVER_URL',
  'HYPERION_SB_EVENTS',
  'HYPERION_SB_DEV_MINT',
  'HYPERION_SB_TRACE',
  'HYPERION_CHILD_TOKEN',
  'HYPERION_CONTROL_KEY',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'GITHUB_TOKEN',
  'GH_TOKEN',
] as const

/** Builds a native child environment without inherited credentials or development controls. */
export function sanitizedHyperionEnvironment({
  resultCode,
  serverUrl,
  events = false,
  hidden = false,
  plutoWine,
}: {
  resultCode?: string
  serverUrl?: string
  events?: boolean
  hidden?: boolean
  plutoWine?: string
} = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('HYPERION_')) delete env[key]
  }
  for (const key of SANITIZED_NATIVE_ENVIRONMENT) {
    delete env[key]
  }
  if (hidden) env.HYPERION_WINDOW = 'hidden'
  if (events) env.HYPERION_SB_EVENTS = '1'
  if (resultCode) env.HYPERION_SB_RESULT_CODE = resultCode
  if (serverUrl) env.HYPERION_SB_SERVER_URL = serverUrl
  if (plutoWine) env.HYPERION_PLUTO_WINE = plutoWine
  return env
}

/** Bounds native diagnostics and removes credentials even if a child prints them unexpectedly. */
export function redactNativeDiagnostic(
  value: string,
  secrets: ReadonlyArray<string | undefined>,
): string {
  let redacted = value.trim().slice(0, 4096)
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, '[redacted]')
  }
  return redacted
}
