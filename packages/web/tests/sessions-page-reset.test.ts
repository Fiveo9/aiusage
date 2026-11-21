import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readSessionQuery, sessionListUrl, sessionFilterKey } from '../src/lib/session-query.js'
import { createRequestTracker, resolvePage } from '../src/lib/sessions-paging.js'

const pageSource = readFileSync(
  fileURLToPath(new URL('../src/routes/sessions/+page.svelte', import.meta.url)),
  'utf8',
)

function harness() {
  const script = pageSource.split('<script>')[1].split('</script>')[0]
    .replace(/^\s*import .*$/gm, '').replace(/^\s*\$:\s*syncFilters.*$/gm, '')
  const requests: any[] = []
  const navigation: any[] = []
  let onNavigate: any
  let onMount: any
  let destroy: any
  const factory = new Function('afterNavigate', 'goto', 'onDestroy', 'onMount', 'fetchSessions', 'readSessionQuery', 'sessionListUrl', 'sessionFilterKey', 'createRequestTracker', 'resolvePage', `
    let $dateRange = {range:'all'}, $selectedDevice = '', $selectedTool = '';
    let $currentPage = {url:new URL('http://local/sessions')};
    const dateRange={set:v=>$dateRange=v}, selectedDevice={set:v=>$selectedDevice=v}, selectedTool={set:v=>$selectedTool=v};
    ${script}
    return { filters:(range,device,tool)=>{ $dateRange=range; $selectedDevice=device; $selectedTool=tool; syncFilters(range,device,tool) },
      submit:(q,s)=>{query=q;sort=s;applySearch()}, nextPage, prevPage, url:url=>$currentPage={url:new URL(url,'http://local')},
      state:()=>({page,data,loading,query,sort,range:$dateRange,device:$selectedDevice,tool:$selectedTool}) };
  `)
  const page = factory((cb: any) => onNavigate = cb, (url: string, options: any) => { navigation.push({url,options}); return Promise.resolve() },
    (cb: any) => destroy = cb, (cb: any) => onMount = cb, (params: any) => new Promise(resolve => requests.push({params,resolve})),
    readSessionQuery, sessionListUrl, sessionFilterKey, createRequestTracker, resolvePage)
  return { page, requests, navigation, mount:(url: string)=>{page.url(url);onMount()}, visit:(url: string)=>onNavigate({to:{url:new URL(url,'http://local')}}), destroy:()=>destroy() }
}

describe('sessions page', () => {
  it('loads after delayed mount without any navigation notification and deduplicates a later callback', () => {
    const h = harness()
    const url = '/sessions?range=all&device=&tool=&sort=newest&page=1'
    h.mount(url)
    expect(h.requests).toHaveLength(1)
    h.visit(url)
    expect(h.requests).toHaveLength(1)
  })

  it('restores search, sort, page and filters on navigation then resets the page on a filter change', () => {
    const h = harness()
    h.visit('/sessions?range=all&device=b&tool=codex&q=title&sort=cost&page=3')
    expect(h.page.state()).toMatchObject({ page:3, query:'title', sort:'cost', device:'b', tool:'codex' })
    expect(h.requests[0].params).toMatchObject({page:3,q:'title',sort:'cost',device:'b'})
    h.page.filters({range:'month'}, 'b', 'codex')
    expect(new URL(h.navigation.at(-1).url, 'http://local').searchParams.get('page')).toBe('1')
    h.visit('/sessions?range=all&device=b&tool=codex&q=title&sort=cost&page=3')
    expect(h.page.state().page).toBe(3)
  })

  it('canonicalizes a bare URL with persisted filters and resets paging when searching', () => {
    const h = harness(); h.visit('/sessions')
    expect(h.navigation[0]).toMatchObject({url:'/sessions?range=all&device=&tool=&sort=newest&page=1',options:{replaceState:true}})
    h.visit(h.navigation[0].url)
    h.page.submit('  查找  ', 'tokens')
    const params = new URL(h.navigation.at(-1).url,'http://local').searchParams
    expect(params.get('q')).toBe('查找'); expect(params.get('page')).toBe('1'); expect(params.get('sort')).toBe('tokens')
  })

  it('ignores old responses, recovers an out-of-range page and ignores responses after unmount', async () => {
    const h = harness()
    h.visit('/sessions?range=all&device=&tool=&sort=newest&page=3')
    h.visit('/sessions?range=all&device=&tool=&q=new&sort=cost&page=2')
    h.requests[1].resolve({sessions:[{sessionId:'new'}],total:100}); await Promise.resolve()
    h.requests[0].resolve({sessions:[],total:1}); await Promise.resolve()
    expect(h.page.state()).toMatchObject({page:2,data:{sessions:[{sessionId:'new'}]}})
    h.visit('/sessions?range=all&device=&tool=&sort=newest&page=5')
    h.requests[2].resolve({sessions:[],total:60}); await Promise.resolve()
    expect(h.navigation.at(-1).url).toContain('page=2')
    h.visit(h.navigation.at(-1).url); h.destroy()
    h.requests[3].resolve({sessions:[{sessionId:'late'}],total:60}); await Promise.resolve()
    expect(h.page.state().data.sessions).toEqual([])
  })
})

describe('session query URLs', () => {
  it('round-trips custom dates and special characters without inherited filters', () => {
    const state = {range:'',from:'2026-11-01',to:'2026-11-20',month:'2026-11',device:'',tool:'',q:'中文 & / %',sort:'tokens',page:4}
    const params = new URL(sessionListUrl(state),'http://local').searchParams
    expect(readSessionQuery(params,{device:'wrong',tool:'wrong'})).toEqual(state)
  })
  it('normalizes invalid sort/page without losing valid search', () => {
    expect(readSessionQuery(new URLSearchParams('q=abc&sort=oops&page=-4'))).toMatchObject({q:'abc',sort:'newest',page:1})
  })
})
