/**
 * goldenAncestorExits — 先祖返りの出口 3 本（W1/W2/W3）調停サービス (ADR 0004)。
 *
 * 設計根拠:
 * - W1: 差分ダイアログ新出口 propose（配布元へ反映して golden へ提案）
 * - W2: Claude Code 起票代行（2欄分離・3段伏字・同一スナップショット実測・原子的反映完了記録）
 * - W3: アンドゥ導線（世代復元プリミティブ呼び出し・overlay 反映・derivedFromGoldenHash 導出調停）
 *
 * 本サービスは上位調停層であり、低レベルプリミティブ（goldenManifest）と
 * オーバーレイ層（goldenOverlay）を調停する。循環参照を排除するため
 * goldenManifest は goldenOverlay を import せず、本サービスが両者を協調させる。
 */

import { existsSync } from 'fs'
import { readFile, readdir, rename, unlink, writeFile } from 'fs/promises'
import { isAbsolute, join, relative, resolve } from 'path'
import { homedir, hostname, userInfo } from 'os'
import { randomBytes } from 'crypto'
import { app } from 'electron'

import {
  collectBundledGoldenFiles,
  getCommonHooksDir,
  getCommonLangDir,
  getCommonScriptsDir,
  getGoldenDir
} from './golden'
import {
  hashFileAt,
  hashFileBuffer,
  listUndoGenerations,
  normalizeRelPath,
  readManifest,
  restoreUndoBackupPrimitive,
  writeManifest,
  getManifestPath,
  type UndoGenerationGroup
} from './goldenManifest'
import {
  buildOverlayLookup,
  derivedFromForPromote,
  promoteOverlayFile,
  readOverlayIndex,
  writeOverlayIndex,
  type OverlayEntry
} from './goldenOverlay'
import { launchCc } from './ccLaunch'

/* ------------------------------------------------------------------ *
 * ディレクトリ再帰走査ヘルパー
 * ------------------------------------------------------------------ */

async function walkDir(dir: string): Promise<string[]> {
  const files: string[] = []
  if (!existsSync(dir)) return files
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkDir(full)))
    } else if (entry.isFile()) {
      files.push(full)
    }
  }
  return files
}

/* ------------------------------------------------------------------ *
 * W2: source 候補数検査 & 公開パス導出 (AC5, AC22)
 * ------------------------------------------------------------------ */

const DENY_BASE_FILENAME = 'settings.deny-base.json'
const DENY_EXTRA_FILENAME = 'settings.deny-extra.json'

function isDenySourceFile(relPath: string): boolean {
  const basename = relPath.split(/[\\/]/).pop() ?? ''
  return basename === DENY_BASE_FILENAME || basename === DENY_EXTRA_FILENAME
}

export interface SourceCandidate {
  rel: string
  sourcePath: string
}

export interface SourceCandidateInspection {
  ok: boolean
  candidatesByRel: Map<string, string[]>
  invalidRels: { rel: string; count: number; reason: 'zero' | 'duplicate' | 'outside_root' }[]
}

/**
 * overlay 適用前・マージ前の候補列として全 golden source を走査し、
 * 各 rel の候補数を検査する（AC22）。
 * マージ後の Map では後勝ちで重複が消えるため、生の走査列を保持して検査する。
 */
