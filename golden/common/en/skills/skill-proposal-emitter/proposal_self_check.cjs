#!/usr/bin/env node
/**
 * proposal_self_check.cjs — deterministic self-check for emitted skill-proposal MDs.
 *
 * Verifies that a proposal MD emitted per SKILL.md (skill-proposal-emitter) will
 * NOT be flagged as a parse error by the CCPIT candidate browser. This is a
 * faithful mirror of the CCPIT parser contract (skillProposals.ts:
 * parseProposalMd / parseProposedFilesFromSection3 / validateAxes).
 * Section 3 may hold one code block (SKILL.md only) or "### <relative path>"
 * headings each followed by a code block (SKILL.md + companion files; CCPIT_069
 * addendum 01). Do not extend the hard checks beyond that
 * contract; a parity test in the CCPIT development repository keeps this file
 * and the canonical parser in sync (contract drift fails there, loudly).
 *
 * Usage:
 *   node proposal_self_check.cjs <proposal.md> [<more.md> ...]
 *
 * Output (stdout): a single JSON object
 *   {
 *     files: [{ file, ok, errors: [{ check, message }], warnings: [{ check, message }] }],
 *     summary: { total, clean, withErrors }
 *   }
 *
 * Exit codes:
 *   0 = every file is clean (warnings never block)
 *   1 = at least one file violates the parser contract (would be un-adoptable)
 *   2 = the check itself could not run (no arguments / unreadable file)
 *
 * errors   -> parseError in the candidate browser (adoption blocked)
 * warnings -> parses fine, but hurts state tracking (request_id / filename / created_at / status)
 */
'use strict'

const fs = require('fs')
const path = require('path')

// Score bounds of the evaluation axes. From the emitter SKILL.md §2 contract
// ("0-5"); identical to the canonical parser constants.
const AXIS_SCORE_MIN = 0
const AXIS_SCORE_MAX = 5

// Expected proposal filename: <YYYYMMDD_HHMM>_<request-id>.md (SKILL.md §2-1;
// request-id is a short kebab-case id). Violations are warnings, never errors.
const FILENAME_RE = /^\d{8}_\d{4}_[a-z0-9][a-z0-9-]*\.md$/
// Length of the '<YYYYMMDD_HHMM>_' prefix in a well-formed proposal file name.
const FILENAME_ID_START = 'YYYYMMDD_HHMM_'.length

// --- canonical-parser mirror (keep 1:1 with skillProposals.ts) ---

function parseFlatFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!m) return null
  const data = {}
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
    if (!kv) continue
    let v = kv[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    data[kv[1]] = v
  }
  return { data, body: m[2] }
}

// Mirrors matchFenceOpen: a line is a fence open (CommonMark: 0-3 leading spaces,
// ``` or ~~~, 3+ chars; a backtick fence's info string may not contain a backtick).
// Returns {char, len, indent, info} or null. Shared by maskFencedCodeBlocks and
// readSection3FencedBlock (069 order 1: one boundary-matching implementation).
function matchFenceOpen(content) {
  const open = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(content)
  if (!open) return null
  if (open[2][0] === '`' && open[3].includes('`')) return null
  return { char: open[2][0], len: open[2].length, indent: open[1].length, info: open[3].trim() }
}

// Mirrors isFenceClose: a line closes `fence` when it is the same char, at least
// as many repeats as the opener, with only trailing whitespace after.
function isFenceClose(content, fence) {
  const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(content)
  return !!close && close[1][0] === fence.char && close[1].length >= fence.len
}

