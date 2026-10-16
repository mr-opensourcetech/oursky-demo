import http from 'node:http'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {alex, characters, historicalThreads} from './history-data.mjs'
import {dms} from './dms-data.mjs'
import {createChat} from './chat.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const atprotoDir = process.env.ATPROTO_DIR || path.resolve(here, '../atproto')
const {TestNetwork} = await import(pathToFileURL(path.join(atprotoDir, 'packages/dev-env/dist/index.js')))
const origin = process.env.DEMO_ORIGIN
if (!origin || !origin.startsWith('https://')) throw new Error('Set DEMO_ORIGIN to the sandbox HTTPS origin')
const publicUrl = new URL(origin).origin
const stateDir = new URL('./state/', import.meta.url)
await fs.mkdir(stateDir, {recursive: true, mode: 0o700})
const password = crypto.randomBytes(24).toString('base64url')
const runId = `demo_${crypto.randomBytes(8).toString('hex').replace(/[0-9]/g, d => String.fromCharCode(103 + Number(d)))}`
let ready = false
let network
let chat
let accounts = []
const people = [alex, ...characters].map(c => [c.handle, c.name, c.bio])
const postCount = characters.reduce((total, c) => total + c.posts.length, 0)
const replyCount = historicalThreads.reduce((total, t) => total + t.replies.length, 0)
const characterByHandle = new Map(characters.map(c => [c.handle, c]))
for (const character of characters) {
  if (character.handle.length > 18) throw new Error(`Seed handle too long: ${character.handle}`)
  await fs.access(path.join(here, 'portraits', `${character.handle}.jpg`))
  for (const [year, text] of character.posts) {
    if (year < character.born + 16 || year > character.died || [...text].length > 300) {
      throw new Error(`Invalid historical seed post: ${character.handle}`)
    }
  }
}
for (const thread of historicalThreads) {
  const year = characterByHandle.get(thread.author)?.posts[0][0]
  if (!year) throw new Error(`Missing thread author: ${thread.author}`)
  for (const [handle, text] of thread.replies) {
    const character = characterByHandle.get(handle)
    if (!character || year < character.born + 16 || year > character.died || [...text].length > 300) {
      throw new Error(`Invalid historical reply: ${handle}`)
    }
  }
}

