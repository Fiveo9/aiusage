import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compile } from 'svelte/compiler'
import * as internal from 'svelte/internal'
import { describe, expect, it } from 'vitest'
import { lang, t } from '../src/lib/i18n.js'
import { formatCost, formatNumber, formatTokens } from '../src/lib/stores.js'
import { createRequestTracker } from '../src/lib/sessions-paging.js'

const source = readFileSync(fileURLToPath(new URL('../src/lib/components/CostProvenance.svelte', import.meta.url)), 'utf8')
const compiled = compile(source, {generate:'ssr',filename:'CostProvenance.svelte'}).js.code
const runnable = compiled.replace(/import \{([\s\S]*?)\} from ["']([^"']+)["'];?/g, (_, names, module) => {
  const dependency = module === 'svelte/internal' ? 'internal' : module.includes('i18n') ? 'i18n' : 'stores'
  return `const {${names}} = ${dependency};`
}).replace(/export default ([\w$]+);?/, 'return $1;')
const Component = new Function('internal','i18n','stores',runnable)(internal,{t},{formatCost,formatNumber,formatTokens})
const mixed = {
  totalRecords:3,knownRecords:2,coverage:2/3,
  sources:{log:{records:1,cost:2},pricing:{records:1,cost:0},unknown:{records:1,cost:0}},
  unpricedModels:[{model:'provider/<missing>',records:1,tokens:100}],
}

describe('cost provenance rendering', () => {
  it('explains sources, coverage and unpriced models in Chinese without treating unknown as free', () => {
    lang.set('zh')
    const {html} = Component.render({provenance:mixed})
    expect(html).toContain('66.7%')
    expect(html).toContain('日志记录费用')
    expect(html).toContain('定价估算')
    expect(html).toContain('未计价')
    expect(html).toContain('不一定等于实际账单')
    expect(html).toContain('缺少价格不代表免费')
    expect(html).toContain('provider/&lt;missing')
    expect(html).not.toContain('provider/<missing>')
    expect(html).toContain('href="/pricing"')
    expect(html).toContain('$0.0000') // known zero remains a numeric cost
  })
  it('renders no unpriced notice when all records are covered and supports English', () => {
    lang.set('en')
    const {html} = Component.render({provenance:{...mixed,totalRecords:2,coverage:1,sources:{...mixed.sources,unknown:{records:0,cost:0}},unpricedModels:[]}})
    expect(html).toContain('100.0%')
    expect(html).toContain('Logged cost')
    expect(html).not.toContain('href="/pricing"')
  })
  it('renders an empty denominator as unavailable instead of 100 percent or NaN', () => {
    const {html} = Component.render({provenance:{...mixed,totalRecords:0,knownRecords:0,coverage:null,sources:{log:{records:0,cost:0},pricing:{records:0,cost:0},unknown:{records:0,cost:0}},unpricedModels:[]}})
    expect(html).toContain('—'); expect(html).not.toContain('NaN'); expect(html).not.toContain('100.0%')
    expect(Component.render({provenance:undefined}).html).toBe('')
  })
})

it('cost page ignores a late filter response and responses after unmount', async () => {
  const page = readFileSync(fileURLToPath(new URL('../src/routes/cost/+page.svelte', import.meta.url)), 'utf8')
  const script = page.split('<script>')[1].split('</script>')[0].replace(/^\s*import .*$/gm,'').replace(/^\s*\$:.*$/gm,'')
  const requests: any[] = []
  let destroy: any
  const factory = new Function('onDestroy','fetchCost','createRequestTracker',`
    let $dateRange={range:'all'}, $selectedDevice='', $selectedTool='';
    ${script}
    return {load:loadData,state:()=>({data,loading,error})};
  `)
  const instance = factory((cb: any)=>destroy=cb,()=>new Promise(resolve=>requests.push(resolve)),createRequestTracker)
  const first = instance.load(); const second = instance.load()
  requests[1]({provenance:{totalRecords:2}}); await second
  requests[0]({provenance:{totalRecords:999}}); await first
  expect(instance.state()).toMatchObject({data:{provenance:{totalRecords:2}},loading:false})
  const third = instance.load(); destroy(); requests[2]({provenance:{totalRecords:1000}}); await third
  expect(instance.state().data.provenance.totalRecords).toBe(2)
})
