#!/usr/bin/env node
/*
 * verification-board-detect.cjs — 実機視認ボード義務化ゲートの「検出核」（純粋判定）。
 *
 * 役割（testable-stop-hook-gate-authoring §1 の node 核）:
 *   「何を言うべきか」だけを担う。対象があれば完成した block-JSON を JSON.stringify で
 *   stdout に出し、bash 足場は printf のみ（JSON エスケープ事故ゼロ）。判定不能は空出力＝非 block。
 *
 * 判定:
 *   VBG_CHANGES が空（コード変更なし）→ 非 block。
 *   今日付けの報告書 MD を _Prompt 配下から探し、frontmatter status が
 *   「実機視認待ち」（pending-user-verification を含む）のものについて、
 *   同じ場所（output_dir があればそこ、無ければ MD と同ディレクトリ）に
 *   視認ボード HTML（ファイル名に「視認ボード」または board を含む .html）が無ければ block。
 *
 * fail-open の向き（§4）: _Prompt 不在 / MD 読めない / frontmatter 無し / 判定不能 → 非 block。
 *   「視認待ち報告が在るのにボードが無い」ときだけ block（cry-wolf を避ける向きに倒す）。
 *
 * env（テスタブル化・§3）:
 *   VBG_PROJECT_DIR : プロジェクトルート（既定 CLAUDE_PROJECT_DIR or '.'）
 *   VBG_CHANGES     : '1'=コード変更あり / ''=なし（bash 足場が git で判定して渡す）
 *   VBG_PROMPT_DIR  : _Prompt ディレクトリ上書き（fixture 用。既定 <root>/_Prompt）
 *   VBG_TODAY_8 / VBG_TODAY_6 : 日付上書き（YYYYMMDD / YYMMDD。既定は実日付）
 */
'use strict'
const fs = require('fs')
const path = require('path')

const PENDING_RE = /pending-user-verification/i
const BOARD_RE = /(視認ボード|board)/i
const MAX_DEPTH = 6

function pad2(n) {
  return String(n).padStart(2, '0')
}

function resolveToday(env) {
  const t8 = env.VBG_TODAY_8
  const t6 = env.VBG_TODAY_6
  if (t8 && t6) return { t8, t6 }
  const d = new Date()
  const y = d.getFullYear()
  const mo = pad2(d.getMonth() + 1)
  const da = pad2(d.getDate())
  return { t8: `${y}${mo}${da}`, t6: `${String(y).slice(2)}${mo}${da}` }
}

function walk(dir, depth, acc) {
  if (depth < 0) return acc
  let ents
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, depth - 1, acc)
    else acc.push(p)
  }
  return acc
}

function frontmatter(txt) {
  const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return m ? m[1] : ''
}

// 仕様（Codex レビュー明文化）: frontmatter の単一行スカラー値のみを読む。
// status が YAML の複数行・配列形式（例: `status:\n  - x`）の場合はマッチせず空を返す＝fail-open
// （非 block）に倒れる。報告書 status は単一行運用のため実害なし。
function fmField(fm, key) {
  const re = new RegExp('^' + key + ':[ \\t]*(.*)$', 'm')
  const m = fm.match(re)
  if (!m) return ''
  return m[1]
    .replace(/\s*#.*$/, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim()
}

/** 純粋判定。block 対象があれば block-JSON 文字列を、無ければ '' を返す。 */
function detect(env) {
  if (!env.VBG_CHANGES) return '' // コード変更なし → 非 block

  const projectDir = env.VBG_PROJECT_DIR || env.CLAUDE_PROJECT_DIR || '.'
  const promptDir = env.VBG_PROMPT_DIR || path.join(projectDir, '_Prompt')
  if (!fs.existsSync(promptDir)) return '' // fail-open

  const { t8, t6 } = resolveToday(env)
  const todayMds = walk(promptDir, MAX_DEPTH, [])
    .filter((p) => /\.md$/i.test(p))
    .filter((p) => {
      const b = path.basename(p)
      return b.startsWith(t8 + '_') || b.startsWith(t6 + '_')
    })

  for (const md of todayMds) {
    let txt
    try {
      txt = fs.readFileSync(md, 'utf8')
    } catch {
      continue
    }
    const fm = frontmatter(txt)
    if (!fm) continue
    if (!PENDING_RE.test(fmField(fm, 'status'))) continue

    // この報告書は実機視認待ち。対応する視認ボード HTML を探す。
    const od = fmField(fm, 'output_dir')
    let targetDir
    if (od) targetDir = path.isAbsolute(od) ? od : path.join(projectDir, od)
    else targetDir = path.dirname(md)

    let files
    try {
      files = fs.readdirSync(targetDir)
    } catch {
      files = []
    }
    const hasBoard = files.some((f) => /\.html$/i.test(f) && BOARD_RE.test(f))
    if (!hasBoard) {
      const reason =
        '実機視認待ちの報告書（status に pending-user-verification / ' +
        path.basename(md) +
        '）を検出しましたが、対応する視認ボード HTML が見つかりません（探索先: ' +
        targetDir +
        '）。人間の実機テストを依頼する完了報告には、入力可能な視認ボード HTML' +
        '（handmade-dashboard 形式・ファイル名に「視認ボード」を含む・判定ボタン+コメント欄+まとめコピー）を' +
        '同じ場所に添付してから停止してください。抑制は ~/.ccpit/app-config.json の ' +
        '"verificationBoardMode"（soft=セッション1回 / strict=毎ターン / off=無効）。'
      return JSON.stringify({ decision: 'block', reason }, null, 2)
    }
  }
  return '' // 視認待ち報告なし、または全てにボードあり → 非 block
}

if (require.main === module) {
  try {
    const out = detect(process.env)
    if (out) process.stdout.write(out + '\n')
  } catch {
    // fail-open: 判定不能は非 block（cry-wolf 回避）
  }
  process.exit(0)
}

module.exports = { detect, frontmatter, fmField, resolveToday }
