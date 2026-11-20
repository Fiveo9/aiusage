// Production-web browser regression using synthetic API responses only.
// Run with the workspace Electron executable; no real service or usage data.
const { app, BrowserWindow } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const output = path.join(root, '.artifacts', 'sessions-browser', process.env.AIUSAGE_UI_RUN || 'check')
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(output, 'profile'))
app.disableHardwareAcceleration()
// Scenarios replace the hidden window; only the final app.exit ends the run.
app.on('window-all-closed', () => {})
const build = path.join(root, 'packages/web/build')
const requests = []
const errors = []
const checks = []
let authDelay = 400
let locked = false
let signedIn = false
const records = [
  { sessionId:'fixture-named', sessionTitle:'Synthetic saved title',deviceInstanceId:'fixture-device',tool:'codex',model:'fixture-model',ts:1700000000000,duration:1000,inputTokens:100,outputTokens:20,cost:1,toolCallCount:0 },
  { sessionId:'fixture-unnamed',deviceInstanceId:'fixture-device',tool:'codex',model:'fixture-model',ts:1700000000001,duration:1000,inputTokens:100,outputTokens:20,cost:2,toolCallCount:0 },
]
const server = http.createServer((req,res) => {
  const url = new URL(req.url, 'http://localhost')
  const send = body => { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(body)) }
  if (url.pathname.startsWith('/api/')) {
    requests.push(url.pathname + url.search)
    if (url.pathname === '/api/auth/status') return setTimeout(()=>send({enabled:locked,authenticated:signedIn}),authDelay)
    if (url.pathname === '/api/auth/login') { signedIn=true; req.resume(); return send({ok:true}) }
    if (url.pathname === '/api/config') return send({displayCurrency:'USD'})
    if (url.pathname === '/api/devices') return send({devices:[]})
    if (url.pathname === '/api/tools') return send({tools:[{tool:'codex',sessionCount:2}]})
    if (url.pathname === '/api/cost') return send({data:[{date:'2026-11-20',cost:3}],byTool:{codex:3},byModel:{'fixture-model':3}})
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
async function evaluate(script) { return window.webContents.executeJavaScript(script, true) }
async function until(script, message, timeout=8000) {
  const deadline=Date.now()+timeout
  while(Date.now()<deadline) { if(await evaluate(script)) return; await delay(50) }
  throw Error(message)
}
async function ready(label) {
  await until("document.querySelector('.session-search button')?.disabled === false && document.querySelector('.activity-session-title') !== null",label)
  checks.push(label)
}
async function newWindow(base,url) {
  window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,partition:`sessions-${Date.now()}`}})
  window.webContents.on('console-message',(_event,level,message)=>{if(level===3) errors.push(message)})
  window.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(base+'/'))event.preventDefault()})
  await window.loadURL(base+url)
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
    }
    assert.deepEqual(errors,[])
    checks.push('No browser console errors')
  } catch(error) { exit=1;errors.push(error.message) }
  finally {
    if(window)window.destroy()
    await new Promise(resolve=>server.close(resolve))
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({status:exit?'failed':'passed',checks,errors,requests},null,2))
    console.log(JSON.stringify({status:exit?'failed':'passed',checks,errors,output}))
    app.exit(exit)
  }
})()