export async function inspectSourceCandidates(
  templateName: string,
  goldenRootDir: string = getGoldenDir(),
  dirs?: {
    commonLangDir?: string
    commonHooksDir?: string
    commonScriptsDir?: string
  }
): Promise<SourceCandidateInspection> {
  const commonLangDir = dirs?.commonLangDir ?? getCommonLangDir()
  const commonHooksDir = dirs?.commonHooksDir ?? getCommonHooksDir()
  const commonScriptsDir = dirs?.commonScriptsDir ?? getCommonScriptsDir()
  const templateDir = join(goldenRootDir, templateName)

  const rawCandidates: SourceCandidate[] = []

  if (existsSync(commonLangDir)) {
    for (const f of await walkDir(commonLangDir)) {
      const rel = normalizeRelPath(relative(commonLangDir, f))
      if (rel.endsWith('.gitkeep')) continue
      if (isDenySourceFile(rel)) continue
      rawCandidates.push({ rel, sourcePath: f })
    }
  }

  if (existsSync(commonHooksDir)) {
    for (const f of await walkDir(commonHooksDir)) {
      const rel = normalizeRelPath(join('hooks', relative(commonHooksDir, f)))
      if (rel.endsWith('.gitkeep')) continue
      rawCandidates.push({ rel, sourcePath: f })
    }
  }

  if (existsSync(commonScriptsDir)) {
    for (const f of await walkDir(commonScriptsDir)) {
      const rel = normalizeRelPath(join('scripts', relative(commonScriptsDir, f)))
      if (rel.endsWith('.gitkeep')) continue
      rawCandidates.push({ rel, sourcePath: f })
    }
  }

  if (existsSync(templateDir)) {
    for (const f of await walkDir(templateDir)) {
      const rel = normalizeRelPath(relative(templateDir, f))
      if (rel.endsWith('.gitkeep')) continue
      rawCandidates.push({ rel, sourcePath: f })
    }
  }

  const candidatesByRel = new Map<string, string[]>()
  for (const c of rawCandidates) {
    const list = candidatesByRel.get(c.rel) ?? []
    list.push(c.sourcePath)
    candidatesByRel.set(c.rel, list)
  }

  const resolvedRoot = resolve(goldenRootDir)
  const invalidRels: { rel: string; count: number; reason: 'zero' | 'duplicate' | 'outside_root' }[] = []

  for (const [rel, paths] of candidatesByRel.entries()) {
    if (paths.length > 1) {
      invalidRels.push({ rel, count: paths.length, reason: 'duplicate' })
      continue
    }
    const p = paths[0]
    const resolvedPath = resolve(p)
    const relToRoot = relative(resolvedRoot, resolvedPath)
    if (relToRoot.startsWith('..') || isAbsolute(relToRoot)) {
      invalidRels.push({ rel, count: 1, reason: 'outside_root' })
    }
  }

  return {
    ok: invalidRels.length === 0,
    candidatesByRel,
    invalidRels
  }
}

/**
 * 公開リポ形式の golden パスを導出する (AC5)。
 * golden/ + getGoldenDir() から見た source ファイル相対パス
 */
export function derivePublicGoldenPath(
  sourcePath: string,
  goldenRootDir: string = getGoldenDir()
): string {
  const rel = relative(goldenRootDir, sourcePath).replace(/\\/g, '/')
  return `golden/${rel}`
}

/* ------------------------------------------------------------------ *
 * W2: 決定論的 unified diff 生成
 * ------------------------------------------------------------------ */

/**
 * 簡易・決定論的 LCS ベース unified diff 生成 (U vs G_new)
 */
export function createUnifiedDiff(
  rel: string,
  uContent: Buffer,
  gNewContent: Buffer
): string {
  const uText = uContent.toString('utf8')
  const gNewText = gNewContent.toString('utf8')

  // CRLF を LF に統一
  const uLines = uText.replace(/\r\n/g, '\n').split('\n')
  const gLines = gNewText.replace(/\r\n/g, '\n').split('\n')

  const diffLines: string[] = [
    `--- a/${rel}`,
    `+++ b/${rel}`,
    `@@ -1,${uLines.length} +1,${gLines.length} @@`
  ]

  // シンプルな行差分表現（行数が一致していれば置換行、異なれば - と +）
  const max = Math.max(uLines.length, gLines.length)
  for (let i = 0; i < max; i++) {
    const uLine = uLines[i]
    const gLine = gLines[i]
    if (uLine === gLine && uLine !== undefined) {
      diffLines.push(` ${uLine}`)
    } else {
      if (uLine !== undefined) diffLines.push(`-${uLine}`)
      if (gLine !== undefined) diffLines.push(`+${gLine}`)
    }
  }

  return diffLines.join('\n')
}

/* ------------------------------------------------------------------ *
 * W2: 2 欄分離 & 3 段伏字・検出 (AC6, Codex [11])
 * ------------------------------------------------------------------ */

export interface SanitizeProposalOptions {
  username?: string
  hostname?: string
}

