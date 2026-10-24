#!/usr/bin/env node
/*
 * report-gate.test.cjs — 検出核 report-detect.cjs の fixture テスト
 *   実行: node report-gate.test.cjs
 *
 * 方針:
 *   - 本番と同じ検出核を require する（判定ロジックを分岐させない）
 *   - git は呼ばない。`git status --porcelain -z` の**実採取**に基づく文字列を注入する
 *   - 主張は両側で固定する（A のとき block する／A でないとき block しない）
 */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const D = require('./report-detect.cjs')

const NUL = String.fromCharCode(0)
const T8 = '20260808'
const T6 = '260808'
const TODAY = { today8: T8, today6: T6 }

/** 既定 fixture 内容。AC-2 md-header ゲート（T40〜）の充足行を含む——各テストは自分の主張だけを
 *  固定し、ヘッダ欠落の主張は T41 側で行う（2026-08-11） */
const DEFAULT_MD = '---\naudience: テスト\n準拠Skill: テスト固定\n---\nx\n'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-test-'))
let pass = 0
let fail = 0
const failures = []

function t(name, fn) {
  try {
    fn()
    pass++
  } catch (e) {
    fail++
    failures.push(`${name}: ${e.message}`)
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed')
}

let seq = 0
/** 使い捨てのリポジトリ風ディレクトリを作る */
function mkRoot(opts) {
  const o = opts || {}
  const root = path.join(tmp, 'r' + ++seq)
  fs.mkdirSync(path.join(root, '_Prompt'), { recursive: true })
  if (o.git === 'file') fs.writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere\n', 'utf8')
  else if (o.git !== false) fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  if (o.vault) {
    fs.mkdirSync(path.join(root, 'CORE'), { recursive: true })
    fs.writeFileSync(path.join(root, 'CORE', 'PROTOCOL.md'), '# protocol\n', 'utf8')
  }
  // F1（2026-09-29 CCPIT_075）は変更検出を「git の変更 ∩ 帰属」に絞る。DIRTY 定数（既定の
  // changesRaw）が指す 'src/changed.ts' を実ファイルとして置く（既定は無効化しない限り常に作る）。
  // mtime は SESSION_START 直後に固定する（実行時の実時刻に依存すると、SESSION_START より前の
  // 時計で走る環境で意味が変わってしまう。Codex 実装レビュー指摘 [3]）。F1 自体の絞り込みを
  // 検証する新規テスト（T-new 系）は個別に changesRaw／実ファイルを明示的に用意する。
  if (o.dirty !== false) {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    const dirtyFile = path.join(root, 'src', 'changed.ts')
    fs.writeFileSync(dirtyFile, 'x', 'utf8')
    const s = (SESSION_START + 1000) / 1000
    fs.utimesSync(dirtyFile, s, s)
  }
  return root
}
function mk(root, rel, content) {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content === undefined ? DEFAULT_MD : content, 'utf8')
  return p
}
function setMtime(p, ms) {
  const s = ms / 1000
  fs.utimesSync(p, s, s)
}
/** porcelain -z 文字列を組む。rename は [ "R  new", "orig" ] の 2 フィールド */
function pz(...fields) {
  return fields.join(NUL) + NUL
}

const NOW = Date.parse('2026-08-08T12:00:00Z')
const SESSION_START = NOW - 60 * 60 * 1000 // 1 時間前
const BEFORE_SESSION = SESSION_START - 60 * 60 * 1000
const DIRTY = pz('?? src/changed.ts')

/** 既定は「transcript 解決を絶対に走らせない」形にする（テストの独立性） */
function base(extra) {
  return Object.assign(
    {
      changesRaw: DIRTY,
      transcript: null,
      sessionId: null,
      owned: [],
      sessionStartMs: SESSION_START,
      nowMs: NOW
    },
    TODAY,
    extra
  )
}

// ============================================================ 変更検出 / 除外

t('T7 clean_tree_passes', () => {
  const p = mkRoot()
  const r = D.check(base({ projectDir: p, changesRaw: '' }))
  assert(r.block === false, 'clean tree must pass')
  assert(r.why === 'no-changes')
})

t('T13 bak_and_local_config_excluded (混在なら block 側は生きる)', () => {
  const p = mkRoot()
  // F1 の帰属絞り込み対象になるので、'real.ts' は実ファイルとして置く（mtime 帰属。§mkRoot 参照）。
  // mtime は SESSION_START 直後に固定する（実行時刻依存を避ける。実装レビュー r2 指摘）。
  const realTs = path.join(p, 'real.ts')
  fs.writeFileSync(realTs, 'x', 'utf8')
  setMtime(realTs, SESSION_START + 1000)
  const r = D.check(base({ projectDir: p, changesRaw: pz('?? a.bak', '?? CLAUDE.local.md', '?? real.ts') }))
  assert(r.block === true, 'real change must still be detected')
})

t('T22 only_bak_dirty_passes', () => {
  const p = mkRoot()
  const r = D.check(
    base({
      projectDir: p,
      changesRaw: pz('?? a.bak', ' M dir/b.bak', '?? CLAUDE.local.md', '?? sub/CLAUDE.local.md')
    })
  )
  assert(r.block === false, 'only-excluded dirty must pass')
  assert(r.why === 'no-changes')
})

t('T14 porcelain_z_parses_nonascii_paths', () => {
  const e = D.parsePorcelainZ(pz('?? _Prompt/02_buildai/報告書メモ.md'))
  assert(e.length === 1, 'one entry')
  assert(e[0].paths[0] === '_Prompt/02_buildai/報告書メモ.md', 'path intact: ' + e[0].paths[0])
})

