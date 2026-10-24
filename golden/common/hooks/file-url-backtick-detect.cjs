#!/usr/bin/env node
/*
 * file-url-backtick-detect.cjs — 「バッククォートで囲まれていない file:/// URL」禁止ゲートの検出核（純粋判定）。
 *
 * 背景: CLI は応答本文を Markdown として表示する。GFM は file: スキームを自動リンクにしないため、
 *   裸の file:/// URL は普通の文章として処理され、パス中の `_` が斜体の記号として消える
 *   （例: `/_Prog/…/WitLab_%E4…` の 2 つの `_` が組になって消える）。利用者がコピーした URL は開けない。
 *   2026-09-25 に実発生。利用者が画面から写した URL と照合し、消えたのは `_` 4 つだけ・
 *   CommonMark の強調規則の予測と完全一致したことを確認済み。
 *
 * 判定（最後の assistant 応答本文に対して）:
 *   フェンスのコードブロック（``` / ~~~）とインラインコード（`…` / ``…``）を取り除き、
 *   残りに file:/// が 1 つでもあれば block。
 *
 * 既知の限界: インデント 4 桁のコードブロックは取り除かない（その中の裸 URL は安全だが block する＝過検出側）。
 *
 * fail-open: 転写が読めない・本文が空 → 非 block。
 * env: LAT_TRANSCRIPT / LAT_SESSION_ID / FUBG_TEXT（本文直接注入）/ FUBG_STDIN_JSON
 */
'use strict'
const lat = require('./last-assistant-text.cjs')

const FILE_URL_RE = /file:\/\/\//i

/** フェンスのコードブロックを空行に置き換える（行数は保つ） */
function stripFences(text) {
  const lines = text.split('\n')
  const out = []
  let fence = null
  for (const ln of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(ln)
    if (fence) {
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && /^\s*$/.test(m[2])) fence = null
      out.push('')
      continue
    }
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      fence = { ch: m[1][0], len: m[1].length }
      out.push('')
      continue
    }
    out.push(ln)
  }
  return out.join('\n')
}

/** インラインコードを取り除く。同じ長さのバッククォート列で閉じたものだけ。空行はまたがない */
function stripInlineCode(s) {
  let res = ''
  let i = 0
  while (i < s.length) {
    if (s[i] !== '`') {
      res += s[i++]
      continue
    }
    let n = 0
    while (s[i + n] === '`') n++
    let j = i + n
    let found = -1
    while (j < s.length) {
      if (s[j] === '\n' && /^\n[ \t]*\n/.test(s.slice(j, j + 64))) break
      if (s[j] === '`') {
        let k = 0
        while (s[j + k] === '`') k++
        if (k === n) {
          found = j
          break
        }
        j += k
      } else {
        j++
      }
    }
    if (found < 0) {
      res += s.slice(i, i + n)
      i += n
      continue
    }
    res += ' '
    i = found + n
  }
  return res
}

/** 裸の file:/// があればその周辺（最大 80 字）を返す。無ければ null */
function judge(text) {
  if (!text) return null
  const bare = stripInlineCode(stripFences(text))
  const m = FILE_URL_RE.exec(bare)
  if (!m) return null
  return bare.slice(m.index, m.index + 80).split('\n')[0]
}

function reasonFor(snippet) {
  return (
    'バッククォートで囲まれていない file:/// URL があります（' + snippet + '…）。' +
    'CLI の Markdown 表示は裸の file:/// をリンクにせず、パス中の `_` を斜体の記号として消すため、利用者がコピーした URL は開けません。' +
    '書き直し: file:/// URL は必ずバッククォートで囲む（例: `file:///C:/…`）。SOR/EOR ブロックの中や表の中でも同じ。' +
    'URL は手で打たず、実ファイルから Node の url.pathToFileURL() で機械生成した文字列を使う。' +
    '抑制: ~/.ccpit/app-config.json の "fileUrlBacktickGateMode"（soft/strict/off）。'
  )
}

function detect(env, stdinJson) {
  const text = env.FUBG_TEXT !== undefined ? env.FUBG_TEXT : lat.lastAssistantText(env, stdinJson)
  const snippet = judge(text)
  if (!snippet) return ''
  return JSON.stringify({ decision: 'block', reason: reasonFor(snippet) }, null, 2)
}

if (require.main === module) {
  try {
    const stdin = process.env.FUBG_STDIN_JSON ? lat.readStdinJson() : null
    const out = detect(process.env, stdin)
    if (out) process.stdout.write(out + '\n')
  } catch {
    /* fail-open */
  }
  process.exit(0)
}

module.exports = { detect, judge, stripFences, stripInlineCode }
