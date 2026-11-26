// Production-web browser regression using synthetic API responses only.
// Run with the workspace Electron executable; no real service or usage data.
const { app, BrowserWindow } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const runId = process.env.AIUSAGE_UI_RUN
if (!/^[a-f0-9]{32}$/.test(runId || '')) throw Error('A unique isolated UI run is required')
if (process.env.AIUSAGE_UI_GUARD) require(process.env.AIUSAGE_UI_GUARD)
const output = path.join(root, '.artifacts', 'sessions-browser', runId)
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.mkdirSync(output, { recursive: false })
const profile = process.env.AIUSAGE_UI_PROFILE || path.join(output, 'profile')
app.setPath('userData', profile)
app.disableHardwareAcceleration()
// Scenarios replace the hidden window; only the final app.exit ends the run.
app.on('window-all-closed', () => {})
const build = path.join(root, 'packages/web/build')
const requests = []
const errors = []
const checks = []
const screenshots = []
const blockedRequests = []
const exceptions = []
let authDelay = 400
let locked = false
let signedIn = false
let invalidAuth = false
let costScenario = 'initial'
let config = { displayCurrency: 'USD', exchangeRate: null }
const savedConfigs = []
const records = [
  { sessionId:'fixture-named', sessionTitle:'Synthetic saved title',deviceInstanceId:'fixture-device',tool:'codex',model:'fixture-model',ts:1700000000000,duration:1000,inputTokens:100,outputTokens:20,cost:1,toolCallCount:0 },
  { sessionId:'fixture-unnamed',deviceInstanceId:'fixture-device',tool:'codex',model:'fixture-model',ts:1700000000001,duration:1000,inputTokens:100,outputTokens:20,cost:2,toolCallCount:0 },
]
const server = http.createServer((req,res) => {
  const url = new URL(req.url, 'http://localhost')
  const send = body => { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(body)) }
  if (url.pathname.startsWith('/api/')) {
    requests.push(url.pathname + url.search)
    if (url.pathname === '/api/auth/status') return setTimeout(()=>send(invalidAuth ? {} : {enabled:locked,authenticated:signedIn}),authDelay)
    if (url.pathname === '/api/auth/login') { signedIn=true; req.resume(); return send({ok:true}) }
    if (url.pathname === '/api/config') {
      if (req.method === 'PUT') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => { const value = JSON.parse(body); savedConfigs.push(value); config = { ...config, ...value }; send({ ok: true }) })
        return
      }
      return send(config)
    }
    if (url.pathname === '/api/detected-tools') return send({ tools: [] })
    if (url.pathname === '/api/sync') return send({ status: { isRunning: false } })
    if (url.pathname === '/api/devices') return send({devices:[]})
    if (url.pathname === '/api/tools') return send({tools:[{tool:'codex',sessionCount:2}]})
    if (url.pathname === '/api/cost') {
      const stale = costScenario === 'race' && url.searchParams.get('range') === 'day'
      const value = stale ? 99 : costScenario === 'initial' ? 3 : 12
      return setTimeout(() => send({ data: [{date:'2026-11-20',cost:value / 3}, {date:'2026-11-21',cost:value * 2 / 3}],
        byTool:{codex:value * 0.75,claude:value * 0.25},byModel:{'fixture-model':value} }), stale ? 650 : 120)
    }
    if (url.pathname === '/api/sessions') {
      const q = (url.searchParams.get('q') || '').toLowerCase()
      const sessions=records.filter(r=>(r.sessionTitle||'').toLowerCase().includes(q)||r.sessionId.includes(q))
      const order=url.searchParams.get('sort')
      if(order==='cost') sessions.sort((a,b)=>b.cost-a.cost)
      return send({sessions,total:sessions.length,page:Number(url.searchParams.get('page')||1),pageSize:50})
    }
    return send({})
  }
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  let file = path.resolve(build,relative)
  if (!file.startsWith(build + path.sep) && file !== build) { res.writeHead(403);res.end();return }
  if (!fs.existsSync(file)||!fs.statSync(file).isFile()) file=path.join(build,'index.html')
  const type={'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.svg':'image/svg+xml'}[path.extname(file)]||'application/octet-stream'
  res.writeHead(200,{'Content-Type':type});res.end(fs.readFileSync(file))
})
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms))
let window
async function evaluate(script) { return window.webContents.executeJavaScript(`{${script}\n}`, true) }
async function until(script, message, timeout=8000) {
  const deadline=Date.now()+timeout
  while(Date.now()<deadline) { if(await evaluate(script)) return; await delay(50) }
  throw Error(message)
}
async function ready(label) {
  await until("document.querySelector('.session-search button')?.disabled === false && document.querySelector('.activity-session-title') !== null",label)
  checks.push(label)
}
async function screenshot(name) {
  await delay(350)
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  fs.writeFileSync(path.join(output, `${name}.png`), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(), { flag: 'wx' })
  screenshots.push(`${name}.png`)
}
async function newWindow(base,url) {
  window=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,partition:`sessions-${Date.now()}`}})
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(base + '/') || details.url.startsWith('data:') || details.url.startsWith('blob:' + base + '/')
    if (!allowed) blockedRequests.push(new URL(details.url).origin)
    callback({ cancel: !allowed })
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('console-message',(_event,level,message,line,source)=>{if(level===3) errors.push(`${message} (${source}:${line})`)})
  window.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(base+'/'))event.preventDefault()})
  await window.loadURL(base+url)
  window.webContents.debugger.attach('1.3')
  window.webContents.debugger.on('message', (_event, method, params) => {
    if (method === 'Runtime.exceptionThrown') exceptions.push(params.exceptionDetails)
  })
  await window.webContents.debugger.sendCommand('Runtime.enable')
}
(async()=>{
  let exit=0
  try {
    await app.whenReady()
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
    const base=`http://127.0.0.1:${server.address().port}`
    await newWindow(base,'/sessions')
    if(process.env.AIUSAGE_UI_EXPECT_BUG==='1') {
      await until("document.querySelector('.session-search button') !== null",'Sessions mounted after auth')
      await delay(300)
      const state=await evaluate("({disabled:document.querySelector('.session-search button').disabled,loading:!!document.querySelector('.state-msg'),rows:document.querySelectorAll('.activity-session-title').length})")
      assert.deepEqual(state,{disabled:true,loading:true,rows:0})
      checks.push('Reproduced cold-entry loading with disabled search')
      assert.equal(requests.filter(url=>url.startsWith('/api/sessions')).length,0)
      checks.push('Cold-entry did not request sessions despite healthy API')
      const response=await fetch(base+'/api/sessions?range=all');assert.equal(response.status,200)
      await evaluate("document.querySelector('a[href=\"/cost\"]').click()")
      await until("location.pathname === '/cost'",'Cost navigation')
      await evaluate("document.querySelector('a[href=\"/sessions\"]').click()")
      await ready('Internal navigation works on the original build')
    } else {
      await ready('Cold direct entry after delayed auth')
      assert.equal(requests.filter(url=>url.startsWith('/api/sessions')).length,1)
      checks.push('One initial sessions request')
      const labels=await evaluate("[...document.querySelectorAll('.activity-session-title')].map(e=>e.textContent)")
      assert.equal(labels[0],'Synthetic saved title');assert.match(labels[1],/Unnamed session/)
      checks.push('Saved title and unnamed fallback rendered distinctly')
      await screenshot('sessions-direct')
      await window.loadURL(base+'/sessions?range=all&device=&tool=&q=title&sort=cost&page=1')
      await ready('Direct entry with search and sort URL')
      await until("document.querySelectorAll('.activity-session-title').length===1",'Search applied on direct entry')
      await new Promise(resolve=>{window.webContents.once('did-finish-load',resolve);window.webContents.reload()})
      await ready('Browser reload with preserved query')
      await evaluate("const e=document.querySelector('#session-search');e.value='fixture';e.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.session-search').requestSubmit()")
      await until("new URL(location.href).searchParams.get('q')==='fixture' && document.querySelectorAll('.activity-session-title').length===2",'Search submit works')
      checks.push('Search submit after reload')
      await evaluate("history.back()")
      await until("new URL(location.href).searchParams.get('q')==='title' && document.querySelectorAll('.activity-session-title').length===1",'Back restores query')
      checks.push('Browser back restores search')
      await evaluate("document.querySelector('a[href=\"/cost\"]').click()")
      await until("location.pathname==='/cost'",'Cost navigation')
      await evaluate("document.querySelector('a[href=\"/sessions\"]').click()")
      await ready('Internal navigation remains functional')
      authDelay=0
      await window.loadURL(base+'/sessions?range=all&device=&tool=&sort=newest&page=1')
      await ready('Cold direct entry with immediate auth response')
      window.destroy();window=null
      locked=true;signedIn=false
      await newWindow(base,'/sessions')
      await until("document.querySelector('.auth-card input') !== null",'Login page')
      await evaluate("const e=document.querySelector('.auth-card input');e.value='synthetic';e.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.auth-card form').requestSubmit()")
      await ready('Direct entry after explicit login')
      await evaluate("document.querySelector('a[href=\"/cost\"]').click()")
      await until("document.querySelector('.kpi-value')?.textContent === '$3.00'", 'Initial async cost rendered')
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.kpi-value')].map(e=>e.textContent)"), ['$3.00', '$1.50', '$2.00'])
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.row-share')].map(e=>e.textContent)"), ['75.0%', '25.0%', '100.0%'])
      checks.push('Async cost total, daily average, peak and shares use loaded data')
      costScenario = 'race'
      await evaluate("document.querySelectorAll('.date-range .segmented-btn')[0].click()")
      await delay(80)
      await evaluate("document.querySelectorAll('.date-range .segmented-btn')[1].click()")
      await until("document.querySelector('.kpi-value')?.textContent === '$12.00'", 'Latest cost response rendered')
      await delay(750)
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.kpi-value')].map(e=>e.textContent)"), ['$12.00', '$6.00', '$8.00'])
      checks.push('Late previous filter response cannot overwrite current cost KPIs')
      await screenshot('cost-usd')
      await evaluate("document.querySelector('a[href=\"/settings\"]').click()")
      await until("!!document.querySelector('#field-display-currency')", 'Settings rendered')
      await evaluate("const e=document.querySelector('#field-display-currency');e.value='CNY';e.dispatchEvent(new Event('change',{bubbles:true}))")
      await until("!!document.querySelector('#field-exchange-rate')", 'CNY exchange rate field rendered')
      await evaluate("const e=document.querySelector('#field-exchange-rate');e.value='8';e.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.btn-save').click()")
      await until("!!document.querySelector('.btn-save.saved')", 'Currency saved')
      assert.equal(savedConfigs.length, 1)
      assert.equal(savedConfigs[0].displayCurrency, 'CNY')
      assert.equal(savedConfigs[0].exchangeRate, 0.125)
      await evaluate("document.querySelector('a[href=\"/cost\"]').click()")
      await until("document.querySelector('.kpi-value')?.textContent.includes('96.00')", 'CNY value rendered')
      const cny = await evaluate("[...document.querySelectorAll('.kpi-value')].map(e=>e.textContent)")
      assert.deepEqual(cny.map(value => value.replace(/[^0-9.]/g, '')), ['96.00', '48.00', '64.00'])
      assert.ok(cny.every(value => /^[¥￥]/.test(value)))
      checks.push('Real settings save and navigation update CNY totals with the correct reciprocal rate')
      await screenshot('cost-cny')
      window.setSize(390, 844)
      await until("innerWidth <= 390 && document.querySelector('.main-area').getBoundingClientRect().left < 1", 'Mobile content clears sidebar offset')
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), true)
      await screenshot('cost-mobile')
      checks.push('Mobile cost content clears sidebar offset and has no page-level horizontal overflow')
      window.setSize(1280, 900)
      await evaluate("document.querySelector('a[href=\"/sessions\"]').click()")
      await ready('Sessions remain renderable after currency change')
      assert.deepEqual(await evaluate("[...document.querySelectorAll('tbody tr td:last-child')].map(e=>e.textContent)"), ['¥8.00', '¥16.00'])
      checks.push('Session cost cells subscribe to the current currency formatter')
      window.destroy(); window = null
      invalidAuth = true
      const beforeAuthFailure = requests.filter(url => url.startsWith('/api/sessions')).length
      await newWindow(base, '/sessions')
      await until("!!document.querySelector('.auth-error[role=alert]')", 'Invalid auth status blocks protected page')
      assert.equal(requests.filter(url => url.startsWith('/api/sessions')).length, beforeAuthFailure)
      await screenshot('auth-error')
      invalidAuth = false
      await evaluate("document.querySelector('.auth-card .btn-primary').click()")
      await ready('Authentication status error recovers through the actual Retry button')
      checks.push('Failed authentication status never mounted protected sessions')
    }
    assert.deepEqual(errors,[])
    assert.deepEqual(exceptions,[])
    assert.deepEqual(blockedRequests,[])
    checks.push('No browser console errors')
  } catch(error) { exit=1;errors.push(error.message); if (window) await screenshot('failure').catch(() => {}) }
  finally {
    if(window)window.destroy()
    await new Promise(resolve=>server.close(resolve))
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({status:exit?'failed':'passed',checks,errors,exceptions,requests,blockedRequests,screenshots,
      runtime:process.versions,productionBuild:build,syntheticApi:true,hiddenWindow:true},null,2))
    console.log(JSON.stringify({status:exit?'failed':'passed',checks,errors,output}))
    app.exit(exit)
  }
})()