t('T21b rename_orig_field_is_bare_path_not_prefixed', () => {
  const e = D.parsePorcelainZ(pz('R  _Prompt/02_buildai/新・報告書メモ.md', '_Prompt/02_buildai/旧・報告書メモ.md'))
  assert(e.length === 1, 'rename is ONE entry, got ' + e.length)
  assert(e[0].paths[0] === '_Prompt/02_buildai/新・報告書メモ.md', 'new path')
  // 旧パスは status 接頭辞を持たない裸のパス（3 文字剥がすと壊れる）
  assert(e[0].paths[1] === '_Prompt/02_buildai/旧・報告書メモ.md', 'orig path must be bare: ' + e[0].paths[1])
})

t('T21 rename_entry_nonascii_both_paths_excluded', () => {
  const e = D.parsePorcelainZ(pz('R  新しい名前.md', '設定バックアップ.bak'))
  assert(D.isExcludedEntry(e[0]) === true, 'either side matching .bak excludes the entry')
  const e2 = D.parsePorcelainZ(pz('R  新しい名前.md', '古い名前.md'))
  assert(D.isExcludedEntry(e2[0]) === false, 'normal rename is not excluded')
})

t('T33 worktree_side_rename_consumes_orig_field【実装レビュー[1]】', () => {
  // XY の 2 文字目が R/C のケース（worktree 側 rename）。片側しか見ないと旧パスが
  // 独立エントリに化け、旧実装なら除外されていた変更が残って**新だけ block**になる。
  for (const xy of ['R ', ' R', 'RM', ' C', 'C ']) {
    const e = D.parsePorcelainZ(pz(`${xy} new.md`, 'old.bak'))
    assert(e.length === 1, `${JSON.stringify(xy)}: must be ONE entry, got ${e.length}`)
    assert(e[0].paths.length === 2, `${JSON.stringify(xy)}: orig path must be consumed`)
    assert(D.isExcludedEntry(e[0]) === true, `${JSON.stringify(xy)}: .bak on either side must exclude`)
  }
})

t('T33b worktree_rename_only_bak_dirty_passes (I1: 旧が pass なら新も pass)', () => {
  const p = mkRoot()
  const r = D.check(base({ projectDir: p, changesRaw: pz(' R new.md', 'old.bak') }))
  assert(r.block === false, 'rename whose orig side is .bak must be excluded → pass')
})

t('T34 same_file_different_spelling_normalizes_equal【実装レビュー】', () => {
  // FS に正解を答えさせる方式。同一の実在ファイルは、綴り（大小・区切り）が違っても一致すること。
  const p = mkRoot()
  const f = mk(p, 'dir/file.md')
  const variants = [f, f.replace(/\\/g, '/'), path.join(p, 'dir', '..', 'dir', 'file.md')]
  const base0 = D.normPath(f)
  for (const v of variants) {
    assert(D.normPath(v) === base0, `same file must normalize equal: ${v}`)
  }
})

t('T34b distinct_existing_files_never_normalize_equal', () => {
  // 別実体は絶対に一致させない（case-sensitive FS で大小違いの別リポを同一視しないことを含む）。
  const p = mkRoot()
  const a = mk(p, 'dir/one.md')
  const b = mk(p, 'dir/two.md')
  assert(D.normPath(a) !== D.normPath(b), 'distinct files must stay distinct')
})

t('T34c nonexistent_path_falls_back_without_throwing', () => {
  const r = D.normPath(path.join(tmp, 'no-such-dir-' + ++seq, 'x.md'))
  assert(typeof r === 'string' && r.length > 0, 'must fall back to a resolved path')
  assert(path.isAbsolute(r), 'fallback must be absolute')
})

t('T21c untracked_directory_entry_handled', () => {
  const p = mkRoot()
  // 実ディレクトリとして置く（F1 の帰属絞り込みは stat 可能なパスを要求する。§mkRoot 参照）。
  // mtime は SESSION_START 直後に固定する（実行時刻依存を避ける。実装レビュー r2 指摘）。
  const dirtyDir = path.join(p, '_Prompt', '02_buildai', '20260808_案件')
  fs.mkdirSync(dirtyDir, { recursive: true })
  setMtime(dirtyDir, SESSION_START + 1000)
  const r = D.check(base({ projectDir: p, changesRaw: pz('?? _Prompt/02_buildai/20260808_案件/') }))
  assert(r.block === true, 'collapsed untracked dir counts as a change')
})

// ============================================================ 報告書探索（同一リポ）

t('T2 no_report_anywhere_blocks【検出力の非退行】', () => {
  const p = mkRoot()
  const r = D.check(base({ projectDir: p }))
  assert(r.block === true, 'must block when no report exists')
  assert(r.kind === 'no-report', 'kind=' + r.kind)
})

t('T3 legacy_depth1_report_passes', () => {
  const p = mkRoot()
  mk(p, `_Prompt/02_buildai/${T8}_1200_report.md`)
  const r = D.check(base({ projectDir: p }))
  assert(r.block === false, 'legacy flat layout must still pass')
})

t('T4 nested_case_dir_report_passes【P2】', () => {
  const p = mkRoot()
  mk(p, `_Prompt/02_buildai/20260807_案件フォルダ/${T8}_0930_report.md`)
  const r = D.check(base({ projectDir: p }))
  assert(r.block === false, 'nested case dir must be visible (maxdepth removed)')
})

t('T5 today_named_dir_nondated_file_passes【P3】', () => {
  const p = mkRoot()
  const f = mk(p, `_Prompt/02_buildai/${T8}_案件名/instruction.md`, '---\ndoc_id: x\naudience: テスト\n準拠Skill: テスト固定\n---\n本文\n')
  const r = D.check(base({ projectDir: p, owned: [f] }))
  assert(r.block === false, 'date-named dir + frontmatter md must pass')
})