// Mirrors maskFencedCodeBlocks: blanks out fenced code blocks (``` or ~~~, 3+ chars,
// up to 3 leading spaces; closed by the same char with at least the opening count;
// unclosed runs to the end) including the fence lines, keeping line breaks and
// positions. Headings are searched on this string; headings inside code blocks
// (e.g. a SKILL.md embedded in "## 3." or a format example) are not headings.
function maskFencedCodeBlocks(text) {
  const lines = text.split('\n')
  let fence = null
  const out = []
  for (const line of lines) {
    const cr = line.endsWith('\r') ? '\r' : ''
    const content = cr ? line.slice(0, -1) : line
    const blank = ' '.repeat(content.length) + cr
    if (!fence) {
      const open = matchFenceOpen(content)
      if (open) {
        fence = open
        out.push(blank)
        continue
      }
      out.push(line)
      continue
    }
    out.push(blank)
    if (isFenceClose(content, fence)) {
      fence = null
    }
  }
  return out.join('\n')
}

function sliceSection(body, n) {
  const re = new RegExp(
    '(?:^|\\n)##\\s*' + n + '\\.[^\\n]*\\r?\\n([\\s\\S]*?)(?=\\n##\\s*\\d+\\.|$)'
  )
  const m = re.exec(maskFencedCodeBlocks(body))
  if (!m) return null
  const start = m.index + m[0].length - m[1].length
  return body.slice(start, start + m[1].length)
}

function parseListKv(section) {
  const raw = []
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s*([^:：]+)[:：]\s*(.*)$/)
    if (m) raw.push({ key: m[1].trim(), value: m[2].trim() })
  }
  return raw
}

// Mirrors parseAxisValue: accepts a bold score ("**4** — ...") as the canonical parser does
function parseAxisValue(value) {
  const m = value.match(/^\s*[*_]{0,2}\s*(\d+)([*_]{0,2})\s*(?:[—\-–]\s*)?(.*)$/)
  if (!m) return { score: null, rationale: value.trim() }
  return { score: Number(m[1]), rationale: m[3].trim() }
}

// Mirrors normalizeAxisKey / CANONICAL_AXIS_NAMES / getCanonicalAxisName: only the fixed
// five axes (ja / en) are axes. Other "- key: value" lines in "## 2." (notes, nested
// bullets) are skipped, as in the canonical parser.
function normalizeAxisKey(key) {
  return key
    .replace(/^[\s*_]+|[\s*_]+$/g, '')
    .replace(/\s+/gu, '')
    .toLowerCase()
}
const CANONICAL_AXIS_NAMES = [
  '再現性',
  '汎用性',
  'Context節約効果',
  '既存Skill重複・統一可能性',
  '本質的UX向上への寄与',
  'Reproducibility',
  'Generality',
  'ContextSaving',
  'OverlapWithExisting',
  'EssentialUXGain'
]
const CANONICAL_AXIS_MAP = new Map(CANONICAL_AXIS_NAMES.map((name) => [normalizeAxisKey(name), name]))
function getCanonicalAxisName(key) {
  return CANONICAL_AXIS_MAP.get(normalizeAxisKey(key)) ?? null
}

function isPlaceholder(rationale) {
  const v = rationale.trim()
  return /FILL/i.test(v) || /^<.*>$/.test(v)
}

// Same predicate set as the canonical validateAxes, but reports every
// violation instead of only the first one (faster fix loops; the clean/error
// verdict is identical either way).
function collectAxisErrors(axes) {
  const errors = []
  if (axes.length === 0) {
    errors.push({
      check: 'axes_empty',
      message: 'evaluation axes are empty (section "## 2." has no "- axis: score — rationale" lines)'
    })
    return errors
  }
  for (const a of axes) {
    if (a.score === null) {
      errors.push({
        check: 'axis_score_missing',
        message: `axis '${a.axis}': score is empty or not a number`
      })
    } else if (a.score < AXIS_SCORE_MIN || a.score > AXIS_SCORE_MAX) {
      errors.push({
        check: 'axis_score_out_of_range',
        message: `axis '${a.axis}': score out of range (${AXIS_SCORE_MIN}-${AXIS_SCORE_MAX})`
      })
    }
    if (a.rationale.trim() === '' || isPlaceholder(a.rationale)) {
      errors.push({
        check: 'axis_rationale_placeholder',
        message: `axis '${a.axis}': rationale is empty or a placeholder (FILL / <...>)`
      })
    }
  }
  return errors
}

