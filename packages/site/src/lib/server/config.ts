import { sql } from '$lib/server/db/pool.js'
import { error } from '@sveltejs/kit'
import { nanoid } from 'nanoid'

interface ConfigEntry {
  /** null: the key has no row in site_config, so callers use their default. */
  value: number | null
  updatedAt: number
}

const CACHE_TTL_MS = 60_000
const cache = new Map<string, ConfigEntry>()
// Bumped whenever the cache is written outside readConfig, so that a read
// which started before a save does not put its older result over the saved one.
let cacheGeneration = 0

// Switches an admin turns off to stop something at once. The cache is per
// server instance and setConfig refreshes only the instance that saved, so a
// cached value would keep the others going for up to CACHE_TTL_MS. These keys
// are read from site_config on every lookup instead (one primary-key query).
// When that read fails the lookup throws: it neither assumes the default nor
// reuses an earlier read, so a database error never keeps a switched-off
// feature running.
const UNCACHED_KEYS: ReadonlySet<string> = new Set(['cloud.sync_globally_enabled'])

async function readConfig(key: string): Promise<number | null> {
  const uncached = UNCACHED_KEYS.has(key)
  const cached = cache.get(key)
  if (!uncached && cached && Date.now() - cached.updatedAt < CACHE_TTL_MS) {
    return cached.value
  }

  const generation = cacheGeneration
  try {
    const rows = await sql`SELECT value FROM site_config WHERE key = ${key}`
    const row = rows[0] as { value: number } | undefined
    const value = row ? row.value : null
    if (generation === cacheGeneration) {
      cache.set(key, { value, updatedAt: Date.now() })
    }
    return value
  } catch (err) {
    if (uncached) throw err
    // DB unavailable (e.g. tests without DB) — fall back to default
  }
  return null
}

export async function getConfig(key: string, defaultValue: number): Promise<number> {
  const val = await readConfig(key)
  return val ?? defaultValue
}

function getConfigSync(key: string, defaultValue: number): number {
  const cached = cache.get(key)
  if (cached && Date.now() - cached.updatedAt < CACHE_TTL_MS) {
    return cached.value ?? defaultValue
  }
  return defaultValue
}

export async function setConfig(key: string, value: number, description: string, userId: string): Promise<void> {
  await sql`
    INSERT INTO site_config (key, value, description, updated_at, updated_by)
    VALUES (${key}, ${value}, ${description}, NOW(), ${userId})
    ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = NOW(), updated_by = ${userId}
  `
  cacheGeneration++
  cache.set(key, { value, updatedAt: Date.now() })
}

export async function getAllConfigs(): Promise<Record<string, { value: number; description: string | null }>> {
  const rows = await sql<{ key: string; value: number; description: string | null }[]>`SELECT key, value, description FROM site_config ORDER BY key`
  const result: Record<string, { value: number; description: string | null }> = {}
  for (const row of rows) {
    result[row.key] = { value: row.value, description: row.description }
  }
  return result
}

export function invalidateConfigCache(): void {
  cacheGeneration++
  cache.clear()
}

