#!/usr/bin/env node
/*
 * last-assistant-text.cjs — Stop hook 検出核の共通ヘルパ。
 * 転写 JSONL（session の main 転写）から「最後の assistant 応答の本文（text ブロック連結）」を返す。
 *
 * 設計（testable-stop-hook-gate-authoring §3・§4）:
 *   - 入力は env で差し替え可能（テストは LAT_TRANSCRIPT に fixture を渡す）。
 *   - 末尾 1 MiB だけ読む（巨大転写のコスト対策）。窓内に assistant 記録が無ければ ''（fail-open）。
 *   - 読めない・壊れている → ''（判定不能は非 block 側）。
 *
 * 連続する assistant 記録（tool_use を挟んで分割されたもの）は「最後の user/tool_result 以降」を
 * 1 応答とみなして連結する。これにより 1 ターン内で複数チャンクに割れた本文も 1 本として検査できる。
 */
'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')

const WINDOW_BYTES = 1024 * 1024
const SESSION_ID_RE = /^[0-9a-f-]{8,64}$/i

function tailText(file) {
  let st
  try {
    st = fs.statSync(file)
  } catch {
    return ''
  }
  if (!st.isFile()) return ''
  const start = st.size > WINDOW_BYTES ? st.size - WINDOW_BYTES : 0
  const len = st.size - start
  const buf = Buffer.alloc(len)
  const fd = fs.openSync(file, 'r')
  try {
    fs.readSync(fd, buf, 0, len, start)
  } finally {
    fs.closeSync(fd)
  }
  const text = buf.toString('utf8')
  if (start === 0) return text
  const nl = text.indexOf('\n')
  return nl < 0 ? '' : text.slice(nl + 1)
}

/** git-bash 形式 /c/Users/... を C:/Users/... に正規化（Node は /c/ を解決できない） */
function normalizePath(p) {
  const m = typeof p === 'string' && /^\/([a-zA-Z])\/(.*)$/.exec(p)
  return m ? m[1].toUpperCase() + ':/' + m[2] : p
}

function resolveTranscript(transcriptPath, sessionId) {
  transcriptPath = normalizePath(transcriptPath)
  if (transcriptPath) {
    try {
      if (fs.statSync(transcriptPath).isFile()) return transcriptPath
    } catch {
      /* session_id 経由へ */
    }
  }
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return null
  const base = path.join(os.homedir(), '.claude', 'projects')
  let dirs
  try {
    dirs = fs.readdirSync(base)
  } catch {
    return null
  }
  for (const d of dirs) {
    const p = path.join(base, d, sessionId + '.jsonl')
    try {
      if (fs.statSync(p).isFile()) return p
    } catch {
      /* 次へ */
    }
  }
  return null
}

function readStdinJson() {
  try {
    if (process.stdin && process.stdin.isTTY) return null
  } catch {
    /* 続行 */
  }
  let raw
  try {
    raw = fs.readFileSync(0, 'utf8')
  } catch {
    return null
  }
  if (!raw || !raw.trim()) return null
  try {
    const j = JSON.parse(raw)
    return { sessionId: j.session_id || null, transcript: j.transcript_path || null, cwd: j.cwd || null }
  } catch {
    return null
  }
}

/** 転写本文（文字列）から最後の応答本文を取り出す。純粋関数（テスト用に公開）。 */
function lastAssistantTextFromLines(text) {
  const lines = text.split('\n')
  const chunks = []
  // 末尾から遡り、assistant の text を集め、user（人間の発話 or tool_result）に当たったら止める
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || line.indexOf('"type"') < 0) continue
    let j
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    if (j.type === 'assistant') {
      const c = j.message && j.message.content
      if (Array.isArray(c)) {
        const t = c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
        if (t) chunks.unshift(t)
      }
      continue
    }
    if (j.type === 'user') {
      // tool_result だけの user 記録はターン内の継続。人間の発話（text を含む）で止める
      const c = j.message && j.message.content
      const isToolResultOnly = Array.isArray(c) && c.length > 0 && c.every((b) => b && b.type === 'tool_result')
      if (isToolResultOnly) continue
      if (chunks.length) break
      // まだ assistant を 1 つも拾っていない（最終記録が user）→ 直前ターンは検査対象外
      return ''
    }
  }
  return chunks.join('\n')
}

/** env / stdin から転写を解決して最後の応答本文を返す。判定不能は ''。 */
function lastAssistantText(env, stdinJson) {
  let tp = env.LAT_TRANSCRIPT || null
  let sid = env.LAT_SESSION_ID || null
  if (!tp && !sid && stdinJson) {
    tp = stdinJson.transcript
    sid = stdinJson.sessionId
  }
  const file = resolveTranscript(tp, sid)
  if (!file) return ''
  try {
    return lastAssistantTextFromLines(tailText(file))
  } catch {
    return ''
  }
}

module.exports = { lastAssistantText, lastAssistantTextFromLines, resolveTranscript, readStdinJson, tailText }