// Per-file size limit of Section 3 files; identical to the canonical parser.
const SECTION3_FILE_MAX_BYTES = 10 * 1024 * 1024

function isBakFileName(fileName) {
  return /\.(bak(\..*)?|old|orig|tmp|swp)$/i.test(fileName) || /~$/.test(fileName) || /\.bak[._-]/i.test(fileName)
}

function isOsVcsArtifactName(fileName) {
  const lower = fileName.toLowerCase()
  return lower === '.ds_store' || lower === 'thumbs.db' || lower === '.git' || lower === 'node_modules'
}

// Mirrors hasFileSectionHeading: "## 3." (outside code blocks) is in the multi-file form
// when it has a ### heading shaped like a relative path: no whitespace, and either
// containing / or \ or ending with an extension that has a letter (SKILL.md,
// scripts/helper.cjs, scripts/install). Mistyped ones (./SKILL.md, skill.md, a companion
// heading without a SKILL.md heading) also take the multi-file path and fail loudly
// instead of being read as single-file. Other ### headings (3-B. notes, r2 changes, v1.2,
// 3-B.notes) are sub-headings of the single-file form, even when a code block follows.
function hasFileSectionHeading(masked) {
  const re = /(?:^|\r?\n)###[ \t]+([^\r\n]+)\r?\n/gm
  let m
  while ((m = re.exec(masked))) {
    const name = m[1].normalize('NFC').trim()
    if (/\s/.test(name)) continue
    if (/[\\/]/.test(name) || /\.[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*$/.test(name)) return true
  }
  return false
}

// Mirrors readSection3FencedBlock: reads one "## 3." fenced block with the parser's
// content contract (join lines with \n, no trailing \n; strip the opener's indent
// from each line) instead of maskFencedCodeBlocks'/extractFencedCodeBlocks' own
// trailing-\n contract, which those keep for their other callers (069 order 1
// plan review [1][2][3]: keep boundary matching in matchFenceOpen/isFenceClose,
// but do not reuse mask/extract's content-joining convention here).
//
// anchored=true (right after a "### <path>" heading): skip whitespace/tab-only
// lines, then the first non-blank line must be the fence open (the existing "a
// heading's immediate content is blank lines then a fence" contract, kept inside
// this helper so callers do not also need to strip the prefix). anchored=false
// (single-file form): skip lines until a fence open is found (same looseness as
// before). Recognizing an open-fence line advances straight to the next line; the
// same line is never re-tested as a close (Codex plan review finding [2]).
function readSection3FencedBlock(text, anchored) {
  const lines = text.split('\n')
  const noCr = (raw) => (raw.endsWith('\r') ? raw.slice(0, -1) : raw)
  let fence = null
  const inner = []
  let i = 0
  if (anchored) {
    while (i < lines.length && /^[ \t]*$/.test(noCr(lines[i]))) i++
    if (i >= lines.length) return null
    fence = matchFenceOpen(noCr(lines[i]))
    if (!fence) return null
    i++
  }
  for (; i < lines.length; i++) {
    const content = noCr(lines[i])
    if (!fence) {
      fence = matchFenceOpen(content)
      continue
    }
    if (isFenceClose(content, fence)) {
      const consumedLength = lines.slice(0, i + 1).join('\n').length + (i + 1 < lines.length ? 1 : 0)
      return { info: fence.info, content: inner.join('\n'), closed: true, consumedLength }
    }
    inner.push(lines[i].replace(new RegExp(`^ {0,${fence.indent}}`), ''))
  }
  if (!fence) return null
  return { info: fence.info, content: inner.join('\n'), closed: false, consumedLength: text.length }
}

// Mirrors parseProposedFilesFromSection3: returns the first contract violation
// (message) or null. A body without "## 3." is not an error (same as the parser).
function section3Error(body) {
  // Headings are searched outside fenced code blocks only (maskFencedCodeBlocks)
  const masked = maskFencedCodeBlocks(body)
  const sec3Match = /(?:^|\n)##\s*3\.[^\n]*\r?\n/.exec(masked)
  if (!sec3Match) return null
  const afterSec3Start = sec3Match.index + sec3Match[0].length
  const afterSec3 = body.slice(afterSec3Start)
  const maskedAfterSec3 = masked.slice(afterSec3Start)
  // Multi-file form is decided by the ### headings within "## 3." (up to the next "## <n>.")
  const sec3EndM = /(?:^|\r?\n)##\s*[0-9]+\./.exec(maskedAfterSec3)
  const sec3Len = sec3EndM ? sec3EndM.index : maskedAfterSec3.length
  const hasSubHeadings = hasFileSectionHeading(maskedAfterSec3.slice(0, sec3Len))

  if (!hasSubHeadings) {
    // Single SKILL.md (legacy form)
    const block = readSection3FencedBlock(afterSec3, false)
    if (!block) return 'no code block in section "## 3."'
    if (!block.closed) return 'no closing code fence in section "## 3."'
    return null
  }

  // Multi-file form: "### <relative path>" + code block, repeated
  const seenPathsLower = new Set()
  let hasSkillMd = false
  let pos = 0
  const len = afterSec3.length
  while (pos < len) {
    const headingRe = /(?:^|\r?\n)###[ \t]+([^\r\n]+)\r?\n/gm
    headingRe.lastIndex = pos
    const hMatch = headingRe.exec(maskedAfterSec3)
    if (!hMatch) break
    const intervening = maskedAfterSec3.slice(pos, hMatch.index)
    if (/(?:^|\r?\n)##\s*[0-9]+\./m.test(intervening)) break

    const rawPath = hMatch[1]
    const headingEnd = hMatch.index + hMatch[0].length
    const block = readSection3FencedBlock(afterSec3.slice(headingEnd), true)
    if (!block) return `heading '### ${rawPath}' is not followed by a code block`
    if (!block.closed) return `code block under '### ${rawPath}' has no closing fence`
    const content = block.content
    pos = headingEnd + block.consumedLength

    const relPath = rawPath.normalize('NFC').trim()
    if (!relPath) return 'empty file path heading'
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(relPath)) return `'..' is not allowed: ${relPath}`
    if (path.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath) || /^[\\/]/.test(relPath) || /^\\\\/.test(relPath)) {
      return `absolute / drive / UNC path is not allowed: ${relPath}`
    }
    if (/[. \t]$/.test(relPath)) return `trailing dot or space is not allowed: ${relPath}`
    for (const seg of relPath.replace(/\\/g, '/').split('/')) {
      if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(seg)) return `Windows reserved name: ${relPath}`
      if (isBakFileName(seg) || isOsVcsArtifactName(seg)) return `excluded file or directory (backup / OS / VCS): ${relPath}`
    }
    const lower = relPath.toLowerCase()
    if (seenPathsLower.has(lower)) return `paths collide ignoring case: ${relPath}`
    seenPathsLower.add(lower)
    const byteLen = Buffer.byteLength(content, 'utf-8')
    if (byteLen > SECTION3_FILE_MAX_BYTES) return `file exceeds 10MB: ${relPath} (${byteLen} bytes)`
    if (relPath === 'SKILL.md') hasSkillMd = true
  }
  if (!hasSkillMd) return 'multi-file section "## 3." must include "### SKILL.md"'
  return null
}

