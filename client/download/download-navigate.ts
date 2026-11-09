/** Navigates the browser to download the latest HyperShield installer. */
export function navigateToDownload() {
  window.fathom?.trackGoal('BCSXAXFR', 0)
  window.location.assign(`/published_artifacts/win/ShieldBattery.latest.exe?t${Date.now()}`)
}
