/**
 * 049 — 起動時照合の「確認経路」と「部分配置の記録」を決める純関数。
 *
 * `GoldenReconcileDialog.tsx` から判断だけを抜き出した層。UI も IPC も持たない。
 *
 * ## なぜ .tsx から出すか
 * vitest は `environment: 'node'`・include は `*.test.ts` のみ（`vitest.config.ts`）で、
 * `.tsx` は挙動を固定できない。そのため P5 の判断は配線ガードの**ソース正規表現検査**
 * （`__tests__/goldenReconcileDialogWiring.test.ts`）でしか守られておらず、
 * 正規表現は条件式の**綴りを固定するだけで、条件の正しさは検査しない**。
 * 実際そのガードは `res.blocked || res.failed.length > 0` という欠陥条件を
 * toContain で固定してしまっていた（skipped を見ないため部分配置を成功として閉じる）。
 * 判断を純関数にすれば、綴りではなく帰結を固定できる。
 *
 * ## 守る不変条件
 * 1. **承認なしで書かない** — 提示しただけで適用要求が組み立つ経路を作らない。
 * 2. **部分失敗を正直に数える** — 成功・失敗・見送りを別々に持ち、
 *    「全部やった」と言えるのは要求した全件が実際に書けたときだけ。
 */

/** `goldenManifest.ts` の `ReconcileCase` と同一の集合（renderer は main を import しない）。 */
export type ReconcileCase =
  | 'unchanged'
  | 'auto-update'
  | 'user-modified'
  | 'conflict'
  | 'new'
  | 'restore'

/** `goldenManifest.ts` の `FileOwner` と同一の集合。 */
export type ReconcileOwner = 'golden' | 'adopted' | 'user' | 'promoted'

/** 何も書けなかった理由（fail-closed）。`ApplyReconcileBlocked` と同一。 */
export type ApplyBlockedReason = 'source-unreadable' | 'path-collisions'

/** 確認ダイアログ 1 行分。`PendingReconcileEntry` の renderer 側の写し。 */
export interface PendingEntry {
  path: string
  case: ReconcileCase
  owner: ReconcileOwner
  willBackup: boolean
  /** 適用すると配置先の内容が変わるか。偽なら得るものも失うものも無い（ADR 0002） */
  wouldChangeContent: boolean
  /** 台帳に配置記録があるか。偽なら「上流が進んだか」を判定できない */
  hasBaseRecord: boolean
  /** 配布元に新規性があるか。偽なら上書きは純粋な巻き戻し */
  upstreamAdvanced: boolean
}

/**
 * `goldenApplyReconcile` の戻り。`ApplyReconcileResult` の構造的な写し。
 *
 * `skipped` は「要求したが書かなかった」の意（再照合で対象外になった / 適用直前に
 * 配置先が変わった）。**失敗ではないが、成功でもない**。
 */
export interface ApplyResultLike {
  applied: string[]
  failed: { path: string; message: string }[]
  backups: string[]
  skipped: string[]
  manifestUpdated: boolean
  blocked?: ApplyBlockedReason
}

/** 成功・失敗・見送りを混ぜずに持つ件数。 */
export interface ApplyCounts {
  requested: number
  applied: number
  failed: number
  skipped: number
  backups: number
}

export interface ApplyOutcome {
  /** 要求した全件が実際に書けたか。これが偽なら「適用しました」と言ってはいけない */
  complete: boolean
  /**
   * 結果を必ず見せるか。**`complete` の否定として導出する**。
   *
   * 独立したフラグにすると「未完了なのに黙って閉じる」状態が表現可能になり、
   * それはまさに 049 で起きた事象そのもの。導出にして構造的に作れなくする。
   */
  mustSurface: boolean
  counts: ApplyCounts
  /** 要求したのに適用されなかった相対パス（整列済み・重複なし） */
  unresolved: string[]
  blocked?: ApplyBlockedReason
}

/** 出現順を保ったまま重複を落とす。 */
function dedupe(paths: readonly string[]): string[] {
  return [...new Set(paths)]
}