function collectWarnings(fm, fileName) {
  const warnings = []
  const nameIsWellFormed = FILENAME_RE.test(fileName)
  if (!nameIsWellFormed) {
    warnings.push({
      check: 'filename_pattern',
      message: `file name '${fileName}' does not match <YYYYMMDD_HHMM>_<request-id>.md`
    })
  }
  if (!fm) return warnings
  const requestId = (fm.data.request_id ?? '').trim()
  if (!requestId) {
    warnings.push({
      check: 'request_id_missing',
      message: 'request_id is missing or empty (state tracking keys on it)'
    })
  } else if (nameIsWellFormed) {
    const idInName = fileName.slice(FILENAME_ID_START, -'.md'.length)
    if (idInName !== requestId) {
      warnings.push({
        check: 'request_id_filename_mismatch',
        message: `request_id '${requestId}' does not match the id in the file name ('${idInName}')`
      })
    }
  }
  if (!(fm.data.created_at ?? '').trim()) {
    warnings.push({ check: 'created_at_missing', message: 'created_at is missing or empty' })
  }
  if (!(fm.data.status ?? '').trim()) {
    warnings.push({ check: 'status_missing', message: 'status is missing or empty' })
  }
  return warnings
}

// Mirrors the parseError decision chain of the canonical parseProposalMd:
// frontmatter -> kind -> target -> (adoption_label: reject skips axes) -> axis gate.
function checkContent(raw, fileName) {
  const fm = parseFlatFrontmatter(raw)
  const errors = []
  if (!fm) {
    errors.push({
      check: 'frontmatter_missing',
      message: 'frontmatter not found (file must start with a flat "key: value" block between --- lines)'
    })
    return { errors, warnings: collectWarnings(null, fileName) }
  }
  if (fm.data.kind !== 'skill') {
    errors.push({
      check: 'kind_mismatch',
      message: `kind is '${fm.data.kind ?? '(none)'}', expected 'skill'`
    })
  }
  const target = fm.data.target ?? ''
  if (!target) {
    errors.push({ check: 'target_missing', message: 'target is missing (adoption destination path)' })
  }
  // Section 3 (the finished files) is checked before the axis gate, as in the parser
  const sec3Err = section3Error(fm.body)
  if (sec3Err) {
    errors.push({ check: 'section3_files', message: sec3Err })
  }
  // adoption_label: reject = no candidate; the axis gate is skipped by contract
  // (never force fake scores). kind/target are still enforced above.
  const isNoCandidate = fm.data.adoption_label === 'reject'
  if (!isNoCandidate) {
    const sec2 = sliceSection(fm.body, 2)
    const axes = []
    if (sec2) {
      for (const it of parseListKv(sec2)) {
        const canonicalName = getCanonicalAxisName(it.key)
        if (!canonicalName) continue
        const { score, rationale } = parseAxisValue(it.value)
        axes.push({ axis: canonicalName, score, rationale })
      }
    }
    errors.push(...collectAxisErrors(axes))
  }
  return { errors, warnings: collectWarnings(fm, fileName) }
}

