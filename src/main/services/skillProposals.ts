/**
 * skillProposals — Skill 化候補（提案 MD）の一覧・パース・状態管理（Part B Phase 1 / 構想3 = 候補ブラウザ）。
 *
 * 役割:
 * - skill-proposal-emitter が `_SkillProposals/<ts>_<id>.md` に出した提案 MD を読み、
 *   候補ブラウザ用にパース（サマリ/評価軸/採用ラベル/レビューボックス）。
 * - 提案の状態（候補/採用済/却下/保留）を CCPIT 側ストア `~/.ccpit/proposal-states.json` で管理
 *   （提案 MD 自体は書き換えない）。
 * - レビュアー（codex 等の第二レビュアー）の findings を CCPIT 側ストア `~/.ccpit/proposal-reviews.json` で管理
 *   （同じく提案 MD を書き換えず、list 時に requestId で MD §5（pending）へマージ上書きして表示）。
 * - 既出/採用済み可視化: 採用レジストリ（skillProvenance）と突合し、target skill が既に採用済みか
 *   （= 重複防止の本筋、CCPIT 側）を判定。
 *
 * 採用 apply 自体は既存 settings:applyChange（kind:skill）経路を再利用する（本モジュールは apply しない）。
 * パーサは ja/en 両 emitter 出力に対応（section 番号 + 言語非依存のフィールドキーで抽出）。
 * 本モジュールは Electron Main プロセスのサービス（AI 体制非依存）。
 */

import { readFile, writeFile, mkdir, readdir, rename, copyFile } from 'fs/promises'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import { join, basename, dirname, isAbsolute, resolve, relative } from 'path'
import { homedir } from 'os'
import { proposalTargetToRel } from './proposalTargetUtils'
import { atomicJsonUpdate, withFileLock } from './composeFileLock'
import { getComposePaths, readMergeLedger } from './composeLedger'
import { normalizeRelPath } from './goldenManifest'
import { readAdoptedRegistry, getDefaultProvenancePaths, type ProvenancePaths } from './skillProvenance'
import { evaluateCommentAdoptionGate, type CommentAdoptionGateResult } from './commentGate'
import {
  defaultCommentStorePaths,
  listComments,
  quarantineFileMatches,
  readCommentStore,
  snapshotMatches
} from './commentStore'

/**
 * golden 同名提案と golden の関係。
 * - none: golden と同名衝突していない
 * - applied: 提案の全ファイルが golden に入っている（反映済み）
 * - unapplied: 提案の中身はまだ golden に無く、base が今の golden と一致する（未反映）
 * - stale: 提案の base が今の golden と違う、または base を確かめられない（提案が古い）
 */
export type GoldenCollisionStatus = 'none' | 'applied' | 'unapplied' | 'stale'

export type ProposalState = 'candidate' | 'adopted' | 'rejected' | 'held'
const VALID_PROPOSAL_STATES: ProposalState[] = ['candidate', 'adopted', 'rejected', 'held']

export interface ProposalAxisScore {
  /** 軸名（emitter の言語に依存。例: 再現性 / Reproducibility） */
  axis: string
  /** 0-5 スコア。数値化できなければ null */
  score: number | null
  /** 根拠 */
  rationale: string
}

export interface ProposalReviewBox {
  verdict: string
  findings: string
  reviewerId: string
  ccRebuttal: string
}

/** 提案で運ばれるファイル（SKILL.md および付随ファイル）。 */
export interface ProposalFile {
  /** 言語の接頭辞（`en:`）を除いた、スキルのフォルダからの相対パス */
  relPath: string
  content: string
  hash: string
  status: 'add' | 'modify'
  /** 運ぶ先の言語。見出しが `en:<相対パス>` のとき 'en'。省略は 'ja'（従来どおり） */
  lang?: 'ja' | 'en'
}

/** 提案の見出しで、golden の en 側へ運ぶファイルを示す予約接頭辞（`:` は Windows のファイル名に使えない） */
export const PROPOSAL_EN_PREFIX = 'en:'

/** パース済み提案（状態・可視化フラグ込み）。 */
export interface ProposalSummary {
  filePath: string
  requestId: string
  /** ~/.claude/skills/<name>/SKILL.md（提案 frontmatter の target） */
  target: string
  /** 提案で運ばれる全ファイル（SKILL.md + 付随ファイル） */
  files?: ProposalFile[]
  /** target から導出した skill 名 */
  skillName: string
  /** 生成時の出自プロジェクト（cwd 絶対パス）。欠落時は ''（後方互換フェイルセーフ） */
  sourceProject: string
  /** 提案日（frontmatter created_at。ISO 8601 想定）。欠落時は ''。一覧の認知負荷低減に使う */
  createdAt: string
  adoptionLabel: string // 'recommend' | 'reject' | その他
  title: string
  what: string
  why: string
  how: string
  axes: ProposalAxisScore[]
  reviewBox: ProposalReviewBox
  /** パース不能・必須欠落時のエラー（一覧では警告表示。null=正常） */
  parseError: string | null
  /**
   * **そもそも skill 提案ではないファイル**（裁定メモ・引き継ぎメモ・「該当なし」記録等）。
   * 「壊れた提案」とは別物で、直す対象でもないので UI は対象外として畳む。
   */
  notAProposal: boolean
  // --- 状態・可視化（list 時に付与） ---
  state: ProposalState
  /** target skill 名が採用レジストリに存在（既に採用済み） */
  alreadyAdopted: boolean
  /** golden 配布 skill と同名衝突（採用時に golden-name-collision となる対象。CCPIT_064 / AC9） */
  goldenCollision: boolean
  /**
   * golden 同名衝突時、**提案の中身が golden に入っているか**（反映済み。`goldenCollisionStatus === 'applied'` と同値）。
   * 旧版（CCPIT_066）は「手元の SKILL.md と golden が同じか」だけを見ていて、未反映の提案でも true になった。
   */
  goldenCollisionResolved: boolean
  /** golden 同名衝突時の提案と golden の関係（衝突していなければ 'none'）。次に押すボタンがこれで決まる */
  goldenCollisionStatus: GoldenCollisionStatus
  /** 提案 frontmatter の base_hash（起草時の SKILL.md の sha256）。無ければ未設定 */
  baseHash?: string
  /** 提案 frontmatter の companion_base_hashes（`相対パス=sha256;…`）。無ければ未設定 */
  companionBaseHashes?: string
  /** 採用前に独立レビューが必須（未レビューの recommend）。UI 採用ゲートが break-glass 付きで参照 */
  needsReview: boolean
  /** 採用ゲートの状態可視化（B-2）。表示と実判定の二重実装を作らないため main 側で算出して渡す */
  gate: ProposalGateView
  /** 刈り取り状況（棄却 / 据え置きの内訳）。UI が件数と理由を出すために使う */
  harvest: HarvestResult
  /**
   * finding 単位の裁定（理由の全文込み）。**ユーザーが妥当性を判断するための材料**であり、
   * 機械が CC の主張の正しさを判定することはできない以上、全文をそのまま見せる。
   */
  adjudications: ProposalAdjudication[]
  /**
   * ack を送り返すときの束縛値。UI は**画面に出ていた内容**の 3 値をそのまま返し、
   * 採用ゲートが採用時点で再計算して照合する。一覧取得〜採用の間に提案や裁定が
   * 変わっていれば不一致で拒否される（list→adopt の TOCTOU 対策）。
   */
  ackBinding: FindingsAckBinding
}

/**
 * 採用ゲートの状態（B-2 可視化用）。**純粋な導出値**であり副作用を持たない
 * （ack 検証と監査 append の副作用は採用チョークポイント側の責務）。
 */
export interface ProposalGateView {
  /**
   * 採用ゲートを**実際に解除できる** approve か（verdict=approve かつ content hash 一致）。
   * 承認後に提案本文が書き換わった stale approve はここが false になる。
   */
  hasValidApprove: boolean
  /** 状態キー（UI がバッジ文言へ写像する） */
  state:
    | 'unreviewed'
    | 'reviewed-unapproved'
    | 'stale-approve'
    | 'approved'
    | 'downgraded'
    | 'terminal'
    | 'not-gated'
  /** 採用ボタンを押せない理由（null = ゲート上は押せる） */
  adoptBlockReason: string | null
  /** 採用時に findings 承知の明示確認が要るか（recommend-with-findings） */
  findingsAckRequired: boolean
  /**
   * **この画面では判定できず、採用操作時に初めて検査される項目**。
   *
   * `describeProposalGate` は純粋関数で**ファイル内容もフォルダも見ない**ため、
   * ここに挙げた検査は採用チョークポイント（`evaluateAdoptGateFromRaw`）でしか行えない。
   * 「ゲート上は可」とだけ表示すると**何を保留しているのか読み手に伝わらない**ので、
   * 保留している検査そのものを渡して画面に印字させる（maintainer指摘 2026-08-07）。
   */
  adoptTimeChecks: string[]
  /**
   * 「レビュー」ボタンを表示するか。**`hasValidApprove` の否定**。
   * stale approve でも表示する — 採用は拒否されるのに再レビュー導線まで消えると回復不能になるため。
   */
  reviewButtonVisible: boolean
}

/**
 * ゲート状態を導出する（純粋関数）。採用ゲート本体と**同じ `needsReviewBeforeAdopt` / hash 比較**を使い、
 * 表示と実判定が食い違わないようにする。
 */
/**
 * この画面では判定できず、**採用操作時に初めて検査される**項目を列挙する。
 *
 * 一覧が出しているのはあくまで**取得時点のスナップショット**であり、
 * `evaluateAdoptGateFromRaw` は採用の瞬間にファイルとフォルダを読み直して再判定する。
 * その差分を隠すと「ゲート上は可」が何を保留した言い方なのか読み手に伝わらない。
 */
function adoptTimeChecksFor(adoptionLabel: string, findingsAckRequired: boolean): string[] {
  const gated = adoptionLabel === 'recommend' || adoptionLabel === FINDINGS_ACK_LABEL
  if (!gated) return []
  const checks = [
    '提案本文が一覧取得時から変わっていないこと（content hash の再照合）',
    '同じフォルダに request_id が重複していないこと（重複時は break-glass でも採用不可）'
  ]
  if (adoptionLabel === FINDINGS_ACK_LABEL) {
    checks.push('降格記録の整合（降格元・降格後の hash 鎖と、本文が改変されていないこと）')
  }
  if (findingsAckRequired) {
    checks.push('承知した内容が現在の指摘・裁定と一致すること（古い ack は拒否される）')
  }
  return checks
}

export function describeProposalGate(
  adoptionLabel: string,
  harvest: HarvestResult,
  hasStoredReview: boolean,
  state: ProposalState
): ProposalGateView {
  const findingsAckRequired = needsFindingsAckBeforeAdopt(adoptionLabel, harvest)
  // 「完全にきれいな状態」＝ 刈り取り済みで据え置きも無い。ここでだけレビュー導線を畳む。
  // 据え置きが残る間はボタンを残す — CC が直して再レビューへ進む経路（ループ）を塞がないため。
  const fullyClean = harvest.ok && harvest.deferred.length === 0
  const base = {
    hasValidApprove: harvest.ok,
    reviewButtonVisible: !fullyClean,
    adoptTimeChecks: adoptTimeChecksFor(adoptionLabel, findingsAckRequired)
  }
  if (state === 'adopted' || state === 'rejected') {
    return {
      ...base,
      state: 'terminal',
      adoptBlockReason: 'この提案は既に確定（採用済み／却下済み）です',
      findingsAckRequired
    }
  }
  if (adoptionLabel === FINDINGS_ACK_LABEL) {
    return {
      ...base,
      state: 'downgraded',
      // オーナー裁定 2026-08-07: **未裁定のまま承知で採用する経路は廃止した**。
      // 何が問題か誰も判定していない状態を「承知」しようがないため、責任譲渡が成立しない。
      // 出口は「方針を添えて差し戻す」か「却下する」の 2 つ。採用したければ先に刈り取る。
      adoptBlockReason: harvest.ok
        ? null
        : '指摘がまだ裁定されていません。方針を添えて差し戻すか、却下してください（採用するには先に刈り取りを完了させます）',
      findingsAckRequired
    }
  }
  if (adoptionLabel !== 'recommend') {
    // reject 等はレビューゲートの対象外（採用ゲートも強制しない）
    return { ...base, state: 'not-gated', adoptBlockReason: null, findingsAckRequired: false }
  }
  if (!hasStoredReview) {
    return {
      hasValidApprove: false,
      state: 'unreviewed',
      adoptBlockReason: '独立レビューが未実施です',
      findingsAckRequired: false,
      reviewButtonVisible: true,
      adoptTimeChecks: base.adoptTimeChecks
    }
  }
  if (harvest.ok) {
    return {
      ...base,
      state: 'approved',
      // 据え置きがあるときは「押せない理由」ではなく「ack が要る」ことを伝える（採用自体は可能）。
      adoptBlockReason: findingsAckRequired
        ? `妥当と認めたうえで未修正の指摘が ${harvest.deferred.length} 件あります。承知のうえで採用してください`
        : null,
      findingsAckRequired
    }
  }
  return {
    hasValidApprove: false,
    // stale は「再レビューすれば戻る」状態で、未裁定とは回復手順が違うので UI へ区別を渡す
    state: harvest.code === 'stale-content' ? 'stale-approve' : 'reviewed-unapproved',
    adoptBlockReason: harvest.reason ?? '指摘の刈り取りが完了していません',
    findingsAckRequired: false,
    adoptTimeChecks: base.adoptTimeChecks,
    reviewButtonVisible: true
  }
}

export interface ProposalStorePaths {
  /** ~/.ccpit/proposal-states.json */
  statesPath: string
  /** ~/.ccpit/proposal-reviews.json（レビュアー（codex 等）の findings を保持。提案 MD は書き換えない） */
  reviewsPath: string
  /**
   * ~/.ccpit/adopt-overrides.json（break-glass 監査ログ。Codex 最終レビュー finding#1）。
   * 採用ゲートを override で強行した事実（誰の何を・どの content hash で・何のブロックを）を append する。
   * 名前衝突 override の**事前許可**ストア emergency-overrides.json（skillProvenance）とは役割が異なる
   * （こちらは事後監査記録）ため、スキーマ汚染を避けて別ファイルにする。
   */
  overridesAuditPath?: string
  /**
   * ~/.ccpit/adopt-findings-ack.json（findings 承知採用の監査ログ）。
   * `recommend-with-findings`（三択(c) の降格）を人間が findings を見たうえで採用した事実を append する。
   * break-glass の adopt-overrides.json とは**別経路・別ストア**（発注 §A-1(c)「break-glass とは別経路」）。
   * break-glass は「ゲートを強行した」記録、こちらは「提示された findings を承知して採用した」記録。
   */
  findingsAckAuditPath?: string
}

export function getDefaultProposalStorePaths(): ProposalStorePaths {
  return {
    statesPath: join(homedir(), '.ccpit', 'proposal-states.json'),
    reviewsPath: join(homedir(), '.ccpit', 'proposal-reviews.json'),
    overridesAuditPath: join(homedir(), '.ccpit', 'adopt-overrides.json'),
    findingsAckAuditPath: join(homedir(), '.ccpit', 'adopt-findings-ack.json')
  }
}

/**
 * findings 承知採用の監査エントリ。**findings の本文ではなく sha256 を採る**のは、
 * 「どの findings を人間が承知したか」を第三者が後から同定できるようにするため
 * （件数だけでは、後で findings が差し替わった場合に同定できない）。
 */