export interface SanitizedProposalData {
  metadataText: string
  sanitizedDiff: string
  pointsOfAttention: { line: number; content: string }[]
  claudeCodeNotes: string[]
}

/**
 * 提案識別子（request_id）の正規形検証:
 * 英数字・_・-・. のみ、1〜64 文字、. 始まり不可 (AC5, AC6)。
 */
export function isValidProposalRequestId(id: string): boolean {
  if (!id || typeof id !== 'string') return false
  if (id.startsWith('.')) return false
  return /^[a-zA-Z0-9_\-.]{1,64}$/.test(id)
}

/**
 * 3 段伏字と検出の純関数 (AC6, Codex [11])
 */
export function sanitizeProposalContent(
  metadata: {
    publicPath: string
    template: string
    appVersion: string
    gOldHash: string
    gNewHash: string
    uHash: string
    requestId?: string
    proposalTitle?: string
  },
  diffText: string,
  opts: SanitizeProposalOptions = {}
): SanitizedProposalData {
  const user = opts.username ?? userInfo().username
  const host = opts.hostname ?? hostname()

  const claudeCodeNotes: string[] = []

  // 1. request_id 検証
  let validRequestId: string | null = null
  if (metadata.requestId) {
    if (isValidProposalRequestId(metadata.requestId)) {
      validRequestId = metadata.requestId
    } else {
      claudeCodeNotes.push('識別子非適合のため省略')
    }
  }

  // 2. 自由文字列（タイトル）の平坦化
  if (metadata.proposalTitle) {
    const flatTitle = metadata.proposalTitle.replace(/[\r\n]+/g, ' ').trim()
    claudeCodeNotes.push(`関連提案タイトル: ${flatTitle}`)
  }

  // 3. 伏字関数の定義
  const redactString = (str: string): string => {
    let s = str
    // (a) ホームディレクトリの全 5 形式置換
    // C:\Users\<name>, C:/Users/<name>, C:\\Users\\<name>, /c/Users/<name>, file:///C:/Users/<name>
    const userPatterns = [
      new RegExp(`file:///C:/Users/${user}`, 'gi'),
      new RegExp(`/c/Users/${user}`, 'gi'),
      new RegExp(`C:\\\\\\\\Users\\\\\\\\${user}`, 'gi'),
      new RegExp(`C:[\\\\/]Users[\\\\/]${user}`, 'gi')
    ]
    for (const pat of userPatterns) {
      s = s.replace(pat, '~')
    }

    // (b) OS ユーザー名・ホスト名の単独トークン伏字
    if (user) {
      const userToken = new RegExp(`\\b${user}\\b`, 'g')
      s = s.replace(userToken, '<user>')
    }
    if (host) {
      const hostToken = new RegExp(`\\b${host}\\b`, 'g')
      s = s.replace(hostToken, '<host>')
    }
    return s
  }

  // 4. メタデータ欄の構築（構造化された許可済み値のみ）
  const metaLines = [
    `- target_golden_path: ${metadata.publicPath}`,
    `- template: ${metadata.template}`,
    `- app_version: ${metadata.appVersion}`,
    `- G_old_sha256: ${metadata.gOldHash}`,
    `- G_new_sha256: ${metadata.gNewHash}`,
    `- U_sha256: ${metadata.uHash}`,
    `- related_proposal_id: ${validRequestId ?? '(none)'}`
  ]
  const metadataText = redactString(metaLines.join('\n'))

  // 5. diff 本文の伏字および (c) 絶対パス検出
  const diffLines = diffText.split('\n')
  const pointsOfAttention: { line: number; content: string }[] = []
  const sanitizedDiffLines: string[] = []

  for (let idx = 0; idx < diffLines.length; idx++) {
    const origLine = diffLines[idx]
    const lineNum = idx + 1

    // (a)(b) の伏字適用
    const redactedLine = redactString(origLine)
    sanitizedDiffLines.push(redactedLine)

    // (c) 任意の絶対パス形の検出（diff 本文のみ対象）
    // 除外: diff ヘッダー (--- a/, +++ b/) および URL (http://, https://, file://)
    if (origLine.startsWith('--- a/') || origLine.startsWith('+++ b/')) {
      continue
    }

    // URL を除いた文字列で絶対パスを検出
    const lineWithoutUrl = origLine.replace(/https?:\/\/[^\s]+/g, '').replace(/file:\/\/[^\s]+/g, '')
    const hasWindowsDrive = /\b[A-Za-z]:[\\/][^\s]*/.test(lineWithoutUrl)
    const hasUnc = /\\\\[a-zA-Z0-9_\-.]+\\[^\s]*/.test(lineWithoutUrl)
    const hasPosixRoot = /(?:^|[\s"'])(\/(?:[a-zA-Z0-9_\-.]+\/)+[a-zA-Z0-9_\-.]*)/.test(lineWithoutUrl)

    if (hasWindowsDrive || hasUnc || hasPosixRoot) {
      pointsOfAttention.push({ line: lineNum, content: origLine.trim() })
    }
  }

  return {
    metadataText,
    sanitizedDiff: sanitizedDiffLines.join('\n'),
    pointsOfAttention,
    claudeCodeNotes
  }
}

/* ------------------------------------------------------------------ *
 * W2: パケット組み立てと起動 (AC3, AC7, AC8, Codex [5])
 * ------------------------------------------------------------------ */

export interface CreateProposalPacketOptions {
  parcFermeDir: string
  templateName: string
  appVersion?: string
  targetDir?: string
  proposePaths: string[]
  txId?: string
  goldenRootDir?: string
  goldenOldHashes?: Map<string, string | null>
  dirs?: {
    commonLangDir?: string
    commonHooksDir?: string
    commonScriptsDir?: string
  }
}

export interface ProposalPacketResult {
  ok: boolean
  txId: string
  packetDir: string
  packetPath: string
  launched: boolean
  autoExitSeconds: number
  sanitizedSummaries: {
    rel: string
    publicPath: string
    attentionCount: number
    sanitizedDiff: string
  }[]
  snapshotsByRel: Map<string, { gOld: string; gNew: string; u: string }>
  error?: string
}

/**
 * W2 起票パケットを組み立て、一時ディレクトリに書き込んで Claude Code を起動する (AC3, AC7)。
 */
export async function createProposalPacketAndLaunch(
  opts: CreateProposalPacketOptions
): Promise<ProposalPacketResult> {
  const txId = opts.txId ?? randomBytes(6).toString('hex')
  const goldenDir = opts.goldenRootDir ?? getGoldenDir()
  const targetDir = opts.targetDir ?? join(homedir(), '.claude')
  const appVersion = opts.appVersion ?? (app ? app.getVersion() : '1.6.2')

  // 1. source 候補数検査 (AC22)
  const inspection = await inspectSourceCandidates(opts.templateName, goldenDir, opts.dirs)
  for (const rel of opts.proposePaths) {
    const c = inspection.candidatesByRel.get(normalizeRelPath(rel))
    if (!c || c.length !== 1) {
      return {
        ok: false,
        txId,
        packetDir: '',
        packetPath: '',
        launched: false,
        autoExitSeconds: 60,
        sanitizedSummaries: [],
        snapshotsByRel: new Map(),
        error: `source_candidates_invalid: ${rel} (count=${c?.length ?? 0})`
      }
    }
  }

  const snapshotsByRel = new Map<string, { gOld: string; gNew: string; u: string }>()
  const packetSections: string[] = []
  const sanitizedSummaries: {
    rel: string
    publicPath: string
    attentionCount: number
    sanitizedDiff: string
  }[] = []

  for (const rel of opts.proposePaths) {
    const normRel = normalizeRelPath(rel)
    const sourcePath = inspection.candidatesByRel.get(normRel)![0]
    const destPath = join(targetDir, normRel)

    if (!existsSync(sourcePath) || !existsSync(destPath)) {
      return {
        ok: false,
        txId,
        packetDir: '',
        packetPath: '',
        launched: false,
        autoExitSeconds: 60,
        sanitizedSummaries: [],
        snapshotsByRel: new Map(),
        error: `file_not_found: ${rel}`
      }
    }

    const gOld = opts.goldenOldHashes?.get(normRel) ?? ''
    const gNewBuf = await readFile(sourcePath)
    const uBuf = await readFile(destPath)

    const gNew = hashFileBuffer(sourcePath, gNewBuf)
    const u = hashFileBuffer(destPath, uBuf)

    snapshotsByRel.set(normRel, { gOld, gNew, u })

    const publicPath = derivePublicGoldenPath(sourcePath, goldenDir)
    const rawDiff = createUnifiedDiff(normRel, uBuf, gNewBuf)

    const sanitized = sanitizeProposalContent(
      {
        publicPath,
        template: opts.templateName,
        appVersion,
        gOldHash: gOld,
        gNewHash: gNew,
        uHash: u
      },
      rawDiff
    )

    sanitizedSummaries.push({
      rel: normRel,
      publicPath,
      attentionCount: sanitized.pointsOfAttention.length,
      sanitizedDiff: sanitized.sanitizedDiff
    })

    const attentionPointsText =
      sanitized.pointsOfAttention.length > 0
        ? sanitized.pointsOfAttention.map((p) => `  - Line ${p.line}: ${p.content}`).join('\n')
        : '  (なし)'

    const notesText =
      sanitized.claudeCodeNotes.length > 0
        ? sanitized.claudeCodeNotes.map((n) => `  - ${n}`).join('\n')
        : '  (なし)'

    packetSections.push(`
## 対象ファイル: ${normRel}

### [Issue 本文に載せてよい情報]
${sanitized.metadataText}

#### Unified Diff (U vs G_new)
\`\`\`diff
${sanitized.sanitizedDiff}
\`\`\`

### [Claude Code 向け参照情報（Issue には載せないこと）]
- local_source_path: ${sourcePath}
- local_dest_path: ${destPath}
- points_of_attention:
${attentionPointsText}
- notes:
${notesText}
`)
  }

  // パケット置き場
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const packetDir = join(app?.getPath ? app.getPath('temp') : homedir(), `ccpit-golden-proposal-${stamp}-${txId}`)
  const packetPath = join(packetDir, 'propose-upstream.md')

  const fullPrompt = `# CCPIT Golden Proposal Packet (TX: ${txId})

${packetSections.join('\n\n---\n')}

## [実行手順と厳格な順序 (AC7)]
1. 反映完了記録の待機:
   同ディレクトリに \`promote-result-${txId}.json\` が作成されるまで 1 秒間隔で待機してください（待機上限: 60 秒）。
   待機上限を超えても記録ファイルが現れない場合は、「反映の完了を確認できなかった」として起票を行わず、人に伝えて終了してください。
2. 終端記録の確認:
   記録ファイルを確認し、status が "complete" かつ全対象 rel が成功している場合のみ起草へ進んでください。
   1 件でも失敗（ok: false）がある場合は、起票を行わず、失敗したファイルと理由を人に伝えて終了してください。
3. 重複 Issue の検索:
   \`gh issue list --repo VTRiot/ccpit-win --state all --search "<対象スキルまたは公開パス> in:title,body"\` を実行し、既存提案を検索してください。
   重複する Issue が存在する場合は、新規起票を行わず既存 Issue へのコメント追加を人に提案してください。
4. Issue 本文の起草と明示承認:
   diff を読み、何が良くなるかを日本語で起草してください。
   points_of_attention（確認ポイント）が存在する場合は、その行を先に示して判断を仰いでください。
   起草した Issue 本文を diff 本文を含む全文で端末の人に見せ、明示的な「起票してよい」の承認を得てください。
5. 起票の実行:
   人が承認した場合のみ起票してください。
   - gh が利用可能かつ認証済みな場合:
     \`gh issue create --repo VTRiot/ccpit-win --title "<タイトル>" --body "<本文>" --label "golden-proposal"\`
     ※ラベル golden-proposal が存在しないエラーとなった場合は、ラベルなしで起票し、人に「ラベル golden-proposal 未作成」と報告してください。
   - gh が利用不可・未認証な場合:
     起草した本文を同ディレクトリの \`proposal-issue-body.md\` に保存し、
     ブラウザで \`https://github.com/VTRiot/ccpit-win/issues/new\` を開き、保存した本文を貼り付けるよう人に案内してください（URL に本文を含めないこと）。
`

  // ディレクトリ作成とパケット書き込み
  const { mkdir } = await import('fs/promises')
  await mkdir(packetDir, { recursive: true })
  await writeFile(packetPath, fullPrompt, 'utf8')

  // Claude Code 起動
  let launched = false
  try {
    const launchRes = launchCc({
      projectPath: packetDir,
      flags: ['--prompt-file', packetPath]
    })
    launched = Boolean(launchRes.spawned)
    if (!launchRes.spawned) {
      return {
        ok: false,
        txId,
        packetDir,
        packetPath,
        launched: false,
        autoExitSeconds: 60,
        sanitizedSummaries,
        snapshotsByRel,
        error: launchRes.error
      }
    }
  } catch (err: unknown) {
    return {
      ok: false,
      txId,
      packetDir,
      packetPath,
      launched: false,
      autoExitSeconds: 60,
      sanitizedSummaries,
      snapshotsByRel,
      error: err instanceof Error ? err.message : 'launch_failed'
    }
  }

  return {
    ok: true,
    txId,
    packetDir,
    packetPath,
    launched,
    autoExitSeconds: 60,
    sanitizedSummaries,
    snapshotsByRel
  }
}

/**
 * 反映完了記録を一時ファイル → rename で原子的確定する (AC20, Codex [4])。
 */
export async function commitProposalResult(opts: {
  packetDir: string
  txId: string
  results: { rel: string; ok: boolean; reason?: string }[]
}): Promise<boolean> {
  const targetFile = join(opts.packetDir, `promote-result-${opts.txId}.json`)
  const tmpFile = `${targetFile}.tmp`

  const payload = JSON.stringify(
    {
      status: 'complete',
      txId: opts.txId,
      completedAt: new Date().toISOString(),
      results: opts.results
    },
    null,
    2
  )

  try {
    await writeFile(tmpFile, payload, 'utf8')
    await rename(tmpFile, targetFile)
    return true
  } catch {
    // 書き込み失敗時のクリーンアップ
    await unlink(tmpFile).catch(() => {})
    return false
  }
}

/* ------------------------------------------------------------------ *
 * W3: アンドゥ・overlay 反映調停サービス (AC10, AC21, Codex [12])
 * ------------------------------------------------------------------ */

export interface RestoreUndoRequest {
  rel: string
  generationStamp: string
}

export interface RestoreUndoResult {
  rel: string
  status: 'restored_and_promoted' | 'restored_overlay_failed' | 'not_restored'
  reason?: string
}

/**
 * 指定されたパス群のバックアップを復元し、overlay へ反映して台帳を更新する (AC10, AC21)。
 */
export async function restoreUndoAndPromote(opts: {
  parcFermeDir: string
  targetDir?: string
  templateName?: string
  requests: RestoreUndoRequest[]
}): Promise<RestoreUndoResult[]> {
  const targetDir = opts.targetDir ?? join(homedir(), '.claude')
  const results: RestoreUndoResult[] = []

  // 1. 世代一覧を取得して期待ハッシュを導出 (Codex [2])
  const generations = await listUndoGenerations({
    parcFermeDir: opts.parcFermeDir,
    targetDir
  })

  const manifest = await readManifest(getManifestPath(opts.parcFermeDir))
  if (!manifest) {
    return opts.requests.map((r) => ({
      rel: r.rel,
      status: 'not_restored',
      reason: 'manifest_not_found'
    }))
  }

  const overlayIndex = await readOverlayIndex(opts.parcFermeDir)
  const priorOverlayLookup = buildOverlayLookup(overlayIndex.entries)
  const goldenDir = getGoldenDir()
  const bundledFiles = await collectBundledGoldenFiles(opts.templateName ?? manifest.template)

  for (const req of opts.requests) {
    const normRel = normalizeRelPath(req.rel)

    // 各 rel ごとに最新世代を探索 (Codex 指摘)
    let latestGenForRel: UndoGenerationGroup | undefined
    for (const g of generations) {
      if (g.files.some((f) => f.rel === normRel)) {
        latestGenForRel = g
        break
      }
    }

    if (!latestGenForRel || req.generationStamp !== latestGenForRel.generationStamp) {
      results.push({
        rel: normRel,
        status: 'not_restored',
        reason: 'older_generation'
      })
      continue
    }

    // 最新世代での該当ファイル情報を探索
    const targetFileEntry = latestGenForRel.files.find((f) => f.rel === normRel)
    if (!targetFileEntry || !targetFileEntry.canRestore) {
      results.push({
        rel: normRel,
        status: 'not_restored',
        reason: targetFileEntry?.notRestorableReason ?? 'not_restorable'
      })
      continue
    }

    const expectedBackupHash = targetFileEntry.backupHash
    const expectedDestHash = targetFileEntry.currentHash ?? ''

    // 2. 復元低レベルプリミティブを実行
    const restoreRes = await restoreUndoBackupPrimitive({
      parcFermeDir: opts.parcFermeDir,
      targetDir,
      rel: normRel,
      generationStamp: req.generationStamp,
      expectedBackupHash,
      expectedDestHash
    })

    if (!restoreRes.ok) {
      results.push({
        rel: normRel,
        status: 'not_restored',
        reason: restoreRes.reason
      })
      continue
    }

    // 3. 復元された手元版の内容を読み取り、overlay へ反映
    const destPath = join(targetDir, normRel)
    let content: Buffer
    try {
      content = await readFile(destPath)
    } catch (err: unknown) {
      results.push({
        rel: normRel,
        status: 'restored_overlay_failed',
        reason: `read_restored_failed: ${err instanceof Error ? err.message : String(err)}`
      })
      continue
    }

    // 同梱 golden の実 sourcePath を導出 (Codex 指摘: common フック・言語・スクリプトを正しく解決)
    const bundledSourcePath =
      bundledFiles.get(normRel) ?? join(goldenDir, opts.templateName ?? manifest.template, normRel)
    const bundledHash = await hashFileAt(bundledSourcePath)

    try {
      const promoteRes = await promoteOverlayFile({
        parcFermeDir: opts.parcFermeDir,
        rel: normRel,
        content,
        bundledSourcePath
      })

      // 4. derivedFromGoldenHash の一意導出 (Codex [12])
      const oldEntry = manifest.entries.find((e) => normalizeRelPath(e.path) === normRel)
      const derivedFrom = derivedFromForPromote(oldEntry, priorOverlayLookup)

      const curIndex = await readOverlayIndex(opts.parcFermeDir)
      const existingIdx = curIndex.entries.findIndex((e) => normalizeRelPath(e.path) === normRel)
      const overlayEntry: OverlayEntry = {
        path: normRel,
        promotedAt: new Date().toISOString(),
        contentHash: promoteRes.contentHash,
        baseGoldenHash: bundledHash ?? promoteRes.contentHash,
        derivedFromGoldenHash: derivedFrom
      }
      if (existingIdx >= 0) {
        curIndex.entries[existingIdx] = overlayEntry
      } else {
        curIndex.entries.push(overlayEntry)
      }
      await writeOverlayIndex(opts.parcFermeDir, curIndex)

      // 5. 台帳（manifest）の更新（次回起動で再提示されないよう更新・AC10）
      const nowIso = new Date().toISOString()
      manifest.entries = manifest.entries.filter((e) => normalizeRelPath(e.path) !== normRel)
      manifest.entries.push({
        path: normRel,
        owner: 'promoted',
        goldenHash: promoteRes.contentHash,
        postHash: promoteRes.contentHash, // AC21
        deployedAt: nowIso
      })
      await writeManifest(getManifestPath(opts.parcFermeDir), manifest)

      results.push({
        rel: normRel,
        status: 'restored_and_promoted'
      })
    } catch (err: unknown) {
      results.push({
        rel: normRel,
        status: 'restored_overlay_failed',
        reason: err instanceof Error ? err.message : String(err)
      })
    }
  }

  return results
}

export const prepareAndLaunchProposalPacket = createProposalPacketAndLaunch
