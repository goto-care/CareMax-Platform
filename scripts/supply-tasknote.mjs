// 備品管理（https://kikakubu-portal.netlify.app/supply/）で「申請を確定」された申請を、
// TaskNote のメール受信箱（Documents\TaskNote\メール受信箱.json）に「やること」として入れる。
//
//  ・一度に確定した申請（submissionId が同じもの）は、1件のタスクにまとめる。
//  ・急ぎを含む申請は優先度3（高）・期限は申請した日、全部「次回でOK」なら優先度1（低）、ほかは2（中）。
//  ・備品管理で全部「完了にする」（または取消し）になったら、受信箱から外して closedMails に書く
//    （TaskNote は closedMails を見て、そのタスクを完了フォルダへ移す。Outlook・楽楽自動応対の取り込みと同じ扱い）。
//  ・一部だけ完了したときは、受信箱の要点を書き直す（「✓ 済み」を付ける）。
//  ・受信箱に入れたはずの申請が消えていたら（ほかの取り込みと書き込みが重なったときなど）、次の回に入れ直す。
//  ・備品管理（Firestore）には何も書き込まない。読むだけ。
//
// 使い方：
//   node scripts/supply-tasknote.mjs                  Firestore の申請を読んで受信箱を更新する
//   node scripts/supply-tasknote.mjs --dry-run        受信箱には書かず、何をするかだけ表示する
//   node scripts/supply-tasknote.mjs --fixture <file.json> [--data <dir>]
//                                                     テスト用。Firestore の代わりに file.json の申請を使う
//                                                     （{ "requests": [...], "inventory": [...] } の形）
//
// Firestore は、備品管理のページと同じく Firebase の匿名ログインで読む。
// 最初の1回だけ匿名ユーザーを作り、その更新用トークンを Documents\TaskNote\.supply-state.json に残して使い回す。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const dryRun = args.includes('--dry-run')
const fixturePath = opt('--fixture', null)
const dataDir = opt('--data', path.join(os.homedir(), 'Documents', 'TaskNote'))
const inboxPath = path.join(dataDir, 'メール受信箱.json')
const statePath = path.join(dataDir, '.supply-state.json')
const runLogPath = path.join(dataDir, '実行ログ.jsonl')

const FIREBASE_API_KEY = 'AIzaSyDFoI20EpiXp6VV8N0SyJdmkEcK2_cZLLA'
const FIREBASE_PROJECT = 'kikakubu-portal'
const SUPPLY_URL = 'https://kikakubu-portal.netlify.app/supply/'
const INBOX_KEEP_DAYS = 30 // Outlook・楽楽自動応対の取り込みと同じ（これより古いものは向こうが消す）
const DAY = 24 * 60 * 60 * 1000

const URGENCY = {
  urgent: { label: '急ぎ', rank: 0 },
  normal: { label: 'ふつう', rank: 1 },
  later: { label: '次回でOK', rank: 2 },
}
const UNKNOWN_REQUESTER_NAMES = new Set(['', 'ゲストユーザー', 'Staff', '担当者'])

// ---------- 小さな道具 ----------

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new Error(`${file} を読めません：${error.message}`)
  }
}
// 書きかけのファイルを TaskNote が読まないよう、別名で書いてから置き換える。
const writeJsonAtomic = (file, data) => {
  const tmp = `${file}.supply.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}
const appendJsonl = (file, line) => {
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8')
}
const pad = (n) => String(n).padStart(2, '0')
const localIso = (d = new Date()) => {
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const shortDateTime = (d) => `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
const str = (v) => (v == null ? '' : String(v).trim())
const toDate = (v) => {
  const d = new Date(v || 0)
  return Number.isNaN(d.getTime()) ? new Date(0) : d
}

const requesterName = (r) => (UNKNOWN_REQUESTER_NAMES.has(str(r.userName)) ? '' : str(r.userName))
const quantityLabel = (r) => (r.quantity ? `${r.quantity}${str(r.unit)}` : '')
const urgencyRank = (r) => (URGENCY[r.urgency] || URGENCY.normal).rank
const submittedAtOf = (r) => toDate(r.submittedAt || r.timestamp)

// 一度に確定した申請のまとまり。古い画面から確定されたもの（submissionId なし）は、申請者と分単位の時刻でまとめる。
const groupKeyOf = (r) => {
  if (str(r.submissionId)) return str(r.submissionId)
  const minute = str(r.submittedAt || r.timestamp).slice(0, 16)
  return `legacy-${str(r.userId) || 'unknown'}-${minute}`
}
const inboxIdOf = (key) => `supply-${key.replace(/[^A-Za-z0-9_-]/g, '')}`

// ---------- Firestore を読む（匿名ログイン） ----------

async function getIdToken(state) {
  if (state.auth?.refreshToken) {
    const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: state.auth.refreshToken }),
    })
    if (res.ok) {
      const json = await res.json()
      state.auth.refreshToken = json.refresh_token
      return json.id_token
    }
    // 更新用トークンが使えなくなっていたら、匿名ユーザーを作り直す。
  }
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  })
  if (!res.ok) throw new Error(`Firebase に匿名ログインできません（HTTP ${res.status}）`)
  const json = await res.json()
  state.auth = { uid: json.localId, refreshToken: json.refreshToken, createdAt: localIso() }
  // 次の回に匿名ユーザーを作り直さないよう、すぐ残しておく。
  writeJsonAtomic(statePath, state)
  return json.idToken
}