export interface FindingsAckAuditEntry {
  requestId: string
  filePath: string
  /** 採用時点の proposal content hash */
  proposalHash: string
  adoptionLabel: string
  /** 採用時点の外部レビューストア verdict */
  storedVerdict: string
  /** 承知した findings の sha256 */
  findingsHash: string
  /** 承知した findings の文字数（可読な補助情報） */
  findingsChars: number
  /**
   * 承知した findings 本文の**全文スナップショット**（レビュー r8#1）。
   * 台帳が後から書き換わりうる前提を認めている以上、hash と裁定理由だけでは
   * 「どの指摘を承知したか」を第三者が復元できない（裁定理由は指摘そのものではない）。
   */
  findingsSnapshot: string
  /** 承知時点で裁定が対象としていた findings 本文の sha256（台帳の `adjudicationsFor`） */
  adjudicationsFor: string
  /** 承知時点の全裁定の sha256（ack 束縛に使った鍵と同値） */
  adjudicationsKey: string
  /**
   * 承知時点の**全裁定の全文スナップショット**（レビュー r5#1）。
   * 台帳側の理由は後から書き換えられるので、hash だけでは「何に同意したか」を復元できない。
   * 監査は append-only なので、ここに焼いた時点の文面が第三者にとっての正本になる。
   *
   * 据え置き分だけでなく**棄却分も含める** — ack は「この提案を採用する」ことへの責任譲渡であり、
   * ユーザーは棄却理由も読んだうえで押しているため、その文面を固定しないと全体を再構成できない。
   */
  adjudications: Array<{ id: string; decision: string; reason: string }>
  /** 承知時点で「妥当だが未修正」だった指摘の id（可読な補助情報） */
  deferredIds: string[]
  /**
   * どの種類の責任譲渡だったか（レビュー r9#2）。
   * `deferred-in-recommend` = 推奨のまま据え置き指摘を承知した / `downgraded` = 指摘つきラベルの承知採用。
   */
  ackKind: 'deferred-in-recommend' | 'downgraded'
  /**
   * 同意文の**版**。UI 文言が変わっても「どの版の同意操作だったか」を後から特定できるようにする。
   * 正本は main 側の定数であり、renderer が申告する `ackLabelShown` より信頼できる。
   */
  ackTextVersion: string
  /**
   * main 側が `ackKind` と据え置き件数から再生成した**期待文言（正本）**（レビュー r12#1）。
   * renderer 由来の `ackLabelShown` は検証できないので、監査の正本はこちらを使う。
   */
  ackLabelExpected: string
  /** UI が実際に表示した同意文（**UI 申告値**。実際の表示を残すための補助） */
  ackLabelShown: string
  /** 承知操作の時刻（＝ ack を受理した時刻） */
  acknowledgedAt: string
  source: 'skillProposals:findings-ack'
}

/**
 * 同意文の版（レビュー r9#2）。UI の文言を変えたらこの版も上げること。
 * 監査は「どの版の同意操作だったか」でしか後から文言を確定できないため、版と文言は必ず対で動かす。
 */
export const ACK_TEXT_VERSION = 'ack-v1-2026-08-06'

/**
 * 監査の正本となる同意文を main 側で再生成する（レビュー r12#1）。
 *
 * renderer から届く `ackLabelShown` は検証できない（UI バグや分岐で意図と違う文言を送りうる）ので、
 * **監査の正本は main が `ackKind` と据え置き件数から組んだこの文字列**にする。
 *
 * **不一致で採用を拒否する案は採らない**。UI は ja/en 二言語で、表示文言は言語によって正当に変わる。
 * 一致を要求すると ack の可否が表示言語に依存してしまい、機能の正しさと無関係な理由で採用が壊れる。
 * したがって「正本（期待文言）と実表示（UI 申告）の両方を残す」形にし、突合は監査を読む人間に委ねる。
 */
export function ackKindOf(adoptionLabel: string): 'deferred-in-recommend' | 'downgraded' {
  return adoptionLabel === FINDINGS_ACK_LABEL ? 'downgraded' : 'deferred-in-recommend'
}

export function expectedAckLabel(kind: 'deferred-in-recommend' | 'downgraded', deferredCount: number): string {
  return kind === 'deferred-in-recommend'
    ? `承認(approve)されていないが承知の上で採用する（妥当と認めたうえで未修正の指摘 ${deferredCount} 件）`
    : '上記 findings を確認した（承知のうえ採用する）'
}

/** break-glass 監査エントリ（adopt-overrides.json の要素） */
export interface AdoptOverrideAuditEntry {
  requestId: string
  filePath: string
  /** 強行時点の proposal content hash（何が採用されたかの同一性） */
  proposalHash: string
  adoptionLabel: string
  /** 強行時点の外部レビューストア verdict（空=未記録） */
  storedVerdict: string
  /** 強行で免除したブロック理由 */
  overriddenBlocks: ('review-required-unapproved' | 'duplicate-scan-incomplete')[]
  overriddenAt: string
  source: 'skillProposals:adopt-gate'
}

/**
 * 提案プールの既定フォルダ（集約先）。`~/.ccpit/proposals/`。
 * emitter の出力先と一致させ、候補ブラウザの起動時デフォルトに使う（横断採用のため cwd 非依存）。
 */
export function getDefaultProposalsFolder(): string {
  return join(homedir(), '.ccpit', 'proposals')
}

// --- frontmatter / section helpers（flat key:value、言語非依存） ---

function parseFlatFrontmatter(md: string): { data: Record<string, string>; body: string } | null {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!m) return null
  const data: Record<string, string> = {}
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

/**
 * フェンスで囲んだコードブロック（CommonMark: 行頭の空白 0〜3 個＋同じ文字 3 個以上の ``` か ~~~。
 * 閉じは同じ文字で開きと同じ数以上・後ろは空白だけ。閉じが無ければ文書の終わりまで）の中身と、
 * フェンスの行そのものを、同じ長さの空白に置き換えた文字列を返す。改行（\r・\n）は残すので、
 * 返した文字列で見つけた位置は、元の文字列の同じ位置を指す。
 *
 * 見出しを探す正規表現は、この文字列に当てる。コードブロックの中の `## 5.` や `###` は見出しではない。
 * 提案の「## 3.」には SKILL.md の全文（自分の見出しを持つ）が入り、skill-proposal-emitter のように
 * 提案の書式の見本（「## 5. レビューボックス」など）を本文に持つスキルもある。
 * 2026-09-28: 069 追補 01 の `###` の判定がコードブロックの中も数え、手元の Skill 提案 497 件中 175 件が
 * 読めなくなっていた（069 追補 01 の前は読めていた）ため、見出しの検索をこの関数に通すよう直した。
 */
export function maskFencedCodeBlocks(text: string): string {
  const lines = text.split('\n')
  let fence: FenceOpen | null = null
  const out: string[] = []
  for (const line of lines) {
    const cr = line.endsWith('\r') ? '\r' : ''
    const content = cr ? line.slice(0, -1) : line
    const blank = ' '.repeat(content.length) + cr
    if (!fence) {
      fence = matchFenceOpen(content)
      out.push(fence ? blank : line)
      continue
    }
    out.push(blank)
    if (isFenceClose(content, fence)) fence = null
  }
  return out.join('\n')
}

/** フェンスの開きの行（行末の \r を除いた 1 行）の読み取り結果。 */
interface FenceOpen {
  char: string
  len: number
  /** 開きの行頭の空白の個数（CommonMark: 0〜3）。069 発注 1: 「## 3.」の中身取り出しの字下げ除去に使う */
  indent: number
  /** 情報文字列（```markdown の markdown）。前後の空白を除く */
  info: string
}

/** 1 行がフェンスの開きなら、その文字・長さ・字下げ・情報文字列を返す（CommonMark。maskFencedCodeBlocks の規則）。 */
function matchFenceOpen(content: string): FenceOpen | null {
  const open = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(content)
  if (!open) return null
  // バッククォートのフェンスの情報文字列にはバッククォートを含めない（CommonMark）
  if (open[2][0] === '`' && open[3].includes('`')) return null
  return { char: open[2][0], len: open[2].length, indent: open[1].length, info: open[3].trim() }
}

/** 1 行が、開き `fence` に対応する閉じか（同じ文字で開きと同じ数以上・後ろは空白だけ）。 */
function isFenceClose(content: string, fence: FenceOpen): boolean {
  const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(content)
  return !!close && close[1][0] === fence.char && close[1].length >= fence.len
}

/** extractFencedCodeBlocks が返すコードブロック 1 つ。 */
export interface FencedCodeBlock {
  /** 情報文字列（前後の空白を除く） */
  info: string
  /** 中身。開きと閉じの間の行を元の文字列のまま（\r も残す）。中身の行があれば最後に \n を付ける */
  content: string
  /** 開きの行の番号（0 始まり・\n で数える） */
  openLine: number
  /** 閉じの行の番号。閉じが無い（文書の終わりまで続く）なら null */
  closeLine: number | null
}

/**
 * フェンスで囲んだコードブロックを、文書の頭から順に返す。規則は maskFencedCodeBlocks と同じ
 * （行頭の空白 0〜3 個・同じ文字 3 個以上・閉じは開きと同じ数以上）。コードブロックの外の見出しを
 * 同時に見たいときは、maskFencedCodeBlocks の結果の同じ行番号を見る。
 */
export function extractFencedCodeBlocks(text: string): FencedCodeBlock[] {
  const joinInner = (inner: string[]): string => (inner.length ? inner.join('\n') + '\n' : '')
  const lines = text.split('\n')
  const blocks: FencedCodeBlock[] = []
  let fence: FenceOpen | null = null
  let openLine = 0
  let inner: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const content = line.endsWith('\r') ? line.slice(0, -1) : line
    if (!fence) {
      fence = matchFenceOpen(content)
      if (fence) {
        openLine = i
        inner = []
      }
      continue
    }
    if (isFenceClose(content, fence)) {
      blocks.push({ info: fence.info, content: joinInner(inner), openLine, closeLine: i })
      fence = null
      continue
    }
    inner.push(line)
  }
  if (fence) {
    blocks.push({ info: fence.info, content: joinInner(inner), openLine, closeLine: null })
  }
  return blocks
}

/** readSection3FencedBlock が返すブロック 1 つ。 */
interface Section3FencedBlock {
  info: string
  /** 開き〜閉じの中身。「## 3.」の今の契約どおり、閉じ直前の改行は含めない（空なら空文字列） */
  content: string
  /** 閉じが見つかったか（false = 文書の終わりまで開いたまま。呼び出し側は今の「閉じフェンスが無い」エラーにする） */
  closed: boolean
  /** 渡した text の先頭からの相対消費文字数。次の探索位置は headingEnd + consumedLength だけで決まる */
  consumedLength: number
}

/**
 * 「## 3.」の中身（SKILL.md 本体・付随ファイル）専用のフェンス読み取り。境界判定（開き・閉じ）は
 * matchFenceOpen/isFenceClose に一本化しつつ、中身の組み立ては今の契約（閉じ直前の改行を含めない・
 * 開きの字下げ分を各行から取り除く）を保つ。069 発注 1: 旧実装は「行頭空白なしの ``` のみ・閉じは
 * 開きとちょうど同じ長さ」でしか読めなかった。maskFencedCodeBlocks/extractFencedCodeBlocks 自体は
 * 変更しない（中身の末尾に \n を足す・字下げを保持する、という別の契約を持つ既存の呼び出し元
 * migration.ts・settingsChange.ts・goldenPromotion.ts に影響を出さないため）。
 *
 * `anchored=true`（複数ファイルの見出し「### <path>」の直後）は、空白・タブのみの行を内部で
 * 読み飛ばしてから最初の非空行を開きとして判定する（見出し直後は空行のみ許容、の従来契約を
 * ヘルパー自身が保つ）。非空行が開きでなければ `null`。
 * `anchored=false`（単一ファイルの書き方）は、開きが見つかるまで行を読み飛ばす（従来と同じ緩さ）。
 *
 * 開きを認識した行は、その場で次の行へ進み、同じ行を閉じ判定にはかけない
 * （`matchFenceOpen('\`\`\`')` と `isFenceClose('\`\`\`', fence)` は同じ入力で両方真になりうるため、
 * 1 行だけの開き兼閉じ風のフェンスを空内容と誤認しないよう明示する。069 発注 1 の Codex 計画レビュー
 * 指摘 [2]）。
 */
function readSection3FencedBlock(text: string, anchored: boolean): Section3FencedBlock | null {
  const lines = text.split('\n')
  const lineWithoutCr = (raw: string): string => (raw.endsWith('\r') ? raw.slice(0, -1) : raw)
  let fence: FenceOpen | null = null
  const inner: string[] = []
  let i = 0
  if (anchored) {
    while (i < lines.length && /^[ \t]*$/.test(lineWithoutCr(lines[i]))) i++
    if (i >= lines.length) return null
    fence = matchFenceOpen(lineWithoutCr(lines[i]))
    if (!fence) return null
    i++
  }
  for (; i < lines.length; i++) {
    const content = lineWithoutCr(lines[i])
    if (!fence) {
      fence = matchFenceOpen(content)
      continue
    }
    if (isFenceClose(content, fence)) {
      const consumedLength =
        lines.slice(0, i + 1).join('\n').length + (i + 1 < lines.length ? 1 : 0)
      return { info: fence.info, content: inner.join('\n'), closed: true, consumedLength }
    }
    const stripped = lines[i].replace(new RegExp(`^ {0,${fence.indent}}`), '')
    inner.push(stripped)
  }
  if (!fence) return null
  return { info: fence.info, content: inner.join('\n'), closed: false, consumedLength: text.length }
}

/**
 * "## N." 見出し以降、次の "## M." 見出し（または末尾）までの本文を返す。無ければ null。
 * 見出しはコードブロックの外にあるものだけを数える（maskFencedCodeBlocks）。返す本文は元の文字列のまま。
 */
function sliceSection(body: string, n: number): string | null {
  const re = new RegExp(`(?:^|\\n)##\\s*${n}\\.[^\\n]*\\r?\\n([\\s\\S]*?)(?=\\n##\\s*\\d+\\.|$)`)
  const m = re.exec(maskFencedCodeBlocks(body))
  if (!m) return null
  const start = m.index + m[0].length - m[1].length
  return body.slice(start, start + m[1].length)
}

/** "- key: value" 形式のリスト項目を {key→value} で返す（key は trim、大小区別なし参照用に lower も）。 */
function parseListKv(section: string): { raw: { key: string; value: string }[] } {
  const raw: { key: string; value: string }[] = []
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s*([^:：]+)[:：]\s*(.*)$/)
    if (m) raw.push({ key: m[1].trim(), value: m[2].trim() })
  }
  return { raw }
}

function findValue(
  items: { key: string; value: string }[],
  ...keys: string[]
): string {
  const lowered = keys.map((k) => k.toLowerCase())
  for (const it of items) {
    if (lowered.includes(it.key.toLowerCase())) return it.value
  }
  return ''
}

/**
 * "4 — 根拠" / "4 - 根拠" / "4" / **"\*\*4\*\*（注釈）— 根拠"** から {score, rationale} を分離。
 *
 * 太字の `**4**` を受け付けるのは、実データで**スコアを強調表示している提案が実在する**ため
 * （2026-08-06 実測: 4 行）。書き手にとっては自然な Markdown であり、
 * これを弾いて「スコアが空欄」と報告するのはパーサ側の誤りだった。
 */
function parseAxisValue(value: string): { score: number | null; rationale: string } {
  // 数値直後の閉じ強調記号（5** / 5__ 等）のみを消費し、空白後に続く理由文の強調記号（例: 5 **根拠**）を誤消費しない
  const m = value.match(/^\s*[*_]{0,2}\s*(\d+)([*_]{0,2})\s*(?:[—\-–]\s*)?(.*)$/)
  if (!m) return { score: null, rationale: value.trim() }
  return { score: Number(m[1]), rationale: m[3].trim() }
}

/**
 * 評価軸キーの表記ゆれ（前後の太字マーカー、内部空白）を除去して正規化する。
 * - 前後の Markdown 強調記号（*, _）と空白を除去
 * - 内部の全空白文字（半角スペース、全角スペース \u3000、タブ等）を除去
 * - 小文字化
 */
export function normalizeAxisKey(key: string): string {
  return key
    .replace(/^[\s*_]+|[\s*_]+$/g, '')
    .replace(/\s+/gu, '')
    .toLowerCase()
}

