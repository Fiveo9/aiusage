import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse } from 'svelte/compiler'
import { readApiResponse } from '../../src/lib/api-response.js'

// Execute the actual page function, with its browser dependencies replaced.
// This is a function-state regression, not a browser qualification.
function pageFunction(page: string, name: string): string {
  const source = readFileSync(new URL(`../../src/routes/${page}/+page.svelte`, import.meta.url), 'utf8')
  const node = (parse(source).instance?.content.body as any[]).find(node => node.type === 'FunctionDeclaration' && node.id.name === name)
  if (!node) throw new Error(`Missing page function ${name}`)
  return source.slice(node.start, node.end)
}
function controller(page: string, name: string, setup: string, expose: string, fixtures: unknown) {
  return new Function('fixtures', 'readApiResponse', `const fetch=fixtures.fetch; const csrfHeaders=()=>({}); const zh=false; ${setup}; ${pageFunction(page, name)}; return ${expose}`)(fixtures, readApiResponse)
}

describe('site page state boundaries', () => {
  it('submits only changed configuration keys and records exactly the saved snapshot', async () => {
    let resolve!: (response: Response) => void
    const pending = new Promise<Response>(r => { resolve = r })
    const fetch = vi.fn((_url: string, _init?: RequestInit) => pending)
    const configs = { quality: { value: 85 }, unchanged: { value: 8 } }
    const api = controller('admin', 'saveConfigs',
      'let configSaving=false, actionError="", actionFeedback=""; const configs=fixtures.configs; let originalConfigValues={quality:80, unchanged:8}',
      '{run:saveConfigs, original:()=>originalConfigValues}', { fetch, configs })
    const run = api.run()
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ configs: { quality: 85 } })
    configs.quality.value = 90
    resolve(Response.json({ updated: ['quality'] }))
    await run
    expect(api.original()).toEqual({ quality: 85, unchanged: 8 })
    expect(configs.quality.value).toBe(90)
  })

  it('updates profile state without changing unrelated fields', async () => {
    const fetch = vi.fn(async () => Response.json({ username: 'new-owner', display_name: 'New Owner', username_changed_at: '2026-11-22T00:00:00Z' }))
    const api = controller('settings', 'handleProfileSave',
      'let profileMsg="", profileError="", profileSaving=false, editUsername="new-owner", editDisplayName="New Owner"; let me={email:"owner@example.test",has_password:true,email_verified:true,avatar_url:"synthetic-avatar"}; const getError=x=>x',
      '{run:handleProfileSave, state:()=>me}', { fetch })
    await api.run()
    expect(api.state()).toMatchObject({ username: 'new-owner', email: 'owner@example.test', has_password: true, email_verified: true, avatar_url: 'synthetic-avatar' })
  })

  it('does not show an old approval for a newly entered device code', async () => {
    let resolve!: (response: Response) => void
    const pending = new Promise<Response>(r => { resolve = r })
    const fetch = vi.fn(() => pending)
    const api = controller('cli/authorize', 'approveDevice',
      'let userCode="ABCD-EFGH", loading=false, error="", approvedCode="", notLoggedIn=false',
      '{run:approveDevice, setCode:value=>{userCode=value}, state:()=>({approvedCode,loading,error})}', { fetch })
    const run = api.run()
    await api.run()
    expect(fetch).toHaveBeenCalledTimes(1)
    api.setCode('JKLM-NPQR')
    resolve(Response.json({ success: true }))
    await run
    expect(api.state()).toEqual({ approvedCode: '', loading: false, error: '' })
  })
})
