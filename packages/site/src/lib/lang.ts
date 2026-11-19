import { writable } from 'svelte/store'

function createLangStore() {
  const { subscribe, update } = writable<'zh' | 'en'>('zh')

  return {
    subscribe,
    toggle: () => update(v => v === 'zh' ? 'en' : 'zh')
  }
}

export const lang = createLangStore()
