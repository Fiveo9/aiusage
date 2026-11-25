export type Locale = 'en' | 'zh'

export interface Translations {
  today: string
  lastNDays: (n: number) => string
  tokenBreakdown: string
  tokenBreakdownToday: string
  tokenInput: string
  tokenOutput: string
  tokenCacheRead: string
  tokenCacheWrite: string
  tokenThinking: string
  noTokenData: string
  dataUnavailable: string
  trend: string
  topModel: string
  topTool: string
  sessions: string
  settings: string
  theme: string
  timeRange: string
  refreshInterval: string
  display: string
  currency: string
  exchangeRate: string
  exchangeRateUpdated: (time: string) => string
  exchangeRateUnavailable: string
  language: string
  showCost: string
  tokenBreakdownToggle: string
  activityChart: string
  syncedAt: (time: string) => string
  themeSystem: string
  themeLight: string
  themeDark: string
  showPanel: string
  openDashboard: string
  refresh: string
  quit: string
  close: string
  installTitle: string
  installPreparing: string
  installInstalling: string
  installLaunching: string
  installDone: string
  installFailed: string
  setupTitle: string
  setupChecking: string
  setupParsing: string
  setupDone: string
  setupFailed: string
}

const en: Translations = {
  today: 'Today',
  lastNDays: (n) => `Last ${n} days`,
  tokenBreakdown: 'Token breakdown',
  tokenBreakdownToday: 'Token breakdown (Today)',
  tokenInput: 'Input',
  tokenOutput: 'Output',
  tokenCacheRead: 'Cache R',
  tokenCacheWrite: 'Cache W',
  tokenThinking: 'Think',
  noTokenData: 'No token data',
  dataUnavailable: 'Usage data unavailable. Try refreshing.',
  trend: 'Trend',
  topModel: 'Top Model',
  topTool: 'Top Tool',
  sessions: 'Sessions',
  settings: 'Settings',
  theme: 'Theme',
  timeRange: 'Time range',
  refreshInterval: 'Refresh interval',
  display: 'Display',
  currency: 'Currency',
  exchangeRate: 'Exchange rate',
  exchangeRateUpdated: (time) => `Updated ${time}`,
  exchangeRateUnavailable: 'Exchange rate unavailable',
  language: 'Language',
  showCost: 'Show cost',
  tokenBreakdownToggle: 'Token breakdown',
  activityChart: 'Activity chart',
  syncedAt: (time) => `Synced ${time}`,
  themeSystem: 'System',
  themeLight: 'Light',
  themeDark: 'Dark',
  showPanel: 'Show Panel',
  openDashboard: 'Open Dashboard',
  refresh: 'Refresh',
  quit: 'Quit',
  close: 'Close',
  installTitle: 'Dashboard Setup',
  installPreparing: 'Preparing...',
  installInstalling: 'Installing @fiveo9/aiusage...',
  installLaunching: 'Starting dashboard...',
  installDone: 'Done! Opening...',
  installFailed: 'Installation failed',
  setupTitle: 'First Time Setup',
  setupChecking: 'Checking CLI...',
  setupParsing: 'Parsing usage logs...',
  setupDone: 'Ready!',
  setupFailed: 'Setup failed',
}

const zh: Translations = {
  today: '今日',
  lastNDays: (n) => `近 ${n} 天`,
  tokenBreakdown: 'Token 分布',
  tokenBreakdownToday: 'Token 分布 (今日)',
  tokenInput: '输入',
  tokenOutput: '输出',
  tokenCacheRead: '缓存读取',
  tokenCacheWrite: '缓存写入',
  tokenThinking: '推理',
  noTokenData: '暂无 Token 数据',
  dataUnavailable: '用量数据暂不可用，请尝试刷新。',
  trend: '趋势',
  topModel: '常用模型',
  topTool: '常用工具',
  sessions: '会话数',
  settings: '设置',
  theme: '主题',
  timeRange: '时间范围',
  refreshInterval: '刷新间隔',
  display: '显示',
  currency: '币种',
  exchangeRate: '汇率',
  exchangeRateUpdated: (time) => `更新于 ${time}`,
  exchangeRateUnavailable: '汇率不可用',
  language: '语言',
  showCost: '显示费用',
  tokenBreakdownToggle: 'Token 分布',
  activityChart: '活动图表',
  syncedAt: (time) => `同步于 ${time}`,
  themeSystem: '跟随系统',
  themeLight: '浅色',
  themeDark: '深色',
  showPanel: '显示面板',
  openDashboard: '打开仪表盘',
  refresh: '刷新',
  quit: '退出',
  close: '关闭',
  installTitle: '仪表盘配置',
  installPreparing: '准备中...',
  installInstalling: '正在安装 @fiveo9/aiusage...',
  installLaunching: '正在启动仪表盘...',
  installDone: '完成！正在打开...',
  installFailed: '安装失败',
  setupTitle: '首次配置',
  setupChecking: '检测 CLI...',
  setupParsing: '解析使用日志...',
  setupDone: '就绪！',
  setupFailed: '配置失败',
}

const translations: Record<Locale, Translations> = { en, zh }

export function t(locale: Locale): Translations {
  return translations[locale] ?? translations.en
}
