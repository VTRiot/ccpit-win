import { readdir, readFile, stat, lstat, mkdir, writeFile } from 'fs/promises'
import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync, rmSync, lstatSync, statSync, mkdirSync } from 'fs'
import { join, dirname, basename, resolve, relative, isAbsolute } from 'path'
import { createHash, randomBytes } from 'crypto'
import { app } from 'electron'
import { spawn, spawnSync } from 'child_process'
import { tmpdir, hostname, homedir } from 'os'

import {
  MANIFEST_VERSION,
  StaleDestinationError,
  backupAndReplace,
  computeSetHash,
  getManifestPath,
  hashFileAt,
  hashFileBuffer,
  isHashExcluded,
  isSkippedFile,
  normalizeRelPath,
  readManifest,
  toGoldenBytes,
  writeManifest,
  acquireManifestLock,
  releaseManifestLock,
  type GoldenManifest,
  type ManifestEntry
} from './goldenManifest'
import {
  bundledBaseHashOf,
  buildOverlayLookup,
  readOverlayIndex,
  type OverlayEntry
} from './goldenOverlay'
import { KNOWN_TEMPLATES } from './denyValidation'
import { performance } from 'perf_hooks'
import { perfEnabled, perfRecord } from './perfTrace'
import { ledgerCatchupConfirmationString, sameSkillSet } from '../../shared/ledgerCatchupConfirmation'
import {
  ISOLATED_GOLDEN_REPO_ENV_VAR,
  checkIsolatedGoldenRepo,
  getIsolationStatus,
  isIsolatedLaunch,
  realish,
} from '../isolation'
import {
  evaluateAdoptGateFromRaw,
  setProposalState,
  readProposalStates,
  readProposalReviews,
  getDefaultProposalStorePaths,
  parseProposedFilesFromSection3,
  maskFencedCodeBlocks,
  type ProposalStorePaths
} from './skillProposals'
import {
  composeCatchUp,
  composePostPromotion,
  composePreflight,
  deriveComposeHolds,
  getComposePaths,
  lookupHold,
  lookupHoldAnySkill,
  isCompositeActive,
  parseSupersedes,
  readMergeLedger,
  type MergeApplication,
  type SnapshotFile
} from './composeLedger'
import { contentHash as composeContentHash } from './composeHash'
import { skillNameFromProposalTarget } from './proposalTarget'
import {
  GoldenGitReadError,
  HEAD_REF,
  checkLease,
  checkRef,
  isInsideGitRepo,
  readGoldenBlob,
  isCommitObjectOrThrow,
  isGoldenGitReadError,
  readGoldenBlobOrThrow,
  readGoldenText,
  readGoldenTextOrThrow,
  resolveHead,
  runGoldenGit
} from './goldenGitRead'
import { withFileLock } from './composeFileLock'
import {
  ABSENT,
  checkMatchesPost,
  listFilesRecursive,
  NONFILE,
  preApplyDirOf,
  readCopy,
  readPostApply,
  readPreApply,
  recordPostApply,
  restoreEntry,
  savePreApply,
  sha256OfFile,
  type PreApplyTarget
} from './composePreApply'

export type GoldenTemplateName = (typeof KNOWN_TEMPLATES)[number]

export const CONTRACT_EFFECTIVE_DATE_ISO = '2026-09-15T20:30:00+09:00'
export const CONTRACT_EFFECTIVE_MS = new Date(CONTRACT_EFFECTIVE_DATE_ISO).getTime()

/**
 * スキル付随ファイルの最大許容サイズ（10MB）。
 * 通常のスキル資材（README, テストスクリプト, アイコン等）を安全に運搬しつつ、
 * 巨大バイナリや誤混入した学習データ等の事故混入を未然に防止する上限。
 */
export const MAX_COMPANION_FILE_SIZE_BYTES = 10 * 1024 * 1024

/**
 * Git 三者照合における先祖コミットの探索深度上限（20コミット）。
 * 直近の開発イテレーションにおける golden 先行（stale-local）状態を検知するのに十分な窓サイズ。
 * この探索窓（20件）を超えて乖離した古いローカルファイルは、先祖特定不能として安全側に
 * `diverged`（双方変更・競合）に倒れ、goldenMergeConsult への誘導（fail-closed）が行われる。
 */
export const LINEAGE_ANCESTOR_DEPTH = 20

/**
 * 契約 CLI ずれ検知（detectContractCliLedgerDrift）におけるコミット探索深度上限（50件）。
 * `--grep=Applied-by:` で絞り込んだ契約 CLI 反映コミットを直近から遡る窓サイズ。
 * 通常運用において台帳未記録の契約 CLI コミットが 50 件蓄積する前に台帳同期（追補）が
 * 行われる前提であり、全コミットの無制限全走査による起動時遅延（ADR 0002 方針）を回避する設計。
 * 50 件を超過した未記録コミットが存在した場合でも、直近 50 件の追補後に再走査されることで
 * 順次追補対象として窓内に出現する。
 */
export const CONTRACT_CLI_SCAN_DEPTH = 50

/**
 * 救済（rescue: 裏口コミット捕獲）における golden コミット探索深度上限（50件）。
 * 直近の golden コミットから救済候補のスキルコミットを走査する窓サイズ。
 */
export const RESCUE_SCAN_DEPTH = 50

export type PromotionSource = 'rescue' | 'normal' | 'proposal'
export type PromotionState = 'pending' | 'dismissed' | 'applied_unpushed' | 'distributed'
export type GoldenDiffState =
  | 'new'
  | 'modified'
  | 'identical'
  | 'stale-local'
  | 'diverged'
  | 'proposal-conflict'

export type SkippedFileReason =
  | 'bak-file'
  | 'os-vcs-artifact'
  | 'size-exceeded'
  | 'symlink-or-special'
  | 'pending-translation'

export interface SkippedFileInfo {
  relPath: string
  reason: SkippedFileReason
  size: number
}

export interface ExtraGoldenFileInfo {
  relPath: string
  size: number
}

export interface SkillDetailInfo {
  name: string
  title: string
  description: string
  what?: string
  why?: string
  how?: string
  rawContent?: string
}

/** 提案競合の相手 1 件。人間が「Skill 候補ブラウザ」で探し当てられる手がかりと、走査時点の提案側の状態を持つ */
export interface ProposalConflictPeer {
  id: string // 候補の id（`proposal:<スキル>:<本文ハッシュ 12 桁>`）
  requestId: string
  title: string
  addedAt: string
  hash12: string
  filePath: string
  proposalState: string // 提案側の状態（candidate・held など。ストアに無ければ candidate）
}

export interface PromotionItem {
  id: string // 一意キー: `${source}:${skillName}` または proposal 時は `${source}:${skillName}:${hash12}`
  title: string // 日本語の題名（何の物か）
  skillName: string // skill名（ディレクトリ名）
  addedAt: string // 追加日（YYYY-MM-DD または ISO8601）
  source: PromotionSource // 入口の種別: 'rescue' | 'normal' | 'proposal'
  state: PromotionState // 状態: 'pending' | 'dismissed' | 'applied_unpushed' | 'distributed'
  diffState?: GoldenDiffState // golden との差: 'new' | 'modified' | 'identical' | 'stale-local' | 'diverged' | 'proposal-conflict'
  targetPath: string // 配置先相対パス（例: 'ccpit/golden/common/ja/skills/foo'）
  localPath: string // ローカルパス（例: 'C:/Users/.../.claude/skills/foo'）
  description: string // 中で何をしとるか（取れんものは「不明」）
  diffSummary?: string // 差分サマリ
  diffDetail?: string // Unified diff 全文詳細プレビュー (F-3)
  skillDetail?: SkillDetailInfo // スキル構造化情報 (F-3: What/Why/How)
  isAdopted?: boolean // CCPIT adopted-skills.json に登録されているか (F-5)
  authorStatement: string // 入れた本人の弁（コミットメッセージ等。取れんものは「不明」）
  lane: string // どのレーンが入れたか（Lane: トレーラ。取れんものは「不明」）
  viewed: boolean // 右ペインで開かれたことがあるか
  promotedAt?: string // 反映日時
  commitSha?: string // 反映時コミットSHA
  capturedContent?: string // 救済アイテム等で裏口コミットから捕獲したファイル内容 (契約 r19 §3-5 段 1)
  skippedFiles?: SkippedFileInfo[] // 運ばれなかった付随ファイル (W1)
  extraGoldenFiles?: ExtraGoldenFileInfo[] // golden 側にのみ存在する余剰ファイル (軽微 3)
  proposalRequestId?: string // CC 提案の requestId (W2)
  proposalHash?: string // CC 提案 MD 本文ハッシュ (W2 / TOCTOU)
  proposalFilePath?: string // CC 提案 MD ファイル絶対パス (W2)
  proposalAckBinding?: { proposalHash: string; findingsHash: string; adjudicationsKey: string }
  isConflicted?: boolean // 複数 proposal 競合フラグ (W2)
  conflictCount?: number // 競合している提案の本数（自分を含む）
  conflictPeers?: ProposalConflictPeer[] // 競合の相手（自分を含まない）
  diverged?: boolean // golden と双方変更フラグ (W3)
  companionFilesCount?: number // 付随ファイル数
  /** 合成提案（`supersedes` を持つ）が有効なとき、その元提案の request_id。この提案が代わりに昇格される */
  composeSources?: string[]
  /** 元提案が、有効な合成提案に置き換えられているとき、その合成提案の request_id。個別には昇格できない */
  composedInto?: string
  /**
   * 合成を始めるとき元提案に選ばれなかった提案が、合成提案の昇格を待っているとき、その合成提案の request_id。
   * 合成提案が昇格を完了する（または却下される）まで、競合の母数から外れ、個別には昇格できない。提案ファイルと状態は書き換えない
   */
  composeWaitingFor?: string
  /**
   * 元提案が、登録済みだがまだ有効でない（未 approve など）合成提案の元になっているとき、その合成提案の request_id。
   * 表示専用: 画面は取り込み済みとして押せなくする（承認時の合成遮断が止めるのと同じ）。競合の母数は変えない
   */
  composeHeldBy?: string
  /**
   * golden を git から読めなかったため、この行の判定（系譜・元の版・救済の内容）が確かでない（CCPIT_L0_010）。
   * 健全時はキーごと無い。立っている行は反映できない（反映は「読めませんでした」の理由で止める）。理由は diffSummary
   */
  gitReadError?: boolean
  /**
   * 握っている合成提案が異常で、通常の却下では解けない状態: `missing`＝MD が提案プールに見つからない、
   * `changed`＝登録時の sha256 と一致する MD が無い（登録後に書き換わった）、
   * `adopted`＝台帳が registered のまま合成提案が adopted（反映が確認できない）。握りは解けず、「合成を破棄」で解く
   * （元提案・選ばなかった提案のどちらにも付く）
   */
  composeHoldAbnormal?: 'missing' | 'changed' | 'adopted'
}

export interface GoldenDeployedSkill {
  name: string
  title: string
  description: string
  jaPath: string
  enPath: string
  hasEn: boolean
  status: 'deployed' | 'withdrawn'
  detail: SkillDetailInfo
  promotedAt?: string
  withdrawnAt?: string
  ledgerMismatch?: boolean // 台帳と実体のハッシュ不一致 (W3)
  mismatchedFiles?: Array<{ path: string; ledgerHash: string; actualHash: string }>
}

export interface DeployedSkillsResult {
  skills: GoldenDeployedSkill[]
  ledgerCorrupt?: boolean
  ledgerError?: string
}

export interface GoldenLedgerFileRecord {
  path: string // 相対パス (例: 'SKILL.md', 'md2html.cjs')
  hash: string // 鏡写し計算された sha256
  status: 'present' | 'deleted'
}

export interface GoldenLedgerEntry {
  name: string
  target: string
  hash: string
  promotedAt: string
  source: PromotionSource
  goldenVersionAtPromotion: string
  action?: 'contract-preexisting' | 'promoted' | 'withdrawn' | 'restored' | 'contract-applied'
  sourceCommitSha?: string // 契約 CLI コミット SHA (重複排除・冪等キー)
  catchupCommits?: string[] // 追補済みコミット SHA 群（Z-3: 再出現防止・因果追跡）
  files?: GoldenLedgerFileRecord[] // skill 内の全付随ファイル完全性記録 (W1, W3)
  history?: {
    originalRecord?: string
    lane?: string
    originalDate?: string
  }
}

export interface GoldenLeaseBlob {
  lane: string
  issued_by: string
  issued_at: string
  expires_at: string
  manifest_sha256: string
  base_master: string
  session8: string
}

export interface PromotionRunRecord {
  runId: string
  pid: number
  lane: string
  manifestSha256: string
  leaseId?: string
  currentStep?: { i: number; n: number; name: string }
  startedAt: string
  lastHeartbeatAt: string
  endedAt?: string
  endedAtSource?: string
  endedAtNote?: string
  exitCode?: number
  repoDir: string
  hostname: string
  /**
   * 持ち主の記録（CCPIT_L0_004 W3）。契約実行ツールを起動する**前**に保存する。
   * 清掃は、この記録と完全に一致するブランチ・worktree だけを「CCPIT の昇格が作った物」として消す。
   * 改修前の記録には無い（その場合は leaseId の blob から session8 を復元できたときだけ対象にする）
   */
  session8?: string
  goldenApplyBranch?: string
  worktreePrefix?: string
}

export interface PromotionProgressEvent {
  runId: string
  stepIndex: number
  totalSteps: number
  stepName: string
  timestamp: string
  leaseId?: string
}

export interface PromotionArtifactCleanupResult {
  cleanedWorktrees: string[]
  cleanedBranches: string[]
  cleanedTempDirs: string[]
  /** 持ち主（CCPIT の昇格の記録）を確かめられず、消さずに残した worktree・ブランチ（CCPIT_L0_004 W3） */
  keptUnknownOwner: string[]
}

export interface GoldenLeaseStatus {
  exists: boolean
  leaseId?: string
  blob?: GoldenLeaseBlob
  rawContent?: string
  parseError?: string
  isExpired?: boolean
  remainingSeconds?: number
  expiresAtIso?: string
  currentMasterMatches?: boolean
  currentMaster?: string
  orphanedWorktrees?: Array<{ path: string; branch: string }>
  /**
   * リース・blob・master のどれかを git から読めなかった理由（CCPIT_L0_014）。健全時はキーごと無い。
   * あるとき、`exists: false` は「リースが無い」ではなく「確かめられなかった」で、解放・清掃はこの理由で止める
   */
  readError?: string
  /** 残置 worktree の一覧を git から読めなかった理由（CCPIT_L0_014）。あるとき `orphanedWorktrees` の空は「0 件」ではない */
  worktreeReadError?: string
  matchingRunRecord?: PromotionRunRecord
  isOwnerAlive?: boolean
  earlyReleaseEntitlement?: {
    entitled: boolean
    reason?: string
    runningRunId?: string
    runningPid?: number
    reconciledRunIds?: string[]
  }
}

interface StoredPromotionState {
  items: Record<
    string,
    {
      state: PromotionState
      viewed: boolean
      promotedAt?: string
      commitSha?: string
      capturedContent?: string
      targetRel?: string
      hash?: string
    }
  >
}

const CCPIT_DIR = join(homedir(), '.ccpit')
const STATE_FILE = join(CCPIT_DIR, 'golden-promotion-state.json')
const WITHDRAWN_DIR = join(CCPIT_DIR, 'golden-withdrawn-skills')
const PROMOTION_RUNS_DIR = join(CCPIT_DIR, 'golden-promotion-runs')

/** クラッシュ・孤立実行と認定するための最小ハートビート停止時間（30秒） */
export const ORPHAN_HEARTBEAT_STALE_MS = 30_000

/** 排他制御: 契約実行ツールが多重実行されるのを防ぐロック */
let isPromotionApplying = false

interface EarlyReleaseChallenge {
  leaseId: string
  token: string
  expiresAtMs: number
}
let activeEarlyReleaseChallenge: EarlyReleaseChallenge | null = null

/** 早期解放ワンタイム承認チャレンジの発行 (追補条項 L-b(iii)) */
export function createEarlyReleaseChallenge(leaseId: string): string {
  const token = randomBytes(16).toString('hex')
  activeEarlyReleaseChallenge = {
    leaseId,
    token,
    expiresAtMs: Date.now() + 60 * 1000, // 60秒有効
  }
  return token
}

/** 早期解放ワンタイム承認チャレンジの検証・消費 (追補条項 L-b(iii) 操作ごとの個別承認) */
export function consumeEarlyReleaseChallenge(leaseId: string, token: string): boolean {
  if (!activeEarlyReleaseChallenge) return false
  if (activeEarlyReleaseChallenge.leaseId !== leaseId) return false
  if (activeEarlyReleaseChallenge.token !== token) return false
  if (Date.now() > activeEarlyReleaseChallenge.expiresAtMs) {
    activeEarlyReleaseChallenge = null
    return false
  }
  activeEarlyReleaseChallenge = null // ワンタイム消費
  return true
}

/**
 * リポジトリルートを安全に探索
 *
 * 隔離起動中は、launcher が隔離 root の中に作った複製（CCPIT_ISOLATED_GOLDEN_REPO）だけを返す。
 * 値が無い・不正なら例外で止め、下の通常の探索には落とさない（CCPIT_L0_004 W8。落ちると本物の CCPIT を動かす）。
 */
export function findRepoRootDir(): string {
  if (isIsolatedLaunch()) {
    const root = getIsolationStatus().root ?? ''
    const verdict = checkIsolatedGoldenRepo(process.env[ISOLATED_GOLDEN_REPO_ENV_VAR], root, {
      canonicalize: realish,
      exists: existsSync,
    })
    if (!verdict.ok) throw new Error(`[CCPIT-Isolation] ${verdict.reason}`)
    return verdict.repo
  }
  const candidates = [
    process.cwd(),
    join(process.cwd(), '..'),
    app?.getAppPath ? app.getAppPath() : '',
    app?.getAppPath ? join(app.getAppPath(), '..') : '',
    app?.getAppPath ? join(app.getAppPath(), '..', '..') : '',
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (existsSync(join(candidate, '.git')) && existsSync(join(candidate, 'ccpit', 'golden'))) {
      return candidate
    }
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, '.git')) && existsSync(join(candidate, 'golden'))) {
      return candidate
    }
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, '.git'))) {
      return candidate
    }
  }
  return process.cwd()
}

/** golden ルートディレクトリを安全に探索 */
export function findGoldenRootDir(repoDir: string = findRepoRootDir()): string {
  const candidates = [
    join(repoDir, 'ccpit', 'golden'),
    join(repoDir, 'golden'),
    join(process.cwd(), 'golden'),
    join(process.cwd(), 'ccpit', 'golden'),
    join(process.cwd(), '..', 'ccpit', 'golden'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return join(repoDir, 'ccpit', 'golden')
}

/**
 * リポジトリ内の golden 配下（ccpit/golden/common 等）を走査し、
 * 現配布 golden に含まれる相対パス集合（writeLedger スコープ）を収集するヘルパー。
 */
export function collectGoldenRels(repoDir: string = findRepoRootDir()): Set<string> {
  const root = findGoldenRootDir(repoDir)
  const rels = new Set<string>()
  if (!existsSync(root)) return rels

  function walk(dir: string, baseRel: string) {
    if (!existsSync(dir)) return
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const rel = baseRel ? `${baseRel}/${entry.name}` : entry.name
      const norm = normalizeRelPath(rel)
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), norm)
      } else if (entry.isFile()) {
        if (!isSkippedFile(norm) && !isHashExcluded(norm)) {
          // targetDir 基準の相対パス（例: skills/foo/SKILL.md）へ正規化
          const skillMatch = norm.match(/(?:^|\/)(?:common\/(?:ja|en)\/)?(skills\/.+)$/)
          if (skillMatch) {
            rels.add(normalizeRelPath(skillMatch[1]))
          } else {
            rels.add(norm)
          }
        }
      }
    }
  }

  walk(root, '')
  return rels
}

/** SHA-256 計算ヘルパー */
export function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').toLowerCase()
}

export function sha256String(str: string): string {
  return createHash('sha256').update(Buffer.from(str, 'utf-8')).digest('hex').toLowerCase()
}

/** 改行コード正規化: CRLF→LF（Windows 作業コピーの smudge を吸収） */
export function normalizeEol(content: string): string {
  return content.replace(/\r\n/g, '\n')
}

/** 正規化後 SHA-256: golden 配布物の「対象ファイル内容」系ハッシュ（expected_sha256 / base_sha256）は
 *  必ずこれを経由する。patch_sha256（パッチ本体自身の完全性）や MANIFEST 自身のハッシュには使わない。 */
export function sha256NormalizedString(content: string): string {
  return sha256String(normalizeEol(content))
}

/**
 * 対象パスが EOL 正規化対象かどうかを判定（契約 CLI golden-apply.mjs と鏡写し）。
 * .md または .json のみ正規化対象。他（.cjs, .js, .sh, .py, バイナリ等）は生バイト扱い。
 */
export function isEolNormalizedTarget(targetPath: string): boolean {
  return /\.(md|json)$/i.test(targetPath)
}

/**
 * Buffer を latin1 経由で CRLF→LF 正規化して SHA-256 を計算（契約 CLI golden-apply.mjs と完全一致）。
 */
export function sha256NormalizedBuffer(buf: Buffer): string {
  return sha256Buffer(Buffer.from(normalizeEol(buf.toString('latin1')), 'latin1'))
}

/**
 * 契約 CLI と鏡写しのルールで対象ファイルの golden ハッシュを計算。
 */
export function computeGoldenTargetHash(targetRelPath: string, buf: Buffer): string {
  if (isEolNormalizedTarget(targetRelPath)) {
    return sha256NormalizedBuffer(buf)
  }
  return sha256Buffer(buf)
}

/**
 * 「同じ中身か」を比べるための指紋（069 発注 3）: golden に書かれるバイト（テキストは LF）にそろえてから
 * `computeGoldenTargetHash`。改行だけが違うファイルは同じ値になる（`.js` `.txt` `.cjs` も。起動時の照合の
 * `hashFileBuffer` と同じ結論）。patch の `base_sha256`/`expected_sha256` は**この関数ではなく**、
 * LF にそろえた後のバイトへの `computeGoldenTargetHash`（契約の道具の鏡写し）を使う。
 */
export function computeGoldenContentHash(targetRelPath: string, buf: Buffer): string {
  return computeGoldenTargetHash(targetRelPath, toGoldenBytes(targetRelPath, buf))
}

/** 契約の道具が検証する値（patch の base/expected と golden 台帳の `files`）。配置の記録の指紋と混ぜて使わない。 */
export type ContractSha = string & { readonly __brand: 'ContractSha' }
/** 配置の記録（golden-manifest.json）の `goldenHash`・`postHash` と同じ決まりの値（`hashFileBuffer`）。 */
export type ManifestHash = string & { readonly __brand: 'ManifestHash' }

/** 1 ファイルを golden へ運んだ結果（3 つの道が共通で受け取る）。 */
export interface CarriedFile {
  relPath: string
  contractSha: ContractSha
  manifestHash: ManifestHash
  /** golden へ入れたバイト（LF にそろえた後）。提案の道が、この PC の写しを同じ版にするときの書き込み元 */
  newBytes: Buffer
  /** 基底コミットの golden の中身の指紋（`hashFileBuffer`）。golden に無かったファイルは null */
  oldHash: ManifestHash | null
}

/** この PC の写し 1 ファイルの扱い（提案から golden へ上げた後、写しを同じ版にそろえる段の判定） */
export type LocalCopyOutcome =
  | 'created'
  | 'updated'
  | 'already-same'
  | 'kept-user-change'
  | 'skipped-language'
  | 'failed'

export interface LocalCopyReportEntry {
  skillName: string
  relPath: string
  outcome: LocalCopyOutcome
  /** 書き換える前の写しの控え（`updated` のとき） */
  backupPath?: string
  /** 書かなかった・失敗した理由 */
  reason?: string
}

/**
 * 写し 1 ファイルの判定（純関数）。指紋はすべて `hashFileBuffer` の決まり（テキストは改行を LF にそろえた内容）。
 * 写しが「golden の過去の版のどれかと同じ」場合だけ上書きしてよい（golden から来た版のままで、利用者の変更が無い）。
 * それ以外は迷わず書かない。`oldHashes` は基底 commit の版と、必要なら golden の履歴の過去の版。
 * - 写しが無い → created
 * - 写し = 新しい版 → already-same
 * - 写し = 過去の golden の版 → updated
 * - 上のどれでもない・通常のファイルでない（destHash が null）→ kept-user-change
 */
export function decideLocalCopy(p: {
  exists: boolean
  destHash: string | null
  oldHashes: readonly string[]
  newHash: string
}): Exclude<LocalCopyOutcome, 'failed' | 'skipped-language'> {
  if (!p.exists) return 'created'
  if (p.destHash === null) return 'kept-user-change'
  if (p.destHash === p.newHash) return 'already-same'
  if (p.oldHashes.includes(p.destHash)) return 'updated'
  return 'kept-user-change'
}

/**
 * 日本語版と英語版で中身が違う（golden の en 側が別の内容になる）ファイルか。SKILL.md と付随の `.md`。
 * 実行体（`.cjs` など）は ja と en で同じバイトなので、どの言語の PC にも同じものを置ける。
 */
export function isLanguageDependentFile(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/')
  return norm === 'SKILL.md' || norm.endsWith('.md')
}

/** 写しを書くときの言語。設定を読めなければ、日本語の内容を書かない側（ja 以外）に倒す */
async function readConfiguredLanguage(): Promise<'ja' | 'en'> {
  try {
    // appConfig は読み込み時に app.getPath を呼ぶので、必要なときだけ読む（試験や electron 外では例外になり ja 以外に倒れる）
    const { getConfig } = await import('./appConfig')
    return getConfig().language === 'ja' ? 'ja' : 'en'
  } catch {
    return 'en'
  }
}

/** golden の履歴（基底 commit までの直近 `LINEAGE_ANCESTOR_DEPTH` 件）にある、そのファイルの過去の版の指紋 */
export function collectGoldenHistoryHashes(repoDir: string, baseRef: string, targetRelPath: string): string[] {
  const normRel = targetRelPath.replace(/\\/g, '/')
  const log = spawnSync('git', ['log', baseRef, '-n', String(LINEAGE_ANCESTOR_DEPTH), '--format=%H', '--', normRel], {
    cwd: repoDir,
    encoding: 'utf-8'
  })
  if (log.status !== 0 || !log.stdout.trim()) return []
  const out = new Set<string>()
  for (const sha of log.stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean)) {
    const blob = getGoldenBlobContent(sha, normRel, repoDir)
    if (blob !== null) out.add(hashFileBuffer(normRel, blob))
  }
  return [...out]
}

/**
 * スキルのフォルダの下の相対パスを、書き込み先の絶対パスにする。フォルダの外へ出るもの
 * （`..`・絶対パス・ドライブ指定・空）は null。
 */
export function resolveLocalCopyDest(skillDir: string, relPath: string): string | null {
  const norm = relPath.replace(/\\/g, '/')
  if (norm === '' || norm.startsWith('/') || /^[A-Za-z]:/.test(norm) || norm.includes('\0')) return null
  if (norm.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return null
  const dest = join(skillDir, ...norm.split('/'))
  const rel = relative(skillDir, dest)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return dest
}

/**
 * スキルのフォルダから宛先の親までの、既に在るディレクトリにリンク（symlink・junction）が無いか。
 * リンクを通ると、フォルダの外の実体を退避・置換してしまうため、そのファイルは書かない。
 * 返り値: リンクのパス（あれば）／無ければ null。
 */
async function findLinkOnPath(skillDir: string, dest: string): Promise<string | null> {
  const parts = relative(skillDir, dirname(dest)).split(/[\\/]/).filter(Boolean)
  const chain = [skillDir]
  for (const seg of parts) chain.push(join(chain[chain.length - 1], seg))
  for (const p of chain) {
    try {
      if ((await lstat(p)).isSymbolicLink()) return p
    } catch (err) {
      // 無い（ENOENT/ENOTDIR）ときだけ「これより下はまだ無い（書くときに作る）」。権限・入出力の失敗はリンクが無い確認にならないので投げる
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      throw err
    }
  }
  return null
}

/**
 * 提案から golden へ上げた後、この PC の写しを同じ版にそろえる（069 発注 5 / M20）。
 * 書いたもの・既に同じもの（`rows`）だけが、配置の記録に載せてよい行。書かなかった・失敗したファイルは載せない
 * （載せると、写しが古いのに記録は新しい版になり、起動時の照合が `unchanged` に隠してしまう）。
 */
export async function syncLocalCopiesForProposal(p: {
  skillName: string
  carried: CarriedFile[]
  targetDir: string
  stagingDir: string
  now?: Date
  /** この PC の配置の言語。日本語でなければ、言語で中身が変わるファイル（SKILL.md・付随の .md）は写しに書かない */
  language: 'ja' | 'en'
  /** 写しが基底 commit の版と違うときだけ呼ぶ。golden の履歴の過去の版の指紋（利用者の変更と古い写しを見分ける） */
  pastHashesOf?: (relPath: string) => string[]
  beforeWriteHook?: (destPath: string) => Promise<void>
}): Promise<{
  report: LocalCopyReportEntry[]
  rows: Map<string, { postHash?: string }>
  /** 写しをそろえられなかった（書かなかった・失敗した）ファイル。記録の行が新しい版を指していれば偽の行なので消す対象 */
  unplaced: Set<string>
}> {
  const report: LocalCopyReportEntry[] = []
  const rows = new Map<string, { postHash?: string }>()
  const unplaced = new Set<string>()
  const skillDir = join(p.targetDir, 'skills', p.skillName)
  let seq = 0
  for (const c of p.carried) {
    const entry = (outcome: LocalCopyOutcome, extra: Partial<LocalCopyReportEntry> = {}): void => {
      report.push({ skillName: p.skillName, relPath: c.relPath, outcome, ...extra })
      if (outcome === 'kept-user-change' || outcome === 'failed' || outcome === 'skipped-language') unplaced.add(c.relPath)
    }
    if (p.language !== 'ja' && isLanguageDependentFile(c.relPath)) {
      entry('skipped-language', {
        reason: `配置の言語が ${p.language} のため、日本語の内容は写しに書かない（起動時の照合が ${p.language} の版を配る）`
      })
      continue
    }
    const dest = resolveLocalCopyDest(skillDir, c.relPath)
    if (dest === null) {
      entry('failed', { reason: 'スキルのフォルダの外を指すパスのため書かない' })
      continue
    }
    try {
      const link = await findLinkOnPath(skillDir, dest)
      if (link !== null) {
        entry('kept-user-change', { reason: `リンク（${link}）を通るため書かない` })
        continue
      }
      let exists = false
      let regular = false
      try {
        const st = await lstat(dest)
        exists = true
        regular = st.isFile()
      } catch {
        /* 無い */
      }
      const destHash = exists && regular ? await hashFileAt(dest) : null
      let decision = decideLocalCopy({
        exists,
        destHash,
        oldHashes: c.oldHash === null ? [] : [c.oldHash],
        newHash: c.manifestHash
      })
      if (decision === 'kept-user-change' && destHash !== null && p.pastHashesOf) {
        decision = decideLocalCopy({ exists, destHash, oldHashes: p.pastHashesOf(c.relPath), newHash: c.manifestHash })
      }
      if (decision === 'kept-user-change') {
        entry('kept-user-change', {
          reason: exists && !regular ? '通常のファイルでないため書かない' : '基底 commit の版とも、配置の記録が示す前回配置の版とも違う（利用者の変更の可能性あり）ため書かない'
        })
        continue
      }
      if (decision === 'already-same') {
        rows.set(c.relPath, {})
        entry('already-same')
        continue
      }
      const src = join(p.stagingDir, 'local-copy', `${p.skillName}-${seq++}`, basename(dest))
      await mkdir(dirname(src), { recursive: true })
      await writeFile(src, c.newBytes)
      if (p.beforeWriteHook) await p.beforeWriteHook(dest)
      const { backupPath, verifiedHash } = await backupAndReplace(
        { sourcePath: src, destPath: dest, expectedDestHash: exists ? destHash : null, eol: 'lf' },
        { now: p.now }
      )
      rows.set(c.relPath, { postHash: verifiedHash })
      entry(decision, backupPath ? { backupPath } : {})
    } catch (err) {
      if (err instanceof StaleDestinationError) {
        entry('kept-user-change', { reason: '書く直前に写しが変わったため書かない' })
      } else {
        entry('failed', { reason: err instanceof Error ? err.message : String(err) })
      }
    }
  }
  return { report, rows, unplaced }
}

/**
 * バックアップファイルかどうかの判定（100% 除外対象）。
 * `.bak` の後ろが `.`・`_`・`-` で続く控え（`SKILL.md.bak.2026…`・`x.bak_20260907`・`SKILL.md.bak-ccpit-lane-20260913`）も除く。
 * 2026-09-28 069 M4: 以前は `.bak-…`・`.bak_…` の形を除かず、ローカルの md-render に残っていた
 * `SKILL.md.bak-ccpit-lane-20260913` を付随ファイルとして走査していた（ローカルから上げると golden に入る）。
 */
export function isBakFile(fileName: string): boolean {
  return (
    /\.(bak(\..*)?|old|orig|tmp|swp)$/i.test(fileName) ||
    /~$/.test(fileName) ||
    /\.bak[._-]/i.test(fileName)
  )
}

/**
 * OS・VCS 固有のアーティファクトかどうかの判定（除外対象）。
 */
export function isOsVcsArtifact(fileName: string): boolean {
  const lower = fileName.toLowerCase()
  return (
    lower === '.ds_store' ||
    lower === 'thumbs.db' ||
    lower === 'desktop.ini' ||
    lower === '.git' ||
    lower.startsWith('.git')
  )
}

export interface ScannedSkillFile {
  relPath: string // スラッシュ区切り (例: "SKILL.md", "scripts/helper.js")
  absPath: string
  size: number
  hash: string // computeGoldenTargetHash
}

export interface SkillFilesScanResult {
  files: ScannedSkillFile[]
  skippedFiles: SkippedFileInfo[]
}

/**
 * スキルディレクトリ配下の全ファイルを再帰走査し、有効ファイルとスキップ理由付き除外ファイルを分離。
 */
export function scanLocalSkillFiles(skillDir: string): SkillFilesScanResult {
  const files: ScannedSkillFile[] = []
  const skippedFiles: SkippedFileInfo[] = []

  if (!existsSync(skillDir)) {
    return { files, skippedFiles }
  }

  function walk(currentDir: string, currentRel: string): void {
    const entries = readdirSync(currentDir, 'utf-8')
    for (const name of entries) {
      const entryAbs = join(currentDir, name)
      const relPath = currentRel ? `${currentRel}/${name}` : name

      // 1. シンボリックリンク / ジャンクションの判定 (lstatSync)
      let lstatObj
      try {
        lstatObj = lstatSync(entryAbs)
      } catch {
        continue
      }

      if (lstatObj.isSymbolicLink()) {
        skippedFiles.push({
          relPath,
          reason: 'symlink-or-special',
          size: 0
        })
        continue
      }

      if (lstatObj.isDirectory()) {
        if (isBakFile(name)) {
          skippedFiles.push({
            relPath,
            reason: 'bak-file',
            size: 0
          })
          continue
        }
        if (isOsVcsArtifact(name)) {
          skippedFiles.push({
            relPath,
            reason: 'os-vcs-artifact',
            size: 0
          })
          continue
        }
        walk(entryAbs, relPath)
      } else if (lstatObj.isFile()) {
        // 2. バックアップファイル
        if (isBakFile(name)) {
          skippedFiles.push({
            relPath,
            reason: 'bak-file',
            size: lstatObj.size
          })
          continue
        }

        // 3. OS/VCS アーティファクト
        if (isOsVcsArtifact(name)) {
          skippedFiles.push({
            relPath,
            reason: 'os-vcs-artifact',
            size: lstatObj.size
          })
          continue
        }

        // 4. サイズ上限（MAX_COMPANION_FILE_SIZE_BYTES: 10MB）
        if (lstatObj.size > MAX_COMPANION_FILE_SIZE_BYTES) {
          skippedFiles.push({
            relPath,
            reason: 'size-exceeded',
            size: lstatObj.size
          })
          continue
        }

        // 正常なファイル
        try {
          const buf = readFileSync(entryAbs)
          const hash = computeGoldenContentHash(relPath, buf)
          files.push({
            relPath,
            absPath: entryAbs,
            size: lstatObj.size,
            hash
          })
        } catch {
          // 読込失敗
        }
      } else {
        // ソケット・パイプ等の特殊ファイル
        skippedFiles.push({
          relPath,
          reason: 'symlink-or-special',
          size: 0
        })
      }
    }
  }

  walk(skillDir, '')
  // パス順でソート（決定論的順序）
  files.sort((a, b) => a.relPath.localeCompare(b.relPath))
  skippedFiles.sort((a, b) => a.relPath.localeCompare(b.relPath))

  return { files, skippedFiles }
}

/**
 * golden 側にのみ存在する余剰ファイルを検知
 */
export function scanExtraGoldenFiles(
  goldenSkillDir: string,
  localRelPaths: Set<string>
): ExtraGoldenFileInfo[] {
  const extraFiles: ExtraGoldenFileInfo[] = []
  if (!existsSync(goldenSkillDir)) {
    return extraFiles
  }

  function walk(currentDir: string, currentRel: string): void {
    let entries: string[] = []
    try {
      entries = readdirSync(currentDir, 'utf-8')
    } catch {
      return
    }
    for (const name of entries) {
      const entryAbs = join(currentDir, name)
      const relPath = currentRel ? `${currentRel}/${name}` : name
      let st
      try {
        st = statSync(entryAbs)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(entryAbs, relPath)
      } else if (st.isFile()) {
        if (!localRelPaths.has(relPath)) {
          extraFiles.push({
            relPath,
            size: st.size
          })
        }
      }
    }
  }

  walk(goldenSkillDir, '')
  extraFiles.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return extraFiles
}

/**
 * base_master のコミットから直接 blob コンテンツを取得（作業ツリーをバイパス）。
 * 確かに無いときは null。git が読めなかったときは `GoldenGitReadError` を投げる（呼び出し元は「無い」と取り違えられない）。
 */
export function getGoldenBlobContent(
  baseMasterSha: string,
  targetRelPath: string,
  repoDir: string = findRepoRootDir()
): Buffer | null {
  // 読めなかった（git の失敗）ときは、`GoldenGitReadError` を投げる。旧は null（＝golden に無い）に化けていた（CCPIT_L0_010）。
  // 確かに無いときだけ null。0 バイトの blob は Buffer（旧と同じ）
  // git のリポジトリの外（.git がどこにも無い）は、従来どおり「無い」（null）。壊れたリポジトリは読めなかった扱いで投げる
  return readGoldenBlobOrThrow(repoDir, baseMasterSha, targetRelPath, {
    maxBuffer: MAX_COMPANION_FILE_SIZE_BYTES,
    noRepoIsAbsent: true
  })
}

/**
 * 候補の走査 1 回分の、golden の ja skills の木の写し（CCPIT_L0_004 W6）。
 *
 * 走査は skill ごとに `git ls-tree`、ファイルごとに `git cat-file` を別のプロセスで起動していた（1 回の表示で 380 回）。
 * Windows では 1 回の起動が 50〜200 ミリ秒かかり、待ち時間の大半を占めていた。ここでは、走査の最初に
 * `ls-tree` を 1 回、`cat-file --batch` を 1 回だけ起動して、同じ commit の木と中身を手元に持つ。
 * 写しは走査 1 回の中だけで使い、次の走査では作り直す（golden の HEAD が変われば中身も変わるため、持ち越さない）。
 */
export interface GoldenSkillsTreeSnapshot {
  /** 写した commit（走査の baseMasterSha と同じときだけ使う） */
  sha: string
  /** `ccpit/golden/common/ja/skills/<name>` → （skill のフォルダからの相対パス → blob と完全な相対パス） */
  bySkillDir: Map<string, Map<string, { blobSha: string; fullRel: string }>>
  /** blob の sha → 中身 */
  blobs: Map<string, Buffer>
  /** 完全な相対パス → blob の sha（写した接頭辞の配下の全ファイル） */
  byPath: Map<string, string>
}

const JA_SKILLS_PREFIX = 'ccpit/golden/common/ja/skills'
const EN_SKILLS_PREFIX = 'ccpit/golden/common/en/skills'
/** 写す接頭辞。系譜の判定は ja、提案の元の版の照合（evaluateProposalBase）は ja と en を見る */
const SNAPSHOT_PREFIXES = [JA_SKILLS_PREFIX, EN_SKILLS_PREFIX] as const
/**
 * cat-file --batch の出力の上限。golden の ja skills の全 blob を 1 回で受けるので、付随ファイル 1 つの上限
 * （MAX_COMPANION_FILE_SIZE_BYTES）の 25 倍を見込む。超えたら写しを作らず、従来の 1 件ずつの問い合わせに落ちる
 */
const GOLDEN_TREE_SNAPSHOT_MAX_BYTES = MAX_COMPANION_FILE_SIZE_BYTES * 25

export function snapshotGoldenSkillsTree(repoDir: string, sha: string): GoldenSkillsTreeSnapshot | null {
  // `-z`: パスを引用符・8 進エスケープにせず NUL 区切りで返させる。既定の core.quotePath=true の機械で、非 ASCII 名のファイル・
  // skill が写しから欠ける／化けるのを防ぐ（CCPIT_L0_014 P7）。ASCII 名の出力は区切りが改行から NUL に変わるだけ
  const ls = spawnSync('git', ['ls-tree', '-r', '-z', sha, '--', ...SNAPSHOT_PREFIXES], {
    cwd: repoDir,
    encoding: 'utf-8',
    maxBuffer: MAX_COMPANION_FILE_SIZE_BYTES,
  })
  if (ls.status !== 0) return null
  const bySkillDir = new Map<string, Map<string, { blobSha: string; fullRel: string }>>()
  const byPath = new Map<string, string>()
  const blobShas = new Set<string>()
  for (const line of ls.stdout.split('\0')) {
    const tabIdx = line.indexOf('\t')
    if (tabIdx === -1) continue
    const meta = line.slice(0, tabIdx).trim().split(/\s+/)
    const fullRel = line.slice(tabIdx + 1)
    // 1 件ずつの ls-tree と同じく、blob 以外の項目も一覧には入れる（中身を写すのは blob だけ）
    const prefix = SNAPSHOT_PREFIXES.find((p) => fullRel.startsWith(p + '/'))
    if (!prefix) continue
    const rest = fullRel.slice(prefix.length + 1)
    const slash = rest.indexOf('/')
    if (slash === -1) continue
    const dir = `${prefix}/${rest.slice(0, slash)}`
    const sub = rest.slice(slash + 1)
    let m = bySkillDir.get(dir)
    if (!m) bySkillDir.set(dir, (m = new Map()))
    m.set(sub, { blobSha: meta[2], fullRel })
    if (meta[1] === 'blob') {
      blobShas.add(meta[2])
      byPath.set(fullRel, meta[2])
    }
  }
  const blobs = new Map<string, Buffer>()
  if (blobShas.size > 0) {
    const cat = spawnSync('git', ['cat-file', '--batch'], {
      cwd: repoDir,
      input: [...blobShas].join('\n') + '\n',
      maxBuffer: GOLDEN_TREE_SNAPSHOT_MAX_BYTES,
    })
    if (cat.status !== 0 || !cat.stdout) return null
    // 出力: "<sha> <type> <size>\n<中身>\n" の繰り返し（missing は "<sha> missing\n"）
    const out = cat.stdout as Buffer
    let pos = 0
    while (pos < out.length) {
      const nl = out.indexOf(0x0a, pos)
      if (nl === -1) break
      const header = out.subarray(pos, nl).toString('utf-8').split(' ')
      pos = nl + 1
      if (header[1] === 'missing' || header.length < 3) continue
      const size = Number(header[2])
      blobs.set(header[0], Buffer.from(out.subarray(pos, pos + size)))
      pos += size + 1
    }
  }
  return { sha, bySkillDir, blobs, byPath }
}

/** 写した接頭辞の配下のパスか（写しに無いことを「golden に無い」と言い切れる範囲か） */
function coveredBySnapshot(fullRel: string): boolean {
  return SNAPSHOT_PREFIXES.some((p) => fullRel.startsWith(p + '/'))
}

/**
 * `getGoldenBlobContent(commitSha, fullRel)` と同じ結果を、写しから返す。写しの commit が違う・写した範囲の外なら、
 * 従来どおり git に問う。写した範囲の中で写しに無いパスは、git でも無い（null）
 */
function blobAtPath(
  snap: GoldenSkillsTreeSnapshot | undefined,
  commitSha: string,
  fullRel: string,
  repoDir: string
): Buffer | null {
  const norm = fullRel.replace(/\\/g, '/')
  if (snap && snap.sha === commitSha && coveredBySnapshot(norm)) {
    const sha = snap.byPath.get(norm)
    if (sha === undefined) {
      // フォルダを指すパスは、cat-file が木の一覧を返す（null ではない）。写しは blob しか持たないので、git に問う
      const isDir = [...snap.byPath.keys()].some((k) => k.startsWith(norm + '/'))
      if (!isDir) return null
    } else {
      const b = snap.blobs.get(sha)
      if (b) return b
    }
  }
  return getGoldenBlobContent(commitSha, norm, repoDir)
}

/** 写しに中身があればそれを、無ければ従来どおり 1 件ずつ git に問う */
function blobFromSnapshot(
  snap: GoldenSkillsTreeSnapshot | undefined,
  commitSha: string,
  info: { blobSha: string; fullRel: string },
  repoDir: string
): Buffer | null {
  if (snap && snap.sha === commitSha) {
    const b = snap.blobs.get(info.blobSha)
    if (b) return b
  }
  return getGoldenBlobContent(commitSha, info.fullRel, repoDir)
}

/**
 * テンポラリ Git リポジトリ経由で git diff --binary を生成（CRITICAL 1 準拠）。
 * base_master の blob と新コンテンツから、完全な git apply 互換パッチを出力する。
 */
export function createGitBinaryPatch(params: {
  targetRelPath: string
  oldBytes: Buffer | null
  newBytes: Buffer | null
}): string {
  const normRel = params.targetRelPath.replace(/\\/g, '/')
  const tempDir = join(tmpdir(), `ccpit_patch_${randomBytes(8).toString('hex')}`)
  mkdirSync(tempDir, { recursive: true })
  try {
    spawnSync('git', ['init', '-q'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'ccpit@local'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'CCPIT'], { cwd: tempDir })

    const targetFile = join(tempDir, normRel)
    const parentDir = dirname(targetFile)
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true })
    }

    if (params.oldBytes !== null) {
      writeFileSync(targetFile, params.oldBytes)
      spawnSync('git', ['add', '-f', normRel], { cwd: tempDir })
      spawnSync('git', ['commit', '-q', '-m', 'base'], { cwd: tempDir })
    }

    if (params.newBytes !== null) {
      writeFileSync(targetFile, params.newBytes)
      if (params.oldBytes === null) {
        // 新規ファイル
        spawnSync('git', ['add', '-f', normRel], { cwd: tempDir })
        const res = spawnSync('git', ['diff', '--cached', '--binary', normRel], {
          cwd: tempDir,
          encoding: 'utf-8'
        })
        return res.stdout || ''
      } else {
        // 更新ファイル
        const res = spawnSync('git', ['diff', '--binary', normRel], {
          cwd: tempDir,
          encoding: 'utf-8'
        })
        return res.stdout || ''
      }
    } else {
      // 削除ファイル
      if (params.oldBytes !== null) {
        unlinkSync(targetFile)
        // `--` が無いと、作業ツリーから消えたパスを git が曖昧な引数として扱い、終了 128・出力 0 バイトになる
        // （健全な git でも削除の patch が常に空だった。CCPIT_L0_014 P8）
        const res = spawnSync('git', ['diff', '--binary', '--', normRel], {
          cwd: tempDir,
          encoding: 'utf-8'
        })
        return res.stdout || ''
      }
      return ''
    }
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

/**
 * Git 三者照合によるハッシュ系譜照合（Plan r3 §3-2 / MAJOR 5 準拠）。
 * base_master の直系先祖コミットと localFiles を比較し、
 * identical / stale-local / diverged / modified / new を判定する。
 */
export function determineSkillLineageState(params: LineageParams): LineageResult {
  try {
    return determineSkillLineageStateCore(params)
  } catch (err) {
    // 走査は投げない（1 件の失敗で一覧の他の skill が消えないように）。読めなかった行は「分岐」の形で返し、反映は止める
    if (isGoldenGitReadError(err)) {
      return { diffState: 'diverged', diverged: true, diffSummary: err.message, gitReadError: true }
    }
    throw err
  }
}

interface LineageParams {
  repoDir: string
  baseMasterSha: string
  goldenTargetDir: string // 例: 'ccpit/golden/common/ja/skills/foo'
  localFiles: ScannedSkillFile[]
  /**
   * ローカルがこの Skill のどの版の**同梱 golden**を元にしているかの指紋（Skill のフォルダからの相対パス → `hashFileBuffer` の値）。
   * `golden-manifest.json` の goldenHash をそのまま渡してはならない（有効な golden の指紋で、ローカルを残した行では
   * ローカルの指紋になる）。`trustedDeployedHashes` の結果を渡す。今の golden の全ファイルについて「元にした指紋＝今の golden の指紋」なら、
   * ローカルは今の golden を元に直したもの（内容変更）で、分岐ではない。記録が無い・欠ける・食い違うときは使わない。
   */
  deployedGoldenHashes?: ReadonlyMap<string, string>
  /** 走査 1 回分の golden の木の写し（CCPIT_L0_004 W6）。baseMasterSha と同じ commit のときだけ使う */
  tree?: GoldenSkillsTreeSnapshot
}

export interface LineageResult {
  diffState: GoldenDiffState
  diverged: boolean
  diffSummary: string
  /** golden を git から読めなかった（CCPIT_L0_010）。健全時はキーごと無い。立っている行は反映できない（読めなかった理由で止める） */
  gitReadError?: boolean
}

/** 本体。git が読めなかったときは `GoldenGitReadError` を投げる（呼び出し側の `determineSkillLineageState` が行の形に直す） */
function determineSkillLineageStateCore(params: LineageParams): LineageResult {
  const normGoldenDir = params.goldenTargetDir.replace(/\\/g, '/')
  const localFileMap = new Map<string, string>() // relPath -> hash
  for (const f of params.localFiles) {
    localFileMap.set(f.relPath, f.hash)
  }
  const useTree = params.tree !== undefined && params.tree.sha === params.baseMasterSha

  // 1. base_master における goldenTargetDir のファイル一覧を取得（写しがあれば git を起動しない）
  // 読めなかったときは投げる（旧は失敗＝空＝「新規」に化けた）。commit が 0 件（unborn）のときだけ、従来どおり空
  const lsOut = useTree
    ? null
    : readGoldenTextOrThrow(params.repoDir, ['ls-tree', '-r', '-z', params.baseMasterSha, '--', normGoldenDir], {
        op: 'tree',
        ref: params.baseMasterSha,
        relPath: normGoldenDir,
        maxBuffer: MAX_COMPANION_FILE_SIZE_BYTES,
        emptyIfNoBase: true
      })

  // 出力フォーマット（-z）: "<mode> blob <blobSha>\t<path>" を NUL で区切る（非 ASCII 名を引用符にしない。CCPIT_L0_014 P7）
  const goldenCurrentFiles = new Map<string, { blobSha: string; fullRel: string }>(
    useTree ? params.tree!.bySkillDir.get(normGoldenDir) ?? [] : []
  )
  if (lsOut !== null && lsOut.trim()) {
    const lines = lsOut.split('\0')
    for (const line of lines) {
      const tabIdx = line.indexOf('\t')
      if (tabIdx === -1) continue
      const meta = line.slice(0, tabIdx).trim().split(/\s+/)
      const fullRel = line.slice(tabIdx + 1)
      const blobSha = meta[2]
      const skillSubRel = fullRel.startsWith(normGoldenDir + '/')
        ? fullRel.slice(normGoldenDir.length + 1)
        : basename(fullRel)
      goldenCurrentFiles.set(skillSubRel, { blobSha, fullRel })
    }
  }

  // golden 側に全く存在しない場合は new
  if (goldenCurrentFiles.size === 0) {
    return {
      diffState: 'new',
      diverged: false,
      diffSummary: `新規追加 (ローカルのみ存在, ${params.localFiles.length} ファイル)`
    }
  }

  // 2. 現在の base_master と localFiles が完全一致するか確認
  let isIdentical = true
  if (goldenCurrentFiles.size !== localFileMap.size) {
    isIdentical = false
  } else {
    for (const [subRel, gInfo] of goldenCurrentFiles.entries()) {
      const localHash = localFileMap.get(subRel)
      if (!localHash) {
        isIdentical = false
        break
      }
      const blob = blobFromSnapshot(useTree ? params.tree : undefined, params.baseMasterSha, gInfo, params.repoDir)
      if (!blob) {
        isIdentical = false
        break
      }
      const gHash = computeGoldenContentHash(gInfo.fullRel, blob)
      if (localHash !== gHash) {
        isIdentical = false
        break
      }
    }
  }

  if (isIdentical) {
    return {
      diffState: 'identical',
      diverged: false,
      diffSummary: '一致 (変更なし)'
    }
  }

  // 3. 差異がある場合、直系先祖コミットとの照合（stale-local 判定）
  // goldenTargetDir を変更した直近コミット履歴を最大 LINEAGE_ANCESTOR_DEPTH (20) 件取得して探索。
  // ※この探索窓を超えて古いローカルファイルは、先祖特定不能として安全側に diverged（双方変更）に倒れ、
  // fail-closed として goldenMergeConsult への誘導が行われる。
  // 履歴が読めないまま「祖先なし」にすると、stale-local（巻き戻しになる）が modified に化けて反映を通してしまう。読めなかったら投げる
  const logOut = readGoldenTextOrThrow(
    params.repoDir,
    ['log', params.baseMasterSha, '-n', String(LINEAGE_ANCESTOR_DEPTH), '--format=%H', '--', normGoldenDir],
    { op: 'log', ref: params.baseMasterSha, relPath: normGoldenDir }
  )

  const ancestorCommits = logOut.trim()
    ? logOut.trim().split('\n').map((s) => s.trim()).filter(Boolean)
    : []

  let matchedAncestorSha: string | null = null
  for (let i = 1; i < ancestorCommits.length; i++) {
    const aSha = ancestorCommits[i]
    const aLsOut = readGoldenTextOrThrow(params.repoDir, ['ls-tree', '-r', '-z', aSha, '--', normGoldenDir], {
      op: 'tree',
      ref: aSha,
      relPath: normGoldenDir
    })
    if (!aLsOut.trim()) continue

    const aFiles = new Map<string, { blobSha: string; fullRel: string }>()
    const lines = aLsOut.split('\0')
    for (const line of lines) {
      const tabIdx = line.indexOf('\t')
      if (tabIdx === -1) continue
      const meta = line.slice(0, tabIdx).trim().split(/\s+/)
      const fullRel = line.slice(tabIdx + 1)
      const blobSha = meta[2]
      const skillSubRel = fullRel.startsWith(normGoldenDir + '/')
        ? fullRel.slice(normGoldenDir.length + 1)
        : basename(fullRel)
      aFiles.set(skillSubRel, { blobSha, fullRel })
    }

    if (aFiles.size !== localFileMap.size) continue

    let aMatch = true
    for (const [subRel, aInfo] of aFiles.entries()) {
      const lHash = localFileMap.get(subRel)
      if (!lHash) {
        aMatch = false
        break
      }
      const blob = getGoldenBlobContent(aSha, aInfo.fullRel, params.repoDir)
      if (!blob) {
        aMatch = false
        break
      }
      const aHash = computeGoldenContentHash(aInfo.fullRel, blob)
      if (lHash !== aHash) {
        aMatch = false
        break
      }
    }

    if (aMatch) {
      matchedAncestorSha = aSha
      break
    }
  }

  if (matchedAncestorSha) {
    return {
      diffState: 'stale-local',
      diverged: false,
      diffSummary: `golden 先行 (巻き戻し防止: ローカルは先祖コミット ${matchedAncestorSha.slice(0, 8)} と一致)`
    }
  }

  // 4. ローカルがどの版の golden を元に直したか（CCPIT が配った golden の記録）
  // 今の golden の全ファイルについて「配った指紋＝今の golden の指紋」なら、ローカルは今の golden を元に直したもので、
  // golden 側は配った後に動いていない → 分岐ではなく内容変更。指紋は記録を書く側と同じ hashFileBuffer で計算する
  // （computeGoldenTargetHash は .md・.json だけ改行を正規化するので、記録の値と比べられない）。
  // 2026-09-28 069 M4: 以前はこの確かめが無く、golden のフォルダに 2 つ以上 commit があれば、今の golden を元に
  // 直したローカルも「分岐・競合」になり、ローカルから上げる道が止まっていた。
  if (params.deployedGoldenHashes && params.deployedGoldenHashes.size > 0) {
    let basedOnCurrent = true
    for (const [subRel, gInfo] of goldenCurrentFiles.entries()) {
      const deployed = params.deployedGoldenHashes.get(subRel)
      const blob = deployed
        ? blobFromSnapshot(useTree ? params.tree : undefined, params.baseMasterSha, gInfo, params.repoDir)
        : null
      if (!deployed || !blob || hashFileBuffer(gInfo.fullRel, blob) !== deployed) {
        basedOnCurrent = false
        break
      }
    }
    // 配った後に golden から消したファイルが、ローカルに残っているなら、上げると golden 側の削除を巻き戻す
    // （ローカルに無い・走査の対象外（.bak など）なら、上げても復活しないので問わない）
    for (const subRel of params.deployedGoldenHashes.keys()) {
      if (!goldenCurrentFiles.has(subRel) && localFileMap.has(subRel)) {
        basedOnCurrent = false
        break
      }
    }
    // ローカルのファイルが golden のファイルと大文字小文字だけ違う綴りなら、Windows では上げると既存のファイルを
    // 上書きしうる（evaluateProposalBase と同じ確かめ）
    const goldenFolded = new Map([...goldenCurrentFiles.keys()].map((k) => [k.toLowerCase(), k]))
    for (const subRel of localFileMap.keys()) {
      const g = goldenFolded.get(subRel.toLowerCase())
      if (g !== undefined && g !== subRel) {
        basedOnCurrent = false
        break
      }
    }
    if (basedOnCurrent) {
      return {
        diffState: 'modified',
        diverged: false,
        diffSummary: `内容変更 (配った golden の版から直した, ${params.localFiles.length} ファイル)`
      }
    }
  }

  if (ancestorCommits.length > 1) {
    return {
      diffState: 'diverged',
      diverged: true,
      diffSummary: `分岐・競合 (golden 側も直近更新されており、ローカルの変更と競合しています)`
    }
  }

  return {
    diffState: 'modified',
    diverged: false,
    diffSummary: `内容変更 (${params.localFiles.length} ファイル)`
  }
}

/**
 * 配った記録のうち、「ローカルがその版を元にしている」と言えるものだけを返す（~/.claude からの相対パス → 同梱 golden の指紋）。
 * 持ち主が `golden`（CCPIT が golden の中身を置いた）と `promoted`（ローカルの中身が golden に入った・
 * ローカルを残した）の記録だけ。`user`・`adopted` は、利用者が上書きを断った・採用で入れたファイルで、
 * CCPIT は今の golden の指紋を記録するがローカルはその版を元にしていない（069 M4 の Codex 3 巡目の指摘）。
 *
 * **台帳の `goldenHash` は有効な golden（overlay を重ねた後）の指紋で、同梱 golden の指紋とは限らない**
 * （道 P2＝ローカルを残した行では、ローカルの中身の指紋）。ここで返すのは同梱 golden の指紋なので、
 * `goldenHash` を直接読まず、必ず `bundledBaseHashOf` を通す（069 発注 2）。
 * 同じ path に指紋か持ち主の違う行が複数あるときは、どれが正しいか決められないので載せない。
 * 元にした版が記録されていない overlay の行（旧い形・不明）は台帳の指紋のまま＝ 今の golden とは一致せず、止める側。
 */
export function trustedDeployedHashes(
  entries: ReadonlyArray<ManifestEntry>,
  overlayEntries: ReadonlyArray<OverlayEntry> = []
): Map<string, string> {
  const lookup = buildOverlayLookup(overlayEntries)
  // 持ち主に依らず、同じ path に指紋か持ち主の違う行があれば曖昧（書き側 resolvePendingReconcile と同じ規則）。
  // 信用できる持ち主の行が 1 つあっても、矛盾する行（user・adopted など）があれば載せない
  const ambiguous = new Set<string>()
  const seen = new Map<string, ManifestEntry>()
  for (const e of entries) {
    const path = normalizeRelPath(e.path)
    const prev = seen.get(path)
    if (prev === undefined) seen.set(path, e)
    else if (prev.goldenHash !== e.goldenHash || prev.owner !== e.owner) ambiguous.add(path)
  }
  const out = new Map<string, string>()
  for (const e of entries) {
    if (e.owner !== 'golden' && e.owner !== 'promoted') continue
    const path = normalizeRelPath(e.path)
    if (ambiguous.has(path)) continue
    out.set(path, bundledBaseHashOf(e, lookup))
  }
  return out
}

/**
 * frontmatter の 1 つのキーの値（scanProposalCandidates の単純な読み方と同じ: `key: value`・前後の引用符を外す）。
 * frontmatter が無い・キーが無いときは undefined。
 */
export function readFrontmatterValue(content: string, key: string): string | undefined {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (!fm) return undefined
  for (const line of fm[1].split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    if (line.slice(0, colonIdx).trim() !== key) continue
    return line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '')
  }
  return undefined
}

/**
 * 提案から golden へ上げる道の、元の版の照合（069 M4）。
 * 提案の `base_hash`（skill-proposal-emitter §2-5: 起草時に読んだ SKILL.md の sha256）と、base_master の golden の
 * SKILL.md の指紋を比べる。違えば、提案を書いた後に golden 側が動いており、反映すると golden 側の変更を巻き戻すので
 * 止める（diverged）。golden に SKILL.md が無ければ新規。以前は判定を「内容変更」に決め打ちし、`base_hash` を
 * どこでも読んでいなかった（2026-09-28 の手元の候補 44 件のうち 6 件が、golden と違う元の版から書かれていた）。
 */
export function evaluateProposalBase(params: EvaluateProposalBaseParams): EvaluateProposalBaseResult {
  try {
    return evaluateProposalBaseCore(params)
  } catch (err) {
    // golden を git から読めなかったら、元の版を確かめられないので反映できない（旧は blob の失敗＝「golden に無い」＝新規扱いで素通りした）
    if (isGoldenGitReadError(err)) {
      return { ok: false, diffState: 'diverged', diverged: true, diffSummary: err.message, gitReadError: true }
    }
    throw err
  }
}

export interface EvaluateProposalBaseResult {
  ok: boolean
  diffState: GoldenDiffState
  diverged: boolean
  diffSummary: string
  /** golden を git から読めなかった（CCPIT_L0_010）。健全時はキーごと無い */
  gitReadError?: boolean
}

export interface EvaluateProposalBaseParams {
  repoDir: string
  baseRef: string
  skillName: string
  baseHash: string | undefined
  /** 提案の SKILL.md。今の golden と同じなら、反映しても何も変わらない（巻き戻すものが無い）ので一致として通す */
  proposedSkillMd?: string
  /** 提案の付随ファイル（SKILL.md 以外）。golden にあって中身が違うものは、元の版の申告と照合する */
  proposedCompanions?: ReadonlyArray<{ relPath: string; content: string }>
  /** frontmatter の `companion_base_hashes`（`相対パス=sha256` を `;` で区切る。en 側は `en:相対パス=sha256`）。付随ファイルの元の版の申告 */
  companionBaseHashes?: string
  /**
   * 提案の `en:` 見出しのファイル（相対パスは接頭辞を除いたもの。SKILL.md も含む）。golden の en の現行値と照合する。
   * golden の en に既にあって中身が違うものは、`en:<相対パス>` の申告が要り、今の golden の en と一致しなければ止める
   * （en だけが提案より後に更新されていれば、巻き戻さない）。
   */
  proposedEnFiles?: ReadonlyArray<{ relPath: string; content: string }>
  /** 走査 1 回分の golden の木の写し（CCPIT_L0_004 W6）。baseRef と同じ commit のときだけ使う */
  tree?: GoldenSkillsTreeSnapshot
}

/** 本体。git が読めなかったときは `GoldenGitReadError` を投げる（`evaluateProposalBase` が止める行の形に直す） */
function evaluateProposalBaseCore(params: EvaluateProposalBaseParams): EvaluateProposalBaseResult {
  const dir = `ccpit/golden/common/ja/skills/${params.skillName}`
  const useTree = params.tree !== undefined && params.tree.sha === params.baseRef
  const blobOf = (rel: string): Buffer | null =>
    blobAtPath(useTree ? params.tree : undefined, params.baseRef, rel, params.repoDir)
  const stop = (diffSummary: string): EvaluateProposalBaseResult => ({
    ok: false,
    diffState: 'diverged',
    diverged: true,
    diffSummary
  })
  // 付随ファイル: golden にあって中身が違うもの（反映すると golden 側を書き換えるもの）は、元の版の申告が要る。
  // golden に SKILL.md が無くても付随ファイルだけ残っていることがあるので、SKILL.md の有無より先に確かめる
  const declared = parseCompanionBaseHashes(params.companionBaseHashes)
  // golden のフォルダのファイル（大文字小文字を無視した鍵 → git 上の綴り）。Windows では綴りの大文字小文字だけが
  // 違うパスは同じファイルなので、git 上で「新規」に見えても既存のファイルを上書きしうる
  const goldenByFolded = new Map<string, string>()
  if (useTree) {
    // 写しの一覧は ls-tree -r の全項目（blob 以外も）なので、--name-only の一覧と同じ
    for (const sub of params.tree!.bySkillDir.get(dir)?.keys() ?? []) goldenByFolded.set(sub.toLowerCase(), sub)
  } else {
    // 読めなかったら投げる（旧は失敗＝一覧が空＝綴りの衝突を見逃した）。commit が 0 件（unborn）のときだけ従来どおり空
    const lsOut = readGoldenTextOrThrow(params.repoDir, ['ls-tree', '-r', '--name-only', '-z', params.baseRef, '--', dir], {
      op: 'tree',
      ref: params.baseRef,
      relPath: dir,
      emptyIfNoBase: true
    })
    // -z: 非 ASCII 名を引用符にしない（既定の core.quotePath=true では、綴りの衝突の検査を素通りしていた。CCPIT_L0_014 P7）
    for (const p of lsOut.split('\0').filter(Boolean)) {
      goldenByFolded.set(p.slice(dir.length + 1).toLowerCase(), p.slice(dir.length + 1))
    }
  }
  let companionChanged = false
  for (const pf of params.proposedCompanions ?? []) {
    // 見出しの区切りが `\` でも `/` でも同じファイルを指す。golden の引き当て・申告の引き当て・比較・メッセージを
    // すべてこの 1 つの綴りで行う（申告側は parseCompanionBaseHashes が `/` にそろえる）
    const relPath = pf.relPath.replace(/\\/g, '/')
    const golden = goldenByFolded.get(relPath.toLowerCase())
    if (golden !== undefined && golden !== relPath) {
      return stop(
        `付随ファイル ${relPath} が golden の ${golden} と大文字小文字だけ違う (Windows では同じファイルを上書きするので、golden と同じ綴りで提案を作り直す)`
      )
    }
    const pfRel = `${dir}/${relPath}`
    const pfBlob = blobOf(pfRel)
    if (pfBlob === null) continue // golden に無い付随ファイルは追加（巻き戻すものが無い）
    if (computeGoldenContentHash(pfRel, Buffer.from(pf.content, 'utf-8')) === computeGoldenContentHash(pfRel, pfBlob)) continue
    companionChanged = true
    const pfBase = declared.get(relPath)
    if (!pfBase) {
      return stop(
        `付随ファイル ${relPath} の元の版を確かめられない (golden にあって中身が違うのに companion_base_hashes に申告が無い。今の golden を元に提案を作り直す)`
      )
    }
    if (!baseMatchesGolden(pfBase, pfRel, pfBlob)) {
      return stop(
        `付随ファイル ${relPath} の元の版が今の golden と違う (申告 ${pfBase.slice(0, 8)}。反映すると golden 側の変更を巻き戻すので、今の golden を元に提案を作り直す)`
      )
    }
  }

  // en 側のファイル: golden の en の現行値を正とする。golden の en に無ければ追加、同じなら変更なし、
  // 違えば `en:<相対パス>` の元の版の申告が今の golden の en と一致するときだけ進める
  const enDir = `ccpit/golden/common/en/skills/${params.skillName}`
  for (const pf of params.proposedEnFiles ?? []) {
    const relPath = pf.relPath.replace(/\\/g, '/')
    const enRel = `${enDir}/${relPath}`
    const enBlob = blobOf(enRel)
    if (enBlob === null) {
      companionChanged = true
      continue
    }
    if (computeGoldenContentHash(enRel, Buffer.from(pf.content, 'utf-8')) === computeGoldenContentHash(enRel, enBlob)) continue
    companionChanged = true
    const enBase = declared.get(`en:${relPath}`)
    if (!enBase) {
      return stop(
        `en 側のファイル ${relPath} の元の版を確かめられない (golden の en にあって中身が違うのに companion_base_hashes に en:${relPath} の申告が無い。今の golden の en を元に提案を作り直す)`
      )
    }
    if (!baseMatchesGolden(enBase, enRel, enBlob)) {
      return stop(
        `en 側のファイル ${relPath} の元の版が今の golden の en と違う (申告 ${enBase.slice(0, 8)}。反映すると en 側の変更を巻き戻すので、今の golden の en を元に提案を作り直す)`
      )
    }
  }

  const rel = `${dir}/SKILL.md`
  const blob = blobOf(rel)
  if (blob === null) {
    return { ok: true, diffState: 'new', diverged: false, diffSummary: '' }
  }

  const goldenHash = computeGoldenContentHash(rel, blob)
  const skillMdSame =
    params.proposedSkillMd !== undefined &&
    computeGoldenContentHash(rel, Buffer.from(params.proposedSkillMd, 'utf-8')) === goldenHash
  if (skillMdSame) {
    return companionChanged
      ? { ok: true, diffState: 'modified', diverged: false, diffSummary: '' }
      : { ok: true, diffState: 'identical', diverged: false, diffSummary: '' }
  }
  const base = (params.baseHash || '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(base)) {
    return stop('元の版を確かめられない (提案に base_hash が無い。今の golden の SKILL.md を元に、base_hash を付けて提案を作り直す)')
  }
  if (!baseMatchesGolden(base, rel, blob)) {
    return stop(
      `元の版が今の golden と違う (base_hash ${base.slice(0, 8)} ≠ golden ${goldenHash.slice(0, 8)}。反映すると golden 側の変更を巻き戻すので、今の golden を元に提案を作り直す)`
    )
  }
  return { ok: true, diffState: 'modified', diverged: false, diffSummary: '' }
}

/**
 * 申告された元の版の指紋が、golden のファイルと同じ中身を指すか。golden の blob は LF なので、LF のままの指紋
 * （computeGoldenTargetHash）と、CRLF にしたときの指紋の両方を受ける（起草した側が CRLF のファイルの生のバイトで
 * sha256 を取った場合も、同じ中身なら一致とする）。
 */
function baseMatchesGolden(base: string, rel: string, blob: Buffer): boolean {
  const b = base.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(b)) return false
  if (b === computeGoldenTargetHash(rel, blob)) return true
  const lf = normalizeEol(blob.toString('latin1'))
  return b === sha256Buffer(Buffer.from(lf.replace(/\n/g, '\r\n'), 'latin1'))
}

/** frontmatter の `companion_base_hashes`（`相対パス=sha256;相対パス=sha256`）を読む。形の違う項目は捨てる */
export function parseCompanionBaseHashes(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const item of (raw || '').split(';')) {
    const eq = item.lastIndexOf('=')
    if (eq <= 0) continue
    const relPath = item.slice(0, eq).trim().replace(/\\/g, '/')
    const sha = item.slice(eq + 1).trim().toLowerCase()
    if (relPath && /^[0-9a-f]{64}$/.test(sha)) out.set(relPath, sha)
  }
  return out
}

/**
 * 妥当な UTF-8 のみを許容してファイルを文字列として読み込む（契約ゲートに使う読込専用）。
 *
 * golden 配布物（SKILL.md・golden-ledger.json）は常に妥当な UTF-8 テキストであるべきという
 * 前提を守る。通常の `readFile(path, 'utf-8')` は不正バイト列を黙って U+FFFD へ非可逆置換するため、
 * その後のハッシュ・パッチ生成が「読込時に既に壊れた内容」を正として扱ってしまう
 * （Codex adversarial-review 指摘・high: 昇格時のデータ破損＝add／不整合による誤拒否＝update・delete）。
 * ここで読込直後に妥当性を検査し、不正なら fail-closed で拒否する。
 */
/** 妥当な UTF-8 なら文字列を、そうでなければ null を返す（スキャン等の非ゲート文脈用・例外を投げない）。 */
function tryDecodeUtf8(buf: Buffer): string | null {
  try {
    // ignoreBOM: true — 既定 (false) だと先頭の UTF-8 BOM を無言で除去してしまい、
    // 往復（decode→re-encode）が非可逆になる（Codex adversarial-review 指摘・high・実測確認済み）。
    // BOM も含めて内容の一部として保持し、正当な入力のバイト同一性を守る。
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf)
  } catch {
    return null
  }
}

function decodeUtf8Strict(buf: Buffer, context: string): string {
  const decoded = tryDecodeUtf8(buf)
  if (decoded === null) {
    throw new Error(`妥当な UTF-8 ではありません（不正バイト列を含みます）: ${context}`)
  }
  return decoded
}

/**
 * JSON.parse に渡す直前だけ、先頭の UTF-8 BOM (U+FEFF) を取り除く。
 * ハッシュ計算にはこれを使わず、BOM 保持済みの decodeUtf8Strict の結果をそのまま使うこと
 * （JSON.parse は先頭 BOM を空白として扱わず妥当な JSON でも拒否するため、意味解析の時だけ
 *  BOM を無視する。Codex adversarial-review 指摘・high・実測確認済み: BOM 付き既存台帳が
 *  空配列として扱われ、既存の監査履歴が失われる）。
 */
function stripBomForJsonParse(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
}

export interface ValidateLedgerResult {
  valid: boolean
  error?: string
  reason?: string
  ledger?: GoldenLedgerEntry[]
}

/**
 * 台帳 golden-ledger.json の共有スキーマ検証器（Z-4）。
 * 構文・構造・意味的完全性を fail-closed で検証する純粋関数。
 */
export function validateGoldenLedger(ledgerJsonOrText: unknown): ValidateLedgerResult {
  let parsed: unknown = ledgerJsonOrText
  if (typeof ledgerJsonOrText === 'string') {
    try {
      parsed = JSON.parse(stripBomForJsonParse(ledgerJsonOrText))
    } catch (err) {
      const msg = `台帳 JSON 構文エラー: ${(err as Error).message}`
      return { valid: false, error: msg, reason: msg }
    }
  }

  if (!Array.isArray(parsed)) {
    const msg = '台帳の最上位は配列である必要があります'
    return { valid: false, error: msg, reason: msg }
  }

  const iso8601Re = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
  const hex64Re = /^[0-9a-fA-F]{64}$/
  const hex40Re = /^[0-9a-fA-F]{40}$/

  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i]
    if (!entry || typeof entry !== 'object') {
      const msg = `エントリ [${i}] がオブジェクトではありません`
      return { valid: false, error: msg, reason: msg }
    }

    if (typeof entry.name !== 'string' || !entry.name.trim()) {
      const msg = `エントリ [${i}] の name が不正です`
      return { valid: false, error: msg, reason: msg }
    }

    if (typeof entry.target !== 'string' || !entry.target.trim()) {
      const msg = `エントリ [${i}] の target が不正です`
      return { valid: false, error: msg, reason: msg }
    }

    if (typeof entry.hash !== 'string' || !entry.hash.trim()) {
      const msg = `エントリ [${i}] の hash が不正です: ${entry.hash}`
      return { valid: false, error: msg, reason: msg }
    }

    if (
      typeof entry.promotedAt !== 'string' ||
      !iso8601Re.test(entry.promotedAt) ||
      isNaN(Date.parse(entry.promotedAt))
    ) {
      const msg = `エントリ [${i}] の promotedAt が有効な ISO 8601 日時ではありません: ${entry.promotedAt}`
      return { valid: false, error: msg, reason: msg }
    }

    if (typeof entry.source !== 'string' || !entry.source.trim()) {
      const msg = `エントリ [${i}] の source が不正です`
      return { valid: false, error: msg, reason: msg }
    }

    if (entry.action !== undefined && typeof entry.action !== 'string') {
      const msg = `エントリ [${i}] の action が不正です`
      return { valid: false, error: msg, reason: msg }
    }

    if (entry.sourceCommitSha !== undefined && entry.sourceCommitSha !== null) {
      if (typeof entry.sourceCommitSha !== 'string' || !hex40Re.test(entry.sourceCommitSha)) {
        const msg = `エントリ [${i}] の sourceCommitSha が 40 桁 16 進数ではありません: ${entry.sourceCommitSha}`
        return { valid: false, error: msg, reason: msg }
      }
    }

    if (entry.catchupCommits !== undefined && entry.catchupCommits !== null) {
      if (!Array.isArray(entry.catchupCommits)) {
        const msg = `エントリ [${i}] の catchupCommits が配列ではありません`
        return { valid: false, error: msg, reason: msg }
      }
      const seenCommits = new Set<string>()
      for (const c of entry.catchupCommits) {
        if (typeof c !== 'string' || !hex40Re.test(c)) {
          const msg = `エントリ [${i}] の catchupCommits に無効な SHA が含まれています: ${c}`
          return { valid: false, error: msg, reason: msg }
        }
        if (seenCommits.has(c.toLowerCase())) {
          const msg = `エントリ [${i}] の catchupCommits に重複があります: ${c}`
          return { valid: false, error: msg, reason: msg }
        }
        seenCommits.add(c.toLowerCase())
      }
    }

    if (entry.files !== undefined && entry.files !== null) {
      if (!Array.isArray(entry.files)) {
        const msg = `エントリ [${i}] の files が配列ではありません`
        return { valid: false, error: msg, reason: msg }
      }
      const seenPaths = new Set<string>()
      for (const f of entry.files) {
        if (!f || typeof f !== 'object') {
          const msg = `エントリ [${i}] の files 要素がオブジェクトではありません`
          return { valid: false, error: msg, reason: msg }
        }
        if (typeof f.path !== 'string' || !f.path.trim()) {
          const msg = `エントリ [${i}] の files.path が不正です`
          return { valid: false, error: msg, reason: msg }
        }
        if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(f.path) || isAbsolute(f.path)) {
          const msg = `エントリ [${i}] の files.path に脱出パスが含まれています: ${f.path}`
          return { valid: false, error: msg, reason: msg }
        }
        const lowerPath = f.path.toLowerCase()
        if (seenPaths.has(lowerPath)) {
          const msg = `エントリ [${i}] の files.path に重複があります: ${f.path}`
          return { valid: false, error: msg, reason: msg }
        }
        seenPaths.add(lowerPath)
        if (typeof f.hash !== 'string' || !hex64Re.test(f.hash)) {
          const msg = `エントリ [${i}] の files.hash が 64 桁 16 進数ではありません: ${f.hash}`
          return { valid: false, error: msg, reason: msg }
        }
        if (f.status !== 'present' && f.status !== 'deleted') {
          const msg = `エントリ [${i}] の files.status が不正です: ${f.status}`
          return { valid: false, error: msg, reason: msg }
        }
      }
    }
  }

  return { valid: true, ledger: parsed as GoldenLedgerEntry[] }
}

export function readGoldenLedgerValidated(ledgerPath: string): {
  status: 'ok' | 'not-found' | 'corrupt'
  ledger: GoldenLedgerEntry[]
  error?: string
} {
  if (!existsSync(ledgerPath)) {
    return { status: 'not-found', ledger: [] }
  }
  let content: string
  try {
    content = readFileSync(ledgerPath, 'utf-8')
  } catch (err) {
    return { status: 'corrupt', ledger: [], error: `台帳読込失敗: ${(err as Error).message}` }
  }
  const val = validateGoldenLedger(content)
  if (!val.valid) {
    return { status: 'corrupt', ledger: [], error: val.error }
  }
  return { status: 'ok', ledger: val.ledger ?? [] }
}

export async function readUtf8Strict(path: string, context: string): Promise<string> {
  const buf = await readFile(path)
  return decodeUtf8Strict(buf, context)
}

/** 状態ストアの読み書き */
export function loadPromotionState(stateFilePath: string = STATE_FILE): StoredPromotionState {
  try {
    if (!existsSync(stateFilePath)) {
      return { items: {} }
    }
    const content = readFileSync(stateFilePath, 'utf-8')
    const parsed = JSON.parse(content) as StoredPromotionState
    return parsed && typeof parsed.items === 'object' ? parsed : { items: {} }
  } catch {
    return { items: {} }
  }
}

export function savePromotionState(
  state: StoredPromotionState,
  stateFilePath: string = STATE_FILE
): void {
  const dir = dirname(stateFilePath)
  if (!existsSync(dir)) {
    mkdirSyncSafe(dir)
  }
  const tempPath = `${stateFilePath}.tmp.${Date.now()}.${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf-8')
    renameSync(tempPath, stateFilePath)
  } catch (err) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath)
    } catch {
      // ignore cleanup error
    }
    throw err
  }
}

/**
 * 昇格状態ストア（golden-promotion-state.json）から、昇格済み（applied_unpushed / distributed）
 * の相対パス一覧を取得するヘルパー（W-2 / Round 4 耐久回復）。
 */
export function getPromotedRelPaths(stateFilePath: string = STATE_FILE): Set<string> {
  const state = loadPromotionState(stateFilePath)
  const paths = new Set<string>()
  for (const [id, item] of Object.entries(state.items)) {
    if (item.state === 'applied_unpushed' || item.state === 'distributed') {
      if (item.targetRel) {
        paths.add(normalizeRelPath(item.targetRel))
      }
      const parts = id.split(':')
      if (parts.length >= 2) {
        const skillName = parts.slice(1).join(':')
        paths.add(normalizeRelPath(`skills/${skillName}/SKILL.md`))
      }
    }
  }
  return paths
}

function mkdirSyncSafe(dir: string): void {
  if (!existsSync(dir)) {
    const parent = dirname(dir)
    if (parent !== dir) {
      mkdirSyncSafe(parent)
    }
    try {
      const fs = require('fs')
      fs.mkdirSync(dir)
    } catch {
      // ignore
    }
  }
}

/** SKILL.md から description とタイトルを抽出 */
export function parseSkillInfo(content: string): { title: string; description: string } {
  let title = ''
  let description = ''

  // Frontmatter の解析
  if (content.startsWith('---')) {
    const endIndex = content.indexOf('\n---', 3)
    if (endIndex !== -1) {
      const fm = content.slice(3, endIndex)
      const descMatch = fm.match(/^description:\s*(.+)$/m)
      if (descMatch) {
        description = descMatch[1].trim().replace(/^["']|["']$/g, '')
      }
      const titleMatch = fm.match(/^title:\s*(.+)$/m)
      if (titleMatch) {
        title = titleMatch[1].trim().replace(/^["']|["']$/g, '')
      }
    }
  }

  // 見出し・説明の行はコードブロックの外だけから探す（コードブロックの中の `# コメント` や ``` の行を拾わない。
  // 伏せ字は位置が元の文字列と一致し、コードブロックの外の行は元のまま）
  const masked = maskFencedCodeBlocks(content)

  // 見出しからタイトルの抽出（なければ）
  if (!title) {
    const h1Match = masked.match(/^#\s+(.+)$/m)
    if (h1Match) {
      title = h1Match[1].trim()
    }
  }

  // 本文からの説明抽出（なければ）
  if (!description) {
    const lines = masked.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('---'))
    if (lines.length > 0) {
      description = lines[0].trim().slice(0, 200)
    }
  }

  return {
    title: title || '不明',
    description: description || '不明',
  }
}

/** SKILL.md から構造化詳細（What, Why, How, Title, Description）を抽出 (F-3, G-1, G-3) */
export function parseSkillDetail(content: string, fallbackName: string = ''): SkillDetailInfo {
  const normalized = content.replace(/\r\n/g, '\n')
  let name = fallbackName
  let description = ''
  let title = fallbackName

  // Frontmatter の解析
  if (normalized.startsWith('---')) {
    const endIndex = normalized.indexOf('\n---', 3)
    if (endIndex !== -1) {
      const fm = normalized.slice(3, endIndex)
      const descMatch = fm.match(/^description:\s*(.+)$/m)
      if (descMatch) {
        description = descMatch[1].trim().replace(/^["']|["']$/g, '')
      }
      const titleMatch = fm.match(/^title:\s*(.+)$/m)
      if (titleMatch) {
        title = titleMatch[1].trim().replace(/^["']|["']$/g, '')
      }
      const nameMatch = fm.match(/^name:\s*(.+)$/m)
      if (nameMatch) {
        name = nameMatch[1].trim().replace(/^["']|["']$/g, '')
      }
    }
  }

  // 見出しはコードブロックの外だけから探す（maskFencedCodeBlocks）。節の中身は元の文字列から取る
  // （2026-09-28 069 M2: コードブロックの中の `# コメント` を題に、`## ` の行を節の終わりに数えていた）
  const masked = maskFencedCodeBlocks(normalized)

  // 見出しからタイトルの抽出（なければ）
  if (!title || title === fallbackName) {
    const h1Match = masked.match(/^#\s+(.+)$/m)
    if (h1Match) {
      title = h1Match[1].trim()
    }
  }

  // What, Why, How 抽出
  const sectionText = (re: RegExp): string | null => {
    const m = re.exec(masked)
    if (!m) return null
    const start = m.index + m[0].length - m[1].length
    return normalized.slice(start, start + m[1].length)
  }
  const whatText = sectionText(/##\s+(?:What|概要|目的|何をするか|機能概要)[^\r\n]*\n([\s\S]*?)(?=\n##|$)/i)
  const whyText = sectionText(/##\s+(?:Why|背景|動機|なぜやるか|設計意図)[^\r\n]*\n([\s\S]*?)(?=\n##|$)/i)
  const howText = sectionText(/##\s+(?:How|使い方|手順|発火条件|どうやるか|使用方法)[^\r\n]*\n([\s\S]*?)(?=\n##|$)/i)

  const what = whatText !== null ? whatText.trim() : (description || '')
  const why = whyText !== null ? whyText.trim() : ''
  const how = howText !== null ? howText.trim() : ''

  return {
    name: name || fallbackName,
    title: title || name || fallbackName,
    description: description || what || '説明なし',
    what,
    why,
    how,
    rawContent: normalized,
  }
}

export interface CandidateScanOptions {
  repoDir?: string
  localSkillsDir?: string
  goldenRootDir?: string
  stateFilePath?: string
  adoptedSkillsPath?: string
  rescueItemsOverride?: PromotionItem[]
  effectiveMs?: number
  proposalsDir?: string
  proposalStorePaths?: ProposalStorePaths
  /**
   * CCPIT が配った golden の記録（`golden-manifest.json`）。ローカルの Skill がどの版の golden を元に直したかを
   * 見分けるのに使う（determineSkillLineageState の deployedGoldenHashes）。省略時は、localSkillsDir も省略
   * （＝ `~/.claude/skills` を見る）なら `~/.ccpit/golden-manifest.json` を読む。localSkillsDir を渡したときは、
   * 記録はそのフォルダへの配置を表さないので、manifestPath を明示したときだけ読む。
   */
  manifestPath?: string
  /**
   * 候補ごとの差分の表示（diffDetail）を作るか。既定は作る（従来どおり）。画面の一覧の取得（IPC の goldenPromotion:list）は
   * false を渡し、差分は詳細の欄を開いたときに getPromotionDiffDetail で作る（CCPIT_L0_004 W6: 一覧の表示を待たせない）
   */
  withDiffDetail?: boolean
}

/**
 * golden 配下の git ログを走査し、Applied-by トレーラが無いコミット（裏口混入）を救済候補として自動検知する
 * 契約 r20 追補条項 7-c: 契約発効境界 (2026-09-15T20:30:00+09:00) 以前のコミットはスキップ
 */
export function scanRescueCandidates(
  repoDir: string = findRepoRootDir(),
  goldenRootDir: string = findGoldenRootDir(repoDir),
  effectiveMs: number = CONTRACT_EFFECTIVE_MS
): PromotionItem[] {
  return scanRescueCandidatesDetailed(repoDir, goldenRootDir, effectiveMs).items
}

export interface RescueScanResult {
  items: PromotionItem[]
  /**
   * 救済候補の検出が完了しなかった理由（CCPIT_L0_010）。履歴（git log）を読めなかった・途中で失敗した、など。
   * 健全時（履歴が空で 0 件を含む）は無い。無いときの items が空なら、確かに救済候補が無い
   */
  scanError?: string
}

/**
 * `git log --name-status -z` の files の節（`FILES:` 以降）を、状態の語とその直後のパスの対に読む（CCPIT_L0_014 P7）。
 * 形: `FILES:\0\nA\0path\0M\0path2\0`（名前変更 `R<n>`・複製 `C<n>` は状態の後にパスが 2 つ）。先頭のトークンは `FILES:` を含む
 * 見出しで、状態の語の前後の空白（先頭の改行）は除く。`-z` はパスを引用符にしないので、非 ASCII 名もそのまま読める。
 */
export function parseNameStatusZ(section: string): Array<{ status: string; path: string }> {
  const toks = section.split('\0')
  const out: Array<{ status: string; path: string }> = []
  for (let i = 1; i < toks.length; ) {
    const status = toks[i].trim()
    if (!status) {
      i += 1
      continue
    }
    const code = status[0]
    if (code === 'R' || code === 'C') {
      // 旧パス・新パスの 2 つ。新パス側を項目として返す（状態は R・C のまま。呼び出し側は A・M だけを見る）
      if (toks[i + 2] !== undefined) out.push({ status: code, path: toks[i + 2] })
      i += 3
      continue
    }
    const path = toks[i + 1]
    if (path === undefined) break
    out.push({ status: code, path })
    i += 2
  }
  return out
}

/** `scanRescueCandidates` の本体。0 件が「確かに無い」のか「読めなかった」のかを `scanError` で見分けられる */
export function scanRescueCandidatesDetailed(
  repoDir: string = findRepoRootDir(),
  goldenRootDir: string = findGoldenRootDir(repoDir),
  effectiveMs: number = CONTRACT_EFFECTIVE_MS
): RescueScanResult {
  const items: PromotionItem[] = []
  try {
    // golden ディレクトリの相対パス
    const normRepo = repoDir.replace(/\\/g, '/').replace(/\/$/, '')
    const normGolden = goldenRootDir.replace(/\\/g, '/').replace(/\/$/, '')
    const goldenRel = normGolden.startsWith(normRepo)
      ? normGolden.slice(normRepo.length).replace(/^\/+/, '')
      : 'ccpit/golden'

    // git log で golden 配下の直近コミットを取得
    // format で FILES: の手前までを \x1f で区切り、name-status を FILES: の後に流し込む
    // 履歴を読めなかったときは、0 件と見分けられるように scanError を返す（旧は失敗＝0 件で、検出が黙って消えた）。
    // 履歴が空（commit が 0 件・golden 配下に commit が無い）は、終了 0 の空出力で、従来どおり 0 件
    const logRead = readGoldenText(
      repoDir,
      ['log', '-n', String(RESCUE_SCAN_DEPTH), '--format=COMMIT:%H%x1f%aI%x1f%s%x1f%b%x1fFILES:', '--name-status', '-z', '--', goldenRel],
      { op: 'log', relPath: goldenRel, emptyIfNoBase: true, ref: HEAD_REF }
    )
    if (logRead.state === 'unreadable') {
      return { items, scanError: logRead.error.message }
    }
    if (!logRead.stdout) {
      return { items }
    }

    // 各コミットブロック（先頭の空要素を除く）
    const rawCommits = logRead.stdout.split(/(?=COMMIT:[0-9a-fA-F]{40})/).filter((c) => c.trim())
    const seenSkills = new Set<string>()

    for (const commitBlock of rawCommits) {
      const parts = commitBlock.split('\x1f')
      if (parts.length < 4) continue

      const commitHash = parts[0].replace('COMMIT:', '').trim()
      const authorDate = parts[1].trim()
      const subject = parts[2].trim()
      const body = parts[3].trim()
      const filesSection = parts[4] || ''

      // 契約発効日 (2026-09-15T20:30:00+09:00) 以前のコミットは救済対象外としてスキップ (契約 r20 追補条項 7-c)
      if (authorDate) {
        const authorMs = new Date(authorDate).getTime()
        if (!isNaN(authorMs) && authorMs <= effectiveMs) {
          continue
        }
      }

      // body と subject から Applied-by と Lane を抽出
      const isOfficialApplied = /Applied-by\s*:/i.test(body) || /Applied-by\s*:/i.test(subject)
      const laneMatch = body.match(/Lane:\s*([^\r\n]+)/i)
      const lane = laneMatch ? laneMatch[1].trim() : '不明'

      if (isOfficialApplied) {
        // 正規契約を通ったコミット
        continue
      }

      // 変更ファイル一覧から skills/<skillName>/SKILL.md を抽出
      // `-z` の name-status を、状態の語とその直後のパスの対として読む（正規表現で項目の境界を推測しない。CCPIT_L0_014 P7）。
      // 状態が A・M の項目だけを見る（削除 D・名前変更 R の SKILL.md は拾わない＝旧の行単位の読みと同じ）
      const skillPathRegex = /[/\\]common[/\\]ja[/\\]skills[/\\]([^/\\\r\n]+)[/\\]SKILL\.md/
      for (const entry of parseNameStatusZ(filesSection)) {
        if (entry.status !== 'A' && entry.status !== 'M') continue
        const match = skillPathRegex.exec(entry.path)
        if (!match) continue
        const skillName = match[1]
        if (!skillName || seenSkills.has(skillName)) continue
        seenSkills.add(skillName)

        const targetPath = `ccpit/golden/common/ja/skills/${skillName}/SKILL.md`
        const targetAbs = join(repoDir, targetPath)
        let title = skillName
        let description = '不明'
        let capturedContent = ''
        // commit の内容を git から読めなかった理由（CCPIT_L0_010）。旧は失敗すると作業ツリーの現物を読んで capturedContent にし、
        // 裏口 commit の内容とは別物（golden の今の版）を救済の内容として反映に渡した
        let captureReadError: string | undefined
        try {
          // 段1 捕獲: capturedContent は後の実昇格時に無検証のまま採用される（jaContent の第一候補）ため、
          // ここで妥当な UTF-8 以外を lossy に保存しない（Codex adversarial-review 指摘・high・実測確認済み。
          // 不正なら capturedContent を空のままにし、実昇格時の decodeUtf8Strict/readUtf8Strict 経由の
          // 再読込へ確実にフォールバックさせ、そこで fail-closed に拒否させる）。
          // git が読めなかったときだけは、現物へのフォールバックをせず、読めなかった印を付ける（commit にその path が確かに無い／
          // 0 バイトのときは従来どおり）
          const blobRead = readGoldenBlob(repoDir, commitHash, targetPath, {
            maxBuffer: MAX_COMPANION_FILE_SIZE_BYTES,
            noRepoIsAbsent: true
          })
          if (blobRead.state === 'unreadable') {
            captureReadError = blobRead.error.message
          } else if (blobRead.state === 'present' && blobRead.bytes.length > 0) {
            const decoded = tryDecodeUtf8(blobRead.bytes)
            if (decoded !== null) {
              capturedContent = decoded
            }
          }
        } catch {
          // ignore
        }

        if (capturedContent) {
          const info = parseSkillInfo(capturedContent)
          title = info.title !== '不明' ? info.title : skillName
          description = info.description
        } else if (captureReadError === undefined && existsSync(targetAbs)) {
          try {
            const buf = readFileSync(targetAbs)
            const decoded = tryDecodeUtf8(buf)
            if (decoded !== null) {
              capturedContent = decoded
              const info = parseSkillInfo(decoded)
              title = info.title !== '不明' ? info.title : skillName
              description = info.description
            }
          } catch {
            // ignore
          }
        }

        // 救済アイテムの golden との差 (diffState)
        let diffState: GoldenDiffState = 'new'
        if (existsSync(targetAbs)) {
          try {
            const currentGoldenContent = readFileSync(targetAbs, 'utf-8')
            const currentHash = sha256NormalizedString(currentGoldenContent)
            const capturedHash = sha256NormalizedString(capturedContent)
            diffState = currentHash === capturedHash ? 'identical' : 'modified'
          } catch {
            diffState = 'modified'
          }
        }

        const addedAt = authorDate ? authorDate.split('T')[0] : '不明'

        items.push({
          id: `rescue:${skillName}`,
          title,
          skillName,
          addedAt,
          source: 'rescue',
          state: 'pending',
          diffState,
          targetPath,
          localPath: dirname(targetAbs),
          description,
          diffSummary:
            captureReadError !== undefined
              ? `裏口コミット (${commitHash.slice(0, 8)}) の内容を読めませんでした（反映できません）: ${captureReadError}`
              : `裏口コミット (${commitHash.slice(0, 8)}) より捕獲`,
          authorStatement: subject || '不明',
          lane,
          viewed: false,
          commitSha: commitHash,
          capturedContent,
          ...(captureReadError !== undefined ? { gitReadError: true } : {}),
        })
      }
    }
  } catch (err) {
    console.error('Failed to scan rescue candidates from git log:', err)
    // 途中で失敗したときの部分結果を「検出できたものがすべて」に見せない
    return { items, scanError: `救済候補の検出が途中で失敗しました: ${err instanceof Error ? err.message : String(err)}` }
  }
  return { items }
}

/**
 * ~/.ccpit/proposals/ を走査して承認済み CC 提案を昇格候補として取得（W2 / MAJOR 3 / MAJOR 4 準拠）。
 */
export async function scanProposalCandidates(
  _repoDir: string = findRepoRootDir(),
  proposalsDir?: string,
  proposalStorePaths?: ProposalStorePaths,
  /** 走査 1 回分の golden の木の写し（CCPIT_L0_004 W6）。元の版の照合の commit と同じときだけ使われる */
  goldenTree?: GoldenSkillsTreeSnapshot
): Promise<PromotionItem[]> {
  const repoDir = _repoDir
  // 計測の口（CCPIT_L0_004 W6）: 提案の走査の内訳（読込・ゲートの評価・元の版の照合）
  const perfOn = perfEnabled()
  const perfT0 = perfOn ? performance.now() : 0
  let perfGateMs = 0
  let perfBaseMs = 0
  let perfBaseN = 0
  // 元の版の照合（evaluateProposalBase）に使う base_master
  let baseRef = 'HEAD'
  const revRes = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' })
  if (revRes.status === 0 && revRes.stdout.trim()) baseRef = revRes.stdout.trim()
  const pDir = proposalsDir || join(homedir(), '.ccpit', 'proposals')
  if (!existsSync(pDir)) {
    return []
  }
  const storePaths = proposalStorePaths || getDefaultProposalStorePaths()

  let entries: string[] = []
  try {
    entries = readdirSync(pDir, 'utf-8')
  } catch {
    return []
  }

  // 外部ストアを事前読込し、terminal状態（adopted/rejected）や未承認を早期スキップして
  // evaluateAdoptGateFromRaw による O(N^2) 重複探索の I/O 爆発を未然に防止
  const states = await readProposalStates(storePaths).catch(() => ({}))
  const reviews = await readProposalReviews(storePaths).catch(() => ({}))

  // O(N) 単一走査: 全 .md ファイルを1度だけ読み込み、requestId 出現回数と提案データをインメモリ化
  const requestIdCounts: Record<string, number> = {}
  interface ParsedProposalEntry {
    entry: string
    fullPath: string
    content: string
    fm: Record<string, string>
    bodyText: string
    requestId: string
  }
  const parsedEntries: ParsedProposalEntry[] = []

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const fullPath = join(pDir, entry)
    let content = ''
    try {
      content = readFileSync(fullPath, 'utf-8')
    } catch {
      continue
    }

    // YAML frontmatter の抽出
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
    if (!fmMatch) continue

    const fmText = fmMatch[1]
    const bodyText = fmMatch[2]

    // 単純 YAML パーサー（キー: 値 の抽出）
    const fm: Record<string, string> = {}
    for (const line of fmText.split('\n')) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue
      const key = line.slice(0, colonIdx).trim()
      const val = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '')
      fm[key] = val
    }

    const requestId = fm['requestId'] || fm['request_id'] || entry.replace(/\.md$/, '')
    requestIdCounts[requestId] = (requestIdCounts[requestId] || 0) + 1

    parsedEntries.push({
      entry,
      fullPath,
      content,
      fm,
      bodyText,
      requestId,
    })
  }

  const candidateItems: PromotionItem[] = []
  const skillProposalMap = new Map<string, PromotionItem[]>()
  // 合成提案（frontmatter `supersedes`）の宣言。有効かどうかは合成台帳と照らして後で決める
  const supersedesByRequestId = new Map<string, string[]>()

  // 改訂済みの旧合成提案は、新しい合成提案に置き換えられている（候補にしない。後から approve になっても昇格を競合させない）
  const ledgerAtScan = readMergeLedger(getComposePaths(dirname(storePaths.statesPath)).mergesPath)
  const revisedOutIds = new Set(
    Object.values(ledgerAtScan.entries)
      .filter((x) => !!x.revisedBy)
      .map((x) => x.compositeId)
  )

  for (const itemData of parsedEntries) {
    const { fullPath, content, fm, bodyText, requestId } = itemData
    if (revisedOutIds.has(requestId)) continue
    const target = fm['target'] || ''
    const title = fm['title'] || requestId
    const author = fm['author'] || 'Claude Code'
    const agent = fm['agent'] || 'claude-code'
    const sourceProject = fm['source_project'] || 'unknown'
    const createdAt = fm['created_at'] || ''

    // 高速化事前フィルタ: terminal 状態や未承認の提案は即座にスキップ (O(N^2) I/O 爆発防止)。L0_011: 合成台帳にある合成提案の held（保留）も外す（台帳に無い held は従来どおり）。※行を増やさない（L0_010 の試験が原本の行番号を固定している）
    const st = states[requestId]
    if (st === 'adopted' || st === 'rejected' || (st === 'held' && Object.prototype.hasOwnProperty.call(ledgerAtScan.entries, requestId))) {
      continue
    }
    const rev = reviews[requestId]
    if (!rev || rev.verdict !== 'approve') {
      continue
    }

    // target から skillName を抽出 (例: '~/.claude/skills/foo/SKILL.md', 'ccpit/golden/common/ja/skills/foo/SKILL.md', 'skills/foo' 等)
    const skillName = skillNameFromProposalTarget(target)
    if (!skillName) continue

    // 承認状態の正規判定（C-1: evaluateAdoptGateFromRaw 委譲）
    // MD 内の自己申告ではなく、外部レビューストア（proposal-states.json / proposal-reviews.json）を正本として判定
    // 事前読込キャッシュを渡し、走査中のディスク再読込・重複探索 I/O をゼロにする
    const tGate = perfOn ? performance.now() : 0
    const gateRes = await evaluateAdoptGateFromRaw(content, fullPath, false, storePaths, {
      preloadedStates: states,
      preloadedReviews: reviews,
      preloadedRequestIdCounts: requestIdCounts,
    })
    if (perfOn) perfGateMs += performance.now() - tGate
    if (gateRes.blocked) {
      continue
    }

    // proposal 本文ハッシュ (TOCTOU 検証用)
    const proposalHash = sha256NormalizedString(content)

    // 完成版コードの抽出: parseProposedFilesFromSection3 を利用して順序非依存で SKILL.md を確実に抽出
    // 取れない提案（「## 3.」が無い・§3 の書式エラー）は候補にしない。2026-09-28 069 M2: 以前は別の正規表現で
    // 最初のコードブロックを拾う予備の道があり、フェンスの長さを見ずに最初の ``` で切っていた。「## 3.」が無い
    // 提案では本文のどこかのコードブロックが capturedContent になり、反映のとき golden の SKILL.md に
    // 書かれうる。手元の提案 514 件で、予備の道で拾えた提案は 0 件（外しても候補は変わらない）
    const propFilesRes = parseProposedFilesFromSection3(bodyText, fullPath)
    // ja 側（`en:` でない）の SKILL.md を取る。`en:` 見出しのファイルは golden の en 側へ運ぶもの（別に数える）
    const jaFiles = propFilesRes.files.filter((f) => f.lang !== 'en')
    const enFiles = propFilesRes.files.filter((f) => f.lang === 'en')
    const skillMdFile = jaFiles.find((f) => f.relPath === 'SKILL.md')
    const capturedContent = skillMdFile ? skillMdFile.content : ''

    if (!capturedContent) continue

    const detail = parseSkillDetail(capturedContent, skillName)
    const hash12 = proposalHash.slice(0, 12)
    const id = `proposal:${skillName}:${hash12}`

    const hasCompanions = jaFiles.length > 1
    const companionNote =
      (hasCompanions ? `(付随ファイル ${jaFiles.length - 1} 件同伴)` : `(付随ファイルなし)`) +
      (enFiles.length > 0 ? `(en 側 ${enFiles.length} 件)` : '')

    // 元の版の照合（base_hash と今の golden の SKILL.md）
    const tBase = perfOn ? performance.now() : 0
    const base = evaluateProposalBase({
      repoDir,
      baseRef,
      skillName,
      baseHash: fm['base_hash'],
      proposedSkillMd: capturedContent,
      proposedCompanions: jaFiles.filter((f) => f.relPath !== 'SKILL.md'),
      companionBaseHashes: fm['companion_base_hashes'],
      proposedEnFiles: enFiles,
      tree: goldenTree,
    })
    if (perfOn) {
      perfBaseMs += performance.now() - tBase
      perfBaseN += 1
    }

    const item: PromotionItem = {
      id,
      title: `[CC提案] ${title}`,
      skillName,
      addedAt: createdAt.split('T')[0] || new Date().toISOString().split('T')[0],
      source: 'proposal',
      state: 'pending',
      diffState: base.diffState,
      diverged: base.diverged,
      targetPath: `ccpit/golden/common/ja/skills/${skillName}/SKILL.md`,
      localPath: fullPath,
      description: detail.description || `Claude Code による提案 (${sourceProject})`,
      diffSummary:
        base.diffState === 'diverged'
          ? `${base.diffSummary} ${companionNote}`
          : base.diffState === 'new'
            ? `CC起点提案 (SKILL.md 新規 ${companionNote})`
            : `CC起点提案 (SKILL.md 改修 ${companionNote})`,
      authorStatement: `提案者: ${author} (${agent}) / プロジェクト: ${sourceProject} ${companionNote}`,
      lane: 'cc-proposal',
      viewed: false,
      capturedContent,
      skillDetail: detail,
      proposalRequestId: requestId,
      proposalHash,
      proposalFilePath: fullPath,
      isAdopted: false,
      ...(base.gitReadError ? { gitReadError: true } : {}),
    }

    if (!skillProposalMap.has(skillName)) {
      skillProposalMap.set(skillName, [])
    }
    skillProposalMap.get(skillName)!.push(item)
    candidateItems.push(item)
    const sup = parseSupersedes(fm['supersedes'])
    if (sup.length > 0) supersedesByRequestId.set(requestId, sup)
  }

  // 合成提案による、競合母数からの元提案の除外（Plan r10 §4-4）。有効の条件がすべて成り立つときだけ。
  // 条件 d（レビューの approve の拘束）と e（base が今の golden と一致＝modified）は、ここで候補になっていること・
  // diffState で確かめる。a〜c と元提案の変更の包含は合成台帳が持つ（isCompositeActive）。
  // 1 つでも欠ければ除外せず、従来どおり同じ skill の複数提案として競合になる
  if (supersedesByRequestId.size > 0) {
    const composeLedger = ledgerAtScan
    for (const it of candidateItems) {
      const sup = it.proposalRequestId ? supersedesByRequestId.get(it.proposalRequestId) : undefined
      if (!sup || !it.proposalRequestId) continue
      const verdict = isCompositeActive({
        entry: composeLedger.entries[it.proposalRequestId],
        proposalSha256: it.proposalHash ?? '',
        supersedes: sup,
        skillName: it.skillName
      })
      if (!verdict.active || it.diffState !== 'modified') continue
      it.composeSources = sup
      for (const other of candidateItems) {
        if (other !== it && other.proposalRequestId && sup.includes(other.proposalRequestId)) {
          other.composedInto = it.proposalRequestId
        }
      }
    }
  }

  // 合成を始めるとき元提案に選ばれなかった提案（合成台帳の excluded）の除外。合成提案が昇格を完了する（台帳 applied）か
  // 却下されるまで、競合の母数から外す。合成提案のレビュー判定・diffState は見ない（未 approve の間も保つ）。台帳と提案の状態からの
  // 導出だけで、提案ファイルと状態には書かない。合成提案の MD が提案プールに無いときは composeHoldAbnormal を立てる（解除は「合成を破棄」）
  // 合成提案の MD の異常: missing＝提案プールに無い／changed＝登録時の sha256 と一致する MD が無い／adopted＝台帳が registered のまま adopted。
  // どれも通常の却下が届かない（または効かない）ので、握られた提案（元提案・選ばなかった提案の両方）に「合成を破棄」の導線を出す
  const abnormalOf = (compositeId: string): 'missing' | 'changed' | 'adopted' | undefined => {
    const entry = ledgerAtScan.entries[compositeId]
    const files = parsedEntries.filter((p) => p.requestId === compositeId)
    if (files.length === 0) return 'missing'
    if (entry && !files.some((p) => sha256NormalizedString(p.content) === entry.proposalSha256)) return 'changed'
    if (entry?.status === 'registered' && states[compositeId] === 'adopted') return 'adopted'
    return undefined
  }
  const composeHolds = deriveComposeHolds(ledgerAtScan.entries, states)
  for (const it of candidateItems) {
    const hold = lookupHold(composeHolds, it.skillName, it.proposalRequestId)
    if (!hold) continue
    const abnormal = abnormalOf(hold.compositeId)
    if (hold.role === 'excluded') {
      it.composeWaitingFor = hold.compositeId
      if (abnormal) it.composeHoldAbnormal = abnormal
    } else if (!it.composedInto) {
      // 元提案は、合成提案が有効（approve かつ modified）なときだけ composedInto が付き、競合の母数から外れる（既存の設計）。
      // 合成提案がまだ有効でない（未 approve）・異常な間も、承認時の合成遮断は個別の昇格を止めるので、画面でも押せなくする。
      // 表示専用（composeHeldBy）: 競合の母数は従来どおり変えない。異常のときは破棄の導線も出す
      it.composeHeldBy = hold.compositeId
      if (abnormal) it.composeHoldAbnormal = abnormal
    }
  }

  // 複数提案の競合制御（MAJOR 4 準拠: 同一スキルに「上げられる」提案が 2 本以上ある場合は全員 proposal-conflict）。
  // 上げられない提案（isProposalUnliftable）は数えない。数えると、それ自体は上げられない古い提案が、上げられる提案を塞ぐ。
  // 有効な合成提案に置き換えられた元提案（composedInto）・合成提案の昇格を待つ提案（composeWaitingFor）も数えない
  for (const [skillName, pItems] of skillProposalMap.entries()) {
    // golden を読めなかった提案（gitReadError）は、上げられるか確かめられないだけなので、競合の相手に数える。
    // 数えないと、同じ skill の別の提案が、読めなかった提案を差し置いて単独で反映できてしまう
    const contenders = pItems.filter(
      (it) => (it.gitReadError || !isProposalUnliftable(it)) && !it.composedInto && !it.composeWaitingFor
    )
    if (contenders.length < 2) continue
    const peerOf = (p: PromotionItem): ProposalConflictPeer => ({
      id: p.id,
      requestId: p.proposalRequestId ?? '',
      title: p.title.replace(/^\[CC提案\]\s*/, ''),
      addedAt: p.addedAt,
      hash12: (p.proposalHash ?? '').slice(0, 12),
      filePath: p.proposalFilePath ?? p.localPath,
      proposalState: (p.proposalRequestId && states[p.proposalRequestId]) || 'candidate'
    })
    for (const it of contenders) {
      // 読めなかった提案の行は、理由（diffSummary）と diverged を上書きしない。読めなかったことを画面に出し続ける
      if (it.gitReadError) continue
      it.isConflicted = true
      it.diffState = 'proposal-conflict'
      it.conflictCount = contenders.length
      it.conflictPeers = contenders.filter((p) => p !== it).map(peerOf)
      it.diffSummary = `提案競合 (同一スキル「${skillName}」に上げられる提案が ${contenders.length} 件あり、どれも選べません)`
    }
  }

  if (perfOn) {
    perfRecord('list.proposal.scan.detail', performance.now() - perfT0, {
      files: entries.length,
      gateMs: Math.round(perfGateMs),
      baseMs: Math.round(perfBaseMs),
      baseN: perfBaseN,
      candidates: candidateItems.length,
    })
  }
  return candidateItems
}

/**
 * 合成提案の追い付き更新が使う、golden の実測（Plan r10 §4-4）: 記録されたコミットが golden の履歴に在り、
 * 対象ファイルの golden 上の sha256 が期待値と一致するか。1 つでも違えば false（未検証の提案を adopted にしない）。
 */
export function makeComposeVerifier(
  repoDir: string = findRepoRootDir(),
  baseRef = 'HEAD'
): (app: MergeApplication, skillName: string) => Promise<boolean> {
  return async (application, skillName) => {
    try {
      if (!application.commit || !isValidGitCommit(application.commit, repoDir)) return false
      if (!isCommitAncestor(application.commit, baseRef, repoDir)) return false
      for (const f of application.files) {
        const blob = getGoldenBlobContent(baseRef, `ccpit/golden/common/${f.lang}/skills/${skillName}/${f.relPath}`, repoDir)
        if (blob === null || composeContentHash(f.relPath, blob) !== f.sha256) return false
      }
      return true
    } catch (err) {
      // golden を git から読めなかったときは、検証できないので false（未検証の提案を adopted にしない）。理由は記録に残す
      if (isGoldenGitReadError(err)) {
        console.error('[compose-catchup] golden の実測を読めなかったため、adopted にしません:', err.message)
        return false
      }
      throw err
    }
  }
}

/** 合成台帳が applied_pending_states のものを、golden の実測で検証してから adopted まで追い付かせる */
export async function runComposeCatchUp(
  options: { repoDir?: string; proposalStorePaths?: ProposalStorePaths } = {}
): ReturnType<typeof composeCatchUp> {
  const stores = options.proposalStorePaths || getDefaultProposalStorePaths()
  return composeCatchUp({
    paths: getComposePaths(dirname(stores.statesPath)),
    setState: (id, st) => setProposalState(id, st, stores),
    verifyApplied: makeComposeVerifier(options.repoDir ?? findRepoRootDir())
  })
}

/**
 * 競合している提案 1 本を、提案側の状態で「却下」にする（昇格ブラウザから競合の相手をその場で外すための口）。
 * 書き口は「Skill 候補ブラウザ」の却下と同じ `setProposalState(requestId, 'rejected')`。
 * 画面から渡るのは候補の id だけで、書く直前に候補を走査し直し、(a) その id の提案が今も候補にあり (b) 今も競合している、
 * ときだけ書く。競合していない提案・候補に無い提案は却下しない（この口を、競合の解消以外の却下に使わせない）。
 * 昇格ブラウザの「見送り」とは別物: 見送りは昇格側の状態だけを変え、競合を解かない。
 */
export async function rejectConflictedProposal(
  candidateId: string,
  options: { repoDir?: string; proposalsDir?: string; proposalStorePaths?: ProposalStorePaths } = {}
): Promise<{ ok: boolean; requestId?: string; error?: string }> {
  const items = await scanProposalCandidates(options.repoDir, options.proposalsDir, options.proposalStorePaths)
  const item = items.find((i) => i.id === candidateId)
  if (!item || item.source !== 'proposal' || !item.proposalRequestId) {
    return { ok: false, error: '対象の提案が候補に見つかりません（すでに却下・採用された可能性があります。「更新」を押してください）' }
  }
  if (!item.isConflicted) {
    return { ok: false, error: 'この提案は競合していないため、この画面からは却下できません（却下は「Skill 候補ブラウザ」で行います）' }
  }
  await setProposalState(item.proposalRequestId, 'rejected', options.proposalStorePaths)
  return { ok: true, requestId: item.proposalRequestId }
}

/**
 * 反映しても golden へ入れられない提案か。元の版が今の golden と違う（diverged・evaluateProposalBase が止める）か、
 * 提案の中身が今の golden と同一（identical・入れる差が無い）なら、競合の相手として数えない。
 * これ以外の状態（将来増える状態を含む）は数える側に倒す＝競合の守りを弱めない向き。
 */
/** SKILL.md の差分の表示（F-3）。golden に無い・作れないときは undefined（従来の一覧の作り方と同じ） */
async function skillMdDiffDetail(
  goldenRootDir: string,
  skillName: string,
  newContent: string,
  /** 真なら、git から差分を読めなかったこと（GoldenGitReadError）を握りつぶさず投げる（詳細の欄を開いたとき。CCPIT_L0_014 P4） */
  opts: { throwOnGitRead?: boolean } = {}
): Promise<string | undefined> {
  const goldenSkillMdPath = join(goldenRootDir, 'common', 'ja', 'skills', skillName, 'SKILL.md')
  if (!existsSync(goldenSkillMdPath)) return undefined
  try {
    const goldenContent = await readFile(goldenSkillMdPath, 'utf-8')
    return createUpdateUnifiedDiff(`${JA_SKILLS_PREFIX}/${skillName}/SKILL.md`, goldenContent, newContent, tmpdir())
  } catch (e) {
    if (opts.throwOnGitRead && isGoldenGitReadError(e)) throw e
    return undefined
  }
}

/**
 * 選んだ候補 1 件の差分の表示（CCPIT_L0_004 W6）。画面の一覧の取得では差分を作らず、詳細の欄を開いたときにこれで作る。
 * 中身は主処理で読む: ローカルの候補は手元の ~/.claude/skills/<名前>/SKILL.md、提案は提案の SKILL.md（画面が一覧で受け取った値）。
 * 閲覧だけで、何も書き換えない（差分の一時ファイルは作った直後に消す）
 */
export async function getPromotionDiffDetail(
  item: { source: string; skillName: string; capturedContent?: string },
  options: { repoDir?: string; localSkillsDir?: string } = {}
): Promise<string | undefined> {
  if (typeof item?.skillName !== 'string' || !/^[A-Za-z0-9._-]+$/.test(item.skillName) || /^\.+$/.test(item.skillName)) {
    return undefined
  }
  const repoDir = options.repoDir || findRepoRootDir()
  const goldenRootDir = findGoldenRootDir(repoDir)
  if (item.source === 'normal') {
    const localSkillsDir =
      options.localSkillsDir ||
      (app?.getPath ? join(app.getPath('home'), '.claude', 'skills') : join(tmpdir(), '.claude', 'skills'))
    const localMd = join(localSkillsDir, item.skillName, 'SKILL.md')
    if (!existsSync(localMd)) return undefined
    return skillMdDiffDetail(goldenRootDir, item.skillName, await readFile(localMd, 'utf-8'), { throwOnGitRead: true })
  }
  if (item.source === 'proposal') {
    return skillMdDiffDetail(goldenRootDir, item.skillName, item.capturedContent || '', { throwOnGitRead: true })
  }
  return undefined
}

function isProposalUnliftable(it: Pick<PromotionItem, 'diverged' | 'diffState'>): boolean {
  return it.diverged === true || it.diffState === 'diverged' || it.diffState === 'identical'
}

/**
 * 昇格候補の一覧を取得する（3つの入口を1つの列に合流: rescue / normal / proposal）
 */
export async function listPromotionCandidates(
  options: CandidateScanOptions = {}
): Promise<PromotionItem[]> {
  return (await listPromotionCandidatesDetailed(options)).items
}

/** 一覧の取得で、検出が完了しなかった項目（CCPIT_L0_010）。健全時は空 */
export interface PromotionScanDiagnostics {
  /** 救済候補の検出が完了しなかった理由。無ければ、救済候補が 0 件でも確かに無い */
  rescueScanError?: string
}

/**
 * 一覧の検出が完了したかの診断だけを取る（読み取り専用）。画面が一覧の取得の後に呼び、「救済候補 0 件」が
 * 「確かに無い」のか「読めなかった」のかを見分けるのに使う。結果はモジュール変数に残さず、呼ぶたびに履歴を読み直す
 */
export async function getPromotionScanDiagnostics(
  options: CandidateScanOptions = {}
): Promise<PromotionScanDiagnostics> {
  const repoDir = options.repoDir || findRepoRootDir()
  const goldenRootDir = options.goldenRootDir || findGoldenRootDir(repoDir)
  const scan = scanRescueCandidatesDetailed(repoDir, goldenRootDir, options.effectiveMs ?? CONTRACT_EFFECTIVE_MS)
  return scan.scanError !== undefined ? { rescueScanError: scan.scanError } : {}
}

/** `listPromotionCandidates` の本体。items は従来と同じ。diagnostics は「0 件」と「読めなかった」を見分けるための付随情報 */
export async function listPromotionCandidatesDetailed(
  options: CandidateScanOptions = {}
): Promise<{ items: PromotionItem[]; diagnostics: PromotionScanDiagnostics }> {
  const diagnostics: PromotionScanDiagnostics = {}
  const repoDir = options.repoDir || findRepoRootDir()
  const localSkillsDir =
    options.localSkillsDir ||
    (app?.getPath ? join(app.getPath('home'), '.claude', 'skills') : join(tmpdir(), '.claude', 'skills'))
  const goldenRootDir = options.goldenRootDir || findGoldenRootDir(repoDir)
  const stateFilePath = options.stateFilePath || STATE_FILE
  const effectiveMs = options.effectiveMs ?? CONTRACT_EFFECTIVE_MS

  // 計測の口（CCPIT_L0_004 W6）: CCPIT_PERF_TRACE があるときだけ区間ごとの合計を記録する
  const perfOn = perfEnabled()
  const perfAcc: Record<string, { ms: number; n: number }> = {}
  const perfAdd = (k: string, t0: number): void => {
    if (!perfOn) return
    const a = (perfAcc[k] ??= { ms: 0, n: 0 })
    a.ms += performance.now() - t0
    a.n += 1
  }
  const perfT0 = perfOn ? performance.now() : 0
  let pt = perfOn ? performance.now() : 0

  const storedState = loadPromotionState(stateFilePath)
  const items: PromotionItem[] = []

  // CCPIT が配った golden の記録（~/.claude からの相対パス → 配った golden の指紋）
  const manifestPath = options.manifestPath ?? (options.localSkillsDir ? undefined : getManifestPath(CCPIT_DIR))
  const deployedManifest = manifestPath ? await readManifest(manifestPath) : null
  // ローカルを残した行（道 P2）の指紋は overlay の中身＝ローカルの指紋なので、元にした同梱 golden の版は
  // overlay 索引（台帳と同じフォルダ）から入口 `bundledBaseHashOf` 経由で得る。索引が読めなければ空 ＝ 信用しない側
  const overlayEntries = manifestPath ? (await readOverlayIndex(dirname(manifestPath))).entries : []
  const deployedHashByPath = trustedDeployedHashes(deployedManifest?.entries ?? [], overlayEntries)

  // 現在の base_master コミット SHA を取得
  let baseMasterSha = 'HEAD'
  try {
    const revRes = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' })
    if (revRes.status === 0 && revRes.stdout.trim()) {
      baseMasterSha = revRes.stdout.trim()
    }
  } catch {
    // fallback
  }

  // CCPIT 採用済みスキルの検出 (F-5: 既定絞り込み用)
  const adoptedSkillsPath = options.adoptedSkillsPath || join(CCPIT_DIR, 'adopted-skills.json')
  const adoptedSet = new Set<string>()
  if (existsSync(adoptedSkillsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(adoptedSkillsPath, 'utf-8'))
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item.name === 'string') adoptedSet.add(item.name)
        }
      }
    } catch {
      // ignore
    }
  }

  // ──────────────────────────────────────────────
  // 入口①: 救済（rescue）
  // ──────────────────────────────────────────────
  // 走査 1 回分の golden の木の写し（CCPIT_L0_004 W6）。作れなければ undefined のまま、従来の 1 件ずつの問い合わせになる。
  // CCPIT_PERF_NO_TREE_SNAPSHOT=1 は、計測（CCPIT_PERF_TRACE）のときだけ、同じ条件で写しの有無を比べるための口
  const treeDisabledForPerf = perfOn && process.env.CCPIT_PERF_NO_TREE_SNAPSHOT === '1'
  const goldenTree =
    baseMasterSha !== 'HEAD' && !treeDisabledForPerf
      ? snapshotGoldenSkillsTree(repoDir, baseMasterSha) ?? undefined
      : undefined
  perfAdd('list.prelude', pt)
  pt = perfOn ? performance.now() : 0
  let rawRescueItems: PromotionItem[]
  if (options.rescueItemsOverride !== undefined) {
    rawRescueItems = options.rescueItemsOverride
  } else {
    const rescueScan = scanRescueCandidatesDetailed(repoDir, goldenRootDir, effectiveMs)
    rawRescueItems = rescueScan.items
    if (rescueScan.scanError !== undefined) diagnostics.rescueScanError = rescueScan.scanError
  }
  perfAdd('list.rescue', pt)

  for (const rItem of rawRescueItems) {
    const persisted = storedState.items[rItem.id]
    const content = rItem.capturedContent || persisted?.capturedContent || ''
    const detail = content ? parseSkillDetail(content, rItem.skillName) : undefined
    items.push({
      ...rItem,
      state: persisted?.state || rItem.state || 'pending',
      viewed: persisted?.viewed ?? rItem.viewed ?? false,
      promotedAt: persisted?.promotedAt || rItem.promotedAt,
      commitSha: persisted?.commitSha || rItem.commitSha,
      capturedContent: content || undefined,
      skillDetail: detail,
      isAdopted: adoptedSet.has(rItem.skillName),
    })
  }

  // ──────────────────────────────────────────────
  // 入口②: 正規昇格（normal）
  // ローカル（~/.claude/skills）にあるすべての Skill を走査
  // 付随ファイル・除外規則・Git 三者系譜照合を適用 (W1 / W3)
  // ──────────────────────────────────────────────
  const jaSkillsGoldenDir = join(goldenRootDir, 'common', 'ja', 'skills')
  if (existsSync(localSkillsDir)) {
    try {
      const entries = await readdir(localSkillsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillName = entry.name
        const localSkillPath = join(localSkillsDir, skillName)
        const localSkillMdPath = join(localSkillPath, 'SKILL.md')

        if (!existsSync(localSkillMdPath)) continue

        // 付随ファイル走査 & 除外規則適用 (W1)
        pt = perfOn ? performance.now() : 0
        const scanResult = scanLocalSkillFiles(localSkillPath)
        const localRelPaths = new Set(scanResult.files.map((f) => f.relPath))

        // golden 側にのみ存在する余剰ファイル検知
        const goldenSkillPath = join(jaSkillsGoldenDir, skillName)
        const extraGoldenFiles = scanExtraGoldenFiles(goldenSkillPath, localRelPaths)
        perfAdd('list.normal.scanFiles', pt)
        pt = perfOn ? performance.now() : 0

        // Git 三者照合による系譜判定 (MAJOR 5 / stale-local 巻き戻し防止 / diverged 競合検知)
        const goldenTargetDir = `ccpit/golden/common/ja/skills/${skillName}`
        const deployedGoldenHashes = new Map<string, string>()
        const deployedPrefix = `skills/${skillName}/`
        for (const [p, h] of deployedHashByPath) {
          if (p.startsWith(deployedPrefix)) deployedGoldenHashes.set(p.slice(deployedPrefix.length), h)
        }
        const lineage = determineSkillLineageState({
          repoDir,
          baseMasterSha,
          goldenTargetDir,
          localFiles: scanResult.files,
          deployedGoldenHashes,
          tree: goldenTree,
        })
        perfAdd('list.normal.lineage', pt)
        pt = perfOn ? performance.now() : 0

        const localContent = await readFile(localSkillMdPath, 'utf-8')
        const detail = parseSkillDetail(localContent, skillName)

        // Unified diff 全文詳細プレビュー (F-3) の生成。画面の一覧の取得では作らず、選んだときに作る（CCPIT_L0_004 W6）
        const diffDetail =
          options.withDiffDetail === false ? undefined : await skillMdDiffDetail(goldenRootDir, skillName, localContent)
        perfAdd('list.normal.readAndDiff', pt)

        const fileStat = await stat(localSkillMdPath)
        const addedAt = fileStat.mtime.toISOString().split('T')[0]
        const id = `normal:${skillName}`
        const persisted = storedState.items[id]

        const companionFilesCount = scanResult.files.filter((f) => f.relPath !== 'SKILL.md').length

        items.push({
          id,
          title: detail.title !== '不明' ? detail.title : skillName,
          skillName,
          addedAt,
          source: 'normal',
          state: persisted?.state || 'pending',
          diffState: lineage.diffState,
          diverged: lineage.diverged,
          targetPath: `${goldenTargetDir}/SKILL.md`,
          localPath: localSkillPath,
          description: detail.description,
          diffSummary: lineage.diffSummary,
          diffDetail,
          skillDetail: detail,
          isAdopted: adoptedSet.has(skillName),
          authorStatement: '不明',
          lane: '不明',
          viewed: persisted?.viewed ?? false,
          promotedAt: persisted?.promotedAt,
          commitSha: persisted?.commitSha,
          skippedFiles: scanResult.skippedFiles,
          extraGoldenFiles,
          companionFilesCount,
          ...(lineage.gitReadError ? { gitReadError: true } : {}),
        })
      }
    } catch (err) {
      console.error('Failed to scan local skills directory:', err)
    }
  }

  // ──────────────────────────────────────────────
  // 入口③: CC 提案昇格（proposal - W2 準拠）
  // ──────────────────────────────────────────────
  try {
    pt = perfOn ? performance.now() : 0
    const proposalItems = await scanProposalCandidates(
      repoDir,
      options.proposalsDir,
      options.proposalStorePaths,
      goldenTree
    )
    perfAdd('list.proposal.scan', pt)
    pt = perfOn ? performance.now() : 0
    for (const pItem of proposalItems) {
      const persisted = storedState.items[pItem.id]
      const skillName = pItem.skillName
      const goldenSkillMdPath = join(jaSkillsGoldenDir, skillName, 'SKILL.md')

      let diffDetail: string | undefined = undefined
      let diffState = pItem.diffState || 'modified'
      let diffSummary = pItem.diffSummary || 'CC 提案による更新'

      // 差分の表示は、画面の一覧の取得では作らず、選んだときに作る（CCPIT_L0_004 W6。withDiffDetail: false）
      const wantDiff = options.withDiffDetail !== false
      // 元の版が今の golden と違う提案（diverged・evaluateProposalBase）は、下の作業ツリーの確かめで上書きしない
      if (pItem.diffState === 'diverged') {
        // 差分の表示だけは作る
        if (wantDiff && existsSync(goldenSkillMdPath)) {
          diffDetail = await skillMdDiffDetail(goldenRootDir, skillName, pItem.capturedContent || '')
        }
      } else if (existsSync(goldenSkillMdPath)) {
        if (wantDiff) diffDetail = await skillMdDiffDetail(goldenRootDir, skillName, pItem.capturedContent || '')
      } else {
        diffState = 'new'
        diffSummary = '新規追加 (CC 提案)'
      }

      if (pItem.isConflicted) {
        diffState = 'proposal-conflict'
      }

      items.push({
        ...pItem,
        diffState,
        diffSummary,
        diffDetail,
        state: persisted?.state || pItem.state || 'pending',
        viewed: persisted?.viewed ?? pItem.viewed ?? false,
        promotedAt: persisted?.promotedAt || pItem.promotedAt,
        commitSha: persisted?.commitSha || pItem.commitSha,
        isAdopted: adoptedSet.has(skillName),
      })
    }
    perfAdd('list.proposal.diffs', pt)
  } catch (err) {
    console.error('Failed to scan proposal candidates:', err)
  }

  if (perfOn) {
    perfRecord('list.total', performance.now() - perfT0, {
      items: items.length,
      stages: Object.fromEntries(
        Object.entries(perfAcc).map(([k, v]) => [k, { ms: Math.round(v.ms), n: v.n }])
      ),
    })
  }
  return { items, diagnostics }
}

/**
 * アイテムの閲覧フラグ（viewed）を更新
 */
export function markPromotionItemViewed(
  id: string,
  stateFilePath: string = STATE_FILE
): void {
  const state = loadPromotionState(stateFilePath)
  if (!state.items[id]) {
    state.items[id] = { state: 'pending', viewed: true }
  } else {
    state.items[id].viewed = true
  }
  savePromotionState(state, stateFilePath)
}

/**
 * 複数アイテムの状態を一括更新（例: 見送り、未処理に戻す、配布済みにする）
 */
export function setPromotionItemsState(
  ids: string[],
  nextState: PromotionState,
  stateFilePath: string = STATE_FILE
): void {
  const state = loadPromotionState(stateFilePath)
  for (const id of ids) {
    if (!state.items[id]) {
      state.items[id] = { state: nextState, viewed: false }
    } else {
      state.items[id].state = nextState
    }
  }
  savePromotionState(state, stateFilePath)
}

export interface PromotionApplyOptions {
  repoDir?: string
  toolPath?: string
  stateFilePath?: string
  reviewReportDir?: string
  lane?: string
  withdrawnDir?: string
  runsDir?: string
  onProgress?: (ev: PromotionProgressEvent) => void
  parcFermeDir?: string
  targetDir?: string
  manifestPath?: string
  goldenRels?: Set<string>
  templateName?: GoldenTemplateName
  proposalStorePaths?: ProposalStorePaths
  __testPostPreflightHook?: () => Promise<void>
  __testPostDoubleCheckHook?: (phase: 'rescue_stage3' | 'normal_step4') => Promise<void>
  /** この PC の配置の言語（既定は app-config の language。読めなければ ja 以外として扱う）。試験が指定する */
  language?: 'ja' | 'en'
  /** 提案の道が写しを書く直前（宛先ごと）。試験が「直前に利用者が書き換えた」「書き込みが失敗した」を再現する */
  __testBeforeLocalCopyWriteHook?: (destPath: string) => Promise<void>
  __testPreWriteManifestHook?: () => Promise<void>
  __testPreRenameHook?: () => Promise<void>
}

export interface PromotionApplyResult {
  success: boolean
  commitSha?: string
  manifestSha256?: string
  appliedItems: string[]
  error?: string
  runnerLog?: string
  /** 提案から上げたとき、この PC の写しをどう扱ったか（ファイルごと）。提案の道が無ければ付かない */
  localCopyReport?: LocalCopyReportEntry[]
}

/**
 * 逆昇格したスキルをローカル配置台帳（golden-manifest.json）へ同期登録する（W-2 / ADR 0002）。
 *
 * 逆昇格（ローカル→golden）が成立した際、ローカルの配置台帳に `owner: 'promoted'` で
 * 当該スキルのエントリを登録・更新する。これにより、次回アプリ起動時の照合で
 * 「配置記録なし（unknown-base）／上書き確認」という不要な確認ダイアログの誤検知を防ぐ。
 *
 * @param opts.manifestPath golden-manifest.json の絶対パス
 * @param opts.targetDir 配置先ルート（通常 ~/.claude）
 * @param opts.items 昇格したスキル名・ローカルパス・ハッシュ（LF正規化sha256）の一覧
 * @param opts.deployedAt 昇格日時（ISO8601）
 * @param opts.goldenRels 現配布 golden に含まれる相対パス集合（goldenSetHash の計算対象スコープ）
 * @param opts.templateName テンプレート名（新規作成時必須、KNOWN_TEMPLATES 準拠）
 * @param opts.lockToken 再入可能排他ロックトークン
 * @param opts.expectedManifestSha Pre-flight 時点の台帳 SHA-256（別台帳差し替え検知）
 */
export async function syncPromotedToLocalManifest(opts: {
  manifestPath: string
  targetDir: string
  items: Array<{
    skillName: string
    localPath?: string
    hash: string
    /**
     * 今回の昇格が運んだ全ファイル（SKILL.md を含む）の行を書く（069 発注 3 / M13）。`relPath` はスキルのフォルダからの相対パス、
     * `hash` は配置の記録の `goldenHash` と同じ決まり（`hashFileBuffer`）。未指定なら従来どおり SKILL.md の 1 行だけ（`hash`）。
     */
    files?: Array<{
      relPath: string
      hash: ManifestHash
      /** 書いた直後に写しを読み戻した指紋。この昇格が写しを書いた行だけ渡す（渡さなければ既存行の値を保つ） */
      postHash?: string
    }>
    /** true: `files` に SKILL.md が無くてよい（SKILL.md の写しを書かなかった品目。書かなかった行は作らない） */
    partial?: boolean
    /**
     * 写しをそろえられなかったファイル。その記録の行の `goldenHash` が `hash`（新しい版）と同じなら、実物と食い違う偽の行なので消す。
     * 新しい版を指さない行（以前の版のまま）は触らない。
     */
    staleClaims?: Array<{ relPath: string; hash: ManifestHash }>
  }>
  deployedAt: string
  goldenRels?: Set<string> | Iterable<string>
  templateName?: GoldenTemplateName
  lockToken?: string
  expectedManifestSha?: string | null
  __testPreWriteManifestHook?: () => Promise<void>
  __testPreRenameHook?: () => Promise<void>
}): Promise<boolean> {
  const { manifestPath, targetDir, items, deployedAt } = opts
  if (items.length === 0) return true

  const mExists = existsSync(manifestPath)
  let manifest = await readManifest(manifestPath)

  if (!mExists) {
    // 物理的不在
    const tName = opts.templateName
    if (!tName || !(KNOWN_TEMPLATES as readonly string[]).includes(tName)) {
      throw new Error(
        `ローカル配置台帳が存在せず、実配布テンプレート名が未指定または未知の値です（指定: '${tName}'、許可: ${KNOWN_TEMPLATES.join('/')}）。`
      )
    }
    manifest = {
      manifestVersion: MANIFEST_VERSION,
      template: tName,
      goldenSetHash: '',
      deployedAt,
      entries: []
    }
  } else if (!manifest) {
    // 物理的に存在するが readManifest が null（空・破損・未対応バージョン）
    throw new Error(
      '既存のローカル配置台帳が空・破損・未対応バージョンです。上書き初期化を防止するため同期を拒否します。'
    )
  } else {
    // 正常な既存台帳が存在する場合
    const currentTemplate = manifest.template
    if (!currentTemplate || !(KNOWN_TEMPLATES as readonly string[]).includes(currentTemplate)) {
      throw new Error(
        `既存のローカル配置台帳に記録されているテンプレート名が未設定または未知の値です（記録値: '${String(currentTemplate)}'、許可: ${KNOWN_TEMPLATES.join('/')}）。`
      )
    }
  }

  // Pre-flight SHA 照合（有効な別台帳差し替え検知 & 不在からの新規出現検知）
  if (opts.expectedManifestSha !== undefined) {
    const currentSha = mExists
      ? createHash('sha256').update(readFileSync(manifestPath)).digest('hex')
      : null
    if (currentSha !== opts.expectedManifestSha) {
      throw new Error(
        `同期直前にローカル台帳ファイルが外部により変更・置換または新規作成されました（期待SHA: ${opts.expectedManifestSha ?? 'NONE(不在)'}, 実測SHA: ${currentSha ?? 'NONE(不在)'}）。上書きを防止するため同期を拒否します。`
      )
    }
  }

  const byPath = new Map<string, ManifestEntry>()
  for (const e of manifest.entries) {
    byPath.set(normalizeRelPath(e.path), e)
  }

  for (const it of items) {
    let relPath = `skills/${it.skillName}/SKILL.md`
    if (it.localPath) {
      const computed = normalizeRelPath(relative(targetDir, join(it.localPath, 'SKILL.md')))
      if (computed !== '' && !computed.startsWith('../') && computed !== '..') {
        relPath = computed
      }
    }

    // 書く行: SKILL.md（`it.hash`）＋運んだ付随ファイル。付随ファイルの行のパスは `<スキルのフォルダ>/<relPath>` を
    // 組み立て、スキルのフォルダの外へ出るもの（`..`・絶対パス）は台帳に書かない
    const skillDirRel = dirname(relPath).replace(/\\/g, '/')
    // `files` を渡す呼び出しは SKILL.md の行も `files` の指紋（ManifestHash）で書く。`hash`（契約の指紋のこともある）を
    // 台帳の goldenHash に使うのは `files` 無しの従来の呼び出しだけ
    if (it.files && !it.partial && !it.files.some((f) => normalizeRelPath(f.relPath) === 'SKILL.md')) {
      throw new Error(`ローカル配置台帳へ書く files に SKILL.md がありません: ${it.skillName}`)
    }
    const rows = new Map<string, string>(it.files ? [] : [[relPath, it.hash]])
    const newPostHashes = new Map<string, string>()
    for (const f of it.files ?? []) {
      const fileRel = normalizeRelPath(f.relPath)
      if (fileRel === '' || isAbsolute(fileRel) || /^[A-Za-z]:/.test(fileRel) || /(?:^|\/)\.\.(?:\/|$)/.test(fileRel)) {
        throw new Error(`ローカル配置台帳へ書く付随ファイルのパスが不正です: ${f.relPath}`)
      }
      const rowPath = fileRel === 'SKILL.md' ? relPath : `${skillDirRel}/${fileRel}`
      rows.set(rowPath, f.hash)
      if (f.postHash) newPostHashes.set(rowPath, f.postHash)
    }
    for (const claim of it.staleClaims ?? []) {
      const fileRel = normalizeRelPath(claim.relPath)
      if (fileRel === '' || isAbsolute(fileRel) || /^[A-Za-z]:/.test(fileRel) || /(?:^|\/)\.\.(?:\/|$)/.test(fileRel)) continue
      const claimPath = fileRel === 'SKILL.md' ? relPath : `${skillDirRel}/${fileRel}`
      if (byPath.get(claimPath)?.goldenHash === claim.hash) byPath.delete(claimPath)
    }
    for (const [rowPath, rowHash] of rows) {
      const prev = byPath.get(rowPath)
      const rowPostHash = newPostHashes.get(rowPath) ?? prev?.postHash
      byPath.set(rowPath, {
        path: rowPath,
        goldenHash: rowHash,
        owner: 'promoted', // ADR 0002: 逆向き反映
        deployedAt,
        ...(prev?.exec !== undefined ? { exec: prev.exec } : {}),
        // 写しを書いた行は読み戻し指紋。書いていない行は前の値を保つ（配置先へは書いていない）
        ...(rowPostHash ? { postHash: rowPostHash } : {})
      })
    }
  }

  const entries = [...byPath.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  )

  // 集合ハッシュは現配布 golden 集合（goldenRels）に絞って計算（writeLedger と一致）。
  // goldenRels が明示指定された場合のみ再計算し、未指定（供給不能時）は既存の goldenSetHash を
  // 勝手に全 entries で再計算して壊さず、既存値を維持する（早期打切り契約保護）。
  let goldenSetHash = manifest.goldenSetHash
  if (opts.goldenRels) {
    const filterSet = new Set(opts.goldenRels)
    const targetEntries = entries.filter((e) => filterSet.has(e.path))
    goldenSetHash = computeSetHash(
      targetEntries.map((e) => ({ path: e.path, hash: e.goldenHash }))
    )
  } else if (!goldenSetHash) {
    // 初回台帳作成時のみフォールバック
    goldenSetHash = computeSetHash(
      entries.map((e) => ({ path: e.path, hash: e.goldenHash }))
    )
  }

  const updatedManifest: GoldenManifest = {
    ...manifest,
    goldenSetHash,
    deployedAt,
    entries
  }

  if (opts.__testPreWriteManifestHook) {
    await opts.__testPreWriteManifestHook()
  }

  await writeManifest(manifestPath, updatedManifest, {
    lockToken: opts.lockToken,
    expectedManifestSha: opts.expectedManifestSha,
    __testPreRenameHook: opts.__testPreRenameHook,
  })
  return true
}

/**
 * 英語スタブの生成（ja/en の集合対称性維持のため）
 */
export function generateEnStubSkillMd(skillName: string, jaContent: string): string {
  const { title } = parseSkillInfo(jaContent)
  return `---
name: "${skillName}"
description: "[Translation Pending] Golden skill: ${skillName}"
---

# ${skillName}

> [!NOTE]
> English documentation is currently pending translation.
> Original Japanese specification is provided in \`common/ja/skills/${skillName}/SKILL.md\`.

- **Name**: ${skillName}
- **Reference Title**: ${title}
`
}

/**
 * 削除用の Unified Diff パッチを生成 (F-2, G-2)
 */
export function createDeleteUnifiedDiff(targetRelPath: string, oldContent: string): string {
  const normPath = targetRelPath.replace(/\\/g, '/')
  const normalized = normalizeEol(oldContent)
  const lines = normalized.split('\n')
  let contentLines = lines
  let hasTrailing = true
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    contentLines = lines.slice(0, -1)
  } else {
    hasTrailing = false
  }
  const lineCount = contentLines.length
  if (lineCount === 0) {
    return `--- a/${normPath}\n+++ /dev/null\n@@ -0,0 +0,0 @@\n`
  }
  const deletedLines = contentLines.map((l) => `-${l}`).join('\n')
  const trailingNewline = hasTrailing ? '\n' : '\n\\ No newline at end of file\n'

  return `--- a/${normPath}\n+++ /dev/null\n@@ -1,${lineCount} +0,0 @@\n${deletedLines}${trailingNewline}`
}

/**
 * 新規追加用の Unified Diff パッチを生成
 */
export function createAddUnifiedDiff(targetRelPath: string, content: string): string {
  const normPath = targetRelPath.replace(/\\/g, '/')
  const normalized = normalizeEol(content)
  if (normalized === '') {
    return `--- /dev/null\n+++ b/${normPath}\n@@ -0,0 +0,0 @@\n`
  }
  const lines = normalized.split('\n')
  let contentLines = lines
  let hasTrailing = true
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    contentLines = lines.slice(0, -1)
  } else {
    hasTrailing = false
  }
  const lineCount = contentLines.length
  if (lineCount === 0) {
    return `--- /dev/null\n+++ b/${normPath}\n@@ -0,0 +0,0 @@\n`
  }
  const addedLines = contentLines.map((l) => `+${l}`).join('\n')
  const trailingNewline = hasTrailing ? '\n' : '\n\\ No newline at end of file\n'

  return `--- /dev/null\n+++ b/${normPath}\n@@ -0,0 +1,${lineCount} @@\n${addedLines}${trailingNewline}`
}

/**
 * 更新用の Unified Diff パッチを生成（git diff --no-index を利用）
 */
export function createUpdateUnifiedDiff(
  targetRelPath: string,
  oldContent: string,
  newContent: string,
  workDir: string
): string {
  const normPath = targetRelPath.replace(/\\/g, '/')
  const normOld = normalizeEol(oldContent)
  const normNew = normalizeEol(newContent)
  if (normOld === normNew) {
    // 差分なし
    return ''
  }

  const oldPath = join(workDir, `diff_old_${randomBytes(4).toString('hex')}.tmp`)
  const newPath = join(workDir, `diff_new_${randomBytes(4).toString('hex')}.tmp`)

  // 一時ファイルは成否にかかわらず消す（CCPIT_L0_004 W1。一覧を開くたびに OS の一時領域へ溜まっていた）
  let diffOutput: string
  try {
    writeFileSync(oldPath, normOld, 'utf-8')
    writeFileSync(newPath, normNew, 'utf-8')
    // 終了 1 は「差がある」＝正常。0・1 以外（128・起動失敗・時間切れ・signal・出力溢れ）は、旧は出力が空＝「差分の生成に失敗」と
    // 区別できなかったので、読めなかった例外にする（CCPIT_L0_014 P4。cwd は一時の作業場＝リポジトリの外で、パスは絶対）
    const run = runGoldenGit(
      workDir,
      ['diff', '--no-index', '--src-prefix=a/', '--dst-prefix=b/', oldPath, newPath],
      { encoding: 'utf-8', okExitCodes: [1] }
    )
    if (!run.ok) {
      throw new GoldenGitReadError({ op: 'diff', relPath: normPath, failure: run.failure })
    }
    diffOutput = (run.stdout as string) || ''
  } finally {
    for (const p of [oldPath, newPath]) {
      try {
        rmSync(p, { force: true })
      } catch {
        // 消せなくても差分の生成は続ける（次の清掃・OS の掃除に任せる）
      }
    }
  }
  const lines = diffOutput.split('\n')
  const hunkIdx = lines.findIndex((l) => l.startsWith('@@'))
  if (hunkIdx === -1) {
    throw new Error(`差分の生成に失敗しました: ${targetRelPath}`)
  }
  const hunks = lines.slice(hunkIdx).join('\n')
  return `--- a/${normPath}\n+++ b/${normPath}\n${hunks}`
}

/**
 * GUI 承認記録の Markdown を生成（契約 r19 追補条項 7-b 準拠）
 */
export function generateApprovalRecordMd(params: {
  timestamp: string
  approvedBy: string
  manifestSha256: string
  lionSha8: string
  items: PromotionItem[]
}): string {
  const rows = params.items
    .map(
      (item, idx) =>
        `| ${idx + 1} | \`${item.skillName}\` | ${item.source === 'rescue' ? '救済' : '正規昇格'} | \`${item.targetPath}\` |`
    )
    .join('\n')

  return `---
report_id: approval-${params.lionSha8}
document_type: approval-record
author: "${params.approvedBy}"
created_at: "${params.timestamp}"
contract_revision: r19
clause: "7-b (GUI 由来の承認)"
manifest_sha256: "${params.manifestSha256}"
lion_sha8: "${params.lionSha8}"
---

# Golden 昇格ブラウザ GUI 承認記録

## 承認概要
- **承認日時**: ${params.timestamp}
- **承認者**: ${params.approvedBy}（画面一括承認操作）
- **照合契約**: 契約 r19 追補条項 7-b（照合先 2 点: maintainer sha8 ＋ 本承認記録記載値）
- **MANIFEST SHA-256**: \`${params.manifestSha256}\`
- **maintainer承認 SHA-8**: \`${params.lionSha8}\`
- **対象件数**: ${params.items.length} 件

## 承認対象一覧
| # | Skill 名 | 入口種別 | 配置先パス |
|---|---|---|---|
${rows}

> [!NOTE]
> 本承認記録は CCPIT Golden 昇格ブラウザにより機械生成された正規の承認根拠です。
> 追補条項 7-b に基づき、契約実行ツールはこの報告書を自己読取して照合します。
`
}

export function getGoldenPromotionRunsDir(): string {
  return PROMOTION_RUNS_DIR
}

export function savePromotionRunRecord(record: PromotionRunRecord, runsDir: string = PROMOTION_RUNS_DIR): void {
  try {
    if (!existsSync(runsDir)) {
      mkdirSyncSafe(runsDir)
    }
    const filePath = join(runsDir, `${record.runId}.json`)
    writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8')
  } catch (err) {
    console.error('Failed to save promotion run record:', err)
  }
}

export function loadAllPromotionRunRecords(runsDir: string = PROMOTION_RUNS_DIR): {
  records: PromotionRunRecord[]
  hasError: boolean
} {
  if (!existsSync(runsDir)) {
    return { records: [], hasError: false }
  }
  try {
    const files = readdirSync(runsDir)
    const records: PromotionRunRecord[] = []
    let hasError = false
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const fullPath = join(runsDir, f)
      try {
        const content = readFileSync(fullPath, 'utf-8')
        const parsed = JSON.parse(content) as PromotionRunRecord
        if (parsed && parsed.runId && typeof parsed.pid === 'number' && typeof parsed.hostname === 'string') {
          records.push(parsed)
        } else {
          hasError = true
        }
      } catch {
        hasError = true
      }
    }
    return { records, hasError }
  } catch {
    return { records: [], hasError: true }
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err.code === 'EPERM'
  }
}

/**
 * What 1 & Codex 指摘反映: クラッシュした孤立昇格実行記録の回収・終了認定 (追補条項 L-b(i))
 * 単一の PID 不在だけを根拠にした死亡推定は行わず、
 * 「同一ホスト」「同一クローン」「対象 PID の OS プロセス不在」「ハートビート停止時間 ≥ 30秒」の
 * 多層根拠が全て成立した場合にのみ、CCPIT 自身が正直に終了を記録する。
 */
export function reconcileOrphanPromotionRuns(
  repoDir: string = findRepoRootDir(),
  runsDir: string = PROMOTION_RUNS_DIR,
  options?: { now?: Date }
): { reconciledCount: number; reconciledRunIds: string[] } {
  const { records, hasError } = loadAllPromotionRunRecords(runsDir)
  // フェイルクローズ: 破損記録が存在する場合は一切の回収・変更を拒否
  if (hasError) {
    return { reconciledCount: 0, reconciledRunIds: [] }
  }

  const now = options?.now || new Date()
  const staleThresholdMs = ORPHAN_HEARTBEAT_STALE_MS // Codex 指摘反映: 引数による短縮を原理的に排除し 30 秒下限を強制
  const currentHost = hostname().toLowerCase()
  const normRepoDir = repoDir.replace(/\\/g, '/').toLowerCase()

  const reconciledRunIds: string[] = []

  for (const record of records) {
    // 既に終了記録があるものはスキップ（完全冪等）
    if (record.endedAt !== undefined || record.exitCode !== undefined) {
      continue
    }

    // 1. 同一ホストの検証
    const recordHost = (record.hostname || '').toLowerCase()
    if (!recordHost || recordHost !== currentHost) {
      continue
    }

    // 2. 同一クローンの検証
    const recordRepo = (record.repoDir || '').replace(/\\/g, '/').toLowerCase()
    if (!recordRepo || recordRepo !== normRepoDir) {
      continue
    }

    // 3. OS プロセスの不在確認 (PID が生存していれば絶対に回収しない)
    if (isProcessAlive(record.pid)) {
      continue
    }

    // 4. ハートビート停止時間の検証 (Stale Heartbeat Check)
    const refTimeStr = record.lastHeartbeatAt || record.startedAt
    if (!refTimeStr) {
      continue
    }
    const refTimeMs = new Date(refTimeStr).getTime()
    if (isNaN(refTimeMs)) {
      continue
    }
    const elapsedMs = now.getTime() - refTimeMs
    // 境界値厳格検査: staleThresholdMs 未満（例: 29,999 ms）は回収拒否
    if (elapsedMs < staleThresholdMs) {
      continue
    }

    // 多層根拠の全条件成立: CCPIT 自身が正直に終了認定を記録
    const elapsedSec = (elapsedMs / 1000).toFixed(1)
    record.endedAt = now.toISOString()
    record.endedAtSource = 'ccpit-crash-recovery'
    record.endedAtNote = `クラッシュまたは強制終了による孤立実行を検知。同一ホスト・同一クローンの PID 不在 (${record.pid}) およびハートビート停止 (${elapsedSec} 秒) の多層根拠に基づき CCPIT が終了と認定。`

    savePromotionRunRecord(record, runsDir)
    reconciledRunIds.push(record.runId)
  }

  return {
    reconciledCount: reconciledRunIds.length,
    reconciledRunIds,
  }
}

interface SessionOwnerMeta {
  repoDir: string
  pid: number
  createdAt: string
  lane: string
  hostname: string
  workDirName: string
}

/**
 * 作業場の持ち主の記録。書けなければ例外を投げ、呼び出し元は作業を始めない（CCPIT_L0_004・Codex 実装レビュー 3 巡目）。
 * 清掃はこの記録の無いフォルダを消さないので、書けないまま進むと、CCPIT 自身の作業場が「持ち主不明」で残りうる。
 * 呼び出し元 5 種（昇格・撤去・復帰・戻し・追い付け）は、どれも失敗の経路で作業場を消す（finally / catch）
 */
async function writeSessionOwnerMeta(
  workDir: string,
  repoDir: string,
  lane: string = 'gui-promotion'
): Promise<void> {
  const meta: SessionOwnerMeta = {
    repoDir,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    lane,
    hostname: hostname(),
    workDirName: basename(workDir),
  }
  try {
    await writeFile(join(workDir, 'session-owner.json'), JSON.stringify(meta, null, 2), 'utf-8')
  } catch (err) {
    throw new Error(`作業場の持ち主の記録（session-owner.json）を書けませんでした。作業を始めません: ${String(err)}`)
  }
}

type PromotionProgressListener = (ev: PromotionProgressEvent) => void
const progressListeners: Set<PromotionProgressListener> = new Set()

export function onPromotionProgress(listener: PromotionProgressListener): () => void {
  progressListeners.add(listener)
  return () => {
    progressListeners.delete(listener)
  }
}

function notifyPromotionProgress(ev: PromotionProgressEvent): void {
  for (const listener of progressListeners) {
    try {
      listener(ev)
    } catch (err) {
      console.error('Error in promotion progress listener:', err)
    }
  }
}

/**
 * 契約実行ツール（golden-apply.mjs）の安全な実行ヘルパー (C-7 単一窓口)
 */
async function runGoldenApplyHelper(params: {
  repoDir: string
  toolPath: string
  manifestPath: string
  manifestSha256: string
  reviewReportPath: string
  lionSha8: string
  lane?: string
  runsDir?: string
  onProgress?: (ev: PromotionProgressEvent) => void
}): Promise<{ code: number; stdout: string; stderr: string; runRecord?: PromotionRunRecord }> {
  const runId = randomBytes(8).toString('hex')
  const runsDir = params.runsDir || PROMOTION_RUNS_DIR
  const nowIso = new Date().toISOString()
  // 契約実行ツールが作るブランチ・worktree の名前は、ここで決めて渡す（CCPIT_L0_004 W3）。
  // golden-apply.mjs は `golden-apply/<lionSha8>-<session8>` と `golden-wt-<lionSha8>-*` を作る
  const session8 = randomBytes(4).toString('hex')

  const record: PromotionRunRecord = {
    runId,
    pid: 0,
    lane: params.lane || 'gui-promotion',
    manifestSha256: params.manifestSha256,
    startedAt: nowIso,
    lastHeartbeatAt: nowIso,
    repoDir: params.repoDir,
    hostname: hostname(),
    session8,
    goldenApplyBranch: `golden-apply/${params.lionSha8}-${session8}`,
    worktreePrefix: `golden-wt-${params.lionSha8}-`,
  }
  // 持ち主の記録は、子がブランチを作るより前に残す（PID は起動の後に書き足す）
  savePromotionRunRecord(record, runsDir)

  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        params.toolPath,
        '--repo-dir',
        params.repoDir,
        '--manifest',
        params.manifestPath,
        '--lion-sha8',
        params.lionSha8,
        '--review-report-path',
        params.reviewReportPath,
        '--review-manifest-sha256',
        params.manifestSha256,
        '--lane',
        params.lane || 'gui-promotion',
        '--session8',
        session8,
      ],
      {
        cwd: params.repoDir,
        // process.execPath は Electron 本体。Electron 公式の ELECTRON_RUN_AS_NODE=1 を渡して
        // golden-apply.mjs（とその子プロセス）を素の Node として実行させる。
        // これが無いと Electron アプリとして起動し、自然終了する子スクリプトが exit しない。
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      }
    )

    if (child.pid) {
      record.pid = child.pid
      savePromotionRunRecord(record, runsDir)
    }

    let stdout = ''
    let stderr = ''
    let stdoutBuffer = ''

    const processLine = (line: string) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('@@PX ')) {
        try {
          const jsonStr = trimmed.slice(5).trim()
          const data = JSON.parse(jsonStr)
          const t = data.t || new Date().toISOString()
          record.lastHeartbeatAt = t

          if (data.ev === 'step') {
            record.currentStep = { i: data.i, n: data.n, name: data.name }
            const evPayload: PromotionProgressEvent = {
              runId,
              stepIndex: data.i,
              totalSteps: data.n,
              stepName: data.name,
              timestamp: t,
              leaseId: record.leaseId,
            }
            params.onProgress?.(evPayload)
            notifyPromotionProgress(evPayload)
          } else if (data.ev === 'lease') {
            record.leaseId = data.id
            const evPayload: PromotionProgressEvent = {
              runId,
              stepIndex: record.currentStep?.i ?? 0,
              totalSteps: record.currentStep?.n ?? 11,
              stepName: record.currentStep?.name ?? 'acquire-lease',
              timestamp: t,
              leaseId: data.id,
            }
            params.onProgress?.(evPayload)
            notifyPromotionProgress(evPayload)
          }
          savePromotionRunRecord(record, runsDir)
        } catch {
          // ignore malformed @@PX line
        }
      }
    }

    child.stdout.on('data', (d) => {
      const str = d.toString()
      stdout += str
      stdoutBuffer += str
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() || ''
      for (const line of lines) {
        processLine(line)
      }
    })

    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })

    child.on('close', (code) => {
      if (stdoutBuffer) {
        processLine(stdoutBuffer)
      }
      record.endedAt = new Date().toISOString()
      record.exitCode = code ?? 1
      savePromotionRunRecord(record, runsDir)
      resolve({ code: code ?? 1, stdout, stderr, runRecord: record })
    })

    child.on('error', (err) => {
      record.endedAt = new Date().toISOString()
      record.exitCode = 1
      savePromotionRunRecord(record, runsDir)
      resolve({ code: 1, stdout: '', stderr: err.message, runRecord: record })
    })
  })
}

/**
 * 選択したアイテムを一括承認し、契約実行ツール経由で golden へ反映する
 */
export async function applyPromotionItems(
  items: PromotionItem[],
  options: PromotionApplyOptions = {}
): Promise<PromotionApplyResult> {
  if (items.length === 0) {
    return {
      success: false,
      appliedItems: [],
      error: '承認対象のアイテムが選択されていません。',
    }
  }

  // 排他制御 (Finding 3)
  if (isPromotionApplying) {
    return {
      success: false,
      appliedItems: [],
      error: '別の昇格処理が実行中です。完了するまでお待ちください。',
    }
  }

  const lockResult = acquireManifestLock('goldenPromotion:apply')
  if (!lockResult.ok) {
    return {
      success: false,
      appliedItems: [],
      error: lockResult.error,
    }
  }
  const manifestLockToken = lockResult.lockToken

  isPromotionApplying = true
  let workDir: string | null = null

  try {
    // リポジトリルートの決定 (Finding 7)
    const repoDir = options.repoDir || findRepoRootDir()

    const goldenRootDir = findGoldenRootDir(repoDir)
    const ledgerPath = join(goldenRootDir, 'common', 'golden-ledger.json')
    const ledgerCheck = readGoldenLedgerValidated(ledgerPath)
    if (ledgerCheck.status === 'corrupt') {
      return {
        success: false,
        appliedItems: [],
        error: `台帳破損エラー: golden-ledger.json が壊れているため昇格を拒否しました (${ledgerCheck.error})`,
      }
    }

    const toolPath =
      options.toolPath ||
      join(repoDir, '_Tools', 'golden-apply', 'golden-apply.mjs')

    if (!existsSync(toolPath)) {
      return {
        success: false,
        appliedItems: [],
        error: `契約実行ツールが見つかりません: ${toolPath}`,
      }
    }

    // ──────────────────────────────────────────────
    // Pre-flight 検証（一時作業ディレクトリ作成・Git操作より前に配置）
    // ──────────────────────────────────────────────
    const home = homedir()
    const pDir = options.parcFermeDir || join(home, '.ccpit')
    const mPath = options.manifestPath || getManifestPath(pDir)
    const tDir = options.targetDir || join(home, '.claude')

    let mExists = false
    let existingManifest: GoldenManifest | null = null
    try {
      mExists = existsSync(mPath)
      existingManifest = await readManifest(mPath)
    } catch (err) {
      return {
        success: false,
        appliedItems: [],
        error: `ローカル配置台帳の読み取り中に例外が発生しました: ${String(err)}。fail-closed により Golden への反映を中断します。`,
      }
    }

    if (!mExists) {
      // (1) 物理的不在: templateName が有効値でなければ新規作成不可として即時拒否
      const tName = options.templateName
      if (!tName || !(KNOWN_TEMPLATES as readonly string[]).includes(tName)) {
        return {
          success: false,
          appliedItems: [],
          error: `ローカル配置台帳が存在せず、実配布テンプレート名が未指定または未知の値です（指定: '${tName}'、許可: ${KNOWN_TEMPLATES.join('/')}）。fail-closed により Golden への反映を中断します。`,
        }
      }
    } else if (!existingManifest) {
      // (2) 物理的に存在するが readManifest が null（空・不正JSON・未対応バージョン破損）:
      // 有効な options.templateName が渡された場合でも既存破損ファイルの上書き・初期化を絶対に防止
      return {
        success: false,
        appliedItems: [],
        error: `既存のローカル配置台帳が空・破損・未対応バージョンです。上書き初期化を防止するため、fail-closed により Golden への反映を中断します。`,
      }
    } else {
      // (3) 正常な既存台帳が存在する場合: manifest.template の健全性を検証
      const currentTemplate = existingManifest.template
      if (!currentTemplate || !(KNOWN_TEMPLATES as readonly string[]).includes(currentTemplate)) {
        return {
          success: false,
          appliedItems: [],
          error: `既存のローカル配置台帳に記録されているテンプレート名が未設定または未知の値です（記録値: '${String(currentTemplate)}'、許可: ${KNOWN_TEMPLATES.join('/')}）。fail-closed により Golden への反映を中断します。`,
        }
      }
    }

    // Pre-flight 時点の台帳フィンガープリント（生バイト SHA-256）を記録
    let preflightManifestSha: string | null = null
    if (mExists) {
      try {
        preflightManifestSha = createHash('sha256').update(readFileSync(mPath)).digest('hex')
      } catch (err) {
        return {
          success: false,
          appliedItems: [],
          error: `Pre-flight 台帳ハッシュの計算中に例外が発生しました: ${String(err)}。fail-closed により中断します。`,
        }
      }
    }

    // テスト専用フック: Pre-flight 検証直後 (Zone 1 テスト用)
    if (options.__testPostPreflightHook) {
      await options.__testPostPreflightHook()
    }

    // 反映直前の基底コミット SHA（反映時の版）を取得 (Finding 4)
    // CCPIT_L0_010: 旧は HEAD が読めないと基準を 'initial' にして進み、以降の blob 読みが全て「無い」になって、
    // 他人の更新を巻き戻す反映を通した。読めなかったら止める（作業用ディレクトリを作る前なので、何も残らない）。
    // commit が 0 件（unborn）は、契約実行ツールが master を引けず必ず失敗する（golden-apply.mjs の rev-parse master）ので、専用の文面で止める
    const baseHead = resolveHead(repoDir)
    if (baseHead.state === 'unreadable') throw baseHead.error
    if (baseHead.state === 'unborn') {
      throw new Error('golden のリポジトリに commit がありません。反映の基準にできないので、最初の commit を作ってから、もう一度実行してください')
    }
    let baseCommitSha: string = baseHead.sha

    const stateFilePath = options.stateFilePath || STATE_FILE
    const now = new Date()
    const timestampIso = now.toISOString()
    const sessionNonce = randomBytes(4).toString('hex')

    // 作業用一時ディレクトリ（CCPIT の外・OS tmpdir 内）
    workDir = join(tmpdir(), `ccpit-promo-${sessionNonce}`)
    await mkdir(workDir, { recursive: true })
    await writeSessionOwnerMeta(workDir, repoDir, options.lane || 'gui-promotion')

    // ──────────────────────────────────────────────
    // 共通 Double-Check 再検証ヘルパー (Zone 1 終端)
    // ──────────────────────────────────────────────
    const assertManifestNotTampered = (): { ok: true } | { ok: false; error: string } => {
      try {
        const currentExists = existsSync(mPath)
        const currentSha = currentExists
          ? createHash('sha256').update(readFileSync(mPath)).digest('hex')
          : null
        if (currentSha !== preflightManifestSha) {
          return {
            ok: false,
            error: `Pre-flight 検証後にローカル台帳ファイルが変更、置換、または破損しました。部分成功を防止するため、承認記録の生成および Golden への反映（Git コミット）前に中断します。`,
          }
        }
        return { ok: true }
      } catch (err) {
        return {
          ok: false,
          error: `Double-Check 再検証中の台帳アクセスで例外が発生しました: ${String(err)}。fail-closed により中断します。`,
        }
      }
    }
    // ──────────────────────────────────────────────
    // 0. 救済アイテムに対する「段 3: いったん戻す」自動化 (F-2)
    // 救済対象で golden 側に既に実体ファイルが存在している場合、
    // 手動 revert を要求するのではなく、契約実行ツールを使って delete パッチを自動適用する
    // ──────────────────────────────────────────────
    // golden を git から読めなかった行（系譜・元の版・救済の内容のどれか）は、判定が確かでないので反映しない。
    // 段 3（golden の既存ファイルを削除する commit）より前に、画面の値（diffState）より先に、読めなかった理由で止める
    // （段 3 の後に止めると、削除だけが済んで追加されない。「競合遮断」などの誤った文面にもしない。source を問わない）
    for (const it of items) {
      if (it.gitReadError) {
        throw new Error(`golden を git から読めなかったため止めました: 「${it.skillName}」— ${it.diffSummary}`)
      }
    }

    const rescueItemsWithExistingFiles = items.filter((it) => {
      if (it.source !== 'rescue') return false
      const jaTargetRel = `ccpit/golden/common/ja/skills/${it.skillName}/SKILL.md`
      return existsSync(join(repoDir, jaTargetRel))
    })

    if (rescueItemsWithExistingFiles.length > 0) {
      const doubleCheckRescue = assertManifestNotTampered()
      if (!doubleCheckRescue.ok) {
        return { success: false, appliedItems: [], error: doubleCheckRescue.error }
      }
      if (options.__testPostDoubleCheckHook) {
        await options.__testPostDoubleCheckHook('rescue_stage3')
      }

      const deletePatches: Array<{
        target_path: string
        type: 'delete'
        base_sha256: string
        expected_sha256: string
        patch_file: string
        patch_sha256: string
      }> = []

      for (const item of rescueItemsWithExistingFiles) {
        const skillName = item.skillName
        const jaRel = `ccpit/golden/common/ja/skills/${skillName}/SKILL.md`
        const jaAbs = join(repoDir, jaRel)
        if (existsSync(jaAbs)) {
          const jaContent = await readUtf8Strict(jaAbs, `段3救済削除対象 ja skill (${skillName})`)
          const jaSha = sha256NormalizedString(jaContent)
          const delPatch = createDeleteUnifiedDiff(jaRel, jaContent)
          const stagedPatch = join(workDir, `del_stage3_ja_${skillName}.patch`)
          await writeFile(stagedPatch, Buffer.from(delPatch, 'utf-8'))
          deletePatches.push({
            target_path: jaRel,
            type: 'delete',
            base_sha256: jaSha,
            expected_sha256: 'NONE',
            patch_file: stagedPatch,
            patch_sha256: sha256String(delPatch),
          })
        }

        const enRel = `ccpit/golden/common/en/skills/${skillName}/SKILL.md`
        const enAbs = join(repoDir, enRel)
        if (existsSync(enAbs)) {
          const enContent = await readUtf8Strict(enAbs, `段3救済削除対象 en skill (${skillName})`)
          const enSha = sha256NormalizedString(enContent)
          const delPatch = createDeleteUnifiedDiff(enRel, enContent)
          const stagedPatch = join(workDir, `del_stage3_en_${skillName}.patch`)
          await writeFile(stagedPatch, Buffer.from(delPatch, 'utf-8'))
          deletePatches.push({
            target_path: enRel,
            type: 'delete',
            base_sha256: enSha,
            expected_sha256: 'NONE',
            patch_file: stagedPatch,
            patch_sha256: sha256String(delPatch),
          })
        }
      }

      if (deletePatches.length > 0) {
        const delManifestStr = JSON.stringify({ patches: deletePatches }, null, 2) + '\n'
        const delManifestPath = join(workDir, 'MANIFEST_DEL_STAGE3.json')
        await writeFile(delManifestPath, delManifestStr, 'utf-8')
        const delManifestSha = sha256String(delManifestStr)
        const delLionSha8 = delManifestSha.slice(0, 8)

        const reportDir =
          options.reviewReportDir || join(repoDir, '_Prompt', 'approval-records')
        await mkdir(reportDir, { recursive: true })
        const delReportPath = join(reportDir, `approval_stage3_${delLionSha8}.md`)
        const delReportMd = `# 救済承認記録: 段3 いったん戻す\n\n対象: ${rescueItemsWithExistingFiles
          .map((i) => i.skillName)
          .join(', ')}\nMANIFEST SHA-256: ${delManifestSha}\n`
        await writeFile(delReportPath, delReportMd, 'utf-8')

        const delRes = await runGoldenApplyHelper({
          repoDir,
          toolPath,
          manifestPath: delManifestPath,
          manifestSha256: delManifestSha,
          reviewReportPath: delReportPath,
          lionSha8: delLionSha8,
          lane: options.lane || 'gui-promotion-stage3',
          runsDir: options.runsDir,
          onProgress: options.onProgress,
        })

        if (delRes.code !== 0) {
          throw new Error(`救済の「段 3: いったん戻す」実行に失敗しました: ${delRes.stderr || delRes.stdout}`)
        }

        // 段 3 のコミット完了後、baseCommitSha を最新 HEAD に更新
        // 読めなかったら止める（旧は baseCommitSha が削除前の版のまま残り、以後の追加が「更新パッチ」になって、
        // 成功と報告しながら HEAD から skill が消えた）。段 3 の削除 commit は済んでいるので、その旨を文面に入れる
        const headAfterStage3 = resolveHead(repoDir)
        if (headAfterStage3.state !== 'present') {
          const why =
            headAfterStage3.state === 'unreadable'
              ? headAfterStage3.error.message
              : 'golden の HEAD が引けません（読めませんでした）'
          throw new Error(
            `救済の「段 3: いったん戻す」の削除は完了していますが、その後の golden の HEAD を読めませんでした。段 3 の削除は済んでいます。もう一度実行してください。${why}`
          )
        }
        baseCommitSha = headAfterStage3.sha
      }
    }

    // ──────────────────────────────────────────────
    // 1. golden 側の台帳の準備（golden-ledger.json）
    // ──────────────────────────────────────────────
    const ledgerRelPath = 'ccpit/golden/common/golden-ledger.json'
    const ledgerAbsPathInRepo = join(repoDir, ledgerRelPath)

    let existingLedger: GoldenLedgerEntry[] = []
    if (existsSync(ledgerAbsPathInRepo)) {
      const existingBuf = await readFile(ledgerAbsPathInRepo)
      const existingLedgerDecoded = decodeUtf8Strict(existingBuf, '既存 golden-ledger.json')
      try {
        existingLedger = JSON.parse(stripBomForJsonParse(existingLedgerDecoded))
        if (!Array.isArray(existingLedger)) existingLedger = []
      } catch {
        existingLedger = []
      }
    }

    // 新しい台帳エントリを構築
    const updatedLedger = [...existingLedger]

    // H-1 & Finding 1: 発効前の既存 golden スキルを contract-preexisting として台帳へ併合記録（maintainer手番ゼロ）
    const hasPreexistingEntries = updatedLedger.some((e) => e.action === 'contract-preexisting')
    if (!hasPreexistingEntries) {
      const commonJaSkillsDir = join(goldenRootDir, 'common', 'ja', 'skills')
      if (existsSync(commonJaSkillsDir)) {
        try {
          const preDirs = readdirSync(commonJaSkillsDir, { withFileTypes: true })
          for (const d of preDirs) {
            if (!d.isDirectory()) continue
            if (items.some((it) => it.skillName === d.name)) continue
            const skillMd = join(commonJaSkillsDir, d.name, 'SKILL.md')
            if (existsSync(skillMd)) {
              // 1 件の不正 UTF-8 が全件の台帳シードを黙って中断させないよう、個別に catch する
              // （Codex adversarial-review 指摘・high: 台帳の監査用ハッシュが非可逆変換で誤記録されうる）。
              try {
                const buf = readFileSync(skillMd)
                const hash = sha256NormalizedString(decodeUtf8Strict(buf, `既存 golden 事前入庫 skill (${d.name})`))
                updatedLedger.unshift({
                  name: d.name,
                  target: `common/ja/skills/${d.name}/SKILL.md`,
                  hash,
                  promotedAt: CONTRACT_EFFECTIVE_DATE_ISO,
                  source: 'normal',
                  goldenVersionAtPromotion: 'contract-preexisting',
                  action: 'contract-preexisting',
                  history: {
                    originalRecord: '契約制定前入庫 (契約 r20 追補条項 7-c)',
                    lane: 'preexisting',
                    originalDate: CONTRACT_EFFECTIVE_DATE_ISO.split('T')[0],
                  },
                })
              } catch {
                // この 1 件のみスキップ（他の preexisting skill のシードは継続する）
              }
            }
          }
        } catch {
          // ignore
        }
      }
    }

    // ──────────────────────────────────────────────
    // 2. パッチ・追加ファイルの配置と MANIFEST パッチ構築
    // ──────────────────────────────────────────────
    const patches: Array<{
      target_path: string
      type: 'add' | 'update'
      base_sha256: string
      expected_sha256: string
      patch_file: string
      patch_sha256: string
    }> = []
    const promotedManifestItems: Array<{
      skillName: string
      localPath?: string
      hash: string
      files?: Array<{ relPath: string; hash: ManifestHash; postHash?: string }>
      partial?: boolean
      staleClaims?: Array<{ relPath: string; hash: ManifestHash }>
    }> = []
    // 合成提案ごとの、反映後に golden 上で期待するファイルの指紋（合成台帳の適用記録に書く）
    const composeAppliedFiles = new Map<string, SnapshotFile[]>()
    // 提案の道が運んだファイル。golden への反映後に、この PC の写しを同じ版にそろえる
    const proposalCarried: Array<{
      manifestItem: (typeof promotedManifestItems)[number]
      skillName: string
      carried: CarriedFile[]
    }> = []

    // ──────────────────────────────────────────────
    // 3 つの道（ローカル・提案・救済）が共通で通る「1 ファイルを golden へ運ぶ」処理（069 発注 3）。
    // ja への patch・en への扱い（SKILL.md はスタブ／付随 .md は翻訳待ち／実行体は ja と同じバイト）・
    // 台帳へ載せる 2 種類の指紋を 1 か所で決める。
    // ──────────────────────────────────────────────
    const stagingDir: string = workDir
    const usedPatchNames = new Set<string>()
    const stagePatch = async (lang: 'ja' | 'en', skillName: string, relPath: string, patchContent: string): Promise<string> => {
      const sanitized = relPath.replace(/[^a-zA-Z0-9._-]/g, '_')
      let name = `${lang}_${skillName}_${sanitized}.patch`
      for (let n = 2; usedPatchNames.has(name); n++) name = `${lang}_${skillName}_${sanitized}.${n}.patch`
      usedPatchNames.add(name)
      const staged = join(stagingDir, name)
      await writeFile(staged, Buffer.from(patchContent, 'utf-8'))
      return staged
    }

    const carrySkillFile = async (p: {
      item: PromotionItem
      skillName: string
      relPath: string
      bytes: Buffer
      skillMdContent: string
      /** 提案が同じ相対パスを `en:` 見出しで持つとき true。en 側はその内容を carryEnFile が運ぶので、ここでは何も積まない */
      enProvided?: boolean
    }): Promise<CarriedFile> => {
      const { item: carryItem, skillName, relPath } = p
      const jaTargetRel = `ccpit/golden/common/ja/skills/${skillName}/${relPath}`
      const enTargetRel = `ccpit/golden/common/en/skills/${skillName}/${relPath}`
      // golden に入れるバイトは git の版と同じ LF にそろえる。契約の道具が測る値（生バイトのものもある）と一致する
      const newBytes = toGoldenBytes(jaTargetRel, p.bytes)
      const contractSha = computeGoldenTargetHash(jaTargetRel, newBytes) as ContractSha
      const manifestHash = hashFileBuffer(jaTargetRel, newBytes) as ManifestHash

      const oldBytes = getGoldenBlobContent(baseCommitSha, jaTargetRel, repoDir)
      const oldSha = oldBytes === null ? null : computeGoldenTargetHash(jaTargetRel, oldBytes)
      if (oldSha !== contractSha) {
        const patchContent = createGitBinaryPatch({ targetRelPath: jaTargetRel, oldBytes, newBytes })
        patches.push({
          target_path: jaTargetRel,
          type: oldBytes === null ? 'add' : 'update',
          base_sha256: oldSha === null ? 'NONE' : oldSha,
          expected_sha256: contractSha,
          patch_file: await stagePatch('ja', skillName, relPath, patchContent),
          patch_sha256: sha256String(patchContent),
        })
      }

      const oldEnBytes = getGoldenBlobContent(baseCommitSha, enTargetRel, repoDir)
      if (p.enProvided) {
        // en 側は提案の `en:` ファイルが正（スタブ・翻訳待ち・実行体の同期は足さない）
      } else if (relPath === 'SKILL.md') {
        // en に SKILL.md が無ければスタブ（翻訳は別の積み残し）
        if (oldEnBytes === null) {
          const enNewBytes = Buffer.from(generateEnStubSkillMd(skillName, p.skillMdContent), 'utf-8')
          const enPatchContent = createGitBinaryPatch({ targetRelPath: enTargetRel, oldBytes: null, newBytes: enNewBytes })
          patches.push({
            target_path: enTargetRel,
            type: 'add',
            base_sha256: 'NONE',
            expected_sha256: computeGoldenTargetHash(enTargetRel, enNewBytes),
            patch_file: await stagePatch('en', skillName, relPath, enPatchContent),
            patch_sha256: sha256String(enPatchContent),
          })
        }
      } else if (relPath.endsWith('.md')) {
        // 裁定 2: en 側の新規付随 Markdown は翻訳待ちで配置保留
        const skipped = (carryItem.skippedFiles ??= [])
        if (!skipped.some((s) => s.relPath === relPath && s.reason === 'pending-translation')) {
          // size は入力として検出したファイルの大きさ（従来どおり。LF にそろえた後のバイト数ではない）
          skipped.push({ relPath, reason: 'pending-translation', size: p.bytes.length })
        }
      } else {
        // 実行体（.cjs, .js, .json, .sh 等）: ja と完全バイト同一で同期
        const oldEnSha = oldEnBytes === null ? null : computeGoldenTargetHash(enTargetRel, oldEnBytes)
        if (oldEnSha !== contractSha) {
          const enPatchContent = createGitBinaryPatch({ targetRelPath: enTargetRel, oldBytes: oldEnBytes, newBytes })
          patches.push({
            target_path: enTargetRel,
            type: oldEnBytes === null ? 'add' : 'update',
            base_sha256: oldEnSha === null ? 'NONE' : oldEnSha,
            expected_sha256: contractSha,
            patch_file: await stagePatch('en', skillName, relPath, enPatchContent),
            patch_sha256: sha256String(enPatchContent),
          })
        }
      }
      const oldHash = oldBytes === null ? null : (hashFileBuffer(jaTargetRel, oldBytes) as ManifestHash)
      return { relPath, contractSha, manifestHash, newBytes, oldHash }
    }

    // 提案の `en:` 見出しのファイルを、golden の en 側へ運ぶ（en への patch だけ。ja・台帳の files・配置の記録・
    // 手元の写しには載せない。en の golden は手元の ~/.claude に対応する場所が無く、台帳も ja の行で持つため）
    const carryEnFile = async (p: { skillName: string; relPath: string; bytes: Buffer }): Promise<void> => {
      const { skillName, relPath } = p
      const enTargetRel = `ccpit/golden/common/en/skills/${skillName}/${relPath}`
      const newBytes = toGoldenBytes(enTargetRel, p.bytes)
      const expectedSha = computeGoldenTargetHash(enTargetRel, newBytes) as ContractSha
      const oldEnBytes = getGoldenBlobContent(baseCommitSha, enTargetRel, repoDir)
      const oldEnSha = oldEnBytes === null ? null : computeGoldenTargetHash(enTargetRel, oldEnBytes)
      if (oldEnSha === expectedSha) return
      const enPatchContent = createGitBinaryPatch({ targetRelPath: enTargetRel, oldBytes: oldEnBytes, newBytes })
      patches.push({
        target_path: enTargetRel,
        type: oldEnBytes === null ? 'add' : 'update',
        base_sha256: oldEnSha === null ? 'NONE' : oldEnSha,
        expected_sha256: expectedSha,
        patch_file: await stagePatch('en', skillName, relPath, enPatchContent),
        patch_sha256: sha256String(enPatchContent),
      })
    }

    // 提案 MD を読み直して検証する（TOCTOU・承認ゲート・§3 のファイル構文）。golden へ運ぶ提案と、golden と同一の提案の両方が使う
    const readProposalForApply = async (
      item: PromotionItem
    ): Promise<{ currentContent: string; propFilesRes: ReturnType<typeof parseProposedFilesFromSection3>; skillMd: string }> => {
      if (!item.proposalFilePath || !existsSync(item.proposalFilePath)) {
        throw new Error(`提案 MD ファイルが見つかりません: ${item.proposalFilePath}`)
      }
      const currentContent = readFileSync(item.proposalFilePath, 'utf-8')
      const currentHash = sha256NormalizedString(currentContent)
      if (item.proposalHash && currentHash !== item.proposalHash) {
        throw new Error(`提案内容が変更されています（TOCTOU 検証失敗）: ${item.proposalRequestId}`)
      }
      const storePaths = options.proposalStorePaths || getDefaultProposalStorePaths()
      const gateRes = await evaluateAdoptGateFromRaw(currentContent, item.proposalFilePath, false, storePaths)
      if (gateRes.blocked) {
        throw new Error(
          `提案の承認ゲート再検証失敗（外部レビューストア照合）: ${gateRes.reason || 'blocked'} (requestId: ${item.proposalRequestId})`
        )
      }
      const propFilesRes = parseProposedFilesFromSection3(currentContent, item.proposalFilePath)
      if (propFilesRes.error) {
        throw new Error(`提案のファイル構文検証エラー: ${propFilesRes.error}`)
      }
      const skillMdFile = propFilesRes.files.find((f) => f.lang !== 'en' && f.relPath === 'SKILL.md')
      const skillMd = skillMdFile ? skillMdFile.content : item.capturedContent || ''
      if (!skillMd) {
        throw new Error(`提案「${item.proposalRequestId}」の完成版コード（SKILL.md）を抽出できませんでした。`)
      }
      return { currentContent, propFilesRes, skillMd }
    }
    // 同じスキルの提案が 1 回の反映に 2 行以上あれば止める。golden と同一（identical）の提案は競合に数えない
    // （scanProposalCandidates）ので、上げられる提案と同時に渡されると、写しの同期が同じ写しのパスへ別々の内容を書き、
    // 後に処理された方が残る。画面ではチェックできない組み合わせだが、反映の入口が画面の値を当てにしない守りとして閉じる
    const proposalRowsBySkill = new Map<string, number>()
    for (const it of items) {
      if (it.source === 'proposal') proposalRowsBySkill.set(it.skillName, (proposalRowsBySkill.get(it.skillName) ?? 0) + 1)
    }
    for (const [skill, n] of proposalRowsBySkill) {
      if (n > 1) {
        throw new Error(
          `競合遮断: 「${skill}」の提案が 1 回の反映に ${n} 件含まれているため適用できません。1 回に反映できる提案は、同じスキルにつき 1 件です。`
        )
      }
    }
    for (const item of items) {
      // golden と同一内容（identical）のアイテムは空差分エラーを避けるためスキップ（ただし救済は段3でdeleteされるためaddパッチが必要）
      if (item.source !== 'rescue' && item.diffState === 'identical') {
        // 提案が golden と同一でも、この PC の写しが古いまま・記録と食い違ったまま残らないよう、写しの同期の対象にする
        // （golden へは何も入れない。golden に既にあり、提案と中身が同じファイルだけを対象にする）
        if (item.source === 'proposal') {
          // 再検証（TOCTOU・承認ゲート・§3 構文）は golden へ運ぶ提案と同じ。通らなければ、ここで全体を止める（golden へは何も入れていない）
          const { propFilesRes } = await readProposalForApply(item)
          const sameCarried: CarriedFile[] = []
          for (const pf of propFilesRes.files) {
            if (pf.lang === 'en') continue // en 側のファイルは手元の写し・配置の記録の対象外
            const relPath = pf.relPath.replace(/\\/g, '/')
            const jaRel = `ccpit/golden/common/ja/skills/${item.skillName}/${relPath}`
            const blob = getGoldenBlobContent(baseCommitSha, jaRel, repoDir)
            if (blob === null) continue
            const newBytes = toGoldenBytes(jaRel, Buffer.from(pf.content, 'utf-8'))
            if (computeGoldenTargetHash(jaRel, newBytes) !== computeGoldenTargetHash(jaRel, blob)) continue
            const manifestHash = hashFileBuffer(jaRel, newBytes) as ManifestHash
            sameCarried.push({
              relPath,
              contractSha: computeGoldenTargetHash(jaRel, newBytes) as ContractSha,
              manifestHash,
              newBytes,
              oldHash: manifestHash
            })
          }
          if (sameCarried.length > 0) {
            const manifestItem: (typeof promotedManifestItems)[number] = {
              skillName: item.skillName,
              localPath: item.localPath,
              hash: sameCarried.find((c) => c.relPath === 'SKILL.md')?.contractSha ?? sameCarried[0].contractSha,
              files: sameCarried.map((c) => ({ relPath: c.relPath, hash: c.manifestHash }))
            }
            promotedManifestItems.push(manifestItem)
            proposalCarried.push({ manifestItem, skillName: item.skillName, carried: sameCarried })
          }
        }
        continue
      }
      // stale-local や diverged, proposal-conflict のアイテムは適用不可（フェイルクローズ）
      if (item.diffState === 'stale-local') {
        throw new Error(`巻き戻し防止: 「${item.skillName}」は golden 先行状態のため適用できません。`)
      }
      if (item.diffState === 'diverged') {
        throw new Error(`競合遮断: 「${item.skillName}」は双方変更（diverged）のため適用できません。goldenMergeConsult を利用してください。`)
      }
      if (item.diffState === 'proposal-conflict') {
        throw new Error(`競合遮断: 「${item.skillName}」は同じスキルに上げられる提案が複数あるため適用できません。「Skill 候補ブラウザ」で不要な提案を却下し、1 件だけにしてください。`)
      }
      // 合成提案が握っている提案（置き換えられた元提案・選ばなかった提案）は、個別には上げない（合成提案を上げる）。
      // 画面の値だけに頼らず、台帳と提案の状態から毎回導き直す（改訂済みの旧エントリは見ない・applied_pending_states は握り続ける）
      if (item.source === 'proposal' && item.proposalRequestId) {
        const stores = options.proposalStorePaths || getDefaultProposalStorePaths()
        // 画面から渡る候補の skillName は信用しない（差し替えられても握りを見落とさない）。request_id だけで引く
        const hold = lookupHoldAnySkill(
          deriveComposeHolds(
            readMergeLedger(getComposePaths(dirname(stores.statesPath)).mergesPath).entries,
            await readProposalStates(stores)
          ),
          item.proposalRequestId
        )
        if (hold) {
          throw new Error(
            hold.role === 'source'
              ? `合成遮断: 提案「${item.proposalRequestId}」は合成提案「${hold.compositeId}」に置き換えられています。個別には昇格できません。合成提案を昇格するか、合成提案を却下して元に戻してください。`
              : `合成遮断: 提案「${item.proposalRequestId}」は合成提案「${hold.compositeId}」の昇格を待っています（合成の元に選ばれなかった提案）。個別には昇格できません。合成提案を昇格するか、合成提案を却下（MD が無いときは「合成を破棄」）して元に戻してください。`
          )
        }
      }

      const skillName = item.skillName
      let jaContent = ''
      const skillFileRecords: GoldenLedgerFileRecord[] = []

      if (item.source === 'proposal') {
        // ──────────────────────────────────────────────
        // CC 提案昇格アイテム（W2 / MAJOR 3 TOCTOU 再検証）
        // ──────────────────────────────────────────────
        const proposalRead = await readProposalForApply(item)
        const { currentContent, propFilesRes } = proposalRead
        jaContent = proposalRead.skillMd

        // 元の版の照合（069 M4）: 画面から来た diffState に頼らず、ここで読み直した提案の base_hash と base_master の
        // golden の SKILL.md を比べる。違えば golden 側の変更を巻き戻すので止める（提案が今の golden と同じなら通す）
        const baseCheck = evaluateProposalBase({
          repoDir,
          baseRef: baseCommitSha,
          skillName,
          baseHash: readFrontmatterValue(currentContent, 'base_hash'),
          proposedSkillMd: jaContent,
          proposedCompanions: propFilesRes.files.filter((f) => f.lang !== 'en' && f.relPath !== 'SKILL.md'),
          companionBaseHashes: readFrontmatterValue(currentContent, 'companion_base_hashes'),
          proposedEnFiles: propFilesRes.files.filter((f) => f.lang === 'en')
        })
        if (!baseCheck.ok) {
          throw new Error(`元の版の照合で止めました: 「${skillName}」— ${baseCheck.diffSummary}`)
        }

        // 合成提案の昇格前の再照合（契約ツールを起動する前）。登録後に不変の写し（compose-registry）だけを読み、
        // 対象 skill の golden の全ファイル（提案が触れないものを含む）を測り直す。合成の宣言（supersedes・compose_snapshot）を
        // 持つ提案が合成台帳に無ければ、そもそも昇格しない
        const composeSup = readFrontmatterValue(currentContent, 'supersedes')
        const composeSnap = readFrontmatterValue(currentContent, 'compose_snapshot')
        if (composeSup || composeSnap) {
          const stores = options.proposalStorePaths || getDefaultProposalStorePaths()
          const statesNow = await readProposalStates(stores)
          const pf = composePreflight({
            paths: getComposePaths(dirname(stores.statesPath)),
            compositeId: item.proposalRequestId ?? '',
            proposalSha256: sha256NormalizedString(currentContent),
            composeSnapshot: composeSnap,
            readGolden: (lang, skill, rel) =>
              getGoldenBlobContent(baseCommitSha, `ccpit/golden/common/${lang}/skills/${skill}/${rel}`, repoDir),
            readState: (id) => statesNow[id]
          })
          if (!pf.ok) {
            throw new Error(`合成提案の昇格前検査で止めました: 「${skillName}」— ${pf.error}`)
          }
          composeAppliedFiles.set(
            item.proposalRequestId ?? '',
            propFilesRes.files.map((f) => {
              const rel = f.relPath.replace(/\\/g, '/')
              return {
                lang: f.lang === 'en' ? ('en' as const) : ('ja' as const),
                relPath: rel,
                sha256: composeContentHash(rel, toGoldenBytes(rel, Buffer.from(f.content, 'utf-8')))
              }
            })
          )
        }

        // `en:` 見出しを持つ相対パス（ja 側の同じパスは、スタブ・翻訳待ち・実行体の同期を足さない）
        const enPaths = new Set(
          propFilesRes.files.filter((f) => f.lang === 'en').map((f) => f.relPath.replace(/\\/g, '/'))
        )
        // SKILL.md と付随ファイル群（Section 3 由来）を、ローカル道・救済道と同じ 1 つの関数で運ぶ
        const carried: CarriedFile[] = [
          await carrySkillFile({
            item,
            skillName,
            relPath: 'SKILL.md',
            bytes: Buffer.from(jaContent, 'utf-8'),
            skillMdContent: jaContent,
            enProvided: enPaths.has('SKILL.md'),
          }),
        ]
        for (const pf of propFilesRes.files) {
          if (pf.lang === 'en' || pf.relPath === 'SKILL.md') continue
          const jaRelPath = pf.relPath.replace(/\\/g, '/')
          carried.push(
            await carrySkillFile({
              item,
              skillName,
              relPath: jaRelPath,
              bytes: Buffer.from(pf.content, 'utf-8'),
              skillMdContent: jaContent,
              enProvided: enPaths.has(jaRelPath),
            })
          )
        }
        // en 側のファイル（`en:` 見出し）は、golden の en へ patch だけを積む
        for (const pf of propFilesRes.files) {
          if (pf.lang !== 'en') continue
          await carryEnFile({
            skillName,
            relPath: pf.relPath.replace(/\\/g, '/'),
            bytes: Buffer.from(pf.content, 'utf-8'),
          })
        }
        for (const c of carried) {
          skillFileRecords.push({ path: c.relPath, hash: c.contractSha, status: 'present' })
        }
        const jaSha = carried[0].contractSha

        // 台帳への登録
        updatedLedger.push({
          name: skillName,
          target: `common/ja/skills/${skillName}/SKILL.md`,
          hash: jaSha,
          promotedAt: timestampIso,
          source: item.source,
          goldenVersionAtPromotion: baseCommitSha,
          files: skillFileRecords,
          history: {
            originalRecord: item.description,
            lane: item.lane,
            originalDate: item.addedAt,
          },
        })

        const manifestItem: (typeof promotedManifestItems)[number] = {
          skillName,
          localPath: item.localPath,
          hash: jaSha,
          files: carried.map((c) => ({ relPath: c.relPath, hash: c.manifestHash })),
        }
        promotedManifestItems.push(manifestItem)
        proposalCarried.push({ manifestItem, skillName, carried })
      } else if (item.source === 'rescue') {
        // ──────────────────────────────────────────────
        // 契約 r19 §3-5 救済フロー（段 1〜5）
        // ──────────────────────────────────────────────
        if (item.capturedContent) {
          jaContent = item.capturedContent
        } else if (item.commitSha) {
          // 読めなかった（git の失敗）ときは、ローカルの内容へ落とさず止める（旧は失敗＝内容なし＝ローカルの別内容を golden へ書いた）。
          // commit にその path が確かに無い／0 バイトのときだけ、従来どおりローカルの内容へ落ちる
          const rescueBlob = readGoldenBlobOrThrow(repoDir, item.commitSha, item.targetPath, {
            maxBuffer: MAX_COMPANION_FILE_SIZE_BYTES,
            noRepoIsAbsent: true
          })
          if (rescueBlob !== null && rescueBlob.length > 0) {
            jaContent = decodeUtf8Strict(rescueBlob, `救済捕獲コミット (${item.commitSha}) の内容`)
          }
        }
        if (!jaContent) {
          const localSkillMd = join(item.localPath, 'SKILL.md')
          if (existsSync(localSkillMd)) {
            jaContent = await readUtf8Strict(localSkillMd, `救済対象ローカルファイル (${skillName})`)
          }
        }
        if (!jaContent) {
          throw new Error(`救済対象「${skillName}」の内容を捕獲できませんでした。`)
        }

        // 救済は golden への裏口コミットの SKILL.md だけを記録し直す（付随ファイルは運ばない・設計どおり）
        const carried = await carrySkillFile({
          item,
          skillName,
          relPath: 'SKILL.md',
          bytes: Buffer.from(jaContent, 'utf-8'),
          skillMdContent: jaContent,
        })
        skillFileRecords.push({ path: 'SKILL.md', hash: carried.contractSha, status: 'present' })

        updatedLedger.push({
          name: skillName,
          target: `common/ja/skills/${skillName}/SKILL.md`,
          hash: carried.contractSha,
          promotedAt: timestampIso,
          source: item.source,
          goldenVersionAtPromotion: baseCommitSha,
          files: skillFileRecords,
          history: {
            originalRecord: item.description,
            lane: item.lane,
            originalDate: item.addedAt,
          },
        })

        promotedManifestItems.push({
          skillName,
          localPath: item.localPath,
          hash: carried.contractSha,
          files: [{ relPath: 'SKILL.md', hash: carried.manifestHash }],
        })
      } else {
        // ──────────────────────────────────────────────
        // 正規昇格アイテム（W1: 付随ファイル一式運搬）
        // ──────────────────────────────────────────────
        const localSkillPath = item.localPath
        if (!existsSync(localSkillPath)) {
          throw new Error(`ローカルスキルディレクトリが見つかりません: ${localSkillPath}`)
        }

        const scanResult = scanLocalSkillFiles(localSkillPath)
        if (scanResult.files.length === 0) {
          throw new Error(`ローカルスキルに有効なファイルが見つかりません: ${localSkillPath}`)
        }

        // SKILL.md 本文の厳格特定と UTF-8 検証 (Codex CRITICAL 1 指摘反映: 付随 .md による上書きを防止)
        const skillMdFile = scanResult.files.find((f) => f.relPath === 'SKILL.md')
        if (!skillMdFile) {
          throw new Error(`ローカルスキルに SKILL.md が見つかりません: ${localSkillPath}`)
        }
        const skillMdBytes = readFileSync(skillMdFile.absPath)
        const jaSkillMdContent = decodeUtf8Strict(skillMdBytes, `ローカル SKILL.md (${skillName})`)

        const carried: CarriedFile[] = []
        for (const file of scanResult.files) {
          const newBytes = readFileSync(file.absPath)

          if (file.relPath.endsWith('.md')) {
            // 付随 Markdown も含む全 .md ファイルの UTF-8 厳格性を検証 (W-7 回帰防止)
            decodeUtf8Strict(newBytes, `ローカル skill ファイル (${skillName}/${file.relPath})`)
          }

          carried.push(
            await carrySkillFile({
              item,
              skillName,
              relPath: file.relPath,
              bytes: newBytes,
              skillMdContent: jaSkillMdContent,
            })
          )
        }
        for (const c of carried) {
          skillFileRecords.push({ path: c.relPath, hash: c.contractSha, status: 'present' })
        }
        const jaSkillMdSha = carried.find((c) => c.relPath === 'SKILL.md')!.contractSha

        // 台帳への登録 (CRITICAL 2: files 配列を記録)
        updatedLedger.push({
          name: skillName,
          target: `common/ja/skills/${skillName}/SKILL.md`,
          hash: jaSkillMdSha,
          promotedAt: timestampIso,
          source: item.source,
          goldenVersionAtPromotion: baseCommitSha,
          files: skillFileRecords,
          history: {
            originalRecord: item.description,
            lane: item.lane,
            originalDate: item.addedAt,
          },
        })

        promotedManifestItems.push({
          skillName,
          localPath: item.localPath,
          hash: jaSkillMdSha,
          files: carried.map((c) => ({ relPath: c.relPath, hash: c.manifestHash })),
        })
      }
    }

    // (c) 更新後の台帳ファイルのパッチ生成 (baseCommitSha blob 基準)
    const ledgerStr = JSON.stringify(updatedLedger, null, 2) + '\n'
    const newLedgerBytes = Buffer.from(ledgerStr, 'utf-8')
    const ledgerNewSha = computeGoldenTargetHash(ledgerRelPath, newLedgerBytes)
    const oldLedgerBytes = getGoldenBlobContent(baseCommitSha, ledgerRelPath, repoDir)

    const ledgerPatchContent = createGitBinaryPatch({
      targetRelPath: ledgerRelPath,
      oldBytes: oldLedgerBytes,
      newBytes: newLedgerBytes,
    })

    const stagedLedgerPatch = join(workDir, 'golden-ledger.patch')
    await writeFile(stagedLedgerPatch, Buffer.from(ledgerPatchContent, 'utf-8'))

    patches.push({
      target_path: ledgerRelPath,
      type: oldLedgerBytes === null ? 'add' : 'update',
      base_sha256: oldLedgerBytes === null ? 'NONE' : computeGoldenTargetHash(ledgerRelPath, oldLedgerBytes),
      expected_sha256: ledgerNewSha,
      patch_file: stagedLedgerPatch,
      patch_sha256: sha256String(ledgerPatchContent),
    })

    // スキルの変更が 0 件（すべて同一内容等）かつ段 3 削除もない場合は安全にスキップ
    const skillPatches = patches.filter((p) => p.target_path !== ledgerRelPath)

    // 提案から上げたスキル（および golden と同一の提案）の、この PC の写しを golden と同じ版にそろえる（069 発注 5 / M20・FB 1）。
    // 配置の記録には、写しが実物と一致した行（書いた・既に同じ）だけを載せる。書かなかった・失敗したファイルの行は
    // 作らない（新しい版の指紋を写しに関係なく書くと、起動時の照合が古い写しを unchanged に隠す）。
    const runLocalCopyStage = async (): Promise<LocalCopyReportEntry[] | undefined> => {
      if (proposalCarried.length === 0) return undefined
      const report: LocalCopyReportEntry[] = []
      const language = options.language ?? (await readConfiguredLanguage())
      // 配置の記録が「前回この PC に配った」と示す指紋（goldenHash・postHash）。golden の履歴の過去の版と一致しても、
      // 記録がその版を配ったと示していなければ、利用者が自分で戻した・偶然一致したものかもしれないので書かない
      const trustedPlaced = trustedDeployedHashes(existingManifest?.entries ?? [])
      const postHashByPath = new Map<string, string>()
      for (const e of existingManifest?.entries ?? []) {
        if (e.postHash) postHashByPath.set(normalizeRelPath(e.path), e.postHash)
      }
      const placedHashesOf = (path: string): string[] => {
        const key = normalizeRelPath(path)
        return [trustedPlaced.get(key), postHashByPath.get(key)].filter((h): h is string => typeof h === 'string')
      }
      for (const pc of proposalCarried) {
        const synced = await syncLocalCopiesForProposal({
          skillName: pc.skillName,
          carried: pc.carried,
          targetDir: tDir,
          stagingDir,
          language,
          pastHashesOf: (relPath) => {
            const placed = placedHashesOf(`skills/${pc.skillName}/${relPath}`)
            return collectGoldenHistoryHashes(
              repoDir,
              baseCommitSha,
              `ccpit/golden/common/ja/skills/${pc.skillName}/${relPath}`
            ).filter((h) => placed.includes(h))
          },
          beforeWriteHook: options.__testBeforeLocalCopyWriteHook,
        })
        report.push(...synced.report)
        pc.manifestItem.files = pc.carried
          .filter((c) => synced.rows.has(c.relPath))
          .map((c) => {
            const postHash = synced.rows.get(c.relPath)?.postHash
            return { relPath: c.relPath, hash: c.manifestHash, ...(postHash ? { postHash } : {}) }
          })
        pc.manifestItem.partial = true
        // 写しをそろえられなかったファイルの記録の行が新しい版を指していれば、実物と食い違う偽の行（過去の不具合が作ったもの）。
        // 残すと起動時の照合が unchanged に隠すので消す（消すと「記録なし」で、写しが違えば確認の対象になる）
        pc.manifestItem.staleClaims = pc.carried
          .filter((c) => synced.unplaced.has(c.relPath))
          .map((c) => ({ relPath: c.relPath, hash: c.manifestHash }))
      }
      for (let i = promotedManifestItems.length - 1; i >= 0; i--) {
        const mi = promotedManifestItems[i]
        if (mi.files?.length === 0 && !(mi.staleClaims && mi.staleClaims.length > 0)) promotedManifestItems.splice(i, 1)
      }
      return report
    }
    const localCopyLogLines = (report: LocalCopyReportEntry[]): string =>
      report
        .map((e) => {
          const detail = e.backupPath ? `（控え: ${e.backupPath}）` : e.reason ? `（${e.reason}）` : ''
          return `[LOCAL-COPY] ${e.outcome} skills/${e.skillName}/${e.relPath}${detail}`
        })
        .join('\n')

    // ローカル配置台帳（golden-manifest.json）への同期（W-2 / Zone 2 保護）。失敗の文言を返す（成功は undefined）
    const runManifestSync = async (): Promise<string | undefined> => {
      if (promotedManifestItems.length === 0) return undefined
      // goldenRels の解決（未指定なら repoDir から自動収集）
      let resolvedGoldenRels = options.goldenRels
      if (!resolvedGoldenRels && existsSync(repoDir)) {
        try {
          resolvedGoldenRels = collectGoldenRels(repoDir)
        } catch {
          // ignore
        }
      }
      try {
        await syncPromotedToLocalManifest({
          manifestPath: mPath,
          targetDir: tDir,
          items: promotedManifestItems,
          deployedAt: timestampIso,
          goldenRels: resolvedGoldenRels,
          templateName: options.templateName,
          lockToken: manifestLockToken,
          expectedManifestSha: preflightManifestSha,
          __testPreWriteManifestHook: options.__testPreWriteManifestHook,
          __testPreRenameHook: options.__testPreRenameHook,
        })
        return undefined
      } catch (manifestErr) {
        console.error('ローカル配置台帳の更新に失敗しました:', manifestErr)
        return manifestErr instanceof Error ? manifestErr.message : String(manifestErr)
      }
    }

    if (skillPatches.length === 0 && rescueItemsWithExistingFiles.length === 0) {
      if (proposalCarried.length === 0) {
        return {
          success: true,
          appliedItems: [],
          runnerLog: '選択された全アイテムが Golden と同一内容のため、変更パッチは生成されませんでした（承認不要）。',
        }
      }
      // 提案が今の golden と同一: golden へは何も入れず、この PC の写しと記録だけをそろえる
      // （golden と同じ版のはずの写しが古いまま、記録と食い違って隠れる状態を残さない）。
      // 契約ツールの基底照合が無い経路なので、写しを書く直前に、配置の記録と golden の HEAD が読み込み時から動いていないことを確かめる
      const onlyDoubleCheck = assertManifestNotTampered()
      if (!onlyDoubleCheck.ok) {
        return { success: false, appliedItems: [], error: onlyDoubleCheck.error }
      }
      if (options.__testPostDoubleCheckHook) {
        await options.__testPostDoubleCheckHook('normal_step4')
      }
      const headNow = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' })
      if (headNow.status !== 0 || headNow.stdout.trim() !== baseCommitSha) {
        return {
          success: false,
          appliedItems: [],
          error: 'golden が読み込み時から更新されたため、この PC の写しには触れずに中断しました。もう一度操作してください。',
        }
      }
      const onlyReport = await runLocalCopyStage()
      const onlySyncError = await runManifestSync()
      const onlyLog = `選択された全アイテムが Golden と同一内容のため、Golden への反映（commit）は行いません。この PC の写しだけをそろえました。\n${localCopyLogLines(onlyReport ?? [])}`
      return {
        success: !onlySyncError,
        appliedItems: [],
        ...(onlySyncError
          ? { error: `ローカル台帳（golden-manifest.json）の更新に失敗しました: ${onlySyncError}。次回の起動時照合で台帳が自動修復されます。` }
          : {}),
        runnerLog: onlySyncError ? `${onlyLog}\n[MANIFEST-SYNC-ERROR] ${onlySyncError}` : onlyLog,
        ...(onlyReport ? { localCopyReport: onlyReport } : {}),
      }
    }

    // ──────────────────────────────────────────────
    // 共通 Double-Check 再検証 & Zone 2 フック (通常 Step 4 直前)
    // ──────────────────────────────────────────────
    const doubleCheckNormal = assertManifestNotTampered()
    if (!doubleCheckNormal.ok) {
      return { success: false, appliedItems: [], error: doubleCheckNormal.error }
    }
    if (options.__testPostDoubleCheckHook) {
      await options.__testPostDoubleCheckHook('normal_step4')
    }

    // ──────────────────────────────────────────────
    // 3. MANIFEST ファイルの書き出しとハッシュ計算
    // ──────────────────────────────────────────────
    const manifestJson = { patches }
    const manifestStr = JSON.stringify(manifestJson, null, 2) + '\n'
    const manifestPath = join(workDir, 'MANIFEST.json')
    await writeFile(manifestPath, manifestStr, 'utf-8')

    const manifestSha256 = sha256String(manifestStr)
    const lionSha8 = manifestSha256.slice(0, 8)

    // ──────────────────────────────────────────────
    // 4. GUI 承認記録の作成（契約 7-b 準拠）
    // ──────────────────────────────────────────────
    const approvalRecordMd = generateApprovalRecordMd({
      timestamp: timestampIso,
      approvedBy: 'maintainer',
      manifestSha256,
      lionSha8,
      items,
    })

    const reportDir =
      options.reviewReportDir ||
      join(repoDir, '_Prompt', 'approval-records')
    await mkdir(reportDir, { recursive: true })

    const approvalRecordPath = join(
      reportDir,
      `approval_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
        now.getDate()
      ).padStart(2, '0')}_${lionSha8}.md`
    )
    await writeFile(approvalRecordPath, approvalRecordMd, 'utf-8')

    // ──────────────────────────────────────────────
    // 4.9 適用前の保存（Plan r10 §8・T10）: 提案から上げる skill ごとに、動かす対象の写しと sha256 一覧を
    // `<ccpit>/compose/<request_id>/pre-apply/` へ保存する。保存に失敗したら、契約ツールを起動せず（golden へ何も入れず）に止める
    // ──────────────────────────────────────────────
    const preApplyDirs: Array<{ requestId: string; dir: string }> = []
    for (const item of items) {
      if (item.source !== 'proposal' || !item.proposalRequestId) continue
      const storesForPre = options.proposalStorePaths || getDefaultProposalStorePaths()
      const ccpitDirForPre = dirname(storesForPre.statesPath)
      const preDir = preApplyDirOf(ccpitDirForPre, item.proposalRequestId)
      const skill = item.skillName
      const targets: PreApplyTarget[] = []
      for (const lang of ['ja', 'en'] as const) {
        const skillRel = `ccpit/golden/common/${lang}/skills/${skill}`
        for (const abs of listFilesRecursive(join(repoDir, skillRel))) {
          targets.push({ kind: 'golden', path: abs, rel: normalizeRelPath(relative(repoDir, abs)) })
        }
        for (const p of patches) {
          if (p.target_path.startsWith(`${skillRel}/`)) {
            targets.push({ kind: 'golden', path: join(repoDir, p.target_path), rel: p.target_path })
          }
        }
      }
      targets.push({ kind: 'golden', path: join(repoDir, ledgerRelPath), rel: ledgerRelPath })
      for (const abs of listFilesRecursive(join(tDir, 'skills', skill))) {
        targets.push({ kind: 'local', path: abs })
      }
      for (const pc of proposalCarried) {
        if (pc.skillName !== skill) continue
        for (const c of pc.carried) targets.push({ kind: 'local', path: join(tDir, 'skills', skill, c.relPath) })
      }
      const mergesPathForPre = getComposePaths(ccpitDirForPre).mergesPath
      targets.push(
        { kind: 'record', path: storesForPre.statesPath },
        { kind: 'record', path: storesForPre.reviewsPath },
        { kind: 'record', path: mergesPathForPre },
        { kind: 'record', path: stateFilePath },
        { kind: 'record', path: mPath }
      )
      if (item.proposalFilePath) targets.push({ kind: 'record', path: item.proposalFilePath })
      const mergeEntry = readMergeLedger(mergesPathForPre).entries[item.proposalRequestId]
      if (mergeEntry) for (const s of mergeEntry.sources) targets.push({ kind: 'record', path: s.filePath })
      try {
        savePreApply(preDir, { requestId: item.proposalRequestId, skillName: skill, baseCommit: baseCommitSha }, targets)
      } catch (preErr) {
        const m = preErr instanceof Error ? preErr.message : String(preErr)
        throw new Error(
          `適用前の保存に失敗したため、適用を始めませんでした（golden へは何も入れていません）: 「${item.proposalRequestId}」— ${m}`
        )
      }
      preApplyDirs.push({ requestId: item.proposalRequestId, dir: preDir })
    }
    // 適用直後の記録（post.json）。契約ツールの成功後、最後の戻り値の前に呼ぶ。失敗の文言を返す（成功は undefined）
    const recordPostApplyAll = (commit?: string): string | undefined => {
      const errs: string[] = []
      for (const d of preApplyDirs) {
        try {
          recordPostApply(d.dir, commit)
        } catch (e) {
          errs.push(`${d.requestId}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      return errs.length > 0 ? errs.join(' / ') : undefined
    }

    // ──────────────────────────────────────────────
    // 5. 契約実行ツールの呼び出し
    // ──────────────────────────────────────────────
    const execResult = await runGoldenApplyHelper({
      repoDir,
      toolPath,
      manifestPath,
      manifestSha256,
      reviewReportPath: approvalRecordPath,
      lionSha8,
      lane: options.lane || 'gui-promotion',
      runsDir: options.runsDir,
      onProgress: options.onProgress,
    })

    let runnerLog = `${execResult.stdout}\n${execResult.stderr}`

    if (execResult.code !== 0) {
      return {
        success: false,
        appliedItems: [],
        error: `契約実行ツールの適用が拒否されました (exit code: ${execResult.code}):\n${execResult.stderr || execResult.stdout}`,
        runnerLog,
      }
    }

    // コミット SHA の抽出
    const commitMatch = execResult.stdout.match(/コミット SHA:\s*([0-9a-fA-F]{40})/)
    const commitSha = commitMatch ? commitMatch[1] : undefined

    // ──────────────────────────────────────────────
    // 6. 状態オブジェクトの構築
    // ──────────────────────────────────────────────
    const promoState = loadPromotionState(stateFilePath)
    const appliedIds: string[] = []

    for (const item of items) {
      let relPath = `skills/${item.skillName}/SKILL.md`
      if (item.localPath) {
        const computed = normalizeRelPath(relative(tDir, join(item.localPath, 'SKILL.md')))
        if (computed !== '' && !computed.startsWith('../') && computed !== '..') {
          relPath = computed
        }
      }
      const itemHash =
        promotedManifestItems.find((p) => p.skillName === item.skillName)?.hash

      promoState.items[item.id] = {
        state: 'applied_unpushed',
        viewed: true,
        promotedAt: timestampIso,
        commitSha,
        capturedContent: item.capturedContent,
        targetRel: relPath,
        hash: itemHash,
      }
      appliedIds.push(item.id)
    }

    // ──────────────────────────────────────────────
    // 状態永続化の試行（原子的書込み & 失敗時即時 return: Codex Round 22 & Round 23 指摘反映）
    // ──────────────────────────────────────────────
    try {
      savePromotionState(promoState, stateFilePath)
    } catch (err) {
      // 状態保存失敗時: 台帳同期は一切呼び出さず、ローカル台帳生バイト完全不変のまま直ちに return（回復不能部分成功）
      const stateSaveError = err instanceof Error ? err.message : String(err)
      recordPostApplyAll(commitSha)
      return {
        success: false,
        commitSha,
        manifestSha256,
        appliedItems: [], // 永続化失敗のため空配列
        error: `Golden へのコミット（${commitSha}）は成功しましたが、昇格状態ファイル（golden-promotion-state.json）の保存に失敗しました: ${stateSaveError}。昇格状態が記録されていないため、次回起動時の自動修復は行われません。手動でのコミット確認（git log ${commitSha}）および台帳の手動同期、または再試行が必要です。`,
        runnerLog: `${runnerLog}\n[STATE-SAVE-ERROR] ${stateSaveError}`,
      }
    }

    // ──────────────────────────────────────────────
    // 5.4. 提案から上げたスキルの、この PC の写しを golden と同じ版にそろえる（069 発注 5 / M20）
    // ──────────────────────────────────────────────
    const localCopyReport = await runLocalCopyStage()
    if (localCopyReport) runnerLog = `${runnerLog}\n${localCopyLogLines(localCopyReport)}`

    // ──────────────────────────────────────────────
    // 5.5. ローカル配置台帳（golden-manifest.json）への同期（W-2 / Zone 2 保護: 状態保存成功後のみ実行）
    // ──────────────────────────────────────────────
    const manifestSyncError = await runManifestSync()

    // 台帳同期にエラーがあった場合は、反映状態を記録した上でエラーを返却（次回起動照合で治癒可能）
    if (manifestSyncError) {
      recordPostApplyAll(commitSha)
      return {
        success: false,
        commitSha,
        manifestSha256,
        appliedItems: appliedIds,
        error: `Golden への反映（コミット: ${commitSha}）は成功しましたが、ローカル台帳（golden-manifest.json）の更新に失敗しました: ${manifestSyncError}。昇格状態（applied_unpushed）は記録されたため、次回の起動時照合で台帳が自動修復されます。`,
        runnerLog: `${runnerLog}\n[MANIFEST-SYNC-ERROR] ${manifestSyncError}`,
        ...(localCopyReport ? { localCopyReport } : {}),
      }
    }

    // ──────────────────────────────────────────────
    // 5.6. 提案アイテムの adopted 状態遷移（E-3: 状態保存成功後のみ実行）
    // ──────────────────────────────────────────────
    let proposalAdoptError: string | undefined
    for (const item of items) {
      if (item.source === 'proposal' && item.proposalRequestId) {
        try {
          const storePaths = options.proposalStorePaths || getDefaultProposalStorePaths()
          // 合成提案: 適用記録に書く commit。契約ツールの出力に commit SHA が無いときだけ HEAD を読む（通常は出力の値を使う）。
          // 読めなかったら、空の commit を台帳に `applied` で記録しない（旧は '' を記録した）。状態（adopted）を変える前に読んで止める
          const appliedFiles = composeAppliedFiles.get(item.proposalRequestId)
          let composeCommit = ''
          if (appliedFiles) {
            if (commitSha) {
              composeCommit = commitSha
            } else {
              const headForCompose = resolveHead(repoDir)
              if (headForCompose.state !== 'present') {
                throw new Error(
                  headForCompose.state === 'unreadable'
                    ? headForCompose.error.message
                    : 'golden の HEAD が引けません（読めませんでした）'
                )
              }
              composeCommit = headForCompose.sha
            }
          }
          await setProposalState(item.proposalRequestId, 'adopted', storePaths)
          // 合成提案: 適用記録を台帳へ書き、元提案も adopted にする（途中で止まっても追い付き更新が golden の実測で続きを行う）
          if (appliedFiles) {
            const post = await composePostPromotion(
              {
                paths: getComposePaths(dirname(storePaths.statesPath)),
                setState: (id, st) => setProposalState(id, st, storePaths)
              },
              {
                compositeId: item.proposalRequestId,
                commit: composeCommit,
                files: appliedFiles
              }
            )
            if (!post.ok) throw new Error(post.error ?? '合成提案の後処理に失敗しました')
          }
        } catch (adoptErr) {
          const msg = adoptErr instanceof Error ? adoptErr.message : String(adoptErr)
          proposalAdoptError = `golden 反映（コミット: ${commitSha}）と昇格状態の記録は成功しましたが、提案「${item.proposalRequestId}」の adopted 遷移に失敗しました: ${msg}。提案ストアを確認すること`
          console.error(`[PROPOSAL-ADOPT-ERROR] ${proposalAdoptError}`)
          break
        }
      }
    }

    // 適用直後の記録（戻しの復元前確認の基準）。失敗しても golden への反映は済んでいるので、戻しが使えない旨を記録に残す
    const postRecordError = recordPostApplyAll(commitSha)
    if (postRecordError) runnerLog = `${runnerLog}\n[POST-APPLY-RECORD-ERROR] ${postRecordError}（この提案は戻しの対象にできません）`

    if (proposalAdoptError) {
      return {
        success: false,
        commitSha,
        manifestSha256,
        appliedItems: appliedIds,
        error: proposalAdoptError,
        runnerLog: `${runnerLog}\n[PROPOSAL-ADOPT-ERROR] ${proposalAdoptError}`,
        ...(localCopyReport ? { localCopyReport } : {}),
      }
    }

    return {
      success: true,
      commitSha,
      manifestSha256,
      appliedItems: appliedIds,
      runnerLog,
      ...(localCopyReport ? { localCopyReport } : {}),
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      appliedItems: [],
      error: errMsg,
      runnerLog: errMsg,
    }
  } finally {
    isPromotionApplying = false
    if (manifestLockToken) {
      releaseManifestLock(manifestLockToken)
    }
    // 一時ディレクトリの清掃
    if (workDir && existsSync(workDir)) {
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }
}

export interface ContractCliLedgerDrift {
  /**
   * 履歴（git log・diff-tree）を読めず、ずれの検出が完了しなかった理由（CCPIT_L0_010）。健全時は欄ごと無い。
   * あるときは `hasDrift: false`・`unrecordedCommits: []`（部分結果を返さない）だが、「ずれ無し」ではない
   */
  gitScanError?: string
  hasDrift: boolean
  unrecordedCommits: Array<{
    sha: string
    shortSha: string
    appliedBy: string
    subject: string
    skillsAffected: string[]
  }>
  ledgerStatus: 'ok' | 'not-found' | 'corrupt'
  ledgerError?: string
}

/**
 * git log から Applied-by: を持つ契約 CLI コミットを走査し、台帳に未記録のコミットを検出（CRITICAL 2 / MAJOR 7 準拠）。
 */
export function detectContractCliLedgerDrift(
  optionsOrRepoDir: string | { repoDir?: string; ledgerPath?: string; gitDir?: string } = findRepoRootDir()
): ContractCliLedgerDrift {
  let repoDir: string
  let ledgerPath: string
  if (typeof optionsOrRepoDir === 'string') {
    repoDir = optionsOrRepoDir
    ledgerPath = join(repoDir, 'ccpit', 'golden', 'common', 'golden-ledger.json')
  } else {
    repoDir = optionsOrRepoDir.repoDir || optionsOrRepoDir.gitDir || findRepoRootDir()
    ledgerPath = optionsOrRepoDir.ledgerPath || join(repoDir, 'ccpit', 'golden', 'common', 'golden-ledger.json')
  }

  const recordedCommitShas = new Set<string>()
  const readRes = readGoldenLedgerValidated(ledgerPath)

  if (readRes.status === 'corrupt') {
    return {
      hasDrift: false,
      unrecordedCommits: [],
      ledgerStatus: 'corrupt',
      ledgerError: readRes.error
    }
  }

  const ledgerStatus = readRes.status === 'not-found' ? 'not-found' : 'ok'
  for (const entry of readRes.ledger) {
    if (entry.sourceCommitSha) {
      recordedCommitShas.add(entry.sourceCommitSha.toLowerCase())
    }
    if (entry.catchupCommits && Array.isArray(entry.catchupCommits)) {
      for (const c of entry.catchupCommits) {
        recordedCommitShas.add(c.toLowerCase())
      }
    }
  }

  // 履歴を読めなかったときは、「ずれ無し」に見えないよう gitScanError を返す（旧は失敗＝ずれ無しで、検出が黙って消えた）。
  // 契約コミットが 0 件（正当な空）は終了 0 の空出力で、従来どおりずれ無し
  const logRead = readGoldenText(
    repoDir,
    ['log', '--grep=Applied-by:', '--format=%H%x00%s%x00%b%x00', '-n', String(CONTRACT_CLI_SCAN_DEPTH)],
    { op: 'log', ref: HEAD_REF, emptyIfNoBase: true }
  )
  if (logRead.state === 'unreadable') {
    return {
      hasDrift: false,
      unrecordedCommits: [],
      ledgerStatus,
      gitScanError: logRead.error.message
    }
  }

  if (!logRead.stdout.trim()) {
    return { hasDrift: false, unrecordedCommits: [], ledgerStatus }
  }

  const unrecordedCommits: ContractCliLedgerDrift['unrecordedCommits'] = []
  const chunks = logRead.stdout.split('\x00\n').filter(Boolean)

  for (const chunk of chunks) {
    const parts = chunk.split('\x00')
    if (parts.length < 3) continue
    const sha = parts[0].trim()
    const subject = parts[1].trim()
    const body = parts[2].trim()

    if (recordedCommitShas.has(sha.toLowerCase())) {
      continue
    }

    const appliedByMatch = body.match(/Applied-by:\s*([^\r\n]+)/i)
    const appliedBy = appliedByMatch ? appliedByMatch[1].trim() : 'unknown'

    // 差分を読めなかったら、部分結果を返さない（読めた分だけの一覧を「ずれはこれだけ」に見せない）。旧は例外で呼び出し側を落とした
    // -z: 非 ASCII 名の skill を 8 進エスケープの別名にしない（旧は読めたのに名前が化けて、未記録の commit が 0 件に見えた。CCPIT_L0_014 P7）
    const diffRead = readGoldenText(repoDir, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', sha], {
      op: 'diff',
      ref: sha
    })
    if (diffRead.state === 'unreadable') {
      return {
        hasDrift: false,
        unrecordedCommits: [],
        ledgerStatus,
        gitScanError: diffRead.error.message
      }
    }
    // パスは trim しない（-z は正確なパスを返す。名前の末尾の全角空白などを削ると別のパスになる）
    const changedFiles = diffRead.stdout.split('\0').filter(Boolean)

    // 画面操作コミット（昇格・撤去・復帰・追補）は台帳自身 (golden-ledger.json) を変更しているため除外
    if (changedFiles.some((f) => f.replace(/\\/g, '/') === 'ccpit/golden/common/golden-ledger.json')) {
      continue
    }

    const affectedSkills = new Set<string>()
    for (const f of changedFiles) {
      const normalized = f.replace(/\\/g, '/')
      const m = normalized.match(/ccpit\/golden\/common\/ja\/skills\/([^/]+)/)
      if (m) {
        affectedSkills.add(m[1])
      }
    }

    // golden 配下の ja/skills に影響がないコミットはスキップ
    if (affectedSkills.size === 0) {
      continue
    }

    unrecordedCommits.push({
      sha,
      shortSha: sha.slice(0, 8),
      appliedBy,
      subject,
      skillsAffected: Array.from(affectedSkills),
    })
  }

  return {
    hasDrift: unrecordedCommits.length > 0,
    unrecordedCommits,
    ledgerStatus,
  }
}

/**
 * 指定された SHA が有効な 40 桁 16 進数かつローカルリポジトリ内に実在するコミットか判定。
 * 確かに無い（40 桁でない・オブジェクトが無い・commit でない）ときは false。git が読めなかったときは `GoldenGitReadError` を投げる
 * （旧は `cat-file -e <sha>^{commit}` の終了コード 0 だけを見て、「無い」と「読めない」が同じ false だった。しかも `^{commit}` 付きは
 * 存在しない sha でも 128 を返し、両者を終了コードで見分けられない。`cat-file -e <sha>`（1＝無い）＋ `cat-file -t` に変えた。CCPIT_L0_010）
 */
export function isValidGitCommit(sha: string, cwd: string): boolean {
  if (!/^[0-9a-f]{40}$/i.test(sha)) return false
  return isCommitObjectOrThrow(cwd, sha)
}

/**
 * git merge-base --is-ancestor を実行し、ancestorSha が descendantSha の先祖（または同一）か判定
 */
export function isCommitAncestor(ancestorSha: string, descendantSha: string, cwd: string): boolean {
  if (ancestorSha.toLowerCase() === descendantSha.toLowerCase()) return true
  const res = spawnSync('git', ['merge-base', '--is-ancestor', ancestorSha, descendantSha], {
    cwd,
    encoding: 'utf-8',
  })
  if (res.status === 0) return true
  if (res.status === 1) return false
  return false
}

/**
 * 同一スキル名を持つ台帳エントリ群から代表先端エントリのインデックスを決定論的に特定 (Z-3 (2))
 * 1. Date.parse(entry.promotedAt) の UTC epoch ミリ秒が最新のエントリを優先
 * 2. 同一ミリ秒の場合は不変識別子 (${entry.promotedAt}_${entry.name}_${entry.hash}) の辞書順比較
 */
export function findRepresentativeLedgerEntryIndex(ledger: GoldenLedgerEntry[], skillName: string): number {
  let bestIdx = -1
  let bestTime = -Infinity
  let bestTieBreaker = ''

  for (let i = 0; i < ledger.length; i++) {
    const e = ledger[i]
    if (e.name !== skillName) continue
    const t = Date.parse(e.promotedAt) || 0
    const tie = `${e.promotedAt}_${e.name}_${e.hash}`
    if (t > bestTime || (t === bestTime && tie > bestTieBreaker)) {
      bestTime = t
      bestTieBreaker = tie
      bestIdx = i
    }
  }
  return bestIdx
}

/**
 * 指定コミットにおける当該スキルの全ファイル構成とハッシュを取得
 */
export function getSkillFilesFromCommit(
  sha: string,
  skillName: string,
  repoDir: string
): { skillMdHash: string; fileRecords: GoldenLedgerFileRecord[] } {
  const goldenTargetDir = `ccpit/golden/common/ja/skills/${skillName}`
  // 読めなかったら投げる（旧は ls-tree の失敗＝構成が空のまま台帳に書かれた。blob の失敗も同じで、構成から欠けた行が書かれた）。
  // 台帳追補は、投げられたら追補ごと止まる
  // -z: 非 ASCII 名の付随ファイル・skill を、台帳の構成から欠かさず、化けた名前で記録しない（CCPIT_L0_014 P7）
  const lsOut = readGoldenTextOrThrow(repoDir, ['ls-tree', '-r', '-z', sha, '--', goldenTargetDir], {
    op: 'tree',
    ref: sha,
    relPath: goldenTargetDir,
    emptyIfNoBase: true
  })
  const fileRecords: GoldenLedgerFileRecord[] = []
  let skillMdHash = ''

  if (lsOut.trim()) {
    for (const line of lsOut.split('\0')) {
      const tabIdx = line.indexOf('\t')
      if (tabIdx === -1) continue
      const fullRel = line.slice(tabIdx + 1)
      const skillSubRel = fullRel.startsWith(goldenTargetDir + '/')
        ? fullRel.slice(goldenTargetDir.length + 1)
        : basename(fullRel)
      const blob = getGoldenBlobContent(sha, fullRel, repoDir)
      if (!blob) continue
      const hash = computeGoldenTargetHash(fullRel, blob)
      if (skillSubRel === 'SKILL.md') skillMdHash = hash
      fileRecords.push({ path: skillSubRel, hash, status: 'present' })
    }
  }
  return { skillMdHash, fileRecords }
}

/**
 * 2つのスキルファイル群が完全一致しているか照合
 */
export function areSkillFileRecordsEqual(
  recordsA: GoldenLedgerFileRecord[],
  recordsB: GoldenLedgerFileRecord[],
  mdHashA: string,
  mdHashB: string
): boolean {
  if (mdHashA !== mdHashB) return false
  if (recordsA.length !== recordsB.length) return false
  const mapB = new Map(recordsB.map((r) => [r.path, r.hash]))
  for (const rA of recordsA) {
    if (mapB.get(rA.path) !== rA.hash) return false
  }
  return true
}

/**
 * 未記録契約コミットの台帳更新パッチ MANIFEST を機械生成（ADR 0002 準拠: golden-apply 経由適用）。
 */
/**
 * 台帳の追い付けで書き換えるスキル（対象 commit の ja/skills の変更から）。何も書かない。
 * applyLedgerCatchup が作業場・MANIFEST を作る前に、確認ダイアログに出した集合と照合するのに使う（CCPIT_L0_004 W4）
 */
export function ledgerCatchupAffectedSkills(repoDir: string, unrecordedSha: string): string[] {
  // -z: 非 ASCII 名の skill を 8 進エスケープの別名にしない（CCPIT_L0_014 P7）。git の失敗を [] に畳む挙動はそのまま
  // （後ろの 2 つの照合 5814・5836 が止める。P5＝直さない）
  const diffRes = spawnSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', unrecordedSha], {
    cwd: repoDir,
    encoding: 'utf-8',
  })
  const changedFiles = diffRes.status === 0 ? diffRes.stdout.split('\0').filter(Boolean) : []
  const affected = new Set<string>()
  for (const f of changedFiles) {
    const m = f.match(/ccpit\/golden\/common\/ja\/skills\/([^/]+)/)
    if (m) affected.add(m[1])
  }
  return [...affected]
}

export async function generateLedgerCatchupManifest(params: {
  repoDir?: string
  unrecordedSha: string
  lane?: string
  lionSha8?: string
  initialLedger?: GoldenLedgerEntry[]
}): Promise<{
  manifestPath: string
  manifestSha256: string
  patchFile: string
  updatedLedger: GoldenLedgerEntry[]
  /** manifest を置いた作業場。使い終わったら呼び出し元が消す */
  workDir: string
  /** この追い付けで台帳を書き換えるスキル（対象 commit の ja/skills の変更から） */
  affectedSkills: string[]
}> {
  const repoDir = params.repoDir || findRepoRootDir()
  const unrecordedSha = params.unrecordedSha

  const ledgerRelPath = 'ccpit/golden/common/golden-ledger.json'
  const ledgerAbsPath = join(repoDir, ledgerRelPath)

  let existingLedger: GoldenLedgerEntry[] = []
  if (params.initialLedger) {
    existingLedger = [...params.initialLedger]
  } else if (existsSync(ledgerAbsPath)) {
    const raw = readFileSync(ledgerAbsPath, 'utf-8')
    existingLedger = JSON.parse(stripBomForJsonParse(raw))
  }

  // base_master のコミット SHA を取得
  const revRes = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' })
  const baseMasterSha = revRes.stdout.trim()

  // 対象コミットで変更されたスキルを特定
  const affectedSkills = new Set<string>(ledgerCatchupAffectedSkills(repoDir, unrecordedSha))

  const updatedLedger = [...existingLedger]
  const nowIso = new Date().toISOString()

  type CatchupAction =
    | { type: 'case1_ancestor'; targetIdx: number; skillName: string }
    | {
        type: 'case2_descendant'
        targetIdx: number
        skillName: string
        skillMdHash: string
        fileRecords: GoldenLedgerFileRecord[]
      }
    | {
        type: 'case3_new'
        skillName: string
        skillMdHash: string
        fileRecords: GoldenLedgerFileRecord[]
      }

  const plannedActions: CatchupAction[] = []

  // Phase 1: 全スキルに対する一括検証（All-or-Nothing 原子性）
  for (const skillName of affectedSkills) {
    const unrecordedTree = getSkillFilesFromCommit(unrecordedSha, skillName, repoDir)

    const targetIdx = findRepresentativeLedgerEntryIndex(updatedLedger, skillName)
    if (targetIdx === -1) {
      // Case 3: 新規登録
      // HEAD 因果関係検証: unrecordedSha が現在の golden HEAD の正当な先祖（または同一）であることを検証
      if (!isCommitAncestor(unrecordedSha, baseMasterSha, repoDir)) {
        throw new Error(
          `新規スキル ${skillName} のコミット ${unrecordedSha} は現在の golden HEAD に至る正当な先祖コミットではありません。台帳追補を中断します。`
        )
      }
      plannedActions.push({
        type: 'case3_new',
        skillName,
        skillMdHash: unrecordedTree.skillMdHash,
        fileRecords: unrecordedTree.fileRecords,
      })
    } else {
      const repEntry = updatedLedger[targetIdx]
      const recordedCommits = new Set<string>()
      if (repEntry.sourceCommitSha && /^[0-9a-f]{40}$/i.test(repEntry.sourceCommitSha)) {
        recordedCommits.add(repEntry.sourceCommitSha.toLowerCase())
      } else if (repEntry.goldenVersionAtPromotion && /^[0-9a-f]{40}$/i.test(repEntry.goldenVersionAtPromotion)) {
        // 画面昇格・撤去・復帰エントリ（sourceCommitSha 不在）の場合、直前 HEAD である goldenVersionAtPromotion をアンカーとする
        recordedCommits.add(repEntry.goldenVersionAtPromotion.toLowerCase())
      }
      if (repEntry.catchupCommits && Array.isArray(repEntry.catchupCommits)) {
        for (const c of repEntry.catchupCommits) {
          recordedCommits.add(c.toLowerCase())
        }
      }

      // 代表エントリに有効なコミットアンカーがない場合（例: goldenVersionAtPromotion が非SHA過去データ、または直近撤去行）、
      // 同一スキルの過去エントリを新しい順に遡り、有効なコミットアンカーを補完して古いコミットによる不当な巻き戻しを阻止する
      if (recordedCommits.size === 0) {
        for (let i = targetIdx - 1; i >= 0; i--) {
          const prevEntry = updatedLedger[i]
          if (prevEntry.name === skillName) {
            if (prevEntry.sourceCommitSha && /^[0-9a-f]{40}$/i.test(prevEntry.sourceCommitSha)) {
              recordedCommits.add(prevEntry.sourceCommitSha.toLowerCase())
              break
            } else if (prevEntry.goldenVersionAtPromotion && /^[0-9a-f]{40}$/i.test(prevEntry.goldenVersionAtPromotion)) {
              recordedCommits.add(prevEntry.goldenVersionAtPromotion.toLowerCase())
              break
            }
          }
        }
      }

      // 実リポジトリ内に実在するコミットのみをトポロジー検証対象にする（モックや履歴欠損への耐性）
      const validCommits = Array.from(recordedCommits).filter((sha) => isValidGitCommit(sha, repoDir))

      if (validCommits.length === 0) {
        // コミット履歴のない古いレコード（またはテスト用モックレコード）
        if (!isCommitAncestor(unrecordedSha, baseMasterSha, repoDir)) {
          throw new Error(
            `スキル ${skillName} のコミット ${unrecordedSha} は現在の golden HEAD に至る正当な先祖コミットではありません。台帳追補を中断します。`
          )
        }
        plannedActions.push({
          type: 'case2_descendant',
          targetIdx,
          skillName,
          skillMdHash: unrecordedTree.skillMdHash,
          fileRecords: unrecordedTree.fileRecords,
        })
      } else {
        let isAncestorOfAll = true
        let isDescendantOfAll = true

        for (const k of validCommits) {
          const isAnc = isCommitAncestor(unrecordedSha, k, repoDir)
          const isDesc = isCommitAncestor(k, unrecordedSha, repoDir)
          if (!isAnc) isAncestorOfAll = false
          if (!isDesc) isDescendantOfAll = false
        }

        if (isAncestorOfAll) {
          // Case 1: C は全記録コミットの先祖（古いコミット）
          // HEAD 因果関係検証: unrecordedSha が現在の golden HEAD の正当な先祖であることを検証
          if (!isCommitAncestor(unrecordedSha, baseMasterSha, repoDir)) {
            throw new Error(
              `スキル ${skillName} のコミット ${unrecordedSha} は現在の golden HEAD に至る正当な先祖コミットではありません。台帳追補を中断します。`
            )
          }
          plannedActions.push({
            type: 'case1_ancestor',
            targetIdx,
            skillName,
          })
        } else if (isDescendantOfAll) {
          // Case 2: C は全記録コミットの子孫（新しい先端）
          // HEAD 因果関係検証: unrecordedSha が現在の golden HEAD の正当な先祖（または同一）であることを検証
          if (!isCommitAncestor(unrecordedSha, baseMasterSha, repoDir)) {
            throw new Error(
              `スキル ${skillName} のコミット ${unrecordedSha} は現在の golden HEAD に至る正当な先祖コミットではありません。台帳追補を中断します。`
            )
          }
          plannedActions.push({
            type: 'case2_descendant',
            targetIdx,
            skillName,
            skillMdHash: unrecordedTree.skillMdHash,
            fileRecords: unrecordedTree.fileRecords,
          })
        } else {
          // Case 4: 非祖先関係（分岐 sibling commit または履歴欠損）
          throw new Error(
            `コミット ${unrecordedSha} とスキル ${skillName} の既存台帳記録コミットとの間に祖先関係が成立しません（分岐または履歴欠損）。台帳追補を中断します。`
          )
        }
      }
    }
  }

  // Phase 2: 全件合格後の適用
  for (const act of plannedActions) {
    if (act.type === 'case1_ancestor') {
      const repEntry = updatedLedger[act.targetIdx]
      const catchup = new Set(repEntry.catchupCommits || [])
      if (repEntry.sourceCommitSha) catchup.add(repEntry.sourceCommitSha)
      catchup.add(unrecordedSha)
      repEntry.catchupCommits = Array.from(catchup)
    } else if (act.type === 'case2_descendant') {
      const repEntry = updatedLedger[act.targetIdx]
      const catchup = new Set(repEntry.catchupCommits || [])
      if (repEntry.sourceCommitSha) catchup.add(repEntry.sourceCommitSha)
      catchup.add(unrecordedSha)
      repEntry.catchupCommits = Array.from(catchup)
      repEntry.sourceCommitSha = unrecordedSha
      repEntry.hash = act.skillMdHash
      repEntry.files = act.fileRecords
      repEntry.action = 'contract-applied'
      repEntry.promotedAt = nowIso
      repEntry.goldenVersionAtPromotion = baseMasterSha
    } else if (act.type === 'case3_new') {
      const newEntry: GoldenLedgerEntry = {
        name: act.skillName,
        target: `common/ja/skills/${act.skillName}/SKILL.md`,
        hash: act.skillMdHash,
        promotedAt: nowIso,
        source: 'normal',
        goldenVersionAtPromotion: baseMasterSha,
        action: 'contract-applied',
        sourceCommitSha: unrecordedSha,
        catchupCommits: [unrecordedSha],
        files: act.fileRecords,
        history: {
          originalRecord: `契約 CLI コミット (${unrecordedSha.slice(0, 8)}) 追補同期`,
          lane: 'contract-cli',
          originalDate: nowIso.split('T')[0],
        },
      }
      updatedLedger.push(newEntry)
    }
  }

  const ledgerStr = JSON.stringify(updatedLedger, null, 2) + '\n'
  const newLedgerBytes = Buffer.from(ledgerStr, 'utf-8')
  const ledgerNewSha = computeGoldenTargetHash(ledgerRelPath, newLedgerBytes)
  const oldLedgerBytes = getGoldenBlobContent(baseMasterSha, ledgerRelPath, repoDir)

  const ledgerPatchContent = createGitBinaryPatch({
    targetRelPath: ledgerRelPath,
    oldBytes: oldLedgerBytes,
    newBytes: newLedgerBytes,
  })

  // 作業場（CCPIT_L0_004 W1）: 持ち主の記録（session-owner.json）を書き、清掃が持ち主を確かめて消せるようにする。
  // 消すのは呼び出し元（applyLedgerCatchup の finally）。ここで失敗したときは、ここで消す
  const workDir = join(tmpdir(), `ccpit_catchup_${randomBytes(8).toString('hex')}`)
  mkdirSync(workDir, { recursive: true })
  try {
    await writeSessionOwnerMeta(workDir, repoDir, params.lane || 'gui-ledger-catchup')
    const patchFile = join(workDir, 'ledger-catchup.patch')
    writeFileSync(patchFile, ledgerPatchContent, 'utf-8')

    const manifestEntries = [
      {
        target_path: ledgerRelPath,
        type: oldLedgerBytes === null ? ('add' as const) : ('update' as const),
        base_sha256: oldLedgerBytes === null ? 'NONE' : computeGoldenTargetHash(ledgerRelPath, oldLedgerBytes),
        expected_sha256: ledgerNewSha,
        patch_file: patchFile,
        patch_sha256: sha256String(ledgerPatchContent),
      },
    ]

    const manifestJson = { patches: manifestEntries }
    const manifestPath = join(workDir, 'MANIFEST.json')
    const manifestStr = JSON.stringify(manifestJson, null, 2) + '\n'
    writeFileSync(manifestPath, manifestStr, 'utf-8')
    const manifestSha256 = sha256String(manifestStr)

    return {
      manifestPath,
      manifestSha256,
      patchFile,
      updatedLedger,
      workDir,
      affectedSkills: Array.from(affectedSkills),
    }
  } catch (err) {
    rmSync(workDir, { recursive: true, force: true })
    throw err
  }
}

export interface LedgerCatchupApprovalContext {
  approvedBy: string // 例: 'maintainer（CCPIT GUI 承認モーダル）'
  approvedAt: string // ISO8601
  confirmationHash: string // ダイアログ表示内容の SHA-256 ハッシュ（64桁小文字または大文字hex）
}

/**
 * 未記録契約コミットの台帳更新パッチを機械生成し、golden-apply 経由で適用（ADR 0002 準拠 / C-3 人間承認証跡 / C-4 SHA検証・drift再照合）。
 */
export async function applyLedgerCatchup(
  unrecordedSha: string,
  options: string | PromotionApplyOptions = {},
  approvalContext?: LedgerCatchupApprovalContext
): Promise<{ success: boolean; commitSha?: string; error?: string; reason?: 'confirmation-mismatch' }> {
  const opts: PromotionApplyOptions = typeof options === 'string' ? { repoDir: options } : options || {}

  // 1. 40 桁 hex 検証 (C-4: 厳格な形式チェック)
  if (typeof unrecordedSha !== 'string' || !/^[0-9a-fA-F]{40}$/.test(unrecordedSha.trim())) {
    return { success: false, error: `無効なコミット SHA 形式です: ${unrecordedSha}` }
  }
  const cleanSha = unrecordedSha.trim()

  // 2. 人間承認コンテキストの厳格検証 (C-3: ADR 0002 準拠・既定値捏造の完全排除)
  if (!approvalContext) {
    return { success: false, error: '台帳追補には GUI での承認証跡 (approvalContext) が必須です (ADR 0002 準拠)' }
  }
  if (typeof approvalContext.approvedBy !== 'string' || !approvalContext.approvedBy.trim()) {
    return { success: false, error: '承認者 (approvedBy) が指定されていないか空文字です' }
  }
  if (typeof approvalContext.approvedAt !== 'string' || isNaN(Date.parse(approvalContext.approvedAt))) {
    return { success: false, error: `承認日時 (approvedAt) が有効な ISO8601 形式ではありません: ${approvalContext.approvedAt}` }
  }
  if (
    typeof approvalContext.confirmationHash !== 'string' ||
    !/^[0-9a-fA-F]{64}$/.test(approvalContext.confirmationHash.trim())
  ) {
    return {
      success: false,
      error: `承認確認ハッシュ (confirmationHash) が有効な SHA-256 (64桁hex) ではありません: ${approvalContext.confirmationHash}`
    }
  }

  const cleanApprovedBy = approvalContext.approvedBy.trim()
  const cleanApprovedAt = approvalContext.approvedAt.trim()
  const cleanConfirmationHash = approvalContext.confirmationHash.trim()

  // 排他（CCPIT_L0_004 W2・範囲外の発見 1）: 昇格・撤去・復帰・戻しと同じ旗と manifest のロック。
  // 旗を立てた後の処理は、すべて try の中に置き、失敗しても finally で旗・ロック・作業場を戻す
  if (isPromotionApplying) return { success: false, error: '別の処理が実行中です。' }
  const lockResult = acquireManifestLock('goldenPromotion:applyLedgerCatchup')
  if (!lockResult.ok) return { success: false, error: lockResult.error }
  isPromotionApplying = true
  let catchupWorkDir: string | null = null

  try {
    const repoDir = opts.repoDir || findRepoRootDir()
    const goldenRootDir = findGoldenRootDir(repoDir)
    const ledgerPath = join(goldenRootDir, 'common', 'golden-ledger.json')
    const ledgerCheck = readGoldenLedgerValidated(ledgerPath)
    if (ledgerCheck.status === 'corrupt') {
      throw new Error(`台帳破損エラー: golden-ledger.json が壊れているため追補を拒否しました (${ledgerCheck.error})`)
    }

    // 3. drift 検知結果との再照合 (C-4 fail-closed: 未記録と報告された SHA のみ許可)
    const drift = detectContractCliLedgerDrift(repoDir)
    // 履歴を読めなかったときは、「検出されていません」という誤った理由にせず、読めなかった理由で拒否する（何も書かない）
    if (drift.gitScanError !== undefined) {
      return {
        success: false,
        error: `契約 CLI 未記録コミットの再検出で履歴を読めませんでした。golden は書き換えていません。${drift.gitScanError}`
      }
    }
    const matchedCommit = drift.unrecordedCommits.find(
      (c) => c.sha.toLowerCase() === cleanSha.toLowerCase()
    )
    if (!matchedCommit) {
      return {
        success: false,
        error: `指定されたコミット ${cleanSha} は契約 CLI 未記録コミットとして検出されていません (fail-closed)`
      }
    }

    // 4. 確認ハッシュの照合（CCPIT_L0_004 W4）: 画面が確認ダイアログに出した内容（同じ関数で組む）と、
    //    主処理が今から書く対象（自分の drift の結果）が食い違えば、何も書かずに拒否する
    const expectedConfirmationHash = sha256String(ledgerCatchupConfirmationString(matchedCommit))
    if (expectedConfirmationHash.toLowerCase() !== cleanConfirmationHash.toLowerCase()) {
      return {
        success: false,
        reason: 'confirmation-mismatch',
        error:
          '確認ダイアログに表示した内容と、実行しようとした内容が一致しません。golden は書き換えていません。画面を更新して、内容を確かめてからやり直してください。',
      }
    }

    const toolPath =
      opts.toolPath ||
      join(repoDir, '_Tools', 'golden-apply', 'golden-apply.mjs')

    if (!existsSync(toolPath)) {
      return { success: false, error: `契約実行ツールが見つかりません: ${toolPath}` }
    }

    // 5. 書き換えるスキルの集合が、確認ダイアログに出した集合と一致すること（CCPIT_L0_004 W4）。
    //    作業場・MANIFEST を作る前に、何も書かない算出で照合する
    const plannedSkills = ledgerCatchupAffectedSkills(repoDir, cleanSha)
    if (!sameSkillSet(plannedSkills, matchedCommit.skillsAffected)) {
      return {
        success: false,
        reason: 'confirmation-mismatch',
        error: `確認ダイアログに表示した影響スキル（${matchedCommit.skillsAffected.join(', ')}）と、台帳を書き換えるスキル（${plannedSkills.join(', ')}）が一致しません。golden は書き換えていません。`,
      }
    }

    let catchupRes
    try {
      catchupRes = await generateLedgerCatchupManifest({
        repoDir,
        unrecordedSha: cleanSha,
        lane: opts.lane || 'gui-ledger-catchup',
      })
    } catch (err) {
      return { success: false, error: `追補 MANIFEST の生成に失敗しました: ${String(err)}` }
    }
    catchupWorkDir = catchupRes.workDir

    // 守り: 生成した MANIFEST の集合も、同じであること（算出は同じ関数なので、通常は上の照合で決まる）
    if (!sameSkillSet(catchupRes.affectedSkills, matchedCommit.skillsAffected)) {
      return {
        success: false,
        reason: 'confirmation-mismatch',
        error: `確認ダイアログに表示した影響スキル（${matchedCommit.skillsAffected.join(', ')}）と、台帳を書き換えるスキル（${catchupRes.affectedSkills.join(', ')}）が一致しません。golden は書き換えていません。`,
      }
    }

    const { manifestPath, manifestSha256 } = catchupRes

    // 承認記録の生成 (C-3: 人間承認の事実・確認ダイアログの表示内容ハッシュ・影響スキルを記録)
    const now = new Date()
    // 契約 1 照合先②: 承認の印は MANIFEST 実 SHA-256 の先頭 8 桁（昇格・撤去・復帰と同じ）。
    // 乱数では golden-apply が必ず拒否する（2026-09-27 修正）
    const lionSha8 = manifestSha256.slice(0, 8)
    const reportDir =
      opts.reviewReportDir ||
      join(repoDir, '_Prompt', 'approval-records')
    await mkdir(reportDir, { recursive: true })
    const approvalRecordPath = join(
      reportDir,
      `approval_catchup_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
        now.getDate()
      ).padStart(2, '0')}_${lionSha8}.md`
    )

    const approvalRecordMd = [
      '# 契約 CLI 台帳追補 承認記録 (ADR 0002 準拠)',
      '',
      `- 承認者: ${cleanApprovedBy}`,
      `- 承認操作日時: ${cleanApprovedAt}`,
      `- 対象契約コミット: ${cleanSha}`,
      `- コミット件名: ${matchedCommit.subject}`,
      `- コミット適用者: ${matchedCommit.appliedBy}`,
      `- 影響スキル一覧: ${matchedCommit.skillsAffected.length > 0 ? matchedCommit.skillsAffected.join(', ') : 'なし'}`,
      `- 確認ダイアログ表示ハッシュ: ${cleanConfirmationHash}`,
      `- 生成 MANIFEST SHA256: ${manifestSha256}`,
      `- 承認根拠: ユーザー（maintainer）による GUI 追補確認ダイアログでの明示承認操作に基づく追補`,
      '',
    ].join('\n')
    await writeFile(approvalRecordPath, approvalRecordMd, 'utf-8')

    const execResult = await runGoldenApplyHelper({
      repoDir,
      toolPath,
      manifestPath,
      manifestSha256,
      reviewReportPath: approvalRecordPath,
      lionSha8,
      lane: opts.lane || 'gui-ledger-catchup',
      runsDir: opts.runsDir,
      onProgress: opts.onProgress,
    })

    if (execResult.code !== 0) {
      return {
        success: false,
        error: `契約実行ツールの適用が拒否されました (exit code: ${execResult.code}):\n${execResult.stderr || execResult.stdout}`,
      }
    }

    const commitMatch = execResult.stdout.match(/コミット SHA:\s*([0-9a-fA-F]{40})/)
    const commitSha = commitMatch ? commitMatch[1] : undefined
    return { success: true, commitSha }
  } finally {
    isPromotionApplying = false
    releaseManifestLock(lockResult.lockToken)
    if (catchupWorkDir) {
      try {
        rmSync(catchupWorkDir, { recursive: true, force: true })
      } catch {
        // 残った場合は、持ち主の記録（session-owner.json）により残骸の清掃の対象になる
      }
    }
  }
}

/**
 * Golden 配布中スキル一覧を取得 (G-1 / W3 台帳不一致検知)
 */
export async function listGoldenDeployedSkills(
  optionsOrRepoDir: string | { repoDir?: string; goldenRootDir?: string; ledgerPath?: string; withdrawnDir?: string } = {}
): Promise<DeployedSkillsResult & GoldenDeployedSkill[]> {
  let repoDir: string
  let goldenRootDir: string
  let ledgerPath: string
  let withdrawnDir: string

  if (typeof optionsOrRepoDir === 'string') {
    repoDir = optionsOrRepoDir
    goldenRootDir = findGoldenRootDir(repoDir)
    ledgerPath = join(goldenRootDir, 'common', 'golden-ledger.json')
    withdrawnDir = WITHDRAWN_DIR
  } else {
    repoDir = optionsOrRepoDir.repoDir || findRepoRootDir()
    goldenRootDir = optionsOrRepoDir.goldenRootDir || findGoldenRootDir(repoDir)
    ledgerPath = optionsOrRepoDir.ledgerPath || join(goldenRootDir, 'common', 'golden-ledger.json')
    withdrawnDir = optionsOrRepoDir.withdrawnDir || WITHDRAWN_DIR
  }

  const jaSkillsDir = join(goldenRootDir, 'common', 'ja', 'skills')
  const enSkillsDir = join(goldenRootDir, 'common', 'en', 'skills')

  const results: GoldenDeployedSkill[] = []

  // 台帳の読み込み・検証
  const readRes = readGoldenLedgerValidated(ledgerPath)
  if (readRes.status === 'corrupt') {
    const emptyResult: any = []
    emptyResult.skills = []
    emptyResult.ledgerCorrupt = true
    emptyResult.ledgerError = readRes.error
    return emptyResult
  }

  const ledgerMap = new Map<string, GoldenLedgerEntry>()
  for (const e of readRes.ledger) {
    if (e && e.name) ledgerMap.set(e.name, e)
  }

  // 1. 配布中（ja配下に存在）
  if (existsSync(jaSkillsDir)) {
    try {
      const dirEntries = await readdir(jaSkillsDir, { withFileTypes: true })
      for (const entry of dirEntries) {
        if (!entry.isDirectory()) continue
        const skillName = entry.name
        const jaSkillMd = join(jaSkillsDir, skillName, 'SKILL.md')
        if (!existsSync(jaSkillMd)) continue

        const content = await readFile(jaSkillMd, 'utf-8')
        const detail = parseSkillDetail(content, skillName)
        const enSkillMd = join(enSkillsDir, skillName, 'SKILL.md')
        const hasEn = existsSync(enSkillMd)
        const ledgerEntry = ledgerMap.get(skillName)

        // 台帳との完全性照合 (CRITICAL 2 / 全付随ファイル検査)
        let ledgerMismatch = false
        const mismatchedFiles: Array<{ path: string; ledgerHash: string; actualHash: string }> = []

        if (ledgerEntry) {
          const recordedPaths = new Set<string>()
          if (ledgerEntry.files && Array.isArray(ledgerEntry.files) && ledgerEntry.files.length > 0) {
            for (const fRecord of ledgerEntry.files) {
              recordedPaths.add(fRecord.path)
              const fileAbs = join(jaSkillsDir, skillName, fRecord.path)
              if (!existsSync(fileAbs)) {
                ledgerMismatch = true
                mismatchedFiles.push({
                  path: fRecord.path,
                  ledgerHash: fRecord.hash,
                  actualHash: 'MISSING',
                })
              } else {
                const buf = readFileSync(fileAbs)
                const actualHash = computeGoldenContentHash(fRecord.path, buf)
                if (actualHash !== fRecord.hash) {
                  ledgerMismatch = true
                  mismatchedFiles.push({
                    path: fRecord.path,
                    ledgerHash: fRecord.hash,
                    actualHash,
                  })
                }
              }
            }

            // 実体側に台帳未記録のファイルが存在しないか逆方向も照合 (Codex CRITICAL 2 指摘反映: 双方向完全性照合)
            const actualScan = scanLocalSkillFiles(join(jaSkillsDir, skillName))
            for (const actualFile of actualScan.files) {
              if (!recordedPaths.has(actualFile.relPath)) {
                ledgerMismatch = true
                mismatchedFiles.push({
                  path: actualFile.relPath,
                  ledgerHash: 'UNRECORDED',
                  actualHash: actualFile.hash,
                })
              }
            }
          } else {
            // files がない旧エントリは SKILL.md のみを検査
            const buf = readFileSync(jaSkillMd)
            const actualHash = computeGoldenContentHash('SKILL.md', buf)
            if (ledgerEntry.hash && actualHash !== ledgerEntry.hash) {
              ledgerMismatch = true
              mismatchedFiles.push({
                path: 'SKILL.md',
                ledgerHash: ledgerEntry.hash,
                actualHash,
              })
            }
          }
        }

        results.push({
          name: skillName,
          title: detail.title,
          description: detail.description,
          jaPath: jaSkillMd,
          enPath: enSkillMd,
          hasEn,
          status: 'deployed',
          detail,
          promotedAt: ledgerEntry?.promotedAt,
          ledgerMismatch,
          mismatchedFiles: ledgerMismatch ? mismatchedFiles : undefined,
        })
      }
    } catch (err) {
      console.error('Failed to read golden deployed skills:', err)
    }
  }

  // 2. 撤去済み（withdrawnDir に存在）
  if (existsSync(withdrawnDir)) {
    try {
      const withdrawnDirs = await readdir(withdrawnDir, { withFileTypes: true })
      for (const entry of withdrawnDirs) {
        if (!entry.isDirectory()) continue
        const skillName = entry.name
        if (results.some((r) => r.name === skillName)) continue

        const jaSkillMd = join(withdrawnDir, skillName, 'ja', 'SKILL.md')
        const enSkillMd = join(withdrawnDir, skillName, 'en', 'SKILL.md')
        let content = ''
        if (existsSync(jaSkillMd)) {
          content = await readFile(jaSkillMd, 'utf-8')
        }
        const detail = parseSkillDetail(content, skillName)
        const ledgerEntry = ledgerMap.get(skillName)

        results.push({
          name: skillName,
          title: detail.title,
          description: detail.description,
          jaPath: jaSkillMd,
          enPath: enSkillMd,
          hasEn: existsSync(enSkillMd),
          status: 'withdrawn',
          detail,
          promotedAt: ledgerEntry?.promotedAt,
          withdrawnAt: ledgerEntry?.promotedAt,
        })
      }
    } catch (err) {
      console.error('Failed to read withdrawn skills:', err)
    }
  }

  results.sort((a, b) => a.name.localeCompare(b.name))
  const finalResult: any = results
  finalResult.skills = results
  finalResult.ledgerCorrupt = false
  return finalResult
}

/**
 * Golden からスキルを引っ込める (G-2)
 * 1. ファイルを withdrawnDir (~/.ccpit/golden-withdrawn-skills/<skillName>) に退避 (goldenの外)
 * 2. 契約実行ツールで type: 'delete' パッチを適用
 * 3. 台帳に action: 'withdrawn' を追記
 */
export async function withdrawGoldenSkill(
  skillName: string,
  options: PromotionApplyOptions = {}
): Promise<PromotionApplyResult> {
  if (isPromotionApplying) {
    return { success: false, appliedItems: [], error: '別の処理が実行中です。' }
  }
  isPromotionApplying = true
  // 旗を立てた後の処理は、すべて try の中に置く（CCPIT_L0_004 W2。mkdir などの失敗で旗が戻らず、以後の昇格が止まっていた）
  let workDir: string | null = null

  try {
    const repoDir = options.repoDir || findRepoRootDir()
    const goldenRootDir = findGoldenRootDir(repoDir)
    const ledgerPath = join(goldenRootDir, 'common', 'golden-ledger.json')
    const ledgerCheck = readGoldenLedgerValidated(ledgerPath)
    if (ledgerCheck.status === 'corrupt') {
      return {
        success: false,
        appliedItems: [],
        error: `台帳破損エラー: golden-ledger.json が壊れているため撤去を拒否しました (${ledgerCheck.error})`,
      }
    }

    const toolPath = options.toolPath || join(repoDir, '_Tools', 'golden-apply', 'golden-apply.mjs')
    workDir = join(tmpdir(), `ccpit-withdraw-${randomBytes(4).toString('hex')}`)
    const withdrawnDir = options.withdrawnDir || WITHDRAWN_DIR
    await mkdir(workDir, { recursive: true })
    await writeSessionOwnerMeta(workDir, repoDir, 'gui-withdraw')

    const jaRel = `ccpit/golden/common/ja/skills/${skillName}/SKILL.md`
    const enRel = `ccpit/golden/common/en/skills/${skillName}/SKILL.md`
    const jaAbs = join(repoDir, jaRel)
    const enAbs = join(repoDir, enRel)

    if (!existsSync(jaAbs)) {
      throw new Error(`対象スキル「${skillName}」が Golden (${jaRel}) に存在しません。`)
    }

    // CCPIT_L0_010: 台帳に書く基準 commit。読めなかったら、退避ディレクトリへ写しを作る前に止める
    // （旧は HEAD が読めないと 'initial' で進み、台帳に initial を書いた。写しを作った後で止めると、退避先に写しが残って後の復元が拒否される）。
    // 作業場の作成・持ち主の記録の書き込みの後に置くのは、それらの失敗の報告（既存の失敗経路）を変えないため。作業場は finally で消える
    const baseHead = resolveHead(repoDir)
    if (baseHead.state === 'unreadable') throw baseHead.error
    if (baseHead.state === 'unborn') {
      throw new Error('golden のリポジトリに commit がありません。撤去の基準にできないので、最初の commit を作ってから、もう一度実行してください')
    }
    const baseCommitSha: string = baseHead.sha

    // 1. 退避ディレクトリへ退避 (golden の外！)
    const targetWithdrawnDir = join(withdrawnDir, skillName)
    await mkdir(join(targetWithdrawnDir, 'ja'), { recursive: true })
    const jaContent = await readUtf8Strict(jaAbs, `撤去対象 ja skill (${skillName})`)
    await writeFile(join(targetWithdrawnDir, 'ja', 'SKILL.md'), jaContent, 'utf-8')

    let enContent: string | null = null
    if (existsSync(enAbs)) {
      await mkdir(join(targetWithdrawnDir, 'en'), { recursive: true })
      enContent = await readUtf8Strict(enAbs, `撤去対象 en skill (${skillName})`)
      await writeFile(join(targetWithdrawnDir, 'en', 'SKILL.md'), enContent, 'utf-8')
    }

    // 2. パッチ生成
    const patches: any[] = []
    const jaSha = sha256NormalizedString(jaContent)
    const delJaPatch = createDeleteUnifiedDiff(jaRel, jaContent)
    const stagedJaPatch = join(workDir, `withdraw_ja_${skillName}.patch`)
    await writeFile(stagedJaPatch, Buffer.from(delJaPatch, 'utf-8'))

    patches.push({
      target_path: jaRel,
      type: 'delete',
      base_sha256: jaSha,
      expected_sha256: 'NONE',
      patch_file: stagedJaPatch,
      patch_sha256: sha256String(delJaPatch),
    })

    if (enContent !== null) {
      const enSha = sha256NormalizedString(enContent)
      const delEnPatch = createDeleteUnifiedDiff(enRel, enContent)
      const stagedEnPatch = join(workDir, `withdraw_en_${skillName}.patch`)
      await writeFile(stagedEnPatch, Buffer.from(delEnPatch, 'utf-8'))

      patches.push({
        target_path: enRel,
        type: 'delete',
        base_sha256: enSha,
        expected_sha256: 'NONE',
        patch_file: stagedEnPatch,
        patch_sha256: sha256String(delEnPatch),
      })
    }

    // 台帳更新 (action: 'withdrawn')
    const ledgerRelPath = 'ccpit/golden/common/golden-ledger.json'
    const ledgerAbsPath = join(repoDir, ledgerRelPath)
    let existingLedger: GoldenLedgerEntry[] = []
    let ledgerBaseSha = 'NONE'
    let ledgerOpType: 'add' | 'update' = 'add'
    if (existsSync(ledgerAbsPath)) {
      const buf = await readFile(ledgerAbsPath)
      const ledgerDecoded = decodeUtf8Strict(buf, '既存 golden-ledger.json (撤去)')
      ledgerBaseSha = sha256NormalizedString(ledgerDecoded)
      ledgerOpType = 'update'
      try {
        existingLedger = JSON.parse(stripBomForJsonParse(ledgerDecoded))
        if (!Array.isArray(existingLedger)) existingLedger = []
      } catch {
        existingLedger = []
      }
    }

    const now = new Date()
    const timestampIso = now.toISOString()
    const updatedLedger = [
      ...existingLedger,
      {
        name: skillName,
        target: `common/ja/skills/${skillName}/SKILL.md`,
        hash: jaSha,
        promotedAt: timestampIso,
        source: 'normal' as PromotionSource,
        goldenVersionAtPromotion: baseCommitSha,
        action: 'withdrawn' as const,
        history: { originalRecord: `撤去: ${skillName}` },
      },
    ]

    const ledgerStr = JSON.stringify(updatedLedger, null, 2) + '\n'
    const ledgerNewSha = sha256NormalizedString(ledgerStr)
    const stagedLedgerPatch = join(workDir, 'withdraw-ledger.patch')
    let ledgerPatch: string
    if (ledgerOpType === 'update') {
      const oldLedgerContent = await readUtf8Strict(ledgerAbsPath, '既存 golden-ledger.json (撤去)')
      ledgerPatch = createUpdateUnifiedDiff(ledgerRelPath, oldLedgerContent, ledgerStr, workDir)
    } else {
      ledgerPatch = createAddUnifiedDiff(ledgerRelPath, ledgerStr)
    }
    await writeFile(stagedLedgerPatch, Buffer.from(ledgerPatch, 'utf-8'))

    patches.push({
      target_path: ledgerRelPath,
      type: ledgerOpType,
      base_sha256: ledgerBaseSha,
      expected_sha256: ledgerNewSha,
      patch_file: stagedLedgerPatch,
      patch_sha256: sha256String(ledgerPatch),
    })

    // MANIFEST 書き出し
    const manifestStr = JSON.stringify({ patches }, null, 2) + '\n'
    const manifestPath = join(workDir, 'MANIFEST_WITHDRAW.json')
    await writeFile(manifestPath, manifestStr, 'utf-8')
    const manifestSha = sha256String(manifestStr)
    const lionSha8 = manifestSha.slice(0, 8)

    // 承認記録
    const reportDir = options.reviewReportDir || join(repoDir, '_Prompt', 'approval-records')
    await mkdir(reportDir, { recursive: true })
    const reportPath = join(reportDir, `approval_withdraw_${lionSha8}.md`)
    await writeFile(reportPath, `# Golden スキル撤去承認記録\n\n対象: ${skillName}\nMANIFEST SHA-256: ${manifestSha}\n`, 'utf-8')

    // 契約実行ツール実行
    const res = await runGoldenApplyHelper({
      repoDir,
      toolPath,
      manifestPath,
      manifestSha256: manifestSha,
      reviewReportPath: reportPath,
      lionSha8,
      lane: options.lane || 'gui-withdraw',
      runsDir: options.runsDir,
      onProgress: options.onProgress,
    })

    if (res.code !== 0) {
      throw new Error(`Golden からの撤去に失敗しました: ${res.stderr || res.stdout}`)
    }

    return { success: true, appliedItems: [skillName] }
  } finally {
    isPromotionApplying = false
    if (workDir) {
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }
}

export interface RollbackPromotionResult {
  success: boolean
  requestId: string
  /** golden に作られた戻しのコミット */
  commitSha?: string
  restoredGolden: string[]
  restoredLocal: string[]
  restoredRecords: string[]
  /** 復元前の確認で一致せず、上書きしなかった対象（理由つき） */
  skipped: Array<{ path: string; reason: string }>
  error?: string
}

/**
 * 提案の昇格を戻す（Plan r10 §8・T10）。
 *
 * 1. 適用前の保存（pre-apply）と適用直後の記録（post）を読む。無ければ戻さない
 * 2. 復元前の確認（CAS）: 全対象の現在の sha256 が post と一致するときだけ進む。1 つでも違えば何も上書きせず止める
 * 3. golden: 適用前の内容への逆パッチ（更新は update、昇格で追加したファイルは delete、消えたものは add）を作り、
 *    **昇格と同じ契約の手順（承認記録・鍵・検査・記名）で前進として流す**。契約の外から golden を直接書かない。
 *    golden-ledger.json も逆パッチの 1 件として契約ツールに流す（直接は書かない）
 * 4. golden が戻せなかったら、手元・記録には触れずに止める（正本と記録をずらさない）
 * 5. 手元の写しと記録（提案状態・合成台帳・レビュー台帳・提案 MD・昇格状態・配置台帳）を、保存した写しへ戻す。
 *    順序は golden → 手元 → 記録。各対象は書く直前にもう一度 CAS する
 */
export async function rollbackPromotion(
  requestId: string,
  options: PromotionApplyOptions = {}
): Promise<RollbackPromotionResult> {
  const fail = (error: string, extra: Partial<RollbackPromotionResult> = {}): RollbackPromotionResult => ({
    success: false,
    requestId,
    restoredGolden: [],
    restoredLocal: [],
    restoredRecords: [],
    skipped: [],
    error,
    ...extra,
  })
  if (isPromotionApplying) return fail('別の処理が実行中です。')
  const lockResult = acquireManifestLock('goldenPromotion:rollback')
  if (!lockResult.ok) return fail(lockResult.error)
  isPromotionApplying = true
  let workDir: string | null = null
  try {
    const repoDir = options.repoDir || findRepoRootDir()
    const stores = options.proposalStorePaths || getDefaultProposalStorePaths()
    const preDir = preApplyDirOf(dirname(stores.statesPath), requestId)
    const pre = readPreApply(preDir)
    const post = readPostApply(preDir)
    if (!pre || !post) {
      return fail(
        `提案「${requestId}」の適用前の保存（pre-apply）または適用直後の記録（post）が見つからないため、戻せません。`
      )
    }
    if (existsSync(join(preDir, 'rolled-back.json'))) {
      return fail(`提案「${requestId}」は既に戻し済みです。`)
    }

    const ledgerPath = join(findGoldenRootDir(repoDir), 'common', 'golden-ledger.json')
    const ledgerCheck = readGoldenLedgerValidated(ledgerPath)
    if (ledgerCheck.status === 'corrupt') {
      return fail(`台帳破損エラー: golden-ledger.json が壊れているため戻しを拒否しました (${ledgerCheck.error})`)
    }

    // 2. 復元前の確認（CAS）。1 つでも違えば何も上書きしない
    // 一部未復元で止まった後の再実行を許すため、「適用直後の値（post）」か「すでに適用前の値（pre）に戻っている」のどちらかなら通す。
    // どちらでもなければ（適用の後に別の編集が入った）、何も上書きせず止める
    const preShaOf = new Map(pre.entries.map((e) => [e.path, e.sha256]))
    const mismatches = checkMatchesPost(post).mismatches.filter((m) => m.actual !== preShaOf.get(m.path))
    if (mismatches.length > 0) {
      return fail(
        `適用の後に変更されたものがあるため、何も戻さず止めました（上書きで正当な編集を消さないため）: ${mismatches
          .map((m) => m.path)
          .join(', ')}`,
        { skipped: mismatches.map((m) => ({ path: m.path, reason: '現在値が適用直後の記録と違う' })) }
      )
    }
    const postShaOf = new Map(post.entries.map((e) => [e.path, e.sha256]))

    // 3. golden: 逆パッチを契約の手順で流す（すでに適用前の値に戻っているものは対象外）
    const goldenEntries = pre.entries.filter(
      (e) =>
        e.kind === 'golden' &&
        e.sha256 !== NONFILE &&
        (postShaOf.get(e.path) ?? ABSENT) !== e.sha256 &&
        sha256OfFile(e.path) !== e.sha256
    )
    const restoredGolden: string[] = []
    let commitSha: string | undefined
    if (goldenEntries.length > 0) {
      const toolPath = options.toolPath || join(repoDir, '_Tools', 'golden-apply', 'golden-apply.mjs')
      if (!existsSync(toolPath)) return fail(`契約実行ツールが見つかりません: ${toolPath}`)
      workDir = join(tmpdir(), `ccpit-rollback-${randomBytes(4).toString('hex')}`)
      await mkdir(workDir, { recursive: true })
      await writeSessionOwnerMeta(workDir, repoDir, 'gui-rollback')

      const patches: Array<{
        target_path: string
        type: 'add' | 'update' | 'delete'
        base_sha256: string
        expected_sha256: string
        patch_file: string
        patch_sha256: string
      }> = []
      let seq = 0
      for (const e of goldenEntries) {
        const rel = e.rel ?? normalizeRelPath(relative(repoDir, e.path))
        const postSha = postShaOf.get(e.path) ?? ABSENT
        const curBytes = postSha === ABSENT ? null : readFileSync(e.path)
        const preBytes = readCopy(preDir, e)
        let type: 'add' | 'update' | 'delete'
        let patchContent: string
        let base: string
        let expected: string
        if (preBytes === null && curBytes !== null) {
          // 昇格で追加したファイル → 逆パッチの delete
          type = 'delete'
          base = computeGoldenTargetHash(rel, curBytes)
          expected = 'NONE'
          const asText = tryDecodeUtf8(curBytes)
          patchContent =
            asText !== null
              ? createDeleteUnifiedDiff(rel, asText)
              : createGitBinaryPatch({ targetRelPath: rel, oldBytes: curBytes, newBytes: null })
        } else if (preBytes !== null && curBytes === null) {
          type = 'add'
          base = 'NONE'
          expected = computeGoldenTargetHash(rel, preBytes)
          patchContent = createGitBinaryPatch({ targetRelPath: rel, oldBytes: null, newBytes: preBytes })
        } else if (preBytes !== null && curBytes !== null) {
          type = 'update'
          base = computeGoldenTargetHash(rel, curBytes)
          expected = computeGoldenTargetHash(rel, preBytes)
          patchContent = createGitBinaryPatch({ targetRelPath: rel, oldBytes: curBytes, newBytes: preBytes })
        } else {
          continue
        }
        if (type !== 'delete' && base === expected) continue // 改行の差だけ等で実質同一
        const staged = join(workDir, `rollback_${String(++seq).padStart(3, '0')}.patch`)
        await writeFile(staged, Buffer.from(patchContent, 'utf-8'))
        patches.push({
          target_path: rel,
          type,
          base_sha256: base,
          expected_sha256: expected,
          patch_file: staged,
          patch_sha256: sha256String(patchContent),
        })
        restoredGolden.push(rel)
      }

      if (patches.length > 0) {
        const manifestStr = JSON.stringify({ patches }, null, 2) + '\n'
        const manifestPath = join(workDir, 'MANIFEST_ROLLBACK.json')
        await writeFile(manifestPath, manifestStr, 'utf-8')
        const manifestSha = sha256String(manifestStr)
        const lionSha8 = manifestSha.slice(0, 8)
        const reportDir = options.reviewReportDir || join(repoDir, '_Prompt', 'approval-records')
        await mkdir(reportDir, { recursive: true })
        const reportPath = join(reportDir, `approval_rollback_${lionSha8}.md`)
        await writeFile(
          reportPath,
          `# Golden 昇格の戻し 承認記録\n\n対象提案: ${requestId}\nMANIFEST SHA-256: ${manifestSha}\n`,
          'utf-8'
        )
        const res = await runGoldenApplyHelper({
          repoDir,
          toolPath,
          manifestPath,
          manifestSha256: manifestSha,
          reviewReportPath: reportPath,
          lionSha8,
          lane: options.lane || 'gui-rollback',
          runsDir: options.runsDir,
          onProgress: options.onProgress,
        })
        if (res.code !== 0) {
          return fail(
            `golden の戻しが契約実行ツールに拒否されました。手元・記録には触れていません（正本と記録をずらさないため）:\n${res.stderr || res.stdout}`
          )
        }
        const m = res.stdout.match(/コミット SHA:\s*([0-9a-fA-F]{40})/)
        commitSha = m ? m[1] : undefined
        // 契約ツールの結果が期待どおりか（golden の対象が適用前の内容に戻ったか）を実測する
        // 改行の差（契約ツールは golden に LF で入れる）で誤検出しないよう、契約の指紋（computeGoldenTargetHash）で比べる
        const notRestored = goldenEntries
          .filter((e) => {
            const rel = e.rel ?? normalizeRelPath(relative(repoDir, e.path))
            const preBytes = readCopy(preDir, e)
            if (preBytes === null) return existsSync(e.path)
            if (!existsSync(e.path)) return true
            return computeGoldenTargetHash(rel, readFileSync(e.path)) !== computeGoldenTargetHash(rel, preBytes)
          })
          .map((e) => e.rel ?? e.path)
        if (notRestored.length > 0) {
          return fail(
            `golden の戻しの後で、適用前の内容に戻っていないファイルがあります。手元・記録には触れていません: ${notRestored.join(', ')}`,
            { commitSha, restoredGolden }
          )
        }
      }
    }

    // 4〜5. 手元の写しと記録（golden の後）。各対象は書く直前にもう一度 CAS する
    const restoredLocal: string[] = []
    const restoredRecords: string[] = []
    const skipped: Array<{ path: string; reason: string }> = []
    // setProposalState・setProposalReview・合成台帳の更新と同じ `<ファイル>.lock` のプロセス間ロックの下で復元する
    const lockedRecord = (p: string): boolean =>
      p === stores.statesPath ||
      p === stores.reviewsPath ||
      p === getComposePaths(dirname(stores.statesPath)).mergesPath
    for (const kind of ['local', 'record'] as const) {
      for (const e of pre.entries.filter((x) => x.kind === kind)) {
        const postSha = postShaOf.get(e.path) ?? ABSENT
        if (postSha === e.sha256 || e.sha256 === NONFILE) continue
        const doRestore = (): void => {
          const curSha = sha256OfFile(e.path)
          if (curSha === e.sha256) return // 前回の戻しですでに適用前の値に戻っている
          if (curSha !== postSha) {
            skipped.push({ path: e.path, reason: '復元の直前に現在値が適用直後の記録と違っていた（上書きしない）' })
            return
          }
          restoreEntry(preDir, e)
          ;(kind === 'local' ? restoredLocal : restoredRecords).push(e.path)
        }
        try {
          if (kind === 'record' && lockedRecord(e.path)) await withFileLock(`${e.path}.lock`, doRestore)
          else doRestore()
        } catch (err) {
          skipped.push({ path: e.path, reason: err instanceof Error ? err.message : String(err) })
        }
      }
    }

    if (skipped.length > 0) {
      // 一部が未復元のときは rolled-back.json を書かない（書くと以後の再実行を恒久に拒否してしまう）。
      // golden は戻し済みなので、再実行は「golden に差分なし」から始まり、残った対象だけを再試行できる
      return {
        success: false,
        requestId,
        commitSha,
        restoredGolden,
        restoredLocal,
        restoredRecords,
        skipped,
        error: `一部未復元: golden は戻しましたが、上書きしなかった対象があります（適用の後に変更されていた／復元に失敗）。もう一度実行すると、残りだけを再試行できます: ${skipped.map((s) => `${s.path}（${s.reason}）`).join(', ')}`,
      }
    }
    writeFileSync(
      join(preDir, 'rolled-back.json'),
      JSON.stringify({ at: new Date().toISOString(), commitSha, restoredGolden, restoredLocal, restoredRecords }, null, 2),
      'utf-8'
    )
    return { success: true, requestId, commitSha, restoredGolden, restoredLocal, restoredRecords, skipped }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  } finally {
    isPromotionApplying = false
    releaseManifestLock(lockResult.lockToken)
    if (workDir) {
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }
}

/**
 * 引っ込めたスキルを Golden に復帰させる (G-2)
 * 1. 退避ディレクトリから内容を読み込む
 * 2. 契約実行ツールで type: 'add' パッチを適用
 * 3. 台帳に action: 'restored' を追記
 * 4. 退避ディレクトリをクリーンアップ
 */
export async function restoreGoldenSkill(
  skillName: string,
  options: PromotionApplyOptions = {}
): Promise<PromotionApplyResult> {
  if (isPromotionApplying) {
    return { success: false, appliedItems: [], error: '別の処理が実行中です。' }
  }
  isPromotionApplying = true
  // 旗を立てた後の処理は、すべて try の中に置く（CCPIT_L0_004 W2。撤去と同じ）
  let workDir: string | null = null

  try {
    const repoDir = options.repoDir || findRepoRootDir()
    const goldenRootDir = findGoldenRootDir(repoDir)
    const ledgerPath = join(goldenRootDir, 'common', 'golden-ledger.json')
    const ledgerCheck = readGoldenLedgerValidated(ledgerPath)
    if (ledgerCheck.status === 'corrupt') {
      return {
        success: false,
        appliedItems: [],
        error: `台帳破損エラー: golden-ledger.json が壊れているため復帰を拒否しました (${ledgerCheck.error})`,
      }
    }

    const toolPath = options.toolPath || join(repoDir, '_Tools', 'golden-apply', 'golden-apply.mjs')
    workDir = join(tmpdir(), `ccpit-restore-${randomBytes(4).toString('hex')}`)
    const withdrawnDir = options.withdrawnDir || WITHDRAWN_DIR
    await mkdir(workDir, { recursive: true })
    await writeSessionOwnerMeta(workDir, repoDir, 'gui-restore')

    const targetWithdrawnDir = join(withdrawnDir, skillName)
    const jaSavedPath = join(targetWithdrawnDir, 'ja', 'SKILL.md')
    if (!existsSync(jaSavedPath)) {
      throw new Error(`退避されたスキル「${skillName}」が見つかりません: ${jaSavedPath}`)
    }

    // CCPIT_L0_010: 台帳に書く基準 commit。読めなかったら止める（旧は 'initial' で進んだ）。
    // 作業場の作成・持ち主の記録・退避された skill の確認の後に置くのは、それらの失敗の報告（既存の失敗経路）を変えないため
    const baseHead = resolveHead(repoDir)
    if (baseHead.state === 'unreadable') throw baseHead.error
    if (baseHead.state === 'unborn') {
      throw new Error('golden のリポジトリに commit がありません。復帰の基準にできないので、最初の commit を作ってから、もう一度実行してください')
    }
    const baseCommitSha: string = baseHead.sha

    const jaContent = await readUtf8Strict(jaSavedPath, `復帰対象 ja skill (${skillName})`)
    const jaRel = `ccpit/golden/common/ja/skills/${skillName}/SKILL.md`
    const jaSha = sha256NormalizedString(jaContent)
    const addJaPatch = createAddUnifiedDiff(jaRel, jaContent)
    const stagedJaPatch = join(workDir, `restore_ja_${skillName}.patch`)
    await writeFile(stagedJaPatch, Buffer.from(addJaPatch, 'utf-8'))

    const patches: any[] = [
      {
        target_path: jaRel,
        type: 'add',
        base_sha256: 'NONE',
        expected_sha256: jaSha,
        patch_file: stagedJaPatch,
        patch_sha256: sha256String(addJaPatch),
      },
    ]

    const enSavedPath = join(targetWithdrawnDir, 'en', 'SKILL.md')
    if (existsSync(enSavedPath)) {
      const enContent = await readUtf8Strict(enSavedPath, `復帰対象 en skill (${skillName})`)
      const enRel = `ccpit/golden/common/en/skills/${skillName}/SKILL.md`
      const enSha = sha256NormalizedString(enContent)
      const addEnPatch = createAddUnifiedDiff(enRel, enContent)
      const stagedEnPatch = join(workDir, `restore_en_${skillName}.patch`)
      await writeFile(stagedEnPatch, Buffer.from(addEnPatch, 'utf-8'))
      patches.push({
        target_path: enRel,
        type: 'add',
        base_sha256: 'NONE',
        expected_sha256: enSha,
        patch_file: stagedEnPatch,
        patch_sha256: sha256String(addEnPatch),
      })
    }

    // 台帳更新 (action: 'restored')
    const ledgerRelPath = 'ccpit/golden/common/golden-ledger.json'
    const ledgerAbsPath = join(repoDir, ledgerRelPath)
    let existingLedger: GoldenLedgerEntry[] = []
    let ledgerBaseSha = 'NONE'
    let ledgerOpType: 'add' | 'update' = 'add'
    if (existsSync(ledgerAbsPath)) {
      const buf = await readFile(ledgerAbsPath)
      const ledgerDecoded = decodeUtf8Strict(buf, '既存 golden-ledger.json (復帰)')
      ledgerBaseSha = sha256NormalizedString(ledgerDecoded)
      ledgerOpType = 'update'
      try {
        existingLedger = JSON.parse(stripBomForJsonParse(ledgerDecoded))
        if (!Array.isArray(existingLedger)) existingLedger = []
      } catch {
        existingLedger = []
      }
    }

    const now = new Date()
    const timestampIso = now.toISOString()
    const updatedLedger = [
      ...existingLedger,
      {
        name: skillName,
        target: `common/ja/skills/${skillName}/SKILL.md`,
        hash: jaSha,
        promotedAt: timestampIso,
        source: 'normal' as PromotionSource,
        goldenVersionAtPromotion: baseCommitSha,
        action: 'restored' as const,
        history: { originalRecord: `復帰: ${skillName}` },
      },
    ]

    const ledgerStr = JSON.stringify(updatedLedger, null, 2) + '\n'
    const ledgerNewSha = sha256NormalizedString(ledgerStr)
    const stagedLedgerPatch = join(workDir, 'restore-ledger.patch')
    let ledgerPatch: string
    if (ledgerOpType === 'update') {
      const oldLedgerContent = await readUtf8Strict(ledgerAbsPath, '既存 golden-ledger.json (復帰)')
      ledgerPatch = createUpdateUnifiedDiff(ledgerRelPath, oldLedgerContent, ledgerStr, workDir)
    } else {
      ledgerPatch = createAddUnifiedDiff(ledgerRelPath, ledgerStr)
    }
    await writeFile(stagedLedgerPatch, Buffer.from(ledgerPatch, 'utf-8'))

    patches.push({
      target_path: ledgerRelPath,
      type: ledgerOpType,
      base_sha256: ledgerBaseSha,
      expected_sha256: ledgerNewSha,
      patch_file: stagedLedgerPatch,
      patch_sha256: sha256String(ledgerPatch),
    })

    // MANIFEST
    const manifestStr = JSON.stringify({ patches }, null, 2) + '\n'
    const manifestPath = join(workDir, 'MANIFEST_RESTORE.json')
    await writeFile(manifestPath, manifestStr, 'utf-8')
    const manifestSha = sha256String(manifestStr)
    const lionSha8 = manifestSha.slice(0, 8)

    // 承認記録
    const reportDir = options.reviewReportDir || join(repoDir, '_Prompt', 'approval-records')
    await mkdir(reportDir, { recursive: true })
    const reportPath = join(reportDir, `approval_restore_${lionSha8}.md`)
    await writeFile(reportPath, `# Golden スキル復帰承認記録\n\n対象: ${skillName}\nMANIFEST SHA-256: ${manifestSha}\n`, 'utf-8')

    // 契約実行ツール実行
    const res = await runGoldenApplyHelper({
      repoDir,
      toolPath,
      manifestPath,
      manifestSha256: manifestSha,
      reviewReportPath: reportPath,
      lionSha8,
      lane: options.lane || 'gui-restore',
      runsDir: options.runsDir,
      onProgress: options.onProgress,
    })

    if (res.code !== 0) {
      throw new Error(`Golden への復帰に失敗しました: ${res.stderr || res.stdout}`)
    }

    // 退避ディレクトリをクリーンアップ
    try {
      if (existsSync(targetWithdrawnDir)) {
        const { rm } = await import('fs/promises')
        await rm(targetWithdrawnDir, { recursive: true, force: true })
      }
    } catch {
      // ignore
    }

    return { success: true, appliedItems: [skillName] }
  } finally {
    isPromotionApplying = false
    if (workDir) {
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }
}

/**
 * 孤立した隔離 worktree の検出ヘルパー (What 3 / C-4)
 * tmpdir() 直下（正規化済み相対パス）かつ basename が golden-wt-*、ブランチが golden-apply/* の場合のみ対象
 */
export function findOrphanedWorktrees(repoDir: string = findRepoRootDir()): Array<{ path: string; branch: string }> {
  // 読めなかったら空配列にせず `GoldenGitReadError` を投げる（旧は失敗＝0 件で、画面の枠が消え、清掃は worktree を見失って
  // 「ブランチ削除の失敗」という誤った理由で止まった。CCPIT_L0_014 P2）。git のリポジトリの外（`.git` がどこにも無い）は、
  // 孤立 worktree が確かに無い場所＝従来どおり空
  const read = readGoldenText(repoDir, ['worktree', 'list', '--porcelain'], { op: 'worktree' })
  if (read.state === 'unreadable') {
    if (read.error.kind === 'exit' && !isInsideGitRepo(repoDir)) return []
    throw read.error
  }
  // 終了 0 なのに出力が空はあり得ない（健全な repo は少なくとも主 worktree を 1 件返す）。「0 件」にせず読めなかったことにする
  // （Codex 実装レビュー 2 回目の指摘 1。`checkLease` の「終了 0 なのに出力が空」と同じ扱い）
  if (!read.stdout.trim()) {
    throw new GoldenGitReadError({
      op: 'worktree',
      failure: {
        kind: 'inconsistent',
        via: 'worktree',
        exitCode: 0,
        signal: null,
        errorCode: null,
        stderrHead: '',
        stderrEmpty: true,
        maxBuffer: null
      },
      note: '終了 0 なのに出力が空（主 worktree が一覧に無い）'
    })
  }
  try {
    const blocks = read.stdout.split('\n\n')
    const orphans: Array<{ path: string; branch: string }> = []
    const normTmp = resolve(tmpdir())

    for (const b of blocks) {
      const lines = b.split('\n')
      let wtPath = ''
      let branch = ''
      for (const l of lines) {
        if (l.startsWith('worktree ')) wtPath = l.slice(9).trim()
        if (l.startsWith('branch ')) branch = l.slice(7).trim()
      }
      if (!wtPath) continue

      // 1. tmpdir() の直下ディレクトリであること（正規化相対パスにセパレータや親参照が含まれない）
      const rel = relative(normTmp, resolve(wtPath))
      const isDirectChildOfTmp =
        rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes('/') && !rel.includes('\\')

      // 2. basename が golden-wt- で始まること
      const baseName = basename(wtPath)
      const isGoldenWt = baseName.startsWith('golden-wt-')

      // 3. ブランチが golden-apply/ で始まること
      const isGoldenBranch = branch.startsWith('refs/heads/golden-apply/') || branch.startsWith('golden-apply/')

      if (isDirectChildOfTmp && isGoldenWt && isGoldenBranch) {
        orphans.push({ path: wtPath, branch })
      }
    }
    return orphans
  } catch {
    return []
  }
}

/**
 * What 1: リース状態・衝突原因の診断（What 1, C-1）
 */
export async function getGoldenLeaseStatus(
  repoDir: string = findRepoRootDir(),
  runsDir: string = PROMOTION_RUNS_DIR
): Promise<GoldenLeaseStatus> {
  const LEASE_REF = 'refs/leases/golden'
  // git を読めなかった項目は、「無い」「正常」に畳まず readError に残す（旧は rev-parse の失敗＝リース無し、cat-file の失敗＝空の blob、
  // master の失敗＝黙って未設定、worktree の失敗＝0 件。画面が事実と違う「正常」を出した。CCPIT_L0_014 P1・P2）。
  // 読めた上で「確かに無い」ものは従来どおり（リース無し・master 無し）。git のリポジトリの外（`.git` がどこにも無い）は
  // 読めなかったのではなく「リースが確かに無い場所」＝従来どおり
  const readErrors: string[] = []
  const leaseRead = checkLease(repoDir, LEASE_REF)
  const outsideRepo = (e: GoldenGitReadError): boolean => e.kind === 'exit' && !isInsideGitRepo(repoDir)

  let orphanedWorktrees: Array<{ path: string; branch: string }> = []
  let worktreeReadError: string | undefined
  try {
    orphanedWorktrees = findOrphanedWorktrees(repoDir)
  } catch (err) {
    if (!isGoldenGitReadError(err)) throw err
    worktreeReadError = err.message
  }

  if (leaseRead.state === 'unreadable') {
    const noLease: GoldenLeaseStatus = { exists: false, orphanedWorktrees }
    if (worktreeReadError !== undefined) noLease.worktreeReadError = worktreeReadError
    if (!outsideRepo(leaseRead.error)) noLease.readError = leaseRead.error.message
    return noLease
  }
  if (leaseRead.state === 'absent') {
    const noLease: GoldenLeaseStatus = { exists: false, orphanedWorktrees }
    if (worktreeReadError !== undefined) noLease.worktreeReadError = worktreeReadError
    return noLease
  }

  const leaseId = leaseRead.sha
  const catRead = readGoldenText(repoDir, ['cat-file', '-p', LEASE_REF], { op: 'lease', ref: LEASE_REF })
  let rawContent = ''
  if (catRead.state === 'unreadable') readErrors.push(catRead.error.message)
  else rawContent = catRead.stdout || ''

  let blob: GoldenLeaseBlob | undefined
  let parseError: string | undefined

  // blob を読めなかったときは解析しない（空文字の解析エラー「Unexpected end of JSON input」を、読めなかったことの代わりにしない）
  if (catRead.state === 'ok') {
    try {
      const parsed = JSON.parse(rawContent)
      const requiredKeys: (keyof GoldenLeaseBlob)[] = [
        'lane',
        'issued_by',
        'issued_at',
        'expires_at',
        'manifest_sha256',
        'base_master',
        'session8',
      ]
      for (const k of requiredKeys) {
        if (typeof parsed[k] !== 'string' || !parsed[k].trim()) {
          throw new Error(`契約 L 違反: 必須キー「${k}」が欠落または無効です`)
        }
      }
      blob = parsed as GoldenLeaseBlob
    } catch (err: any) {
      parseError = err.message
    }
  }

  let isExpired: boolean | undefined
  let remainingSeconds: number | undefined
  let expiresAtIso: string | undefined

  if (blob && blob.expires_at) {
    expiresAtIso = blob.expires_at
    const expMs = new Date(blob.expires_at).getTime()
    if (!isNaN(expMs)) {
      const diffSec = Math.floor((expMs - Date.now()) / 1000)
      remainingSeconds = diffSec
      isExpired = diffSec <= 0
    }
  }

  let currentMasterMatches: boolean | undefined
  let currentMaster: string | undefined
  // master が確かに無い（終了 1・標準エラー空）のは従来どおり黙って未設定。読めなかったものは readError に残す
  const masterRead = checkRef(repoDir, 'refs/heads/master', 'ref')
  if (masterRead.state === 'present') {
    currentMaster = masterRead.sha
    if (blob && blob.base_master) {
      currentMasterMatches = currentMaster.toLowerCase() === blob.base_master.toLowerCase()
    }
  } else if (masterRead.state === 'unreadable') {
    readErrors.push(masterRead.error.message)
  }

  const partialStatus: GoldenLeaseStatus = {
    exists: true,
    leaseId,
    blob,
    rawContent,
    parseError,
    isExpired,
    remainingSeconds,
    expiresAtIso,
    currentMasterMatches,
    currentMaster,
    orphanedWorktrees,
  }
  if (readErrors.length > 0) partialStatus.readError = readErrors.join(' / ')
  if (worktreeReadError !== undefined) partialStatus.worktreeReadError = worktreeReadError

  // 早期解放資格の判定。リース・blob・master を読めなかったときは呼ばない（判定が master を自分で読み直し、読めないと
  // 「base_master が現在の実 master と一致しません」という誤った理由を資格に載せるため。CCPIT_L0_014 P1）
  if (partialStatus.readError === undefined) {
    const entitlement = await verifyEarlyReleaseEntitlement(repoDir, partialStatus, runsDir)
    partialStatus.earlyReleaseEntitlement = entitlement
    if (entitlement.runningPid) {
      partialStatus.isOwnerAlive = isProcessAlive(entitlement.runningPid)
    }
  }

  // matchingRunRecord の特定（leaseId 完全一致のみ）
  const { records } = loadAllPromotionRunRecords(runsDir)
  if (leaseId) {
    const matched = records.filter((r) => r.leaseId && r.leaseId === leaseId)
    if (matched.length === 1) {
      partialStatus.matchingRunRecord = matched[0]
      if (partialStatus.isOwnerAlive === undefined) {
        partialStatus.isOwnerAlive = isProcessAlive(matched[0].pid)
      }
    }
  }

  return partialStatus
}

/**
 * What 2: 期限切れリースの安全な CAS 解放（What 2, C-2, C-3）
 * master 再検証と lease 削除を同一 git update-ref --stdin トランザクションでアトミックに実行
 */
export async function releaseExpiredGoldenLease(
  repoDir: string = findRepoRootDir(),
  expectedLeaseId: string
): Promise<{ success: boolean; releasedLeaseId: string }> {
  if (!expectedLeaseId || typeof expectedLeaseId !== 'string' || !expectedLeaseId.trim()) {
    throw new Error('契約 L 回復拒否: expectedLeaseId の指定が必須です')
  }

  const LEASE_REF = 'refs/leases/golden'
  // 直前 Pre-flight Check (C-3, p2-4)
  const status = await getGoldenLeaseStatus(repoDir)
  // 読めなかったものを「存在しません」「不明」との不一致という理由にしない（何も解放していない。CCPIT_L0_014 P1）
  if (status.readError) {
    throw new Error(`契約 L 回復拒否: リースの状態を git から読めませんでした（何も解放していません）。${status.readError}`)
  }
  if (!status.exists || !status.leaseId || !status.blob) {
    throw new Error('契約 L 回復拒否: refs/leases/golden は存在しません')
  }

  if (status.leaseId !== expectedLeaseId) {
    throw new Error(
      `契約 L 回復拒否: 画面表示時の leaseId (${expectedLeaseId}) と現在の leaseId (${status.leaseId}) が一致しません`
    )
  }

  // 失効判定の再検証: 期限切れでなければ拒否
  if (!status.isExpired) {
    throw new Error(
      `契約 L 回復拒否: リースはまだ失効していません (残り約 ${status.remainingSeconds ?? '不明'} 秒)`
    )
  }

  // base_master と現在の実 master の事前検証
  if (status.currentMasterMatches !== true) {
    throw new Error(
      `契約 L 回復拒否: base_master (${status.blob.base_master}) が現在の実 master (${status.currentMaster || '不明'}) と一致しません`
    )
  }

  // アトミック CAS: master verify と lease delete を同一 update-ref --stdin トランザクションで原子的実行 (C-6)
  const stdinLines = [
    `verify refs/heads/master ${status.blob.base_master}`,
    `delete ${LEASE_REF} ${status.leaseId}`,
    ''
  ].join('\n')

  const delRes = spawnSync('git', ['update-ref', '--stdin'], {
    cwd: repoDir,
    input: stdinLines,
    encoding: 'utf-8',
  })

  if (delRes.status !== 0) {
    throw new Error(`契約 L 回復拒否: CAS によるアトミック解放に失敗しました (master 移動または lease 不一致): ${delRes.stderr || delRes.stdout}`)
  }

  return { success: true, releasedLeaseId: status.leaseId }
}

/** 残骸の清掃が見る、CCPIT の作業場の接頭辞（持ち主は session-owner.json か実行の記録で確かめる） */
const CLEANUP_TEMP_DIR_PREFIXES = [
  'ccpit-promo-',
  'ccpit-withdraw-',
  'ccpit-restore-',
  'ccpit-rollback-',
  'ccpit_catchup_',
] as const

/**
 * CCPIT の昇格が作ったブランチ・worktree の一覧（CCPIT_L0_004 W3）。
 *
 * 持ち主の原則: 「CCPIT が作る前に書いた記録（実行の記録）」と「物の識別子」が一致し、記録の repoDir・hostname が
 * 今のクローンと一致し、記録のプロセスが死んでいること。名前の接頭辞が同じというだけでは持ち主とみなさない。
 * 改修前の記録（goldenApplyBranch が無い）は、leaseId の blob から session8 を復元できたときだけ含める。
 */
export function collectOwnedApplyBranches(
  repoDir: string,
  runsDir: string = PROMOTION_RUNS_DIR
): Map<string, { worktreePrefix: string; runId: string }> {
  const owned = new Map<string, { worktreePrefix: string; runId: string }>()
  const normRepoDir = repoDir.replace(/\\/g, '/').toLowerCase()
  const currentHost = hostname().toLowerCase()
  const { records } = loadAllPromotionRunRecords(runsDir)
  for (const r of records) {
    if ((r.repoDir || '').replace(/\\/g, '/').toLowerCase() !== normRepoDir) continue
    if ((r.hostname || '').toLowerCase() !== currentHost) continue
    if (isProcessAlive(r.pid)) continue
    const sha8 = (r.manifestSha256 || '').slice(0, 8)
    if (r.goldenApplyBranch && r.worktreePrefix) {
      owned.set(r.goldenApplyBranch, { worktreePrefix: r.worktreePrefix, runId: r.runId })
      continue
    }
    // 改修前の記録: リースの blob（golden-apply.mjs が hash-object -w で書いた JSON）の session8 から名前を組み直す
    if (!r.leaseId || !/^[0-9a-f]{8}$/i.test(sha8) || !/^[0-9a-f]{40}$/i.test(r.leaseId)) continue
    const blob = spawnSync('git', ['cat-file', '-p', r.leaseId], { cwd: repoDir, encoding: 'utf-8' })
    if (blob.status !== 0) continue
    try {
      const s8 = JSON.parse(blob.stdout)?.session8
      if (typeof s8 === 'string' && /^[0-9A-Za-z]+$/.test(s8)) {
        owned.set(`golden-apply/${sha8}-${s8}`, { worktreePrefix: `golden-wt-${sha8}-`, runId: r.runId })
      }
    } catch {
      // 壊れた blob は対象にしない
    }
  }
  return owned
}

/**
 * What 3: 残骸（孤立 worktree / 一時ブランチ）の安全な清掃（What 3, C-4）
 */
export async function cleanupPromotionArtifacts(
  repoDir: string = findRepoRootDir(),
  runsDir: string = PROMOTION_RUNS_DIR
): Promise<PromotionArtifactCleanupResult> {
  const LEASE_REF = 'refs/leases/golden'
  // リースの有無を確かめられないまま清掃しない（旧は git の失敗＝リース無しと読んで、使用中の worktree・ブランチを消しうる清掃へ進んだ）。
  // 「確かに無い」（終了 1 かつ標準エラーが空）のときだけ進む。壊れたリース ref・git の失敗・時間切れは、何も消さずに拒否する
  const leaseRead = checkLease(repoDir, LEASE_REF)
  if (leaseRead.state === 'unreadable') {
    throw new Error(`残骸清掃拒否: リースの有無を確かめられませんでした（何も消していません）。${leaseRead.error.message}`)
  }
  if (leaseRead.state === 'present') {
    throw new Error('残骸清掃拒否: refs/leases/golden が存在している間は残骸を清掃できません')
  }

  const cleanedWorktrees: string[] = []
  const cleanedBranches: string[] = []
  // 持ち主を確かめられず、消さずに残した物（CCPIT_L0_004 W3）
  const keptUnknownOwner: string[] = []
  const ownedBranches = collectOwnedApplyBranches(repoDir, runsDir)

  // 何かを消す前に、消す対象の一覧（残置 worktree・孤立ブランチ）をどちらも読む。どちらかを読めなければ、何も消さずに止まる
  // （旧は、一覧の失敗＝0 件で進み、worktree を見失って「ブランチ削除の失敗」という誤った理由で止まる／ブランチが黙って 0 件の
  // 成功になった。ブランチの列挙を worktree の清掃より前へ移しても、列挙は読み取りだけで worktree の remove はブランチを消さない
  // ので、名前の集合は同じ。使用中のブランチの削除は git が拒否する。CCPIT_L0_014 P2・P3）
  let orphans: Array<{ path: string; branch: string }>
  try {
    orphans = findOrphanedWorktrees(repoDir)
  } catch (err) {
    if (!isGoldenGitReadError(err)) throw err
    throw new Error(`残骸清掃拒否: 残置 worktree の一覧を git から読めませんでした（何も消していません）。${err.message}`)
  }
  const branchRead = readGoldenText(repoDir, ['branch', '--list', 'golden-apply/*'], { op: 'branch' })
  if (branchRead.state === 'unreadable') {
    throw new Error(`残骸清掃拒否: 孤立ブランチの一覧を git から読めませんでした（何も消していません）。${branchRead.error.message}`)
  }
  const branchListOut = branchRead.stdout

  // 1. 隔離 worktree の清掃（対象限定 & 失敗時不変）
  for (const wt of orphans) {
    const branchName = wt.branch.replace(/^refs\/heads\//, '')
    const owner = ownedBranches.get(branchName)
    if (!owner || !basename(resolve(wt.path)).startsWith(owner.worktreePrefix)) {
      keptUnknownOwner.push(`worktree ${wt.path} (${branchName})`)
      continue
    }
    if (wt.path) {
      // --force を使わず正常な remove を試行。失敗時は例外を投げてディレクトリ強制削除を行わない（失敗時不変）
      const rmRes = spawnSync('git', ['worktree', 'remove', wt.path], { cwd: repoDir, encoding: 'utf-8' })
      if (rmRes.status !== 0) {
        throw new Error(`残骸清掃失敗: 隔離 worktree (${wt.path}) の解除に失敗しました: ${rmRes.stderr || rmRes.stdout}`)
      }
      // 成功後だけ対象パスを fs.rmSync(..., { recursive: true, force: true })
      if (existsSync(wt.path)) {
        try {
          const fs = require('fs')
          fs.rmSync(wt.path, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
      cleanedWorktrees.push(wt.path)
    }
  }
  // ※ git worktree prune は対象外登録にも作用し得るため完全除外 (High 4)

  // 2. 孤立ブランチ golden-apply/* の削除（列挙は、何かを消す前に上で済ませてある）
  if (branchListOut) {
    const branches = branchListOut
      .split('\n')
      .map((b) => b.replace(/^[*+ ]+/, '').trim())
      .filter(Boolean)
    for (const b of branches) {
      if (!ownedBranches.has(b)) {
        keptUnknownOwner.push(`branch ${b}`)
        continue
      }
      // 持ち主の worktree を上で残した場合（接頭辞の不一致など）は、ブランチも消さない（checkout 中で消せない）
      if (keptUnknownOwner.some((k) => k.startsWith('worktree ') && k.endsWith(`(${b})`))) continue
      const delB = spawnSync('git', ['branch', '-D', b], { cwd: repoDir, encoding: 'utf-8' })
      if (delB.status === 0) {
        cleanedBranches.push(b)
      } else {
        throw new Error(`残骸清掃失敗: 一時ブランチ (${b}) の削除に失敗しました: ${delB.stderr || delB.stdout}`)
      }
    }
  }

  // 3. 一時作業フォルダ（ccpit-promo-*, ccpit-withdraw-*, ccpit-restore-*）の安全な清掃 (W2, Codex 指摘反映)
  const cleanedTempDirs: string[] = []
  const normTmp = resolve(tmpdir())
  const normRepoDir = repoDir.replace(/\\/g, '/').toLowerCase()
  const currentHost = hostname().toLowerCase()

  try {
    const tempEntries = readdirSync(normTmp, { withFileTypes: true })

    for (const ent of tempEntries) {
      if (!ent.isDirectory()) continue
      const name = ent.name
      // プレフィックス制限（接頭辞は候補の絞り込みにすぎない。持ち主は下の記録で確かめる）
      // CCPIT_L0_004 W1: 戻し（ccpit-rollback-）・台帳の追い付け（ccpit_catchup_）の作業場も対象に足した
      if (!CLEANUP_TEMP_DIR_PREFIXES.some((p) => name.startsWith(p))) {
        continue
      }

      const fullPath = join(normTmp, name)

      // パストラバーサル検査: tmpdir() 直下限定
      const rel = relative(normTmp, resolve(fullPath))
      if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel) || rel.includes('/') || rel.includes('\\')) {
        continue
      }

      // シンボリックリンク / ジャンクション (reparse point) の拒否 (Codex 指摘)
      try {
        const lstat = lstatSync(fullPath)
        if (lstat.isSymbolicLink()) {
          continue
        }
      } catch {
        continue
      }

      // 自クローン同定の検査
      let isOwnerMatched = false

      // 判定法 A: session-owner.json の検証
      const ownerPath = join(fullPath, 'session-owner.json')
      if (existsSync(ownerPath)) {
        try {
          const ownerContent = readFileSync(ownerPath, 'utf-8')
          const owner = JSON.parse(ownerContent)
          const ownerRepo = (owner.repoDir || '').replace(/\\/g, '/').toLowerCase()
          const ownerHost = (owner.hostname || '').toLowerCase()
          // 記録が、このフォルダのために書かれたものであること（別のフォルダへ写した記録で消させない。
          // CCPIT_L0_004 Codex 実装レビュー 1 巡目。workDirName は 2026-09-19 の 3247f6f 以降の記録が必ず持つ）
          const ownerDirName = typeof owner.workDirName === 'string' ? owner.workDirName : ''
          // 同一ホスト・同一クローンの確認
          if (ownerDirName === name && ownerRepo === normRepoDir && ownerHost === currentHost) {
            // プロセスが生存している場合は絶対に削除しない（実行中保護）
            if (!isProcessAlive(owner.pid)) {
              isOwnerMatched = true
            }
          }
        } catch {
          // JSON 不正時は fail-closed で削除しない
        }
      } else {
        // session-owner.json の無いフォルダは消さない（CCPIT_L0_004 W3・Codex 実装レビュー 2 巡目）。
        // 旧来の判定法 B（中の MANIFEST の sha256 を実行の記録と照合）は、記録がフォルダを指していないため、
        // 既存の MANIFEST を別の ccpit-* フォルダへ写すだけで、そのフォルダを消させられた。
        // CCPIT の作業場は 5 種とも作った直後に session-owner.json を書く（2026-09-19 の 3247f6f 以降）。
        // それより前の残骸は持ち主を確かめられないので、名前を挙げて残し、扱いは人が決める
        keptUnknownOwner.push(`temp ${name}（持ち主の記録 session-owner.json が無い）`)
      }

      if (isOwnerMatched) {
        try {
          rmSync(fullPath, { recursive: true, force: true })
          cleanedTempDirs.push(fullPath)
        } catch (rmErr) {
          console.error(`Failed to clean temp directory ${fullPath}:`, rmErr)
        }
      }
    }
  } catch (err) {
    console.error('Error while scanning temp directories for cleanup:', err)
  }

  return { cleanedWorktrees, cleanedBranches, cleanedTempDirs, keptUnknownOwner }
}

/**
 * What 5 & 6: 早期解放資格の判定（What 5, 6, C-8, 追補条項 L-b）
 * Codex 指摘反映: 単一集約入口として冒頭で reconcileOrphanPromotionRuns を実行
 */
export async function verifyEarlyReleaseEntitlement(
  repoDir: string = findRepoRootDir(),
  currentStatus?: GoldenLeaseStatus,
  runsDir: string = PROMOTION_RUNS_DIR,
  options?: { now?: Date }
): Promise<{
  entitled: boolean
  reason?: string
  runningRunId?: string
  runningPid?: number
  reconciledRunIds?: string[]
}> {
  // 1. 冒頭でクラッシュした孤立実行の回収・終了認定を試行 (Codex 指摘集約)
  const { reconciledRunIds } = reconcileOrphanPromotionRuns(repoDir, runsDir, options)

  const { records, hasError } = loadAllPromotionRunRecords(runsDir)

  // (1) フェイルクローズ: 個別ファイル破損または読み取りエラー時拒否 (Codex p2-2)
  if (hasError) {
    return {
      entitled: false,
      reason: '昇格実行記録ファイルの一部が破損または読み取り不能です（安全のため早期解放を拒否します）',
    }
  }

  const normRepoDir = repoDir.replace(/\\/g, '/').toLowerCase()

  // (2) 同一クローンで running 状態のプロセスが実在するか検査 (C-8, R-2)
  const activeProcesses = records.filter((r) => {
    const rRepo = (r.repoDir || '').replace(/\\/g, '/').toLowerCase()
    if (rRepo !== normRepoDir) return false
    if (r.exitCode !== undefined || r.endedAt !== undefined) return false
    return isProcessAlive(r.pid)
  })

  if (activeProcesses.length > 0) {
    const pids = activeProcesses.map((p) => p.pid).join(', ')
    return {
      entitled: false,
      reason: `同一クローン内で昇格プロセス (PID: ${pids}) が現在も実行中です`,
    }
  }

  // (3) 対象リースの特定 (p2-4)
  let leaseBlob = currentStatus?.blob
  let leaseId = currentStatus?.leaseId
  let currentMasterMatches = currentStatus?.currentMasterMatches

  if (!leaseBlob || !leaseId) {
    const LEASE_REF = 'refs/leases/golden'
    const revRes = spawnSync('git', ['rev-parse', '--verify', LEASE_REF], { cwd: repoDir, encoding: 'utf-8' })
    if (revRes.status !== 0 || !revRes.stdout.trim()) {
      return { entitled: false, reason: 'refs/leases/golden が存在しません' }
    }
    leaseId = revRes.stdout.trim()
    const catRes = spawnSync('git', ['cat-file', '-p', LEASE_REF], { cwd: repoDir, encoding: 'utf-8' })
    try {
      leaseBlob = JSON.parse(catRes.stdout)
    } catch {
      return { entitled: false, reason: 'リース blob の解析に失敗しました' }
    }
  }

  if (!leaseBlob || !leaseId) {
    return { entitled: false, reason: 'リース情報の取得に失敗しました' }
  }

  // (4) base_master と現在の実 master の一致検証 (追補条項 L-b(ii), C-8)
  if (currentMasterMatches === undefined) {
    try {
      const masterRes = spawnSync('git', ['rev-parse', 'refs/heads/master'], { cwd: repoDir, encoding: 'utf-8' })
      if (masterRes.status === 0 && masterRes.stdout.trim()) {
        const curMaster = masterRes.stdout.trim()
        currentMasterMatches = curMaster.toLowerCase() === (leaseBlob.base_master || '').toLowerCase()
      } else {
        currentMasterMatches = false
      }
    } catch {
      currentMasterMatches = false
    }
  }

  if (!currentMasterMatches) {
    return {
      entitled: false,
      reason: `lease blob の base_master (${leaseBlob.base_master}) が現在の実 master と一致しません`,
    }
  }

  // (5) 該当する実行記録を検索（leaseId 完全一致のみ。追補条項 L-b(i)）
  const candidateRecords = records.filter((r) => r.leaseId && r.leaseId === leaseId)

  if (candidateRecords.length === 0) {
    return {
      entitled: false,
      reason: '本環境（~/.ccpit/golden-promotion-runs）に対象 leaseId の昇格実行記録が見つかりません（他PCまたは他クローン・他者による発行の可能性があります）',
    }
  }

  if (candidateRecords.length > 1) {
    return {
      entitled: false,
      reason: `対象 leaseId の昇格実行記録が複数件 (${candidateRecords.length} 件) 存在し曖昧です`,
    }
  }

  const targetRecord = candidateRecords[0]

  // (6) クローン一致の検証 (L-b(i))
  const targetRepo = (targetRecord.repoDir || '').replace(/\\/g, '/').toLowerCase()
  if (targetRepo !== normRepoDir) {
    return {
      entitled: false,
      reason: `当該リースは別クローン (${targetRecord.repoDir}) から発行されたため早期解放できません`,
    }
  }

  // (7) 同一ホストの検証 (追補条項 L-b(i))
  const currentHost = hostname().toLowerCase()
  const targetHost = (targetRecord.hostname || '').toLowerCase()
  if (!targetHost || targetHost !== currentHost) {
    return {
      entitled: false,
      reason: `当該リースは別ホスト (${targetRecord.hostname || '不明'}) から発行されたため早期解放できません (追補条項 L-b(i))`,
    }
  }

  // (8) CCPIT による終了確認 (追補条項 L-b(i))
  // プロセスが存在しないこと単独（kill -0 失敗のみ）を根拠とした死亡推定は禁止する
  // CCPIT 自身の実行管理下で起動され、かつ終了（exitCode または endedAt）が記録されたプロセスのみを死亡とみなす
  if (targetRecord.endedAt === undefined && targetRecord.exitCode === undefined) {
    return {
      entitled: false,
      reason: `CCPIT の実行記録に対象プロセスの終了（exitCode または endedAt）が記録されていません（PID 単独推定は禁止されています）`,
      runningPid: targetRecord.pid,
      runningRunId: targetRecord.runId,
    }
  }

  // (9) OS プロセスの不在確認
  if (isProcessAlive(targetRecord.pid)) {
    return {
      entitled: false,
      reason: `所有者プロセス (PID: ${targetRecord.pid}) が現在も生存しています`,
      runningPid: targetRecord.pid,
      runningRunId: targetRecord.runId,
    }
  }

  // すべての条件を満たす: 早期解放資格あり
  return {
    entitled: true,
    runningRunId: targetRecord.runId,
    runningPid: targetRecord.pid,
    reconciledRunIds,
  }
}

/**
 * What 7: 所有者死亡時の安全な早期解放（What 7, C-7, 追補条項 L-b）
 * master 再検証と lease 削除を同一 git update-ref --stdin トランザクションでアトミックに実行
 */
export async function releaseEarlyGoldenLease(
  repoDir: string = findRepoRootDir(),
  expectedLeaseId: string,
  runsDir: string = PROMOTION_RUNS_DIR,
  challengeToken?: string
): Promise<{ success: boolean; releasedLeaseId: string }> {
  if (!expectedLeaseId || typeof expectedLeaseId !== 'string' || !expectedLeaseId.trim()) {
    throw new Error('契約 L 早期解放拒否: expectedLeaseId の指定が必須です')
  }

  // 追補条項 L-b(iii): Main プロセスの確認ダイアログ結果に紐づくワンタイム承認トークンの検証・消費
  // （approvedBy は renderer 入力で信頼せず、Main 側ダイアログで発行・消費されたトークンのみを唯一の承認根拠とする）
  if (!challengeToken || !consumeEarlyReleaseChallenge(expectedLeaseId, challengeToken)) {
    throw new Error('契約 L 早期解放拒否: maintainer個別明示承認のワンタイム検証に失敗しました（無効または期限切れの承認トークンです）')
  }

  const LEASE_REF = 'refs/leases/golden'
  // 直前 Pre-flight Check (C-7, p2-4)
  const status = await getGoldenLeaseStatus(repoDir, runsDir)
  if (status.readError) {
    throw new Error(`契約 L 早期解放拒否: リースの状態を git から読めませんでした（何も解放していません）。${status.readError}`)
  }
  if (!status.exists || !status.leaseId || !status.blob) {
    throw new Error('契約 L 早期解放拒否: refs/leases/golden は存在しません')
  }

  if (status.leaseId !== expectedLeaseId) {
    throw new Error(
      `契約 L 早期解放拒否: 画面表示時の leaseId (${expectedLeaseId}) と現在の leaseId (${status.leaseId}) が一致しません`
    )
  }

  // base_master と現在の実 master の一致検証 (追補条項 L-b(ii), C-7)
  if (status.currentMasterMatches !== true) {
    throw new Error(
      `契約 L 早期解放拒否: base_master (${status.blob.base_master}) が現在の実 master (${status.currentMaster || '不明'}) と一致しません`
    )
  }

  // 早期解放資格の直前再検証 (p2-4)
  const entitlement = await verifyEarlyReleaseEntitlement(repoDir, status, runsDir)
  if (!entitlement.entitled) {
    throw new Error(`契約 L 早期解放拒否: ${entitlement.reason || '早期解放資格を満たしていません'}`)
  }

  // アトミック CAS: master verify と lease delete を同一 update-ref --stdin トランザクションで原子的実行 (C-6)
  const stdinLines = [
    `verify refs/heads/master ${status.blob.base_master}`,
    `delete ${LEASE_REF} ${status.leaseId}`,
    ''
  ].join('\n')

  const delRes = spawnSync('git', ['update-ref', '--stdin'], {
    cwd: repoDir,
    input: stdinLines,
    encoding: 'utf-8',
  })

  if (delRes.status !== 0) {
    throw new Error(`契約 L 早期解放拒否: CAS によるアトミック解放に失敗しました (master 移動または lease 不一致): ${delRes.stderr || delRes.stdout}`)
  }

  return { success: true, releasedLeaseId: status.leaseId }
}