t('T6 output_dir_pointer_passes【A段】', () => {
  const p = mkRoot()
  const outDir = path.join(tmp, 'outdir' + ++seq)
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, `${T8}_1500_real.md`), 'body', 'utf8')
  mk(p, `_Prompt/${T8}_0001_pointer.md`, `---\naudience: テスト\n準拠Skill: テスト固定\noutput_dir: ${outDir.replace(/\\/g, '/')}\n---\n`)
  const r = D.check(base({ projectDir: p }))
  assert(r.block === false, 'output_dir pointer must still work')
})

t('T31 output_dir_windows_absolute_path_resolved【P4】', () => {
  // 旧実装は `case "$OD" in /*)` で POSIX 絶対パスしか絶対と認めず、`C:/...` を相対として
  // ${PROJECT_DIR}/C:/... に連結していた（実測で確認）。＝ A 段（空隙補充ルール）が
  // Windows 絶対パスで機能していなかった。
  const p = mkRoot()
  const outDir = path.join(tmp, 'winabs' + ++seq)
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, `${T8}_1500_real.md`), 'body', 'utf8')
  // 本テストは golden 経由で**他 OS にも配られる**ので、Windows 前提のアサートを置かない。
  // 固定したい主張は「絶対パスの output_dir が解決されること」。
  // ドライブレター形式（P4 の再発防止本体）は Windows のときだけ追加で確かめる。
  const odText = outDir.replace(/\\/g, '/')
  assert(path.isAbsolute(outDir), 'fixture must be an absolute path')
  if (process.platform === 'win32') {
    assert(/^[A-Za-z]:\//.test(odText), 'on Windows the fixture must be a drive-letter path')
  }
  mk(p, `_Prompt/${T8}_0001_pointer.md`, `---\naudience: テスト\n準拠Skill: テスト固定\noutput_dir: ${odText}\n---\n`)
  const r = D.check(base({ projectDir: p }))
  assert(r.block === false, 'Windows absolute output_dir must resolve')
  assert(r.found && r.found.stage === 'A', 'must be satisfied via stage A, got ' + (r.found && r.found.stage))
})

t('T31b output_dir_relative_path_still_resolved', () => {
  const p = mkRoot()
  fs.mkdirSync(path.join(p, 'elsewhere'), { recursive: true })
  fs.writeFileSync(path.join(p, 'elsewhere', `${T8}_1500_real.md`), 'body', 'utf8')
  mk(p, `_Prompt/${T8}_0001_pointer.md`, '---\naudience: テスト\n準拠Skill: テスト固定\noutput_dir: elsewhere\n---\n')
  const r = D.check(base({ projectDir: p }))
  assert(r.block === false, 'relative output_dir must keep working (両側固定)')
})

t('T23 projectdir_report_needs_no_ownership【現行挙動を狭めない】', () => {
  const p = mkRoot()
  const f = mk(p, `_Prompt/02_buildai/${T8}_1200_someone_else.md`)
  setMtime(f, BEFORE_SESSION) // 他人が昔書いた報告書でも projectDir なら通る（現行同等）
  const r = D.check(base({ projectDir: p, owned: [] }))
  assert(r.block === false, 'projectDir must not require attribution')
})

// ============================================================ P3 の締め（緩すぎない）

t('T18 p3_readme_without_frontmatter_does_not_pass', () => {
  const p = mkRoot()
  const f = mk(p, `_Prompt/02_buildai/${T8}_案件名/README.md`, '# readme\n本文\n')
  const r = D.check(base({ projectDir: p, owned: [f] }))
  assert(r.block === true, 'non-frontmatter md must NOT count as a report')
})

t('T19 p3_owned_frontmatter_md_passes', () => {
  const p = mkRoot()
  const f = mk(p, `_Prompt/02_buildai/${T8}_案件名/notes.md`, '---\na: 1\naudience: テスト\n準拠Skill: テスト固定\n---\n')
  const r = D.check(base({ projectDir: p, owned: [f] }))
  assert(r.block === false, 'owned frontmatter md must pass')
})

t('T35 b_stage_accepts_today_named_non_md【継承した緩さを意図として固定】', () => {
  // B 段は今日付け**ファイル名**なら拡張子を問わない。これは旧実装（`find -name "${T8}_*" -type f`・
  // 拡張子フィルタなし）から**継承した挙動**であり、本変更で持ち込んだものではない。
  // 締めると現在通っているケースが block し始める＝ block 条件を広げる＝ I1 違反になるため、
  // 意図的に据え置く。差分実測 S12/S13 で旧実装も pass することを確認済み。
  for (const name of [`${T8}_1200_report.html`, `${T8}_1200_tmp.txt`]) {
    const p = mkRoot()
    mk(p, `_Prompt/02_buildai/${name}`)
    const r = D.check(base({ projectDir: p }))
    assert(r.block === false, `${name}: inherited B-stage behaviour must be preserved`)
  }
})

t('T20 p3_html_alone_does_not_pass', () => {
  const p = mkRoot()
  const f = mk(p, `_Prompt/02_buildai/${T8}_案件名/generated.html`, '<html></html>')
  const r = D.check(base({ projectDir: p, owned: [f] }))
  assert(r.block === true, 'html alone must NOT satisfy the P3 path')
})

t('T25 p3_bash_created_report_passes_via_mtime', () => {
  const p = mkRoot()
  const f = mk(p, `_Prompt/02_buildai/${T8}_案件名/report.md`, '---\na: 1\naudience: テスト\n準拠Skill: テスト固定\n---\n')
  setMtime(f, SESSION_START + 1000) // owned に無いが自セッション中に作られた
  const r = D.check(base({ projectDir: p, owned: [] }))
  assert(r.block === false, 'P3 must accept mtime attribution too (not owned-only)')
})