// ── Email Verification ──
export const CFG = {
  EMAIL_TOKEN_TTL_HOURS:          'email.token_ttl_hours',
  EMAIL_IP_LIMIT:                 'email.ip_limit',
  EMAIL_IP_LIMIT_WINDOW_MINUTES:  'email.ip_limit_window_minutes',
  EMAIL_LIMIT:                    'email.limit',
  EMAIL_LIMIT_WINDOW_HOURS:       'email.limit_window_hours',
  EMAIL_GLOBAL_LIMIT:             'email.global_limit',
  EMAIL_GLOBAL_LIMIT_WINDOW_HOURS:'email.global_limit_window_hours',
  EMAIL_SEND_ATTEMPT_RETENTION_DAYS: 'email.send_attempt_retention_days',

  // ── User Profile ──
  USERNAME_COOLDOWN_DAYS:    'profile.username_cooldown_days',
  USERNAME_MIN_LENGTH:       'profile.username_min_length',
  USERNAME_MAX_LENGTH:       'profile.username_max_length',
  DISPLAY_NAME_MIN_LENGTH:   'profile.display_name_min_length',
  DISPLAY_NAME_MAX_LENGTH:   'profile.display_name_max_length',
  PASSWORD_MIN_LENGTH:       'profile.password_min_length',

  // ── Avatar ──
  AVATAR_MAX_FILE_SIZE:   'avatar.max_file_size',
  AVATAR_OUTPUT_SIZE:     'avatar.output_size',
  AVATAR_QUALITY:         'avatar.quality',

  // ── Sync ──
  SYNC_MAX_RECORDS:       'sync.max_records',
  SYNC_MAX_TOMBSTONES:    'sync.max_tombstones',
  SYNC_BODY_MAX_SIZE:     'sync.body_max_size',
  SYNC_PULL_DEFAULT_LIMIT:'sync.pull_default_limit',
  SYNC_PULL_MAX_LIMIT:    'sync.pull_max_limit',

  // ── Cloud Sync Gating ──
  CLOUD_SYNC_GLOBALLY_ENABLED: 'cloud.sync_globally_enabled',
  CLOUD_STAR_CACHE_TTL_HOURS: 'cloud.star_cache_ttl_hours',

  // The stored key is retained for existing signed cloud-sync requests.
  UPLOAD_TIMESTAMP_WINDOW_MS: 'upload.timestamp_window_ms',

  // ── Device Auth ──
  DEVICE_AUTH_EXPIRY_MINUTES:'device.auth_expiry_minutes',
  DEVICE_AUTH_POLL_INTERVAL_SECONDS:'device.auth_poll_interval_seconds',

  // ── Session ──
  SESSION_DURATION_DAYS:'session.duration_days',

  // ── OAuth ──
  OAUTH_STATE_MAX_AGE_SECONDS:'oauth.state_max_age_seconds',

  // ── Nonce ──
  NONCE_RETENTION_MINUTES:'nonce.retention_minutes',

  // ── Data Retention ──
  RETENTION_NONCE_HOURS:        'retention.nonce_hours',
  RETENTION_SYNC_BATCH_DAYS:    'retention.sync_batch_days',
  RETENTION_TOMBSTONE_DAYS:     'retention.tombstone_days',
  RETENTION_DEVICE_AUTH_HOURS:  'retention.device_auth_hours',
} as const

// ── Default values ──
const DEFAULTS: Record<string, number> = {
  [CFG.EMAIL_TOKEN_TTL_HOURS]:           24,
  [CFG.EMAIL_IP_LIMIT]:                  5,
  [CFG.EMAIL_IP_LIMIT_WINDOW_MINUTES]:   10,
  [CFG.EMAIL_LIMIT]:                     3,
  [CFG.EMAIL_LIMIT_WINDOW_HOURS]:        1,
  [CFG.EMAIL_GLOBAL_LIMIT]:              1000,
  [CFG.EMAIL_GLOBAL_LIMIT_WINDOW_HOURS]: 24,
  [CFG.EMAIL_SEND_ATTEMPT_RETENTION_DAYS]: 7,

  [CFG.USERNAME_COOLDOWN_DAYS]:   30,
  [CFG.USERNAME_MIN_LENGTH]:      3,
  [CFG.USERNAME_MAX_LENGTH]:      32,
  [CFG.DISPLAY_NAME_MIN_LENGTH]:  1,
  [CFG.DISPLAY_NAME_MAX_LENGTH]:  64,
  [CFG.PASSWORD_MIN_LENGTH]:      8,

  [CFG.AVATAR_MAX_FILE_SIZE]: 5 * 1024 * 1024,
  [CFG.AVATAR_OUTPUT_SIZE]:   256,
  [CFG.AVATAR_QUALITY]:       80,

  [CFG.SYNC_MAX_RECORDS]:        1000,
  [CFG.SYNC_MAX_TOMBSTONES]:     500,
  [CFG.SYNC_BODY_MAX_SIZE]:      2 * 1024 * 1024,
  [CFG.SYNC_PULL_DEFAULT_LIMIT]: 1000,
  [CFG.SYNC_PULL_MAX_LIMIT]:     2000,

  [CFG.CLOUD_STAR_CACHE_TTL_HOURS]:     24,
  [CFG.CLOUD_SYNC_GLOBALLY_ENABLED]: 1,

  [CFG.UPLOAD_TIMESTAMP_WINDOW_MS]:     5 * 60 * 1000,



  [CFG.DEVICE_AUTH_EXPIRY_MINUTES]: 10,
  [CFG.DEVICE_AUTH_POLL_INTERVAL_SECONDS]: 5,

  [CFG.SESSION_DURATION_DAYS]: 7,
  [CFG.OAUTH_STATE_MAX_AGE_SECONDS]: 600,
  [CFG.NONCE_RETENTION_MINUTES]: 10,

  [CFG.RETENTION_NONCE_HOURS]:         24,
  [CFG.RETENTION_SYNC_BATCH_DAYS]:     30,
  [CFG.RETENTION_TOMBSTONE_DAYS]:      90,
  [CFG.RETENTION_DEVICE_AUTH_HOURS]:   1,
}

