const MANUAL_IMPORT_SOURCE_KEYS = new Set(['kelivo'])

/**
* @param {{ sourceKey: string; }} tool
*/
export function isManualImportSource(tool) {
  return MANUAL_IMPORT_SOURCE_KEYS.has(tool?.sourceKey)
}

/**
* @param {any[]} tools
*/
export function splitSettingsSources(tools) {
  const manualImportTools = tools.filter(isManualImportSource)
  const detectedTools = tools.filter((tool) => !isManualImportSource(tool))

  return {
    manualImportTools,
    activeDetectedTools: detectedTools.filter((tool) => tool.status !== 'not_found'),
    notFoundDetectedTools: detectedTools.filter((tool) => tool.status === 'not_found'),
  }
}
