// Verifies the running demo end to end: seeded content, sign-in, and local chat.
// Usage: DEMO_ORIGIN=<the https origin the backend was started with> node scripts/smoke-test.mjs
const base = process.env.DEMO_URL || 'http://127.0.0.1:3000'
const origin = process.env.DEMO_ORIGIN || base
const failures = []
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); if (!ok) failures.push(name) }
const call = async (path, opts = {}) => { const r = await fetch(base + path, opts); const t = await r.text(); try { return {status: r.status, body: JSON.parse(t)} } catch { return {status: r.status, body: null} } }

const status = (await call('/demo/status')).body
check('backend ready', status?.ready === true)
check('15 users, 100 posts, 42 replies', status?.users === 15 && status?.posts === 100 && status?.replies === 42, JSON.stringify(status))

const login = await call('/demo/login', {method: 'POST', headers: {origin, 'content-type': 'application/json'}, body: JSON.stringify({handle: 'alex.test'})})
check('test user signs in', login.status === 200 && !!login.body?.accessJwt)
const auth = {authorization: `Bearer ${login.body?.accessJwt}`}

const feed = await call('/xrpc/app.bsky.feed.getTimeline?limit=30', {headers: auth})
const texts = (feed.body?.feed || []).map(i => i.post.record.text)
check('home feed has posts', texts.length > 10, `${texts.length} posts`)
check('posts have no date prefix', texts.every(t => !/^\d{4} · /.test(t)))

const explore = await call('/xrpc/app.bsky.actor.searchActors?q=darwin&limit=5', {headers: auth})
check('people search finds Darwin', (explore.body?.actors || []).some(a => /darwin/i.test(a.displayName || a.handle)))

const convos = await call('/xrpc/chat.bsky.convo.listConvos', {headers: auth})
check('Alex has direct-message conversations', (convos.body?.convos || []).length >= 6, `${convos.body?.convos?.length} convos`)
const first = convos.body?.convos?.[0]
const sent = await call('/xrpc/chat.bsky.convo.sendMessage', {method: 'POST', headers: {...auth, 'content-type': 'application/json'}, body: JSON.stringify({convoId: first?.id, message: {text: 'smoke test'}})})
check('can send a direct message', sent.status === 200 && sent.body?.text === 'smoke test')
const log = await call(`/xrpc/chat.bsky.convo.getLog?cursor=${first?.rev}`, {headers: auth})
check('new message appears in chat log', (log.body?.logs || []).length >= 1)

if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1) }
console.log('\nAll checks passed')