const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bluesky Demo</title>
<style>body{margin:0;background:#f4f8fc;color:#15263b;font:17px system-ui,sans-serif}main{max-width:760px;margin:8vh auto;padding:32px}h1{font-size:48px;letter-spacing:-2px;margin:12px 0}p{line-height:1.6;color:#52657b}.tag{color:#087af5;font-size:13px;font-weight:700;letter-spacing:2px}.box{padding:28px;background:white;border:1px solid #dce6f1;border-radius:20px;margin-top:24px}.grid{display:flex;gap:30px;margin:20px 0}.grid strong{display:block;font-size:28px}.grid span{font-size:13px;color:#52657b}button,select{font:inherit;padding:13px 20px;border-radius:10px;border:1px solid #ccd9e9}button{background:#087af5;color:white;border:0;cursor:pointer;font-weight:650}button:disabled{opacity:.5}small{display:block;color:#52657b;line-height:1.6;margin-top:20px}#status{min-height:24px}code{font-size:14px}a{color:#087af5}</style>
<main><div class="tag">BEFORE 1900 · HISTORICAL ROLE-PLAY</div>
<h1>A different kind of timeline.</h1>
<p>Scientists, activists, presidents, prime ministers, and athletes discuss the ideas and events of their own lifetimes. All portraits are AI illustrations; every post and conversation is imagined, not an authentic quotation.</p>
<div class="box"><div class="grid"><div><strong>14</strong><span>historical figures</span></div><div><strong>100</strong><span>imagined posts</span></div><div><strong>14</strong><span>reply threads</span></div></div>
<p>Enter as Alex, your test account, or explore a historical character.</p>
<select id="account" aria-label="Demo account">${people.map(([handle, name]) => `<option value="${handle}.test">${name}</option>`).join('')}</select> <button id="open" disabled>Open Bluesky</button><p id="status">Checking the local services…</p></div>
<small><b>Real software, fictional social history:</b> social-app + atproto, PostgreSQL, Redis, and local account storage.<br>Posts stay in this isolated demo. Direct messages run locally too, stored in PostgreSQL. Restarting the backend restores the seeded community.</small></main>
<script>
const status=document.querySelector('#status'),button=document.querySelector('#open');
async function check(){try{const r=await fetch('/demo/status');const s=await r.json();if(s.ready){status.textContent='Historical community ready. No password needed.';button.disabled=false}else setTimeout(check,2000)}catch{status.textContent='Waiting for the local network…';setTimeout(check,2000)}}check();
button.onclick=async()=>{button.disabled=true;status.textContent='Signing in to your local demo account…';try{const r=await fetch('/demo/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({handle:document.querySelector('#account').value})});if(!r.ok)throw Error('Sign-in failed');const account=await r.json();localStorage.setItem('BSKY_STORAGE',JSON.stringify({colorMode:'light',darkTheme:'dim',session:{accounts:[account],currentAccount:{did:account.did}},reminders:{},languagePrefs:{primaryLanguage:'en',contentLanguages:['en'],postLanguage:'en',postLanguageHistory:['en'],appLanguage:'en'},requireAltTextEnabled:false,externalEmbeds:{},invites:{copiedInvites:[]},onboarding:{step:'Home'},mutedThreads:[],hiddenPosts:[],pdsAddressHistory:[location.origin],disableAutoplay:true,trendingDisabled:true,trendingVideoDisabled:true,hasCheckedForStarterPack:true}));location.href='/'}catch(e){status.textContent=e.message;button.disabled=false}};
</script></html>`

function json(res, code, value) {
  res.writeHead(code, {'content-type':'application/json', 'cache-control':'no-store'})
  res.end(JSON.stringify(value))
}

function proxy(req, res, port) {
  const rewritesSession = /^\/xrpc\/com\.atproto\.server\.(createSession|refreshSession|getSession)(?:\?|$)/.test(req.url)
  const headers = {...req.headers, host:port === 8081 ? req.headers.host : `localhost:${port}`}
  // http.request does not decompress responses. Session JSON must be readable
  // before rewriting its local PDS endpoint.
  if (rewritesSession) headers['accept-encoding'] = 'identity'
  const upstream = http.request({hostname:'127.0.0.1', port, path:req.url, method:req.method, headers}, reply => {
    if (rewritesSession && reply.statusCode === 200) {
      let body = ''
      const fail = () => {
        if (!res.headersSent) json(res,502,{error:'Invalid local session response'})
        else if (!res.writableEnded) res.destroy()
      }
      reply.on('error', fail)
      reply.on('aborted', fail)
      reply.on('data', chunk => {
        body += chunk
        if (body.length > 1048576) {
          fail()
          reply.destroy()
        }
      })
      reply.on('end', () => {
        if (res.writableEnded) return
        try {
          const result = JSON.parse(body)
          for (const service of result.didDoc?.service || []) {
            if (service.id === '#atproto_pds') service.serviceEndpoint = publicUrl
          }
          json(res, 200, result)
        } catch {
          fail()
        }
      })
      return
    }
    res.writeHead(reply.statusCode, reply.headers)
    reply.pipe(res)
  })
  upstream.on('error', () => {if (!res.headersSent) json(res,503,{error:'Local service is starting'});else res.destroy()})
  req.pipe(upstream)
}

const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, publicUrl).pathname
    res.setHeader('Content-Security-Policy', "connect-src 'self' https://ip.bsky.app ws: wss: blob:; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'none'")
    res.setHeader('Referrer-Policy','same-origin')
    if(path === '/demo' || path === '/demo/') {
      res.writeHead(200, {'content-type':'text/html; charset=utf-8','cache-control':'no-store'})
      return res.end(page)
    }
    if(path === '/demo/status') return json(res,200,{ready,users:ready?people.length:0,posts:ready?postCount:0,replies:ready?replyCount:0,historicalFigures:characters.length,theme:'Before 1900',database:'PostgreSQL',runId})
    if(path === '/demo/login') {
      if(req.method !== 'POST' || req.headers.origin !== publicUrl) return json(res,403,{error:'Same-origin POST required'})
      if(!ready) return json(res,503,{error:'Seeding in progress'})
      let body = ''
      for await (const chunk of req) {body += chunk;if(body.length>1024)return json(res,413,{error:'Body too large'})}
      const {handle} = JSON.parse(body)
      if(!accounts.some(a => a.handle===handle))return json(res,400,{error:'Choose a seeded account'})
      const login = await fetch('http://127.0.0.1:2583/xrpc/com.atproto.server.createSession',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identifier:handle,password})})
      if(!login.ok) return json(res,502,{error:'Local sign-in failed'})
      const session = await login.json()
      return json(res,200,{service:publicUrl+'/',pdsUrl:publicUrl+'/',did:session.did,handle:session.handle,email:session.email,emailConfirmed:true,emailAuthFactor:false,accessJwt:session.accessJwt,refreshJwt:session.refreshJwt,active:true,isSelfHosted:true})
    }
    if(path.startsWith('/xrpc/com.atproto.admin.') || path.startsWith('/xrpc/tools.ozone.'))return json(res,403,{error:'Admin API not exposed by demo'})
    if(path.startsWith('/xrpc/chat.'))return chat ? await chat.handle(req,res,new URL(req.url,publicUrl)) : json(res,503,{error:'Chat is starting'})
    if(path.startsWith('/xrpc/app.bsky.') && !req.headers.authorization)return proxy(req,res,2584)
    if(path.startsWith('/xrpc/'))return proxy(req,res,2583)
    if(path.startsWith('/img/'))return proxy(req,res,2584)
    if(path.startsWith('/.well-known/'))return proxy(req,res,2583)
    if(path.startsWith('/telemetry') || path.startsWith('/unavailable/'))return json(res,404,{error:'External service disabled in isolated demo'})
    return proxy(req,res,8081)
  } catch(error) {
    console.error('Gateway request failed:',error.message)
    if(!res.headersSent)json(res,500,{error:'Local demo request failed'})
  }
})
server.on('upgrade',(req,socket,head)=>{
  const upstream=http.request({hostname:'127.0.0.1',port:8081,path:req.url,headers:req.headers})
  upstream.on('upgrade',(res,peer,data)=>{
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(res.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')}\r\n\r\n`)
    if(data.length)socket.write(data)
    if(head.length)peer.write(head)
    peer.pipe(socket);socket.pipe(peer)
  })
  upstream.on('error',()=>socket.destroy())
  upstream.end()
})
server.listen(3000,'0.0.0.0',()=>console.log('Demo gateway listening on 3000'))