/**
 * 評価軸の正規名（emitter SKILL.md §2 が定める固定 5 軸。ja / en）。
 *
 * **§2 の箇条書きすべてを軸とみなしてはならない**。実データ（215 提案）で実測すると、
 * 5 軸はそれぞれ 201 回ずつ現れる一方、それ以外のキーは**すべて出現 1 回**の注釈行だった
 * （既存 skill との境界説明・証拠の限界・子箇条書き等）。
 * 旧実装はこれらを軸と誤認し「スコアが空欄」と報告していた（実測 8 件が偽の解析エラー）。
 */
const CANONICAL_AXIS_NAMES = [
  // 日本語 5 軸
  '再現性',
  '汎用性',
  'Context節約効果',
  '既存Skill重複・統一可能性',
  '本質的UX向上への寄与',
  // 英語 5 軸
  'Reproducibility',
  'Generality',
  'ContextSaving',
  'OverlapWithExisting',
  'EssentialUXGain'
] as const

export const CANONICAL_AXIS_MAP: ReadonlyMap<string, string> = new Map(
  CANONICAL_AXIS_NAMES.map((name) => [normalizeAxisKey(name), name])
)

/** そのキーが評価軸か（正規化後の完全一致ホワイトリスト判定。注釈行を軸と誤認しないための唯一の判定）。 */
export function isCanonicalAxis(key: string): boolean {
  return CANONICAL_AXIS_MAP.has(normalizeAxisKey(key))
}

/** キーから正準スペルを取得する（非軸なら null）。 */
export function getCanonicalAxisName(key: string): string | null {
  return CANONICAL_AXIS_MAP.get(normalizeAxisKey(key)) ?? null
}

// 評価軸スコアの許容範囲（emitter SKILL.md §2「各軸 0〜5」由来。マジックナンバー禁止のため定数化）。
const AXIS_SCORE_MIN = 0
const AXIS_SCORE_MAX = 5

/**
 * 根拠が定型句（emitter テンプレの `<FILL: 根拠>` / `<FILL: 0-5>` 等の未記入プレースホルダ）か。
 * `FILL` トークン、または `<...>` 形の山括弧プレースホルダを定型句とみなす。
 */
function isPlaceholder(rationale: string): boolean {
  const v = rationale.trim()
  return /FILL/i.test(v) || /^<.*>$/.test(v)
}

/**
 * A2 評価軸ゲート（FSA §5-a）: 空欄（score===null）・範囲外・定型句の評価軸を弾く。
 * emitter SKILL.md:58「空欄・定型句は CCPIT の品質ゲートで弾かれる」契約の CCPIT 側実装。
 * 弾く提案は捨てず parseError として返し、候補ブラウザで理由表示する（呼び出し側）。
 * 戻り値: 問題なければ null、問題があれば理由文字列。
 */
function validateAxes(axes: ProposalAxisScore[]): string | null {
  if (axes.length === 0) return '評価軸が空です（## 2. 評価軸 が未記入）'
  for (const a of axes) {
    if (a.score === null) return `評価軸 '${a.axis}' のスコアが空欄または非数値です`
    if (a.score < AXIS_SCORE_MIN || a.score > AXIS_SCORE_MAX)
      return `評価軸 '${a.axis}' のスコアが範囲外（${AXIS_SCORE_MIN}-${AXIS_SCORE_MAX}）です`
    if (a.rationale.trim() === '' || isPlaceholder(a.rationale))
      return `評価軸 '${a.axis}' の根拠が空欄または定型句(FILL)です`
  }
  return null
}

function isBakFileName(fileName: string): boolean {
  return (
    /\.(bak(\..*)?|old|orig|tmp|swp)$/i.test(fileName) ||
    /~$/.test(fileName) ||
    /\.bak[._-]/i.test(fileName)
  )
}

function isOsVcsArtifactName(fileName: string): boolean {
  const lower = fileName.toLowerCase()
  return (
    lower === '.ds_store' ||
    lower === 'thumbs.db' ||
    lower === '.git' ||
    lower === 'node_modules'
  )
}

export function decodeUtf8Strict(buffer: Buffer | Uint8Array, filePath?: string): string {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    return decoder.decode(buffer)
  } catch (err) {
    throw new Error(
      `不正な UTF-8 バイト列が検出されました（置換・修復不能）: ${filePath ?? 'unknown'} (${(err as Error).message})`
    )
  }
}

/**
 * 「## 3.」の中（コードブロックの外）に、複数ファイルの書き方の見出し（`### <相対パス>`）があるか。
 * ファイルの節の見出しはパスそのもの。空白を含まず、かつ「`/` か `\` を含む」か「英字を含む拡張子で終わる」
 * 見出しをパスの形とみなす（`SKILL.md`・`scripts/helper.cjs`・`scripts/install`・`./SKILL.md`・`skill.md`）。
 * パスの形の ### 見出しが 1 つでもあれば複数ファイルの書き方とみなし、パスの検査に回す。書き間違い
 * （`### ./SKILL.md`・`### skill.md`、SKILL.md の見出しを書き忘れて付随ファイルだけに見出しを付けた形）も
 * ここで複数ファイルの書き方になり、「必須ファイル SKILL.md」などでエラーになる（1 ファイルとして黙って読み、
 * 付随ファイルを落とすことはしない）。
 * パスの形でない ### は、1 ファイルの書き方の小見出し（`### 3-B. 補足`・`### r2 での変更点`・`### v1.2`・
 * `### 3-B.補足` など）なので数えない。手元の提案では、小見出しの直後にコードブロックを置いた 1 ファイルの
 * 書き方もある（2 件で実測）ので、「直後がコードブロックか」では見分けない。
 * 見分けの上限: 見出しの形による推定なので、書き方どおり（`### SKILL.md` を必ず置く）なら必ず見分けられる。
 * 誤りうるのは、SKILL.md の見出しを書き忘れ、かつ付随ファイルの見出しがどれも空白を含むか、`/` を含まず
 * 拡張子に英字を含まない名前のときだけで、そのときは付随ファイルを落とす（自己検査も同じ判定）。
 * @param masked 「## 3.」の中の maskFencedCodeBlocks の結果
 */
function hasFileSectionHeading(masked: string): boolean {
  const re = /(?:^|\r?\n)###[ \t]+([^\r\n]+)\r?\n/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(masked))) {
    const name = m[1].normalize('NFC').trim()
    if (/\s/.test(name)) continue
    if (/[\\/]/.test(name) || /\.[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*$/.test(name)) return true
  }
  return false
}

export function parseProposedFilesFromSection3(
  body: string,
  filePath?: string
): { files: ProposalFile[]; error: string | null } {
  // 見出しはコードブロックの外にあるものだけを数える（maskFencedCodeBlocks）。
  // コードブロックの中身（SKILL.md の全文など）は、元の文字列から取り出す
  const masked = maskFencedCodeBlocks(body)
  const sec3Match = /(?:^|\n)##\s*3\.[^\n]*\r?\n/.exec(masked)
  if (!sec3Match) {
    return { files: [], error: null }
  }
  const afterSec3Start = sec3Match.index + sec3Match[0].length
  const afterSec3 = body.slice(afterSec3Start)
  const maskedAfterSec3 = masked.slice(afterSec3Start)
  // 複数ファイルの書き方かどうかは、「## 3.」の中（次の「## <数字>.」まで）の ### 見出しで決める（hasFileSectionHeading）
  const sec3EndM = /(?:^|\r?\n)##\s*[0-9]+\./.exec(maskedAfterSec3)
  const sec3Len = sec3EndM ? sec3EndM.index : maskedAfterSec3.length
  const hasSubHeadings = hasFileSectionHeading(maskedAfterSec3.slice(0, sec3Len))

  if (!hasSubHeadings) {
    // 従来型（単一 SKILL.md）
    const block = readSection3FencedBlock(afterSec3, false)
    if (!block) {
      return { files: [], error: 'コードブロックが見つかりません' }
    }
    if (!block.closed) {
      return { files: [], error: '閉じコードフェンスが見つかりません' }
    }
    const content = block.content
    try {
      decodeUtf8Strict(Buffer.from(content, 'utf-8'), filePath)
    } catch (err) {
      return { files: [], error: (err as Error).message }
    }
    const hash = createHash('sha256').update(content, 'utf-8').digest('hex')
    return {
      files: [{ relPath: 'SKILL.md', content, hash, status: 'modify' }],
      error: null
    }
  }

  // 複数ファイル提案（### <相対パス>）
  const files: ProposalFile[] = []
  const seenPathsLower = new Set<string>()
  let pos = 0
  const len = afterSec3.length

  while (pos < len) {
    const headingRe = /(?:^|\r?\n)###[ \t]+([^\r\n]+)\r?\n/gm
    headingRe.lastIndex = pos
    const hMatch = headingRe.exec(maskedAfterSec3)
    if (!hMatch) break

    const intervening = maskedAfterSec3.slice(pos, hMatch.index)
    if (/(?:^|\r?\n)##\s*[0-9]+\./m.test(intervening)) {
      break
    }

    const rawPath = hMatch[1]
    const headingEnd = hMatch.index + hMatch[0].length

    const afterHeading = afterSec3.slice(headingEnd)
    const block = readSection3FencedBlock(afterHeading, true)
    if (!block) {
      return { files: [], error: `見出し '### ${rawPath}' の直後に有効なコードブロックがありません` }
    }
    if (!block.closed) {
      return { files: [], error: `見出し '### ${rawPath}' のコードブロックに対応する閉じフェンスがありません` }
    }

    const content = block.content
    pos = headingEnd + block.consumedLength

    const headingPath = rawPath.normalize('NFC').trim()
    // 予約接頭辞 `en:` は 1 回だけ外し、残りに既存のパス検査をすべて掛ける（`:` を含む通常のファイル名は
    // Windows に存在しないので、接頭辞と通常のパスは衝突しない）
    const isEn = headingPath.startsWith(PROPOSAL_EN_PREFIX)
    const relPath = isEn ? headingPath.slice(PROPOSAL_EN_PREFIX.length).trim() : headingPath
    if (!relPath) {
      return { files: [], error: '空のファイルパスが指定されています' }
    }
    // 接頭辞を外した後に残る `:` は、言語の接頭辞（`en:` のみ）でもドライブでもないパス。従来は黙って通っていた
    if (relPath.includes(':') && !/^[A-Za-z]:/.test(relPath)) {
      return {
        files: [],
        error: `パスに ':' は使えません（言語の接頭辞は 'en:' だけです）: ${headingPath}`
      }
    }

    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(relPath)) {
      return { files: [], error: `ディレクトリトラバーサル (..) は禁止されています: ${relPath}` }
    }
    if (isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath) || /^[\\/]/.test(relPath) || /^\\\\/.test(relPath)) {
      return { files: [], error: `絶対パスやドライブレター、UNCパスは禁止されています: ${relPath}` }
    }
    if (/[. \t]$/.test(relPath)) {
      return { files: [], error: `パス末尾のドットや空白は禁止されています: ${relPath}` }
    }

    const segs = relPath.replace(/\\/g, '/').split('/')
    for (const seg of segs) {
      if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(seg)) {
        return { files: [], error: `Windows 予約名が含まれています: ${relPath}` }
      }
      if (isBakFileName(seg) || isOsVcsArtifactName(seg)) {
        return { files: [], error: `除外パターンに一致するファイル/ディレクトリです: ${relPath}` }
      }
    }

    // 照合キーは「言語＋小文字化した相対パス」。`SKILL.md` と `en:SKILL.md` は別のファイル
    const lower = `${isEn ? 'en' : 'ja'}:${relPath.toLowerCase()}`
    if (seenPathsLower.has(lower)) {
      return { files: [], error: `パスが大文字小文字の違いで衝突しています: ${headingPath}` }
    }
    seenPathsLower.add(lower)

    const byteLen = Buffer.byteLength(content, 'utf-8')
    if (byteLen > 10 * 1024 * 1024) {
      return { files: [], error: `ファイルサイズが上限(10MB)を超えています: ${relPath} (${byteLen} bytes)` }
    }

    try {
      decodeUtf8Strict(Buffer.from(content, 'utf-8'), filePath)
    } catch (err) {
      return { files: [], error: (err as Error).message }
    }

    const hash = createHash('sha256').update(content, 'utf-8').digest('hex')
    files.push({
      relPath,
      content,
      hash,
      status: relPath === 'SKILL.md' ? 'modify' : 'add',
      ...(isEn ? { lang: 'en' as const } : {})
    })
  }

  // 候補走査・採用が SKILL.md を ja 側から取る前提を保つため、ja の SKILL.md は必須。
  // en:SKILL.md だけの提案は、黙って落とさずここで明示のエラーにする
  if (!files.some((f) => f.lang !== 'en' && f.relPath === 'SKILL.md')) {
    return {
      files: [],
      error: files.some((f) => f.lang === 'en' && f.relPath === 'SKILL.md')
        ? '必須ファイル SKILL.md（ja）が含まれていません（en:SKILL.md だけの提案は扱えません。ja の SKILL.md も書いてください）'
        : '必須ファイル SKILL.md が含まれていません'
    }
  }

  return { files, error: null }
}

/** 提案 MD 1 本をパース（状態・フラグは含まない）。 */
export async function parseProposalMd(
  filePath: string
): Promise<
  Omit<
    ProposalSummary,
    | 'state'
    | 'alreadyAdopted'
    | 'goldenCollision'
    | 'goldenCollisionResolved'
    | 'goldenCollisionStatus'
    | 'needsReview'
    | 'gate'
    | 'harvest'
    | 'adjudications'
    | 'ackBinding'
  >
> {
  const raw = await readFile(filePath)
  return parseProposalMdFromRaw(raw, filePath)
}

/** parseProposalMd の raw 受け版（1-read 統合で採用ゲートと content hash を同一 snapshot で共有するため）。 */
export function parseProposalMdFromRaw(
  raw: Buffer | string,
  filePath?: string
): Omit<
  ProposalSummary,
  | 'state'
  | 'alreadyAdopted'
  | 'goldenCollision'
  | 'goldenCollisionResolved'
  | 'goldenCollisionStatus'
  | 'needsReview'
  | 'gate'
  | 'harvest'
  | 'adjudications'
  | 'ackBinding'
> {
  const rawText = typeof raw === 'string' ? raw : decodeUtf8Strict(raw, filePath)
  const fm = parseFlatFrontmatter(rawText)
  const base = {
    filePath: filePath ?? '',
    requestId: '',
    target: '',
    files: [] as ProposalFile[],
    skillName: '',
    sourceProject: '',
    createdAt: '',
    adoptionLabel: '',
    title: '',
    what: '',
    why: '',
    how: '',
    axes: [] as ProposalAxisScore[],
    reviewBox: { verdict: '', findings: '', reviewerId: '', ccRebuttal: '' },
    parseError: null as string | null,
    notAProposal: false
  }
  if (!fm) {
    return { ...base, parseError: 'frontmatter not found', notAProposal: true }
  }
  const target = fm.data.target ?? ''
  const skillName = target ? basename(dirname(target.replace(/\\/g, '/'))) : ''

  // Section 3（完成版ファイル群）のパースと検証
  const filesRes = parseProposedFilesFromSection3(fm.body, filePath)

  // Summary (## 1.)
  const sec1 = sliceSection(fm.body, 1)
  let title = '',
    what = '',
    why = '',
    how = ''
  if (sec1) {
    const { raw: items } = parseListKv(sec1)
    title = findValue(items, 'タイトル', 'Title')
    what = findValue(items, 'What')
    why = findValue(items, 'Why')
    how = findValue(items, 'How')
  }
  if (!title) title = fm.data.purpose ?? skillName ?? '(untitled)'
  // Axes (## 2.)
  const sec2 = sliceSection(fm.body, 2)
  const axes: ProposalAxisScore[] = []
  if (sec2) {
    for (const it of parseListKv(sec2).raw) {
      const canonicalName = getCanonicalAxisName(it.key)
      if (!canonicalName) continue
      const { score, rationale } = parseAxisValue(it.value)
      axes.push({ axis: canonicalName, score, rationale })
    }
  }
  // Review box (## 5.)
  const sec5 = sliceSection(fm.body, 5)
  const reviewBox = { verdict: '', findings: '', reviewerId: '', ccRebuttal: '' }
  if (sec5) {
    const items = parseListKv(sec5).raw
    reviewBox.verdict = findValue(items, 'review_verdict')
    reviewBox.findings = findValue(items, 'findings')
    reviewBox.reviewerId = findValue(items, 'reviewer_id')
    reviewBox.ccRebuttal = findValue(items, 'cc_rebuttal')
  }
  const isNoCandidate = fm.data.adoption_label === 'reject'
  const notAProposal = fm.data.kind !== 'skill' || !target
  const parseError = notAProposal
    ? fm.data.kind !== 'skill'
      ? `kind is '${fm.data.kind ?? '(none)'}', expected 'skill'`
      : 'target missing'
    : filesRes.error
      ? filesRes.error
      : isNoCandidate
        ? null
        : validateAxes(axes)
  return {
    ...base,
    files: filesRes.files,
    requestId: fm.data.request_id ?? '',
    target,
    skillName,
    sourceProject: fm.data.source_project ?? '',
    createdAt: fm.data.created_at ?? '',
    adoptionLabel: fm.data.adoption_label ?? '',
    ...(fm.data.base_hash ? { baseHash: fm.data.base_hash } : {}),
    ...(fm.data.companion_base_hashes
      ? { companionBaseHashes: fm.data.companion_base_hashes }
      : {}),
    title,
    what,
    why,
    how,
    axes,
    reviewBox,
    parseError,
    notAProposal
  }
}

