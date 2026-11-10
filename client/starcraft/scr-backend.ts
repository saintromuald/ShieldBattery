/**
 * Whether the current client can launch the Windows SC:R/DLL backend.
 *
 * Linux HyperShield packages launch Hyperion natively and intentionally do not ship the Windows
 * SC:R DLLs. Other clients retain the existing SC:R health checks.
 */
export function isScrBackendSupported(userAgent = globalThis.navigator?.userAgent ?? ''): boolean {
  return !userAgent.includes('Linux')
}