network = await TestNetwork.create({
  dbPostgresUrl:process.env.DB_POSTGRES_URL,
  dbPostgresSchema:runId,
  pds:{port:2583,hostname:'localhost',enableDidDocWithSession:true,serviceName:'Bluesky Local Demo',serviceHandleDomains:['.test']},
  bsky:{port:2584,publicUrl,dbPostgresSchema:`appview_${runId}`},
  plc:{port:2582},
  ozone:{port:2587,dbMaterializedViewRefreshIntervalMs:30000},
})
await fs.writeFile(new URL('./runtime.env',stateDir),[
  `EXPO_PUBLIC_ENV=development`,
  `EXPO_PUBLIC_SERVICE_URL=${publicUrl}`,
  `EXPO_PUBLIC_BLUESKY_PROXY_DID=${network.bsky.serverDid}`,
  `EXPO_PUBLIC_CHAT_PROXY_DID=did:example:chat-disabled`,
  `EXPO_PUBLIC_METRICS_API_HOST=${publicUrl}/telemetry`,
  `EXPO_PUBLIC_GROWTHBOOK_API_HOST=${publicUrl}/unavailable/growthbook`,
  `EXPO_PUBLIC_GROWTHBOOK_CLIENT_KEY=local-demo`,
  `GEOLOCATION_DEV_URL=https://ip.bsky.app`,
  `LIVE_EVENTS_DEV_URL=${publicUrl}/unavailable/live-events`,
  `APP_CONFIG_DEV_URL=${publicUrl}/unavailable/app-config`,
  `EXPO_NO_TELEMETRY=1`,
  `EXPO_OFFLINE=1`,
  `CI=false`,
  `BROWSER=none`,
].join('\n')+'\n',{mode:0o600})
console.log('Real local services started; seeding historical role-play community')
const seed = network.getSeedClient()
for (let i=0;i<people.length;i++) {
  const [handle,name,bio]=people[i]
  const account=await seed.createAccount(handle,{handle:`${handle}.test`,email:`${handle}@example.test`,password})
  accounts.push(account)
  const avatar=await fs.readFile(path.join(here,'portraits',`${handle}.jpg`))
  const blob=await seed.agent.com.atproto.repo.uploadBlob(avatar,{encoding:'image/jpeg',headers:seed.getHeaders(account.did)})
  const disclosure = handle === 'alex' ? '' : '\nHistorical role-play · AI portrait · Imagined posts, not quotations.'
  await seed.agent.com.atproto.repo.putRecord({repo:account.did,collection:'app.bsky.actor.profile',rkey:'self',record:{$type:'app.bsky.actor.profile',displayName:name,description:`${bio}${disclosure}`,avatar:blob.data.blob}},{headers:seed.getHeaders(account.did)})
  await seed.agent.com.atproto.repo.putRecord({repo:account.did,collection:'chat.bsky.actor.declaration',rkey:'self',record:{$type:'chat.bsky.actor.declaration',allowIncoming:'all'}},{headers:seed.getHeaders(account.did)})
  await seed.agent.app.bsky.actor.putPreferences({preferences:[
    {$type:'app.bsky.actor.defs#personalDetailsPref',birthDate:'1990-01-15T00:00:00.000Z'},
    {$type:'app.bsky.actor.defs#savedFeedsPrefV2',items:[{id:'following',type:'timeline',value:'following',pinned:true}]},
    {$type:'app.bsky.actor.defs#bskyAppStatePref',queuedNudges:[]},
    {$type:'app.bsky.actor.defs#labelersPref',labelers:[]},
  ]},{headers:seed.getHeaders(account.did)})
}
for(let i=0;i<accounts.length;i++) {
  for(let j=0;j<accounts.length;j++) {
    if(i!==j && (i===0 || (j-i+15)%15<5))await seed.follow(accounts[i].did,accounts[j].did)
  }
}
const posts=[]
const roots = new Map()
const accountByHandle = new Map(accounts.map(a => [a.handle.replace(/\.test$/, ''), a]))
const now = Date.now()
let ordinal = 0
for (let round=0;round<8;round++) {
  for (let c=0;c<characters.length;c++) {
    const character=characters[c]
    const entry=character.posts[round]
    if (!entry) continue
    const [year,text]=entry
    const createdAt = round === 0
      ? new Date(now-(characters.length-c)*3600000)
      : new Date(now-86400000-(postCount-ordinal)*1800000)
    const post=await seed.post(accountByHandle.get(character.handle).did,text,undefined,undefined,undefined,{langs:['en'],createdAt:createdAt.toISOString()})
    posts.push(post)
    if(round===0)roots.set(character.handle,{post,year,createdAt})
    ordinal++
  }
}
for (const thread of historicalThreads) {
  const root = roots.get(thread.author)
  let parent = root.post.ref
  for (let i=0;i<thread.replies.length;i++) {
    const [handle,text]=thread.replies[i]
    const reply=await seed.reply(accountByHandle.get(handle).did,root.post.ref,parent,text,undefined,undefined,{langs:['en'],createdAt:new Date(root.createdAt.getTime()+(i+1)*300000).toISOString()})
    parent=reply.ref
  }
}
for(let i=0;i<posts.length;i++)for(let j=0;j<3;j++)await seed.like(accounts[1+(i+j+1)%characters.length].did,posts[i].ref)
await network.processAll(30000)
chat = await createChat({atprotoDir, schema:'chat', pdsUrl:'http://127.0.0.1:2583', appviewUrl:'http://127.0.0.1:2584', dbUrl:process.env.SUPABASE_DB_URL||'postgresql://postgres:postgres@127.0.0.1:54322/postgres'})
const didByHandle = new Map([...accountByHandle].map(([h,a])=>[h,a.did]))
for (let i=0;i<dms.length;i++) {
  const [a,b,messages]=dms[i]
  await chat.seedConvo(accountByHandle.get(a),accountByHandle.get(b),messages.map(([h,t])=>[didByHandle.get(h),t]),(dms.length-i)*2700000)
}
console.log(`DMS_READY conversations=${dms.length} messages=${dms.reduce((n,d)=>n+d[2].length,0)}`)
await fs.writeFile(new URL('./accounts.json',stateDir),JSON.stringify(accounts.map(({handle,did})=>({handle,did})),null,2))
await fs.writeFile(new URL('./history-threads.json',stateDir),JSON.stringify([...roots].map(([handle,root])=>({handle,year:root.year,uri:root.post.ref.uriStr})),null,2))
ready=true
console.log(`DEMO_READY users=${accounts.length} historicalFigures=${characters.length} posts=${posts.length} replies=${replyCount} likes=${posts.length*3} appview=${network.bsky.serverDid}`)
async function shutdown() {
  ready=false
  await chat?.close()
  server.close()
  await network?.close()
  process.exit(0)
}
process.on('SIGTERM',shutdown)
process.on('SIGINT',shutdown)