/**
 * 確認ダイアログの承認を、適用要求のパス集合へ変換する。
 *
 * `approved` が偽の間は**常に空**。「提示された entries をそのまま IPC へ渡す」
 * という書き方だと、承認の有無と要求の組み立てが別々の場所に散り、
 * 片方だけ壊れたときに無承認適用が成立してしまう。ここで 1 か所に閉じる。
 *
 * 部分選択は受け付けない（仕様の選択肢は OK / 後で の 2 つ）。承認とは
 * **提示した集合そのもの**への承認であり、部分集合を作る経路を持たない。
 */
export function approvedPaths(entries: readonly PendingEntry[], approved: boolean): string[] {
  if (!approved) return []
  return dedupe(entries.map((e) => e.path))
}

/**
 * 適用結果を、UI がそのまま信じてよい形へ要約する。
 *
 * `unresolved` は「`failed` と `skipped` の和」ではなく **「要求 − 適用済み」** で出す。
 * main 側が取りこぼしをどちらにも積まずに返した場合でも、UI が「全部やった」と
 * 言わないようにするため。集合の差で出せば、報告漏れがあっても安全側へ倒れる。
 *
 * `applied` は要求との積で数える。要求していないパスが返ってきても件数を水増ししない。
 */
export function summarizeApply(requested: readonly string[], res: ApplyResultLike): ApplyOutcome {
  const want = dedupe(requested)
  const wantSet = new Set(want)
  const appliedSet = new Set(dedupe(res.applied).filter((p) => wantSet.has(p)))

  const unresolved = want.filter((p) => !appliedSet.has(p)).sort()
  const complete = unresolved.length === 0 && res.blocked === undefined

  return {
    complete,
    mustSurface: !complete,
    counts: {
      requested: want.length,
      applied: appliedSet.size,
      failed: res.failed.length,
      skipped: res.skipped.length,
      backups: res.backups.length
    },
    unresolved,
    ...(res.blocked !== undefined ? { blocked: res.blocked } : {})
  }
}

/**
 * 未解決分の行だけを、提示順のまま取り出す。
 *
 * ダイアログを閉じてよいのは `outcome.complete` のときだけで、そうでなければ
 * ここが返す行をそのまま再提示する。現行の `.tsx` は pull が `useEffect` の
 * 一回きりで `dismissed` も不可逆なため、未解決が残っていても二度と出てこない
 * （049 の「確認消失」）。何を残すかの判断を UI から出しておく。
 *
 * `unresolved` は文字列の集合でしかないので、UI 側で行を組み立て直すと
 * `case` / `owner` / `willBackup` を推測で埋める羽目になる。**元の行を絞り込むだけ**
 * にして、作れないようにする。提示に無いパスが未解決なら、行にはしない
 * （それは表示ではなく `counts` と `unresolved` が伝えるべき事実）。
 *
 * 入力は変更しない。再提示のたびに元の集合が痩せると、
 * 「残っているのに出てこない」が再発するため。
 */
export function remainingEntries(
  entries: readonly PendingEntry[],
  outcome: ApplyOutcome
): PendingEntry[] {
  const unresolved = new Set(outcome.unresolved)
  return entries.filter((e) => unresolved.has(e.path))
}

/* ------------------------------------------------------------------ *
 * ADR 0002 — 危険度の分類と、行ごとの出口の組み立て
 * ------------------------------------------------------------------ */

/**
 * 提示 1 行の「適用したら何が起きるか」。
 *
 * `case`（ケース表）は `U` vs `G_new` を見ていないため、**内容が変わるかどうかを語れない**。
 * 実測（2026-09-07）では「衝突」表示の 2 件が内容差ゼロ、「ユーザー編集」表示の 2 件だけが実損で、
 * ラベルが危険度と逆相関していた。ここで真偽値から危険度そのものを導出する。
 */
export type ReconcileImpact =
  /** 適用しても内容が変わらない。台帳がずれているだけ */
  | 'no-op'
  /** 手元だけが新しい。上書きは純粋な巻き戻しで、得るものが無い */
  | 'rollback'
  /** 双方に変化がある。ADR 0001 が想定した通常系 */
  | 'merge'
  /** 配置記録が無く、手元の素性が判らない */
  | 'unknown-base'