// Stored units, before the admin UI's display conversion. All settings are
// integral; 0/1 is the only representation accepted for the global switch.
export const CONFIG_BOUNDS: Record<string, readonly [number, number]> = {
  [CFG.EMAIL_TOKEN_TTL_HOURS]: [1, 168],
  [CFG.EMAIL_IP_LIMIT]: [1, 1000],
  [CFG.EMAIL_IP_LIMIT_WINDOW_MINUTES]: [1, 1440],
  [CFG.EMAIL_LIMIT]: [1, 100],
  [CFG.EMAIL_LIMIT_WINDOW_HOURS]: [1, 168],
  [CFG.EMAIL_GLOBAL_LIMIT]: [1, 1_000_000],
  [CFG.EMAIL_GLOBAL_LIMIT_WINDOW_HOURS]: [1, 168],
  [CFG.EMAIL_SEND_ATTEMPT_RETENTION_DAYS]: [1, 365],
  [CFG.USERNAME_COOLDOWN_DAYS]: [0, 3650],
  [CFG.USERNAME_MIN_LENGTH]: [1, 64],
  [CFG.USERNAME_MAX_LENGTH]: [1, 64],
  [CFG.DISPLAY_NAME_MIN_LENGTH]: [1, 256],
  [CFG.DISPLAY_NAME_MAX_LENGTH]: [1, 256],
  [CFG.PASSWORD_MIN_LENGTH]: [8, 72],
  [CFG.AVATAR_MAX_FILE_SIZE]: [1024, 16 * 1024 * 1024],
  [CFG.AVATAR_OUTPUT_SIZE]: [16, 2048],
  [CFG.AVATAR_QUALITY]: [1, 100],
  [CFG.SYNC_MAX_RECORDS]: [1, 10_000],
  [CFG.SYNC_MAX_TOMBSTONES]: [1, 10_000],
  [CFG.SYNC_BODY_MAX_SIZE]: [1024, 16 * 1024 * 1024],
  [CFG.SYNC_PULL_DEFAULT_LIMIT]: [1, 10_000],
  [CFG.SYNC_PULL_MAX_LIMIT]: [1, 10_000],
  [CFG.CLOUD_SYNC_GLOBALLY_ENABLED]: [0, 1],
  [CFG.CLOUD_STAR_CACHE_TTL_HOURS]: [0, 168],
  [CFG.UPLOAD_TIMESTAMP_WINDOW_MS]: [1000, 15 * 60 * 1000],
  [CFG.DEVICE_AUTH_EXPIRY_MINUTES]: [1, 60],
  [CFG.DEVICE_AUTH_POLL_INTERVAL_SECONDS]: [1, 60],
  [CFG.SESSION_DURATION_DAYS]: [1, 365],
  [CFG.OAUTH_STATE_MAX_AGE_SECONDS]: [30, 3600],
  [CFG.NONCE_RETENTION_MINUTES]: [1, 1440],
  [CFG.RETENTION_NONCE_HOURS]: [1, 720],
  [CFG.RETENTION_SYNC_BATCH_DAYS]: [1, 3650],
  [CFG.RETENTION_TOMBSTONE_DAYS]: [1, 3650],
  [CFG.RETENTION_DEVICE_AUTH_HOURS]: [0, 168],
}

