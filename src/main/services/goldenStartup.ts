import { app } from 'electron'
import { existsSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { basename, dirname, join } from 'path'

import { readConfigSync, getParcFermeDir } from './appConfig'
import { KNOWN_TEMPLATES } from './denyValidation'
import { getGoldenDir, resolveGoldenFiles } from './golden'
import {
  getManifestPath,
  hashFileAt,
  readManifest,
  listUndoGenerations,
  normalizeRelPath,
  type UndoGenerationGroup
} from './goldenManifest'
import {
  prepareAndLaunchProposalPacket,
  commitProposalResult,
  restoreUndoAndPromote,
  type RestoreUndoResult
} from './goldenAncestorExits'
import {
  buildMergeConsultPacket,
  deriveImpact,
  proposalTargetToRel,
  validateMergeConsultTargets,
  type MergeConsultProposal,
  type MergeConsultSubject
} from './goldenMergeConsult'
import {
  discardOverlayEntry,
  getOverlayDir,
  overlayFilePath,
  readOverlayIndex
} from './goldenOverlay'
import { assertWithinProposalsFolder } from './proposalReviewRequest'
import {
  getDefaultProposalsFolder,
  parseProposalMdFromRaw,
  readProposalStates
} from './skillProposals'
import {
  applyPendingReconcile,
  collectFollowUpState,
  deferPendingReconcile,
  remanagePaths,
  resolvePendingReconcile,
  runStartupReconcile,
  toPendingReconcileEntries,
  type ApplyReconcileResult,
  type FollowUpEntry,
  type PendingReconcileEntry,
  type ReconcileDecision,
  type ResolveReconcileResult,
  type StartupReconcileResult
} from './goldenReconcileService'

/**
 * 起動時照合（§9 配線 P4）の合成層。
 *
 * `goldenReconcileService` は electron 非依存に保つ（単体テストが実機なしで回るため）。
 * electron / app-config / 同梱物の解決という「環境の話」はこの薄い層だけが持つ。
 */

/** 照合を実行しなかった理由。 */
export type StartupReconcileSkip =
  /** Fresh Start 未実施。~/.claude は我々が配置したものではない */
  | 'not-deployed'
  /** PIT 参照中など golden 由来でない配置。触ってはいけない */
  | 'not-golden-source'
  /** 記録された template が未知（配布物と config の不整合） */
  | 'unknown-template'

export type StartupReconcileDecision =
  | { run: true; templateName: string }
  | { run: false; reason: StartupReconcileSkip }

/**
 * 「そもそも照合してよい環境か」を判定する純粋関数。
 *
 * 照合は**書き込みを伴う**（ケース2/5/restore を無確認で適用する）。
 * よって「CCPIT が golden を配置した環境」であることを確認できない限り走らせない。
 * 記録を持たない `~/.claude` はユーザーの資産であって、我々の管理対象ではない。
 */
export function decideStartupReconcile(cfg: {
  deploySource?: string
  deployedTemplate?: string
}): StartupReconcileDecision {
  if (cfg.deploySource !== 'golden') return { run: false, reason: 'not-golden-source' }
  const templateName = cfg.deployedTemplate
  if (!templateName) return { run: false, reason: 'not-deployed' }
  if (!(KNOWN_TEMPLATES as readonly string[]).includes(templateName)) {
    return { run: false, reason: 'unknown-template' }
  }
  return { run: true, templateName }
}

let lastResult: StartupReconcileResult | null = null

/**
 * 直近の照合結果。P5（確認ダイアログ）が `pending` を pull するための保持庫。
 * P4 の時点では保持するだけで、UI へは出さない。
 */
export function getLastStartupReconcile(): StartupReconcileResult | null {
  return lastResult
}

export type StartupReconcileOutcome =
  | { ran: true; result: StartupReconcileResult }
  | { ran: false; reason: StartupReconcileSkip }

/** 照合対象の環境を解決する。ここだけが electron / config / 同梱物を知る。 */
async function resolveReconcileEnv(templateName: string): Promise<{
  templateName: string
  goldenFiles: Map<string, string>
  targetDir: string
  parcFermeDir: string
  overlayActivePaths: ReadonlySet<string>
  overlayStalePaths: ReadonlySet<string>
}> {
  // ADR 0002: 供給元は「同梱 golden に逆向き反映を重ねたもの」。
  // 内訳（有効 / 失効）も一緒に受け取る — 失効した rel は無確認適用から外し、
  // 有効な rel はベースライン移行で `promoted` として記録する必要があるため。
  const resolution = await resolveGoldenFiles(templateName)
  return {
    templateName,
    goldenFiles: resolution.merged,
    targetDir: join(app.getPath('home'), '.claude'),
    parcFermeDir: getParcFermeDir(),
    overlayActivePaths: new Set(resolution.active),
    overlayStalePaths: new Set(resolution.stale)
  }
}

/** `app.whenReady()` から 1 回だけ呼ぶ。 */
export async function runStartupReconcileForApp(): Promise<StartupReconcileOutcome> {
  const decision = decideStartupReconcile(readConfigSync())
  if (!decision.run) return { ran: false, reason: decision.reason }

  const env = await resolveReconcileEnv(decision.templateName)
  const result = await runStartupReconcile({
    templateName: env.templateName,
    goldenFiles: env.goldenFiles,
    targetDir: env.targetDir,
    parcFermeDir: env.parcFermeDir,
    overlayActivePaths: env.overlayActivePaths,
    overlayStalePaths: env.overlayStalePaths
  })
  lastResult = result
  return { ran: true, result }
}

/**
 * 確認待ちを解消済みとして手元から外す。
 *
 * 適用した項目も「後で」を選んだ項目も、**この起動中は二度と出さない**。
 * 「後で」の再提示は次回起動の再分類から導出される（D6）ので、ここで残す必要が無い。
 */
function dropFromPending(paths: string[]): void {
  if (lastResult === null) return
  const done = new Set(paths)
  lastResult = { ...lastResult, pending: lastResult.pending.filter((i) => !done.has(i.path)) }
}

/** ダイアログが pull する確認待ち一覧（D3）。 */
export function getPendingReconcileEntries(): PendingReconcileEntry[] {
  return lastResult === null ? [] : toPendingReconcileEntries(lastResult.pending)
}

/** 「OK」— 選ばれた項目を `.bak` を残して golden で上書きする。 */
export async function applyPendingReconcileForApp(paths: string[]): Promise<ApplyReconcileResult> {
  const decision = decideStartupReconcile(readConfigSync())
  if (!decision.run) {
    // 照合してよい環境でないなら書き込みもしない（起動時判定と同じ門を通す）。
    return { applied: [], failed: [], backups: [], skipped: paths, manifestUpdated: false }
  }
  const env = await resolveReconcileEnv(decision.templateName)
  const result = await applyPendingReconcile({
    templateName: env.templateName,
    goldenFiles: env.goldenFiles,
    targetDir: env.targetDir,
    parcFermeDir: env.parcFermeDir,
    paths
  })
  dropFromPending([...result.applied, ...result.skipped])
  return result
}

/** 反映先がアプリの更新・再インストールで失われない場所か（ADR 0002 の完了条件）。 */
export interface ResolveReconcileForAppResult extends ResolveReconcileResult {
  /**
   * 反映先がアプリ本体の外にあるか。
   *
   * 「書けた」と「残る」は別問題なので、主張ではなく**実測**で返す:
   * packaged のリソース配下（`process.resourcesPath`）に無いことを確認する。
   */
  overlayDurable: boolean
  /** W2: propose 出口の実行結果（パケット・起動・要約） */
  proposeResults?: {
    txId: string
    packetPath: string
    launched: boolean
    autoExitSeconds: number
    sanitizedSummaries: {
      rel: string
      publicPath: string
      attentionCount: number
      sanitizedDiff: string
    }[]
    error?: string
  }
}

export interface ResolveReconcileAppOptions {
  proposePaths?: string[]
}

/** 反映先がアプリのリソース配下に無いか（＝更新で置き換わらないか）を実測する。 */
function measureOverlayDurable(overlayDir: string): boolean {
  const resources = process.resourcesPath
  if (typeof resources !== 'string' || resources === '') return true
  const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
  return !norm(overlayDir).startsWith(`${norm(resources)}/`)
}

/**
 * 確認ダイアログの決定をまとめて実行する（ADR 0002・UI が使う唯一の書込経路）。
 * W1/W2: propose 出口が含まれる場合、パケット作成・起動・反映記録の原子的確定を直列実行する。
 */
export async function resolvePendingReconcileForApp(
  decisions: ReconcileDecision[],
  options?: ResolveReconcileAppOptions
): Promise<ResolveReconcileForAppResult> {
  const decision = decideStartupReconcile(readConfigSync())
  const overlayDir = getOverlayDir(getParcFermeDir())
  if (!decision.run) {
    // 門が閉じているときは 1 バイトも書かない。要求は全件 `skipped` として返し、
    // UI が「やった」と誤報できないようにする（部分成功の握り潰し防止）。
    return {
      applied: [],
      promoted: [],
      unmanaged: [],
      deferred: [],
      failed: [],
      backups: [],
      skipped: decisions.map((d) => ({ path: d.path, reason: 'not-pending' as const })),
      overlayDir,
      overlayDurable: measureOverlayDurable(overlayDir),
      manifestUpdated: false
    }
  }
  const env = await resolveReconcileEnv(decision.templateName)

  // W2: propose 出口の処理（proposePaths が指定されている場合）
  let proposalPrep: Awaited<ReturnType<typeof prepareAndLaunchProposalPacket>> | null = null
  let finalDecisions = [...decisions]
  const promoteDisallowedRels = new Map<string, string>()

  if (options?.proposePaths && options.proposePaths.length > 0) {
    const manifest = await readManifest(getManifestPath(env.parcFermeDir))
    const goldenOldHashes = new Map<string, string | null>()
    if (manifest) {
      for (const e of manifest.entries) {
        goldenOldHashes.set(normalizeRelPath(e.path), e.goldenHash)
      }
    }
    proposalPrep = await prepareAndLaunchProposalPacket({
      parcFermeDir: env.parcFermeDir,
      targetDir: env.targetDir,
      templateName: env.templateName,
      proposePaths: options.proposePaths,
      goldenOldHashes
    })

    if (!proposalPrep.ok && !proposalPrep.packetPath) {
      // 事前検証（source 候補数など）に失敗した場合はパケット自体が存在しないため中断
      return {
        applied: [],
        promoted: [],
        unmanaged: [],
        deferred: [],
        failed: options.proposePaths.map((p) => ({
          path: p,
          message: proposalPrep!.error ?? 'proposal_failed'
        })),
        backups: [],
        skipped: decisions.map((d) => ({ path: d.path, reason: 'not-pending' as const })),
        overlayDir,
        overlayDurable: measureOverlayDurable(overlayDir),
        manifestUpdated: false,
        proposeResults: {
          txId: proposalPrep.txId || '',
          packetPath: '',
          launched: false,
          autoExitSeconds: 60,
          sanitizedSummaries: [],
          error: proposalPrep.error
        }
      }
    }

    // パケット作成後・promote 直前の G_old/G_new/U 再実測 (AC20, AC24, Codex 指摘)
    for (const p of options.proposePaths) {
      const norm = normalizeRelPath(p)
      const snap = proposalPrep.snapshotsByRel.get(norm)
      if (snap) {
        const currentDestPath = join(env.targetDir, norm)
        const currentSourcePath =
          env.goldenFiles.get(norm) ?? join(getGoldenDir(), env.templateName, norm)
        const curU = existsSync(currentDestPath) ? await hashFileAt(currentDestPath) : null
        const curGNew = existsSync(currentSourcePath) ? await hashFileAt(currentSourcePath) : null
        const curGOld = goldenOldHashes.get(norm) ?? ''

        if (curU !== snap.u || curGNew !== snap.gNew || curGOld !== snap.gOld) {
          promoteDisallowedRels.set(norm, 'packet_created_then_changed')
        }
      }
    }

    // 変更が検知された rel は promote 対象から除外
    if (promoteDisallowedRels.size > 0) {
      finalDecisions = finalDecisions.filter(
        (d) => !promoteDisallowedRels.has(normalizeRelPath(d.path))
      )
    }
  }

  let result: Awaited<ReturnType<typeof resolvePendingReconcile>>
  let promoteExecutionFailed = false
  try {
    result = await resolvePendingReconcile({
      templateName: env.templateName,
      goldenFiles: env.goldenFiles,
      targetDir: env.targetDir,
      parcFermeDir: env.parcFermeDir,
      overlayStalePaths: env.overlayStalePaths,
      decisions: finalDecisions
    })
  } catch (err: unknown) {
    promoteExecutionFailed = true
    result = {
      applied: [],
      promoted: [],
      unmanaged: [],
      deferred: [],
      failed: finalDecisions.map((d) => ({
        path: d.path,
        message: err instanceof Error ? err.message : String(err)
      })),
      backups: [],
      skipped: [],
      overlayDir,
      manifestUpdated: false
    }
  }

  dropFromPending([
    ...result.applied,
    ...result.promoted,
    ...result.unmanaged,
    ...result.deferred,
    ...result.skipped.map((s) => s.path)
  ])

  // 終端記録の原子的確定（パケットが存在する場合は例外・起動失敗問わず必ず実行・AC20 fail-closed）
  let proposeResults: ResolveReconcileForAppResult['proposeResults'] = undefined
  if (proposalPrep && proposalPrep.packetPath) {
    const promoteResults = options!.proposePaths!.map((p) => {
      const norm = normalizeRelPath(p)
      if (promoteDisallowedRels.has(norm)) {
        return { rel: norm, ok: false, reason: promoteDisallowedRels.get(norm)! }
      }
      if (promoteExecutionFailed) {
        return { rel: norm, ok: false, reason: 'reconcile_exception' }
      }
      if (!proposalPrep!.launched) {
        return { rel: norm, ok: false, reason: 'launch_failed' }
      }
      const ok = result.promoted.includes(norm)
      return {
        rel: norm,
        ok,
        reason: ok ? undefined : 'promotion_failed'
      }
    })

    const commitOk = await commitProposalResult({
      packetDir: dirname(proposalPrep.packetPath),
      txId: proposalPrep.txId,
      results: promoteResults
    })

    proposeResults = {
      txId: proposalPrep.txId,
      packetPath: proposalPrep.packetPath,
      launched: proposalPrep.launched,
      autoExitSeconds: proposalPrep.autoExitSeconds,
      sanitizedSummaries: proposalPrep.sanitizedSummaries,
      error: !commitOk
        ? 'commit_result_failed'
        : !proposalPrep.launched
          ? proposalPrep.error ?? 'launch_failed'
          : undefined
    }
  }

  return {
    ...result,
    overlayDurable: measureOverlayDurable(result.overlayDir),
    ...(proposeResults ? { proposeResults } : {})
  }
}

/** W3: アンドゥ可能なバックアップ世代の一覧を取得する (AC9, AC12, AC13) */
export async function listUndoGenerationsForApp(): Promise<UndoGenerationGroup[]> {
  const decision = decideStartupReconcile(readConfigSync())
  if (!decision.run) return []
  const env = await resolveReconcileEnv(decision.templateName)
  return listUndoGenerations({
    parcFermeDir: env.parcFermeDir,
    targetDir: env.targetDir
  })
}

/** W3: アンドゥ要求を実行し、同時に overlay へ昇格・台帳更新する (AC10, AC11, AC21) */
export async function restoreUndoBackupsForApp(
  requests: { rel: string; generationStamp: string }[]
): Promise<RestoreUndoResult[]> {
  const decision = decideStartupReconcile(readConfigSync())
  if (!decision.run) return []
  const env = await resolveReconcileEnv(decision.templateName)
  return restoreUndoAndPromote({
    parcFermeDir: env.parcFermeDir,
    targetDir: env.targetDir,
    templateName: env.templateName,
    requests
  })
}

/** 未追従の一覧（Health 画面が表示する）。門が閉じていれば空。 */
export async function getFollowUpStateForApp(): Promise<FollowUpEntry[]> {
  const decision = decideStartupReconcile(readConfigSync())
  if (!decision.run) return []
  const env = await resolveReconcileEnv(decision.templateName)
  return collectFollowUpState({
    goldenFiles: env.goldenFiles,
    targetDir: env.targetDir,
    parcFermeDir: env.parcFermeDir
  })
}

/** 「もう問わない」の取り消し（次回起動で再提示させる）。 */
export async function remanageForApp(
  paths: string[]
): Promise<{ unmanaged: string[]; deferred: string[]; manifestUpdated: boolean }> {
  const decision = decideStartupReconcile(readConfigSync())
  if (!decision.run) return { unmanaged: [], deferred: [], manifestUpdated: false }
  return remanagePaths({ parcFermeDir: getParcFermeDir(), paths })
}

/**
 * 反映（overlay）を破棄する。
 *
 * **失効した反映もユーザーの内容が入った唯一の控えになりうる**ので、自動では消さない。
 * 破棄は明示的な操作としてのみ行う。
 */
export async function discardOverlayForApp(
  paths: string[]
): Promise<{ discarded: string[] }> {
  const decision = decideStartupReconcile(readConfigSync())
  if (!decision.run) return { discarded: [] }
  const parcFermeDir = getParcFermeDir()
  const discarded: string[] = []
  for (const p of paths) {
    await discardOverlayEntry(parcFermeDir, p)
    discarded.push(p)
  }
  return { discarded }
}

/** 「後で」— manifest に持ち越しを記録し、次回起動で再提示させる（D6）。 */
export async function deferPendingReconcileForApp(
  paths: string[]
): Promise<{ deferred: string[]; manifestUpdated: boolean }> {
  const decision = decideStartupReconcile(readConfigSync())
  if (!decision.run) return { deferred: [], manifestUpdated: false }

  const result = await deferPendingReconcile({ parcFermeDir: getParcFermeDir(), paths })
  dropFromPending(paths)
  return result
}

/** 起動ログ 1 行。適用・失敗・確認待ちの件数を必ず可視化する（D7: 黙って落とさない）。 */
export function formatStartupReconcileLog(outcome: StartupReconcileOutcome): string {
  if (!outcome.ran) return `[golden-reconcile] skipped reason=${outcome.reason}`
  const r = outcome.result
  return [
    `[golden-reconcile] status=${r.status}`,
    `applied=${r.applied.length}`,
    `failed=${r.failed.length}`,
    `pending=${r.pending.length}`,
    `unchanged=${r.unchangedCount}`,
    // ADR 0002: 「台帳のずれだけ直した」件数と「問わないと決めた」件数も必ず出す。
    // 提示件数が減った理由が分からないと、静かに握り潰したのと区別が付かない。
    `ledgerHealed=${r.ledgerHealed.length}`,
    `unmanaged=${r.unmanaged.length}`,
    `manifestUpdated=${r.manifestUpdated}`
  ].join(' ')
}

/* ------------------------------------------------------------------ *
 * CCPIT_064 / ADR 0003 — 「Claude Code に相談」の依頼パケット組み立て
 * ------------------------------------------------------------------ */

export interface PrepareMergeConsultInput {
  /** 確認ダイアログで「相談」を選んだ rel（配置先ルート相対） */
  paths: string[]
  /** Skill 候補画面から起動するときの提案 MD（絶対パス。target の rel も対象に加える） */
  proposalPaths?: string[]
  /** 配布元がリポジトリ正本か（テスト用注入。未指定時は !app.isPackaged） */
  isRepo?: boolean
}

export type PrepareMergeConsultResult =
  | { ok: true; packet: string; subjects: string[]; proposals: number }
  | { ok: false; error: string }

/** 配置先の隣にある `.bak*`（過去の内容の手がかり）。読めなければ空。 */
async function listBackupsBeside(destPath: string): Promise<string[]> {
  const dir = dirname(destPath)
  const name = basename(destPath)
  try {
    const names = await readdir(dir)
    return names
      .filter((n) => n.startsWith(`${name}.bak`))
      .sort()
      .map((n) => join(dir, n))
  } catch {
    return []
  }
}

/**
 * 同じ rel の他言語版の配布元。`<golden>/common/<lang>/<rel>` の形のときだけ存在しうる
 * （hooks / scripts / template 配下は言語非依存なので空）。
 */
async function listSiblingLanguageSources(
  sourcePath: string
): Promise<{ lang: string; path: string }[]> {
  const norm = sourcePath.replace(/\\/g, '/')
  const m = norm.match(/^(.*\/common)\/([^/]+)\/(.+)$/)
  if (!m) return []
  const [, commonDir, lang, rest] = m
  if (lang === 'hooks' || lang === 'scripts') return []
  let dirs: string[]
  try {
    dirs = (await readdir(commonDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
  const out: { lang: string; path: string }[] = []
  for (const d of dirs.sort()) {
    if (d === lang || d === 'hooks' || d === 'scripts') continue
    const candidate = join(commonDir, d, rest)
    if (existsSync(candidate)) out.push({ lang: d, path: candidate })
  }
  return out
}

/**
 * 相談パケットを組み立てる（何も書かない。読むだけ）。
 *
 * 対象 rel ごとに、配置先（U）・配布元（G_new）・台帳の基準（G_old）・overlay・退避ファイルを
 * 今この瞬間に実測して書く。
 *
 * 【Codex Finding 1 是正】
 * 明示指定された提案 MD の target rel と要求 rel の束縛を検証し、
 * 不整合があれば即座に fail-closed で拒否する。
 */
export async function prepareMergeConsultForApp(
  input: PrepareMergeConsultInput
): Promise<PrepareMergeConsultResult> {
  const cfg = readConfigSync()
  const decision = decideStartupReconcile(cfg)
  if (!decision.run) {
    return { ok: false, error: `golden reconcile is not active (${decision.reason})` }
  }
  const env = await resolveReconcileEnv(decision.templateName)
  const manifest = await readManifest(getManifestPath(env.parcFermeDir))
  const overlayIndex = await readOverlayIndex(env.parcFermeDir)
  const oldByPath = new Map((manifest?.entries ?? []).map((e) => [e.path, e] as const))
  const overlayByPath = new Map(overlayIndex.entries.map((e) => [e.path, e] as const))
  const pendingByPath = new Map((lastResult?.pending ?? []).map((i) => [i.path, i] as const))
  const normKey = (p: string): string => p.replace(/\\/g, '/').toLowerCase()

  // --- 提案の境界検査・解析 ---
  const proposalsFolder = getDefaultProposalsFolder()
  const explicitProposalPaths = new Set<string>()
  try {
    for (const raw of input.proposalPaths ?? []) {
      // 提案フォルダ外（別ドライブ・symlink 含む）を拒否 (assertWithinProposalsFolder)
      const checked = assertWithinProposalsFolder(String(raw), proposalsFolder)
      explicitProposalPaths.add(normKey(checked))
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const states = await readProposalStates()
  const proposals: MergeConsultProposal[] = []
  const explicitTargetRels = new Set<string>()
  const files = existsSync(proposalsFolder)
    ? (await readdir(proposalsFolder)).filter((f) => f.toLowerCase().endsWith('.md'))
    : []

  for (const f of files.sort()) {
    const filePath = join(proposalsFolder, f)
    let raw: string
    try {
      raw = await readFile(filePath, 'utf-8')
    } catch {
      continue
    }
    const parsed = parseProposalMdFromRaw(raw, filePath)
    if (parsed.notAProposal) continue
    const rel = proposalTargetToRel(parsed.target, env.targetDir)
    if (rel === null) continue
    const isExplicit = explicitProposalPaths.has(normKey(filePath))
    const state = states[parsed.requestId] ?? 'candidate'
    if (!isExplicit && (state === 'adopted' || state === 'rejected')) continue
    if (isExplicit) explicitTargetRels.add(rel)
    proposals.push({
      filePath,
      requestId: parsed.requestId,
      title: parsed.title,
      adoptionLabel: parsed.adoptionLabel,
      state,
      rel,
      targetRaw: parsed.target
    })
  }

  const goldenFileRels = new Set([
    ...env.goldenFiles.keys(),
    ...[...env.goldenFiles.keys()].map((k) => k.replace(/\\/g, '/'))
  ])
  const pendingRels = new Set(pendingByPath.keys())

  const valid = validateMergeConsultTargets({
    proposalsFolder,
    proposalPaths: input.proposalPaths,
    requestedPaths: input.paths,
    availableProposals: proposals.map((p) => ({ filePath: p.filePath, targetRel: p.rel })),
    goldenFileRels,
    pendingRels
  })
  if (!valid.ok) return { ok: false, error: valid.error }
  const rels = new Set(valid.rels)

  const subjects: MergeConsultSubject[] = []
  for (const rel of [...rels].sort()) {
    const pending = pendingByPath.get(rel)
    const sourcePath =
      pending?.sourcePath ??
      env.goldenFiles.get(rel) ??
      env.goldenFiles.get(rel.replace(/\//g, '\\'))
    if (!sourcePath) return { ok: false, error: `not a golden-distributed file: ${rel}` }
    const destPath = pending?.destPath ?? join(env.targetDir, rel)
    const goldenNewHash = await hashFileAt(sourcePath)
    if (goldenNewHash === null) return { ok: false, error: `source unreadable: ${rel}` }
    const deployedHash = await hashFileAt(destPath)
    const entry = oldByPath.get(rel) ?? null
    const owner = entry?.owner ?? 'golden'
    const goldenOldHash = entry?.goldenHash ?? null
    const ov = overlayByPath.get(rel)
    const ovPath = ov ? overlayFilePath(env.parcFermeDir, rel) : null
    subjects.push({
      rel,
      destPath,
      sourcePath,
      siblingSources: await listSiblingLanguageSources(sourcePath),
      goldenOldHash,
      goldenNewHash,
      deployedHash,
      owner,
      case: pending?.case ?? (deployedHash === goldenNewHash ? 'unchanged' : 'conflict'),
      impact: deriveImpact({ goldenOldHash, goldenNewHash, deployedHash }),
      overlay: ov
        ? {
            path: ovPath!,
            promotedAt: ov.promotedAt,
            contentHash: ov.contentHash,
            baseGoldenHash: ov.baseGoldenHash,
            stale: ov.baseGoldenHash !== goldenNewHash,
            isBaseSnapshot: ov.contentHash === goldenOldHash
          }
        : null,
      backups: await listBackupsBeside(destPath)
    })
  }

  const goldenDir = getGoldenDir()
  const isRepo = input.isRepo !== undefined ? input.isRepo : !app.isPackaged

  const packet = buildMergeConsultPacket({
    generatedAt: new Date().toISOString(),
    language: (cfg.language as 'ja' | 'en') === 'en' ? 'en' : 'ja',
    goldenSource: {
      kind: isRepo ? 'repository' : 'bundled',
      dir: goldenDir
    },
    targetDir: env.targetDir,
    parcFermeDir: env.parcFermeDir,
    templateName: decision.templateName,
    subjects,
    proposals
  })

  return {
    ok: true,
    packet,
    subjects: subjects.map((s) => s.rel),
    proposals: proposals.filter((p) => rels.has(p.rel)).length
  }
}
