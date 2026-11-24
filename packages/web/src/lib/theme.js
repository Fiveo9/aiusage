import { writable, get } from 'svelte/store'

const THEME_KEY = 'aiusage-theme'

function getStored() {
  if (typeof window === 'undefined') return 'system'
  try {
    const value = localStorage.getItem(THEME_KEY)
    return ['system', 'light', 'dark'].includes(value) ? value : 'system'
  } catch { return 'system' }
}

function getSystemTheme() {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export const userPref = writable(getStored())
export const resolvedTheme = writable(getSystemTheme())

export function cycleTheme() {
  userPref.update(current => {
    if (current === 'system') return 'dark'
    if (current === 'dark') return 'light'
    return 'system'
  })
}

export function initTheme() {
  if (typeof window === 'undefined') return

  const mq = window.matchMedia('(prefers-color-scheme: dark)')

  function apply(pref) {
    const theme = pref === 'system' ? getSystemTheme() : pref
    document.documentElement.setAttribute('data-theme', theme)
    resolvedTheme.set(theme)
  }

  const unsubscribe = userPref.subscribe(pref => {
    try { localStorage.setItem(THEME_KEY, pref) } catch {}
    apply(pref)
  })

  const onChange = () => {
    const pref = get(userPref)
    if (pref === 'system') {
      apply('system')
    }
  }
  mq.addEventListener('change', onChange)
  return () => { unsubscribe(); mq.removeEventListener('change', onChange) }
}
