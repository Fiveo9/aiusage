/** Model spelling used by both Kiro's local database and JSON/JSONL imports. */
export function normalizeKiroModel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'kiro-agent'
  return value
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/^(anthropic\.|openai\.|aws\.)/, '')
    .replace(/:\d+$/, '')
    .replace(/-\d{8}-v\d+(?:-\d+)?$/i, '')
}