/**
 * 3 つの真偽値から危険度を決める**全域関数**。
 *
 * 分岐順が意味を持つ: 内容が変わらないなら他の情報は要らない（問う必要が無い）。
 * 次に「基準があるか」を見る — 基準が無ければ上流の前進を判定できないので、
 * `upstreamAdvanced` の値に関わらず `unknown-base` に倒す（推測で語らない）。
 */
export function classifyImpact(e: {
  wouldChangeContent: boolean
  hasBaseRecord: boolean
  upstreamAdvanced: boolean
}): ReconcileImpact {
  if (!e.wouldChangeContent) return 'no-op'
  if (!e.hasBaseRecord) return 'unknown-base'
  return e.upstreamAdvanced ? 'merge' : 'rollback'
}

/** 行ごとの出口。`ReconcileAction`（main 側）と同一の集合。 */
export type ReconcileAction = 'apply' | 'promote' | 'unmanage' | 'defer'

/**
 * 確認ダイアログの各行で選べる選択肢。
 * `ReconcileAction`（4 出口）に、書かない出口 `consult`（Claude Code に相談）を足したもの。
 * `consult` は main に渡る前に `defer` へ写される（ADR 0003）。
 */
export type RowChoice = ReconcileAction | 'consult' | 'propose'

export interface ReconcileDecision {
  path: string
  action: ReconcileAction
}

/**
 * その行で選べる出口。
 *
 * `unknown-base` から `promote` を外しているのは非対称に見えるが、根拠がある:
 * 反映は「手元の方が配布元より新しい」という主張であり、配置記録が無ければ裏付けられない。
 * とくに台帳が破損すると確認対象が**全件**この状態になるため、ここを開けておくと
 * 「配置先の現状を丸ごと配布物として固定する」一括操作が成立してしまう。
 * 上書き・後で・問わないは残るので、ユーザーが行き止まりになることはない。
 * （main 側の `resolvePendingReconcile` も同じ判定で拒否する。表示層だけの制限にしない）
 */
export function allowedActions(impact: ReconcileImpact): ReconcileAction[] {
  if (impact === 'unknown-base') return ['apply', 'defer', 'unmanage']
  return ['apply', 'promote', 'defer', 'unmanage']
}

/** 相談出口を選べるか（差分の無い no-op 行には出さない・AC1）。 */
export function consultAllowed(impact: ReconcileImpact): boolean {
  return impact !== 'no-op'
}

/** 提案出口を選べるか（手元のみ最新 rollback または双方変更 merge、かつ基準記録があること・AC1）。 */
export function proposeAllowed(impact: ReconcileImpact, hasBaseRecord: boolean = true): boolean {
  return (impact === 'rollback' || impact === 'merge') && hasBaseRecord
}

/**
 * ダイアログの各行で選べる選択肢（ADR 0003 / 0004）。
 * no-op 以外の行に `consult` が加わり、基準のある rollback/merge に `propose` が加わる。
 */
export function allowedChoices(impact: ReconcileImpact, hasBaseRecord: boolean = true): RowChoice[] {
  const base = allowedActions(impact) as RowChoice[]
  const choices: RowChoice[] = [...base]
  if (proposeAllowed(impact, hasBaseRecord)) {
    choices.push('propose')
  }
  if (consultAllowed(impact)) {
    choices.push('consult')
  }
  return choices
}

/**
 * 提示行と選択状態から「Claude Code に相談」が選ばれたパス一覧（重複なし）を抜き出す。
 * 起動 IPC に渡す引数となる（配線ガード固定対象）。
 */
export function consultPaths(
  entries: readonly PendingEntry[],
  chosen: Readonly<Record<string, RowChoice>>
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const e of entries) {
    if (seen.has(e.path)) continue
    seen.add(e.path)
    const impact = classifyImpact(e)
    if (chosen[e.path] === 'consult' && consultAllowed(impact)) {
      out.push(e.path)
    }
  }
  return out
}

/**
 * 提示行と選択状態から「golden へ提案」が選ばれたパス一覧（重複なし）を抜き出す（AC23）。
 */