// --- 状態ストア（proposal-states.json） ---

type StateMap = Record<string, ProposalState>

export async function readProposalStates(
  paths: ProposalStorePaths = getDefaultProposalStorePaths()
): Promise<StateMap> {
  if (!existsSync(paths.statesPath)) return {}
  try {
    const raw = await readFile(paths.statesPath, 'utf-8')
    if (raw.trim() === '') return {}
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: StateMap = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && (VALID_PROPOSAL_STATES as string[]).includes(v)) {
        out[k] = v as ProposalState
      }
    }
    return out
  } catch {
    return {} // フェイルセーフ: 破損時は全て候補扱い
  }
}

export async function setProposalState(
  requestId: string,
  state: ProposalState,
  paths: ProposalStorePaths = getDefaultProposalStorePaths()
): Promise<void> {
  if (!VALID_PROPOSAL_STATES.includes(state)) {
    throw new Error(`invalid proposal state: ${state}`)
  }
  // プロセス間のロック＋書込み直前の再確認＋tmp+rename（複数提案を一度に動かす合成ルートでも更新が失われない）。
  // 値は従来どおり妥当な状態だけを残す（readProposalStates と同じ選別）
  await atomicJsonUpdate<StateMap>(
    paths.statesPath,
    (cur) => {
      const out: StateMap = {}
      if (cur !== null && typeof cur === 'object' && !Array.isArray(cur)) {
        for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
          if (typeof v === 'string' && (VALID_PROPOSAL_STATES as string[]).includes(v)) out[k] = v as ProposalState
        }
      }
      out[requestId] = state
      return out
    },
    () => ({})
  )
}

// --- レビューストア（proposal-reviews.json） ---

/**
 * 保存されるレビュー 1 件。レビューボックス契約（C1）の 4 フィールド + 記録時刻。
 * reviewerId は抽象（codex / らいこ / LocalLLM 等を差し替え可能に汎用文字列で保持）。
 */
export type StoredProposalReview = ProposalReviewBox & {
  /** ISO 8601。レビュー記録時刻（実時刻、推定丸め禁止） */
  reviewedAt: string
  /**
   * レビュアーが実際にレビューした proposal content の sha256（= computeProposalHash(raw)）。
   * 採用ゲートが「承認された content そのものか」を照合する（request_id 再利用によるなりすまし承認を防ぐ）。
   * reviews.json 上のキーは既存互換のため snake_case `proposal_hash`。欠落 = legacy（採用時 fail closed）。
   */
  proposalHash?: string
  // --- 三択(c)「明示降格」の記録（発注 20260805_1631 §A-1）。Stop hook 側の検出核も同じキーを読む ---
  /** 降格先ラベル。`recommend-with-findings` のときのみ降格が成立する */
  downgradedTo?: string
  /** 降格を適用した実時刻（ISO 8601） */
  downgradedAt?: string
  /**
   * 降格を適用した時点の**降格前** content の sha256。降格操作はこれが `proposalHash` と一致することを
   * 適用時に検証して記録する（＝レビューされた content の上にしか降格を置けない）。
   */
  downgradedFromHash?: string
  /**
   * 降格マーカー追記**後**のファイルの sha256。hook はこれを現ファイルと比較する。
   * 降格には frontmatter 追記が必須で hash が必ず変わるため、`proposalHash` と現ファイルを直接比較すると
   * 正規の降格が自己失効する。2 本の hash で鎖を張ることで「マーカー追記以外の変更」だけを弾く。
   */
  downgradedContentHash?: string
  // --- 刈り取り（harvest）の記録。検出核 hook `recommend-review-detect.cjs` と同じキーを読む ---
  /** 裁定が対象とした findings 本文の sha256。再レビューで findings が変われば古い裁定は無効になる */
  adjudicationsFor?: string
  /** finding 単位の裁定。id 集合は findings から抽出した id 集合と完全一致していなければならない */
  adjudications?: ProposalAdjudication[]
}

/**
 * finding 1 件に対する CC の裁定。**終端は 2 つだけ**（`rejected` / `deferred`）。
 * 「修正して再レビュー待ち」は終端にしない — 直したなら再レビューを回して裁定し直す（刈り取りはループ）。
 */
export interface ProposalAdjudication {
  /** finding id。canonical decimal string（先頭ゼロ・数値型は不可） */
  id: string
  decision: string
  /** 棄却／据え置きの理由。ユーザーへ全文提示される */
  reason: string
  /** ISO 8601 */
  at?: string
}

/** 三択(c) の降格ラベル。検出核 hook（recommend-review-detect.cjs）と同値でなければならない。 */
export const FINDINGS_ACK_LABEL = 'recommend-with-findings'

/** 裁定の終端語彙。hook 側 `TERMINAL_DECISIONS` と同値。 */
export const DECISION_REJECTED = 'rejected'
export const DECISION_DEFERRED = 'deferred'
const TERMINAL_DECISIONS = new Set<string>([DECISION_REJECTED, DECISION_DEFERRED])

/** finding id の正準形。抽出側と裁定側の両方に課す（先頭ゼロ・空白付きを弾く）。 */
const CANONICAL_FINDING_ID_RE = /^[1-9][0-9]*$/

/** block 理由に埋める値プレビューの上限長（ログ肥大・機微データ引用の抑制。検出核と同値）。 */
const ID_PREVIEW_MAX = 50

/**
 * 型不正の原因がひと目で分かる短い値表示（検出核 `previewValue` と同一規則）。
 * `JSON.stringify` で文字列と数値を見分けられる形にし（`"1"` vs `1`）、
 * stringify 不能値（undefined 等）は `String()` に落とす。50 字超は切り詰める。
 */
function previewValue(v: unknown): string {
  const s = JSON.stringify(v)
  const t = typeof s === 'string' ? s : String(v)
  return t.length > ID_PREVIEW_MAX ? `${t.slice(0, ID_PREVIEW_MAX)}…` : t
}

/** 裁定理由に課すフロア。水増しを弾くだけで質は保証しない（質の判断はユーザー）。 */
export const MIN_ADJUDICATION_REASON_CHARS = 30
export const MIN_ADJUDICATION_REASON_UNIQUE_CHARS = 15

/**
 * proposal content の承認バインディング用 hash。
 * 入力は readFile(filePath, 'utf-8') の**文字列**（正規化しない・BOM/改行は読んだまま）。
 * 既存 backlog-sweep 記録（sha256(raw utf-8 文字列)）と一致させるため、承認記録側・採用ゲート側で
 * 必ずこの単一関数を使う（計算方式の分岐は cry-wolf のもと・禁止）。
 */
export function computeProposalHash(raw: Buffer | string): string {
  if (Buffer.isBuffer(raw)) {
    return createHash('sha256').update(raw).digest('hex')
  }
  return createHash('sha256').update(raw, 'utf-8').digest('hex')
}

/**
 * 裁定の束縛に使う findings 本文の hash。
 * ハッシュ対象は**台帳に格納されている `findings` 文字列そのもの**（UTF-8・正規化なし・抜粋なし）。
 * `FINDINGS:` セクションだけを抽出して hash する案は採らない — 抽出パーサを挟むと、その実装差が
 * `.cjs` / TS 間のハッシュ不一致を生む（それが防ごうとしている当のリスク）。
 */
export function computeFindingsHash(findings: string): string {
  return createHash('sha256').update(findings, 'utf-8').digest('hex')
}

/**
 * レビュー本文から finding の id を抽出する（検出核 `.cjs` の `extractFindingIds` と**同一規則**）。
 * **行単位の単純一致**で行い、ブロック切り出しの lookahead に頼らない。
 * 戻り値: id 配列 / 指摘ゼロなら `[]` / **判定不能なら `null`（呼び出し側で fail closed）**
 */
export function extractFindingIds(findings: unknown): string[] | null {
  if (typeof findings !== 'string') return null
  const ids: number[] = []
  for (const line of findings.split(/\r?\n/)) {
    const m = line.match(/^\s*\[(\d+)\]/)
    if (!m) continue
    if (!CANONICAL_FINDING_ID_RE.test(m[1])) return null
    ids.push(Number(m[1]))
  }
  if (ids.length === 0) {
    return /FINDINGS:\s*none/i.test(findings) ? [] : null
  }
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] !== i + 1) return null
  }
  return ids.map(String)
}

/** 裁定理由が実質的か（水増しを弾くフロア）。`.cjs` の `isSubstantiveReason` と同一規則。 */
export function isSubstantiveAdjudicationReason(reason: unknown): boolean {
  if (typeof reason !== 'string') return false
  const trimmed = reason.trim()
  if (trimmed.length < MIN_ADJUDICATION_REASON_CHARS) return false
  const dense = trimmed.replace(/\s+/g, '')
  if (dense.length < MIN_ADJUDICATION_REASON_CHARS) return false
  if (new Set(dense).size < MIN_ADJUDICATION_REASON_UNIQUE_CHARS) return false
  return true
}

/**
 * 刈り取りが成立しなかった理由の**安定キー**。UI とテストはこちらを見る
 * （日本語の理由文は人間向けで、文言変更でテストが壊れる結合を作らない）。
 */
export type HarvestCode =
  | 'ok'
  | 'no-review'
  | 'stale-content'
  | 'findings-unparseable'
  | 'verdict-mismatch'
  | 'adjudications-stale'
  | 'adjudications-missing'
  | 'adjudications-malformed'
  | 'adjudication-nonterminal'
  | 'adjudication-reason-thin'

/** 刈り取り判定の結果。`ok` が採用ゲートの解除条件、`deferred` が ack 要否を決める。 */
export interface HarvestResult {
  ok: boolean
  code: HarvestCode
  /** 解除しない理由（ok=true なら null） */
  reason: string | null
  findingCount: number
  rejected: string[]
  deferred: string[]
}

function harvestFailed(code: HarvestCode, reason: string): HarvestResult {
  return { ok: false, code, reason, findingCount: 0, rejected: [], deferred: [] }
}

/**
 * 「この review 記録は、いま手元にある content を対象としたものか」。
 *
 * 素朴に `proposalHash === sha256(raw)` だけで見ると、**正規降格した提案が必ず落ちる**。
 * 降格は提案 frontmatter へ `adoption_label` / `downgraded_at` を追記するので、
 * ファイル hash は**必ず**変わるためである（2026-08-07 実測: 降格済み 20 件が全滅し、
 * しかも「content hash 不一致だから再レビューせよ」という**誤った対処**を指示していた。
 * 実体は「裁定が 1 件も無い」だった）。
 *
 * よって §5-3 で定義済みの **hash チェーン**を判定に入れる:
 *   レビュー対象 content(`proposalHash`) → 降格元(`downgradedFromHash`)
 *   → 降格後(`downgradedContentHash`) → 現ファイル
 * 鎖の両端が繋がっているときだけ「降格マーカー追記以外の変更は無い」と言える。
 * **緩めない**: 鎖のどこか 1 つでも切れていれば `false`（本文が書き換わっている ＝ 再レビューが要る）。
 */
function reviewCoversContent(review: StoredProposalReview, raw: string | Buffer): boolean {
  const storedHash = review.proposalHash ?? ''
  if (!storedHash) return false
  const current = computeProposalHash(raw)
  if (storedHash === current) return true
  return (
    review.downgradedTo === FINDINGS_ACK_LABEL &&
    review.downgradedFromHash === storedHash &&
    !!review.downgradedContentHash &&
    review.downgradedContentHash === current
  )
}

/**
 * 「CC が指摘を裁定し切ったか」を判定する（検出核 `.cjs` の `judgeHarvest` と**同一規則**・パリティテストで固定）。
 *
 * 推奨バッジは「レビュアーが approve と言った」ではなく **「CC が全 finding に決着を付けた」**を意味する。
 * 終端は `rejected`（的外れと根拠付きで棄却）と `deferred`（妥当だが未修正・ユーザー判断へ委譲）の 2 つ。
 * `deferred` を含んでいても推奨は維持し、**採用時に ack（責任譲渡）を要求**する。
 */
export function evaluateHarvest(review: StoredProposalReview | undefined, raw: string | Buffer): HarvestResult {
  if (!review) return harvestFailed('no-review', '独立レビューが未実施です')
  if (!reviewCoversContent(review, raw)) {
    return harvestFailed(
      'stale-content',
      'レビュー後に提案内容が変更されています（レビューされた content と一致しません）。再レビューが必要です'
    )
  }
  const ids = extractFindingIds(review.findings)
  if (ids === null) {
    return harvestFailed('findings-unparseable', 'レビュー本文から指摘を同定できません（形式が想定外です）')
  }
  const verdict = (review.verdict ?? '').trim().toLowerCase()
  if (ids.length === 0) {
    if (verdict !== ADOPTION_CLEARING_VERDICT) {
      return harvestFailed(
        'verdict-mismatch',
        `指摘ゼロと記録されていますが verdict が approve ではありません（${verdict || '未記録'}）`
      )
    }
    return { ok: true, code: 'ok', reason: null, findingCount: 0, rejected: [], deferred: [] }
  }
  // **順序が意味を持つ**: 「裁定が無い」を先に見る。逆順だと `adjudicationsFor` が未記録の
  // 未裁定エントリまで「古い裁定がある」と誤診断し、対処（再レビュー）を誤らせる（2026-08-07 実測）。
  const adj = review.adjudications
  if (!Array.isArray(adj) || adj.length === 0) {
    return harvestFailed('adjudications-missing', '指摘に対する裁定が記録されていません')
  }
  if (review.adjudicationsFor !== computeFindingsHash(review.findings)) {
    return harvestFailed('adjudications-stale', '裁定が現在の指摘に対するものではありません（再レビュー後の古い裁定）')
  }
  const seen = new Set<string>()
  for (const a of adj) {
    // 理由には期待形と実値（プレビュー＋型名）を並記する。実事故（2026-08-25）: JSON 数値の id を
    // 書いて「形式が不正」だけ返され、型が原因だと台帳を開いて突き合わせるまで分からなかった。
    if (!a || typeof a.id !== 'string' || !CANONICAL_FINDING_ID_RE.test(a.id)) {
      const v = a ? a.id : a
      return harvestFailed(
        'adjudications-malformed',
        `裁定の形式が不正: id は canonical decimal string（文字列、例 "1"）が必要。実際: ${previewValue(v)}（${typeof v}）`
      )
    }
    if (seen.has(a.id)) return harvestFailed('adjudications-malformed', '裁定 id が重複しています')
    seen.add(a.id)
  }
  if (seen.size !== ids.length || !ids.every((id) => seen.has(id))) {
    return harvestFailed('adjudications-malformed', '裁定が指摘と 1:1 対応していません（欠け・余分があります）')
  }
  const rejected: string[] = []
  const deferred: string[] = []
  for (const a of adj) {
    if (!TERMINAL_DECISIONS.has(a.decision)) {
      return harvestFailed(
        'adjudication-nonterminal',
        `指摘 ${a.id} が未裁定です（${String(a.decision)}）。修正したなら再レビューが必要です`
      )
    }
    if (!isSubstantiveAdjudicationReason(a.reason)) {
      return harvestFailed('adjudication-reason-thin', `指摘 ${a.id} の裁定理由が実質的ではありません`)
    }
    ;(a.decision === DECISION_DEFERRED ? deferred : rejected).push(a.id)
  }
  return { ok: true, code: 'ok', reason: null, findingCount: ids.length, rejected, deferred }
}