export function isValidConfigValue(key: string, value: unknown): value is number {
  if (!Object.hasOwn(CONFIG_BOUNDS, key) || typeof value !== 'number' || !Number.isSafeInteger(value)) return false
  const [min, max] = CONFIG_BOUNDS[key]
  return value >= min && value <= max
}

export async function setConfigsAtomically(entries: Record<string, number>, userId: string): Promise<void> {
  if (!Object.keys(entries).length || Object.entries(entries).some(([key, value]) => !isValidConfigValue(key, value))) throw error(400, 'Invalid configuration value')
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('site-config'))`
    const rows = await tx`SELECT key, value FROM site_config FOR UPDATE`
    const merged = { ...DEFAULTS }
    for (const row of rows) merged[row.key as string] = row.value as number
    Object.assign(merged, entries)
    for (const [minKey, maxKey] of [[CFG.USERNAME_MIN_LENGTH, CFG.USERNAME_MAX_LENGTH], [CFG.DISPLAY_NAME_MIN_LENGTH, CFG.DISPLAY_NAME_MAX_LENGTH], [CFG.SYNC_PULL_DEFAULT_LIMIT, CFG.SYNC_PULL_MAX_LIMIT]]) {
      if (merged[minKey] > merged[maxKey]) throw error(400, 'Minimum configuration value exceeds maximum')
    }
    for (const [key, value] of Object.entries(entries)) await tx`
      INSERT INTO site_config (key, value, description, updated_at, updated_by)
      VALUES (${key}, ${value}, ${CONFIG_DESCRIPTIONS[key] ?? null}, NOW(), ${userId})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by
    `
    await tx`INSERT INTO admin_audit_logs (id, admin_user_id, action, target_type, target_id, reason, metadata)
      VALUES (${nanoid()}, ${userId}, 'update_config', 'site_config', 'batch', 'Updated configuration', ${JSON.stringify({ configs: entries })}::jsonb)`
  })
  // Never populate the process cache with a rolled-back batch.
  invalidateConfigCache()
}

// ── Category grouping for admin UI ──
export const CONFIG_CATEGORIES: Record<string, { label: string; label_zh: string; keys: string[] }> = {
  email: {
    label: 'Email Verification',
    label_zh: '邮箱验证',
    keys: [
      CFG.EMAIL_TOKEN_TTL_HOURS, CFG.EMAIL_IP_LIMIT, CFG.EMAIL_IP_LIMIT_WINDOW_MINUTES,
      CFG.EMAIL_LIMIT, CFG.EMAIL_LIMIT_WINDOW_HOURS, CFG.EMAIL_GLOBAL_LIMIT,
      CFG.EMAIL_GLOBAL_LIMIT_WINDOW_HOURS, CFG.EMAIL_SEND_ATTEMPT_RETENTION_DAYS,
    ],
  },
  profile: {
    label: 'User Profile',
    label_zh: '用户资料',
    keys: [
      CFG.USERNAME_COOLDOWN_DAYS, CFG.USERNAME_MIN_LENGTH, CFG.USERNAME_MAX_LENGTH,
      CFG.DISPLAY_NAME_MIN_LENGTH, CFG.DISPLAY_NAME_MAX_LENGTH, CFG.PASSWORD_MIN_LENGTH,
    ],
  },
  avatar: {
    label: 'Avatar',
    label_zh: '头像',
    keys: [CFG.AVATAR_MAX_FILE_SIZE, CFG.AVATAR_OUTPUT_SIZE, CFG.AVATAR_QUALITY],
  },
  sync: {
    label: 'Data Sync',
    label_zh: '数据同步',
    keys: [
      CFG.CLOUD_SYNC_GLOBALLY_ENABLED,
      CFG.SYNC_MAX_RECORDS, CFG.SYNC_MAX_TOMBSTONES, CFG.SYNC_BODY_MAX_SIZE,
      CFG.SYNC_PULL_DEFAULT_LIMIT, CFG.SYNC_PULL_MAX_LIMIT,
      CFG.CLOUD_STAR_CACHE_TTL_HOURS,
    ],
  },
  session: {
    label: 'Login & Security',
    label_zh: '登录与安全',
    keys: [
      CFG.UPLOAD_TIMESTAMP_WINDOW_MS, CFG.SESSION_DURATION_DAYS, CFG.OAUTH_STATE_MAX_AGE_SECONDS,
      CFG.DEVICE_AUTH_EXPIRY_MINUTES, CFG.DEVICE_AUTH_POLL_INTERVAL_SECONDS,
    ],
  },
  retention: {
    label: 'Data Retention',
    label_zh: '数据保留',
    keys: [
      CFG.NONCE_RETENTION_MINUTES, CFG.RETENTION_NONCE_HOURS,
      CFG.RETENTION_SYNC_BATCH_DAYS,
      CFG.RETENTION_TOMBSTONE_DAYS, CFG.RETENTION_DEVICE_AUTH_HOURS,
    ],
  },
}

// ── Descriptions for admin UI ──
export const CONFIG_DESCRIPTIONS: Record<string, string> = {
  [CFG.EMAIL_TOKEN_TTL_HOURS]:           'How long a verification link stays valid (hours)',
  [CFG.EMAIL_IP_LIMIT]:                  'Max verification emails one IP can request',
  [CFG.EMAIL_IP_LIMIT_WINDOW_MINUTES]:   'Time window for IP email limit (minutes)',
  [CFG.EMAIL_LIMIT]:                     'Max verification emails per email address',
  [CFG.EMAIL_LIMIT_WINDOW_HOURS]:        'Time window for per-email limit (hours)',
  [CFG.EMAIL_GLOBAL_LIMIT]:              'Max verification emails site-wide',
  [CFG.EMAIL_GLOBAL_LIMIT_WINDOW_HOURS]: 'Time window for site-wide email limit (hours)',
  [CFG.EMAIL_SEND_ATTEMPT_RETENTION_DAYS]: 'Keep email send logs for this many days',

  [CFG.USERNAME_COOLDOWN_DAYS]:   'Days before a user can change username again',
  [CFG.USERNAME_MIN_LENGTH]:      'Minimum characters for username',
  [CFG.USERNAME_MAX_LENGTH]:      'Maximum characters for username',
  [CFG.DISPLAY_NAME_MIN_LENGTH]:  'Minimum characters for display name',
  [CFG.DISPLAY_NAME_MAX_LENGTH]:  'Maximum characters for display name',
  [CFG.PASSWORD_MIN_LENGTH]:      'Minimum characters for password',

  [CFG.AVATAR_MAX_FILE_SIZE]: 'Maximum file size for avatar upload (MB)',
  [CFG.AVATAR_OUTPUT_SIZE]:   'Avatar image output size in pixels',
  [CFG.AVATAR_QUALITY]:       'Avatar compression quality (1-100)',

  [CFG.SYNC_MAX_RECORDS]:        'Max records per sync push from CLI',
  [CFG.SYNC_MAX_TOMBSTONES]:     'Max deleted record markers per sync',
  [CFG.SYNC_BODY_MAX_SIZE]:      'Max request body size for sync (MB)',
  [CFG.SYNC_PULL_DEFAULT_LIMIT]: 'Default number of records returned per sync pull',
  [CFG.SYNC_PULL_MAX_LIMIT]:     'Maximum records allowed per sync pull',
  [CFG.CLOUD_STAR_CACHE_TTL_HOURS]: 'How long to cache GitHub star check results (hours)',
  [CFG.CLOUD_SYNC_GLOBALLY_ENABLED]: 'Enable or disable AIUsage Cloud globally (1=on, 0=off)',

  [CFG.UPLOAD_TIMESTAMP_WINDOW_MS]:     'Allowed time drift for upload signatures (sec)',



  [CFG.DEVICE_AUTH_EXPIRY_MINUTES]: 'How long a CLI login code stays valid (minutes)',
  [CFG.DEVICE_AUTH_POLL_INTERVAL_SECONDS]: 'How often the CLI checks if login is approved (seconds)',

  [CFG.SESSION_DURATION_DAYS]: 'How long a user stays logged in (days)',
  [CFG.OAUTH_STATE_MAX_AGE_SECONDS]: 'How long a third-party login link stays valid (seconds)',
  [CFG.NONCE_RETENTION_MINUTES]: 'How often expired upload tokens are cleaned up (minutes)',

  [CFG.RETENTION_NONCE_HOURS]:         'Keep upload tokens for this many hours',
  [CFG.RETENTION_SYNC_BATCH_DAYS]:     'Keep sync history for this many days',
  [CFG.RETENTION_TOMBSTONE_DAYS]:      'Permanently delete removed records after this many days',
  [CFG.RETENTION_DEVICE_AUTH_HOURS]:   'Clean up expired CLI login codes after this many hours',
}

export const CONFIG_DESCRIPTIONS_ZH: Record<string, string> = {
  [CFG.EMAIL_TOKEN_TTL_HOURS]:           '验证链接在多少小时内有效',
  [CFG.EMAIL_IP_LIMIT]:                  '同一 IP 最多可发送几封验证邮件',
  [CFG.EMAIL_IP_LIMIT_WINDOW_MINUTES]:   'IP 发送限制的时间窗口（分钟）',
  [CFG.EMAIL_LIMIT]:                     '同一邮箱最多可收到几封验证邮件',
  [CFG.EMAIL_LIMIT_WINDOW_HOURS]:        '单邮箱发送限制的时间窗口（小时）',
  [CFG.EMAIL_GLOBAL_LIMIT]:              '全站最多同时发送多少封验证邮件',
  [CFG.EMAIL_GLOBAL_LIMIT_WINDOW_HOURS]: '全站发送限制的时间窗口（小时）',
  [CFG.EMAIL_SEND_ATTEMPT_RETENTION_DAYS]: '邮件发送日志保留几天',

  [CFG.USERNAME_COOLDOWN_DAYS]:   '修改用户名后需要等待几天才能再次修改',
  [CFG.USERNAME_MIN_LENGTH]:      '用户名最少几个字符',
  [CFG.USERNAME_MAX_LENGTH]:      '用户名最多几个字符',
  [CFG.DISPLAY_NAME_MIN_LENGTH]:  '显示名称最少几个字符',
  [CFG.DISPLAY_NAME_MAX_LENGTH]:  '显示名称最多几个字符',
  [CFG.PASSWORD_MIN_LENGTH]:      '密码最少几个字符',

  [CFG.AVATAR_MAX_FILE_SIZE]: '头像文件最大多少 MB',
  [CFG.AVATAR_OUTPUT_SIZE]:   '头像输出尺寸（像素）',
  [CFG.AVATAR_QUALITY]:       '头像压缩质量（1-100）',

  [CFG.SYNC_MAX_RECORDS]:        'CLI 单次同步最多推送几条记录',
  [CFG.SYNC_MAX_TOMBSTONES]:     '单次同步最多推送几条删除标记',
  [CFG.SYNC_BODY_MAX_SIZE]:      '同步请求体最大多少 MB',
  [CFG.SYNC_PULL_DEFAULT_LIMIT]: '同步拉取时默认返回几条',
  [CFG.SYNC_PULL_MAX_LIMIT]:     '同步拉取时最多返回几条',
  [CFG.CLOUD_STAR_CACHE_TTL_HOURS]: 'GitHub Star 检查结果缓存多少小时',
  [CFG.CLOUD_SYNC_GLOBALLY_ENABLED]: '全局启用或禁用 AIUsage Cloud（1=开启，0=关闭）',

  [CFG.UPLOAD_TIMESTAMP_WINDOW_MS]:     '上传签名允许的时间偏差（秒）',



  [CFG.DEVICE_AUTH_EXPIRY_MINUTES]: 'CLI 登录码在几分钟内有效',
  [CFG.DEVICE_AUTH_POLL_INTERVAL_SECONDS]: 'CLI 每隔几秒检查一次登录是否通过',

  [CFG.SESSION_DURATION_DAYS]: '用户登录后保持几天免登录',
  [CFG.OAUTH_STATE_MAX_AGE_SECONDS]: '第三方登录链接在几秒内有效',
  [CFG.NONCE_RETENTION_MINUTES]: '每隔几分钟清理过期的上传令牌',

  [CFG.RETENTION_NONCE_HOURS]:         '上传令牌保留几小时后自动清理',
  [CFG.RETENTION_SYNC_BATCH_DAYS]:     '同步历史记录保留几天',
  [CFG.RETENTION_TOMBSTONE_DAYS]:      '已删除的记录在几天后彻底清除',
  [CFG.RETENTION_DEVICE_AUTH_HOURS]:   '过期的 CLI 登录码在几小时后清理',
}

// ── Units for admin UI ──
export const CONFIG_UNITS: Record<string, { en: string; zh: string }> = {
  [CFG.EMAIL_TOKEN_TTL_HOURS]:           { en: 'hours', zh: '小时' },
  [CFG.EMAIL_IP_LIMIT_WINDOW_MINUTES]:   { en: 'min', zh: '分钟' },
  [CFG.EMAIL_LIMIT_WINDOW_HOURS]:        { en: 'hours', zh: '小时' },
  [CFG.EMAIL_GLOBAL_LIMIT_WINDOW_HOURS]: { en: 'hours', zh: '小时' },
  [CFG.EMAIL_SEND_ATTEMPT_RETENTION_DAYS]: { en: 'days', zh: '天' },

  [CFG.USERNAME_COOLDOWN_DAYS]:   { en: 'days', zh: '天' },

  [CFG.AVATAR_MAX_FILE_SIZE]: { en: 'MB', zh: 'MB' },
  [CFG.AVATAR_OUTPUT_SIZE]:   { en: 'px', zh: 'px' },

  [CFG.SYNC_BODY_MAX_SIZE]:      { en: 'MB', zh: 'MB' },
  [CFG.CLOUD_STAR_CACHE_TTL_HOURS]: { en: 'hours', zh: '小时' },

  [CFG.UPLOAD_TIMESTAMP_WINDOW_MS]:     { en: 'sec', zh: '秒' },



  [CFG.DEVICE_AUTH_EXPIRY_MINUTES]: { en: 'min', zh: '分钟' },
  [CFG.DEVICE_AUTH_POLL_INTERVAL_SECONDS]: { en: 'sec', zh: '秒' },

  [CFG.SESSION_DURATION_DAYS]: { en: 'days', zh: '天' },
  [CFG.OAUTH_STATE_MAX_AGE_SECONDS]: { en: 'sec', zh: '秒' },
  [CFG.NONCE_RETENTION_MINUTES]: { en: 'min', zh: '分钟' },

  [CFG.RETENTION_NONCE_HOURS]:         { en: 'hours', zh: '小时' },
  [CFG.RETENTION_SYNC_BATCH_DAYS]:     { en: 'days', zh: '天' },
  [CFG.RETENTION_TOMBSTONE_DAYS]:      { en: 'days', zh: '天' },
  [CFG.RETENTION_DEVICE_AUTH_HOURS]:   { en: 'hours', zh: '小时' },
}

// ── Display multiplier for admin UI ──
// When set, the admin UI divides the stored value by this number for display,
// and multiplies back when saving. E.g. 1048576 bytes → 1 MB in UI.
export const CONFIG_DISPLAY_MULTIPLIER: Record<string, number> = {
  [CFG.AVATAR_MAX_FILE_SIZE]:      1024 * 1024,  // bytes → MB
  [CFG.SYNC_BODY_MAX_SIZE]:        1024 * 1024,  // bytes → MB
  [CFG.UPLOAD_TIMESTAMP_WINDOW_MS]: 1000,         // ms → sec
}

export function getDefaultValue(key: string): number {
  return DEFAULTS[key] ?? 0
}

export async function getConfigValue(key: string): Promise<number> {
  return getConfig(key, DEFAULTS[key] ?? 0)
}

// Sync version for hot paths that already cached via getConfigSync
export { getConfigSync }