export function proposePaths(
  entries: readonly PendingEntry[],
  chosen: Readonly<Record<string, RowChoice>>
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const e of entries) {
    if (seen.has(e.path)) continue
    seen.add(e.path)
    const impact = classifyImpact(e)
    if (chosen[e.path] === 'propose' && proposeAllowed(impact, e.hasBaseRecord)) {
      out.push(e.path)
    }
  }
  return out
}

/**
 * 既定の出口。**既定でよければ操作は「実行」1 回で済む**ようにする。
 *
 * `rollback` の既定を `promote` にするのが本件の主目的。
 * `merge` / `unknown-base` の既定は `apply` ＝ **現行と同じ挙動**（無回帰）。
 */
export function defaultAction(impact: ReconcileImpact): ReconcileAction {
  return impact === 'rollback' ? 'promote' : 'apply'
}

/**
 * 提示行と選択状態から、実行要求を組み立てる**唯一の入口**。
 *
 * ## 未設定状態を作らない
 * 元の実装は「提示集合そのものへの承認」という all-or-nothing だった。その設計意図は
 * 「チェックボックスで部分状態を作ると仕様外の状態が増える」＝**未定義状態**の忌避であって、
 * 粒度そのものの否定ではない。ここでは各行が**必ず 1 つの出口を持つ**（未選択は既定へ落ちる）
 * ので、「選ばれていない行」という曖昧な状態は表現できない。
 *
 * ## 選択が不正なら既定へ倒す
 * 許可されていない出口（例: `unknown-base` への `promote`）が渡された場合は既定へ落とす。
 * ここで通してしまうと main 側の拒否に頼ることになり、UI と main で判断が二重化する。
 *
 * ## consult は defer へ、propose は promote へ写す（ADR 0003 / 0004）
 * `consult` は main の書込経路には渡さず `defer`（後で）として記録する。
 * `propose` は main の書込経路 `goldenResolveReconcile` には `promote` として渡す（AC2）。
 */
export function buildDecisions(
  entries: readonly PendingEntry[],
  chosen: Readonly<Record<string, RowChoice>>
): ReconcileDecision[] {
  const seen = new Set<string>()
  const out: ReconcileDecision[] = []
  for (const e of entries) {
    if (seen.has(e.path)) continue
    seen.add(e.path)
    const impact = classifyImpact(e)
    const want = chosen[e.path]
    let action: ReconcileAction
    if (want === 'propose' && proposeAllowed(impact, e.hasBaseRecord)) {
      action = 'promote'
    } else if (want === 'consult' && consultAllowed(impact)) {
      action = 'defer'
    } else if (
      want !== undefined &&
      want !== 'consult' &&
      want !== 'propose' &&
      allowedActions(impact).includes(want)
    ) {
      action = want
    } else {
      action = defaultAction(impact)
    }
    out.push({ path: e.path, action })
  }
  return out
}

/** 全行を同じ出口にする（フッターの「後で（全件）」用）。 */
export function uniformDecisions(
  entries: readonly PendingEntry[],
  action: ReconcileAction
): ReconcileDecision[] {
  const seen = new Set<string>()
  const out: ReconcileDecision[] = []
  for (const e of entries) {
    if (seen.has(e.path)) continue
    seen.add(e.path)
    out.push({ path: e.path, action })
  }
  return out
}