/**
 * 「ユーザーが採用時に読んだ裁定の内容」を一意に表す鍵（レビュー r4#2・r5#1）。
 *
 * ack を boolean にすると**何に対する同意かを束縛できない**。UI が古い状態で立てた ack が
 * 別内容の採用へ流用されうるので、ack は `{proposalHash, findingsHash, adjudicationsKey}` の
 * 3 値で送らせ、採用チョークポイントが現在の raw と台帳から**再計算して照合**する。
 *
 * 対象は据え置きだけでなく**全裁定**（r5#1）。ack は「この提案を採用する」ことへの責任譲渡であって
 * 据え置き分だけへの同意ではなく、ユーザーは棄却理由も読んだうえで押している。
 * どちらの理由が書き換わっても鍵が変わる ＝ 古い ack は自動的に無効になる。
 *
 * **正準形（レビュー r8#2。ここを変えると既存 ack と監査キーが全て変わる）**:
 * 1. `id` の**文字列比較**で昇順に整列する（数値比較ではない。`'10' < '2'` になるが、
 *    list 側と adopt 側が同一関数を通るため一貫していればよい）
 * 2. 各要素は `{ id, decision, reason }` の **3 キー・この順序固定**。台帳の他キー（`at` 等）は含めない
 * 3. 値は**台帳格納値そのまま**（trim もしない・Unicode 正規化もしない）
 * 4. `JSON.stringify` の既定出力（空白なし）を UTF-8 で sha256
 * 固定入力に対する期待値はテストで golden 固定してある（意図しない直列化変更を検出するため）。
 *
 * **裁定が無いエントリ（未刈り取りの `recommend-with-findings` 降格経路）でも同じ式で計算する**
 * （レビュー r11#1）。空配列の sha256 という**一意に定まる値**になるので、ack ペイロードの形は
 * 両経路で同一のまま扱える。`ackKind` ごとにペイロードの形を分ける案は採らない —
 * 形を分岐させること自体が、その指摘が警戒している「実装差で空・固定値・省略可が割れる」原因になる。
 * 降格経路で ack を縛るのは主に `proposalHash` と `findingsHash`（＋降格鎖の検証）である。
 */
export function computeAdjudicationsKey(review: StoredProposalReview | undefined): string {
  const items = (review?.adjudications ?? [])
    .map((a) => ({ id: a.id, decision: a.decision, reason: a.reason }))
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(items), 'utf-8').digest('hex')
}

type ReviewMap = Record<string, StoredProposalReview>

/** 1 エントリが妥当な review か（フェイルセーフ用の最小バリデーション）。 */
function coerceStoredReview(v: unknown): StoredProposalReview | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const s = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')
  // reviews.json のキーは既存互換で snake_case `proposal_hash`（欠落 = legacy → 採用時 fail closed）。
  const ph = typeof o.proposal_hash === 'string' ? (o.proposal_hash as string) : undefined
  // 降格 4 フィールドは camelCase のまま（`proposal_hash` だけが既存互換の snake_case 例外）。
  const opt = (k: string): Record<string, string> =>
    typeof o[k] === 'string' && (o[k] as string) !== '' ? { [k]: o[k] as string } : {}
  return {
    verdict: s('verdict'),
    findings: s('findings'),
    reviewerId: s('reviewerId'),
    ccRebuttal: s('ccRebuttal'),
    reviewedAt: s('reviewedAt'),
    ...(ph ? { proposalHash: ph } : {}),
    ...opt('downgradedTo'),
    ...opt('downgradedAt'),
    ...opt('downgradedFromHash'),
    ...opt('downgradedContentHash'),
    ...opt('adjudicationsFor'),
    ...coerceAdjudications(o.adjudications)
  }
}

/**
 * 裁定配列の最小バリデーション。**正規化はしない**（id を丸めたり decision を補ったりしない）——
 * 形が違えば `evaluateHarvest` が fail closed で弾く。ここでの役割は型の担保だけ。
 */
function coerceAdjudications(v: unknown): { adjudications?: ProposalAdjudication[] } {
  if (!Array.isArray(v)) return {}
  const out: ProposalAdjudication[] = []
  for (const e of v) {
    if (e === null || typeof e !== 'object' || Array.isArray(e)) continue
    const o = e as Record<string, unknown>
    if (typeof o.id !== 'string' || typeof o.decision !== 'string' || typeof o.reason !== 'string') continue
    out.push({
      id: o.id,
      decision: o.decision,
      reason: o.reason,
      ...(typeof o.at === 'string' ? { at: o.at } : {})
    })
  }
  return { adjudications: out }
}

export async function readProposalReviews(
  paths: ProposalStorePaths = getDefaultProposalStorePaths()
): Promise<ReviewMap> {
  if (!existsSync(paths.reviewsPath)) return {}
  try {
    const raw = await readFile(paths.reviewsPath, 'utf-8')
    if (raw.trim() === '') return {}
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: ReviewMap = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const r = coerceStoredReview(v)
      if (r) out[k] = r
    }
    return out
  } catch {
    return {} // フェイルセーフ: 破損時はレビュー無し（= MD §5 pending に縮退）
  }
}

/**
 * setProposalReview の `extra` に入れてはならない鍵（CCPIT_L0_011）。
 * 採用ゲート（evaluateHarvest・reviewCoversContent・降格鎖）が読む項目と、レビューの本体の項目。
 * extra 経由でゲートが見る値を上書きさせない。拒否は throw（黙って落とさない）。
 */
export const SET_PROPOSAL_REVIEW_EXTRA_RESERVED_KEYS: readonly string[] = [
  'verdict',
  'findings',
  'proposal_hash',
  'proposalHash',
  'adjudications',
  'adjudicationsFor',
  'reviewerId',
  'ccRebuttal',
  'reviewedAt',
  'downgradedTo',
  'downgradedAt',
  'downgradedFromHash',
  'downgradedContentHash'
]

export interface SetProposalReviewOptions {
  /**
   * 台帳の行へ、既知の項目の後に足す追加項目（合成提案のレビューの reviewScope など）。
   * 渡さなければ従来と同じ行になる。予約の鍵（SET_PROPOSAL_REVIEW_EXTRA_RESERVED_KEYS）が入っていたら throw する。
   */
  extra?: Record<string, unknown>
}

export async function setProposalReview(
  requestId: string,
  review: StoredProposalReview,
  paths: ProposalStorePaths = getDefaultProposalStorePaths(),
  opts?: SetProposalReviewOptions
): Promise<void> {
  if (!requestId) throw new Error('setProposalReview: requestId is required')
  const extra = opts?.extra
  if (extra !== undefined) {
    if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) {
      throw new Error('setProposalReview: extra must be a plain object')
    }
    const bad = Object.keys(extra).filter((k) => SET_PROPOSAL_REVIEW_EXTRA_RESERVED_KEYS.includes(k))
    if (bad.length > 0) {
      throw new Error(`setProposalReview: extra に予約の鍵は入れられません: ${bad.join(', ')}`)
    }
  }
  await mkdir(dirname(paths.reviewsPath), { recursive: true })
  // 昇格の戻し（rollbackPromotion）が同じファイルを復元するので、プロセス間ロックの下で「読む→差し替え→rename」を行う
  // （挙動・.bak 方針は変えない。ロックだけを足す）
  await withFileLock(`${paths.reviewsPath}.lock`, () =>
    setProposalReviewLocked(requestId, review, paths, extra)
  )
}

/**
 * 台帳 JSON の生のオブジェクトを読む（ロックの下で呼ぶこと）。破損していたら退避して空から始める。
 * setProposalReviewLocked と recordComposeAdjudication が共有する（読み方を分岐させない）。
 */
async function loadReviewsObjectLocked(
  paths: ProposalStorePaths,
  quarantineBroken = true
): Promise<Record<string, unknown>> {
  let obj: Record<string, unknown> = {}
  if (existsSync(paths.reviewsPath)) {
    let parsed: unknown = null
    let broken = false
    try {
      const rawText = await readFile(paths.reviewsPath, 'utf-8')
      if (rawText.trim() !== '') {
        parsed = JSON.parse(rawText)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) broken = true
      }
    } catch {
      broken = true
    }
    if (broken && !quarantineBroken) {
      throw new Error(`台帳が読めません（破損）: ${paths.reviewsPath}`)
    }
    if (broken) {
      // 破損を黙って上書きしない（証跡温存）。退避してから新規に積む。
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      await rename(paths.reviewsPath, `${paths.reviewsPath}.corrupt-${ts}`)
    } else if (parsed) {
      obj = parsed as Record<string, unknown>
    }
  }
  return obj
}

/** 台帳 JSON を書く（ロックの下で呼ぶこと）: .bak（既存は保護）→ temp 書込 → atomic rename */
async function saveReviewsObjectLocked(
  paths: ProposalStorePaths,
  obj: Record<string, unknown>
): Promise<void> {
  // 書込中クラッシュで 150 エントリの台帳を壊さないための最小限の耐性。
  // 単一ライタ前提であり CAS は入れていない（複数ライタの同時更新は本発注のスコープ外）。
  const bak = `${paths.reviewsPath}.bak`
  if (existsSync(paths.reviewsPath) && !existsSync(bak)) {
    try {
      await copyFile(paths.reviewsPath, bak)
    } catch {
      /* .bak 取得失敗は書込を止めない（ロールバック用であって競合制御ではない） */
    }
  }
  const tmp = `${paths.reviewsPath}.tmp`
  await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8')
  await rename(tmp, paths.reviewsPath)
}

async function setProposalReviewLocked(
  requestId: string,
  review: StoredProposalReview,
  paths: ProposalStorePaths,
  extra?: Record<string, unknown>
): Promise<void> {
  // --- 非破壊マージ（実測で見つけた破壊バグの根治） ---
  // 旧実装は readProposalReviews() で読んだ map を**全件書き戻して**いた。coerceStoredReview が
  // エントリを既知フィールドへ切り詰めるため、1 回 upsert しただけで他ツールが書いた未知フィールドが
  // 全エントリから消える（実測: review_status 99 件 / kind 100 件 / note 8 / codexSessionId 5 /
  // history 4 / concurrent_review_consolidation 2）。review_status は proposal-review-backlog-sweep が
  // 再レビュー要否の判定に使う正本であり、消えると当該 skill の判定が壊れる（しかもサイレント）。
  // よって **raw JSON を読み、対象キーのみ差し替える**。他エントリには一切触れない。
  const obj = await loadReviewsObjectLocked(paths)
  const prevRaw = obj[requestId]
  const prev =
    prevRaw !== null && typeof prevRaw === 'object' && !Array.isArray(prevRaw)
      ? (prevRaw as Record<string, unknown>)
      : {}
  // 対象エントリ自身も「既存フィールドの上へ重ねる」形にする（当該提案の kind/note 等も保全）。
  const opt = (k: string, v: string | undefined): Record<string, string> =>
    typeof v === 'string' && v !== '' ? { [k]: v } : {}
  // **ゲート束縛フィールドは prev から引き継がない**（実装後 Codex レビュー r2-B#1）。
  // `proposal_hash` が残ると「hash 未指定の新しいレビュー」が旧 hash によって束縛済みに見え、
  // 採用ゲートが誤って解除されうる。欠落 = legacy = fail-closed の意味を保つため明示的に落とす。
  // 裁定（`adjudications` / `adjudicationsFor`）も同じ理由で prev から引き継がない。
  // `adjudicationsFor` の突合があるので実質的には自己防衛できるが、「新しいレビューを書いたのに
  // 古い裁定が残る」経路を**そもそも作らない**方が読み手に対して正直で、fail-closed 側でもある。
  const {
    proposal_hash: _droppedHash,
    adjudications: _droppedAdj,
    adjudicationsFor: _droppedAdjFor,
    ...prevWithoutGateBinding
  } = prev
  void _droppedHash
  void _droppedAdj
  void _droppedAdjFor
  obj[requestId] = {
    ...prevWithoutGateBinding,
    verdict: review.verdict,
    findings: review.findings,
    reviewerId: review.reviewerId,
    ccRebuttal: review.ccRebuttal,
    reviewedAt: review.reviewedAt,
    // reviews.json 上は既存互換で snake_case `proposal_hash`（他フィールドは camelCase）
    ...opt('proposal_hash', review.proposalHash),
    ...opt('downgradedTo', review.downgradedTo),
    ...opt('downgradedAt', review.downgradedAt),
    ...opt('downgradedFromHash', review.downgradedFromHash),
    ...opt('downgradedContentHash', review.downgradedContentHash),
    ...opt('adjudicationsFor', review.adjudicationsFor),
    ...(Array.isArray(review.adjudications) ? { adjudications: review.adjudications } : {}),
    // 追加項目（L0_011）。予約の鍵は setProposalReview の入口で弾いてあるので、既知の項目は上書きされない
    ...(extra ?? {})
  }

  // --- .bak（既存は保護）→ temp 書込 → atomic rename ---
  await saveReviewsObjectLocked(paths, obj)
}

// --- 合成提案のレビューの裁定（CCPIT_L0_011 W4） ---

export type ComposeAdjudicationInput = { id: string; decision: string; reason: string }

/**
 * 裁定の検査（純関数）。`~/.claude/scripts/proposal-review-record.cjs` の裁定の検査（id は文字列・正準・重複なし・
 * decision は終端・理由は実質的・1:1）と同じ規則。合成提案のレビューの行へ書く前に通す。
 *
 * - id は extractFindingIds(findings) が返す集合の要素であること（未知の id は不可）
 * - requireComplete=true のとき、指摘が 1 件以上なら裁定が空でなく、指摘と 1:1（欠け・余分なし）
 *   requireComplete が偽（途中の記録）のときは、欠けは許す（未知の id・重複は許さない）
 * 既存の evaluateHarvest は変えない（これは書く側の検査で、読む側のゲートとは別）。
 */