function main(argv) {
  const args = argv.slice(2)
  if (args.length === 0) {
    process.stdout.write(
      JSON.stringify(
        { fatal: 'usage: node proposal_self_check.cjs <proposal.md> [<more.md> ...]' },
        null,
        2
      ) + '\n'
    )
    return 2
  }
  const files = []
  let fatal = false
  for (const arg of args) {
    const fp = path.resolve(arg)
    let raw
    try {
      raw = fs.readFileSync(fp, 'utf-8')
    } catch (err) {
      fatal = true
      files.push({
        file: fp,
        ok: false,
        fatal: `cannot read file: ${err && err.message ? err.message : String(err)}`,
        errors: [],
        warnings: []
      })
      continue
    }
    // The parser decodes strictly and refuses invalid UTF-8
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(fp))
    } catch (err) {
      files.push({
        file: fp,
        ok: false,
        errors: [{ check: 'utf8_invalid', message: 'file is not valid UTF-8' }],
        warnings: []
      })
      continue
    }
    const { errors, warnings } = checkContent(raw, path.basename(fp))
    files.push({ file: fp, ok: errors.length === 0, errors, warnings })
  }
  const withErrors = files.filter((f) => !f.ok).length
  const out = {
    files,
    summary: { total: files.length, clean: files.length - withErrors, withErrors }
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  if (fatal) return 2
  return withErrors > 0 ? 1 : 0
}

process.exit(main(process.argv))