// ============================================================ 別リポ（本件の中核）

function crossRepo(extra) {
  const p = mkRoot() // projectDir: dirty・報告書なし
  const q = mkRoot(extra && extra.qOpts) // 別リポ
  return { p, q }
}

t('T1 crossrepo_report_in_other_root_passes【本件の再現】', () => {
  const { p, q } = crossRepo()
  const f = mk(q, `_Prompt/02_buildai/20260807_案件/${T8}_1400_report.md`)
  const r = D.check(base({ projectDir: p, owned: [f] }))
  assert(r.block === false, 'report in another session-touched repo must pass')
})

t('T16 foreign_stale_report_in_other_root_does_not_pass', () => {
  const { p, q } = crossRepo()
  const f = mk(q, `_Prompt/02_buildai/${T8}_1400_foreign.md`)
  setMtime(f, BEFORE_SESSION)
  const other = mk(q, 'src/touched.ts') // 自分が触ったのは別ファイル（root 導出のため）
  const r = D.check(base({ projectDir: p, owned: [other] }))
  assert(r.block === true, 'a pre-existing foreign report must NOT satisfy the gate')
})

t('T17 owned_report_in_other_root_passes', () => {
  const { p, q } = crossRepo()
  const f = mk(q, `_Prompt/02_buildai/${T8}_1400_mine.md`)
  setMtime(f, BEFORE_SESSION) // mtime は古いが owned なので通る
  const r = D.check(base({ projectDir: p, owned: [f] }))
  assert(r.block === false, 'owned report must pass regardless of mtime')
})

t('T17b/T24 bash_created_or_concurrent_report_accepted_by_design', () => {
  // 第2巡[1] 対応（Bash 生成を弾かない）と 第3巡[1] の受容した残穴は同一の観測像である。
  // 弁別不能を受け入れた設計判断であることを、テストで「意図」として固定する。
  const { p, q } = crossRepo()
  const f = mk(q, `_Prompt/02_buildai/${T8}_1400_by_script.md`)
  setMtime(f, SESSION_START + 1000)
  const other = mk(q, 'src/touched.ts')
  const r = D.check(base({ projectDir: p, owned: [other] }))
  assert(r.block === false, 'mtime-fresh report in a touched repo is accepted by design')
})

t('T8 transcript_unresolvable_falls_back_to_project_dir_only', () => {
  const { p, q } = crossRepo()
  mk(q, `_Prompt/02_buildai/${T8}_1400_report.md`)
  // owned=null 相当（transcript も session_id も無い）→ 追加ルートは生まれない
  const r = D.check({
    projectDir: p,
    changesRaw: DIRTY,
    transcript: null,
    sessionId: null,
    sessionStartMs: null,
    nowMs: NOW,
    ...TODAY
  })
  assert(r.block === true, 'without attribution info the gate must behave like the old one')
  assert(r.roots.length === 1, 'roots must be [projectDir], got ' + r.roots.length)
})

t('T10 worktree_gitfile_root_detected', () => {
  const p = mkRoot()
  const q = mkRoot({ git: 'file' })
  const f = mk(q, `_Prompt/02_buildai/${T8}_1400_report.md`)
  assert(D.ascendToRoot(f) !== null, 'worktree root must be detected (.git is a FILE)')
  const r = D.check(base({ projectDir: p, owned: [f] }))
  assert(r.block === false, 'worktree repo must count as a root')
})

t('T9 non_repo_edit_adds_no_root', () => {
  const p = mkRoot()
  const lone = path.join(tmp, 'nonrepo' + ++seq, 'deep', 'note.md')
  fs.mkdirSync(path.dirname(lone), { recursive: true })
  fs.writeFileSync(lone, 'x', 'utf8')
  const roots = D.resolveRoots(p, [lone])
  const has = roots.some((r) => D.normPath(r) === D.normPath(path.dirname(lone)))
  assert(!has, 'a non-repo edited file must not become a root')
})

t('T32 derived_root_is_the_raw_path_not_a_comparison_key', () => {
  // ルート遡上は **原文のパス**から行うこと。比較用の正規化キーを fs 操作へ流用すると、
  // 実在しないパスのフォールバックや realpath による symlink 解決の差で、
  // 意図しないディレクトリをルートにしうる。
  const p = mkRoot()
  const q = mkRoot()
  const f = mk(q, `_Prompt/02_buildai/${T8}_1400_report.md`)
  const roots = D.resolveRoots(p, [f])
  const derived = roots[1]
  assert(derived !== undefined, 'derived root must exist')
  assert(derived === q, `root must be the raw path as given: expected ${q}, got ${derived}`)
})

t('T15 roots_capped_and_deduped', () => {
  const p = mkRoot()
  const ownedRaw = []
  for (let i = 0; i < 20; i++) {
    const q = mkRoot()
    ownedRaw.push(mk(q, 'src/a.ts'))
    ownedRaw.push(mk(q, 'src/b.ts')) // 同一 root を指す 2 本 → 重複排除の確認
  }
  const roots = D.resolveRoots(p, ownedRaw)
  assert(roots.length <= 8, 'roots capped at 8, got ' + roots.length)
  const norm = roots.map(D.normPath)
  assert(new Set(norm).size === norm.length, 'roots must be deduped')
})

// ============================================================ root 導出の意味（第4巡[1]）

