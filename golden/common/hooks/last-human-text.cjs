#!/usr/bin/env node
/*
 * last-human-text.cjs — Stop hook 検出核の共通ヘルパ（handover-declaration-gate 専用の追加ヘルパ）。
 *
 * last-assistant-text.cjs は一切改変しない（兄弟ゲート paste-delimiter / opaque-approval への回帰リスクを
 * ゼロにするため）。本ファイルはその exports（resolveTranscript / tailText / readStdinJson）だけを再利用し、
 * 「転写の中で、どの記録が“人間が打った生発言”か」を判定するロジックを新たに持つ。
 *
 * 背景（CCPIT_071 §3-2 検査5・r1レビュー反映）:
 *   transcript の各行は role:"user" でも、(a) ツール実行結果（content が配列で tool_result のみ）、
 *   (b) システムが差し込んだ文（Stop hook の差し戻し文・Skill ツールの base-directory 注入文・
 *   cross-session 通知・バックグラウンドタスク完了通知等）が混在する。(b) の一部は isMeta:true が
 *   付くが、<task-notification> のように付かないケースが実 transcript で確認されている（isMeta 単独では
 *   不十分）。よって isMeta と既知の注入文パターンの両方で多層に除外する。
 *
 *   分類できない記録は「人間の同意」としては数えない（安全側）。これは外側の fail-open
 *   （転写が読めない等）とは別で、「同意の成立」を判定する側の話である。
 */
'use strict'
const lat = require('./last-assistant-text.cjs')

// 既知のシステム注入文パターン（isMeta が付かないケースの content-pattern フォールバック）。
const INJECTED_PREFIX_RE = /^\s*(<task-notification>|<cross-session-message|\[Cross-session|Stop hook feedback:|Stop hook blocking error|<local-command-stdout>|<system-reminder>)/

function parseLines(text) {
  const out = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.indexOf('"type"') < 0) continue
    let j
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    out.push(j)
  }
  return out
}

function blockText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

function isToolResultOnly(content) {
  return Array.isArray(content) && content.length > 0 && content.every((b) => b && b.type === 'tool_result')
}

/** record が「人間が打った生発言」なら本文を、そうでなければ null を返す。 */
function humanRealText(rec) {
  if (!rec || rec.type !== 'user') return null
  const content = rec.message && rec.message.content
  if (isToolResultOnly(content)) return null
  if (rec.isMeta === true) return null
  const text = blockText(content)
  if (!text) return null
  if (INJECTED_PREFIX_RE.test(text)) return null
  return text
}

const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})/
// 閉じフェンスは CommonMark 規約上、マーカーの後に空白以外を置けない（info-string は開始行のみ許される）。
const FENCE_CLOSE_RE = /^\s*(`{3,}|~{3,})\s*$/

/** コードフェンス（``` または ~~~ で開始・同種同数以上・末尾空白のみの行で閉じる）の中身を取り除く。
 *  フェンス内のデコイ文字列（report_id 等）で誤検出しないため。行ベースで開閉を追跡し、
 *  ``` と ~~~ の混同・長さ違い・info-string 付き偽閉じ行の誤対応を避ける
 *  （Codex レビュー指摘[3]、第2ラウンド指摘[2]反映）。 */
function stripFences(text) {
  const lines = text.split('\n')
  const out = []
  let fenceChar = null
  let fenceLen = 0
  for (const line of lines) {
    if (fenceChar) {
      const closeM = FENCE_CLOSE_RE.exec(line)
      if (closeM && closeM[1][0] === fenceChar && closeM[1].length >= fenceLen) {
        fenceChar = null
        fenceLen = 0
      }
      continue
    }
    const openM = FENCE_OPEN_RE.exec(line)
    if (openM) {
      fenceChar = openM[1][0]
      fenceLen = openM[1].length
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

/** record が assistant のテキスト本文を持つなら連結して返す（コードフェンス除去済み）。無ければ ''。 */
function assistantText(rec) {
  if (!rec || rec.type !== 'assistant') return ''
  const content = rec.message && rec.message.content
  return stripFences(blockText(content))
}

/**
 * records（parseLines の出力）の中から、index < beforeIndex の範囲で、
 * assistant テキストが reportId と「準拠していません」を両方含む最後（最も新しい）の位置を返す。
 * 見つからなければ -1。
 */
function findLastPresentationIndex(records, reportId, beforeIndex) {
  if (!reportId) return -1
  const limit = typeof beforeIndex === 'number' ? beforeIndex : records.length
  for (let i = Math.min(limit, records.length) - 1; i >= 0; i--) {
    const t = assistantText(records[i])
    if (t && t.indexOf(reportId) >= 0 && t.indexOf('準拠していません') >= 0) return i
  }
  return -1
}

/** records の中で、index < beforeIndex の範囲での最後の人間生発言のインデックス。無ければ -1。 */
function lastHumanIndex(records, beforeIndex) {
  const limit = typeof beforeIndex === 'number' ? beforeIndex : records.length
  for (let i = Math.min(limit, records.length) - 1; i >= 0; i--) {
    if (humanRealText(records[i]) !== null) return i
  }
  return -1
}

/** fromIndexExclusive より後（かつ配列の範囲内）にある人間生発言の本文を全件、出現順で返す。 */
function humanRealTextsAfter(records, fromIndexExclusive) {
  const out = []
  for (let i = fromIndexExclusive + 1; i < records.length; i++) {
    const t = humanRealText(records[i])
    if (t !== null) out.push(t)
  }
  return out
}

/** env / stdin から転写を解決し、parseLines した records を返す。読めなければ []。 */
function loadRecords(env, stdinJson) {
  let tp = env.LAT_TRANSCRIPT || null
  let sid = env.LAT_SESSION_ID || null
  if (!tp && !sid && stdinJson) {
    tp = stdinJson.transcript
    sid = stdinJson.sessionId
  }
  const file = lat.resolveTranscript(tp, sid)
  if (!file) return []
  try {
    return parseLines(lat.tailText(file))
  } catch {
    return []
  }
}

module.exports = {
  parseLines,
  humanRealText,
  assistantText,
  stripFences,
  findLastPresentationIndex,
  lastHumanIndex,
  humanRealTextsAfter,
  loadRecords
}