function decodeValue(v) {
  if (!v || typeof v !== 'object') return undefined
  if ('stringValue' in v) return v.stringValue
  if ('integerValue' in v) return Number(v.integerValue)
  if ('doubleValue' in v) return v.doubleValue
  if ('booleanValue' in v) return v.booleanValue
  if ('timestampValue' in v) return v.timestampValue
  if ('nullValue' in v) return null
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {})
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue)
  return undefined
}
const decodeFields = (fields) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, decodeValue(v)]))

async function firestoreRunQuery(token, structuredQuery) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents:runQuery`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery }),
  })
  if (!res.ok) throw new Error(`Firestore を読めません（HTTP ${res.status}）`)
  const rows = await res.json()
  return rows
    .filter((row) => row.document)
    .map((row) => ({ id: row.document.name.split('/').pop(), ...decodeFields(row.document.fields || {}) }))
}

async function loadFromFirestore(state) {
  const token = await getIdToken(state)
  const requests = await firestoreRunQuery(token, {
    from: [{ collectionId: 'requests' }],
    where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'Pending' } } },
  })
  // 備品名を残していない古い申請があるときだけ、備品の名前を読む（画像は大きいので名前とカテゴリーだけ）。
  let inventory = []
  if (requests.some((r) => !str(r.itemName))) {
    inventory = await firestoreRunQuery(token, {
      from: [{ collectionId: 'inventory' }],
      select: { fields: [{ fieldPath: 'name' }, { fieldPath: 'category' }] },
    })
  }
  return { requests, inventory }
}

// ---------- 受信箱のタスクを作る ----------

function buildInboxItem(id, requests, doneLabels, inventoryById, now, previous) {
  const nameOf = (r) => str(r.itemName) || str(inventoryById.get(r.itemId)?.name) || '（名前不明の備品）'
  const reqs = [...requests].sort((a, b) => urgencyRank(a) - urgencyRank(b) || nameOf(a).localeCompare(nameOf(b), 'ja'))
  const submittedAt = new Date(Math.min(...reqs.map((r) => submittedAtOf(r).getTime())))
  const requesters = [...new Set(reqs.map(requesterName).filter(Boolean))]
  const who = requesters.length ? requesters.map((n) => `${n}さん`).join('・') : '申請者名なし'
  const showRequesterPerLine = requesters.length > 1
  const urgent = reqs.some((r) => r.urgency === 'urgent')
  const allLater = reqs.every((r) => r.urgency === 'later')

  const first = reqs[0]
  const firstLabel = [nameOf(first), quantityLabel(first)].filter(Boolean).join(' ')
  const title = reqs.length === 1
    ? `備品を注文する：${firstLabel}`
    : `備品を注文する：${firstLabel} ほか${reqs.length - 1}品`

  const lines = reqs.map((r) => {
    const parts = [`・${nameOf(r)}`]
    const qty = quantityLabel(r)
    if (qty) parts.push(`　${qty}`)
    if (r.urgency === 'urgent' || r.urgency === 'later') parts.push(`（${URGENCY[r.urgency].label}）`)
    if (showRequesterPerLine && requesterName(r)) parts.push(`／${requesterName(r)}さん`)
    if (str(r.comment)) parts.push(` — ${str(r.comment).replace(/\s*\n\s*/g, ' ')}`)
    return parts.join('')
  })
  const summary = [
    `備品管理で申請が確定されました（${who}・${shortDateTime(submittedAt)}）。`,
    ...lines,
    ...doneLabels.map((label) => `✓ 済み：${label}`),
    '',
    '注文したら、備品管理の申請リストで「完了にする」を押してください。全部が完了になると、TaskNote のこのタスクも完了に移ります。',
    '',
    `▶ 備品管理：${SUPPLY_URL}`,
  ].join('\n')

  return {
    id,
    source: 'supply',
    receivedAt: localIso(submittedAt),
    from: '備品管理（申請）',
    fromAddress: '',
    subject: `【備品管理】${who}の申請 ${reqs.length + doneLabels.length}品`,
    title,
    summary,
    due: urgent ? localDate(submittedAt) : null,
    priority: urgent ? 3 : allLater ? 1 : 2,
    reason: urgent ? '急ぎの備品の申請' : allLater ? '次回の発注でよい備品の申請' : '備品の申請（注文待ち）',
    addedAt: previous?.addedAt || localIso(now),
  }
}

const sameItem = (a, b) => {
  if (!a || !b) return false
  const strip = ({ addedAt, ...rest }) => rest
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b))
}

// ---------- 本体 ----------

async function main() {
  const now = new Date()
  const cutoff = now.getTime() - INBOX_KEEP_DAYS * DAY
  fs.mkdirSync(dataDir, { recursive: true })

  const state = readJson(statePath, {})
  state.tracked = state.tracked || {}

  const source = fixturePath ? readJson(fixturePath, null) : await loadFromFirestore(state)
  if (!source || !Array.isArray(source.requests)) throw new Error('申請を読めませんでした')
  const pending = source.requests.filter((r) => r.status === 'Pending')
  const inventoryById = new Map((source.inventory || []).map((i) => [i.id, i]))

  const groups = new Map()
  for (const r of pending) {
    const id = inboxIdOf(groupKeyOf(r))
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(r)
  }

  const inbox = readJson(inboxPath, { version: 1, items: [] })
  inbox.items = inbox.items || []
  inbox.closedMails = inbox.closedMails || []
  const closedIds = new Set(inbox.closedMails.map((c) => c.id))

  const result = { added: [], updated: [], healed: [], closed: [] }
  let inboxChanged = false

  // 1. 注文待ちの申請を、受信箱に入れる・書き直す・入れ直す。
  for (const [id, reqs] of groups) {
    const tracked = state.tracked[id]
    const labelOf = (r) => [str(r.itemName) || str(inventoryById.get(r.itemId)?.name) || '（名前不明の備品）', quantityLabel(r)].filter(Boolean).join(' ')
    const labels = { ...(tracked?.labels || {}) }
    for (const r of reqs) labels[r.id] = labelOf(r)
    const currentIds = reqs.map((r) => r.id)
    const doneLabels = Object.entries(labels).filter(([rid]) => !currentIds.includes(rid)).map(([, label]) => label)

    const index = inbox.items.findIndex((x) => x.id === id)
    const previous = index >= 0 ? inbox.items[index] : tracked?.item
    const item = buildInboxItem(id, reqs, doneLabels, inventoryById, now, previous)
    const tooOld = new Date(item.receivedAt).getTime() < cutoff
    let inInbox = index >= 0

    if (index >= 0) {
      if (!sameItem(inbox.items[index], item)) {
        inbox.items[index] = item
        inboxChanged = true
        result.updated.push(item.title)
      }
    } else if (!tracked) {
      if (!tooOld && !closedIds.has(id)) {
        inbox.items.push(item)
        inboxChanged = true
        inInbox = true
        result.added.push(item.title)
      }
    } else if (!tooOld && !closedIds.has(id)) {
      // 受信箱から消えていた（ほかの取り込みと書き込みが重なったなど）。TaskNote は同じ id を二重にしない。
      inbox.items.push(item)
      inboxChanged = true
      inInbox = true
      result.healed.push(item.title)
    }
    state.tracked[id] = {
      requestIds: currentIds, labels, receivedAt: item.receivedAt, item,
      sent: Boolean(tracked?.sent || inInbox), // 一度でも受信箱に入れたか（済んだときに closedMails を書くかどうか）
    }
  }

  // 2. 全部「完了にする」か取消しになったまとまりを、受信箱から外して closedMails に書く。
  for (const [id, tracked] of Object.entries(state.tracked)) {
    if (groups.has(id)) continue
    const item = inbox.items.find((x) => x.id === id) || tracked.item
    const before = inbox.items.length
    inbox.items = inbox.items.filter((x) => x.id !== id)
    if (tracked.sent && !closedIds.has(id)) {
      inbox.closedMails.push({ id, reason: 'read', at: localIso(now), title: item?.title || '' })
      closedIds.add(id)
      inboxChanged = true
    }
    if (before !== inbox.items.length) inboxChanged = true
    result.closed.push(item?.title || id)
    delete state.tracked[id]
  }

  // ここで state.tracked に残っているのは、いま注文待ちのまとまりだけ（済んだものは 2. で消した）。
  state.lastCheckedAt = localIso(now)

  console.log(`PENDING: ${pending.length} 件（${groups.size} まとまり）`)
  for (const t of result.added) console.log(`ADDED: ${t}`)
  for (const t of result.updated) console.log(`UPDATED: ${t}`)
  for (const t of result.healed) console.log(`HEALED: ${t}`)
  for (const t of result.closed) console.log(`CLOSED: ${t}`)
  if (!result.added.length && !result.updated.length && !result.healed.length && !result.closed.length) {
    console.log('CHANGES: なし')
  }

  if (dryRun) {
    console.log('DRY-RUN: 受信箱には書いていません')
    return
  }
  if (inboxChanged) {
    inbox.version = 1
    inbox.updatedAt = localIso(now)
    writeJsonAtomic(inboxPath, inbox)
  }
  writeJsonAtomic(statePath, state)
  appendJsonl(runLogPath, {
    at: localIso(now), type: 'supply-run', pending: pending.length, groups: groups.size,
    added: result.added.length, updated: result.updated.length || undefined,
    healed: result.healed.length || undefined, closed: result.closed.length,
    fixture: fixturePath ? true : undefined,
  })
}

main().catch((error) => {
  console.log(`ERROR: ${error.message}`)
  if (!dryRun) {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      appendJsonl(runLogPath, { at: localIso(), type: 'supply-error', error: error.message })
    } catch { /* ログが書けなくても終わる */ }
  }
  process.exitCode = 1
})