t('T28 ascend_returns_parent_of_prompt_not_prompt_itself', () => {
  // .git を持たず `_Prompt` だけで検出されるケース（第4巡[1] が壊れると一段ずれる）
  const q = mkRoot({ git: false })
  const f = mk(q, `_Prompt/02_buildai/${T8}_1400_report.md`)
  const r = D.ascendToRoot(f)
  assert(r !== null, 'root must be found via _Prompt even without .git')
  assert(D.normPath(r) === D.normPath(q), `root must be the parent of _Prompt, got ${r}`)
  assert(D.normPath(r) !== D.normPath(path.join(q, '_Prompt')), 'must NOT return _Prompt itself')
  // 実際に報告書が見つかること（一段ずれていれば見つからない）
  const p = mkRoot()
  const res = D.check(base({ projectDir: p, owned: [f] }))
  assert(res.block === false, 'report under the derived root must be discovered')
})

// ============================================================ 性能契約（第4巡[2]）

t('T29 budget_exhaustion_does_not_block (倒れる向きの明示)', () => {
  const p = mkRoot()
  // 報告書は無い＝通常なら block。予算 0 なら「不完全な探索で block しない」側へ倒れる。
  const r = D.check(base({ projectDir: p, searchBudgetMs: -1 }))
  assert(r.block === false, 'incomplete search must not block')
  assert(r.why === 'budget-exhausted', 'why=' + r.why)
})

t('T29b normal_budget_still_blocks (予算が足りていれば従来どおり)', () => {
  const p = mkRoot()
  const r = D.check(base({ projectDir: p, searchBudgetMs: 4000 }))
  assert(r.block === true, 'with budget available the gate must still block')
  assert(r.kind === 'no-report')
})

t('T30 early_exit_stops_scanning_on_first_hit', () => {
  const p = mkRoot()
  mk(p, `_Prompt/02_buildai/${T8}_0900_report.md`)
  for (let i = 0; i < 200; i++) mk(p, `_Prompt/02_buildai/noise/f${i}.txt`)
  const t0 = Date.now()
  const r = D.check(base({ projectDir: p }))
  const ms = Date.now() - t0
  assert(r.block === false)
  assert(ms < 2000, 'search must be fast, took ' + ms + 'ms')
})

// ============================================================ C 段（閲覧層）

t('T11 viewing_layer_gap_blocks_on_project_dir', () => {
  const p = mkRoot({ vault: true })
  const md = mk(p, `_Prompt/02_buildai/${T8}_1200_report.md`, '---\naudience: テスト\n準拠Skill: テスト固定\n---\n本文のみ（HTML も file:/// も無い）')
  const r = D.check(base({ projectDir: p, owned: [md] }))
  assert(r.block === true, 'viewing layer gap must block')
  assert(r.kind === 'viewing-layer', 'kind=' + r.kind)
})

t('T11b viewing_layer_satisfied_by_html_sibling', () => {
  const p = mkRoot({ vault: true })
  const md = mk(p, `_Prompt/02_buildai/${T8}_1200_report.md`, '---\naudience: テスト\n準拠Skill: テスト固定\n---\n本文')
  const html = mk(p, `_Prompt/02_buildai/${T8}_1200_report.html`, '<html></html>')
  setMtime(md, NOW - 10000)
  setMtime(html, NOW) // html のほうが新しい
  const r = D.check(base({ projectDir: p, owned: [md] }))
  assert(r.block === false, 'html sibling must satisfy the viewing layer')
})

/* --- 多レーン誤発火の遮断（2026-09-04）------------------------------------
 * 同一リポジトリで複数レーンの CC が同時に走る運用では、C 段が _Prompt/ 全体を
 * 見ると「他レーンが落とした今日付け MD」で自分の Stop が止まる。C 段を owned
 * （当セッションが Edit/Write/NotebookEdit で触ったパス）に限定した。両側を固定する。 */

t('T11c viewing_layer_ignores_other_lane_md【多レーン誤発火の遮断】', () => {
  const p = mkRoot({ vault: true })
  const mine = mk(p, `_Prompt/02_buildai/${T8}_0900_mine.md`)
  mk(p, `_Prompt/02_buildai/${T8}_0900_mine.html`, '<html></html>')
  // 別レーンの CC が落とした、閲覧層を満たさない今日付け MD（自分は触っていない）
  mk(p, `_Prompt/02_buildai/${T8}_1200_other-lane.md`, '---\naudience: テスト\n準拠Skill: テスト固定\n---\nHTML も file:/// も無い')
  const r = D.check(base({ projectDir: p, owned: [mine] }))
  assert(r.block === false, 'other lane MD must not block this session, kind=' + r.kind)
})

t('T11d viewing_layer_still_blocks_own_md_among_other_lanes【検出力の維持】', () => {
  const p = mkRoot({ vault: true })
  const mine = mk(p, `_Prompt/02_buildai/${T8}_1300_mine.md`, '---\naudience: テスト\n準拠Skill: テスト固定\n---\nHTML 無し')
  mk(p, `_Prompt/02_buildai/${T8}_1200_other-lane.md`, '---\naudience: テスト\n準拠Skill: テスト固定\n---\nHTML 無し')
  const r = D.check(base({ projectDir: p, owned: [mine] }))
  assert(r.block === true, 'own gap must still block')
  assert(r.kind === 'viewing-layer', 'kind=' + r.kind)
  assert(r.gaps.length === 1, 'only the own MD must be reported, got ' + r.gaps.length + ': ' + r.gaps.join(','))
  assert(String(r.gaps[0]).indexOf('mine') !== -1, 'gap must be the own MD: ' + r.gaps[0])
})

