#!/usr/bin/env node
/*
 * md2html.cjs — CCPIT 決定論的 Markdown→HTML レンダラ (件3 / md-render skill 本体)
 *
 * 設計正本: _Prompt/02_buildai/20260612_0242_CCPIT_Step10Gen1_IndexGate_MdHtmlRenderer_InvestigationReport_r1.md
 *
 * 原則:
 *  - 純関数: HTML = f(MD バイト列, 内蔵テンプレート)。壁時計/環境変数/他ファイルを入力にしない。
 *    生成タイムスタンプは入れない。フッタは「正本ファイル名 + MD sha256 先頭12桁」のみ (data 属性)。
 *  - テンプレートはテキストノードを持たない: <body> 内の全テキストは MD トークン由来。
 *    chrome ラベル (TOC 題 / 要判断一覧題 / 件数バッジ / フッタ sha) は CSS 擬似要素 or data-* 属性。
 *  - 生 HTML 不透過 + エスケープ恒常化: MD 中の生 HTML はリテラル表示。
 *  - 依存ゼロ: Node 組み込み (fs/path/crypto) のみ。対応構文は閉じた 8 種。未対応はリテラル退化。
 *
 * CLI:
 *   node md2html.cjs <in.md> [out.html]     MD → HTML (out 省略時は stdout)
 *   node md2html.cjs --verify <in.md>        双方向検証: HTML⊆MD(捏造防止) + MD⊆HTML(欠落防止) (違反で exit 1)
 *     --verify-html / --verify-md            片方向のみ実行 (デバッグ用)
 *   node md2html.cjs --lint <in.md>          報告書型 frontmatter の必須マーカー欠落を警告 (exit 0 維持)
 *   node md2html.cjs --selftest              内蔵 golden ケースを描画し埋込 sha256 と照合 (破損検出)
 *   node md2html.cjs --check <in.md> <html>  HTML 埋込 sha256 と現 MD sha256 を照合 (_index 鮮度用 / 件2 ④ 先取り)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// 低レベルユーティリティ
// ---------------------------------------------------------------------------

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function sha1(str) {
  return crypto.createHash('sha1').update(str, 'utf8').digest('hex');
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// ホバー機能 (opt-in) のレンダラ内状態。
// render() 開始時に必ずリセットする。非 hover 文書では _hoverMode=false のため
// renderInline のリンク出力は一切変化しない (既存リンク byte 不変)。
// 決定論: 状態は MD の frontmatter から純粋に導出され、render() 呼び出し毎に確定する。
// ---------------------------------------------------------------------------

let _hoverMode = false;
let _hoverIndex = null; // Map<識別子(URL等), index 文字列>

// ---------------------------------------------------------------------------
// インライン: code span / bold / link のみ (regs §4-2 の 8 種のインライン部)
// 未対応のインライン記法はリテラル退化 (全リテラル文字はエスケープ経由)。
// ---------------------------------------------------------------------------

function renderInline(raw) {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    // code span
    if (c === '`') {
      const end = raw.indexOf('`', i + 1);
      if (end !== -1) {
        out += '<code>' + escapeHtml(raw.slice(i + 1, end)) + '</code>';
        i = end + 1;
        continue;
      }
    }
    // bold **...**
    if (c === '*' && raw[i + 1] === '*') {
      const end = raw.indexOf('**', i + 2);
      if (end !== -1) {
        out += '<strong>' + renderInline(raw.slice(i + 2, end)) + '</strong>';
        i = end + 2;
        continue;
      }
    }
    // link [text](url)
    if (c === '[') {
      const close = raw.indexOf(']', i + 1);
      if (close !== -1 && raw[close + 1] === '(') {
        const paren = raw.indexOf(')', close + 2);
        if (paren !== -1) {
          const text = raw.slice(i + 1, close);
          const url = raw.slice(close + 2, paren);
          // ホバー属性付与は厳密に gating 内に閉じ込める:
          //   hoverMode かつ URL が http/https かつ fm.hover の識別子に一致する時のみ。
          // それ以外 (非 hover 文書 / 非一致 / 相対 / mailto 等) は従来どおり無属性
          //   → 既存リンク出力 byte 不変。
          let extra = '';
          if (_hoverMode && _hoverIndex && /^https?:\/\//.test(url) && _hoverIndex.has(url)) {
            extra =
              ' class="hoverable" data-hkey="' + escapeAttr(_hoverIndex.get(url)) +
              '" target="_blank" rel="noopener"';
          }
          out += '<a href="' + escapeAttr(url) + '"' + extra + '>' + renderInline(text) + '</a>';
          i = paren + 1;
          continue;
        }
      }
    }
    out += escapeHtml(c);
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// frontmatter (最小 YAML サブセット: scalar + インラインリスト [a, b])
// ---------------------------------------------------------------------------

function parseFrontmatter(md) {
  if (!md.startsWith('---\n') && !md.startsWith('---\r\n')) {
    return { fm: null, fmOrder: [], body: md };
  }
  const lines = md.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { fm: null, fmOrder: [], body: md };

  const fm = {};
  const fmOrder = [];
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    // hover: ブロック宣言 (opt-in)。値が空で、次行以降がインデントされた
    //   "- 識別子 || 要約文" の場合のみ配列 fm.hover=[{key,summary}] に捕捉する。
    //   hover: 不在時はこの分岐に入らず既存挙動を一切変えない。
    //   壊れた行 (|| 区切りなし等) は捕捉対象から外す (lint が警告する)。
    if (key === 'hover' && val === '') {
      const items = [];
      let j = i + 1;
      while (j < end && /^\s+\S/.test(lines[j])) {
        const im = lines[j].match(/^\s+-\s+(.*)$/);
        if (im) {
          const raw = im[1];
          const sep = raw.indexOf('||');
          if (sep !== -1) {
            const hk = raw.slice(0, sep).trim();
            const summary = raw.slice(sep + 2).trim();
            if (hk) items.push({ key: hk, summary });
          }
          // || なしの壊れた行は捕捉しない (lint 警告対象)
        }
        j++;
      }
      i = j - 1; // 消費した子行をスキップ
      fm.hover = items;
      fmOrder.push('hover');
      continue;
    }
    // comments_resolved: ブロック宣言 (opt-in)。hover と同型。値が空で、次行以降が
    //   インデントされた以下いずれかの場合のみ fm.comments_resolved に捕捉する。
    //     3 部: "- 見出し || 元コメント || CC 対応メモ" → {key, original, memo}
    //     2 部: "- 見出し || CC 対応メモ"               → {key, memo, original:''}
    //   区切りは "||" (前後の空白は trim)。3 部は最初の "||" を sep1、2 番目を sep2 とする。
    //   後方互換: 2 部 (元コメント無し) は従来どおり original を空文字にし読取専用埋込を出さない。
    //   ※ "||" は本 DSL の予約区切り子。entry 内に 3 個以上 "||" がある場合、最初の 2 個で
    //     見出し/元コメント/メモに 3 分割し、3 個目以降はメモ本文の一部として残る (sep2 は最初の
    //     1 個のみ消費)。よって元コメント・メモ本文に "||" を含めない (含めると分割位置がずれる)。
    //     Codex MINOR 指摘: 旧 2 部メモが "||" を含むと 3 部に再解釈される → 元コメント/メモは
    //     "||" 非含有を前提とする運用契約 (SKILL.md にも明記)。
    //   comments_resolved: 不在時はこの分岐に入らず既存挙動を一切変えない (byte 不変)。
    //   壊れた行 (|| 区切りなし等) は捕捉対象から外す (lint が警告する)。
    if (key === 'comments_resolved' && val === '') {
      const items = [];
      let j = i + 1;
      while (j < end && /^\s+\S/.test(lines[j])) {
        const im = lines[j].match(/^\s+-\s+(.*)$/);
        if (im) {
          const raw = im[1];
          const sep1 = raw.indexOf('||');
          if (sep1 !== -1) {
            const rk = raw.slice(0, sep1).trim();
            const rest = raw.slice(sep1 + 2);
            const sep2 = rest.indexOf('||');
            if (sep2 !== -1) {
              // 3 部: 見出し || 元コメント || CC 対応メモ
              const original = rest.slice(0, sep2).trim();
              const memo = rest.slice(sep2 + 2).trim();
              if (rk) items.push({ key: rk, original, memo });
            } else {
              // 2 部: 見出し || CC 対応メモ (元コメント無し)
              const memo = rest.trim();
              if (rk) items.push({ key: rk, memo, original: '' });
            }
          }
          // || なしの壊れた行は捕捉しない (lint 警告対象)
        }
        j++;
      }
      i = j - 1; // 消費した子行をスキップ
      fm.comments_resolved = items;
      fmOrder.push('comments_resolved');
      continue;
    }
    // インラインリストは最初の ']' で閉じる (末尾コメント "[a, b]  # ..." を許容)。
    // スカラ値の ' #' は除去しない (既存文書に "FeatureRequest #7" 等の正当値が実在)。
    if (val.startsWith('[')) {
      const close = val.indexOf(']');
      if (close !== -1) {
        val = val.slice(1, close).split(',').map((x) => x.trim()).filter(Boolean);
      }
    }
    fm[key] = val;
    fmOrder.push(key);
  }
  const body = lines.slice(end + 1).join('\n');
  return { fm, fmOrder, body };
}

// ---------------------------------------------------------------------------
// ブロックトークナイザ (行ベース, 8 種)
//  heading / table / fence(code|mermaid|svg) / blockquote(admonition) /
//  list / hr / paragraph
// ---------------------------------------------------------------------------

function isTableSeparator(line) {
  // |---|:--:|---| 形式
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  // エスケープされていない | で分割 (本サブセットでは \| 非対応。素の split)
  return s.split('|').map((c) => c.trim());
}

function tokenize(body) {
  const lines = body.split(/\r?\n/);
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (line.trim() === '') {
      i++;
      continue;
    }

    // フェンス (``` or ~~~, >=3, 可変長)
    const fence = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const indent = fence[1];
      const marker = fence[2];
      const info = fence[3].trim();
      const content = [];
      i++;
      while (i < lines.length) {
        const close = lines[i].match(/^(\s*)(`{3,}|~{3,})\s*$/);
        if (close && lines[i].trim().startsWith(marker[0]) && close[2].length >= marker.length) {
          i++;
          break;
        }
        content.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'fence', info, content, indent });
      continue;
    }

    // 見出し H1-H4
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const htext = heading[2].trim();
      // アンカー: 位置非依存・見出し依存 (sec-+sha1(canon(見出し))[:8])。再レンダリングでも
      // 見出しが同じなら id 不変 = コメントが迷子にならない (RDV 移植の最重要価値)。
      // 接尾辞は付けない (canon 同一見出しは id 共有 = 完全決定論。重複は lint が警告)。
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        text: htext,
        id: 'sec-' + sha1(canon(htext)).slice(0, 8),
      });
      i++;
      continue;
    }

    // 水平線 (--- / *** / ___)  ※ frontmatter は parseFrontmatter で除去済み
    if (/^(\s*)(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // blockquote (admonition 含む)
    if (/^\s*>/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      const first = quoteLines[0] || '';
      const adm = first.match(/^\[!([A-Za-z]+)\]\s*(.*)$/);
      if (adm) {
        blocks.push({
          type: 'admonition',
          adType: adm[1].toUpperCase(),
          title: adm[2].trim(),
          content: quoteLines.slice(1),
        });
      } else {
        blocks.push({ type: 'blockquote', content: quoteLines });
      }
      continue;
    }

    // テーブル (現在行に | があり、次行が区切り行)
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':');
        const r = c.endsWith(':');
        if (l && r) return 'center';
        if (r) return 'right';
        if (l) return 'left';
        return '';
      });
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', header, aligns, rows });
      continue;
    }

    // リスト (- / * / + / 数字., ネスト 2 段まで)
    if (/^(\s*)([-*+]|\d+\.)\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^(\s*)([-*+]|\d+\.)\s+/.test(lines[i])) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        const indent = m[1].length;
        const ordered = /\d+\./.test(m[2]);
        items.push({ indent, ordered, text: m[3] });
        i++;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    // 段落 (連続する非特殊行)
    const para = [];
    while (i < lines.length && lines[i].trim() !== '') {
      const l = lines[i];
      if (
        /^(#{1,4})\s+/.test(l) ||
        /^\s*>/.test(l) ||
        /^(\s*)(`{3,}|~{3,})/.test(l) ||
        /^(\s*)(-{3,}|\*{3,}|_{3,})\s*$/.test(l) ||
        /^(\s*)([-*+]|\d+\.)\s+/.test(l) ||
        (l.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
      ) {
        break;
      }
      para.push(l);
      i++;
    }
    if (para.length) blocks.push({ type: 'paragraph', lines: para });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// admonition 型 → CSS クラス + 表示ラベルは CSS 擬似要素 (テキストノード非生成)
// ---------------------------------------------------------------------------

const ADM_CLASS = {
  DECISION: 'adm-decision',
  DA: 'adm-da',
  NOTE: 'adm-note',
  WARNING: 'adm-warning',
  TIP: 'adm-tip',
  IMPORTANT: 'adm-important',
};

// ---------------------------------------------------------------------------
// ブロック描画
// ---------------------------------------------------------------------------

function renderList(items, summaryBadge) {
  // ネスト 2 段まで。indent でグルーピング
  // summaryBadge: 結論の概要パネル限定。最上位 li の先頭が **OK/FAIL/CAVEAT/INFO** 完全一致なら
  //   状態バッジ (色付きピル) に変換。ラベル文字は MD 由来 (HTML⊆MD・決定論)。集合外/ネスト内は不変。
  const CONC_BADGES = { OK: 'ok', FAIL: 'fail', CAVEAT: 'caveat', INFO: 'info' };
  const topIndent = items.length ? items[0].indent : 0;
  let html = '';
  let idx = 0;
  function consume(minIndent) {
    if (idx >= items.length) return '';
    const baseIndent = items[idx].indent;
    const ordered = items[idx].ordered;
    let out = ordered ? '<ol>' : '<ul>';
    while (idx < items.length && items[idx].indent === baseIndent) {
      const it = items[idx];
      idx++;
      const bm = summaryBadge && baseIndent === topIndent
        ? it.text.match(/^\*\*(OK|FAIL|CAVEAT|INFO)\*\*(\s|$)/) : null;
      const inner = bm
        ? '<span class="conc-badge conc-' + CONC_BADGES[bm[1]] + '">' + bm[1] + '</span>' +
            renderInline(it.text.slice(bm[0].length - bm[2].length))
        : renderInline(it.text);
      let li = '<li>' + inner;
      // 子 (より深い indent) を取り込む
      if (idx < items.length && items[idx].indent > baseIndent) {
        li += consume(items[idx].indent);
      }
      li += '</li>';
      out += li;
    }
    out += ordered ? '</ol>' : '</ul>';
    return out;
  }
  while (idx < items.length) {
    html += consume(items[idx].indent);
  }
  return html;
}

// 純数値セル判定 (版数 v1.5.0 / 日付 2026-06-12 は '-'/'v'/二重ドットで弾く)
function parsePureNumber(cell) {
  const s = (cell || '').trim();
  if (!/^[\d,]+(\.\d+)?%?$/.test(s)) return null;
  const n = parseFloat(s.replace(/,/g, '').replace('%', ''));
  return Number.isFinite(n) ? n : null;
}

// DA 比例バー: 列単位で「全データセルが純数値 (空は許容)」かつ 2 行以上を数値列とみなす。
// バー幅は列内 max に対する比率 (CSS inline style = テキストノード非生成 / r1 §3-2-5 整合)。
// レンダラは割合ラベル等の新規テキストを生成しない (バーは style のみ)。
function analyzeNumericColumns(block) {
  const cols = block.header.length;
  const numeric = [];
  for (let k = 0; k < cols; k++) {
    let count = 0;
    let max = 0;
    let min = Infinity;
    let allNum = true;
    for (const row of block.rows) {
      const cell = (row[k] || '').trim();
      if (cell === '') continue;
      const n = parsePureNumber(cell);
      if (n === null) {
        allNum = false;
        break;
      }
      count++;
      if (n > max) max = n;
      if (n < min) min = n;
    }
    numeric[k] = allNum && count >= 2 ? { max, min } : null;
  }
  return numeric;
}

// r3: 値依存カラースケール (意味中立 = 列内の大小位置のみを示す。良し悪しを込めない)
// Codex 相談 案A: シアン(低) → 深シアン → エメラルド → 黄 → ピンク → マゼンタ(高)。
// 中間緑 #10B981 は図の意味色ティール #5EEAD4 と非衝突 (設計制約)。
const BAR_ANCHORS = [
  [0.0, [0x22, 0xd3, 0xee]],
  [0.18, [0x06, 0xb6, 0xd4]],
  [0.43, [0x10, 0xb9, 0x81]],
  [0.58, [0xfa, 0xcc, 0x15]],
  [0.84, [0xf4, 0x72, 0xb6]],
  [1.0, [0xd9, 0x46, 0xef]],
];

// t∈[0,1] → {hex, rgba}。両端強調ワープ (γ=2.0: 中間圧縮・0/1 近傍急峻) +
// アンカー区分線形 RGB 補間。純関数 = 同値→同色 (決定論)。
function barColor(t) {
  const x = 2 * t - 1;
  const w = 0.5 + 0.5 * Math.sign(x) * Math.pow(Math.abs(x), 2);
  let rgb = BAR_ANCHORS[BAR_ANCHORS.length - 1][1];
  for (let i = 1; i < BAR_ANCHORS.length; i++) {
    const p0 = BAR_ANCHORS[i - 1][0];
    const c0 = BAR_ANCHORS[i - 1][1];
    const p1 = BAR_ANCHORS[i][0];
    const c1 = BAR_ANCHORS[i][1];
    if (w <= p1) {
      const u = (w - p0) / (p1 - p0);
      rgb = c0.map((a, k) => Math.round(a + (c1[k] - a) * u));
      break;
    }
  }
  const hex = '#' + rgb.map((v) => v.toString(16).toUpperCase().padStart(2, '0')).join('');
  return { hex, rgba: 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',.3)' };
}

function renderTable(block) {
  const numericCols = analyzeNumericColumns(block);
  let html = '<div class="table-wrap"><table>';
  html += '<thead><tr>';
  block.header.forEach((cell, k) => {
    const a = block.aligns[k] ? ' style="text-align:' + block.aligns[k] + '"' : '';
    const nc = numericCols[k] ? ' class="num-col"' : '';
    html += '<th' + nc + a + '>' + renderInline(cell) + '</th>';
  });
  html += '</tr></thead><tbody>';
  block.rows.forEach((row) => {
    html += '<tr>';
    row.forEach((cell, k) => {
      const a = block.aligns[k] ? ' style="text-align:' + block.aligns[k] + '"' : '';
      const col = numericCols[k];
      const n = col ? parsePureNumber(cell) : null;
      if (col && n !== null && col.max > 0) {
        const pct = Math.round((n / col.max) * 1000) / 10; // 0.1% 刻み = 決定論
        let style = 'width:' + pct + '%';
        if (col.max > col.min) {
          // 全値同一列は t 不定 → 上書きせず既定シアン (:root --bar) に退化
          const c = barColor((n - col.min) / (col.max - col.min));
          style += ';--bar:' + c.hex + ';--bar-soft:' + c.rgba;
          // 極値の非色シグナル: 列最大のみエッジ 3px (長さが主・色は補助。Codex Q5)
          if (n === col.max) style += ';border-right-width:3px';
        }
        html +=
          '<td class="num-cell"' + a + '><span class="bar" style="' + style + '"></span>' +
          '<span class="num">' + renderInline(cell) + '</span></td>';
      } else {
        html += '<td' + a + '>' + renderInline(cell) + '</td>';
      }
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  return html;
}

function renderFence(block) {
  const info = (block.info || '').toLowerCase();
  const raw = block.content.join('\n');
  if (info === 'mermaid') {
    // 三段フォールバック: クライアント描画 (未注入なら原文表示) — 原文は常にエスケープ済みで残る
    return '<pre class="mermaid">' + escapeHtml(raw) + '</pre>';
  }
  if (info === 'svg') {
    // (c) data URI 埋め込み: <img> 内 SVG はブラウザ sandbox で script 非実行 = 安全。
    // base64 は決定的 = 決定論維持。原文は data URI 属性に入りテキストノードにならない
    // (完全性検証では図ブロックとして除外)。生 <script> はそのまま実行 HTML にならない。
    const b64 = Buffer.from(raw, 'utf8').toString('base64');
    return '<img class="svg-fig" alt="" src="data:image/svg+xml;base64,' + b64 + '"/>';
  }
  const langAttr = info ? ' data-lang="' + escapeAttr(info) + '"' : '';
  return '<pre class="code"' + langAttr + '><code>' + escapeHtml(raw) + '</code></pre>';
}

function renderAdmonition(block, opts) {
  const cls = ADM_CLASS[block.adType] || 'adm-note';
  const id = opts && opts.id ? ' id="' + escapeAttr(opts.id) + '"' : '';
  // data-adm はラベル描画用 (CSS ::before content)。テキストノードではない。
  let html = '<div class="adm ' + cls + '"' + id + ' data-adm="' + escapeAttr(block.adType) + '">';
  if (block.title) html += '<p class="adm-title">' + renderInline(block.title) + '</p>';
  if (block.content && block.content.join('').trim()) {
    html += '<div class="adm-body">' + renderBlocks(tokenize(block.content.join('\n'))) + '</div>';
  }
  html += '</div>';
  return html;
}

function renderBlocks(blocks, decisionIds, summaryBadge) {
  let html = '';
  let decSeq = decisionIds ? decisionIds.seq : { n: 0 };
  for (const b of blocks) {
    switch (b.type) {
      case 'heading': {
        const tag = 'h' + b.level;
        html += '<' + tag + ' id="' + escapeAttr(b.id) + '">' + renderInline(b.text) + '</' + tag + '>';
        break;
      }
      case 'paragraph':
        html += '<p>' + renderInline(b.lines.join(' ')) + '</p>';
        break;
      case 'list':
        html += renderList(b.items, summaryBadge);
        break;
      case 'table':
        html += renderTable(b);
        break;
      case 'fence':
        html += renderFence(b);
        break;
      case 'blockquote':
        html += '<blockquote>' + renderBlocks(tokenize(b.content.join('\n'))) + '</blockquote>';
        break;
      case 'admonition': {
        let id = null;
        if (b.adType === 'DECISION' && decisionIds) {
          decSeq.n++;
          id = 'dec-' + decSeq.n;
          b._decId = id;
        }
        html += renderAdmonition(b, { id });
        break;
      }
      case 'hr':
        html += '<hr/>';
        break;
      default:
        break;
    }
  }
  return html;
}

// ---------------------------------------------------------------------------
// セクション分割 (H2 境界) と特殊セクション識別
// ---------------------------------------------------------------------------

function buildSections(blocks) {
  const sections = [];
  let current = null;
  let preamble = [];
  for (const b of blocks) {
    if (b.type === 'heading' && b.level <= 2) {
      if (b.level === 1) {
        // H1 はタイトル扱い。preamble に残す
        preamble.push(b);
        continue;
      }
      current = { heading: b, blocks: [] };
      sections.push(current);
    } else if (current) {
      current.blocks.push(b);
    } else {
      preamble.push(b);
    }
  }
  return { preamble, sections };
}

// 結論の概要 見出し判定 (classifySection と lint で共有し semantics 乖離を防ぐ・ja/en)。
const SUMMARY_HEADING_RE = /結論の概要|結論サマリ|conclusion\s*summary/i;

function classifySection(sec) {
  const t = sec.heading.text;
  if (/読者と目的/.test(t)) return 'audience';
  if (SUMMARY_HEADING_RE.test(t)) return 'summary';
  if (/スコープ外提案|Pending|ペンディング/i.test(t)) return 'pending';
  return 'body';
}

// H2 セクションの blocks を H3 境界で再分割する (comments: atomic 専用)。
//   buildSections は H2 境界でしか割らないため、H3 単位の Composer 注入位置を得るには
//   各 H2 の本文ブロック列を更に H3 (level 3) 見出しで区切る必要がある。
//   返り値: { lead, subsections } 。
//     lead       = 最初の H3 より前のブロック列 (H2 直下〜最初の H3 の直前。H3 が無ければ全ブロック)。
//     subsections = [{ heading: <H3 block>, blocks: [...] }, ...]。
//       各 subsection.blocks は その H3 見出しの後・次の H3 (level 3) の直前まで。
//       level 4 (H4) 以下は直前の H3 サブセクションに内包する (H4 単位の Composer は出さない
//       = Atomic 粒度は H3 = トピック単位)。H3 が現れる前の H4 は lead に残る。
//   純関数: 入力ブロック列のみから決定論的に導出する。atomic 分岐内でのみ呼ぶため
//   非 atomic 文書の出力は一切変化しない。
function splitByH3(blocks) {
  const lead = [];
  const subsections = [];
  let current = null;
  for (const b of blocks) {
    if (b.type === 'heading' && b.level === 3) {
      current = { heading: b, blocks: [] };
      subsections.push(current);
    } else if (current) {
      current.blocks.push(b);
    } else {
      lead.push(b);
    }
  }
  return { lead, subsections };
}

// 報告書型判定 (render / lint 共用)。frontmatter の報告書キー or 「読者と目的」セクションで検出。
function isReportDoc(fm, body) {
  return !!(
    (fm && (fm.doc_id || fm.report_id || fm.audience || fm.status)) ||
    /##\s*本報告書の読者と目的/.test(body)
  );
}

// 編集可能 Composer の内側マークアップ (toggle + 編集欄 + 保存カード)。テキストノード非生成。
//   data-section を変えるだけで「基底 id 用」「再コメント (<sid>:re) 用」の両方を生成できる。
//   COMMENT_LOADER / COMMENT_LOADER_RESOLVED が data-section をキーに localStorage を読む。
function editableComposer(sectionId) {
  const sid = escapeAttr(sectionId);
  return (
    '<div class="cmt" data-section="' + sid + '" data-state="empty">' +
    '<button class="cmt-toggle" type="button" aria-label="コメントを書く"></button>' +
    '<div class="cmt-edit">' +
    '<textarea class="cmt-input" aria-label="コメント入力" placeholder=""></textarea>' +
    '<div class="cmt-actions">' +
    '<button class="cmt-save" type="button" aria-label="保存"></button>' +
    '<button class="cmt-cancel" type="button" aria-label="キャンセル"></button>' +
    '</div></div>' +
    '<div class="cmt-card"><div class="cmt-display"></div>' +
    '<button class="cmt-editbtn" type="button" aria-label="編集"></button></div>'
  );
}

// コメント Composer (本文 H2 直下)。テキストノードを生成しない: ラベルは CSS ::before / aria 属性、
// textarea と表示領域は空 (本文は実行時に localStorage から JS で textContent 投入)。
// → verify (HTML⊆MD / MD⊆HTML) はテキストノード増分ゼロで不変。
//
// resolvedMap[sectionId] の形:
//   2 部 (元コメント無し): { rk:<index>, hasOrig:false }
//   3 部 (元コメント有り): { rk:<index>, hasOrig:true }
//   不在 / 非該当 sectionId: 既存 Composer 出力 byte 不変 (resolvedMap 自体が null の非 resolved 文書を含む)。
//
// 出力 3 分岐:
//   (i)  非 resolved (resolvedMap 不在 or 非該当): 従来どおり編集 Composer のみ = byte 不変。
//   (ii) resolved・元コメント無し (hasOrig:false): 編集 Composer + 旧 resolvedBlock (バッジ+メモ)
//        = 既存 comments_resolved 文書 (2 部) と byte 不変。再コメントは基底 Composer がそのまま担う。
//   (iii)resolved・元コメント有り (hasOrig:true): レビュアーの確定コメントを読取専用で埋込み
//        (cmt-orig 空コンテナ + データ島 textContent) + バッジ + メモ。基底 id の編集 Composer は
//        出さず (data-readonly="1" の inert な .cmt) 改変不可にする。新規継続コメントは別 key
//        "<sid>:re" の編集 Composer で受ける (集約コピー対象。基底 id は除外集合に入る)。
function commentComposer(sectionId, resolvedMap) {
  const sid = escapeAttr(sectionId);
  const entry =
    resolvedMap && Object.prototype.hasOwnProperty.call(resolvedMap, sectionId)
      ? resolvedMap[sectionId]
      : null;

  // (iii) 元コメント有り = 読取専用埋込 + 再コメント欄。
  if (entry && entry.hasOrig) {
    const rk = escapeAttr(String(entry.rk));
    // 基底 .cmt は data-readonly="1" の inert コンテナ:
    //   - cmt-orig: レビュアーの元コメント (読取専用引用)。ローダがデータ島から textContent 投入。
    //   - cmt-resolved: ✓対応済みバッジ + CC 対応メモ (従来同型)。
    //   編集 UI (toggle/textarea/save) を一切含めない = 改変不可。COMMENT_LOADER_RESOLVED は
    //   data-readonly="1" の .cmt をスキップする (querySelector(null) クラッシュ回避)。
    const readonlyBase =
      '<div class="cmt cmt-ro" data-section="' + sid + '" data-readonly="1">' +
      '<div class="cmt-orig" data-rk="' + rk + '"></div>' +
      '<div class="cmt-resolved">' +
      '<span class="cmt-resolved-badge" aria-label="対応済み"></span>' +
      '<div class="cmt-memo" data-rk="' + rk + '"></div>' +
      '</div>' +
      '</div>';
    // 再コメント欄: 別 localStorage key "<sid>:re"。data-recmt="1" で UI を区別 (CSS ラベル)。
    //   data-section が基底 id と異なる (":re" 接尾) ため resolved 除外集合に含まれず集約コピーに入る。
    const reComposer =
      '<div class="cmt cmt-re" data-section="' + sid + ':re" data-recmt="1" data-state="empty">' +
      '<button class="cmt-toggle" type="button" aria-label="再コメントを書く"></button>' +
      '<div class="cmt-edit">' +
      '<textarea class="cmt-input" aria-label="再コメント入力" placeholder=""></textarea>' +
      '<div class="cmt-actions">' +
      '<button class="cmt-save" type="button" aria-label="保存"></button>' +
      '<button class="cmt-cancel" type="button" aria-label="キャンセル"></button>' +
      '</div></div>' +
      '<div class="cmt-card"><div class="cmt-display"></div>' +
      '<button class="cmt-editbtn" type="button" aria-label="編集"></button></div>' +
      '</div>';
    return readonlyBase + reComposer;
  }

  // (ii) 元コメント無し (2 部・後方互換): 編集 Composer + 旧 resolvedBlock。既存出力 byte 不変。
  let resolvedBlock = '';
  if (entry) {
    const rk = String(entry.rk);
    resolvedBlock =
      '<div class="cmt-resolved">' +
      '<span class="cmt-resolved-badge" aria-label="対応済み"></span>' +
      '<div class="cmt-memo" data-rk="' + escapeAttr(rk) + '"></div>' +
      '</div>';
  }
  // (i)/(ii): 基底編集 Composer (+ 2 部時のみ resolvedBlock)。resolvedBlock='' なら従来 byte 不変。
  return editableComposer(sectionId) + resolvedBlock + '</div>';
}

// H2 本文セクションの「本文ブロック群」HTML を生成する (見出し <h2> は呼び出し側が別途出力)。
//   atomicComments=false: 従来どおり renderBlocks(s.blocks) を返すだけ (H3 への注入なし = byte 不変)。
//   atomicComments=true : s.blocks を H3 境界で再分割し、各 H3 サブセクションの本文末に
//                         commentComposer(H3.id) を注入する。lead (最初の H3 より前) は素描画。
//                         → 「H3 本文の読み終わりに Composer が来る」配置。H2 末 Composer は
//                         呼び出し側が別途付加する (二層)。
//   Composer はテキストノード非生成 (既存 commentComposer と同型) ゆえ HTML⊆MD 不変。
//   各 H3 は本文中 H3 見出しとして renderBlocks で描画され、その後に Composer が続く配置。
function renderBodyInner(s, decisionIds, atomicComments, resolvedMap) {
  if (!atomicComments) {
    return renderBlocks(s.blocks, decisionIds);
  }
  const { lead, subsections } = splitByH3(s.blocks);
  let html = renderBlocks(lead, decisionIds);
  for (const sub of subsections) {
    html += renderBlocks([sub.heading], decisionIds);
    html += renderBlocks(sub.blocks, decisionIds);
    html += commentComposer(sub.heading.id, resolvedMap);
  }
  return html;
}

// ---------------------------------------------------------------------------
// メイン描画: 固定 7 ブロック
// ---------------------------------------------------------------------------

function render(md, srcFileName) {
  const { fm } = parseFrontmatter(md);
  const { body } = parseFrontmatter(md);

  // --- テーマ / ホバー opt-in モード判定 (frontmatter 宣言時のみ有効) ---
  // 全注入を themeMode / hoverMode 分岐内に閉じ込めるため、非宣言文書は byte 不変。
  const themeMode = !!(fm && fm.theme === 'toggle');
  const hoverMode = !!(fm && Array.isArray(fm.hover) && fm.hover.length);

  // renderInline が参照するホバー状態を確定 (render 毎にリセット = 決定論)。
  _hoverMode = hoverMode;
  _hoverIndex = null;
  if (hoverMode) {
    _hoverIndex = new Map();
    fm.hover.forEach((h, idx) => {
      // 同一識別子が複数宣言された場合は最初を優先 (決定論)。
      if (!_hoverIndex.has(h.key)) _hoverIndex.set(h.key, String(idx));
    });
  }

  const blocks = tokenize(body);

  // 見出し再採番 (グローバル一意 id) は tokenize 内で付与済み
  const decisionIds = { seq: { n: 0 } };

  // DECISION 収集 (集約パネル用) — 描画前に id を確定させるため本文を先に描画
  const { preamble, sections } = buildSections(blocks);

  // H1 タイトル
  const h1 = preamble.find((b) => b.type === 'heading' && b.level === 1);
  const title = h1 ? h1.text : fm && fm.doc_id ? String(fm.doc_id) : (srcFileName || 'report');

  // 本文セクション描画 (DECISION id をここで採番)
  const audienceSec = sections.find((s) => classifySection(s) === 'audience');
  const summarySec = sections.find((s) => classifySection(s) === 'summary');
  const pendingSec = sections.find((s) => classifySection(s) === 'pending');
  const bodySecs = sections.filter((s) => classifySection(s) === 'body');

  // --- ブロック 5: 本文 ---
  // preamble (H1 タイトルより後・最初の H2 より前) の非 H1 ブロックは欠落させず lead として描画
  let bodyHtml = '';
  const leadBlocks = preamble.filter((b) => b !== h1);
  if (leadBlocks.length) {
    bodyHtml += '<div class="lead">' + renderBlocks(leadBlocks, decisionIds) + '</div>';
  }
  // frontmatter tabs: by-h2 宣言時のみ本文 H2 セクション群をタブ UI に包む (インライン新構文ゼロ)。
  // タブラベルは H2 見出しテキスト (MD 由来の実テキストノード = corpus 内 → HTML⊆MD 維持)。
  // 番号は CSS counter (非テキストノード)。非表示パネルも静的 HTML に全文残り --verify が被覆する。
  // コメント機能: 報告書 (isReport) かつ reportId (report_id/doc_id) があり comments:off でない時のみ。
  // reportId は MD 由来のみ (srcFileName fallback 禁止 = 同一 MD 異名でも byte 不変 = 決定論)。
  const reportId = fm && (fm.report_id || fm.doc_id) ? String(fm.report_id || fm.doc_id) : '';
  const commentsMode = !!(reportId && isReportDoc(fm, body) && fm.comments !== 'off');
  // --- Atomic コメント opt-in (comments: atomic): commentsMode が前提 ---
  // commentsMode かつ frontmatter comments の値が 'atomic' の時のみ有効。
  // この時、各 H2 セクション内の H3 (小見出し=トピック) サブセクション直下にも
  // Composer を注入する (H2 末 Composer は維持 = 二層)。
  // 既定 (report_id 有・comments 値なし) / comments: on / off / 非報告書 は
  // atomicComments=false ゆえ従来どおり H2 のみ = 既存 byte 不変。
  const atomicComments = !!(commentsMode && fm && fm.comments === 'atomic');

  // --- コメント解決 opt-in (comments_resolved): commentsMode が前提 ---
  // commentsMode かつ frontmatter に有効な comments_resolved エントリがある時のみ有効。
  // 全注入 (CSS/データ島/ローダ/Composer 内ブロック) を resolvedMode 分岐内に閉じ込め、
  // 非宣言文書 (および comments_resolved 不在のコメント文書) は byte 不変。
  const resolvedMode = !!(commentsMode && fm && Array.isArray(fm.comments_resolved) && fm.comments_resolved.length);
  // resolvedMap: 見出しテキスト key を canon→sha1→'sec-'... で sectionId 化し
  //   {sectionId: {rk:index, hasOrig:bool}} に。index は resolvedMemos (データ島) 上の位置。
  //   resolvedMemos[index] = {memo, orig} (orig は 3 部 entry の元コメント。2 部は '')。
  //   Composer が付くのは本文 H2 (bodySecs)/atomic 時は H3 も。それに一致する key だけ島へ入れる
  //   (Codex 採用: 未参照メモをソースから排除 = 情報最小化。見出し不一致 key は描画せず lint 警告のみ)。
  //   hasOrig は orig が空文字でない時 true → commentComposer が読取専用埋込 + 再コメント欄に分岐。
  //   同一 sectionId への複数宣言は最初を優先 (決定論)。
  let resolvedMap = null;
  let resolvedMemos = null;
  // 読取専用埋込 (元コメント有り) を持つ resolved 見出し id 集合。
  //   返信集約 (REPLY_GEN_RESOLVED) がこの集合の基底 id コメントをスキップするため DOM へ出力する。
  //   元コメント無し (2 部) の resolved は基底 Composer が再コメントを兼ねるため除外しない (従来挙動)。
  let resolvedOrigSids = null;
  if (resolvedMode) {
    resolvedMap = {};
    resolvedMemos = [];
    resolvedOrigSids = [];
    // Composer が付く見出し id の集合。
    //   非 atomic: 本文 H2 (bodySecs) のみ (従来どおり)。
    //   atomic   : 本文 H2 に加え、各 H2 内の H3 サブセクション見出し id も Composer が付くため
    //              renderableIds に含める (H3 見出しに一致する comments_resolved メモを島へ通す)。
    const renderableIds = new Set(bodySecs.map((s) => s.heading.id));
    if (atomicComments) {
      for (const s of bodySecs) {
        for (const b of s.blocks) {
          if (b.type === 'heading' && b.level === 3) renderableIds.add(b.id);
        }
      }
    }
    fm.comments_resolved.forEach((e) => {
      const sid = 'sec-' + sha1(canon(e.key)).slice(0, 8);
      // 描画されない key (本文 H2 見出しに不一致) はデータ島にも入れない。
      if (!renderableIds.has(sid)) return;
      // 同一 sectionId は最初の宣言のみ採用 (重複後続はスキップ = 島に入れない)。
      if (Object.prototype.hasOwnProperty.call(resolvedMap, sid)) return;
      const orig = (e && typeof e.original === 'string') ? e.original : '';
      const hasOrig = orig.length > 0;
      resolvedMap[sid] = { rk: resolvedMemos.length, hasOrig };
      resolvedMemos.push({ memo: e.memo, orig });
      if (hasOrig) resolvedOrigSids.push(sid);
    });
  }

  const tabsMode = !!(fm && fm.tabs === 'by-h2' && bodySecs.length > 0);
  if (tabsMode) {
    let tabBar = '<div class="tabs" role="tablist">';
    let panelsHtml = '';
    bodySecs.forEach((s, idx) => {
      const on = idx === 0 ? ' active' : '';
      const seld = idx === 0 ? 'true' : 'false';
      tabBar +=
        '<button class="tab' + on + '" type="button" role="tab" aria-selected="' + seld +
        '" data-tab="' + idx + '">' + renderInline(s.heading.text) + '</button>';
      panelsHtml +=
        '<section class="tab-panel' + on + '" role="tabpanel" data-tab-panel="' + idx + '">' +
        renderBlocks([s.heading], decisionIds) +
        renderBodyInner(s, decisionIds, atomicComments, resolvedMap) +
        (commentsMode ? commentComposer(s.heading.id, resolvedMap) : '') +
        '</section>';
    });
    tabBar += '</div>';
    bodyHtml += '<div class="report-tabs">' + tabBar + panelsHtml + '</div>';
  } else {
    for (const s of bodySecs) {
      if (commentsMode) {
        bodyHtml +=
          '<section class="topic">' +
          renderBlocks([s.heading], decisionIds) +
          renderBodyInner(s, decisionIds, atomicComments, resolvedMap) +
          commentComposer(s.heading.id, resolvedMap) +
          '</section>';
      } else {
        bodyHtml += renderBlocks([s.heading], decisionIds);
        bodyHtml += renderBlocks(s.blocks, decisionIds);
      }
    }
  }

  // --- ブロック 3: 要判断一覧 (DECISION 集約) ---
  // bodyHtml 描画で各 DECISION に _decId が付与済み
  const decisions = [];
  // 要判断一覧 見出しフォールバック (根治): [!DECISION] のマーカー行に題が無い場合でも
  //   本文先頭から題を自動生成し、一覧エントリが空リンクになるのを構造的に防ぐ。
  //   優先 = 先頭 **強調** 句 → 無ければ先頭非空行を最初の文区切りまで。インライン記号は除去。
  function decisionFallbackTitle(content) {
    for (const ln of (content || [])) {
      const t = String(ln).trim();
      if (!t) continue;
      const bold = t.match(/^\*\*(.+?)\*\*/);
      let title = (bold ? bold[1] : t).replace(/[*`]/g, '');
      title = title.split(/[。．.!！?？\n]/)[0].trim();
      if (!title) continue;
      return title.length > 50 ? title.slice(0, 50) + '…' : title;
    }
    return '(無題の判断)';
  }
  function collectDecisions(bs) {
    for (const b of bs) {
      if (b.type === 'admonition' && b.adType === 'DECISION' && b._decId) {
        decisions.push({ id: b._decId, title: b.title || decisionFallbackTitle(b.content) });
      }
      if (b.type === 'blockquote' || b.type === 'admonition') {
        // ネストは本サブセットでは DECISION を含めない想定。スキップ
      }
    }
  }
  for (const s of bodySecs) collectDecisions(s.blocks);
  if (summarySec) collectDecisions(summarySec.blocks);

  let decisionPanel = '';
  if (decisions.length) {
    decisionPanel =
      '<section class="panel panel-decisions" data-count="' +
      decisions.length +
      '"><ul class="decision-list">';
    for (const d of decisions) {
      decisionPanel +=
        '<li><a href="#' + escapeAttr(d.id) + '">' + renderInline(d.title) + '</a></li>';
    }
    decisionPanel += '</ul></section>';
  }

  // --- ブロック 2: 読者と目的パネル ---
  let audiencePanel = '';
  if (audienceSec) {
    audiencePanel =
      '<section class="panel panel-audience">' +
      renderBlocks([audienceSec.heading]) +
      renderBlocks(audienceSec.blocks) +
      '</section>';
  }

  // --- ブロック 2.5: 結論の概要パネル (状態バッジ付き・読者と目的と要判断一覧の間) ---
  let summaryPanel = '';
  if (summarySec) {
    summaryPanel =
      '<section class="panel panel-summary">' +
      renderBlocks([summarySec.heading]) +
      renderBlocks(summarySec.blocks, null, true) +
      '</section>';
  }

  // --- ブロック 6: Pending 台帳 ---
  let pendingPanel = '';
  if (pendingSec) {
    const firstTable = pendingSec.blocks.find((b) => b.type === 'table');
    const count = firstTable ? firstTable.rows.length : pendingSec.blocks
      .filter((b) => b.type === 'list')
      .reduce((acc, b) => acc + b.items.length, 0);
    pendingPanel =
      '<section class="panel panel-pending" data-count="' +
      count +
      '">' +
      renderBlocks([pendingSec.heading]) +
      renderBlocks(pendingSec.blocks) +
      '</section>';
  }

  // --- ブロック 4: TOC (H2-H4) ---
  const tocItems = blocks.filter((b) => b.type === 'heading' && b.level >= 2 && b.level <= 4);
  let toc = '';
  if (tocItems.length) {
    toc = '<nav class="toc"><ul>';
    for (const h of tocItems) {
      toc +=
        '<li class="toc-l' + h.level + '"><a href="#' + escapeAttr(h.id) + '">' +
        renderInline(h.text) + '</a></li>';
    }
    toc += '</ul></nav>';
  }

  // --- ブロック 1: ヘッダ ---
  let header = '<header class="report-header">';
  header += '<h1 class="report-title">' + renderInline(title) + '</h1>';
  if (fm) {
    header += '<dl class="meta">';
    const metaKeys = ['doc_id', 'revision', 'status', 'where', 'audience', 'issued_by', 'parent_task'];
    for (const key of metaKeys) {
      if (!(key in fm)) continue;
      const val = fm[key];
      header += '<div class="meta-row meta-' + key + '">';
      header += '<dt>' + escapeHtml(key) + '</dt><dd>';
      if (key === 'where' && typeof val === 'string') {
        const segs = val.split('>').map((x) => x.trim()).filter(Boolean);
        header += '<span class="breadcrumb">';
        segs.forEach((seg, k) => {
          header += '<span class="crumb">' + renderInline(seg) + '</span>';
        });
        header += '</span>';
      } else if (key === 'status' && typeof val === 'string') {
        header += '<span class="badge badge-status" data-status="' + escapeAttr(val) + '">' +
          renderInline(val) + '</span>';
      } else if (Array.isArray(val)) {
        header += '<span class="chips">';
        val.forEach((v) => {
          header += '<span class="chip">' + renderInline(v) + '</span>';
        });
        header += '</span>';
      } else {
        header += renderInline(String(val));
      }
      header += '</dd></div>';
    }
    header += '</dl>';
  }
  header += '</header>';

  // --- ブロック 7: フッタ (ファイル名 + sha256 は data 属性。テキストノード非生成) ---
  const mdSha = sha256(md);
  const footer =
    '<footer class="report-footer" data-srcfile="' +
    escapeAttr(srcFileName || '') +
    '" data-sha256="' +
    escapeAttr(mdSha.slice(0, 12)) +
    '"></footer>';

  // mermaid フェンス存在判定 (存在時のみローダ注入)
  const hasMermaid = blocks.some((b) => b.type === 'fence' && (b.info || '').toLowerCase() === 'mermaid');
  const mermaidLoader = hasMermaid ? MERMAID_LOADER : '';
  // タブ: head の apply-before-paint で html.js 付与 (無フラッシュ) + body 末でクリック配線。tabs 時のみ注入。
  const tabHead = tabsMode ? TAB_HEAD : '';
  const tabLoader = tabsMode ? TAB_LOADER : '';
  // コメント: 返信プロンプト生成セクション (タブ外・常時可視) + localStorage/集約 JS。commentsMode 時のみ。
  const replyGen = commentsMode ? REPLY_GEN_HTML : '';
  // 返信プロンプト集約 + localStorage 配線。gating の二段構え:
  //   (1) 非 resolvedMode: 従来式 COMMENT_LOADER + (atomic ? REPLY_GEN_ATOMIC : REPLY_GEN) を
  //       1 byte も変えずに使用 (comments-on / atomic / tabs-comments golden を byte 不変に死守)。
  //   (2) resolvedMode のみ: 読取専用基底 .cmt を配線除外する COMMENT_LOADER_RESOLVED と、
  //       対応済み基底 id を集約からスキップする REPLY_GEN(_ATOMIC)_RESOLVED に差し替える。
  //   atomic 時は H3 単位の逆引き集約 (closest('.topic') が最外 H2 を掴む穴を塞ぐ) を維持。
  let commentLoader = '';
  if (commentsMode) {
    if (resolvedMode) {
      commentLoader =
        COMMENT_LOADER_RESOLVED + (atomicComments ? REPLY_GEN_ATOMIC_RESOLVED : REPLY_GEN_RESOLVED);
    } else {
      commentLoader = COMMENT_LOADER + (atomicComments ? REPLY_GEN_ATOMIC : REPLY_GEN);
    }
  }

  // テーマ: apply-before-paint (head 早期同期 script) + body 末ローダ + トグル UI。themeMode 時のみ。
  const themeHead = themeMode ? THEME_HEAD : '';
  const themeToggle = themeMode ? THEME_TOGGLE_HTML : '';
  const themeLoader = themeMode ? THEME_LOADER : '';

  // ホバー: 要約データ島 (JSON) + body 末ローダ。hoverMode 時のみ。
  const hoverData = hoverMode ? hoverDataIsland(fm.hover) : '';
  const hoverLoader = hoverMode ? HOVER_LOADER : '';

  // コメント解決: メモ/元コメントデータ島 (JSON {index:{memo,orig}}) + body 末ローダ。resolvedMode 時のみ。
  const resolvedData = resolvedMode ? resolvedDataIsland(resolvedMemos) : '';
  const resolvedLoader = resolvedMode ? RESOLVED_LOADER : '';
  // <html> に対応済み (元コメント有り) 基底見出し id 集合をスペース区切りで埋め込む。
  //   REPLY_GEN(_ATOMIC)_RESOLVED がこれを skip-set として読み、基底 id コメントを集約から除外する。
  //   resolvedMode かつ元コメント有り entry が 1 件以上ある時のみ属性を出す (非該当は属性ごと無し)。
  const resolvedSectionsAttr =
    resolvedMode && resolvedOrigSids && resolvedOrigSids.length
      ? ' data-resolved-sections="' + escapeAttr(resolvedOrigSids.join(' ')) + '"'
      : '';

  const inner =
    header +
    themeToggle +
    audiencePanel +
    summaryPanel +
    decisionPanel +
    toc +
    '<main class="report-body">' + bodyHtml + '</main>' +
    pendingPanel +
    replyGen +
    footer;

  return (
    '<!DOCTYPE html>\n<html lang="ja"' +
    (themeMode ? ' data-theme="day"' : '') +
    ' data-src-sha256="' + mdSha + '"' +
    (commentsMode ? ' data-report-id="' + escapeAttr(reportId) + '"' : '') +
    resolvedSectionsAttr + '>\n' +
    '<head>\n<meta charset="utf-8"/>\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>\n' +
    '<title>' + escapeHtml(title) + '</title>\n' +
    '<style>\n' + CSS + (themeMode ? THEME_CSS : '') + (hoverMode ? HOVER_CSS : '') +
      (tabsMode ? TAB_CSS : '') + (commentsMode ? COMMENT_CSS : '') +
      (resolvedMode ? RESOLVED_CSS : '') + (summarySec ? SUMMARY_CSS : '') + '\n</style>\n' +
      themeHead + tabHead + '</head>\n' +
    '<body>\n<div class="wrap">\n' + inner + '\n</div>\n' +
    hoverData + resolvedData + mermaidLoader + tabLoader + commentLoader + themeLoader + hoverLoader + resolvedLoader + '</body>\n</html>\n'
  );
}

// ---------------------------------------------------------------------------
// テンプレート: CSS (テキストノードを供給しない。ラベルは ::before/::after content)
// ---------------------------------------------------------------------------

const CSS = `
:root{
  --bg:#0F141E; --fg:#E5E7EB; --muted:#94A3B8; --line:#2A3242; --card:#1A2230;
  --accent:#7AA2E8; --accent-soft:#1E2A44; --decision:#E0915A; --decision-soft:#3A2618;
  --da:#5BC49A; --da-soft:#16302A; --warn:#D9B45A; --warn-soft:#332B14; --code-bg:#161C28;
  --bar:#22D3EE; --bar-soft:rgba(34,211,238,.3);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font-family:"Segoe UI","Hiragino Kaku Gothic ProN","Yu Gothic UI",Meiryo,sans-serif;
  line-height:1.7;font-size:15px}
.wrap{max-width:960px;margin:0 auto;padding:32px 24px 80px}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
h1,h2,h3,h4{line-height:1.4;margin:1.6em 0 .6em}
h2{border-bottom:2px solid var(--line);padding-bottom:.25em;font-size:1.4em}
h3{font-size:1.15em}
h4{font-size:1.02em;color:var(--muted)}
hr{border:none;border-top:1px solid var(--line);margin:1.6em 0}
code{background:var(--code-bg);padding:.1em .35em;border-radius:4px;
  font-family:"Cascadia Code","Consolas",monospace;font-size:.88em}
pre.code{background:var(--code-bg);padding:14px 16px;border-radius:8px;overflow:auto;
  border:1px solid var(--line)}
pre.code code{background:none;padding:0}
pre.mermaid{background:var(--card);border:1px dashed var(--line);padding:14px;border-radius:8px}
.table-wrap{overflow-x:auto;margin:1em 0}
table{border-collapse:collapse;width:100%;background:var(--card);font-size:.92em}
th,td{border:1px solid var(--line);padding:7px 11px;text-align:left;vertical-align:top}
th{background:var(--accent-soft);font-weight:600}
tr:nth-child(even) td{background:#1E2735}
blockquote{margin:1em 0;padding:.4em 1em;border-left:3px solid var(--line);color:var(--muted)}
th.num-col{text-align:right;color:#CBD5E1;border-bottom:2px solid rgba(34,211,238,.55)}
td.num-cell{position:relative;text-align:right;font-variant-numeric:tabular-nums}
td.num-cell .bar{position:absolute;left:0;top:0;bottom:0;
  background:linear-gradient(to top,var(--bar) 0,var(--bar) 5px,var(--bar-soft) 5px);
  border-right:2px solid var(--bar);z-index:0}
td.num-cell .num{position:relative;z-index:1}
img.svg-fig{display:block;max-width:100%;margin:1em auto;background:var(--card);
  border:1px solid var(--line);border-radius:8px;padding:8px}

/* --- ヘッダ --- */
.report-header{border-bottom:3px solid var(--accent);padding-bottom:18px;margin-bottom:8px}
.report-title{margin:.2em 0 .5em;font-size:1.7em}
dl.meta{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0;font-size:.9em}
dl.meta .meta-row{display:contents}
dl.meta dt{color:var(--muted);font-weight:600;text-transform:uppercase;font-size:.82em;letter-spacing:.03em}
dl.meta dd{margin:0}
.breadcrumb .crumb:not(:last-child)::after{content:"\\203A";color:var(--muted);margin:0 .5em}
.badge-status{display:inline-block;padding:.1em .6em;border-radius:999px;font-size:.85em;font-weight:600;
  background:var(--warn-soft);color:var(--warn);border:1px solid var(--warn)}
.badge-status[data-status="awaiting-approval"],.badge-status[data-status="in_progress"]{
  background:var(--warn-soft);color:var(--warn);border-color:var(--warn)}
.badge-status[data-status="approved"],.badge-status[data-status="done"],.badge-status[data-status="complete"]{
  background:var(--da-soft);color:var(--da);border-color:var(--da)}
.chips .chip{display:inline-block;background:var(--accent-soft);color:var(--accent);
  padding:.05em .55em;border-radius:999px;font-size:.85em;margin-right:.35em}

/* --- パネル共通 --- */
.panel{background:var(--card);border:1px solid var(--line);border-radius:10px;
  padding:8px 20px 16px;margin:18px 0}
.panel>h2{border-bottom:1px solid var(--line);margin-top:.6em}

/* ブロック2: 読者と目的 */
.panel-audience{border-left:4px solid var(--accent)}

/* ブロック3: 要判断一覧 (題は CSS 擬似要素。テキストノード非生成) */
.panel-decisions{border-left:4px solid var(--decision);position:relative}
.panel-decisions::before{content:"\\8981\\5224\\65AD\\4E00\\89A7";display:block;font-weight:700;
  color:var(--decision);font-size:1.05em;margin:.4em 0 .2em}
.panel-decisions::after{content:" (" attr(data-count) ")";color:var(--muted);font-size:.85em}
.decision-list{margin:.4em 0 0;padding-left:1.2em}
.decision-list li{margin:.25em 0}

/* ブロック4: TOC (題は CSS 擬似要素) */
.toc{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 20px 14px;margin:18px 0}
.toc::before{content:"\\76EE\\6B21";display:block;font-weight:700;color:var(--muted);margin:.4em 0 .2em;
  text-transform:uppercase;letter-spacing:.05em;font-size:.85em}
.toc ul{list-style:none;margin:0;padding:0}
.toc li{margin:.15em 0}
.toc-l3{padding-left:1.2em;font-size:.95em}
.toc-l4{padding-left:2.4em;font-size:.9em;color:var(--muted)}

/* ブロック6: Pending 台帳 (件数バッジは data 属性 → CSS content) */
.panel-pending{border-left:4px solid var(--warn)}
.panel-pending>h2::after{content:" (" attr(data-count) ")";color:var(--muted);font-size:.7em;font-weight:400}

/* admonition (ラベルは CSS ::before。テキストノード非生成) */
.adm{border-radius:8px;padding:10px 16px;margin:1em 0;border:1px solid var(--line)}
.adm .adm-title{font-weight:600;margin:.2em 0}
.adm .adm-body{font-size:.95em}
.adm::before{display:inline-block;font-weight:700;font-size:.78em;letter-spacing:.05em;
  padding:.05em .5em;border-radius:4px;margin-bottom:.3em}
.adm-decision{background:var(--decision-soft);border-color:var(--decision)}
.adm-decision::before{content:"\\8981\\5224\\65AD";background:var(--decision);color:#0F141E}
.adm-da{background:var(--da-soft);border-color:var(--da)}
.adm-da::before{content:"DA";background:var(--da);color:#0F141E}
.adm-note{background:var(--accent-soft);border-color:var(--accent)}
.adm-note::before{content:"NOTE";background:var(--accent);color:#0F141E}
.adm-warning,.adm-important{background:var(--warn-soft);border-color:var(--warn)}
.adm-warning::before{content:"WARNING";background:var(--warn);color:#0F141E}
.adm-important::before{content:"IMPORTANT";background:var(--warn);color:#0F141E}
.adm-tip::before{content:"TIP";background:var(--da);color:#0F141E}

/* フッタ (ファイル名 + sha は data 属性 → CSS content。テキストノード非生成) */
.report-footer{margin-top:40px;padding-top:14px;border-top:1px solid var(--line);
  color:var(--muted);font-size:.82em}
.report-footer::before{content:attr(data-srcfile)}
.report-footer::after{content:"  ·  sha256:" attr(data-sha256);font-family:monospace}
`;

// 結論の概要 CSS は ## 結論の概要 を持つ報告書にのみ注入 (非該当報告書の <style> を byte 不変に保つ)。
// パネル左帯 + 状態バッジ (OK/FAIL/CAVEAT/INFO・diagram-craft palette)。バッジ文字は MD 由来 (HTML⊆MD)。
const SUMMARY_CSS = `
.panel-summary{border-left:4px solid var(--accent)}
.conc-badge{display:inline-block;font-weight:700;font-size:.78em;letter-spacing:.03em;
  padding:.08em .5em;border-radius:999px;margin-right:.5em;border:1px solid}
.conc-ok{background:#0F766E;border-color:#5EEAD4;color:#F8FAFC}
.conc-fail{background:#7F1D1D;border-color:#FCA5A5;color:#FEF2F2}
.conc-caveat{background:#7C2D12;border-color:#FDBA74;color:#FFF7ED}
.conc-info{background:#1F2937;border-color:#64748B;color:#E5E7EB}
`;

// タブ CSS は tabs: by-h2 報告書にのみ注入する (非タブ報告書の <style> を byte 不変に保つ)。
// JS 無し=全パネル縦表示で全文可読 / html.js 時のみタブ表示。
// タブラベルは H2 見出しテキストそのもの (完全 MD 由来)。番号は付与しない (著者が見出しで付ける)。
const TAB_CSS = `
.report-tabs .tabs{display:none;flex-wrap:wrap;gap:.25em;margin:18px 0 0;padding:.3em .4em 0;
  border:1px solid var(--line);border-radius:8px 8px 0 0;background:var(--card)}
html.js .report-tabs .tabs{display:flex}
.report-tabs .tab{font:inherit;font-size:1.4em;font-weight:600;background:none;border:none;color:var(--muted);
  cursor:pointer;padding:.45em .9em;border-bottom:3px solid transparent;white-space:nowrap}
.report-tabs .tab:hover{color:var(--fg)}
.report-tabs .tab.active{color:var(--accent);border-bottom-color:var(--accent)}
.report-tabs .tab-panel{display:block}
html.js .report-tabs .tab-panel{display:none}
html.js .report-tabs .tab-panel.active{display:block}
`;

const MERMAID_LOADER = `<script>
(function(){
  // 三段フォールバック (1)local vendor → (2)pinned CDN+SRI → (3)原文表示(何もしない)
  function boot(m){ try{ m.initialize({startOnLoad:true,theme:'dark'}); }catch(e){} }
  function tryCdn(){
    var s=document.createElement('script');
    s.src='https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js';
    s.onload=function(){ if(window.mermaid) boot(window.mermaid); };
    document.head.appendChild(s);
  }
  var v=document.createElement('script');
  v.src='./vendor/mermaid.min.js';
  v.onload=function(){ if(window.mermaid) boot(window.mermaid); };
  v.onerror=tryCdn;
  document.head.appendChild(v);
})();
</script>
`;

// タブ: apply-before-paint (head 同期実行で html.js を付与 → JS 有時のみタブ表示・無フラッシュ)。
// 汎用・MD 非依存・byte 固定 = 決定論維持。tabs: by-h2 宣言時のみ注入。
const TAB_HEAD = '<script>document.documentElement.classList.add("js")</script>\n';

// タブ配線 (body 末)。data-* と既存 DOM のみ読み、classList / aria-selected のみ操作。
// innerHTML 不使用・MD 由来文字列の DOM 注入なし = 攻撃面を増やさない。byte 固定 = 決定論維持。
const TAB_LOADER = `<script>
(function(){
  var root=document.querySelector('.report-tabs'); if(!root) return;
  var tabs=[].slice.call(root.querySelectorAll('.tab'));
  var panels=[].slice.call(root.querySelectorAll('.tab-panel'));
  function sel(i){
    tabs.forEach(function(t){var on=t.getAttribute('data-tab')===i;
      t.classList.toggle('active',on); t.setAttribute('aria-selected',on?'true':'false');});
    panels.forEach(function(p){p.classList.toggle('active',p.getAttribute('data-tab-panel')===i);});
  }
  tabs.forEach(function(t){t.addEventListener('click',function(){sel(t.getAttribute('data-tab'));});});
})();
</script>
`;

// ---------------------------------------------------------------------------
// テーマ切替 (opt-in: frontmatter theme: toggle 時のみ注入)。
// 非宣言文書は CSS/HTML/JS いずれも注入されず byte 不変。
// 設計核: 無属性 :root のスタイルに依存しない (Day/Dark を両方明示)。
//         Day を既定とし、html タグに data-theme="day" を静的出力。
//         apply-before-paint で localStorage の保存値を描画前に反映 (無フラッシュ)。
//         トグル UI はラジオ。可視ラベルは CSS 擬似要素 (verify 除外) ＝ 静的
//         テキストノードを生成しない (a11y 正本は aria-label 属性)。
// ---------------------------------------------------------------------------

const THEME_CSS = `
/* Dark パレット (現行ダーク変数を data-theme="dark" に明示複製) */
:root[data-theme="dark"]{
  --bg:#0F141E; --fg:#E5E7EB; --muted:#94A3B8; --line:#2A3242; --card:#1A2230;
  --accent:#7AA2E8; --accent-soft:#1E2A44; --decision:#E0915A; --decision-soft:#3A2618;
  --da:#5BC49A; --da-soft:#16302A; --warn:#D9B45A; --warn-soft:#332B14; --code-bg:#161C28;
  --bar:#22D3EE; --bar-soft:rgba(34,211,238,.3);
}
/* Day パレット (実機FB: 背景をより明るく。本文 WCAG AA 確保。card は純白で paper 感) */
:root[data-theme="day"]{
  --bg:#FCFDFF; --fg:#1A202C; --muted:#566072; --line:#DBE1EA; --card:#FFFFFF;
  --accent:#1F50C0; --accent-soft:#E7EEFC; --decision:#9E4E16; --decision-soft:#FBEAD8;
  --da:#176B49; --da-soft:#DCF3E8; --warn:#8A6000; --warn-soft:#FBF0D2; --code-bg:#F0F3F8;
  --bar:#0E7490; --bar-soft:rgba(14,116,144,.18);
}
/* 数値列バー可読性 (実機FB1: 濃い側でも数値が読める)。
   テーマスコープ限定 = 非テーマ文書 (.num-cell .num) は base CSS のまま byte 不変。
   Day: 暗文字を --fg 強制 + 太字 + 前面化。バーは opacity で淡色化し濃い側でも
        暗文字が読める (任意の barColor 着地でも solid 帯/枠込み AA 以上)。 */
:root[data-theme="day"] .num-cell .num{color:var(--fg);font-weight:600;position:relative;z-index:1}
:root[data-theme="day"] .num-cell .bar{opacity:.55}
/* Dark: 明文字を --fg 強制 + 太字 + 前面化。バーは暗カード側へ寄せて (opacity 低め)
        明文字が明色バー上でも読める (黄/シアン等の明色 barColor でも AA 以上)。 */
:root[data-theme="dark"] .num-cell .num{color:var(--fg);font-weight:600;position:relative;z-index:1}
:root[data-theme="dark"] .num-cell .bar{opacity:.4}
/* 表ゼブラ縞 (実機FB: base の tr:nth-child(even) td が #1E2735 ハードコードで、Day では
   暗背景に暗文字 (--fg) が乗り「2トンカラーの濃いほうが読めん」状態。テーマスコープで
   Day=淡色 / Dark=現行暗色 に上書き。base 規則 (#1E2735) は据え置き = 非テーマ文書 byte 不変。 */
:root[data-theme="day"] tr:nth-child(even) td{background:#EEF2F8}
:root[data-theme="dark"] tr:nth-child(even) td{background:#1E2735}
/* 数値列ヘッダ色 (base #CBD5E1 は Day の白 card 上で低コントラスト) */
:root[data-theme="day"] th.num-col{color:var(--muted)}
:root[data-theme="dark"] th.num-col{color:#CBD5E1}
/* コメントUIのマゼンタ (base #D946EF) は Day の白背景上で約2.6:1=AA未達。
   Day スコープで濃マゼンタ #A21CAF (白上 約6.7:1) へ。base 規則は据え置き=非テーマ文書 byte 不変。 */
:root[data-theme="day"] .cmt-toggle,
:root[data-theme="day"] .cmt-editbtn,
:root[data-theme="day"] .reply-gen-btn{color:#A21CAF;border-color:#A21CAF}
:root[data-theme="day"] .cmt-save{background:#A21CAF;color:#FFFFFF}
/* admonition ラベルチップ (実機FB3): base の濃文字 (#0F141E) は Day の濃い accent/da/decision/warn
   solid 上で AA 未達 (NOTE 2.6:1)。Day スコープで白文字へ上書きし AA 確保 (白 on Day solid = 5.3〜7.1)。
   base ::before 規則は据え置き = 非テーマ文書のラベル色 byte 不変。 */
:root[data-theme="day"] .adm-decision::before,
:root[data-theme="day"] .adm-da::before,
:root[data-theme="day"] .adm-note::before,
:root[data-theme="day"] .adm-warning::before,
:root[data-theme="day"] .adm-important::before,
:root[data-theme="day"] .adm-tip::before{color:#FFFFFF}
/* テーマトグル UI (ラジオ。視覚ラベルは擬似要素 = テキストノード非生成) */
.theme-toggle{display:flex;gap:.4em;align-items:center;margin:10px 0 4px;
  font-size:.85em}
.theme-toggle::before{content:"\\30C6\\30FC\\30DE";color:var(--muted);font-weight:600;
  margin-right:.4em;text-transform:uppercase;letter-spacing:.04em}
.theme-toggle label{display:inline-flex;align-items:center;gap:.3em;cursor:pointer;
  padding:.2em .7em;border:1px solid var(--line);border-radius:999px;color:var(--muted);
  background:var(--card)}
.theme-toggle input{position:absolute;opacity:0;width:1px;height:1px;margin:0}
.theme-toggle label:has(input[value="day"])::after{content:"Day"}
.theme-toggle label:has(input[value="dark"])::after{content:"Dark"}
.theme-toggle label:has(input:checked){border-color:var(--accent);color:var(--accent);
  background:var(--accent-soft);font-weight:600}
.theme-toggle label:has(input:focus-visible){outline:2px solid var(--accent);outline-offset:2px}
`;

// apply-before-paint: head 早期同期 script。描画前に localStorage 値を反映。
// 既定 day。汎用・MD 非依存・byte 固定 = 決定論維持。themeMode 時のみ注入。
const THEME_HEAD = `<script>(function(){try{var t=localStorage.getItem('mdr-theme');if(t==='day'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();</script>
`;

// トグル UI (本文先頭付近)。静的テキストノードを生成しない (commentComposer と同型):
//   視覚ラベルは CSS ::after、a11y 正本は aria-label 属性。
const THEME_TOGGLE_HTML =
  '<div class="theme-toggle" role="radiogroup" aria-label="テーマ切替">' +
  '<label><input type="radio" name="mdr-theme" value="day" aria-label="Day"/></label>' +
  '<label><input type="radio" name="mdr-theme" value="dark" aria-label="Dark"/></label>' +
  '</div>';

// テーマローダ (body 末)。ラジオ change で data-theme 更新 + localStorage 保存。
// innerHTML 不使用・setAttribute/localStorage/checked のみ。byte 固定 = 決定論維持。
const THEME_LOADER = `<script>
(function(){
  var radios=[].slice.call(document.querySelectorAll('.theme-toggle input[name="mdr-theme"]'));
  if(!radios.length) return;
  var cur=document.documentElement.getAttribute('data-theme')||'day';
  radios.forEach(function(r){
    r.checked=(r.value===cur);
    r.addEventListener('change',function(){
      if(!r.checked) return;
      document.documentElement.setAttribute('data-theme',r.value);
      try{ localStorage.setItem('mdr-theme',r.value); }catch(e){}
    });
  });
})();
</script>
`;

// ---------------------------------------------------------------------------
// ホバープレビュー (opt-in: frontmatter hover: ブロック宣言時のみ注入)。
// 非宣言文書は CSS/JS/データ島いずれも注入されず byte 不変。
// 設計核: 要約は実行時 textContent で投入 (innerHTML 禁止 = XSS 面なし)。
//         データ島は <script type="application/json"> = extractTextNodes が除外
//         (verify はホバー要約を本文テキストとして数えない)。実行時 fetch なし。
// ---------------------------------------------------------------------------

const HOVER_CSS = `
a.hoverable{border-bottom:1px dotted var(--accent)}
.mdr-hover-card{position:absolute;z-index:50;max-width:320px;background:var(--card);
  color:var(--fg);border:1px solid var(--accent);border-radius:8px;padding:.55em .8em;
  font-size:.88em;line-height:1.5;box-shadow:0 6px 24px rgba(0,0,0,.35);
  white-space:pre-wrap;pointer-events:none}
`;

// データ島生成: {index:{summary}} の JSON。</script> 破壊防止に "</" を "<\\/" へ、
// HTML 特殊文字は <script> 文脈で危険な '<' '>' '&' をエスケープ。textContent 投入のため
// 値自体の HTML 解釈は起きないが、データ島の早期終了とタグ注入を二重に防ぐ。
function hoverDataIsland(hover) {
  const map = {};
  hover.forEach((h, idx) => {
    map[String(idx)] = { summary: h.summary, key: h.key };
  });
  let json = JSON.stringify(map);
  // <script> 内 JSON の安全化: </script> 等のタグ境界を破壊させない。
  json = json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return '<script type="application/json" class="mdr-hover-data">' + json + '</script>\n';
}

// ホバーローダ (body 末)。.hoverable に hover/focus/tap で要約カードを生成。
// 要約は textContent で投入 (innerHTML 禁止)。データ島 JSON を parse して参照。
// 実行時 fetch なし。byte 固定 = 決定論維持。
const HOVER_LOADER = `<script>
(function(){
  var island=document.querySelector('script.mdr-hover-data'); if(!island) return;
  var data={}; try{ data=JSON.parse(island.textContent||'{}'); }catch(e){ return; }
  var card=null;
  function hide(){ if(card){ card.parentNode&&card.parentNode.removeChild(card); card=null; } }
  function show(a){
    var k=a.getAttribute('data-hkey'); if(k===null) return;
    var rec=data[k]; if(!rec||!rec.summary) return;
    hide();
    card=document.createElement('div');
    card.className='mdr-hover-card';
    card.textContent=rec.summary;
    document.body.appendChild(card);
    var r=a.getBoundingClientRect();
    var top=r.bottom+window.scrollY+6, left=r.left+window.scrollX;
    var maxL=window.scrollX+document.documentElement.clientWidth-card.offsetWidth-8;
    if(left>maxL) left=Math.max(window.scrollX+8,maxL);
    card.style.top=top+'px'; card.style.left=left+'px';
  }
  var links=[].slice.call(document.querySelectorAll('a.hoverable'));
  links.forEach(function(a){
    a.addEventListener('mouseenter',function(){show(a);});
    a.addEventListener('mouseleave',hide);
    a.addEventListener('focus',function(){show(a);});
    a.addEventListener('blur',hide);
    a.addEventListener('click',function(ev){
      // タップ端末: 1 タップ目はプレビュー表示で遷移を抑止、表示中の再タップで遷移。
      if(!card){ ev.preventDefault(); show(a); }
    });
  });
  document.addEventListener('scroll',hide,true);
})();
</script>
`;

// ---------------------------------------------------------------------------
// コメント解決バッジ + CC 対応メモ (opt-in: frontmatter comments_resolved + commentsMode 時のみ注入)。
// 非宣言文書は CSS/JS/データ島いずれも注入されず byte 不変。
// 設計核 (hover と同型):
//   - バッジ可視ラベル「✓ 対応済み」は CSS 擬似要素 (::before content = <style> 内 = extractTextNodes 除外)。
//   - メモ本文は <script type="application/json"> データ島へ ('<' '>' '&' と U+2028/2029 を
//     エスケープし </script> breakout 防止)。extractTextNodes が <script> 除外 → HTML⊆MD 維持。
//   - メモは frontmatter 由来で body piece でないため MD⊆HTML 検査対象外。
//   - ローダは .cmt-memo に data-rk でデータ島から memo を textContent 投入 (innerHTML 禁止・実行時 fetch なし)。
//   - Day/Dark 両テーマでコントラスト確保のためテーマ変数 (--da/--da-soft 等) を使う。
// ---------------------------------------------------------------------------

const RESOLVED_CSS = `
.cmt-resolved{display:flex;align-items:flex-start;gap:.5em;margin:.5em 0 0;
  padding:.45em .7em;background:var(--da-soft);border:1px solid var(--da);border-radius:8px}
.cmt-resolved-badge{flex:0 0 auto;display:inline-block;font-weight:700;font-size:.78em;
  letter-spacing:.03em;padding:.12em .55em;border-radius:999px;background:var(--da);color:var(--bg);
  white-space:nowrap}
.cmt-resolved-badge::before{content:"\\2713 \\5BFE\\5FDC\\6E08\\307F"}
.cmt-memo{flex:1 1 auto;white-space:pre-wrap;font-size:.9em;color:var(--fg);line-height:1.55}
/* 元コメント (レビュアーの確定レビュー) の読取専用引用。編集 UI を持たず textContent 投入のみ。
   題ラベル「レビュアー (確定・編集不可)」は擬似要素 = テキストノード非生成 (HTML⊆MD 維持)。 */
.cmt-orig{margin:.5em 0 0;padding:.45em .7em .5em 1em;background:var(--accent-soft);
  border-left:3px solid var(--accent);border-radius:0 8px 8px 0;white-space:pre-wrap;
  font-size:.9em;color:var(--fg);line-height:1.55}
.cmt-orig::before{content:"\\30EC\\30D3\\30E5\\30A2\\30FC\\FF08\\78BA\\5B9A\\30FB\\7DE8\\96C6\\4E0D\\53EF\\FF09";
  display:block;font-weight:700;font-size:.74em;letter-spacing:.03em;color:var(--accent);
  margin-bottom:.25em;text-transform:uppercase}
/* 再コメント欄 (対応済みでも継続コメント可・集約コピー対象)。トグル/編集ラベルを差し替え。
   題ラベル「再コメント」は擬似要素 = テキストノード非生成。 */
.cmt-re{border-top:none;margin-top:.5em;padding-top:.2em}
.cmt-re::before{content:"\\518D\\30B3\\30E1\\30F3\\30C8";display:block;color:var(--muted);
  font-weight:600;font-size:.78em;letter-spacing:.03em;margin:.2em 0 .1em;text-transform:uppercase}
.cmt-re .cmt-toggle::before{content:"\\518D\\30B3\\30E1\\30F3\\30C8\\3092\\66F8\\304F"}
`;

// データ島生成: {index:{memo, orig}} の JSON。hoverDataIsland と同型の安全化 (</script> breakout 防止)。
//   memo = CC 対応メモ / orig = レビュアーの元コメント (読取専用埋込。2 部 entry では '')。
//   両者とも textContent 投入のため値自体の HTML 解釈は起きないが、データ島の早期終了を二重に防ぐ。
//   ローダは {memo, orig} オブジェクトを期待する (旧 {index:memoString} 形式も後方互換で処理)。
function resolvedDataIsland(memos) {
  const map = {};
  memos.forEach((rec, idx) => {
    // rec は { memo, orig }。防御的に欠損を空文字へ。
    const memo = rec && typeof rec.memo === 'string' ? rec.memo : '';
    const orig = rec && typeof rec.orig === 'string' ? rec.orig : '';
    map[String(idx)] = { memo, orig };
  });
  let json = JSON.stringify(map);
  json = json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return '<script type="application/json" class="mdr-resolved-data">' + json + '</script>\n';
}

// 解決メモ/元コメントローダ (body 末)。
//   .cmt-memo  ← データ島 rec.memo を textContent 投入 (CC 対応メモ)。
//   .cmt-orig  ← データ島 rec.orig を textContent 投入 (レビュアーの元コメント・読取専用)。
//   いずれも data-rk でデータ島の index を参照。後方互換: 値が文字列なら memo として扱う (旧形式)。
//   innerHTML 不使用・実行時 fetch なし = XSS 面なし。byte 固定 = 決定論維持。resolvedMode 時のみ注入。
const RESOLVED_LOADER = `<script>
(function(){
  var island=document.querySelector('script.mdr-resolved-data'); if(!island) return;
  var data={}; try{ data=JSON.parse(island.textContent||'{}'); }catch(e){ return; }
  function rec(k){ var v=data[k]; if(v==null) return null; if(typeof v==='string') return {memo:v,orig:''}; return v; }
  [].slice.call(document.querySelectorAll('.cmt-memo')).forEach(function(el){
    var k=el.getAttribute('data-rk'); if(k===null) return;
    var r=rec(k); if(!r||typeof r.memo!=='string') return;
    el.textContent=r.memo;
  });
  [].slice.call(document.querySelectorAll('.cmt-orig')).forEach(function(el){
    var k=el.getAttribute('data-rk'); if(k===null) return;
    var r=rec(k); if(!r||typeof r.orig!=='string') return;
    el.textContent=r.orig;
  });
})();
</script>
`;

// ---------------------------------------------------------------------------
// コメント機能 (016): 全て commentsMode 時のみ注入 (非コメント文書は byte 不変)。
// 設計核: 静的 HTML にコメント関連テキストノードを置かない (空コンテナ + CSS/aria ラベル + 空 textarea)
//         → verify (HTML⊆MD / MD⊆HTML) はテキストノード増分ゼロで不変。
// 永続は localStorage (HTML 本体外 = 決定論維持)。集約は固定整形 (LLM 不使用)。
// ---------------------------------------------------------------------------

const COMMENT_CSS = `
.topic{margin:0 0 1.4em}
.cmt{margin:.6em 0 0;border-top:1px dashed var(--line);padding-top:.6em}
.cmt-toggle{font:inherit;font-size:.84em;background:rgba(217,70,239,.10);border:1px solid #D946EF;color:#D946EF;
  border-radius:6px;padding:.35em .8em;cursor:pointer}
.cmt-toggle:hover{background:rgba(217,70,239,.22);border-color:#E879F5;color:#F0A6F5}
.cmt-toggle::before{content:"コメントを書く"}
.cmt[data-state="saved"] .cmt-toggle,.cmt[data-state="editing"] .cmt-toggle{display:none}
.cmt-edit{display:none}
.cmt[data-state="editing"] .cmt-edit{display:block}
.cmt-input{display:block;width:100%;min-height:4.5em;background:var(--code-bg);color:var(--fg);
  border:1px solid var(--line);border-radius:6px;padding:.5em;font:inherit;font-size:.9em;resize:vertical}
.cmt-actions{margin-top:.4em}
.cmt-save,.cmt-cancel,.cmt-editbtn{font:inherit;font-size:.82em;border:none;border-radius:6px;
  padding:.32em .8em;margin-right:.4em;cursor:pointer}
.cmt-save{background:#D946EF;color:#0F141E}
.cmt-save:hover{background:#E879F5}
.cmt-save::before{content:"保存"}
.cmt-cancel{background:var(--card);color:var(--muted);border:1px solid var(--line)}
.cmt-cancel::before{content:"キャンセル"}
.cmt-card{display:none;background:var(--decision-soft);border:1px solid var(--decision);
  border-radius:8px;padding:.55em .8em;margin-top:.4em}
.cmt[data-state="saved"] .cmt-card{display:block}
.cmt-display{white-space:pre-wrap;font-size:.92em}
.cmt-editbtn{background:none;color:#D946EF;padding:.25em 0;margin-top:.35em}
.cmt-editbtn:hover{color:#F0A6F5}
.cmt-editbtn::before{content:"編集"}
.reply-gen{margin:30px 0 0;padding:16px 0 0;border-top:2px solid var(--accent)}
.cmt-progress{color:var(--muted);font-size:.82em;margin-bottom:.6em}
.cmt-progress::before{content:"コメント " attr(data-n) " / " attr(data-total) " トピック"}
.reply-gen-btn{font:inherit;font-size:.9em;background:rgba(217,70,239,.10);border:1px solid #D946EF;color:#D946EF;
  border-radius:8px;padding:.55em 1.1em;cursor:pointer}
.reply-gen-btn:hover{background:rgba(217,70,239,.22);border-color:#E879F5;color:#F0A6F5}
.cmt-toggle:focus-visible,.cmt-save:focus-visible,.cmt-editbtn:focus-visible,.reply-gen-btn:focus-visible{outline:2px solid #F0A6F5;outline-offset:2px}
.reply-gen-btn::before{content:"返信プロンプト生成"}
/* 生成=即コピー (1クリック)。完了/失敗フィードバックは生成ボタンに転用 (緑=成功 / warn=fallback) */
.reply-gen[data-copied="1"] .reply-gen-btn{background:var(--da-soft);border-color:var(--da);color:var(--da)}
.reply-gen[data-copied="1"] .reply-gen-btn::before{content:"コピーしました"}
.reply-gen[data-copied="0"] .reply-gen-btn{background:var(--warn-soft);border-color:var(--warn);color:var(--warn)}
.reply-gen[data-copied="0"] .reply-gen-btn::before{content:"Ctrl+C でコピー"}
.reply-out{display:none;width:100%;min-height:8em;margin:.8em 0;background:var(--code-bg);color:var(--fg);
  border:1px solid var(--line);border-radius:6px;padding:.6em;
  font-family:"Cascadia Code","Consolas",monospace;font-size:.85em;white-space:pre;resize:vertical}
.reply-gen[data-generated="1"] .reply-out{display:block}
`;

// 返信プロンプト生成セクション (静的・テキストノードなし。ラベルは CSS、textarea は空)。
const REPLY_GEN_HTML =
  '<section class="reply-gen" data-generated="0">' +
  '<div class="cmt-progress" data-n="0" data-total="0"></div>' +
  '<button class="reply-gen-btn" type="button" aria-label="返信プロンプト生成しコピー"></button>' +
  '<textarea class="reply-out" readonly aria-label="返信プロンプト"></textarea>' +
  '</section>';

// localStorage 永続 (byte 固定 JS)。innerHTML 不使用、textContent/value/classList/setAttribute/localStorage のみ。
const COMMENT_LOADER = `<script>
(function(){
  var rid=document.documentElement.getAttribute('data-report-id'); if(!rid) return;
  function key(sid){return 'ccpit-cmt:'+rid+':'+sid;}
  function load(sid){ try{return JSON.parse(localStorage.getItem(key(sid))||'null');}catch(e){return null;} }
  var cmts=[].slice.call(document.querySelectorAll('.cmt'));
  function progress(){
    var n=0; cmts.forEach(function(c){ if(c.getAttribute('data-state')==='saved') n++; });
    var p=document.querySelector('.cmt-progress');
    if(p){ p.setAttribute('data-n',String(n)); p.setAttribute('data-total',String(cmts.length)); }
  }
  cmts.forEach(function(c){
    var sid=c.getAttribute('data-section');
    var ta=c.querySelector('.cmt-input');
    var disp=c.querySelector('.cmt-display');
    var saved=load(sid);
    function show(){
      if(saved&&saved.text){ disp.textContent=saved.text; c.setAttribute('data-state','saved'); }
      else { c.setAttribute('data-state','empty'); }
    }
    function edit(){ ta.value=(saved&&saved.text)||''; c.setAttribute('data-state','editing'); ta.focus(); }
    c.querySelector('.cmt-toggle').addEventListener('click',edit);
    c.querySelector('.cmt-editbtn').addEventListener('click',edit);
    c.querySelector('.cmt-cancel').addEventListener('click',show);
    c.querySelector('.cmt-save').addEventListener('click',function(){
      var v=ta.value.trim(); if(!v){ return; }
      saved={text:v,at:Date.now()};
      try{ localStorage.setItem(key(sid),JSON.stringify(saved)); }catch(e){}
      show(); progress();
    });
    show();
  });
  progress();
})();
</script>
`;

// 返信プロンプト集約 + ワンクリックコピー (固定整形・LLM 不使用)。clipboard 失敗時 execCommand フォールバック。
const REPLY_GEN = `<script>
(function(){
  var sec=document.querySelector('.reply-gen'); if(!sec) return;
  var btn=sec.querySelector('.reply-gen-btn'), out=sec.querySelector('.reply-out');
  var rid=document.documentElement.getAttribute('data-report-id')||'';
  function load(sid){ try{return JSON.parse(localStorage.getItem('ccpit-cmt:'+rid+':'+sid)||'null');}catch(e){return null;} }
  function excerpt(box){
    var t='', ps=box.querySelectorAll('p,li');
    for(var i=0;i<ps.length;i++){ t+=(t?' ':'')+ps[i].textContent.trim(); if(t.length>=400) break; }
    return t.slice(0,400);
  }
  function feedback(ok){ sec.setAttribute('data-copied',ok?'1':'0'); setTimeout(function(){ sec.removeAttribute('data-copied'); },1800); }
  function legacyCopy(){ var ok=false; try{ out.focus(); out.select(); ok=document.execCommand('copy'); }catch(e){} return ok; }
  btn.addEventListener('click',function(){
    var parts=[], n=0;
    [].slice.call(document.querySelectorAll('.cmt')).forEach(function(c){
      var sid=c.getAttribute('data-section'), s=load(sid);
      if(!(s&&s.text)) return;
      n++;
      var box=c.closest('.tab-panel,.topic')||c.parentNode;
      var h=box.querySelector('h2,h3,h4'), heading=h?h.textContent.trim():sid;
      parts.push('### '+heading+'\\n（本文抜粋）'+excerpt(box)+'\\nコメント: '+s.text);
    });
    var head='## CCPIT 報告書コメント返信タスク（'+n+'件）\\n報告書: '+rid+'\\n\\n';
    out.value = n ? head+parts.join('\\n\\n') : head+'（コメントなし）';
    sec.setAttribute('data-generated','1');
    // 生成=即コピー (1クリック)。clipboard 成功→緑、失敗(file:// 等)→execCommand フォールバック
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(out.value).then(function(){feedback(true);},function(){feedback(legacyCopy());});
    } else { feedback(legacyCopy()); }
  });
})();
</script>
`;

// 返信プロンプト集約 (atomic 版): comments: atomic 時のみ使用。
//   各 .cmt の data-section (= その Composer が属する見出しの id "sec-...") から見出し要素を逆引きし、
//   見出しテキストと「その見出し直下の本文だけ」を抜粋する。H2 Composer なら H2 見出し + H2 直下本文
//   (次の H3 までの lead)、H3 Composer なら H3 見出し + H3 本文。これにより H3 単位の Atomic な
//   コメントが、集約段でも正しいトピック名・本文範囲で拾われる。
//   見出し本文の範囲は DOM 兄弟走査: 見出し要素から次の h2/h3/h4 (= 同位/上位見出し) の直前までの
//   p,li を集める (renderBlocks は見出し・本文・.cmt を flat な兄弟として出力するため、この走査で
//   その見出しのサブセクションだけが切り出せる。.cmt 自体は p,li でないため抜粋に混ざらない)。
//   非 atomic の REPLY_GEN とは別 const = 既存コメント文書 (comments-on 等) の出力は byte 不変。
const REPLY_GEN_ATOMIC = `<script>
(function(){
  var sec=document.querySelector('.reply-gen'); if(!sec) return;
  var btn=sec.querySelector('.reply-gen-btn'), out=sec.querySelector('.reply-out');
  var rid=document.documentElement.getAttribute('data-report-id')||'';
  function load(sid){ try{return JSON.parse(localStorage.getItem('ccpit-cmt:'+rid+':'+sid)||'null');}catch(e){return null;} }
  function hLevel(el){ var m=el&&el.tagName&&el.tagName.match(/^H([2-6])$/); return m?+m[1]:0; }
  // 見出し id → 見出し要素 の逆引き表 (本文中の id 付き見出しのみ)。
  var hmap={};
  [].slice.call(document.querySelectorAll('h2[id],h3[id],h4[id]')).forEach(function(h){ hmap[h.id]=h; });
  // 見出し要素から、その見出し直下のサブセクション本文を抜粋する。
  //   抜粋範囲は renderBodyInner / splitByH3 のサブセクション分割と一致させる:
  //   H2 末 Composer は H2 lead (最初の H3 の直前まで)、H3 Composer は H3 本文
  //   (次の H3 か H2 の直前まで。H3 配下の H4 は H3 サブセクションに内包する)。
  //   よって停止する見出しレベルは max(3, 当該見出しレベル):
  //     H2/H3 一致 → レベル<=3 (h2/h3) の見出しで停止 (h4 では停止せず H4 本文を含める)。
  //     H4 一致 (フォールバック経路のみ) → レベル<=4 で停止。
  function excerptOf(h){
    var stop=Math.max(3, hLevel(h));
    var t='', n=h.nextElementSibling;
    while(n){
      var lv=hLevel(n);
      if(lv>0 && lv<=stop) break; // 同位/上位見出し境界で停止
      if(n.matches&&n.matches('p,li')){ if(n.textContent){ t+=(t?' ':'')+n.textContent.trim(); } }
      var qs=n.querySelectorAll?n.querySelectorAll('p,li'):[];
      for(var i=0;i<qs.length;i++){ t+=(t?' ':'')+qs[i].textContent.trim(); if(t.length>=400) break; }
      if(t.length>=400) break;
      n=n.nextElementSibling;
    }
    return t.slice(0,400);
  }
  // 逆引き不能時のフォールバック (従来挙動): topic/panel 内の最初の見出しと全本文。
  function fallbackHeading(c){ var box=c.closest('.tab-panel,.topic')||c.parentNode; var h=box.querySelector('h2,h3,h4'); return h?h.textContent.trim():null; }
  function fallbackExcerpt(c){ var box=c.closest('.tab-panel,.topic')||c.parentNode; var t='',ps=box.querySelectorAll('p,li'); for(var i=0;i<ps.length;i++){ t+=(t?' ':'')+ps[i].textContent.trim(); if(t.length>=400) break; } return t.slice(0,400); }
  function feedback(ok){ sec.setAttribute('data-copied',ok?'1':'0'); setTimeout(function(){ sec.removeAttribute('data-copied'); },1800); }
  function legacyCopy(){ var ok=false; try{ out.focus(); out.select(); ok=document.execCommand('copy'); }catch(e){} return ok; }
  btn.addEventListener('click',function(){
    var parts=[], n=0;
    [].slice.call(document.querySelectorAll('.cmt')).forEach(function(c){
      var sid=c.getAttribute('data-section'), s=load(sid);
      if(!(s&&s.text)) return;
      n++;
      var h=hmap[sid];
      var heading=h?h.textContent.trim():(fallbackHeading(c)||sid);
      var ex=h?excerptOf(h):fallbackExcerpt(c);
      parts.push('### '+heading+'\\n（本文抜粋）'+ex+'\\nコメント: '+s.text);
    });
    var head='## CCPIT 報告書コメント返信タスク（'+n+'件）\\n報告書: '+rid+'\\n\\n';
    out.value = n ? head+parts.join('\\n\\n') : head+'（コメントなし）';
    sec.setAttribute('data-generated','1');
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(out.value).then(function(){feedback(true);},function(){feedback(legacyCopy());});
    } else { feedback(legacyCopy()); }
  });
})();
</script>
`;

// ---------------------------------------------------------------------------
// resolvedMode 専用ローダ群 (resolvedMode 時のみ注入。非 resolved 文書には一切出ない = byte 不変)。
//   既存 COMMENT_LOADER / REPLY_GEN / REPLY_GEN_ATOMIC は 1 byte も変えず、
//   resolvedMode の時だけ下記の別 const に差し替える (REPLY_GEN_ATOMIC の二変種化と同型の gating)。
// ---------------------------------------------------------------------------

// コメントローダ (resolved 版)。COMMENT_LOADER と同一だが、読取専用埋込の基底 .cmt
//   (data-readonly="1") を配線対象から除外する。読取専用 .cmt は編集 UI 要素 (.cmt-toggle 等) を
//   持たないため、素の COMMENT_LOADER だと querySelector(null).addEventListener で例外になる。
//   除外により progress の total も実際に編集可能な Composer (通常 + 再コメント) 数になる。
const COMMENT_LOADER_RESOLVED = `<script>
(function(){
  var rid=document.documentElement.getAttribute('data-report-id'); if(!rid) return;
  function key(sid){return 'ccpit-cmt:'+rid+':'+sid;}
  function load(sid){ try{return JSON.parse(localStorage.getItem(key(sid))||'null');}catch(e){return null;} }
  var cmts=[].slice.call(document.querySelectorAll('.cmt')).filter(function(c){ return c.getAttribute('data-readonly')!=='1'; });
  function progress(){
    var n=0; cmts.forEach(function(c){ if(c.getAttribute('data-state')==='saved') n++; });
    var p=document.querySelector('.cmt-progress');
    if(p){ p.setAttribute('data-n',String(n)); p.setAttribute('data-total',String(cmts.length)); }
  }
  cmts.forEach(function(c){
    var sid=c.getAttribute('data-section');
    var ta=c.querySelector('.cmt-input');
    var disp=c.querySelector('.cmt-display');
    var saved=load(sid);
    function show(){
      if(saved&&saved.text){ disp.textContent=saved.text; c.setAttribute('data-state','saved'); }
      else { c.setAttribute('data-state','empty'); }
    }
    function edit(){ ta.value=(saved&&saved.text)||''; c.setAttribute('data-state','editing'); ta.focus(); }
    c.querySelector('.cmt-toggle').addEventListener('click',edit);
    c.querySelector('.cmt-editbtn').addEventListener('click',edit);
    c.querySelector('.cmt-cancel').addEventListener('click',show);
    c.querySelector('.cmt-save').addEventListener('click',function(){
      var v=ta.value.trim(); if(!v){ return; }
      saved={text:v,at:Date.now()};
      try{ localStorage.setItem(key(sid),JSON.stringify(saved)); }catch(e){}
      show(); progress();
    });
    show();
  });
  progress();
})();
</script>
`;

// 返信プロンプト集約 (resolved・非 atomic 版)。REPLY_GEN と同一だが、対応済み (元コメント有り) の
//   基底見出し id 集合を data-resolved-sections から読み、その基底 id の .cmt を集約からスキップする。
//   → レビュアーの確定コメント (読取専用埋込) は集約コピーに二度と乗らない (冗長 + 改変リスク回避)。
//   再コメント (<sid>:re) は基底 id と異なるためスキップされず集約に入る (継続コメントは届く)。
const REPLY_GEN_RESOLVED = `<script>
(function(){
  var sec=document.querySelector('.reply-gen'); if(!sec) return;
  var btn=sec.querySelector('.reply-gen-btn'), out=sec.querySelector('.reply-out');
  var rid=document.documentElement.getAttribute('data-report-id')||'';
  var skip=(document.documentElement.getAttribute('data-resolved-sections')||'').split(' ').filter(Boolean);
  function load(sid){ try{return JSON.parse(localStorage.getItem('ccpit-cmt:'+rid+':'+sid)||'null');}catch(e){return null;} }
  function excerpt(box){
    var t='', ps=box.querySelectorAll('p,li');
    for(var i=0;i<ps.length;i++){ t+=(t?' ':'')+ps[i].textContent.trim(); if(t.length>=400) break; }
    return t.slice(0,400);
  }
  function feedback(ok){ sec.setAttribute('data-copied',ok?'1':'0'); setTimeout(function(){ sec.removeAttribute('data-copied'); },1800); }
  function legacyCopy(){ var ok=false; try{ out.focus(); out.select(); ok=document.execCommand('copy'); }catch(e){} return ok; }
  btn.addEventListener('click',function(){
    var parts=[], n=0;
    [].slice.call(document.querySelectorAll('.cmt')).forEach(function(c){
      var sid=c.getAttribute('data-section');
      if(skip.indexOf(sid)>=0) return; // 対応済み (元コメント) 基底 id は集約から除外
      var s=load(sid);
      if(!(s&&s.text)) return;
      n++;
      var box=c.closest('.tab-panel,.topic')||c.parentNode;
      var h=box.querySelector('h2,h3,h4'), heading=h?h.textContent.trim():sid;
      parts.push('### '+heading+'\\n（本文抜粋）'+excerpt(box)+'\\nコメント: '+s.text);
    });
    var head='## CCPIT 報告書コメント返信タスク（'+n+'件）\\n報告書: '+rid+'\\n\\n';
    out.value = n ? head+parts.join('\\n\\n') : head+'（コメントなし）';
    sec.setAttribute('data-generated','1');
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(out.value).then(function(){feedback(true);},function(){feedback(legacyCopy());});
    } else { feedback(legacyCopy()); }
  });
})();
</script>
`;

// 返信プロンプト集約 (resolved・atomic 版)。REPLY_GEN_ATOMIC と同一だが、対応済み基底 id を
//   data-resolved-sections から読みスキップする (REPLY_GEN_RESOLVED と同じ除外規律)。
//   再コメント (<sid>:re) は hmap に無いため fallbackHeading で正しい H2/H3 トピック名に解決される。
const REPLY_GEN_ATOMIC_RESOLVED = `<script>
(function(){
  var sec=document.querySelector('.reply-gen'); if(!sec) return;
  var btn=sec.querySelector('.reply-gen-btn'), out=sec.querySelector('.reply-out');
  var rid=document.documentElement.getAttribute('data-report-id')||'';
  var skip=(document.documentElement.getAttribute('data-resolved-sections')||'').split(' ').filter(Boolean);
  function load(sid){ try{return JSON.parse(localStorage.getItem('ccpit-cmt:'+rid+':'+sid)||'null');}catch(e){return null;} }
  function hLevel(el){ var m=el&&el.tagName&&el.tagName.match(/^H([2-6])$/); return m?+m[1]:0; }
  var hmap={};
  [].slice.call(document.querySelectorAll('h2[id],h3[id],h4[id]')).forEach(function(h){ hmap[h.id]=h; });
  function excerptOf(h){
    var stop=Math.max(3, hLevel(h));
    var t='', n=h.nextElementSibling;
    while(n){
      var lv=hLevel(n);
      if(lv>0 && lv<=stop) break;
      if(n.matches&&n.matches('p,li')){ if(n.textContent){ t+=(t?' ':'')+n.textContent.trim(); } }
      var qs=n.querySelectorAll?n.querySelectorAll('p,li'):[];
      for(var i=0;i<qs.length;i++){ t+=(t?' ':'')+qs[i].textContent.trim(); if(t.length>=400) break; }
      if(t.length>=400) break;
      n=n.nextElementSibling;
    }
    return t.slice(0,400);
  }
  function fallbackHeading(c){ var box=c.closest('.tab-panel,.topic')||c.parentNode; var h=box.querySelector('h2,h3,h4'); return h?h.textContent.trim():null; }
  function fallbackExcerpt(c){ var box=c.closest('.tab-panel,.topic')||c.parentNode; var t='',ps=box.querySelectorAll('p,li'); for(var i=0;i<ps.length;i++){ t+=(t?' ':'')+ps[i].textContent.trim(); if(t.length>=400) break; } return t.slice(0,400); }
  function feedback(ok){ sec.setAttribute('data-copied',ok?'1':'0'); setTimeout(function(){ sec.removeAttribute('data-copied'); },1800); }
  function legacyCopy(){ var ok=false; try{ out.focus(); out.select(); ok=document.execCommand('copy'); }catch(e){} return ok; }
  btn.addEventListener('click',function(){
    var parts=[], n=0;
    [].slice.call(document.querySelectorAll('.cmt')).forEach(function(c){
      var sid=c.getAttribute('data-section');
      if(skip.indexOf(sid)>=0) return; // 対応済み基底 id は集約から除外 (除外判定は exact sid)
      var s=load(sid);
      if(!(s&&s.text)) return;
      n++;
      // 再コメント (<baseSid>:re) は hmap に無いため、基底 id へ正規化して H3 見出し/抜粋を引く。
      //   こうしないと closest('.topic') が最外 H2 を掴み、H3 再コメントが誤った H2 トピック名で
      //   集約される (Codex MAJOR 指摘: atomic 集約の取り違え穴の再発防止)。
      var baseSid=sid.replace(/:re$/,'');
      var h=hmap[sid]||hmap[baseSid];
      var heading=h?h.textContent.trim():(fallbackHeading(c)||sid);
      var ex=h?excerptOf(h):fallbackExcerpt(c);
      parts.push('### '+heading+'\\n（本文抜粋）'+ex+'\\nコメント: '+s.text);
    });
    var head='## CCPIT 報告書コメント返信タスク（'+n+'件）\\n報告書: '+rid+'\\n\\n';
    out.value = n ? head+parts.join('\\n\\n') : head+'（コメントなし）';
    sec.setAttribute('data-generated','1');
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(out.value).then(function(){feedback(true);},function(){feedback(legacyCopy());});
    } else { feedback(legacyCopy()); }
  });
})();
</script>
`;

// ---------------------------------------------------------------------------
// --verify: HTML ⊆ MD テキストノード包含検証
// ---------------------------------------------------------------------------

function extractTextNodes(html) {
  // <script> と <style> はここで全除外する。これらにはレンダラ制御データと装飾のみを置く
  // (mermaid/タブ/コメント/テーマ/ホバーのローダ、ホバー要約データ島 JSON、CSS 擬似要素ラベル等)。
  // 本文由来の可視テキストをここに置いてはならない。置けば verify (HTML⊆MD / MD⊆HTML) の
  // 被覆検証をすり抜け、捏造・欠落の検出網に穴が空く。
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  // タグを区切り文字へ (隣接テキストノードの癒着を防ぐ)
  s = s.replace(/<[^>]+>/g, '\n');
  s = decodeEntities(s);
  return s
    .split('\n')
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// 統一正規化 canon: MD ソーステキストと HTML 描画テキストを比較可能にする。
// マーカー (renderInline が消費する ** ` / tokenize が剥がす # > | / リンク url / [!TYPE])
// と「全空白」を両側から除去し、内容文字のみ残す。
//  - インライン要素境界 (<strong>/<code>/<a>) が HTML テキストノードを分割して挿入する
//    空白を、全空白除去で吸収 (誰が読む: ⇔ 誰が読む :  の不一致を解消)。
//  - リテラル | や 対なし ** が内容に出ても、両側で同じく除去するため誤検出しない
//    ("Edit|Write" ⇔ buildCorpus が | を空白化して不一致、という M1 の穴を塞ぐ)。
function canon(s) {
  return decodeEntities(s)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // リンク [t](u) → t (url は href 属性=非テキストノード)
    .replace(/\[!([A-Za-z]+)\]/g, '') // admonition マーカー
    .replace(/[*`|>#]/g, '') // renderInline 消費マーカー + 構造記号
    .replace(/\s+/g, '') // 全空白除去 (インライン境界の分割空白を吸収)
    .trim();
}

// 後方互換エイリアス (export 済み)。corpus = 全 MD を canon 正規化した文字列。
function buildCorpus(md) {
  return canon(md);
}

// HTML ⊆ MD (捏造防止): 各 HTML テキストノードが MD コーパスに含まれるか
function verify(md) {
  const html = render(md, 'verify-input.md');
  const corpus = canon(md);
  const nodesRaw = extractTextNodes(html);
  const violations = [];
  for (const node of nodesRaw) {
    const c = canon(node);
    if (c && !corpus.includes(c)) {
      violations.push(node);
    }
  }
  return { ok: violations.length === 0, violations, total: nodesRaw.length };
}

// ---------------------------------------------------------------------------
// 完全性検証 (MD ⊆ HTML): MD 本文の各描画ブロック片が HTML に被覆されているか。
// silent omission (preamble バグ級の欠落) を検出。HTML⊆MD の鏡像。
//
// 正規化注意 (005 追加1):
//  - frontmatter は body 抽出で除外 (非描画メタ)
//  - マーカー記号 (# > | ** ` [!TYPE] リンク url) は除去 (描画されない)
//  - フェンス言語識別子は info string 行を片に含めない
//  - 図ブロック (mermaid/svg) は片に含めない (図中テキストは被覆検証から除外)
// ---------------------------------------------------------------------------

// 完全性検証も同じ canon を使う (両方向対称)。エイリアスを残す。
function normForMatch(s) {
  return canon(s);
}

// MD ブロック列から「描画されるテキスト片」を抽出 (図ブロックは除外)
function collectPieces(blocks) {
  const pieces = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
        pieces.push(b.text);
        break;
      case 'paragraph':
        pieces.push(b.lines.join(' '));
        break;
      case 'list':
        for (const it of b.items) pieces.push(it.text);
        break;
      case 'table':
        for (const cell of b.header) pieces.push(cell);
        for (const row of b.rows) for (const cell of row) pieces.push(cell);
        break;
      case 'fence':
        // 図ブロック (mermaid/svg) は完全性検証から除外。通常コードは内容として含める
        if (!['mermaid', 'svg'].includes((b.info || '').toLowerCase())) {
          pieces.push(b.content.join(' '));
        }
        break;
      case 'admonition':
        if (b.title) pieces.push(b.title);
        if (b.content && b.content.join('').trim()) {
          pieces.push(...collectPieces(tokenize(b.content.join('\n'))));
        }
        break;
      case 'blockquote':
        pieces.push(...collectPieces(tokenize(b.content.join('\n'))));
        break;
      default:
        break;
    }
  }
  return pieces;
}

function verifyCompleteness(md) {
  const html = render(md, 'verify-input.md');
  const { body } = parseFrontmatter(md);
  const blocks = tokenize(body);
  // HTML 側コーパス (全テキストノードを canon 連結)
  const htmlCorpus = canon(extractTextNodes(html).join('\n'));
  // MD 側ブロック片 (canon 正規化)
  const pieces = collectPieces(blocks)
    .map(canon)
    .filter((p) => p.length > 0);
  const omissions = [];
  for (const p of pieces) {
    if (!htmlCorpus.includes(p)) omissions.push(p);
  }
  return { ok: omissions.length === 0, omissions, total: pieces.length };
}

// 双方向検証 (HTML⊆MD 捏造防止 + MD⊆HTML 欠落防止)
function verifyBidirectional(md) {
  const fwd = verify(md); // HTML ⊆ MD
  const bwd = verifyCompleteness(md); // MD ⊆ HTML
  return { ok: fwd.ok && bwd.ok, fwd, bwd };
}

// ---------------------------------------------------------------------------
// --lint: 報告書型 frontmatter の必須マーカー欠落を警告 (exit 0)
//         + figures 宣言-実体一致の機械判定 (違反は errors → exit 1)。
//         意味判定 (図が必要か) は diagram-craft skill 側に置き lint はしない。
//         移行措置 (grandfather): 本検査は改定後の新規報告書にのみ実行する運用。
//         既存報告書への遡及 lint・一括 lint 適用は禁止 (report skill 規約)。
// ---------------------------------------------------------------------------

// frontmatter 生スキャン (lint 専用): hover: ブロックの宣言有無と壊れた子行を抽出する。
// parseFrontmatter は壊れた行を捕捉しない (出力 byte 不変が最優先) ため、警告用に別途走査する。
function lintFrontmatterRaw(md) {
  const res = {
    hoverDeclared: false, brokenHoverLines: [],
    resolvedDeclared: false, brokenResolvedLines: [],
  };
  if (!md.startsWith('---\n') && !md.startsWith('---\r\n')) return res;
  const lines = md.split(/\r?\n/);
  let fmEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { fmEnd = i; break; }
  }
  if (fmEnd === -1) return res;
  for (let i = 1; i < fmEnd; i++) {
    const m = lines[i].match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (m && m[1] === 'hover' && m[2].trim() === '') {
      res.hoverDeclared = true;
      let j = i + 1;
      while (j < fmEnd && /^\s+\S/.test(lines[j])) {
        const im = lines[j].match(/^\s+-\s+(.*)$/);
        if (!im) {
          res.brokenHoverLines.push(lines[j]);
        } else if (im[1].indexOf('||') === -1) {
          res.brokenHoverLines.push(lines[j]);
        }
        j++;
      }
      i = j - 1;
    } else if (m && m[1] === 'comments_resolved' && m[2].trim() === '') {
      // hover と同型: 子行のうち "- 見出し || メモ" 形式でない行を壊れた行として記録。
      res.resolvedDeclared = true;
      let j = i + 1;
      while (j < fmEnd && /^\s+\S/.test(lines[j])) {
        const im = lines[j].match(/^\s+-\s+(.*)$/);
        if (!im) {
          res.brokenResolvedLines.push(lines[j]);
        } else if (im[1].indexOf('||') === -1) {
          res.brokenResolvedLines.push(lines[j]);
        }
        j++;
      }
      i = j - 1;
    }
  }
  return res;
}

function lint(md) {
  const { fm, body } = parseFrontmatter(md);
  const warnings = [];
  const errors = [];
  const isReport = isReportDoc(fm, body);

  if (!isReport) {
    return { isReport: false, warnings, errors };
  }
  if (!/##\s*本報告書の読者と目的/.test(body)) {
    warnings.push('必須セクション欠落: "## 本報告書の読者と目的"');
  }
  if (
    !new RegExp('^##\\s+.*(?:' + SUMMARY_HEADING_RE.source + ')', 'im').test(body) &&
    !(fm && fm.conclusion_summary === 'none' && fm.conclusion_summary_reason &&
      String(fm.conclusion_summary_reason).trim())
  ) {
    warnings.push('必須セクション欠落: "## 結論の概要" (読者と目的の直後・各結論に **OK/FAIL/CAVEAT/INFO** バッジ。免除は frontmatter conclusion_summary: none ＋ conclusion_summary_reason 必須)');
  }
  if (!(fm && fm.where) && !/##\s*現在地/.test(body)) {
    warnings.push('Where 情報欠落: frontmatter "where:" も "## 現在地" も無い');
  }
  if (!/>\s*\[!DECISION\]/.test(body)) {
    warnings.push('設計判断マーカー欠落: "> [!DECISION]" が本文に無い (判断箇所が不明確)');
  }
  if (!/スコープ外提案|Pending/i.test(body)) {
    warnings.push('スコープ外会計欠落: "## スコープ外提案（Pending）" が無い');
  }

  // figures 宣言-実体一致 (双方向・機械判定可能なシグナルのみ block)。
  // 実体検出はレンダラと同一コードパス (tokenize / analyzeNumericColumns) を再利用し判定乖離を排除。
  // mermaid は種別分類する (stateDiagram → state / graph・flowchart → flow, where-map)。
  // where-map と flow の区別は意味判定 (ツリー+現在地か否か) のため lint では行わず
  // diagram-craft skill 側に置く (機械判定可能なシグナルのみ block する設計原則)。
  // 逆方向 (実体→宣言) の強度区分: mermaid/svg フェンスは執筆者が意図して書く図ソース → error。
  // 数値列表は付随的 (任意の数値列にバーが自動描画される過剰近似) → warning に留める (誤爆防止)。
  const blocks = tokenize(body);
  let hasGraph = false;
  let hasState = false;
  let hasSvg = false;
  let hasNumTable = false;
  let hasMermaidAny = false;
  let hasUnsupportedMermaid = false; // sequenceDiagram 等 (renderFence は全 mermaid を描画するため検査対象)
  for (const b of blocks) {
    if (b.type === 'fence') {
      const info = (b.info || '').toLowerCase();
      if (info === 'mermaid') {
        hasMermaidAny = true;
        const src = (b.content || []).join('\n');
        const isState = /^\s*stateDiagram/m.test(src);
        const isGraph = /^\s*(graph|flowchart)\b/m.test(src);
        if (isState) hasState = true;
        if (isGraph) hasGraph = true;
        if (!isState && !isGraph) hasUnsupportedMermaid = true;
      }
      if (info === 'svg') hasSvg = true;
    } else if (b.type === 'table') {
      if (analyzeNumericColumns(b).some(Boolean)) hasNumTable = true;
    }
  }
  const figures = fm ? fm.figures : undefined;
  if (figures === undefined || figures === '') {
    errors.push(
      'figures 宣言欠落: frontmatter に "figures: [図種]" か "figures: none" + figures_reason を書け' +
        ' (移行措置: 改定前の既存報告書は --lint 対象外。新規報告書にのみ実行せよ)'
    );
  } else if (figures === 'none') {
    if (!fm.figures_reason) {
      errors.push('figures: none に figures_reason が無い (省略理由の明文化義務)');
    }
    if (hasMermaidAny || hasSvg) {
      errors.push('宣言矛盾: figures: none なのに本文に図ソース (mermaid/svg フェンス) がある。実体に合わせて宣言せよ');
    }
    if (hasNumTable) {
      warnings.push('figures: none だが数値列を持つ表があり DA バーが自動描画される (DA 比較の意図があるなら figures: [da-table] を宣言せよ)');
    }
  } else if (Array.isArray(figures) && figures.length === 0) {
    errors.push('figures: [] は不可: 図種を 1 つ以上書くか "figures: none" + figures_reason を使え');
  } else {
    const declared = Array.isArray(figures) ? figures : [figures];
    const present = {
      'da-table': hasNumTable,
      'where-map': hasGraph,
      flow: hasGraph,
      state: hasState,
      'arch-svg': hasSvg,
    };
    for (const kind of declared) {
      if (!(kind in present)) {
        errors.push('未知の図種: "' + kind + '" (da-table / where-map / flow / state / arch-svg のみ)');
      } else if (!present[kind]) {
        errors.push(
          '宣言-実体不一致: figures に "' + kind + '" があるが本文に実体が無い' +
            ' (da-table=数値列を持つ表, where-map/flow=graph・flowchart フェンス, state=stateDiagram フェンス, arch-svg=svg フェンス)'
        );
      }
    }
    // 逆方向: 本文実体が宣言に無い = 図プランのドリフト検出
    const has = (k) => declared.includes(k);
    if (hasState && !has('state')) {
      errors.push('未宣言の図: stateDiagram フェンスがあるが figures に state が無い');
    }
    if (hasGraph && !has('flow') && !has('where-map')) {
      errors.push('未宣言の図: graph/flowchart フェンスがあるが figures に flow か where-map が無い');
    }
    if (hasSvg && !has('arch-svg')) {
      errors.push('未宣言の図: svg フェンスがあるが figures に arch-svg が無い');
    }
    if (hasUnsupportedMermaid) {
      errors.push(
        '規約外の mermaid 図: stateDiagram / graph / flowchart 以外の mermaid フェンスがある' +
          ' (図種規約は flow / where-map / state に対応する形式のみ。sequenceDiagram 等は使用しない)'
      );
    }
    if (hasNumTable && !has('da-table')) {
      warnings.push('数値列を持つ表があるが figures に da-table が無い (DA バーが自動描画される。DA 比較なら宣言を推奨)');
    }
  }

  // tabs 宣言検査 (タブ UI は決定論レンダラ拡張。宣言時のみ render がタブ化。警告のみ・非ブロック)。
  if (fm && fm.tabs !== undefined && fm.tabs !== '') {
    if (fm.tabs !== 'by-h2') {
      warnings.push('未知の tabs 値: "' + fm.tabs + '" (対応値は by-h2 のみ。タブ化されない)');
    } else {
      const tabbable = blocks.filter(
        (b) =>
          b.type === 'heading' &&
          b.level === 2 &&
          !/読者と目的/.test(b.text) &&
          !/スコープ外提案|Pending|ペンディング/i.test(b.text)
      ).length;
      if (tabbable < 2) {
        warnings.push('tabs: by-h2 だがタブ化対象の H2 セクションが ' + tabbable + ' 件 (2 件以上推奨)');
      }
    }
  }

  // comments 値検査 (既定は報告書で有効。on/off/atomic のみ受理。未知値は警告・非ブロック)。
  //   atomic = H3 (小見出し=トピック) 単位にも Composer を出す Atomic コメント (H2 末 Composer も維持)。
  if (fm && fm.comments !== undefined && fm.comments !== '') {
    if (fm.comments !== 'on' && fm.comments !== 'off' && fm.comments !== 'atomic') {
      warnings.push('未知の comments 値: "' + fm.comments + '" (on / off / atomic のみ。既定はコメント有効)');
    }
  }

  // theme 宣言検査 (opt-in テーマ切替。toggle のみ受理。未知値は警告・非ブロック)。
  if (fm && fm.theme !== undefined && fm.theme !== '') {
    if (fm.theme !== 'toggle') {
      warnings.push('未知の theme 値: "' + fm.theme + '" (対応値は toggle のみ。テーマ切替は注入されない)');
    }
  }

  // hover 宣言検査 (opt-in ホバープレビュー)。frontmatter の hover: ブロックの子行のうち
  // "|| 区切り無し" 等の壊れた行を警告する (parseFrontmatter は壊れた行を黙って捨てるため)。
  const fmRaw = lintFrontmatterRaw(md);
  if (fmRaw.hoverDeclared) {
    if (fmRaw.brokenHoverLines.length) {
      warnings.push(
        'hover 宣言の不正行: "- 識別子 || 要約" 形式でない行が ' + fmRaw.brokenHoverLines.length +
          ' 件 (これらは無視される。例: ' + JSON.stringify(fmRaw.brokenHoverLines[0]) + ')'
      );
    }
    if (!(fm && Array.isArray(fm.hover) && fm.hover.length)) {
      warnings.push('hover 宣言があるが有効な "- 識別子 || 要約" 行が 1 件も無い (ホバーは注入されない)');
    }
  }

  // comments_resolved 宣言検査 (opt-in コメント解決バッジ・非ブロック)。
  //   (a) 壊れた子行 (|| 区切り無し) を警告 (parseFrontmatter は黙って捨てる)。
  //   (b) commentsMode 前提が満たされない (= report_id/doc_id 無し or comments:off) のに宣言した場合を警告。
  //   (c) 見出しに一致しない key を警告 (描画されない)。判定は render と同一の
  //       canon→sha1→'sec-'... sectionId 化で全見出し集合と突き合わせる。
  if (fmRaw.resolvedDeclared) {
    if (fmRaw.brokenResolvedLines.length) {
      warnings.push(
        'comments_resolved 宣言の不正行: "- 見出し || メモ" 形式でない行が ' + fmRaw.brokenResolvedLines.length +
          ' 件 (これらは無視される。例: ' + JSON.stringify(fmRaw.brokenResolvedLines[0]) + ')'
      );
    }
    const hasResolvedEntries = !!(fm && Array.isArray(fm.comments_resolved) && fm.comments_resolved.length);
    if (!hasResolvedEntries) {
      warnings.push('comments_resolved 宣言があるが有効な "- 見出し || メモ" 行が 1 件も無い (バッジは注入されない)');
    } else {
      const reportIdL = fm && (fm.report_id || fm.doc_id) ? String(fm.report_id || fm.doc_id) : '';
      const commentsModeL = !!(reportIdL && isReportDoc(fm, body) && fm.comments !== 'off');
      if (!commentsModeL) {
        warnings.push('comments_resolved 宣言があるがコメント機能が無効 (report_id/doc_id 不在 or comments:off) のため描画されない');
      } else {
        // 全見出しの sectionId 集合を構築し、key 不一致を検出。
        const headingIds = new Set(
          blocks.filter((b) => b.type === 'heading').map((b) => 'sec-' + sha1(canon(b.text)).slice(0, 8))
        );
        const unmatched = fm.comments_resolved
          .map((e) => e.key)
          .filter((k) => !headingIds.has('sec-' + sha1(canon(k)).slice(0, 8)));
        if (unmatched.length) {
          warnings.push(
            'comments_resolved の見出し不一致: 一致する見出しが無い key が ' + unmatched.length +
              ' 件 (これらのメモは描画されない。例: ' + JSON.stringify(unmatched[0]) + ')'
          );
        }
      }
    }
  }

  // 重複見出し警告: 同一 canon の H2 が複数 = sha1 アンカー/コメントが合流する (書き手に通知)。
  const h2canon = blocks
    .filter((b) => b.type === 'heading' && b.level === 2)
    .map((b) => canon(b.text));
  const seenH2 = {};
  const dupH2 = {};
  for (const t of h2canon) {
    if (seenH2[t]) dupH2[t] = true;
    seenH2[t] = true;
  }
  if (Object.keys(dupH2).length) {
    warnings.push(
      '重複見出し: 同一テキストの H2 が複数あり sha1 アンカー/コメントが合流する (' +
        Object.keys(dupH2).length + ' 種。見出しを一意にせよ)'
    );
  }

  // comments: atomic 時のみ: H3 (小見出し) にも Composer・localStorage key・返信集約の逆引きが
  //   H3 id (= sec-sha1(canon(text))) に依存するため、同一テキストの H3 が複数あると
  //   コメントが合流する。atomic 文書に限り H3 の重複も警告する (非 atomic 文書は H3 id が
  //   Composer に使われないため従来どおり警告しない = lint 出力も互換)。
  if (fm && fm.comments === 'atomic') {
    const h3canon = blocks
      .filter((b) => b.type === 'heading' && b.level === 3)
      .map((b) => canon(b.text));
    const seenH3 = {};
    const dupH3 = {};
    for (const t of h3canon) {
      if (seenH3[t]) dupH3[t] = true;
      seenH3[t] = true;
    }
    if (Object.keys(dupH3).length) {
      warnings.push(
        '重複見出し (atomic): 同一テキストの H3 が複数あり sha1 アンカー/コメントが合流する (' +
          Object.keys(dupH3).length + ' 種。H3 を一意にせよ。comments: atomic では H3 がコメント単位)'
      );
    }
  }

  return { isReport: true, warnings, errors };
}

// ---------------------------------------------------------------------------
// --selftest: 内蔵 golden ケース描画 → 埋込 sha256 と照合 (破損検出)
// ---------------------------------------------------------------------------

const GOLDEN = [
  {
    name: 'minimal-heading-para',
    md: '# Title\n\n## 1. 概要\n\n本文 **強調** と `code`。\n',
    sha: '7c376d8517c8b914d8eb4f8f0386a32d224e53892a1ad83a59c815e0574815a4',
  },
  {
    name: 'table-numeric-admonition',
    md:
      '---\ndoc_id: T\nstatus: in_progress\nwhere: A > B\n---\n\n# T\n\n## 本報告書の読者と目的\n\n- **誰が読む**: x\n\n## 1. 比較\n\n| 観点 | スコア |\n|---|---|\n| 案1 | 10 |\n| 案2 | 40 |\n\n> [!DECISION] 決裁A\n\n## スコープ外提案（Pending）\n\n| 項目 | 状態 |\n|---|---|\n| P1 | 未着手 |\n',
    sha: '492387849e9eb2db68d8e324f52781d213832bfeb5fb557ebc1e4d4f92fc5c22',
  },
  {
    name: 'svg-data-uri',
    md: '# S\n\n## 1. 図\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>\n```\n',
    sha: '6ca878bfa0fd44938f1c54bf2913166b774071fdbcde834e7b2ccac609bbb2b0',
  },
  {
    name: 'tabs-by-h2',
    md: '---\ntabs: by-h2\n---\n\n# TT\n\n## 1. 目的\n\nfoo **強調**\n\n## 2. 次\n\nbar `code`\n',
    sha: '7c787829dcfa514a67759b3586ec31992c9a4e409cf973446d791f4de26b96e5',
  },
  {
    name: 'comments-on',
    md: '---\nreport_id: R1\n---\n\n# CR\n\n## 1. 目的\n\nfoo\n\n## 2. 次\n\nbar\n',
    sha: '60a86a3187072f9885b132c6690f1ecd169a89aa9e989fc97ab0d093fd4fc47f',
  },
  {
    name: 'tabs-comments',
    md: '---\nreport_id: R2\ntabs: by-h2\n---\n\n# CT\n\n## 1. 目的\n\nfoo\n\n## 2. 次\n\nbar\n',
    sha: '8e726d2c9961b9cfdd62a2161fb0890475cf822d60c80eacb669135ddfca7020',
  },
  // --- theme/hover 拡張ケース (8 件) ---
  {
    name: 'theme-toggle-only',
    md: '---\ntheme: toggle\n---\n\n# TH\n\n## 1. 概要\n\n本文 **強調**。\n',
    sha: '17ca957c56c95e0b8e9cae45ed14b990b120ac0986fc979c94951c8ffdabf4bb',
  },
  {
    name: 'hover-only',
    md:
      '---\nhover:\n  - https://example.com/a || A の要約\n  - https://example.com/b || B の要約\n---\n\n' +
      '# HV\n\n## 1. 参照\n\n[A](https://example.com/a) と [B](https://example.com/b) を参照。\n',
    sha: '54db8dec0d081690687b4738fc0fd9d128f9e3bf144a1f61d9d8bdc4998824e4',
  },
  {
    name: 'theme-hover-combo',
    md:
      '---\ntheme: toggle\nhover:\n  - https://example.com/x || X 要約\n---\n\n' +
      '# THV\n\n## 1. 本文\n\n[X](https://example.com/x) リンク。\n',
    sha: '137558df16137655ff4f5914933631701f0d2c77cba9d9821eaca2a6549c339f',
  },
  {
    name: 'hover-nomatch-link',
    md:
      '---\nhover:\n  - https://example.com/known || 既知\n---\n\n' +
      '# NM\n\n## 1. 本文\n\n[未一致](https://example.com/other) は target/rel が付かない。\n',
    sha: '1872b7e48a55bb2c3828f6e78f3ce213c71efccc77de3198efd30659ea690af7',
  },
  {
    name: 'hover-non-http-link',
    md:
      '---\nhover:\n  - mailto:a@b.c || メール\n  - ./rel.md || 相対\n---\n\n' +
      '# NH\n\n## 1. 本文\n\n[メール](mailto:a@b.c) と [相対](./rel.md) は target/rel が付かない。\n',
    sha: '924465eef5b9ca7a428e5e74c62776a256f3a408144a395d17824f13f6c15029',
  },
  {
    name: 'hover-special-chars',
    md:
      '---\nhover:\n  - https://example.com/s || < > & " \' を含む 日本語\n---\n\n' +
      '# SP\n\n## 1. 本文\n\n[S](https://example.com/s) の要約に特殊文字。\n',
    sha: 'd1ef0a56302e0807abc799799e91303f6b57ee949b2a1226fd525dbbc0db5f61',
  },
  {
    name: 'theme-unknown-value',
    md: '---\ndoc_id: U\ntheme: neon\n---\n\n# U\n\n## 1. 概要\n\n本文。\n',
    sha: '0bb41fa435dc07e7c45be41022a703888072784113228d4e58175dc3713be6c5',
  },
  {
    name: 'hover-broken-line',
    md:
      '---\ndoc_id: B\nhover:\n  - https://example.com/ok || 正常\n  - これは区切り無しの壊れた行\n---\n\n' +
      '# B\n\n## 1. 本文\n\n[OK](https://example.com/ok) リンク。\n',
    sha: '69af52ab777bd3933d54f8a35ba52f4c5bc5a808b7653a62c02fa4ea0922bd7d',
  },
  // --- comments_resolved 拡張ケース: commentsMode + comments_resolved opt-in ---
  // 注: 下記 3 件は 2 部記法 (元コメント無し)。candidate5 で データ島形式が
  //   {index:memo} → {index:{memo,orig}} へ拡張され RESOLVED_LOADER も .cmt-orig 投入を追加したため
  //   sha を再算出 (可視出力 = バッジ+メモ+編集 Composer は従来と機能等価。読取専用埋込は出ない)。
  {
    name: 'comments-resolved-basic',
    md:
      '---\nreport_id: RR1\ncomments_resolved:\n  - 1. 目的 || この節は対応済み。\n---\n\n' +
      '# CRB\n\n## 1. 目的\n\nfoo\n\n## 2. 次\n\nbar\n',
    sha: 'e9eb38f8a9f82c55c4be9ba1fe4b015d4f6b9e6643db9a32056040aae8f8f35c',
  },
  {
    name: 'comments-resolved-mismatch',
    md:
      '---\nreport_id: RR2\ncomments_resolved:\n  - 存在しない見出し || 描画されないメモ。\n  - 1. 目的 || 対応済み。\n---\n\n' +
      '# CRM\n\n## 1. 目的\n\nfoo\n\n## 2. 次\n\nbar\n',
    sha: '58e2571ad325899158e632d4e9c10618cebb4be9def7ce2c016a2c8efe1352ec',
  },
  {
    name: 'comments-resolved-specialchars',
    md:
      '---\nreport_id: RR3\ncomments_resolved:\n  - 1. 目的 || 特殊 < > & " \' を含む メモ\n---\n\n' +
      '# CRS\n\n## 1. 目的\n\nfoo\n\n## 2. 次\n\nbar\n',
    sha: 'a82e301d0b040c6e95cf874e023e78a1d585efbdeae94da3d3f4fc120970a52e',
  },
  // --- comments_resolved 3 部記法 (元コメント埋込 = 読取専用 + 再コメント欄) 拡張ケース (2 件) ---
  {
    // 3 部: 見出し || 元コメント || CC 対応メモ。§1 が読取専用埋込 (cmt-orig) + ✓対応済み + メモ +
    //   再コメント Composer (sec-...:re) になる。<html> に data-resolved-sections=§1基底id。§2 は通常。
    name: 'comments-resolved-embed',
    md:
      '---\nreport_id: RE1\ncomments_resolved:\n  - 1. 目的 || 元コメント本文。 || CC 対応メモ。\n---\n\n' +
      '# CRE\n\n## 1. 目的\n\nfoo\n\n## 2. 次\n\nbar\n',
    sha: '0040b0ea2695e858cebd69a8ca680efd512b33a211aad2bdd50b12fcb5cb8c69',
  },
  {
    // 3 部 + atomic: 元コメント埋込が H3 (1.2 細目B) に付く。読取専用埋込 + 再コメント (sec-...:re) が
    //   H3 欄に共存し、H2 末・他 H3 の Composer は編集可能なまま (対応済みでも再コメント可を atomic 粒度で実証)。
    name: 'comments-resolved-recomment-atomic',
    md:
      '---\nreport_id: RE2\ncomments: atomic\ncomments_resolved:\n  - 1.2 細目B || 元コメント。 || 対応済みメモ。\n---\n\n' +
      '# CRR\n\n## 1. 概要\n\nlead。\n\n### 1.1 細目A\n\nfoo\n\n### 1.2 細目B\n\nbar\n',
    sha: '78118cf6030cd87a0527bf42aa67daa2b7a6e40e290c429c411971049d3e5c6b',
  },
  // --- comments: atomic 拡張ケース (2 件): H3 (小見出し=トピック) 直下にも Composer ---
  {
    // H2 複数 (1. / 2.) + 各 H2 内 H3 複数 (1.1/1.2, 2.1) + lead 段落。
    // 各 H3 直下に Composer + 各 H2 末に総括 Composer (二層) が出る。
    name: 'comments-atomic',
    md:
      '---\nreport_id: AT1\ncomments: atomic\n---\n\n' +
      '# AT\n\n## 1. 概要\n\nlead 段落。\n\n### 1.1 細目A\n\nfoo\n\n### 1.2 細目B\n\nbar\n\n' +
      '## 2. 次\n\nbaz\n\n### 2.1 細目C\n\nqux\n',
    sha: '800a272b7e6a55837dcf3bc8e6fa3261361825018ba90738d67947bbd67a1b2e',
  },
  {
    // atomic + H3 に対する 2 部 comments_resolved (元コメント無し)。対応済みバッジが H3 Composer の
    // 欄に共存し、その H3 でも編集 Composer が残る (再コメント可) ことを sha で固定する。
    // candidate5 でデータ島形式拡張 ({memo,orig}) のため sha 再算出 (元コメント無し = 読取専用埋込は出ない)。
    name: 'comments-atomic-resolved',
    md:
      '---\nreport_id: AT2\ncomments: atomic\ncomments_resolved:\n  - 1.2 細目B || この H3 は対応済み。\n---\n\n' +
      '# ATR\n\n## 1. 概要\n\nlead。\n\n### 1.1 細目A\n\nfoo\n\n### 1.2 細目B\n\nbar\n',
    sha: 'a29594fd24f0d01a8181c270a752c37f5dfb966232b99894c8c3160645961e1f',
  },
  {
    // 結論の概要パネル (読者と目的の後・要判断一覧の前に hoist) + 4 状態バッジ化を固定。
    name: 'conclusion-summary-badges',
    md:
      '---\nreport_id: CS1\n---\n\n# T\n\n## 本報告書の読者と目的\n\n- x\n\n' +
      '## 結論の概要\n\n- **OK** — a\n- **FAIL** — b\n- **CAVEAT** — c\n- **INFO** — d\n\n## 1. 詳細\n\nfoo\n',
    sha: '019b5b2c319e5aa089c03b49cb7ccb113c0ec124140d8e20ce2b3b19715b6f6e',
  },
  {
    // 誤爆防止: summary 内でも exact 不一致 (OK: / OK x) は非変換、パネル外 (本文) の OK も非変換を固定。
    name: 'summary-badge-scope',
    md:
      '---\nreport_id: CS2\n---\n\n# T\n\n## 本報告書の読者と目的\n\n- x\n\n' +
      '## 結論の概要\n\n- **OK** — yes\n- **OK:** — no\n- **OK x** — no\n\n## 1. 詳細\n\n- **OK** — body not badge\n',
    sha: '239b9ceec18797b5c211f23e8ca8867dbf23fc103c56bf41f6208b410d8eabeb',
  },
  {
    // 重複見出し周辺で hoist しても anchor id (sha1) が安定 = 決定論を固定。
    name: 'summary-duplicate-heading',
    md:
      '---\nreport_id: CS3\n---\n\n# T\n\n## 本報告書の読者と目的\n\n- x\n\n' +
      '## 結論の概要\n\n- **OK** — a\n\n## 重複\n\np\n\n## 重複\n\nq\n',
    sha: '04b82df993861683f28ec929e591c252538c189d7301ef5a2ae8211499c11c06',
  },
  {
    // 根治: title 無し [!DECISION] でも 要判断一覧 エントリが空にならず本文先頭から題を生成。
    name: 'decision-title-fallback',
    md:
      '---\nreport_id: CS4\n---\n\n# T\n\n## 本報告書の読者と目的\n\n- x\n\n' +
      '## 1. 詳細\n\n> [!DECISION]\n> **題無しの判断**。先頭強調句から題を生成。\n\nfoo\n',
    sha: '81dc0edbfdb1c7057589e178938f5cee4a02f98c0f1de9a4521258a10144c1a5',
  },
];

function selftest() {
  let ok = true;
  for (const g of GOLDEN) {
    const got = sha256(render(g.md, g.name + '.md'));
    if (got !== g.sha) {
      ok = false;
      console.error('[SELFTEST FAIL] ' + g.name + '\n  expected ' + g.sha + '\n  got      ' + got);
    } else {
      console.error('[SELFTEST OK]   ' + g.name);
    }
  }
  if (!selftestRedact()) ok = false; // redaction (--redact-apply / --leak-check) の positive+negative
  return ok;
}

// ---------------------------------------------------------------------------
// --check: HTML 埋込 sha256 と現 MD sha256 を照合 (_index 鮮度 / 件2 ④ 先取り)
// ---------------------------------------------------------------------------

function check(mdPath, htmlPath) {
  const md = fs.readFileSync(mdPath, 'utf8');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const m = html.match(/data-src-sha256="([0-9a-f]{64})"/);
  if (!m) return { ok: false, reason: 'HTML に data-src-sha256 が無い' };
  const embedded = m[1];
  const current = sha256(md);
  return { ok: embedded === current, embedded, current };
}

// ---------------------------------------------------------------------------
// redaction (件: 共有版=対外 の話者明示オフレコ/ぼかしを機械除去し漏えいを hard-fail)
//   --redact-apply <config.json> <in.md> <out.md>
//       alias を replacement へ置換 (テキストノード限定・URL/コードは触らない)・drop_hover の
//       hover エントリ/本文リンクを除去 → 匿名版 MD を機械生成 (DO NOT EDIT・来歴付き)。
//   --leak-check  <config.json> <file...>
//       alias(実名=どこでも禁止) と forbidden_headings(見出し文脈=機微章の取りこぼし) の
//       出現を全面走査 (正規化+デコード後) し、1 件でも exit≠0 (共有版ビルドの完了ゲート)。
//   config(JSON)= operator 専用・実名を持つ唯一の所在。配布物には一切置かない。
//   設計: redact-apply は壊さないため意図的にコード/URL を素通りさせ、その取りこぼしは
//         leak-check(より広い検査) が捕捉して人手対応に回す (置換と検査の責務分離)。
// ---------------------------------------------------------------------------

const REDACT_TOP_KEYS = new Set(['version', 'entries', 'forbidden_headings', 'contextual_terms']);
const REDACT_ENTRY_KEYS = new Set(['id', 'class', 'aliases', 'replacement', 'drop_hover', 'mode', 'leak_terms', 'note']);

// 厳格スキーマ: 未知キーは hard-fail (typo を無効設定として黙殺しない: Codex#11)。
function validateRedactConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('redact-config: オブジェクトでない');
  // "_" 接頭辞キーは注釈(無視)。それ以外の未知キーは hard-fail (typo を黙殺しない: Codex#11)。
  for (const k of Object.keys(cfg)) {
    if (k.startsWith('_')) continue;
    if (!REDACT_TOP_KEYS.has(k)) throw new Error('redact-config: 未知のトップキー "' + k + '"');
  }
  if (!Array.isArray(cfg.entries)) throw new Error('redact-config: entries[] が必要');
  for (const e of cfg.entries) {
    for (const k of Object.keys(e)) {
      if (k.startsWith('_')) continue;
      if (!REDACT_ENTRY_KEYS.has(k)) throw new Error('redact-config: entry 未知キー "' + k + '" (id=' + (e.id || '?') + ')');
    }
    if (!e.id) throw new Error('redact-config: entry に id が必要');
    if (!Array.isArray(e.aliases) || e.aliases.length === 0) throw new Error('redact-config: entry.aliases[] が必要 (id=' + e.id + ')');
    for (const a of e.aliases) if (typeof a !== 'string' || a === '') throw new Error('redact-config: alias は非空文字列 (id=' + e.id + ')');
    if (typeof e.replacement !== 'string' || e.replacement === '') throw new Error('redact-config: entry.replacement(非空文字列) が必要 (id=' + e.id + ')');
  }
  // replacement が秘匿語(alias/leak_term)を含むと再置換/漏えいの原因 (Codex impl#6)。
  const secretTerms = [];
  for (const e of cfg.entries) { secretTerms.push(...e.aliases); if (Array.isArray(e.leak_terms)) secretTerms.push(...e.leak_terms); }
  for (const e of cfg.entries) {
    for (const t of secretTerms) {
      if (t && e.replacement.includes(t)) throw new Error('redact-config: replacement "' + e.replacement + '" が秘匿語 "' + t + '" を含む (id=' + e.id + ')');
    }
  }
  if (cfg.forbidden_headings && !Array.isArray(cfg.forbidden_headings)) throw new Error('redact-config: forbidden_headings は配列');
  return cfg;
}

function loadRedactConfig(p) {
  return validateRedactConfig(JSON.parse(fs.readFileSync(p, 'utf8')));
}

// %XX 連を安全にデコード (壊れた % は素通り)。
function safePercentDecode(s) {
  return String(s).replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
    try { return decodeURIComponent(seq); } catch (_) { return seq; }
  });
}
// 多重 %エンコード (%25E5… 二重) を不動点まで展開 (上限3回・無限展開防止)。
function multiPercentDecode(s) {
  let prev = String(s);
  for (let k = 0; k < 3; k++) { const next = safePercentDecode(prev); if (next === prev) break; prev = next; }
  return prev;
}
// 数値文字参照 &#DDD; / &#xHHH; を復号 (decodeEntities は名前付き5種のみ=穴: Codex impl#1)。
//   HTML 成果物で alias を &#23665;&#37326; 形式に隠す経路を塞ぐ。leak-check 専用 (検出器を生成器より強く)。
function decodeNumericEntities(s) {
  return String(s)
    .replace(/&#x([0-9A-Fa-f]+);?/g, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return m; } })
    .replace(/&#(\d+);?/g, (m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (_) { return m; } });
}
// JS/CSS の \uXXXX / \u{…} / \xNN エスケープを復号 (script/style 内に alias を隠す経路: Codex impl#3)。
function decodeJsUnicode(s) {
  return String(s)
    .replace(/\\u\{([0-9A-Fa-f]+)\}/g, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return m; } })
    .replace(/\\u([0-9A-Fa-f]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

// leak 検査用の強正規化: 実体参照/URL%デコード + NFKC + ゼロ幅除去 + 全空白畳み込み + ASCII casefold。
//   分割/エンコード/全半角/異体字越しの alias 出現も拾う (置換より検査を広く: Codex#3/#6)。
//   canon と異なり URL 内容は捨てない (alias が URL に潜む経路を塞ぐ)。
function normForLeak(s) {
  let t = String(s);
  // 混在/多重エンコード(%26%23x..%3B のように percent×数値文字参照を入れ子化した経路) を
  //   不動点まで展開 (順序非依存・上限6回・無限展開防止: Codex impl2#1)。
  for (let k = 0; k < 6; k++) {
    const before = t;
    t = safePercentDecode(t);
    t = decodeEntities(t);
    t = decodeNumericEntities(t);
    t = decodeJsUnicode(t);
    if (t === before) break;
  }
  t = t.normalize('NFKC');
  t = t.replace(/[​‌‍⁠﻿]/g, ''); // ゼロ幅
  t = t.replace(/\s+/g, '');                              // 全空白
  return t.toLowerCase();
}

// inline トークナイズ (renderInline と同じ文法): code span(`...`) / link [t](u) / autolink<u> / bare URL / text。
//   code と URL(リンク url 部・autolink・bare) は置換対象外として分離する (Codex#4: URL/コード破壊回避)。
function tokenizeInlineForRedact(s) {
  const toks = [];
  let i = 0, buf = '';
  const flush = () => { if (buf) { toks.push({ t: 'text', v: buf }); buf = ''; } };
  while (i < s.length) {
    const c = s[i];
    if (c === '`') { // code span
      const end = s.indexOf('`', i + 1);
      if (end !== -1) { flush(); toks.push({ t: 'keep', v: s.slice(i, end + 1) }); i = end + 1; continue; }
    }
    if (c === '[') { // link [text](url)
      const close = s.indexOf(']', i + 1);
      if (close !== -1 && s[close + 1] === '(') {
        const paren = s.indexOf(')', close + 2);
        if (paren !== -1) { flush(); toks.push({ t: 'link', text: s.slice(i + 1, close), url: s.slice(close + 2, paren) }); i = paren + 1; continue; }
      }
    }
    if (c === '<') { // autolink <url>
      const gt = s.indexOf('>', i + 1);
      if (gt !== -1 && /^<https?:\/\/[^>]+>$/.test(s.slice(i, gt + 1))) { flush(); toks.push({ t: 'keep', v: s.slice(i, gt + 1) }); i = gt + 1; continue; }
    }
    if ((c === 'h' || c === 'H') && /^https?:\/\//i.test(s.slice(i))) { // bare URL
      const m = s.slice(i).match(/^https?:\/\/\S+/i);
      if (m) { flush(); toks.push({ t: 'keep', v: m[0] }); i += m[0].length; continue; }
    }
    buf += c; i++;
  }
  flush();
  return toks;
}

// テキストノード内の alias を最長一致優先で置換し、実置換数を report に積む。
function replaceAliasesInText(text, sortedAliases, aliasRepl, report) {
  let out = text;
  for (const a of sortedAliases) {
    if (!a || out.indexOf(a) === -1) continue;
    const parts = out.split(a);
    const n = parts.length - 1;
    out = parts.join(aliasRepl.get(a));
    if (report) report.replaced[a] = (report.replaced[a] || 0) + n;
  }
  return out;
}

// MD → 匿名版 MD。frontmatter の hover: ブロックと本文を node 種別で処理する。
function redactApply(md, cfg) {
  const report = { replaced: {}, droppedHover: 0, delinked: 0 };
  const aliasRepl = new Map();
  const dropHoverAliases = [];
  for (const e of cfg.entries) {
    for (const a of e.aliases) aliasRepl.set(a, e.replacement);
    if (e.drop_hover) dropHoverAliases.push(...e.aliases);
  }
  const sortedAliases = Array.from(aliasRepl.keys()).sort((x, y) => y.length - x.length); // 最長一致優先
  const urlHasDropAlias = (url) => dropHoverAliases.some((a) => a && url.includes(a));

  const lines = md.split(/\r?\n/);
  let fmEnd = -1;
  if (lines[0] === '---') {
    for (let i = 1; i < lines.length; i++) { if (lines[i].trim() === '---') { fmEnd = i; break; } }
  }
  const out = [];
  let inHover = false;
  let inFence = false, fenceCh = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // ---- frontmatter ----
    if (fmEnd !== -1 && i <= fmEnd) {
      if (i === 0 || i === fmEnd) { out.push(line); continue; }
      if (/^hover:\s*$/.test(line)) { inHover = true; out.push(line); continue; }
      if (inHover) {
        if (!/^\s+\S/.test(line)) { inHover = false; out.push(line); continue; }
        const cm = line.match(/^(\s+-\s+)([^|]*?)\s*\|\|\s*(.*)$/);
        if (cm) {
          const key = cm[2].trim();      // 識別子(URL)
          const summary = cm[3];
          if (dropHoverAliases.some((a) => a && (key.includes(a) || summary.includes(a)))) { report.droppedHover++; continue; }
          out.push(cm[1] + key + ' || ' + replaceAliasesInText(summary, sortedAliases, aliasRepl, report));
          continue;
        }
        out.push(line); continue;
      }
      out.push(line); continue; // 他 frontmatter キーは値を触らない (leak-check が捕捉)
    }
    // ---- body ----
    const fmark = line.match(/^(\s*)(```+|~~~+)/);
    if (fmark) {
      if (!inFence) { inFence = true; fenceCh = fmark[2][0]; }
      else if (fmark[2][0] === fenceCh) { inFence = false; fenceCh = ''; }
      out.push(line); continue;
    }
    if (inFence) { out.push(line); continue; }
    const toks = tokenizeInlineForRedact(line);
    let rebuilt = '';
    for (const tk of toks) {
      if (tk.t === 'text') rebuilt += replaceAliasesInText(tk.v, sortedAliases, aliasRepl, report);
      else if (tk.t === 'keep') rebuilt += tk.v;
      else if (tk.t === 'link') {
        if (urlHasDropAlias(tk.url)) { report.delinked++; rebuilt += replaceAliasesInText(tk.text, sortedAliases, aliasRepl, report); }
        else rebuilt += '[' + replaceAliasesInText(tk.text, sortedAliases, aliasRepl, report) + '](' + tk.url + ')';
      }
    }
    out.push(rebuilt);
  }
  return { out: out.join('\n'), report };
}

// 漏えい検査 (file ベースでなく {name, content} で受け selftest を純粋化)。
function leakCheckContents(items, cfg) {
  const aliasNeedles = [];
  for (const e of cfg.entries) {
    for (const a of e.aliases) aliasNeedles.push({ id: e.id, term: a, norm: normForLeak(a) });
    if (Array.isArray(e.leak_terms)) for (const t of e.leak_terms) aliasNeedles.push({ id: e.id, term: t, norm: normForLeak(t) });
  }
  const headingNeedles = (cfg.forbidden_headings || []).map((h) => ({ term: h, norm: normForLeak(h) }));
  const violations = [];
  const warnings = [];
  for (const it of items) {
    const base = it.name;
    const isMd = /\.md$/i.test(base);
    const nameNorm = normForLeak(base);
    for (const n of aliasNeedles) if (n.norm && nameNorm.includes(n.norm)) violations.push({ file: base, kind: 'alias(filename)', id: n.id, term: n.term });
    const raw = it.content;
    const whole = normForLeak(raw); // 全面 (本文/属性/data/meta/url …)
    for (const n of aliasNeedles) if (n.norm && whole.includes(n.norm)) violations.push({ file: base, kind: 'alias', id: n.id, term: n.term });
    // forbidden_headings: 見出し文脈のみ (散文 FP 回避)
    const headingTexts = [];
    if (isMd) raw.split(/\r?\n/).forEach((ln) => { const m = ln.match(/^#{1,6}\s+(.*)$/); if (m) headingTexts.push(m[1]); });
    else { const re = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi; let m; while ((m = re.exec(raw))) headingTexts.push(m[1].replace(/<[^>]+>/g, '')); }
    const headNorm = headingTexts.map(normForLeak);
    for (const h of headingNeedles) if (h.norm && headNorm.some((ht) => ht.includes(h.norm))) violations.push({ file: base, kind: 'forbidden_heading', term: h.term });
    // 金額 mention は WARN のみ (正当な金額表記=売上/予算/支援額 等で FP しブロックしないため: Codex#7)
    const money = raw.match(/[0-9０-９]+\s*(?:億|万)\s*円?/g);
    if (money) warnings.push({ file: base, kind: 'money_mention', samples: Array.from(new Set(money)).slice(0, 12) });
  }
  return { ok: violations.length === 0, violations, warnings };
}

// positive(匿名版 PASS) + negative(alias/コード内/見出し/原文 で必ず落ちる) selftest。
function selftestRedact() {
  let ok = true;
  const fail = (msg) => { ok = false; console.error('[SELFTEST FAIL] redact: ' + msg); };
  const cfg = validateRedactConfig({ version: 1, entries: [{ id: 'org', class: 'explicit', aliases: ['アクメ社', 'アクメ'], replacement: '某社', drop_hover: true }], forbidden_headings: ['機微情報'] });

  // positive: alias を text/link/hover のみに持つ → 完全匿名化 → leak PASS
  const clean = '---\nhover:\n  - https://ja.wikipedia.org/wiki/アクメ社 || アクメ社の説明。\n  - https://example.com/x || 無関係。\n---\n\n# T\n\n## 概要\n\n- **[アクメ社](https://ja.wikipedia.org/wiki/アクメ社)**の社員。一般に アクメ社 と呼ぶ。\n';
  const r1 = redactApply(clean, cfg);
  if (r1.report.droppedHover !== 1) fail('positive droppedHover=1 のはず: ' + r1.report.droppedHover);
  if (r1.report.delinked !== 1) fail('positive delinked=1 のはず: ' + r1.report.delinked);
  if (!/\*\*某社\*\*の社員/.test(r1.out)) fail('positive delink 置換失敗');
  if (/アクメ/.test(r1.out)) fail('positive alias 残存: ' + r1.out);
  const lc1 = leakCheckContents([{ name: 'clean.md', content: r1.out }], cfg);
  if (!lc1.ok) fail('positive leak PASS のはず: ' + JSON.stringify(lc1.violations));

  // negative1: 原文(alias 残) → leak FAIL
  if (leakCheckContents([{ name: 'dirty.md', content: clean }], cfg).ok) fail('negative 原文は FAIL のはず');
  // negative2: code span 内 alias は redact-apply が触らない → leak が捕捉
  const r3 = redactApply('---\n---\n\n# T\n\nコード `アクメ社API` を参照。\n', cfg);
  if (!/`アクメ社API`/.test(r3.out)) fail('negative code span 不変のはず: ' + r3.out);
  if (leakCheckContents([{ name: 'code.md', content: r3.out }], cfg).ok) fail('negative code 内 alias を捕捉のはず');
  // negative3: forbidden_heading 見出し → FAIL
  if (leakCheckContents([{ name: 'h.md', content: '# T\n\n## 機微情報\n\n秘密。\n' }], cfg).ok) fail('negative forbidden_heading 捕捉のはず');
  // negative4: ファイル名に alias → FAIL
  if (leakCheckContents([{ name: 'アクメ社_share.html', content: '<h1>x</h1>' }], cfg).ok) fail('negative filename alias 捕捉のはず');
  // negative5: 数値文字参照で隠した alias も捕捉 (検出器強化: アクメ=U+30A2/30AF/30E1)
  if (leakCheckContents([{ name: 'ent.html', content: '<p>&#x30A2;&#x30AF;&#x30E1;社</p>' }], cfg).ok) fail('negative 数値文字参照 alias を捕捉のはず');
  // negative6: JS \uXXXX で隠した alias も捕捉 ('\\u' はソース上のリテラル \u)
  if (leakCheckContents([{ name: 'js.html', content: '<script>var x="\\u30A2\\u30AF\\u30E1社"</script>' }], cfg).ok) fail('negative JS \\u alias を捕捉のはず');
  // negative7: percent×数値文字参照の入れ子 (%26%23x30A2%3B…) も不動点デコードで捕捉
  if (leakCheckContents([{ name: 'nest.html', content: '<p>%26%23x30A2%3B%26%23x30AF%3B%26%23x30E1%3B社</p>' }], cfg).ok) fail('negative 多重エンコード alias を捕捉のはず');
  // strict schema: 未知キー → throw
  let threw = false; try { validateRedactConfig({ version: 1, entries: [], bogus: 1 }); } catch (_) { threw = true; }
  if (!threw) fail('strict schema 未知キーで throw のはず');
  // config footgun: replacement が alias を含む → throw (再置換/漏えい防止)
  let threw2 = false; try { validateRedactConfig({ version: 1, entries: [{ id: 'x', aliases: ['社'], replacement: '某社' }] }); } catch (_) { threw2 = true; }
  if (!threw2) fail('config: replacement が alias を含むとき throw のはず');

  if (ok) console.error('[SELFTEST OK]   redact (positive + negative 9)');
  return ok;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === '--selftest') {
    process.exit(selftest() ? 0 : 1);
  }

  if (argv[0] === '--verify' || argv[0] === '--verify-html' || argv[0] === '--verify-md') {
    const inPath = argv[1];
    if (!inPath) {
      console.error('usage: md2html.cjs --verify <in.md>  (双方向: HTML⊆MD + MD⊆HTML)');
      process.exit(2);
    }
    const md = fs.readFileSync(inPath, 'utf8');
    const base = path.basename(inPath);
    const onlyHtml = argv[0] === '--verify-html';
    const onlyMd = argv[0] === '--verify-md';
    let bad = false;

    if (!onlyMd) {
      const f = verify(md); // HTML ⊆ MD (捏造防止)
      if (f.ok) {
        console.error('[VERIFY HTML⊆MD OK] ' + f.total + ' text nodes ⊆ MD : ' + base);
      } else {
        bad = true;
        console.error('[VERIFY HTML⊆MD FAIL] ' + f.violations.length + ' / ' + f.total + ' 捏造テキスト:');
        f.violations.slice(0, 30).forEach((v) => console.error('  ✗(捏造) ' + JSON.stringify(v)));
      }
    }
    if (!onlyHtml) {
      const b = verifyCompleteness(md); // MD ⊆ HTML (欠落防止)
      if (b.ok) {
        console.error('[VERIFY MD⊆HTML OK] ' + b.total + ' blocks 被覆 : ' + base);
      } else {
        bad = true;
        console.error('[VERIFY MD⊆HTML FAIL] ' + b.omissions.length + ' / ' + b.total + ' 欠落ブロック:');
        b.omissions.slice(0, 30).forEach((v) => console.error('  ✗(欠落) ' + JSON.stringify(v)));
      }
    }
    process.exit(bad ? 1 : 0);
  }

  if (argv[0] === '--lint') {
    const inPath = argv[1];
    if (!inPath) {
      console.error('usage: md2html.cjs --lint <in.md>');
      process.exit(2);
    }
    const md = fs.readFileSync(inPath, 'utf8');
    const r = lint(md);
    if (!r.isReport) {
      console.error('[LINT] 非報告書 (frontmatter 報告書型でない) — スキップ: ' + path.basename(inPath));
      process.exit(0);
    }
    if (r.warnings.length === 0) {
      console.error('[LINT OK] 必須マーカー充足: ' + path.basename(inPath));
    } else {
      console.error('[LINT WARN] ' + r.warnings.length + ' 件 (' + path.basename(inPath) + '):');
      r.warnings.forEach((w) => console.error('  ⚠ ' + w));
    }
    if (r.errors.length > 0) {
      console.error('[LINT ERROR] figures 宣言-実体検査 ' + r.errors.length + ' 件 (' + path.basename(inPath) + '):');
      r.errors.forEach((e) => console.error('  ✗ ' + e));
      process.exit(1); // figures 違反はブロック (新規報告書にのみ実行する運用 = 移行措置)
    }
    process.exit(0); // 警告のみ。ブロックしない
  }

  if (argv[0] === '--check') {
    const mdPath = argv[1];
    const htmlPath = argv[2];
    if (!mdPath || !htmlPath) {
      console.error('usage: md2html.cjs --check <in.md> <out.html>');
      process.exit(2);
    }
    const r = check(mdPath, htmlPath);
    if (r.ok) {
      console.error('[CHECK OK] HTML は最新: ' + path.basename(htmlPath));
      process.exit(0);
    }
    console.error('[CHECK STALE] ' + (r.reason || 'sha256 不一致') + ' : ' + path.basename(htmlPath));
    if (r.embedded) console.error('  embedded=' + r.embedded.slice(0, 12) + ' current=' + r.current.slice(0, 12));
    process.exit(1);
  }

  if (argv[0] === '--redact-apply') {
    const cfgPath = argv[1], inPath = argv[2], outPath = argv[3];
    if (!cfgPath || !inPath || !outPath) {
      console.error('usage: md2html.cjs --redact-apply <config.json> <in.md> <out.md>');
      process.exit(2);
    }
    const cfg = loadRedactConfig(cfgPath);
    const md = fs.readFileSync(inPath, 'utf8');
    const { out, report } = redactApply(md, cfg);
    const cfgSha = sha256(fs.readFileSync(cfgPath, 'utf8')).slice(0, 16);
    // DO NOT EDIT + 来歴を frontmatter 内の単独行 (キー扱い・renderには出ない) で付す。
    const stamp = 'generated_do_not_edit: redact-apply src=' + path.basename(inPath) + ' config-sha=' + cfgSha;
    let final;
    if (out.startsWith('---\n')) final = '---\n' + stamp + '\n' + out.slice(4);
    else if (out.startsWith('---\r\n')) final = '---\n' + stamp + '\n' + out.slice(5);
    else final = out; // frontmatter 無し文書はスタンプ省略
    fs.writeFileSync(outPath, final, 'utf8');
    const auditPath = outPath.replace(/\.md$/i, '') + '.redact-report.json';
    fs.writeFileSync(auditPath, JSON.stringify({ source: path.basename(inPath), configSha: cfgSha, report }, null, 2), 'utf8');
    console.error('[REDACT-APPLY] ' + path.basename(inPath) + ' → ' + path.basename(outPath) +
      ' | replaced=' + JSON.stringify(report.replaced) + ' droppedHover=' + report.droppedHover + ' delinked=' + report.delinked);
    process.exit(0);
  }

  if (argv[0] === '--leak-check') {
    const cfgPath = argv[1];
    const files = argv.slice(2);
    if (!cfgPath || files.length === 0) {
      console.error('usage: md2html.cjs --leak-check <config.json> <file...>');
      process.exit(2);
    }
    const cfg = loadRedactConfig(cfgPath);
    const items = files.map((f) => ({ name: path.basename(f), content: fs.readFileSync(f, 'utf8') }));
    const r = leakCheckContents(items, cfg);
    r.warnings.forEach((w) => console.error('[LEAK-CHECK WARN] ' + w.file + ' ' + w.kind + ': ' + (w.samples || []).join(' ')));
    if (r.ok) {
      console.error('[LEAK-CHECK OK] ' + files.length + ' files: alias / forbidden-heading 0 件 (正規化+デコード後 全面)');
      process.exit(0);
    }
    console.error('[LEAK-CHECK FAIL] ' + r.violations.length + ' 件:');
    r.violations.forEach((v) => console.error('  ✗ ' + v.file + ' [' + v.kind + '] ' + (v.id ? v.id + ':' : '') + v.term));
    process.exit(1);
  }

  // 既定: render
  const inPath = argv[0];
  const outPath = argv[1];
  if (!inPath) {
    console.error('usage: md2html.cjs <in.md> [out.html] | --verify | --lint | --selftest | --check');
    process.exit(2);
  }
  const md = fs.readFileSync(inPath, 'utf8');
  const html = render(md, path.basename(inPath));
  if (outPath) {
    fs.writeFileSync(outPath, html, 'utf8');
    console.error('[RENDER] ' + path.basename(inPath) + ' → ' + outPath + ' (' + html.length + ' bytes)');
  } else {
    process.stdout.write(html);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  render, verify, verifyCompleteness, verifyBidirectional, lint, selftest, check,
  sha256, tokenize, parseFrontmatter, extractTextNodes, buildCorpus, canon, normForMatch, collectPieces,
  validateRedactConfig, redactApply, leakCheckContents, normForLeak, selftestRedact,
};