export function validateComposeAdjudications(
  findings: string,
  adjudications: ComposeAdjudicationInput[],
  opts: { requireComplete?: boolean } = {}
): { ok: true } | { ok: false; error: string } {
  const ids = extractFindingIds(findings)
  if (ids === null) {
    return { ok: false, error: 'findings から指摘 id を同定できません（[1] 形式の連番か FINDINGS: none が要ります）' }
  }
  if (!Array.isArray(adjudications)) return { ok: false, error: 'adjudications が配列ではありません' }
  if (opts.requireComplete && ids.length > 0 && adjudications.length === 0) {
    return { ok: false, error: `指摘が ${ids.length} 件ありますが adjudications が空です。全件に終端裁定が要ります` }
  }
  const known = new Set(ids)
  const seen = new Set<string>()
  for (const a of adjudications as unknown[]) {
    const o = a !== null && typeof a === 'object' ? (a as Record<string, unknown>) : null
    if (!o || typeof o.id !== 'string') {
      const v = o ? o.id : a
      return {
        ok: false,
        error: `adjudications[].id は文字列でなければなりません（例: "1"）。実際: ${previewValue(v)}（${typeof v}）`
      }
    }
    if (!CANONICAL_FINDING_ID_RE.test(o.id)) {
      return { ok: false, error: `adjudications[].id が canonical decimal string ではありません: ${previewValue(o.id)}` }
    }
    if (seen.has(o.id)) return { ok: false, error: `裁定 id が重複しています: ${o.id}` }
    seen.add(o.id)
    if (typeof o.decision !== 'string' || !TERMINAL_DECISIONS.has(o.decision)) {
      return {
        ok: false,
        error: `decision が終端ではありません: ${previewValue(o.decision)}（id=${o.id}）。使えるのは ${[...TERMINAL_DECISIONS].join(' / ')} だけです`
      }
    }
    if (!isSubstantiveAdjudicationReason(o.reason)) {
      return { ok: false, error: `裁定理由が実質的ではありません（水増し / 短すぎ）: id=${o.id}` }
    }
  }
  const unknownIds = [...seen].filter((id) => !known.has(id))
  if (unknownIds.length > 0) {
    return {
      ok: false,
      error: `裁定が指摘と対応していません（余分な id: ${unknownIds.join(',')}。指摘=[${ids.join(',')}]）`
    }
  }
  if (opts.requireComplete && seen.size !== ids.length) {
    return {
      ok: false,
      error: `裁定が指摘と 1:1 対応していません。指摘=[${ids.join(',')}] 裁定=[${[...seen].join(',')}]（欠け・余分は不可）`
    }
  }
  return { ok: true }
}

/**
 * 合成提案のレビューへの棄却の記録（maintainerが UI で入れた理由）。台帳の行の `adjudications` に書く。
 *
 * - 合成提案のレビューの行（reviewScope.kind === 'compose-diff'）だけが対象
 * - 行の proposal_hash が compositeFile の現在の内容のハッシュと一致するときだけ（内容が変わっていたら拒否）
 * - gateId は行の findings の [n] にあること。理由は実質的であること
 * - 合成提案 MD は一切書き換えない（§5 も書かない。合成台帳の proposalSha256 の束縛を守る）
 * - ロックは setProposalReview と同じ `<reviewsPath>.lock`。読む→検査→書くを 1 回のロックの下で行う
 * 戻り値の remaining は、まだ裁定の無い gate id の数。
 */
export async function recordComposeAdjudication(
  input: { compositeId: string; compositeFile: string; gateId: string; reason: string },
  paths: ProposalStorePaths = getDefaultProposalStorePaths()
): Promise<{ ok: true; remaining: number } | { ok: false; error: string }> {
  const { compositeId, compositeFile, gateId, reason } = input
  if (!compositeId) return { ok: false, error: 'compositeId がありません' }
  if (!existsSync(paths.reviewsPath)) return { ok: false, error: '台帳にレビューの行がありません' }
  return withFileLock(`${paths.reviewsPath}.lock`, async () => {
    // 提案の読取りとハッシュの算出もロックの下で行う（検査から書込みまでの間に読む版が古くなる窓を狭める）。
    // 書込み後に提案が変わっても、行の proposal_hash 束縛が採用ゲート（reviewCoversContent）で効くので、古い裁定は採用に使えない
    let raw: string
    try {
      raw = await readFile(compositeFile, 'utf-8')
    } catch (e) {
      return { ok: false as const, error: `合成提案を読めません: ${e instanceof Error ? e.message : String(e)}` }
    }
    const currentHash = computeProposalHash(raw)
    let obj: Record<string, unknown>
    try {
      // 書かない経路なので、破損した台帳を退避（rename）しない
      obj = await loadReviewsObjectLocked(paths, false)
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
    const rowRaw = obj[compositeId]
    if (rowRaw === null || typeof rowRaw !== 'object' || Array.isArray(rowRaw)) {
      return { ok: false as const, error: `台帳に ${compositeId} の行がありません` }
    }
    const row = rowRaw as Record<string, unknown>
    const scope = row.reviewScope as Record<string, unknown> | undefined
    if (!scope || typeof scope !== 'object' || scope.kind !== 'compose-diff') {
      return { ok: false as const, error: '合成提案のレビュー（reviewScope.kind=compose-diff）の行ではありません' }
    }
    const rowHash = typeof row.proposal_hash === 'string' ? row.proposal_hash : ''
    if (!rowHash || rowHash !== currentHash) {
      return {
        ok: false as const,
        error: '合成提案の内容がレビューされた版と違います（行の proposal_hash と現在のハッシュが不一致）'
      }
    }
    // 行の束縛（reviewScope が別の版のまま残った行ではない）
    if (scope.proposalHash !== rowHash) {
      return { ok: false as const, error: 'reviewScope.proposalHash が行の proposal_hash と一致しません' }
    }
    const findings = typeof row.findings === 'string' ? row.findings : ''
    const ids = extractFindingIds(findings)
    if (ids === null) return { ok: false as const, error: '行の findings から指摘を同定できません' }
    if (!ids.includes(gateId)) {
      return { ok: false as const, error: `指摘 ${previewValue(gateId)} は行の findings にありません（指摘=[${ids.join(',')}]）` }
    }
    if (!isSubstantiveAdjudicationReason(reason)) {
      return { ok: false as const, error: '棄却の理由が実質的ではありません（短すぎ・水増し）' }
    }
    const findingsHash = computeFindingsHash(findings)
    // 今の指摘に対する裁定だけを引き継ぐ（古い指摘への裁定は持ち越さない）
    const prevAdj =
      row.adjudicationsFor === findingsHash && Array.isArray(row.adjudications)
        ? (row.adjudications as unknown[]).filter(
            (x): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x)
          )
        : []
    const at = new Date().toISOString()
    const next = [
      ...prevAdj.filter((x) => x.id !== gateId),
      { id: gateId, decision: DECISION_REJECTED, reason, at }
    ]
    const v = validateComposeAdjudications(findings, next as ComposeAdjudicationInput[])
    if (!v.ok) return { ok: false as const, error: v.error }
    obj[compositeId] = { ...row, adjudications: next, adjudicationsFor: findingsHash }
    await saveReviewsObjectLocked(paths, obj)
    const done = new Set(next.map((x) => String(x.id)))
    return { ok: true as const, remaining: ids.filter((id) => !done.has(id)).length }
  })
}

// --- 一覧（状態・可視化フラグ込み） ---

export interface ListProposalsOptions {
  storePaths?: ProposalStorePaths
  provenancePaths?: ProvenancePaths
  goldenSkillNames?: string[]
  /** golden 正本マップ (rel -> sourceAbsPath)。未指定・取得失敗時は false 扱い (CCPIT_066) */
  goldenSourceMap?: Map<string, string>
  /** 配置先ルートディレクトリ（~/.claude/ 想定。絶対パス必須） (CCPIT_066) */
  targetDir?: string
  /** テスト用読込関数 DI (既定: fs/promises.readFile) (CCPIT_066) */
  readFileFn?: (path: string) => Promise<Buffer>
  /** golden の en 側の物理パスを返す（`skills/<name>/<相対パス>` → 絶対パス）。en: のファイルの判定に使う */
  goldenEnPathOf?: (rel: string) => string | undefined
}

export interface CheckGoldenContentMatchInput {
  target: string
  targetDir?: string
  goldenSourceMap?: Map<string, string>
  readFileFn?: (path: string) => Promise<Buffer>
}

/**
 * Map 内から slash / backslash 双方のキーで安全に物理パスを探索する (CCPIT_066 / r6 F3)
 */