t('T12 viewing_layer_not_applied_to_other_roots【新規 block 面ゼロ】', () => {
  const p = mkRoot() // projectDir は Vault 型ではない
  const q = mkRoot({ vault: true }) // 追加ルートが Vault 型で gap を持つ
  const f = mk(q, `_Prompt/02_buildai/${T8}_1400_report.md`, '---\naudience: テスト\n準拠Skill: テスト固定\n---\nHTML も file:/// も無い')
  const r = D.check(base({ projectDir: p, owned: [f] }))
  assert(r.block === false, 'C-stage must NOT be applied to non-projectDir roots')
})

// ============================================================ 出力の健全性

t('T26 block_json_is_valid_and_control_char_free', () => {
  const p = mkRoot()
  const r = D.check(base({ projectDir: p }))
  assert(r.block === true)
  const s = JSON.stringify({ decision: 'block', reason: r.reason })
  const parsed = JSON.parse(s)
  assert(parsed.decision === 'block', 'round-trips as valid JSON')
  let ctrl = 0
  for (let i = 0; i < parsed.reason.length; i++) {
    const c = parsed.reason.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) ctrl++
  }
  assert(ctrl === 0, 'reason must contain no raw control characters, found ' + ctrl)
  assert(parsed.reason.indexOf(String(p).replace(/\\/g, '/')) >= 0, 'reason must list searched roots')
})

t('T27 detect_core_never_throws_on_missing_paths', () => {
  const r = D.check(base({ projectDir: path.join(tmp, 'does-not-exist-' + ++seq) }))
  assert(typeof r.block === 'boolean', 'must return a verdict, not throw')
})

// ============================================================ AC-2: md ヘッダ行存在（2026-08-11）

t('T40 header_lines_present_passes【存在 pass】', () => {
  const p = mkRoot()
  mk(
    p,
    `_Prompt/02_buildai/${T8}_1200_report.md`,
    '---\naudience: maintainer\n準拠Skill: testable-stop-hook-gate-authoring\n---\n本文\n'
  )
  const r = D.check(base({ projectDir: p }))
  assert(r.block === false, 'md with both header lines must pass, got kind=' + r.kind)
})

t('T40b 該当Skillなし_wording_passes', () => {
  const p = mkRoot()
  mk(p, `_Prompt/02_buildai/${T8}_1200_report.md`, '---\naudience: maintainer\n---\n該当Skillなし\n本文\n')
  const r = D.check(base({ projectDir: p }))
  assert(r.block === false, 'alternative wording 該当Skillなし must pass')
})

t('T40c bom_headed_first_line_still_detected', () => {
  // BOM 直後に header 行が来る md（frontmatter 無し・B 段検出）でも行存在と認めること。
  // BOM 先頭 md でも行存在と認める（検出核は先頭 BOM を剥いでから判定する）ことのピン。
  const p = mkRoot()
  mk(
    p,
    `_Prompt/02_buildai/${T8}_1200_report.md`,
    String.fromCharCode(0xfeff) + 'audience: maintainer\n準拠Skill: x\n本文\n'
  )
  const r = D.check(base({ projectDir: p }))
  assert(r.block === false, 'BOM-headed md must still pass the header existence check')
})

t('T41 header_line_missing_blocks【欠落 block】', () => {
  const cases = [
    '---\naudience: maintainer\n---\n本文\n', // 準拠Skill 欠落
    '---\n準拠Skill: x\n---\n本文\n', // audience 欠落
    '本文のみ\n' // 両方欠落（今日付けファイル名なので B 段で検出される）
  ]
  for (const body of cases) {
    const p = mkRoot()
    mk(p, `_Prompt/02_buildai/${T8}_1200_report.md`, body)
    const r = D.check(base({ projectDir: p }))
    assert(r.block === true, 'missing header line must block: ' + JSON.stringify(body))
    assert(r.kind === 'md-header', 'kind=' + r.kind)
    // block JSON の健全性（T26 と同じ主張を新 reason にも課す）
    const parsed = JSON.parse(JSON.stringify({ decision: 'block', reason: r.reason }))
    let ctrl = 0
    for (let i = 0; i < parsed.reason.length; i++) {
      const c = parsed.reason.charCodeAt(i)
      if (c < 0x20 || c === 0x7f) ctrl++
    }
    assert(ctrl === 0, 'md-header reason must contain no raw control characters')
  }
})

t('T42 waiver_line_passes【waiver＝行存在のみが解除条件】', () => {
  const p = mkRoot()
  mk(
    p,
    `_Prompt/02_buildai/${T8}_1200_report.md`,
    '---\naudience: maintainer\n準拠Skill: なし（maintainer棄却指示 2026-08-11）\n---\n本文\n'
  )
  const r = D.check(base({ projectDir: p }))
  assert(r.block === false, 'explicit waiver line must pass (existence-only, no content judgement)')
})

t('T43 nonmd_satisfier_unaffected【md 以外へ block 面を広げない】', () => {
  const p = mkRoot()
  mk(p, `_Prompt/02_buildai/${T8}_1200_report.html`, '<html></html>')
  const r = D.check(base({ projectDir: p }))
  assert(r.block === false, 'T35 系（B 段 non-md）は header ゲート追加後も通ること')
})

t('T44 stageA_pointer_side_header_passes', () => {
  const p = mkRoot()
  const outDir = path.join(tmp, 'hdr' + ++seq)
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, `${T8}_1500_real.md`), 'body', 'utf8') // 実体側に行なし
  mk(
    p,
    `_Prompt/${T8}_0001_pointer.md`,
    `---\naudience: テスト\n準拠Skill: テスト固定\noutput_dir: ${outDir.replace(/\\/g, '/')}\n---\n`
  )
  const r = D.check(base({ projectDir: p }))
  assert(r.block === false, 'stage A はポインタ md 側の header 記載で充足してよい')
  assert(r.found && r.found.stage === 'A', 'stage=' + (r.found && r.found.stage))
})

