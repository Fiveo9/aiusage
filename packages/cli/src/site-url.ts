export function getSiteUrl(): string {
  return process.env.AIUSAGE_SITE_URL || process.env.SITE_URL || 'https://aiusage.jtanx.com'
}