export function lookupGoldenSourcePath(
  map: Map<string, string>,
  rel: string
): string | undefined {
  const bySlash = map.get(rel)
  if (bySlash) return bySlash
  const byBackslash = map.get(rel.replace(/\//g, '\\'))
  if (byBackslash) return byBackslash
  return undefined
}

/**
 * 提案 target と正本 golden 配布元ファイルの内容が一致しているかを判定する純関数。
 * 判定不能（ファイル不在、例外、マップ欠落、不正パス、相対・無効 targetDir 等）はすべて安全側 (false) に倒す。
 * 本モジュールは Electron 非依存を維持 (CCPIT_066)。
 */
export async function checkGoldenContentMatch(
  input: CheckGoldenContentMatchInput
): Promise<boolean> {
  try {
    if (!input.targetDir || !isAbsolute(input.targetDir) || !input.goldenSourceMap) return false

    const rawRel = proposalTargetToRel(input.target, input.targetDir)
    if (!rawRel) return false
    const rel = normalizeRelPath(rawRel)

    const sourcePath = lookupGoldenSourcePath(input.goldenSourceMap, rel)
    if (!sourcePath || !existsSync(sourcePath)) return false

    const resolvedTargetDir = resolve(input.targetDir)
    const destPath = resolve(resolvedTargetDir, rel)
    const relFromTarget = relative(resolvedTargetDir, destPath)
    if (relFromTarget.startsWith('..') || isAbsolute(relFromTarget)) return false
    if (!existsSync(destPath)) return false

    const readFn = input.readFileFn ?? readFile
    const [destBuf, sourceBuf] = await Promise.all([
      readFn(destPath),
      readFn(sourcePath)
    ])

    const destHash = createHash('sha256').update(destBuf).digest('hex')
    const sourceHash = createHash('sha256').update(sourceBuf).digest('hex')

    return destHash === sourceHash
  } catch {
    return false
  }
}

export interface ClassifyGoldenCollisionInput {
  skillName: string
  /** 提案 §3 の全ファイル（SKILL.md ＋付随ファイル）。空なら判定できない（stale 側に倒す） */
  files: ReadonlyArray<{ relPath: string; content: string; lang?: 'ja' | 'en' }>
  /** frontmatter の base_hash */
  baseHash?: string
  /** frontmatter の companion_base_hashes（`相対パス=sha256;…`。en 側のファイルは `en:<相対パス>=sha256`） */
  companionBaseHashes?: string
  /** golden の en 側の物理パスを返す（`skills/<name>/<相対パス>` → 絶対パス）。en のファイルを判定するときに使う */
  goldenEnPathOf?: (rel: string) => string | undefined
  goldenSourceMap?: Map<string, string>
  readFileFn?: (path: string) => Promise<Buffer>
}

function lfText(buf: Buffer | string): string {
  return (typeof buf === 'string' ? buf : buf.toString('utf-8')).replace(/\r\n/g, '\n')
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

/** 申告された元の版の指紋が golden のファイルと同じ中身を指すか（LF のままの指紋と CRLF にした指紋の両方を受ける）。 */
function baseHashMatchesGoldenText(base: string | undefined, goldenLf: string): boolean {
  const b = (base ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(b)) return false
  return b === sha256Text(goldenLf) || b === sha256Text(goldenLf.replace(/\n/g, '\r\n'))
}

/**
 * 提案の中身が golden に入っているかを、提案 §3 の**全ファイル**で判定する（W2）。
 * 手元の配置先は見ない（手元と golden が同じだけでは「反映済み」にならない）。
 * - applied: 全ファイルが golden にあり、中身（改行を LF にそろえて）が同じ
 * - unapplied: 中身が違うものがあり、元の版（SKILL.md は base_hash、golden にあって違う付随ファイルは
 *   companion_base_hashes）が今の golden と一致する。golden に無いファイルは追加（巻き戻すものが無い）
 * - stale: 元の版の申告が無い・今の golden と違う、または判定不能（マップ欠落・読取例外・ファイル無し）
 * Electron 非依存の純関数。判定不能はすべて安全側（stale ＝「反映済み」にしない）。
 */
export async function classifyProposalAgainstGolden(
  input: ClassifyGoldenCollisionInput
): Promise<Exclude<GoldenCollisionStatus, 'none'>> {
  try {
    if (!input.goldenSourceMap || input.files.length === 0 || !input.skillName) return 'stale'
    const readFn = input.readFileFn ?? readFile
    const declared = new Map<string, string>()
    for (const item of (input.companionBaseHashes ?? '').split(';')) {
      const eq = item.lastIndexOf('=')
      if (eq <= 0) continue
      const p = item.slice(0, eq).trim().replace(/\\/g, '/')
      const sha = item.slice(eq + 1).trim().toLowerCase()
      if (p && /^[0-9a-f]{64}$/.test(sha)) declared.set(p, sha)
    }

    let allSame = true
    let skillMdPresent = false
    for (const f of input.files) {
      const relPath = f.relPath.replace(/\\/g, '/')
      const rel = `skills/${input.skillName}/${relPath}`
      if (f.lang === 'en') {
        // en 側のファイル: golden の en の現行値を正とする。提案より後に en が動いていれば stale（巻き戻さない）。
        // golden の en に無いファイルは追加（巻き戻すものが無い）。en の SKILL.md は ja の SKILL.md の有無に数えない
        const enPath = input.goldenEnPathOf?.(rel)
        if (!enPath) return 'stale'
        if (!existsSync(enPath)) {
          allSame = false
          continue
        }
        const enLf = lfText(await readFn(enPath))
        if (lfText(f.content) === enLf) continue
        allSame = false
        if (!baseHashMatchesGoldenText(declared.get(`${PROPOSAL_EN_PREFIX}${relPath}`), enLf)) return 'stale'
        continue
      }
      const goldenPath = lookupGoldenSourcePath(input.goldenSourceMap, rel)
      const isSkillMd = relPath === 'SKILL.md'
      if (isSkillMd) skillMdPresent = true
      if (!goldenPath || !existsSync(goldenPath)) {
        // golden に無いファイル: 追加は巻き戻すものが無い。ただし SKILL.md が無いのは判定不能（同名衝突の前提と矛盾）
        if (isSkillMd) return 'stale'
        allSame = false
        continue
      }
      const goldenLf = lfText(await readFn(goldenPath))
      if (lfText(f.content) === goldenLf) continue
      allSame = false
      const base = isSkillMd ? input.baseHash : declared.get(relPath)
      if (!baseHashMatchesGoldenText(base, goldenLf)) return 'stale'
    }
    if (!skillMdPresent) return 'stale'
    return allSame ? 'applied' : 'unapplied'
  } catch {
    return 'stale'
  }
}

export const GOLDEN_COLLISION_NOT_APPLIED = 'golden-collision-not-applied'

/**
 * 「統合済みとして採用済みにする」（状態だけを adopted にし、ファイルは何も書かない操作）の守り。
 * golden 同名衝突の提案で、中身がまだ golden に入っていない（未反映・提案が古い）のに adopted にすると、
 * 提案の中身が黙って消える。承知フラグ（何も適用されないと承知）が無ければ拒否する。
 * renderer の無効化だけに頼らないよう、IPC ハンドラ（renderer 起点）で使う。正規の昇格が内部から
 * `setProposalState` を直接呼ぶ経路には掛けない。
 */
export function evaluateMarkAdoptedGuard(
  proposal: Pick<ProposalSummary, 'goldenCollision' | 'goldenCollisionStatus'> | undefined,
  state: ProposalState,
  acknowledgeNoApply: boolean
): { ok: true } | { ok: false; reason: string } {
  if (state !== 'adopted' || !proposal || !proposal.goldenCollision) return { ok: true }
  if (proposal.goldenCollisionStatus === 'applied' || acknowledgeNoApply) return { ok: true }
  return {
    ok: false,
    reason: `${GOLDEN_COLLISION_NOT_APPLIED}: この提案の中身はまだ golden に入っていません。採用済みにしても何も適用されません（承知フラグが必要です）`
  }
}

/** 採用ゲートを解除する肯定的 terminal verdict（独立レビュアーが「採用してよい」と判定した状態）。 */
const ADOPTION_CLEARING_VERDICT = 'approve'

/**
 * 採用前に独立レビューが必須か（recommend で、外部レビューストアの verdict が approve 以外）。
 * **信頼境界（marshal round3）**: ゲート判定に使う `storedVerdict` は **外部レビューストア
 * （proposal-reviews.json）由来のみ**を authoritative とする。候補 MD 自身の §5 review box を
 * 渡してはならない——untrusted な提案が `review_verdict: approve` を自己申告して独立レビュー
 * なしに採用されるのを防ぐ（外部入力を信頼しない原則）。呼び出し側は stored 無し時に空文字を渡す。
 * approve のみゲート解除。それ以外（未記録＝空／pending／needs-attention／reject／unknown）はブロックし、
 * break-glass の明示チェックでのみ override 可。reject / 無ラベルの提案は対象外（recommend のみ強制）。
 * **content binding（Codex 設計レビュー反映）**: 解除には approve に加えて `hashMatches`（承認記録の
 * proposal_hash と現 content の hash が一致）を要求する。承認された content そのものでなければ免除しない
 * （request_id 再利用による stale approve のなりすまし・単一 stale 再利用を根治）。呼び出し側が hash を照合して渡す。
 */
export function needsReviewBeforeAdopt(adoptionLabel: string, harvest: HarvestResult): boolean {
  // **指摘つき（未裁定が残る降格ラベル）も対象に含める**（オーナー裁定 2026-08-07）。
  // かつては「承知のうえで採用」で通せたが、**未裁定のまま採用できる経路は
  // 刈り取りループを迂回する唯一の穴**であり、「レビューはやった、指摘は放置」を
  // 構造的に不可能にする、という本発注の目的と正面から衝突する。
  // 指摘つきの出口は「方針を添えて差し戻す」か「却下」の 2 つ。採用したければ先に刈り取る。
  if (adoptionLabel !== 'recommend' && adoptionLabel !== FINDINGS_ACK_LABEL) return false
  return !harvest.ok
}

/**
 * 採用前に「指摘を承知した」明示確認が必要か（純粋判定）。
 *
 * **ack が成立するのは「CC が裁定し切ったうえで残した既知の欠陥」に対してだけ**
 * （オーナー裁定 2026-08-07）。責任譲渡は、譲渡される中身が確定していて初めて意味を持つ。
 *
 * | 状態 | ack | 理由 |
 * |---|---|---|
 * | 推奨 + `deferred` あり | **要る** | CC が裁定済みで理由も提示済み。ユーザーが読んで引き受けられる |
 * | 指摘つき（未裁定が残る） | **不可** | 何が問題か誰も判定していない。承知しようがないので採用させない（`needsReviewBeforeAdopt` が block する） |
 *
 * 責務境界（Plan Codex レビュー r6 finding#2）: 本関数と `describeProposalGate` は**純粋判定**に留め、
 * ack の検証と監査 append という副作用は採用チョークポイント `evaluateAdoptGateFromRaw` が担う。
 */
export function needsFindingsAckBeforeAdopt(_adoptionLabel: string, harvest: HarvestResult): boolean {
  // 未裁定が残る提案は ack で通せない（＝ここで true を返さない）。採用自体が block される。
  if (!harvest.ok) return false
  // 「妥当だが未修正」を CC が理由付きで据え置いた提案だけが、ack による責任譲渡の対象。
  // ここが本アプリ → ユーザーへの責任譲渡点であり、ack を 1 操作として記録に残す。
  return harvest.deferred.length > 0
}

/**
 * ack（責任譲渡）の束縛ペイロード（レビュー r4#2）。
 * boolean だと「何に対する同意か」を束縛できないため、UI は現在状態から 3 値を送り、
 * 採用チョークポイントが**現在の raw と台帳から再計算して照合**する。1 つでも違えば拒否。
 */
export interface FindingsAckPayload extends FindingsAckBinding {
  /**
   * **ユーザーがチェックボックスを明示的に押した**という表明（レビュー r9#1）。
   * 3 値の内容束縛だけでは「一覧で受け取った `ackBinding` をそのまま返しただけ」の経路と
   * 区別できないため、**承知の意思表示を独立した入力**として要求する。厳密に `true` のみ受理。
   */
  accepted: boolean
  /** UI が実際に表示した同意文（監査用。UI 申告値であり、正本は `ACK_TEXT_VERSION`） */
  labelShown?: string
}

/** ack の内容束縛（3 値）。一覧が UI へ渡し、UI がそのまま返す部分。 */
export interface FindingsAckBinding {
  /** 承知した時点の提案 content の sha256 */
  proposalHash: string
  /**
   * 承知した時点の findings 本文の sha256。
   * **台帳の `adjudicationsFor` と同一の値**（どちらも「台帳に入っている `findings` 文字列そのもの」の
   * sha256）であり、`evaluateHarvest` が両者の一致を要求するので機械的にも揃う。
   * 名前を分けているのは役割が違うため — `adjudicationsFor` は「裁定がどの findings に対するものか」を
   * 示す台帳側の外部キーで**裁定が無い提案（降格経路）には存在しない**が、`findingsHash` は
   * ack の束縛値なので**降格経路でも必要**になる（レビュー r5#2 の改名案を採らなかった理由）。
   */
  findingsHash: string
  /** 承知した時点の**全裁定**（id + decision + 理由）の sha256 */
  adjudicationsKey: string
}

/**
 * 降格の正準逆変換（検出核 hook `recommend-review-detect.cjs` の `invertDowngrade` と**同一規則**）。
 * 現ファイルから降格マーカーを外し `adoption_label` を `recommend` へ戻す。
 * 両実装の一致は `__tests__` のパリティテストで固定する（.cjs は依存ゼロで配布されるため直接共有できない）。
 */
export function invertDowngradeText(txt: string): string | null {
  const fmMatch = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fmMatch) return null
  const fmEnd = fmMatch[0].length
  let fm = txt.slice(0, fmEnd)
  const rest = txt.slice(fmEnd)
  fm = fm.replace(/^downgraded_at:.*\r?\n/m, '')
  fm = fm.replace(/^downgrade_reason:.*\r?\n/m, '')
  // CRLF の \r を捕獲して復元する（消すと正規降格が復元できず過剰ブロックになる）
  fm = fm.replace(/^(adoption_label:[ \t]*)recommend-with-findings[ \t]*(\r?)$/m, '$1recommend$2')
  return fm + rest
}

/**
 * `recommend-with-findings` の降格鎖が現 content に対して健全か（純粋判定）。
 *
 * **なぜ採用ゲートでも要るか（実装後 Codex レビュー chunk B の critical 指摘）**:
 * 降格ラベルの採用を「ack + 監査」だけで通すと、**approve も content hash 束縛も外れる**。
 * 降格後に本文を差し替えてから採用すれば「レビューされていない content」を適用できてしまい、
 * 発注 §4 の禁則「ハッシュ束縛は不変」に抵触する。
 * 発注 §A-1(c) が免除するのは **approve 必須**までであって、content 束縛ではない。
 * よって降格採用では「レビューされた content ＋ 降格マーカーの追記のみ」であることを鎖で要求する。
 */
export function evaluateDowngradeChain(
  raw: string,
  review: StoredProposalReview | undefined
): { ok: boolean; reason: string | null } {
  if (!review) return { ok: false, reason: '降格ラベルだが台帳にレビュー記録がありません' }
  if (typeof review.findings !== 'string' || review.findings.trim() === '') {
    return { ok: false, reason: 'findings が空です（実レビューの実体がありません）' }
  }
  if ((review.downgradedTo ?? '').trim() !== FINDINGS_ACK_LABEL) {
    return { ok: false, reason: '台帳に降格記録（downgradedTo）がありません' }
  }
  // 降格記録は**台帳と frontmatter の双方**に要る（片側だけの「別名の宙吊り」を塞ぐ）。
  const fm = parseFlatFrontmatter(raw)
  if (!fm || (fm.data.downgraded_at ?? '').trim() === '') {
    return { ok: false, reason: '提案 frontmatter に降格記録（downgraded_at）がありません' }
  }
  // 台帳側の降格時刻も検証する（検出核 hook と同一条件。降格履歴の監査可能性を担保）。
  const dAt = review.downgradedAt
  if (typeof dAt !== 'string' || dAt.trim() === '' || Number.isNaN(Date.parse(dAt))) {
    return { ok: false, reason: '台帳の降格時刻（downgradedAt）が欠落または解析不能です' }
  }
  const storedHash = review.proposalHash ?? ''
  const fromHash = review.downgradedFromHash ?? ''
  if (!storedHash || !fromHash || storedHash !== fromHash) {
    return { ok: false, reason: '降格元がレビュー対象 content と一致しません' }
  }
  const afterHash = review.downgradedContentHash ?? ''
  if (!afterHash || afterHash !== computeProposalHash(raw)) {
    return { ok: false, reason: '降格後に提案内容が変更されています' }
  }
  const restored = invertDowngradeText(raw)
  if (restored === null || computeProposalHash(restored) !== storedHash) {
    return { ok: false, reason: '降格操作で本文が改変されています（逆変換がレビュー対象と一致しません）' }
  }
  return { ok: true, reason: null }
}

/**
 * 採用直前にユーザーコメント側のゲートを評価する（`commentGate` / `commentStore` の薄い接続）。
 *
 * **ストアが読めないこと自体を hard block にする**（fail-closed）。
 * 「読めないから空とみなす」は、ストアを消せば無応答を消せるという迂回路になる。
 */
function evaluateCommentsForAdoption(
  requestId: string,
  raw: string,
  currentProposalHash: string,
  ack: { proposalHashAtAck?: string; commentsKey?: string } | undefined
): CommentAdoptionGateResult | null {
  const paths = defaultCommentStorePaths()
  const read = readCommentStore(paths)
  if (read.uninitialized) return null // 一度も作られていない ＝ コメント機能未使用
  if (read.problem) {
    return {
      passes: false,
      hardBlockers: [read.problem.reason],
      ackRequired: [],
      ackSatisfied: false,
      openCount: 0,
      warnings: [],
      commentsKey: '',
      commentAdoptionSnapshotKey: '',
      reason: read.problem.reason
    }
  }
  const comments = listComments(requestId, read)
  if (comments.length === 0 && !read.store?.repair) return null
  return evaluateCommentAdoptionGate({
    requestId,
    comments,
    currentContent: raw,
    currentProposalHash,
    repair: read.store?.repair ?? null,
    quarantineFileExists: quarantineFileMatches,
    snapshotMatches: (commentId, expected) => snapshotMatches(paths, requestId, commentId, expected),
    ack: ack ?? null
  })
}

/** 採用ゲート判定の結果（採用 IPC が適用前に評価する）。 */
export interface AdoptGateResult {
  /** レビューゲートでブロックすべきか（recommend 未承認 かつ override なし） */
  blocked: boolean
  /** ブロック理由（UI 表示用の安定キー。null=非ブロック） */
  reason:
    | 'review-required'
    | 'terminal-state'
    | 'findings-ack-required'
    | 'comments-unanswered'
    | 'comments-broken'
    | 'comments-ack-required'
    | null
  /** 判定に使った requestId（呼び出し側のログ/整合確認用） */
  requestId: string
  /** コメント系でブロックした場合の人間向け説明（UI がそのまま出せる） */
  commentDetail?: string
}

/**
 * 採用直前の atomic レビューゲート判定（main 集約）。1-read 版 `evaluateAdoptGateFromRaw` を
 * readFile して呼ぶ薄いラッパ。採用経路（skillProposals:adopt）は raw を1回だけ読み、ゲート判定と
 * ChangeRequest 導出を**同一 snapshot** で行う（proposal content の gate/apply 2-read TOCTOU 根治）。
 */
export async function evaluateAdoptGate(
  filePath: string,
  override: boolean,
  paths: ProposalStorePaths = getDefaultProposalStorePaths()
): Promise<AdoptGateResult> {
  const raw = await readFile(filePath, 'utf-8')
  return evaluateAdoptGateFromRaw(raw, filePath, override, paths)
}

/**
 * 採用ゲート本体（raw 受け）。terminal-state / request_id 重複 / 承認の content-hash 照合を評価する。
 * - adopted/rejected（確定）→ terminal-state block。
 * - 同フォルダ内に同一 request_id が複数 → fail closed（同時重複のなりすまし免除防止）。
 * - **content binding**: 承認記録の proposal_hash が現 content(raw) の hash と一致し、かつ verdict===approve の
 *   ときのみ免除。hash 無し(legacy)・不一致・未 approve は「承認された content と別物」＝未承認で fail closed
 *   （request_id 再利用による stale approve のなりすまし・単一 stale 再利用を根治）。override で強行可。
 * MD §5 の self-attested verdict は信頼しない（外部レビューストアのみ authoritative）。
 */
export async function evaluateAdoptGateFromRaw(
  raw: string,
  filePath: string,
  override: boolean,
  paths: ProposalStorePaths = getDefaultProposalStorePaths(),
  opts: {
    /**
     * 採用要求ごとに UI から明示的に渡す「指摘を承知した」ペイロード。
     * **永続化しない**（台帳に持たせると提案改稿・再レビュー時の invalidation 条件が新たな穴になる）。
     * 未指定 ＝ fail-closed。**boolean ではなく 3 値**にしてあるのは、ack が
     * 「いま画面に出ている内容」に対するものだと**サーバ側で再計算して照合**するため（レビュー r4#2）。
     */
    findingsAck?: FindingsAckPayload
    /**
     * コメント側の ack（`deferred` ack とは**次元を分けて**保持・評価する・r39#1）。
     * 全体一致で照合すると、コメントが stale 化しただけで既存の `deferred` ack まで巻き添え失効する。
     */
    commentsAck?: { proposalHashAtAck?: string; commentsKey?: string }
    /**
     * 大量走査時の O(N^2) I/O 爆発防止用事前読込キャッシュ (CCPIT_069 / C-1)。
     */
    preloadedStates?: Record<string, ProposalState>
    preloadedReviews?: Record<string, StoredProposalReview>
    preloadedRequestIdCounts?: Record<string, number>
  } = {}
): Promise<AdoptGateResult> {
  const parsed = parseProposalMdFromRaw(raw, filePath)
  const states = opts.preloadedStates ?? (await readProposalStates(paths))
  const state = parsed.requestId ? states[parsed.requestId] : undefined
  if (state === 'adopted' || state === 'rejected') {
    // terminal-state は override 対象外（確定済みの再採用は break-glass でも不可）
    return { blocked: true, reason: 'terminal-state', requestId: parsed.requestId }
  }
  // request_id 重複走査。fail-closed（Codex 最終レビュー finding#3）:
  // - 重複が**確認**された（dup>1）→ 無条件 block（override でも不可＝同時重複なりすまし免除防止）。
  // - 走査が**完遂できない**（フォルダ走査不能・個別 .md 読取失敗）→ 「重複なし」を証明できないので
  //   block。break-glass(override) でのみ強行可（強行は監査ログに記録される）。
  let scanIncomplete = false
  if (parsed.requestId) {
    let dup = 0
    if (opts.preloadedRequestIdCounts) {
      dup = opts.preloadedRequestIdCounts[parsed.requestId] ?? 0
    } else {
      try {
        const folder = dirname(filePath)
        for (const f of await readdir(folder)) {
          if (!f.toLowerCase().endsWith('.md')) continue
          try {
            const fmm = parseFlatFrontmatter(await readFile(join(folder, f), 'utf-8'))
            const rid = fmm ? (fmm.data.request_id ?? fmm.data.proposal_id ?? '') : ''
            if (rid === parsed.requestId) dup++
          } catch {
            scanIncomplete = true // 読めない .md は重複か否かを判定できない
          }
        }
      } catch {
        scanIncomplete = true // フォルダ走査不能 → 重複検証不能
      }
    }
    if (dup > 1) {
      return { blocked: true, reason: 'review-required', requestId: parsed.requestId }
    }
  }
  const reviews = opts.preloadedReviews ?? (await readProposalReviews(paths))
  const stored = parsed.requestId ? reviews[parsed.requestId] : undefined
  const storedVerdict = stored ? stored.verdict : ''
  // 解除条件は「レビュアーが approve と言ったか」ではなく「CC が指摘を裁定し切ったか」（刈り取り）。
  const harvest = evaluateHarvest(stored, raw)
  // **指摘つき（未裁定が残る降格ラベル）は override でも採用できない**（オーナー裁定 2026-08-07）。
  // 「承知のうえでの採用」を廃止したとき、出口は「方針を添えて差し戻す」「却下する」の
  // **2 つだけ**と定めた。break-glass を 3 つ目の出口として残すとその約束が崩れ、
  // 刈り取りループを迂回する穴が名前を変えて生き残る。
  // request_id 重複と同じ「override でも不可」の系列に置く（先例は上の dup > 1）。
  if (parsed.adoptionLabel === FINDINGS_ACK_LABEL && !harvest.ok) {
    return { blocked: true, reason: 'review-required', requestId: parsed.requestId }
  }

  /**
   * **ユーザーコメント系のゲート**（`user_comment_dialogue_plan.md`）。
   *
   * 「投げられた指摘に無応答のまま先へ進めない」という本レーンの芯を、
   * **指摘の出し手がユーザーであるときにも**適用する。
   *
   * **break-glass では免除しない**（`ackRequired` と同じ思想）。override は
   * 「ゲートを強行する鍵」であって「ユーザーの要望に答えた」ことの代替にならない。
   * だから `overriddenBlocks` へ積まず、ここで**無条件 return** する。
   */
  const commentGateResult = parsed.requestId
    ? evaluateCommentsForAdoption(parsed.requestId, raw, computeProposalHash(raw), opts.commentsAck)
    : null
  if (commentGateResult && !commentGateResult.passes) {
    const reason: AdoptGateResult['reason'] =
      commentGateResult.hardBlockers.length > 0
        ? 'comments-broken'
        : commentGateResult.openCount > 0
          ? 'comments-unanswered'
          : 'comments-ack-required'
    return {
      blocked: true,
      reason,
      requestId: parsed.requestId,
      commentDetail: commentGateResult.reason ?? undefined
    }
  }
  const overriddenBlocks: AdoptOverrideAuditEntry['overriddenBlocks'] = []
  if (needsReviewBeforeAdopt(parsed.adoptionLabel, harvest)) {
    overriddenBlocks.push('review-required-unapproved')
  }
  if (scanIncomplete) {
    overriddenBlocks.push('duplicate-scan-incomplete')
  }
  // 指摘承知の明示確認。break-glass とは**別経路**なので override では免除しない —
  // override は「ゲートを強行する」ための鍵であって「指摘を読んだ」ことの代替にはならない。
  // 対象は (1) 降格ラベル `recommend-with-findings` (2) 推奨だが `deferred` を含む提案。
  const ackRequired = needsFindingsAckBeforeAdopt(parsed.adoptionLabel, harvest)
  if (ackRequired) {
    if (parsed.adoptionLabel === FINDINGS_ACK_LABEL) {
      // **content 束縛は免除しない**（実装後 Codex レビュー chunk B の critical 指摘）。
      // §A-1(c) が免除するのは approve 必須までで、ハッシュ束縛は §4 禁則により不変。
      // 降格鎖が現 content に対して健全でなければ、ack があっても採用させない。
      const chain = evaluateDowngradeChain(raw, stored)
      if (!chain.ok) {
        return { blocked: true, reason: 'review-required', requestId: parsed.requestId }
      }
    }
    // ack は**いま画面に出ている内容**に対するものでなければならない（レビュー r4#2）。
    // 3 値を現在の raw と台帳から再計算して照合し、1 つでも違えば stale ack として拒否する。
    const expected = {
      proposalHash: computeProposalHash(raw),
      findingsHash: computeFindingsHash(stored?.findings ?? ''),
      adjudicationsKey: computeAdjudicationsKey(stored)
    }
    const got = opts.findingsAck
    if (
      !got ||
      // 承知の意思表示そのもの（r9#1）。内容束縛が合っていても、明示操作が無ければ通さない。
      got.accepted !== true ||
      got.proposalHash !== expected.proposalHash ||
      got.findingsHash !== expected.findingsHash ||
      got.adjudicationsKey !== expected.adjudicationsKey
    ) {
      return { blocked: true, reason: 'findings-ack-required', requestId: parsed.requestId }
    }
  }
  /**
   * findings 承知採用の監査を残す。**実際に採用を通す経路でのみ**呼ぶこと
   * （実装後 Codex レビュー r2-B#2 → r3-B#1 の往復で確定した位置）。
   * - 早すぎる append: 後段で block されても「承知して採用した」記録だけが残る（r3-B#1）
   * - 遅すぎる/片側だけの append: break-glass 併用時に記録が欠落する（r2-B#2）
   * 監査を残せなければ通さない（fail-closed。break-glass と同じ思想）。
   */
  const appendAckAuditIfNeeded = async (): Promise<boolean> => {
    if (!ackRequired) return true
    try {
      await appendFindingsAckAudit(
        {
          requestId: parsed.requestId,
          filePath,
          proposalHash: computeProposalHash(raw),
          adoptionLabel: parsed.adoptionLabel,
          storedVerdict,
          findingsHash: computeFindingsHash(stored?.findings ?? ''),
          findingsChars: stored?.findings ? stored.findings.length : 0,
          // 指摘そのものの全文（r8#1）。裁定理由は「指摘への応答」であって指摘ではないので、
          // これが無いと deferredIds が指す指摘の claim / impact / suggestion を復元できない。
          findingsSnapshot: stored?.findings ?? '',
          // --- 「何を承知して採用したか」を第三者が再構成できるだけの記録（r4#1・r5#1）---
          // 台帳の裁定理由は後から書き換えられるので、hash だけでは復元できない。
          // 短いテキストなので append-only 監査へ**全裁定の全文スナップショット**を焼き込む。
          adjudicationsFor: stored?.adjudicationsFor ?? '',
          adjudicationsKey: computeAdjudicationsKey(stored),
          adjudications: (stored?.adjudications ?? []).map((a) => ({
            id: a.id,
            decision: a.decision,
            reason: a.reason
          })),
          deferredIds: (stored?.adjudications ?? [])
            .filter((a) => a && a.decision === DECISION_DEFERRED)
            .map((a) => a.id),
          // 「何という同意操作だったか」（r9#2）。文言そのものは変わりうるので版を正本にする。
          ackKind: ackKindOf(parsed.adoptionLabel),
          ackTextVersion: ACK_TEXT_VERSION,
          ackLabelExpected: expectedAckLabel(ackKindOf(parsed.adoptionLabel), harvest.deferred.length),
          ackLabelShown: opts.findingsAck?.labelShown ?? '',
          acknowledgedAt: new Date().toISOString(),
          source: 'skillProposals:findings-ack'
        },
        paths
      )
      return true
    } catch {
      return false
    }
  }

  if (overriddenBlocks.length === 0) {
    if (!(await appendAckAuditIfNeeded())) {
      return { blocked: true, reason: 'findings-ack-required', requestId: parsed.requestId }
    }
    return { blocked: false, reason: null, requestId: parsed.requestId }
  }
  if (!override) {
    return { blocked: true, reason: 'review-required', requestId: parsed.requestId }
  }
  // break-glass 強行（Codex 最終レビュー finding#1）: 監査ログに append してから通す。
  // 監査を書けないなら通さない（fail-closed）——「記録なき強行」を作らない。
  try {
    await appendAdoptOverrideAudit(
      {
        requestId: parsed.requestId,
        filePath,
        proposalHash: computeProposalHash(raw),
        adoptionLabel: parsed.adoptionLabel,
        storedVerdict,
        overriddenBlocks,
        overriddenAt: new Date().toISOString(),
        source: 'skillProposals:adopt-gate'
      },
      paths
    )
  } catch {
    return { blocked: true, reason: 'review-required', requestId: parsed.requestId }
  }
  // break-glass で通す場合も、findings 承知採用なら承知記録を残してから通す。
  if (!(await appendAckAuditIfNeeded())) {
    return { blocked: true, reason: 'findings-ack-required', requestId: parsed.requestId }
  }
  return { blocked: false, reason: null, requestId: parsed.requestId }
}

/**
 * 配列 JSON の監査ログへ append する共通処理（破損時は退避して新規配列から継続）。
 * break-glass 監査と findings 承知採用監査の**両方**が使う（記録の作法を 1 箇所に保つ）。
 */
async function appendJsonArrayAudit(auditPath: string, entry: unknown): Promise<void> {
  let list: unknown[] = []
  if (existsSync(auditPath)) {
    try {
      const parsed = JSON.parse(await readFile(auditPath, 'utf-8')) as unknown
      if (Array.isArray(parsed)) list = parsed
      else throw new Error('not-array')
    } catch {
      // 監査ログ破損は黙って上書きしない——退避してから新規に積む（証跡温存）
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      await rename(auditPath, `${auditPath}.corrupt-${ts}`)
    }
  }
  list.push(entry)
  await mkdir(dirname(auditPath), { recursive: true })
  await writeFile(auditPath, JSON.stringify(list, null, 2), 'utf-8')
}

/** break-glass 監査ログへ append。 */
async function appendAdoptOverrideAudit(
  entry: AdoptOverrideAuditEntry,
  paths: ProposalStorePaths
): Promise<void> {
  await appendJsonArrayAudit(
    paths.overridesAuditPath ?? join(homedir(), '.ccpit', 'adopt-overrides.json'),
    entry
  )
}

/** findings 承知採用の監査ログへ append（break-glass とは別ストア）。 */
async function appendFindingsAckAudit(
  entry: FindingsAckAuditEntry,
  paths: ProposalStorePaths
): Promise<void> {
  await appendJsonArrayAudit(
    paths.findingsAckAuditPath ?? join(homedir(), '.ccpit', 'adopt-findings-ack.json'),
    entry
  )
}

/** 指定フォルダの提案 MD を全件パースし、状態と「既に採用済み」フラグを付与して返す。 */
export async function listProposals(
  folder: string,
  opts: ListProposalsOptions = {}
): Promise<ProposalSummary[]> {
  if (!existsSync(folder)) return []
  const entries = await readdir(folder, { withFileTypes: true })
  const mdFiles = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => join(folder, e.name))

  const resolvedStorePaths = opts.storePaths ?? getDefaultProposalStorePaths()
  const states = await readProposalStates(resolvedStorePaths)
  const reviews = await readProposalReviews(resolvedStorePaths)
  const goldenNamesSet = new Set(opts.goldenSkillNames ?? [])
  let adoptedNames = new Set<string>()
  try {
    const reg = await readAdoptedRegistry(opts.provenancePaths ?? getDefaultProvenancePaths())
    adoptedNames = new Set(reg.map((e) => e.name))
  } catch {
    adoptedNames = new Set() // レジストリ破損時は可視化フラグなしで続行
  }

  // 合成提案が golden へ昇格済みなら、その元提案は「反映済み（合成提案として）」。元提案の中身そのものは golden と
  // 一致しない（合成提案はそれより多くを含む）ので、ファイルの比較ではなく合成台帳（applied）で決める
  const appliedViaCompose = new Set<string>()
  for (const e of Object.values(readMergeLedger(getComposePaths(dirname(resolvedStorePaths.statesPath)).mergesPath).entries)) {
    if (e.status !== 'applied') continue
    for (const src of e.sources) appliedViaCompose.add(src.requestId)
  }

  const out: ProposalSummary[] = []
  for (const fp of mdFiles) {
    try {
      const raw = await readFile(fp)
      const parsed = parseProposalMdFromRaw(raw, fp)
      // レビューストアに当該 requestId の review があれば、MD §5（pending）を store 値で上書き（store が正）。
      const stored = parsed.requestId ? reviews[parsed.requestId] : undefined
      const effectiveReviewBox = stored
        ? {
            verdict: stored.verdict,
            findings: stored.findings,
            reviewerId: stored.reviewerId,
            ccRebuttal: stored.ccRebuttal
          }
        : parsed.reviewBox
      const proposalState = states[parsed.requestId] ?? 'candidate'
      // 刈り取り判定（content binding 込み）。verdict は外部レビューストア(stored)のみ authoritative
      // （MD §5 self-attest 不信）。UI 表示と実採用ゲート(evaluateAdoptGate)は同一関数を通す。
      const harvest = evaluateHarvest(stored, raw)
      const isCollision = parsed.skillName ? goldenNamesSet.has(parsed.skillName) : false
      // 同名衝突の「解決済み」は、手元と golden が同じか（旧）ではなく、提案の中身が golden に入っているか（W2）
      const goldenCollisionStatus: GoldenCollisionStatus = isCollision
        ? appliedViaCompose.has(parsed.requestId)
          ? 'applied'
          : await classifyProposalAgainstGolden({
              skillName: parsed.skillName,
              files: parsed.files ?? [],
              baseHash: parsed.baseHash,
              companionBaseHashes: parsed.companionBaseHashes,
              goldenSourceMap: opts.goldenSourceMap,
              goldenEnPathOf: opts.goldenEnPathOf,
              readFileFn: opts.readFileFn
            })
        : 'none'
      const goldenCollisionResolved = goldenCollisionStatus === 'applied'

      out.push({
        ...parsed,
        reviewBox: effectiveReviewBox,
        state: proposalState,
        alreadyAdopted: parsed.skillName ? adoptedNames.has(parsed.skillName) : false,
        goldenCollision: isCollision,
        goldenCollisionResolved,
        goldenCollisionStatus,
        // 確定状態(adopted/rejected)は採用ゲート対象外＝バッジを出さない。
        needsReview:
          proposalState !== 'adopted' &&
          proposalState !== 'rejected' &&
          needsReviewBeforeAdopt(parsed.adoptionLabel, harvest),
        harvest,
        adjudications: stored?.adjudications ?? [],
        gate: describeProposalGate(parsed.adoptionLabel, harvest, !!stored, proposalState),
        ackBinding: {
          proposalHash: computeProposalHash(raw),
          findingsHash: computeFindingsHash(stored?.findings ?? ''),
          adjudicationsKey: computeAdjudicationsKey(stored)
        }
      })
    } catch (err) {
      // 1 本の読込失敗で一覧全体を落とさない
      out.push({
        filePath: fp,
        requestId: '',
        target: '',
        skillName: '',
        sourceProject: '',
        createdAt: '',
        adoptionLabel: '',
        title: basename(fp),
        what: '',
        why: '',
        how: '',
        axes: [],
        reviewBox: { verdict: '', findings: '', reviewerId: '', ccRebuttal: '' },
        parseError: err instanceof Error ? err.message : String(err),
        // 読取自体に失敗した品。提案として解釈すらできていないので対象外扱い
        notAProposal: true,
        state: 'candidate',
        alreadyAdopted: false,
        goldenCollision: false,
        goldenCollisionResolved: false,
        goldenCollisionStatus: 'none',
        // parseError 品は採用不能（採用ゲート以前に adopt 経路に乗らない）。型充足のため false
        needsReview: false,
        harvest: {
          ok: false,
          code: 'no-review',
          reason: '提案がパースできません',
          findingCount: 0,
          rejected: [],
          deferred: []
        },
        adjudications: [],
        // パース不能品は採用経路に乗らない。空値 ＝ ack として成立しない（fail-closed）
        ackBinding: { proposalHash: '', findingsHash: '', adjudicationsKey: '' },
        gate: {
          hasValidApprove: false,
          state: 'not-gated',
          adoptBlockReason: '提案がパースできないため採用経路に乗りません',
          findingsAckRequired: false,
          // パース不能な提案はレビューにも出せない（依頼文を組めない）
          reviewButtonVisible: false,
          // 採用経路に乗らないので、採用時検査そのものが存在しない
          adoptTimeChecks: []
        }
      })
    }
  }
  // 採用推奨を上に、次に候補→保留→却下→採用済の順で見やすく
  const stateRank: Record<ProposalState, number> = {
    candidate: 0,
    held: 1,
    rejected: 2,
    adopted: 3
  }
  out.sort((a, b) => {
    if (a.state !== b.state) return stateRank[a.state] - stateRank[b.state]
    if (a.adoptionLabel !== b.adoptionLabel) {
      return a.adoptionLabel === 'recommend' ? -1 : b.adoptionLabel === 'recommend' ? 1 : 0
    }
    return a.filePath.localeCompare(b.filePath)
  })
  return out
}