// ============================================================ CCPIT_075（帰属の 3 段優先順位）

t('T-new-1 own_attributed_report_wins_over_foreign_headerless_candidate【CCPIT_075 S1 相当】', () => {
  const p = mkRoot()
  const code = mk(p, 'src/mine.ts', 'x')
  setMtime(code, SESSION_START + 1000)
  const foreign = mk(p, `_Prompt/02_buildai/${T8}_0100_foreign.md`, '# ヘッダ無し\n')
  setMtime(foreign, BEFORE_SESSION)
  const mine = mk(p, `_Prompt/02_buildai/${T8}_0200_mine.md`) // DEFAULT_MD はヘッダ有り
  const r = D.check(base({ projectDir: p, owned: [code, mine] }))
  assert(r.block === false, 'own attributed report must win over a foreign headerless candidate, got kind=' + r.kind)
  assert(r.found && r.found.file === mine, 'found must be the own report, got ' + (r.found && r.found.file))
})

t('T-new-2 owned_priority_beats_stale_mtime_pseudo_attribution_in_long_session【CCPIT_075 S3 相当】', () => {
  const p = mkRoot()
  const code = mk(p, 'src/mine.ts', 'x')
  setMtime(code, SESSION_START)
  const longStart = SESSION_START - 30 * 24 * 60 * 60 * 1000 // 30 日前に開始した長時間セッション
  // foreign の実 mtime（テスト実行時刻）は longStart よりずっと後になるため、mtime 帰属だけを見ると
  // 誤って「自分の物」に見える（長時間セッションの弱点）。owned を優先すれば弁別できる。
  const foreign = mk(p, `_Prompt/02_buildai/${T8}_0100_foreign.md`, '# ヘッダ無し\n')
  const mine = mk(p, `_Prompt/02_buildai/${T8}_0200_mine.md`)
  const r = D.check(base({ projectDir: p, owned: [code, mine], sessionStartMs: longStart }))
  assert(r.block === false, 'owned report must win over a merely mtime-attributed foreign candidate, got kind=' + r.kind)
  assert(r.found && r.found.file === mine, 'found must be the owned report, got ' + (r.found && r.found.file))
})

t('T-new-3 no_attributed_code_change_short_circuits_to_no_changes【CCPIT_075 S4 相当】', () => {
  const p = mkRoot({ dirty: false }) // 既定のダミー dirty ファイルも作らない＝本当に無変更
  mk(p, `_Prompt/00_FromDesignAi/${T8}_0400_note.md`, '# メモ（報告書ではない）\n')
  const foreign = mk(p, `_Prompt/02_buildai/${T8}_0100_foreign.md`, '# ヘッダ無し\n')
  setMtime(foreign, BEFORE_SESSION)
  const r = D.check(base({ projectDir: p, owned: [], changesRaw: pz('?? src/changed.ts') }))
  assert(r.block === false && r.why === 'no-changes', '無帰属の phantom dirty は changed に数えない, got ' + JSON.stringify({ block: r.block, why: r.why, kind: r.kind }))
})

t('T-new-4 attributed_code_change_without_report_still_blocks【CCPIT_075 S5 相当・I1】', () => {
  const p = mkRoot({ dirty: false })
  const code = mk(p, 'src/mine.ts', 'x')
  setMtime(code, SESSION_START + 1000)
  const r = D.check(base({ projectDir: p, owned: [code], changesRaw: pz('?? src/mine.ts') }))
  assert(r.block === true, 'attributed code change with no report must still block')
  assert(r.kind === 'no-report', 'kind=' + r.kind)
})

t('T-new-5 own_report_missing_header_still_blocks_despite_foreign_headered_md【CCPIT_075 S6 相当】', () => {
  const p = mkRoot()
  const code = mk(p, 'src/mine.ts', 'x')
  setMtime(code, SESSION_START + 1000)
  const mine = mk(p, `_Prompt/02_buildai/${T8}_0200_mine.md`, '本文のみ（ヘッダ無し）\n')
  const foreignOk = mk(p, `_Prompt/02_buildai/${T8}_0100_foreign_ok.md`) // DEFAULT_MD: ヘッダ有り・他レーン想定
  setMtime(foreignOk, BEFORE_SESSION)
  const r = D.check(base({ projectDir: p, owned: [code, mine] }))
  assert(r.block === true, 'own header-missing report must still block despite a foreign headered md, got kind=' + r.kind)
  assert(r.kind === 'md-header', 'kind=' + r.kind)
})

t('T-new-6 legacy_fallback_candidate_skips_header_check_when_truly_unattributed', () => {
  const p = mkRoot()
  const foreign = mk(p, `_Prompt/02_buildai/${T8}_1200_foreign.md`, '# ヘッダ無し\n')
  setMtime(foreign, BEFORE_SESSION)
  const r = D.check(base({ projectDir: p, owned: [] })) // T23 と同じ「真に空」
  assert(r.block === false, 'legacy fallback で受理された無帰属候補にヘッダ規律を課さない, got kind=' + r.kind)
})

