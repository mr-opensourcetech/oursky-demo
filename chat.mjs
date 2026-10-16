// Local direct-message service for the demo. Bluesky's hosted chat service is not
// part of the open-source backend, so this implements the chat.bsky.convo.* calls
// the real client uses, stored in PostgreSQL next to the rest of the demo data.
import crypto from 'node:crypto'
import {createRequire} from 'node:module'
import path from 'node:path'

const NS = 'chat.bsky.convo.defs'
let seq = 0
const newRev = () => `${Date.now()}${String(++seq % 1000).padStart(3, '0')}`.padStart(20, '0')

export async function createChat({atprotoDir, schema, pdsUrl, appviewUrl, dbUrl}) {
  const require = createRequire(path.join(atprotoDir, 'packages/dev-env/package.json'))
  const {Pool} = require(path.join(atprotoDir, 'node_modules/.pnpm/pg@8.10.0/node_modules/pg'))
  const pool = new Pool({connectionString: dbUrl, max: 4})
  const q = (text, params) => pool.query(text, params)
  // Tables are created by supabase-chat/supabase/migrations; each demo run starts clean.
  await q(`truncate ${schema}.convos, ${schema}.members, ${schema}.messages, ${schema}.reactions, ${schema}.events restart identity cascade`)

  const profiles = new Map()
  async function profile(did) {
    if (!profiles.has(did)) {
      const r = await fetch(`${appviewUrl}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`)
      if (!r.ok) return {did, handle: 'unknown.invalid'}
      const p = await r.json()
      profiles.set(did, {$type: 'chat.bsky.actor.defs#profileViewBasic', did: p.did, handle: p.handle, displayName: p.displayName, avatar: p.avatar, associated: p.associated, chatDisabled: false, kind: {$type: 'chat.bsky.actor.defs#profileKindStandard'}})
    }
    return profiles.get(did)
  }

  const sessions = new Map()
  async function viewer(req) {
    const auth = req.headers.authorization
    if (!auth?.startsWith('Bearer ')) return null
    const cached = sessions.get(auth)
    if (cached && cached.until > Date.now()) return cached.did
    const r = await fetch(`${pdsUrl}/xrpc/com.atproto.server.getSession`, {headers: {authorization: auth}})
    if (!r.ok) return null
    const {did} = await r.json()
    sessions.set(auth, {did, until: Date.now() + 60000})
    return did
  }

  async function messageView(row) {
    const reactions = (await q(`select * from ${schema}.reactions where message_id=$1 order by created_at`, [row.id])).rows
    const view = {$type: `${NS}#messageView`, id: row.id, rev: row.rev, text: row.body, sender: {did: row.sender}, sentAt: row.sent_at.toISOString()}
    if (row.facets) view.facets = row.facets
    if (reactions.length) view.reactions = reactions.map(r => ({value: r.value, sender: {did: r.sender}, createdAt: r.created_at.toISOString()}))
    if (row.reply_to) {
      const parent = (await q(`select * from ${schema}.messages where id=$1`, [row.reply_to])).rows[0]
      if (parent) view.replyTo = {$type: `${NS}#messageView`, id: parent.id, rev: parent.rev, text: parent.body, sender: {did: parent.sender}, sentAt: parent.sent_at.toISOString()}
    }
    return view
  }

  async function convoView(id, did) {
    const convo = (await q(`select * from ${schema}.convos where id=$1`, [id])).rows[0]
    const members = (await q(`select * from ${schema}.members where convo_id=$1`, [id])).rows
    const me = members.find(m => m.did === did)
    if (!convo || !me) return null
    const last = (await q(`select * from ${schema}.messages where convo_id=$1 and not ($2 = any(hidden_for)) order by n desc limit 1`, [id, did])).rows[0]
    const unread = (await q(`select count(*)::int c from ${schema}.messages where convo_id=$1 and sender<>$2 and n>$3 and not ($2 = any(hidden_for))`, [id, did, me.last_read])).rows[0].c
    const view = {id, rev: convo.rev, members: await Promise.all(members.map(m => profile(m.did))), muted: me.muted, status: me.accepted ? 'accepted' : 'request', unreadCount: unread, kind: {$type: `${NS}#directConvo`}}
    if (last) view.lastMessage = await messageView(last)
    return view
  }

  async function logEvent(convoId, audience, build) {
    const rev = newRev()
    await q(`update ${schema}.convos set rev=$2 where id=$1`, [convoId, rev])
    await q(`insert into ${schema}.events(rev,convo_id,audience,payload) values($1,$2,$3,$4)`, [rev, convoId, audience, JSON.stringify(await build(rev))])
    return rev
  }

  async function createMessage(convoId, sender, {text, facets, replyTo}, sentAt = new Date()) {
    const members = (await q(`select did from ${schema}.members where convo_id=$1`, [convoId])).rows.map(r => r.did)
    const id = crypto.randomBytes(8).toString('hex')
    const rev = newRev()
    const row = (await q(`insert into ${schema}.messages(id,convo_id,sender,body,facets,reply_to,sent_at,rev) values($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [id, convoId, sender, text, facets ? JSON.stringify(facets) : null, replyTo?.messageId || null, sentAt, rev])).rows[0]
    // Sending marks the sender's own side read and un-hides the convo for everyone.
    await q(`update ${schema}.members set last_read=$3, left_convo=false where convo_id=$1 and did=$2`, [convoId, sender, row.n])
    await q(`update ${schema}.members set left_convo=false where convo_id=$1`, [convoId])
    const view = await messageView(row)
    await logEvent(convoId, members, async eventRev => ({$type: `${NS}#logCreateMessage`, rev: eventRev, convoId, message: view, relatedProfiles: await Promise.all(members.map(profile))}))
    return view
  }

  async function findOrCreateDirect(a, b) {
    const existing = (await q(`select m1.convo_id from ${schema}.members m1 join ${schema}.members m2 on m1.convo_id=m2.convo_id where m1.did=$1 and m2.did=$2`, [a, b])).rows[0]
    if (existing) return existing.convo_id
    const id = crypto.randomBytes(8).toString('hex')
    await q(`insert into ${schema}.convos(id,rev) values($1,$2)`, [id, newRev()])
    await q(`insert into ${schema}.members(convo_id,did) values($1,$2),($1,$3)`, [id, a, b])
    await logEvent(id, [a, b], rev => ({$type: `${NS}#logBeginConvo`, rev, convoId: id}))
    return id
  }

  async function seedConvo(a, b, messages, startMsAgo) {
    const id = await findOrCreateDirect(a.did, b.did)
    const step = Math.max(60000, Math.floor(startMsAgo / (messages.length + 1)))
    for (let i = 0; i < messages.length; i++) {
      const [sender, text] = messages[i]
      await createMessage(id, sender, {text}, new Date(Date.now() - startMsAgo + i * step))
    }
    return id
  }

  async function markRead(convoId, did, messageId) {
    const target = messageId
      ? (await q(`select n from ${schema}.messages where id=$1`, [messageId])).rows[0]?.n
      : (await q(`select max(n) n from ${schema}.messages where convo_id=$1`, [convoId])).rows[0]?.n
    await q(`update ${schema}.members set last_read=greatest(last_read, $3) where convo_id=$1 and did=$2`, [convoId, did, target || 0])
  }

  const fail = (res, code, error, message) => { res.writeHead(code, {'content-type': 'application/json'}); res.end(JSON.stringify({error, message})); return true }
  const send = (res, value) => { res.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(JSON.stringify(value)); return true }
  async function readBody(req) {
    let body = ''
    for await (const chunk of req) { body += chunk; if (body.length > 1048576) throw new Error('Body too large') }
    return body ? JSON.parse(body) : {}
  }

  async function listFor(did, requests) {
    const rows = (await q(`select c.id from ${schema}.convos c join ${schema}.members m on m.convo_id=c.id where m.did=$1 and not m.left_convo and m.accepted=$2 and exists(select 1 from ${schema}.messages x where x.convo_id=c.id) order by (select max(n) from ${schema}.messages x where x.convo_id=c.id) desc`, [did, !requests])).rows
    return (await Promise.all(rows.map(r => convoView(r.id, did)))).filter(Boolean)
  }

  async function handle(req, res, url) {
    const method = url.pathname.replace('/xrpc/chat.bsky.', '')
    const did = await viewer(req)
    if (!did) return fail(res, 401, 'AuthenticationRequired', 'Sign in required')
    const params = url.searchParams
    const input = req.method === 'POST' ? await readBody(req) : {}
    const mine = async convoId => (await convoView(convoId, did))
    switch (method) {
      case 'actor.getStatus': return send(res, {chatDisabled: false, canCreateGroups: false, groupMemberLimit: 0})
      case 'convo.listConvos': return send(res, {convos: await listFor(did, false)})
      case 'convo.listConvoRequests': return send(res, {requests: []})
      case 'convo.getConvo': {
        const convo = await mine(params.get('convoId'))
        return convo ? send(res, {convo}) : fail(res, 400, 'InvalidConvo', 'Conversation not found')
      }
      case 'convo.getConvoForMembers':
      case 'convo.getConvoAvailability': {
        const others = params.getAll('members').filter(m => m !== did)
        if (others.length !== 1) return fail(res, 400, 'InvalidRequest', 'Direct messages need one other member')
        const convoId = await findOrCreateDirect(did, others[0])
        const convo = await mine(convoId)
        return send(res, method === 'convo.getConvoForMembers' ? {convo} : {canChat: true, convo})
      }
      case 'convo.getMessages': {
        const convoId = params.get('convoId')
        if (!(await mine(convoId))) return fail(res, 400, 'InvalidConvo', 'Conversation not found')
        const limit = Math.min(Number(params.get('limit') || 50), 100)
        const cursor = params.get('cursor')
        const rows = (await q(`select * from ${schema}.messages where convo_id=$1 and not ($2 = any(hidden_for)) ${cursor ? 'and n < $4' : ''} order by n desc limit $3`, cursor ? [convoId, did, limit + 1, cursor] : [convoId, did, limit + 1])).rows
        const page = rows.slice(0, limit)
        const messages = await Promise.all(page.map(messageView))
        const dids = [...new Set(messages.flatMap(m => [m.sender.did, ...(m.reactions || []).map(r => r.sender.did)]))]
        return send(res, {messages, relatedProfiles: await Promise.all(dids.map(profile)), ...(rows.length > limit ? {cursor: String(page.at(-1).n)} : {})})
      }
      case 'convo.sendMessage': {
        if (!(await mine(input.convoId)) || !input.message?.text?.trim()) return fail(res, 400, 'InvalidRequest', 'Message needs text')
        return send(res, await createMessage(input.convoId, did, input.message))
      }
      case 'convo.sendMessageBatch': {
        const items = []
        for (const item of input.items || []) {
          if (await mine(item.convoId)) items.push(await createMessage(item.convoId, did, item.message))
        }
        return send(res, {items})
      }
      case 'convo.updateRead': {
        if (!(await mine(input.convoId))) return fail(res, 400, 'InvalidConvo', 'Conversation not found')
        await markRead(input.convoId, did, input.messageId)
        return send(res, {convo: await mine(input.convoId)})
      }
      case 'convo.updateAllRead': {
        const convos = await listFor(did, input.status === 'request')
        for (const convo of convos) await markRead(convo.id, did)
        return send(res, {updatedCount: convos.filter(c => c.unreadCount).length})
      }
      case 'convo.getUnreadCounts': {
        const convos = await listFor(did, false)
        return send(res, {unreadAcceptedConvos: Math.min(100, convos.filter(c => c.unreadCount).length), unreadRequestConvos: 0})
      }
      case 'convo.muteConvo':
      case 'convo.unmuteConvo': {
        await q(`update ${schema}.members set muted=$3 where convo_id=$1 and did=$2`, [input.convoId, did, method === 'convo.muteConvo'])
        return send(res, {convo: await mine(input.convoId)})
      }
      case 'convo.acceptConvo': return send(res, {})
      case 'convo.leaveConvo': {
        await q(`update ${schema}.members set left_convo=true where convo_id=$1 and did=$2`, [input.convoId, did])
        const convo = await q(`select rev from ${schema}.convos where id=$1`, [input.convoId])
        return send(res, {convoId: input.convoId, rev: convo.rows[0]?.rev || newRev()})
      }
      case 'convo.deleteMessageForSelf': {
        const row = (await q(`update ${schema}.messages set hidden_for = array_append(hidden_for,$3) where id=$1 and convo_id=$2 returning *`, [input.messageId, input.convoId, did])).rows[0]
        if (!row) return fail(res, 400, 'InvalidRequest', 'Message not found')
        return send(res, {id: row.id, rev: row.rev, sender: {did: row.sender}, sentAt: row.sent_at.toISOString()})
      }
      case 'convo.addReaction':
      case 'convo.removeReaction': {
        const row = (await q(`select * from ${schema}.messages where id=$1 and convo_id=$2`, [input.messageId, input.convoId])).rows[0]
        if (!row || !(await mine(input.convoId))) return fail(res, 400, 'InvalidRequest', 'Message not found')
        if (method === 'convo.addReaction') await q(`insert into ${schema}.reactions(message_id,sender,value) values($1,$2,$3) on conflict do nothing`, [row.id, did, input.value])
        else await q(`delete from ${schema}.reactions where message_id=$1 and sender=$2 and value=$3`, [row.id, did, input.value])
        const members = (await q(`select did from ${schema}.members where convo_id=$1`, [input.convoId])).rows.map(r => r.did)
        const message = await messageView(row)
        const reaction = {value: input.value, sender: {did}, createdAt: new Date().toISOString()}
        await logEvent(input.convoId, members, async rev => ({$type: `${NS}#log${method === 'convo.addReaction' ? 'Add' : 'Remove'}Reaction`, rev, convoId: input.convoId, message, reaction, relatedProfiles: await Promise.all(members.map(profile))}))
        return send(res, {message})
      }
      case 'convo.getLog': {
        const cursor = params.get('cursor') || ''
        const rows = (await q(`select rev, payload from ${schema}.events where $1 = any(audience) and rev > $2 order by rev limit 200`, [did, cursor])).rows
        return send(res, {logs: rows.map(r => r.payload), cursor: rows.at(-1)?.rev || cursor || newRev()})
      }
      default:
        return fail(res, 501, 'MethodNotImplemented', `${method} is not part of this local demo`)
    }
  }

  return {handle, seedConvo, close: () => pool.end()}
}
