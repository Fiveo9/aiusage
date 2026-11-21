const usageFields = [
  'callCount',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'thinkingTokens',
  'totalTokens',
  'totalCost',
]

export function modelDisplayName(model, mode = 'full') {
  if (mode !== 'merged') return model
  // Keep an empty trailing segment intact rather than producing a blank name.
  return model.slice(model.lastIndexOf('/') + 1) || model
}

export function groupModels(models = [], mode = 'full') {
  if (mode !== 'merged') {
    return models.map(row => ({ ...row, originalModels: [row.model] }))
  }

  const groups = new Map()
  let totalTokens = 0
  for (const row of models) {
    const name = modelDisplayName(row.model, mode)
    let group = groups.get(name)
    if (!group) {
      group = {
        model: name,
        providers: new Set(),
        originalModels: new Set(),
        ...Object.fromEntries(usageFields.map(field => [field, 0])),
      }
      groups.set(name, group)
    }
    if (row.provider) group.providers.add(row.provider)
    group.originalModels.add(row.model)
    for (const field of usageFields) group[field] += row[field] ?? 0
    totalTokens += row.totalTokens ?? 0
  }

  return Array.from(groups.values(), ({ providers, originalModels, ...group }) => ({
    ...group,
    provider: Array.from(providers).join(', '),
    originalModels: Array.from(originalModels),
    // Recompute from totals, not the already-rounded percentages in the API.
    percentage: totalTokens > 0 ? Math.round(group.totalTokens / totalTokens * 1000) / 10 : 0,
  }))
}

export function groupModelCosts(byModel = {}, mode = 'full') {
  const groups = new Map()
  for (const [model, cost] of Object.entries(byModel)) {
    const name = modelDisplayName(model, mode)
    groups.set(name, (groups.get(name) ?? 0) + cost)
  }
  return Object.fromEntries(groups)
}