t('T-new-7 rename_and_delete_attribution_asymmetry【F1: 削除のみ判定不能→attributed】', () => {
  // (a) 自分が rename した（新パスが owned）→ attributed
  {
    const p = mkRoot({ dirty: false })
    const renamed = mk(p, 'src/renamed_new.ts', 'x')
    setMtime(renamed, SESSION_START + 1000)
    const r = D.check(
      base({ projectDir: p, owned: [renamed], changesRaw: pz('R  src/renamed_new.ts', 'src/renamed_old.ts') })
    )
    assert(r.block === true, '(a) own rename must be attributed and block on no-report, got ' + JSON.stringify(r))
  }
  // (b) 他レーンが rename した（新パスが owned に無く mtime も開始前）→ not attributed
  {
    const p = mkRoot({ dirty: false })
    const renamed = mk(p, 'other/renamed_new.ts', 'x')
    setMtime(renamed, BEFORE_SESSION)
    const r = D.check(
      base({ projectDir: p, owned: [], changesRaw: pz('R  other/renamed_new.ts', 'other/renamed_old.ts') })
    )
    assert(r.block === false && r.why === 'no-changes', '(b) foreign rename must not be attributed, got ' + JSON.stringify(r))
  }
  // (c) 純粋な削除（rename でない）は自他を区別せず attributed とみなす（既知の制約。§4-2a）
  {
    const p = mkRoot({ dirty: false })
    const r = D.check(base({ projectDir: p, owned: [], changesRaw: pz(' D src/deleted.ts') }))
    assert(r.block === true, '(c) unresolvable pure delete must conservatively count as changed, got ' + JSON.stringify(r))
  }
})

t('T-new-8 stageA_pair_uses_higher_priority_side_for_acceptance_and_header', () => {
  const p = mkRoot()
  const outDir = path.join(tmp, 'pairA' + ++seq)
  fs.mkdirSync(outDir, { recursive: true })
  const target = path.join(outDir, `${T8}_1500_real.md`)
  fs.writeFileSync(target, 'body（ヘッダ無し）', 'utf8')
  setMtime(target, BEFORE_SESSION) // target 側は無帰属
  const pointer = mk(
    p,
    `_Prompt/${T8}_0001_pointer.md`,
    `---\naudience: テスト\n準拠Skill: テスト固定\noutput_dir: ${outDir.replace(/\\/g, '/')}\n---\n`
  ) // pointer 側は owned
  const r = D.check(base({ projectDir: p, owned: [pointer] }))
  assert(r.block === false, 'pointer 側が owned ならペア全体を採用し header 検査も pointer 側で足りる, got kind=' + r.kind)
  assert(r.found && r.found.stage === 'A', 'stage=' + (r.found && r.found.stage))
})

t('T-new-9b known_nonempty_owned_does_not_get_legacy_fallback【実装レビュー指摘[1]】', () => {
  const p = mkRoot()
  const code = mk(p, 'src/mine.ts', 'x')
  setMtime(code, SESSION_START + 1000) // owned・帰属あり＝ known-nonempty
  const foreign = mk(p, `_Prompt/02_buildai/${T8}_1200_foreign.md`, '# ヘッダ無し\n')
  setMtime(foreign, BEFORE_SESSION) // owned にも mtime にも当たらない無帰属候補のみ
  const r = D.check(base({ projectDir: p, owned: [code] }))
  assert(r.block === true, 'owned が既知の非空なら無帰属候補で legacy fallback してはならない, got ' + JSON.stringify(r))
  assert(r.kind === 'no-report', 'kind=' + r.kind)
})

t('T-new-9c stageA_ownedHit_overrides_earlier_B_stage_mtimeHit【実装レビュー指摘[2]】', () => {
  const p = mkRoot()
  const code = mk(p, 'src/mine.ts', 'x')
  setMtime(code, SESSION_START + 1000)
  // B 段: 他レーンのヘッダ無し候補（mtime をセッション開始後に固定＝mtime 帰属してしまう体）
  const bStageForeign = mk(p, `_Prompt/02_buildai/${T8}_0100_foreign.md`, '# ヘッダ無し\n')
  setMtime(bStageForeign, SESSION_START + 500)
  // stage A: 自分の owned なポインタ（output_dir 経由）。B 段の報告エリア外に置く。
  const outDir = path.join(tmp, 'crossStage' + ++seq)
  fs.mkdirSync(outDir, { recursive: true })
  const target = path.join(outDir, `${T8}_1500_real.md`)
  fs.writeFileSync(target, 'body', 'utf8')
  const pointer = mk(
    p,
    `_Prompt/${T8}_0001_pointer.md`,
    `---\naudience: テスト\n準拠Skill: テスト固定\noutput_dir: ${outDir.replace(/\\/g, '/')}\n---\n`
  )
  const r = D.check(base({ projectDir: p, owned: [code, pointer] }))
  assert(r.block === false, 'stage A の owned 一致が B 段の mtimeHit を上回るべき, got kind=' + r.kind)
  assert(r.found && r.found.stage === 'A', 'B 段の foreign(mtime) ではなく stage A の owned を採用すべき, stage=' + (r.found && r.found.stage))
})

t('T-new-9 p3_still_requires_attribution_in_projectDir【legacy fallback は B 段のみ】', () => {
  const p = mkRoot()
  const f = mk(
    p,
    `_Prompt/02_buildai/${T8}_案件名/notes.md`,
    '---\na: 1\naudience: テスト\n準拠Skill: テスト固定\n---\n'
  )
  setMtime(f, BEFORE_SESSION)
  const r = D.check(base({ projectDir: p, owned: [] })) // owned が真に空でも P3 は救われない
  assert(r.block === true, 'P3 must NOT get the projectDir legacy fallback, got kind=' + r.kind)
  assert(r.kind === 'no-report', 'kind=' + r.kind)
})

// ============================================================ 結果

try {
  fs.rmSync(tmp, { recursive: true, force: true })
} catch (e) {
  /* 後始末失敗は無視 */
}

const total = pass + fail
if (fail) {
  console.log(`FAIL: ${pass}/${total} PASS`)
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log(`OK: ${pass}/${total} PASS`)