/** `goldenResolveReconcile` の戻り。`ResolveReconcileForAppResult` の構造的な写し。 */
export interface ResolveResultLike {
  applied: string[]
  promoted: string[]
  unmanaged: string[]
  deferred: string[]
  failed: { path: string; message: string }[]
  backups: string[]
  skipped: { path: string; reason: string }[]
  overlayDir: string
  overlayDurable: boolean
  manifestUpdated: boolean
  blocked?: ApplyBlockedReason
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

export interface ResolveCounts {
  requested: number
  applied: number
  promoted: number
  unmanaged: number
  deferred: number
  failed: number
  skipped: number
  backups: number
}

export interface ResolveOutcome {
  /** 要求した全行が**意図どおりの出口**へ着いたか。偽なら「やりました」と言ってはいけない */
  complete: boolean
  /** 結果を必ず見せるか。`complete` の否定として導出する（黙って閉じる状態を作れなくする） */
  mustSurface: boolean
  counts: ResolveCounts
  /** 意図どおりに処理されなかった rel（整列済み・重複なし） */
  unresolved: string[]
  /** 反映が 1 件でもあったか（反映先の所在を示す必要があるか） */
  didPromote: boolean
  blocked?: ApplyBlockedReason
}

/**
 * 実行結果を、UI がそのまま信じてよい形へ要約する。
 *
 * ## 「成功」の定義は出口ごとに違う
 * 単に「エラーが無かった」ではなく、**その行が選んだ出口の結果配列に入っていること**を見る。
 * `apply` を選んだ行が `deferred` に入っていたら、それは成功ではない。
 * 集合の差で数えるので、main 側が取りこぼしをどこにも積まずに返した場合でも安全側へ倒れる
 * （`summarizeApply` と同じ設計・049 の再演防止）。
 */
export function summarizeResolve(
  decisions: readonly ReconcileDecision[],
  res: ResolveResultLike
): ResolveOutcome {
  const bucket: Record<ReconcileAction, Set<string>> = {
    apply: new Set(res.applied),
    promote: new Set(res.promoted),
    unmanage: new Set(res.unmanaged),
    defer: new Set(res.deferred)
  }
  const seen = new Set<string>()
  const unresolved: string[] = []
  for (const d of decisions) {
    if (seen.has(d.path)) continue
    seen.add(d.path)
    if (!bucket[d.action].has(d.path)) unresolved.push(d.path)
  }
  unresolved.sort()
  const complete = unresolved.length === 0 && res.blocked === undefined

  const requestedSet = seen
  const countIn = (arr: string[]): number => arr.filter((p) => requestedSet.has(p)).length

  return {
    complete,
    mustSurface: !complete,
    counts: {
      requested: requestedSet.size,
      applied: countIn(res.applied),
      promoted: countIn(res.promoted),
      unmanaged: countIn(res.unmanaged),
      deferred: countIn(res.deferred),
      failed: res.failed.length,
      skipped: res.skipped.length,
      backups: res.backups.length
    },
    unresolved,
    didPromote: countIn(res.promoted) > 0,
    ...(res.blocked !== undefined ? { blocked: res.blocked } : {})
  }
}

/** 未解決分の行だけを、提示順のまま取り出す（`remainingEntries` の解決版）。 */
export function remainingAfterResolve(
  entries: readonly PendingEntry[],
  outcome: ResolveOutcome
): PendingEntry[] {
  const unresolved = new Set(outcome.unresolved)
  return entries.filter((e) => unresolved.has(e.path))
}

/** `goldenLaunchMergeConsult` の戻りの構造的な写し。 */
export interface ConsultLaunchLike {
  ok: boolean
  error?: string
  promptFilePath?: string
  shell?: string
  appliedFlags?: string[]
  rejectedSettings?: string[]
  subjects?: string[]
  proposals?: number
}

/**
 * 起動失敗を、結果パネルがそのまま信じてよい形にする。
 *
 * 起動に失敗したら決定は実行しない（相談行を `defer` で書くと「相談した」ように見える記録が残る）。
 * よって resolve の結果は無く、ここで「要求した全行が未解決」の形を作って必ず見せる。
 * 対象は次回起動の再分類で再提示される（台帳には何も書いていないので失われない）。
 */
export function consultLaunchFailure(
  paths: readonly string[],
  message: string
): { report: ResolveResultLike; outcome: ResolveOutcome } {
  const unresolved = [...new Set(paths)].sort()
  const report: ResolveResultLike = {
    applied: [],
    promoted: [],
    unmanaged: [],
    deferred: [],
    failed: [{ path: '*', message }],
    backups: [],
    skipped: [],
    overlayDir: '',
    overlayDurable: true,
    manifestUpdated: false
  }
  const outcome: ResolveOutcome = {
    complete: false,
    mustSurface: true,
    counts: {
      requested: unresolved.length,
      applied: 0,
      promoted: 0,
      unmanaged: 0,
      deferred: 0,
      failed: 1,
      skipped: 0,
      backups: 0
    },
    unresolved,
    didPromote: false
  }
  return { report, outcome }
}
