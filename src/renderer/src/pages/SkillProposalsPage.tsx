import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FolderOpen,
  RefreshCw,
  Check,
  X,
  PauseCircle,
  AlertTriangle,
  ShieldCheck,
  Settings,
  Play,
  Copy,
  CheckCircle2,
  Search,
  HelpCircle
} from 'lucide-react'
import { Button } from '../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '../components/ui/dialog'
import { CommentThread } from '../components/proposals/CommentThread'
import { DialogueSettingsDialog } from '../components/proposals/DialogueSettingsDialog'
import { cn } from '../lib/utils'
import {
  getGoldenCollisionCardModel,
  getGoldenCollisionHelp,
  executeGoldenCollisionAction
} from '../lib/skillProposalCollisionCard'
import {
  composeFlowOwnsPrimary,
  composeFlowSteps,
  composeStatusView,
  pickStatusForSkill
} from '../lib/composeStatusView'
import {
  deriveCaseView,
  isComposeInProgress,
  seqsToReportForDisplay,
  openReceptacles,
  receptacleBadgeLabel,
  sourceNoteFor
} from '../lib/composeCaseView'
import { ComposeCaseCard, ComposeStaleNotice, ReceptaclePanel } from '../components/ComposeCaseCard'
import { ComposeStartingNotice } from '../components/ComposeActivityIndicator'
import { runComposeStart } from '../lib/composeStartFlow'
import {
  COMPOSE_POLL_INTERVAL_MS,
  type ReceptacleClosedHow,
  type ReceptacleSummary
} from '../../../shared/composeContract'
import { requestNavigate, setPromotionPreselect } from '../lib/composeNavigation'
import {
  canSubmitPicker,
  defaultPickerSelection,
  pickerReasonText,
  pickerSubmitIds,
  togglePickerSelection,
  type PickerItem
} from '../lib/composePicker'

type Proposal = Awaited<ReturnType<typeof window.api.skillProposalsList>>[number]
type ComposeStatus = Awaited<ReturnType<typeof window.api.skillProposalsComposeStatus>>[number]
type ProposalState = Proposal['state']

// v2: 集約先 ~/.ccpit/proposals/ への移行に伴い新キー。旧キー(_Prompt 残骸)は参照しない（クリーンブレイク）
const STORAGE_KEY_FOLDER = 'ccpit-skill-proposals-folder-v2'

export function SkillProposalsPage(): React.JSX.Element {
  const { i18n } = useTranslation()
  const ja = i18n.language.startsWith('ja')
  const L = (j: string, e: string): string => (ja ? j : e)

  const [folder, setFolder] = useState<string>('')
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [searchQuery, setSearchQuery] = useState('') // H-5: 部分一致検索
  const [selected, setSelected] = useState<Proposal | null>(null)
  const [skillBody, setSkillBody] = useState<string>('')
  const [proposedFiles, setProposedFiles] = useState<Array<{ path: string; content: string }>>([])
  const [password, setPassword] = useState('')
  const [hasPassword, setHasPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  /** L0_012: 「まとめて合成」を押してから IPC の復帰と状態の取り直しまで（ダイアログに「準備中」を出す） */
  const [composeStarting, setComposeStarting] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null)
  // 未レビュー recommend の break-glass（独立レビュー未実施でも承知で採用する明示確認）
  const [reviewOverride, setReviewOverride] = useState(false)
  // 指摘承知採用（降格ラベル or 推奨のまま据え置きあり）の明示確認。break-glass とは別経路。
  const [findingsAck, setFindingsAck] = useState(false)
  // golden 同名カード: 「？」の説明ダイアログと、「何も適用されない」確認の待ち（対象の requestId）
  const [collisionHelpOpen, setCollisionHelpOpen] = useState(false)
  const [markAckPendingId, setMarkAckPendingId] = useState<string | null>(null)
  // 提案の合成（golden 同名 skill の提案を今の golden に重ねて 1 本にする）の進み具合
  const [composeStatuses, setComposeStatuses] = useState<ComposeStatus[]>([])
  // 状態を最後に取れた時刻（renderer の時計）。進行中に COMPOSE_UPDATE_SLO_MS を超えたら「更新待ち」を出す
  const [composeFetchedAt, setComposeFetchedAt] = useState<number | null>(null)
  // 受け皿（原文への指摘の置き場）の一覧
  const [receptacles, setReceptacles] = useState<ReceptacleSummary[]>([])
  // 描画を main に報告済みの seq（同じ seq を 2 回送らない）と、直前に表示していた作業場
  const reportedSeqs = useRef<Set<number>>(new Set())
  const displayedWorkspace = useRef<string | null>(null)
  const displayedCaseId = useRef<string | null>(null)
  // 状態の取り直しの世代。古い取得が新しい取得の後に解決しても、画面を後退させない
  const fetchStarted = useRef(0)
  const fetchApplied = useRef(0)
  // 合成の元提案の選択ダイアログ（既定は選べる提案を全件選択。実行は「まとめて合成」の 1 つ）
  const [picker, setPicker] = useState<{ skillName: string; items: PickerItem[]; selected: Set<string> } | null>(null)
  /**
   * ユーザーコメント → CC 対話のスレッド。
   *
   * **親がここで単一 state として所有する。** 子（CommentThread）に fetch させると、
   * スレッド表示と `adoptBlockers()` が別々の読み取り結果に基づき、投稿直後に
   * 「未応答なのに採用ボタンが押せる」ズレが出る（Plan Codex レビュー finding#3）。
   *
   * 旧「方針を添えて差し戻す」の textarea はここへ統合して廃止した。
   * あれは `useState` に置くだけで保存されず、別候補を選ぶと消え、送った記録も残らなかった
   * （＝設計収束までの一時しのぎ・commit 38a9bab）。同じ入力が、いまは
   * 永続化され・履歴が残り・CC に応答義務が生じる。
   */
  const [commentView, setCommentView] = useState<{
    /** どの提案のスレッドか。**選択中と一致しなければ使わない**（実装レビュー finding#4） */
    requestId: string
    status: 'loading' | 'ready' | 'error'
    view: Awaited<ReturnType<typeof window.api.skillProposalsCommentThread>> | null
  } | null>(null)
  /**
   * コメント応答の ack。**findings ack とは別 state**（実装レビュー finding#1）。
   *
   * 当初 `findingsAck` を流用したが、それでは「stale な応答だけがあり findings ack は不要」な
   * 提案で、ack するチェックボックスが**画面に存在しない**（findings 用は
   * `gate.findingsAckRequired` のときしか描画されない）ため、**ack できず採用もできない
   * 行き止まり**が生まれていた。Plan レビューで自分が「回復不能状態を作る」と退けたのと
   * 同じ失敗を実装側で作っていた。main と同じく次元を分ける。
   */
  const [commentsAck, setCommentsAck] = useState(false)
  /**
   * IPC 越しに来る刈り取り情報の既定値。
   *
   * **main が古い場合に `undefined` が来る**（electron-vite の dev は main を自動リロードしないので、
   * 「renderer だけ新しい」状態が起きる。版ずれ・IPC 失敗でも同じ形になる）。
   * 2026-08-06 に、ここを存在前提で読んでいたためアプリ全体がブランクになった。
   * **黙って隠さない**（下の警告表示とセット）。握り潰すと別の無言バグになる。
   */
  const harvestOf = (p: Proposal): NonNullable<Proposal['harvest']> =>
    p.harvest ?? {
      ok: false,
      code: 'unavailable',
      reason: null,
      findingCount: 0,
      rejected: [],
      deferred: []
    }
  /** 一覧データが旧形式（main が古い）かどうか。ユーザーへ提示するために判定する。 */
  const isStaleShape = (p: Proposal | null): boolean => !!p && (!p.harvest || !p.ackBinding)

  /**
   * 採用ボタンを押せない理由（**ボタンの disabled と同一ソース**）。
   *
   * 以前は「採用可否: ゲート上は可」とだけ出していたが、それだと
   * (a) ゲート以外の理由でボタンが押せないとき理由が分からない
   * (b) 「ゲート上は」が何を保留した言い方なのかも分からない
   * という二重の不親切だった（maintainer指摘 2026-08-07）。
   * **表示と disabled を別々に書くと必ずずれる**ので、この 1 関数から両方を導く。
   */
  const adoptBlockers = (p: Proposal): string[] => {
    const out: string[] = []
    if (busy) out.push(L('処理中です', 'busy'))
    if (!passwordOk) out.push(L('認証パスワードが未入力です', 'password not entered'))
    if (p.state === 'adopted') out.push(L('この提案は採用済みです', 'already adopted'))
    if (p.state === 'rejected') out.push(L('この提案は却下済みです', 'already rejected'))
    if (p.goldenCollision)
      out.push(
        L(
          'golden 配布の skill と同名のため直接採用できません（統合を相談するか、提案名を変更してください）',
          'Same name as a golden skill; cannot adopt directly (consult merge or rename proposal)'
        )
      )
    // alreadyAdopted は**ブロッカーではない**（更新採用経路 Step 3.65 が CAS 検証＋
    // 圧縮アーカイブ＋swap で差し替える）。文脈はバッジ・更新パネル・ボタン文言で示す。
    // 旧挙動（同名採用済み＝採用不可）に戻すとすげ替え運用が全部手作業に退行するので注意。
    if (p.needsReview && !reviewOverride)
      out.push(
        p.gate.adoptBlockReason ??
          L('独立レビューを通過していません', 'has not cleared the independent review')
      )
    if (p.gate.findingsAckRequired && !findingsAck)
      out.push(L('指摘承知のチェックが未です', 'the acknowledgement checkbox is unchecked'))
    // --- ユーザーコメント系（main の evaluateCommentsForAdoption と同じ読み取り結果から導く）---
    // **break-glass では免除されない**。未応答のまま採用へ進めないのが本機能の芯（設計 §2）。
    //
    // finding#4: スレッドが**未取得・取得中・取得失敗**のときは「コメント無し」と見なさない。
    // 見なすと、未応答コメントがあるのにボタンが押せて main で弾かれる（＝直したはずの症状の再生産）。
    const cStatus = commentStatusFor(p)
    if (cStatus === 'loading') out.push(L('コメントを読み込み中です', 'loading comments'))
    if (cStatus === 'error' || cStatus === 'none')
      out.push(
        L(
          'コメントの状態を確認できていません（再読み込みしてください）',
          'the comment state could not be determined (please refresh)'
        )
      )
    const cv = commentViewFor(p)
    const cg = cv?.gate ?? null
    if (cv?.storeProblem)
      out.push(L('コメントストアを読めません', 'the comment store cannot be read'))
    if (cv?.repairPending)
      out.push(L('コメントストアの修復が未確認です', 'a comment-store repair is unacknowledged'))
    if (cg && cg.hardBlockers.length > 0)
      out.push(
        L(
          `壊れたコメントレコードがあります（${cg.hardBlockers.length} 件）`,
          `there are broken comment records (${cg.hardBlockers.length})`
        )
      )
    if (cg && cg.openCount > 0)
      out.push(
        L(
          `未応答のコメントが ${cg.openCount} 件あります`,
          `${cg.openCount} comment(s) are awaiting a CC response`
        )
      )
    if (cg && cg.ackRequired.length > 0 && !commentsAck)
      out.push(
        L(
          `コメント応答の確認（ack）が未です（${cg.ackRequired.length} 件）`,
          `${cg.ackRequired.length} comment response(s) need acknowledgement`
        )
      )
    return out
  }

  /**
   * コメント側 ack のペイロード。**findings ack とは次元を分けて送る**（r39#1）。
   * 値は画面に出ていたものをそのまま返し、main が採用時に再計算して照合する。
   */
  const commentsAckPayload = (
    p: Proposal
  ): { proposalHashAtAck: string; commentsKey: string } | undefined => {
    const cg = commentViewFor(p)?.gate
    if (!cg || cg.ackRequired.length === 0 || !commentsAck) return undefined
    if (!p.ackBinding?.proposalHash || !cg.commentsKey) return undefined
    return { proposalHashAtAck: p.ackBinding.proposalHash, commentsKey: cg.commentsKey }
  }

  /**
   * 同意チェックボックスの文言。表示と監査記録の**二重定義を作らない**ため 1 箇所で組む。
   * main は版（ACK_TEXT_VERSION）を正本として記録し、この文字列は「UI が実際に見せた文言」として残す。
   */
  const ackLabel = (p: Proposal): string =>
    !p.reviewBox.findings
      ? L(
          'findings が記録されていないため確認できません（再レビューが必要）',
          'No findings recorded — cannot acknowledge (re-review required)'
        )
      : harvestOf(p).deferred.length > 0
        ? L(
            `承認(approve)されていないが承知の上で採用する（妥当と認めたうえで未修正の指摘 ${harvestOf(p).deferred.length} 件）`,
            `Adopt without approval, acknowledging ${harvestOf(p).deferred.length} valid but unfixed finding(s)`
          )
        : L('上記 findings を確認した（承知のうえ採用する）', 'I have reviewed the findings above')
  // レビュアー（codex companion）の可用性。不在なら素通しさせずボタンを不能化して理由を出す。
  const [reviewerStatus, setReviewerStatus] = useState<{
    available: boolean
    version?: string
    detail?: string
  } | null>(null)
  // レビュー実行中の提案 filePath（同時 1 件）
  const [reviewingPath, setReviewingPath] = useState<string | null>(null)
  // 対話 CC 設定ダイアログ（全提案共通の 1 設定）
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 解析エラー修復起動の状態（ファイル単位・D9, AC10, AC15, AC16）
  const [repairState, setRepairState] = useState<
    Record<
      string,
      {
        waiting: boolean
        appliedFlags?: string[]
        rejectedSettings?: string[]
        detectedSettings?: string[]
        planWarning?: boolean
      }
    >
  >({})
  const [repairLaunching, setRepairLaunching] = useState(false)

  const reload = useCallback(async (dir: string): Promise<Proposal[]> => {
    if (!dir) {
      setProposals([])
      return []
    }
    setBusy(true)
    try {
      const list = await window.api.skillProposalsList(dir)
      setProposals(list)
      setSelected((cur) => {
        if (!cur) return null
        const updated = list.find((item) => item.filePath === cur.filePath)
        if (updated) {
          // 解析エラーが解消していたら修復待ちを解除（AC15）
          if (cur.parseError && !updated.parseError) {
            setRepairState((prev) => {
              const next = { ...prev }
              delete next[cur.filePath]
              return next
            })
          }
          return updated
        }
        return cur
      })
      return list
    } finally {
      setBusy(false)
    }
  }, [])

  /**
   * コメントスレッドを取り直す（**この 1 本だけが取得経路**）。
   * 子には結果を props で配るので、表示と `adoptBlockers()` が必ず同じ読み取り結果に基づく。
   */
  const refreshCommentThread = useCallback(async (p: Proposal | null): Promise<void> => {
    if (!p || p.parseError) {
      setCommentView(null)
      return
    }
    setCommentView({ requestId: p.requestId, status: 'loading', view: null })
    try {
      const v = await window.api.skillProposalsCommentThread(p.requestId, p.filePath)
      // 選択が切り替わっていたら**捨てる**（遅れて届いた前の提案の結果で上書きしない・finding#4）
      setCommentView((cur) =>
        cur && cur.requestId !== p.requestId
          ? cur
          : { requestId: p.requestId, status: 'ready', view: v }
      )
    } catch {
      // 取得失敗を握り潰して「コメント無し」に見せない。error のまま持ち、採用は fail-closed にする
      setCommentView((cur) =>
        cur && cur.requestId !== p.requestId
          ? cur
          : { requestId: p.requestId, status: 'error', view: null }
      )
    }
  }, [])

  /**
   * 選択中の提案に対して **ready な** スレッドだけを返す。
   * 読み込み中・失敗・別提案の残骸は `null`（＝不明）として扱い、採用判定は fail-closed にする。
   */
  const commentViewFor = (
    p: Proposal
  ): Awaited<ReturnType<typeof window.api.skillProposalsCommentThread>> | null =>
    commentView && commentView.requestId === p.requestId && commentView.status === 'ready'
      ? commentView.view
      : null

  /** スレッドの取得状態（UI が「不明」を黙って「無し」に見せないため） */
  const commentStatusFor = (p: Proposal): 'loading' | 'ready' | 'error' | 'none' =>
    commentView && commentView.requestId === p.requestId ? commentView.status : 'none'

  // 合成の進み具合: 起動時に読み、main からの push（検査・登録・レビューの完了）で更新する。
  // focus 復帰でも読み直す（push を取りこぼしても、戻ってきたときに最新になる）
  const refreshComposeStatuses = useCallback(async (): Promise<void> => {
    const gen = ++fetchStarted.current
    try {
      const all = await window.api.skillProposalsComposeStatus()
      // 後から始めた取得がすでに反映されていたら、この古い結果は捨てる
      if (gen < fetchApplied.current) return
      fetchApplied.current = gen
      setComposeStatuses(all)
      setComposeFetchedAt(Date.now())
    } catch {
      // 取れなかったときは最終更新を進めない（更新待ちの判定の根拠になる）
    }
  }, [])
  useEffect(() => {
    const load = (): void => void refreshComposeStatuses()
    load()
    const off = window.api.onComposeStatus(() => load())
    window.addEventListener('focus', load)
    return () => {
      off()
      window.removeEventListener('focus', load)
    }
  }, [refreshComposeStatuses])

  // push を取りこぼしても進行中の案件は止まって見えないよう、進行中の間は一定間隔で取り直す
  const composeWatching = composeStatuses.some(isComposeInProgress)
  useEffect(() => {
    if (!composeWatching) return
    const id = window.setInterval(() => void refreshComposeStatuses(), COMPOSE_POLL_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [composeWatching, refreshComposeStatuses])

  // 画面に出ている合成のカード（golden 同名の提案を選んでいて、取消だけの履歴でないもの）
  const displayedCompose = useMemo(() => {
    if (!selected?.goldenCollision || !selected.skillName || selected.goldenCollisionStatus === 'applied') return null
    const st = pickStatusForSkill(composeStatuses, selected.skillName)
    return st && !(st.phase === 'cancelled' && !st.revises && !st.caseId) ? st : null
  }, [selected, composeStatuses])
  // 新しい seq を画面に出した直後に main へ 1 回だけ報告する（遷移→描画の遅延の測定）。出していない status は報告しない
  useEffect(() => {
    const r = seqsToReportForDisplay(
      displayedCompose,
      displayedWorkspace.current,
      reportedSeqs.current,
      displayedCaseId.current
    )
    displayedWorkspace.current = r.workspace
    displayedCaseId.current = r.caseId
    if (r.baseline !== null) reportedSeqs.current.add(r.baseline)
    for (const seq of r.send) {
      reportedSeqs.current.add(seq)
      window.api.composeRendered(seq)
    }
  }, [displayedCompose])

  // 受け皿: 案件の受け皿の増減（状態に載る受け皿のパス）が変わったときに読み直す
  const refreshReceptacles = useCallback(async (): Promise<void> => {
    try {
      setReceptacles(await window.api.skillProposalsReceptacles())
    } catch {
      // 一覧が取れなくても候補ブラウザの他の機能は止めない
    }
  }, [])
  const receptacleSig = composeStatuses.map((s) => (s.receptacles ?? []).join('|')).join(';')
  useEffect(() => {
    void refreshReceptacles()
  }, [receptacleSig, refreshReceptacles])
  const closeReceptacle = async (
    path: string,
    how: ReceptacleClosedHow
  ): Promise<{ ok: boolean; error?: string }> => {
    const res = await window.api.skillProposalsReceptacleClose({ path, how })
    if (res.ok) await refreshReceptacles()
    return res
  }
  const openReceptaclesBySkill = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of openReceptacles(receptacles)) m.set(r.skill, (m.get(r.skill) ?? 0) + 1)
    return m
  }, [receptacles])

  // 起動時: localStorage の明示選択(v2)があれば尊重、無ければ既定プリセット ~/.ccpit/proposals/
  useEffect(() => {
    window.api
      .skillProposalsReviewerStatus()
      .then(setReviewerStatus)
      .catch(() => setReviewerStatus(null))
  }, [])

  /**
   * **CC の応答をこの画面へ戻す経路**（Plan Codex レビュー finding#1）。
   *
   * CC は `proposal-comment-respond.cjs` でストアへ書き、提案 MD も改稿する。
   * アプリ側にファイル監視は無いので、放っておくと「応答したのに画面は未応答のまま」になり、
   * クリップボード断絶を**ファイル書き込み断絶に付け替えただけ**になる。
   *
   * 本機能の実際の動線は「起動 → 端末へ移る → 戻ってくる」なので、**focus 復帰が応答完了と
   * 実質同義**になる。`fs.watch` の不安定さ（Windows）に依存せず、これで十分かつ確実。
   * 明示の「更新」ボタンも併置してある（focus を跨がない場合の逃げ道）。
   *
   * CCPIT_061: 修復待ちの提案がある場合も、focus 復帰時に再確認を走らせて解消を自動反映する（AC15 補助）。
   */
  useEffect(() => {
    const onFocus = (): void => {
      setSelected((cur) => {
        if (cur) {
          void refreshCommentThread(cur)
          if (cur.parseError && repairState[cur.filePath]?.waiting && folder) {
            void reload(folder)
          }
        }
        return cur
      })
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshCommentThread, folder, reload, repairState])

  // 選択中の解析エラー提案に対する祖先設定の事前検査（AC16）
  useEffect(() => {
    if (!selected || !selected.parseError || selected.notAProposal) return
    const p = selected.filePath

    window.api
      .skillProposalsCheckRepairEnvironment(p)
      .then((res) => {
        if (res.ok && res.detectedSettings) {
          setRepairState((prev) => {
            if (prev[p]?.detectedSettings !== undefined) return prev
            return {
              ...prev,
              [p]: {
                ...(prev[p] ?? { waiting: false }),
                detectedSettings: res.detectedSettings
              }
            }
          })
        }
      })
      .catch(() => {
        /* fail-open */
      })
  }, [selected])

  useEffect(() => {
    window.api.settingsHasPassword().then(setHasPassword)
    const saved = localStorage.getItem(STORAGE_KEY_FOLDER)
    if (saved) {
      setFolder(saved)
    } else {
      window.api.skillProposalsDefaultFolder().then(setFolder)
    }
  }, [])

  useEffect(() => {
    if (folder) void reload(folder)
  }, [folder, reload])

  const chooseFolder = async (): Promise<void> => {
    const picked = await window.api.selectFolder()
    if (!picked) return
    localStorage.setItem(STORAGE_KEY_FOLDER, picked)
    setFolder(picked)
    setSelected(null)
    setSkillBody('')
    setProposedFiles([])
  }

  const select = async (p: Proposal): Promise<void> => {
    setSelected(p)
    setSkillBody('')
    setProposedFiles([])
    setMessage(null)
    setReviewOverride(false) // 別候補へ切り替えたら break-glass はリセット（誤って持ち越さない）
    setFindingsAck(false) // findings 承知も同様に持ち越さない
    setCommentView(null) // 前の候補のスレッドを一瞬でも見せない（誤読防止）
    setCommentsAck(false) // コメント ack も持ち越さない
    if (p.parseError) return
    void refreshCommentThread(p)
    try {
      const req = await window.api.settingsReadRequest(p.filePath)
      if (req.kind === 'skill') {
        setSkillBody(req.proposedSkillBody)
        if ('files' in req && Array.isArray((req as any).files)) {
          setProposedFiles((req as any).files)
        }
      }
    } catch {
      /* preview 失敗は致命でない */
    }
  }

  // 部分一致検索フィルタ (H-5: Finding 3 型整合確認済みプロパティ)
  const filteredProposals = useMemo(() => {
    if (!searchQuery.trim()) return proposals
    const q = searchQuery.trim().toLowerCase()
    return proposals.filter((p) => {
      const matchTitle = (p.title || '').toLowerCase().includes(q)
      const matchSkillName = (p.skillName || '').toLowerCase().includes(q)
      const matchFilePath = (p.filePath || '').toLowerCase().includes(q)
      const matchWhat = (p.what || '').toLowerCase().includes(q)
      const matchWhy = (p.why || '').toLowerCase().includes(q)
      const matchHow = (p.how || '').toLowerCase().includes(q)
      return matchTitle || matchSkillName || matchFilePath || matchWhat || matchWhy || matchHow
    })
  }, [proposals, searchQuery])

  // 検索・候補変更時の選択追従 (Finding 5)
  useEffect(() => {
    if (selected && !filteredProposals.some((item) => item.filePath === selected.filePath)) {
      if (filteredProposals.length > 0) {
        void select(filteredProposals[0])
      } else {
        setSelected(null)
        setSkillBody('')
      }
    }
  }, [filteredProposals, selected])

  const changeState = async (
    p: Proposal,
    state: ProposalState,
    opts?: { acknowledgeNoApply?: boolean }
  ): Promise<void> => {
    await window.api.skillProposalsSetState(p.requestId, state, { ...opts, folder })
    await reload(folder)
    setSelected((cur) => (cur && cur.requestId === p.requestId ? { ...cur, state } : cur))
  }

  const adopt = async (p: Proposal): Promise<void> => {
    // 未レビュー recommend は独立レビューを経ずに採用させない（break-glass で override 可）。
    // recommend-review すり抜けの UI 側の栓（判定は main の needsReviewBeforeAdopt）。
    if (p.needsReview && !reviewOverride) {
      setMessage({
        kind: 'err',
        text: L(
          '独立レビューで承認（approve）されていない推奨提案です。レビューを実施／指摘を解決するか、「承知で採用」を明示チェックしてください。',
          'Recommend proposal not cleared by an approving independent review. Resolve the review or explicitly check "adopt anyway".'
        )
      })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      // main 集約 atomic: ゲート判定 → 通過時のみ applyChange。renderer の list スナップショットに
      // 依存しないため、list 取得後にレビューが変わっても最新状態で再判定される（TOCTOU 根治）。
      // ack は「承知の明示操作（accepted）」＋「画面に出ていた内容の 3 値」を返す。
      // main が採用時に 3 値を再計算して照合するので、一覧取得後に提案や裁定が変わっていれば
      // stale ack として拒否される。accepted は内容束縛とは別に、ユーザーの意思表示を表す。
      const result = await window.api.skillProposalsAdopt(
        p.filePath,
        password,
        reviewOverride,
        // ackBinding が来ていない（main が古い）なら ack を送らない。
        // 空の束縛値をでっち上げると main 側で stale ack として拒否されるだけなので、
        // 送らずに「古い形式です」の警告をユーザーへ出す方が正直。
        findingsAck && p.ackBinding
          ? { accepted: true as const, labelShown: ackLabel(p), ...p.ackBinding }
          : undefined,
        // コメント側 ack は別次元で送る（findings ack の 3 値束縛には一切触れない）
        commentsAckPayload(p),
        p.ackBinding?.proposalHash
      )
      if (result.success) {
        // 状態確定は main が「実際に適用した request_id」で atomic に行う（renderer の stale
        // スナップショット requestId で書かない＝適用 content と terminal-state のズレを根治・round4）。
        setPassword('')
        const note = result.renamedTo
          ? L(
              ` 先行 skill と同名衝突のため一時名 '${result.renamedTo}' で採用しました（~/.ccpit/reports/ 参照）。`,
              ` Name collision with a pre-existing skill: adopted under temp name '${result.renamedTo}' (see ~/.ccpit/reports/).`
            )
          : ''
        setMessage({
          kind: result.renamedTo ? 'info' : 'ok',
          text: L('採用しました（適用済み）。', 'Adopted (applied).') + note
        })
        await reload(folder)
        setSelected((cur) => (cur ? { ...cur, state: 'adopted' } : cur))
      } else if (result.reason === 'terminal-state') {
        // 既に確定（採用済み/却下済み）の提案は採用不可。UI と main ゲートの terminal-state を一致させる。
        setMessage({
          kind: 'err',
          text: L(
            'この提案は既に確定（採用済み／却下済み）です。採用できません。',
            'This proposal is already finalized (adopted/rejected); cannot adopt.'
          )
        })
        await reload(folder)
      } else if (result.reason === 'review-required') {
        // main の atomic 再判定でブロック（list 取得後にレビューが変わった等）。break-glass を促し最新化。
        setReviewOverride(false)
        setMessage({
          kind: 'err',
          text: L(
            '独立レビューで承認（approve）されていません（最新状態で再判定）。レビューを実施するか「承知で採用」を明示チェックしてください。',
            'Not cleared by an approving review (re-checked against latest state). Run a review or check "adopt anyway".'
          )
        })
        await reload(folder)
      } else if (result.reason === 'findings-ack-required') {
        // 降格ラベルは「findings を提示して確認を取った」明示フラグが無いと通さない（fail-closed）。
        setFindingsAck(false)
        setMessage({
          kind: 'err',
          text: L(
            'この提案は recommend-with-findings（指摘つきの人間判断待ち）です。findings を確認したうえで「findings を確認した」にチェックしてから採用してください。',
            'This proposal is recommend-with-findings. Review the findings, then check "findings acknowledged" before adopting.'
          )
        })
        await reload(folder)
      } else if (
        result.reason === 'comments-unanswered' ||
        result.reason === 'comments-broken' ||
        result.reason === 'comments-ack-required'
      ) {
        // 汎用の 'apply failed' に落とさない。main が commentDetail を組み立てているので
        // それをそのまま出し、足りなければ理由ごとの既定文言で補う。
        // コメント側の ack だけを戻す（findings ack を巻き添えにしない・finding#1）
        if (result.reason === 'comments-ack-required') setCommentsAck(false)
        const fallback =
          result.reason === 'comments-unanswered'
            ? L(
                '未応答のユーザーコメントがあります。CC に応答させてから採用してください。',
                'There are unanswered user comments. Have CC respond before adopting.'
              )
            : result.reason === 'comments-broken'
              ? L(
                  '壊れたコメントレコードがあります。隔離するか修復してください。',
                  'There are broken comment records. Quarantine or repair them.'
                )
              : L(
                  'コメント応答の確認（ack）が必要です。内容を確認してチェックしてください。',
                  'The comment responses need acknowledgement. Review them and check the box.'
                )
        setMessage({ kind: 'err', text: result.commentDetail ?? fallback })
        await reload(folder)
        await refreshCommentThread(p)
      } else if (result.reason === 'read-error') {
        // 提案ファイル自体が読めない（削除/移動/権限）。一覧を最新化して状態を反映。
        setMessage({
          kind: 'err',
          text: L(
            '提案ファイルを読み込めませんでした（削除・移動された可能性）。一覧を更新します。',
            'Could not read the proposal file (it may have been deleted or moved). Refreshing the list.'
          )
        })
        await reload(folder)
      } else if (result.reason === 'content-changed') {
        // preview 時と適用時で内容ハッシュが不一致（TOCTOU ガード）。再プレビューを促す。
        setMessage({
          kind: 'err',
          text: L(
            '提案内容がプレビュー時から変更されています。内容を再確認してから採用してください。',
            'The proposal content changed since preview. Re-check the content, then adopt again.'
          )
        })
        await reload(folder)
      } else {
        const hint =
          result.reason === 'golden-name-collision'
            ? L(
                ' — golden 配布の skill と同名のため、そのままでは採用できません。golden 版との統合を Claude Code に相談するか、提案 skill 名を変更してください。',
                ' — This proposal has the same name as a golden-distributed skill and cannot be adopted as is. Consult Claude Code to merge it into the golden version, or rename the proposal.'
              )
            : result.reason === 'authentication-failed' ||
                result.reason === 'auth-missing-for-skill'
              ? L(' — パスワードを確認してください。', ' — check the password.')
              : ''
        setMessage({ kind: 'err', text: `${result.error ?? 'apply failed'}${hint}` })
      }
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  /** golden 版との統合を Claude Code に相談する (CCPIT_064 / AC9 (a)) */
  const consultGoldenMerge = async (p: Proposal): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      const targetRel = p.skillName ? `skills/${p.skillName}/SKILL.md` : ''
      const res = await window.api.goldenLaunchMergeConsult({
        paths: targetRel ? [targetRel] : [],
        proposalPaths: [p.filePath]
      })
      if (res.ok) {
        setMessage({
          kind: 'ok',
          text: L(
            `Claude Code を起動しました。依頼パケット: ${res.promptFilePath ?? ''}`,
            `Claude Code launched. Request packet: ${res.promptFilePath ?? ''}`
          )
        })
      } else {
        setMessage({
          kind: 'err',
          text: L(
            `Claude Code の起動に失敗しました: ${res.error ?? 'unknown error'}`,
            `Failed to launch Claude Code: ${res.error ?? 'unknown error'}`
          )
        })
      }
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  /**
   * 合成して golden へ入れる（主ボタン）。同じ skill 宛ての承認済みの提案から合成の元を選ぶダイアログを開く
   * （既定は全件選択）。選んだ提案を、今の golden に重ねて 1 本にする。選ばなかった提案は、合成が昇格を完了するまで
   * 昇格候補から外れる。Claude Code が作業場で合成し、検査・登録・独立レビューは CCPIT が行う。終わったら昇格画面で承認する。
   */
  const composeGoldenMerge = async (p: Proposal): Promise<void> => {
    if (busy || !p.skillName) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await window.api.skillProposalsComposeSelectable({ skillName: p.skillName })
      if (res.ok) {
        setPicker({
          skillName: p.skillName,
          items: res.items,
          selected: defaultPickerSelection(res.items)
        })
      } else {
        setMessage({ kind: 'err', text: L(`合成を始められません: ${res.error}`, `Cannot start the composition: ${res.error}`) })
      }
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  /** 選択ダイアログの「まとめて合成」。選んだ提案の ID を渡して合成を始める（主処理が起動の瞬間に適格かを再計算して照合する） */
  const startComposeWithPicked = async (): Promise<void> => {
    if (busy || !picker || !canSubmitPicker(picker.selected, picker.items)) return
    const sourceIds = pickerSubmitIds(picker.selected, picker.items)
    setMessage(null)
    // L0_012: 押した瞬間にボタンの傍へ「準備中」を出し、IPC の復帰 → 状態の取り直し（カードに「起動待ち」）→ ダイアログを閉じる
    await runComposeStart({
      setStarting: (on) => {
        setComposeStarting(on)
        setBusy(on)
      },
      start: () => window.api.skillProposalsComposeStart({ skillName: picker.skillName, sourceIds }),
      refresh: refreshComposeStatuses,
      closePicker: () => setPicker(null),
      onOk: (res) =>
        setMessage({
          kind: 'ok',
          text: res.ok
            ? L(
                `合成を始めました。進み具合は提案カードに出ます。元提案: ${res.sourceIds.join('、')}`,
                `Composition started. Progress is shown on the proposal card. Sources: ${res.sourceIds.join(', ')}`
              )
            : ''
        }),
      onError: (r) =>
        setMessage({
          kind: 'err',
          text:
            'thrown' in r
              ? r.thrown instanceof Error
                ? r.thrown.message
                : String(r.thrown)
              : L(`合成を始められません: ${r.ok ? '' : r.error}`, `Cannot start the composition: ${r.ok ? '' : r.error}`)
        })
    })
  }

  /** 合成が登録・承認まで進んだら、Golden 昇格画面をその提案を選択済みで開く（承認の押下は昇格画面の既存のボタン） */
  const openPromotionFor = (compositeId: string): void => {
    setPromotionPreselect(compositeId)
    requestNavigate('goldenPromotion')
  }

  /**
   * 指摘を反映して改訂する。登録済みの合成提案を土台に、独立レビューの指摘を反映した合成を同じ経路で作り直す。
   * 登録・再レビューは CCPIT が自動で行う（適応を変えない限り、選択の聞き直しは無い）。
   */
  const reviseCompose = async (compositeId: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await window.api.skillProposalsComposeRevise({ compositeId })
      if (res.ok) {
        setMessage({
          kind: 'ok',
          text: L(
            '改訂を始めました（Claude Code が作業場で、旧合成提案とレビューの指摘を読んで作り直します）。',
            'Revision started (Claude Code re-composes in a workspace from the previous composite and the review findings).'
          )
        })
        await refreshComposeStatuses()
      } else {
        setMessage({ kind: 'err', text: L(`改訂を始められません: ${res.error}`, `Cannot start the revision: ${res.error}`) })
      }
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  const cancelCompose = async (workspaceDir: string): Promise<void> => {
    await window.api.skillProposalsComposeCancel(workspaceDir).catch(() => undefined)
    await refreshComposeStatuses()
  }

  /**
   * 統合済みとして採用済みにする (CCPIT_064 / AC9 (b) — 状態遷移のみ、ファイルは書かない)。
   * 中身が golden に入っていない提案は、何も適用されないことの確認を挟む（確認後は confirmed=true で再入）。
   */
  const markAsAdoptedMerged = async (p: Proposal, confirmed = false): Promise<void> => {
    if (busy) return
    if (p.goldenCollisionStatus !== 'applied' && !confirmed) {
      setMarkAckPendingId(p.requestId)
      return
    }
    setBusy(true)
    setMessage(null)
    setMarkAckPendingId(null)
    try {
      await changeState(p, 'adopted', { acknowledgeNoApply: p.goldenCollisionStatus !== 'applied' })
      setMessage({
        kind: 'ok',
        text: L(
          '統合済みとして採用済みにしました（ファイルは書き換えていません）。',
          'Marked as adopted (merged); no files were written.'
        )
      })
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  /** B-1: 独立レビューを read-only sandbox で実行し、台帳を更新して一覧を最新化する。 */
  const runReview = async (p: Proposal): Promise<void> => {
    if (reviewingPath) return
    setReviewingPath(p.filePath)
    setMessage(null)
    try {
      const r = await window.api.skillProposalsReview(p.filePath)
      if (r.status === 'ok') {
        setMessage({
          kind: r.verdict === 'approve' ? 'ok' : 'info',
          text: L(`レビュー完了: verdict = ${r.verdict}`, `Review finished: verdict = ${r.verdict}`)
        })
        // 台帳が変わったので一覧とバッジを即時反映し、選択中の提案も最新化する
        const list = await window.api.skillProposalsList(folder)
        setProposals(list)
        const fresh = list.find((x) => x.filePath === p.filePath)
        if (fresh) setSelected(fresh)
      } else {
        setMessage({ kind: 'err', text: r.message })
      }
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setReviewingPath(null)
    }
  }

  /** B-3: レビュー依頼プロンプトをクリップボードへ（B-1 が内部で使う文字列と同一ソース）。 */
  const copyReviewRequest = async (p: Proposal): Promise<void> => {
    try {
      const text = await window.api.skillProposalsReviewRequestText(p.filePath)
      await window.api.clipboardWrite(text)
      setMessage({
        kind: 'ok',
        text: L('レビュー依頼プロンプトをコピーしました。', 'Copied the review request prompt.')
      })
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    }
  }

  /**
   * 解析エラーの修復依頼を CC 向けにコピーする（D8: 副ボタンとして併置、単一ソース・N2）。
   *
   * **アプリは提案 MD を書き換えない**。提案は採用ゲートの content hash 束縛の対象で、
   * アプリが本文を直すと「レビューされた content」との対応が壊れる。
   * 直すのは CC の仕事で、ここは「何がどう壊れているか」を正確に渡すだけ。
   */
  const copyRepairRequest = async (p: Proposal): Promise<void> => {
    try {
      const text = await window.api.skillProposalsRepairRequestText(p.filePath, folder)
      await window.api.clipboardWrite(text)
      setMessage({
        kind: 'ok',
        text: L(
          '修復依頼文をコピーしました。CC セッションへ貼り付けてください。',
          'Copied the repair request. Paste it into a CC session.'
        )
      })
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    }
  }

  /**
   * 解析エラー提案の修復用 Claude Code を起動する（D1, AC1, AC6, AC10, AC12）。
   */
  const launchRepairRequest = async (p: Proposal): Promise<void> => {
    if (repairLaunching || busy) return
    setRepairLaunching(true)
    setMessage(null)
    try {
      const res = await window.api.skillProposalsLaunchRepair(p.filePath, folder)
      const hasPlan =
        res.appliedFlags?.includes('plan') ||
        (await window.api
          .configGet()
          .then(
            (cfg) =>
              (cfg as { skillProposals?: { permissionMode?: string } })?.skillProposals
                ?.permissionMode === 'plan'
          )
          .catch(() => false))

      setRepairState((prev) => ({
        ...prev,
        [p.filePath]: {
          ...(prev[p.filePath] ?? {}),
          waiting: res.ok,
          appliedFlags: res.appliedFlags,
          rejectedSettings: res.rejectedSettings,
          detectedSettings: res.detectedSettings ?? prev[p.filePath]?.detectedSettings,
          planWarning: hasPlan
        }
      }))

      if (res.ok) {
        setMessage({
          kind: 'ok',
          text: L(
            'Claude Code の起動を要求しました。端末で修復が完了したら「再確認」を押してください。',
            'Requested Claude Code launch. Click "Re-check" once repair completes in the terminal.'
          )
        })
      } else {
        setMessage({
          kind: 'err',
          text: res.error ?? L('修復起動に失敗しました。', 'Failed to launch repair.')
        })
      }
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setRepairLaunching(false)
    }
  }

  /**
   * 修復完了後の再確認（AC15）。一覧と選択カードを再読込し、直っていれば修復待ちを解除する。
   */
  const recheckRepair = async (p: Proposal): Promise<void> => {
    if (!folder) return
    const list = await reload(folder)
    const updated = list.find((item) => item.filePath === p.filePath)
    if (updated) {
      setSelected(updated)
      if (!updated.parseError) {
        // 修復成功: 修復待ち解除
        clearRepairWaiting(p.filePath)
        setMessage({
          kind: 'ok',
          text: L('書式の修復が確認できました。', 'Formatting repair verified successfully.')
        })
      } else {
        // まだエラーが残っている場合は祖先設定環境も再取得
        window.api
          .skillProposalsCheckRepairEnvironment(p.filePath)
          .then((res) => {
            if (res.ok && res.detectedSettings) {
              setRepairState((prev) => ({
                ...prev,
                [p.filePath]: {
                  ...(prev[p.filePath] ?? { waiting: true }),
                  detectedSettings: res.detectedSettings
                }
              }))
            }
          })
          .catch(() => {})
        setMessage({
          kind: 'info',
          text: L(
            'まだ解析エラーが残っています。端末側の作業を確認してください。',
            'Parse error still remains. Please check the terminal.'
          )
        })
      }
    }
  }

  /** 修復待ちを手動で解除（AC10 行き止まり防止） */
  const clearRepairWaiting = (filePath: string): void => {
    setRepairState((prev) => {
      const next = { ...prev }
      if (next[filePath]) {
        next[filePath] = { ...next[filePath], waiting: false }
      }
      return next
    })
  }

  /** 提案日を YYYY-MM-DD で短く。解析できなければ元文字列、空なら日付不明。 */
  const formatProposedOn = (iso: string): string => {
    if (!iso) return L('日付不明', 'date unknown')
    const t = Date.parse(iso)
    if (Number.isNaN(t)) return iso
    const d = new Date(t)
    const p2 = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
  }

  /** 提案元プロジェクトは末尾フォルダ名だけ出す（絶対パスは title 属性へ逃がす）。 */
  const projectLabel = (sourceProject: string): string => {
    if (!sourceProject) return L('出自不明', 'unknown source')
    const norm = sourceProject.replace(/[\\/]+$/, '').replace(/\\/g, '/')
    const base = norm.slice(norm.lastIndexOf('/') + 1)
    return base || norm
  }

  /** B-2: ゲート状態バッジ。 */
  const gateBadge = (g: Proposal['gate']): React.JSX.Element | null => {
    const map: Record<string, { j: string; e: string; cls: string }> = {
      unreviewed: { j: '未レビュー', e: 'unreviewed', cls: 'bg-amber-500/15 text-amber-600' },
      'reviewed-unapproved': {
        j: '指摘あり',
        e: 'needs attention',
        cls: 'bg-orange-500/15 text-orange-600'
      },
      'stale-approve': {
        j: '承認失効',
        e: 'stale approve',
        cls: 'bg-red-500/15 text-red-600'
      },
      // `approved`（＝刈り取り済み・採用ゲート解除可）は**バッジを出さない**。
      // 推奨バッジ自体が「刈り取り済み」を意味するようになったので重複しており、
      // 一覧で 推奨 + 候補 + 承認済 と 3 つ並ぶのは純粋なノイズだった（maintainer指摘 2026-08-06）。
      // バッジは**例外の目印**に徹する — 何も出ていない = 問題なし、と読める方が認知負荷が低い。
      downgraded: {
        j: '指摘つき人間判断待ち',
        e: 'recommend-with-findings',
        cls: 'bg-violet-500/15 text-violet-600'
      }
    }
    const m = map[g.state]
    if (!m) return null
    return <span className={cn('text-xs px-1.5 py-0.5 rounded', m.cls)}>{ja ? m.j : m.e}</span>
  }

  const stateBadge = (s: ProposalState): React.JSX.Element => {
    const map: Record<ProposalState, { j: string; e: string; cls: string }> = {
      candidate: { j: '候補', e: 'candidate', cls: 'bg-blue-500/15 text-blue-600' },
      adopted: { j: '採用済', e: 'adopted', cls: 'bg-green-500/15 text-green-600' },
      rejected: { j: '却下', e: 'rejected', cls: 'bg-red-500/15 text-red-600' },
      held: { j: '保留', e: 'held', cls: 'bg-amber-500/15 text-amber-600' }
    }
    const m = map[s]
    return <span className={cn('text-xs px-2 py-0.5 rounded', m.cls)}>{ja ? m.j : m.e}</span>
  }

  const passwordOk = !hasPassword || password.length > 0

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Header: folder + reload */}
      <div className="flex items-center gap-2 shrink-0">
        <h2 className="text-base font-semibold">
          {L('Skill 候補ブラウザ', 'Skill candidate browser')}
        </h2>
        <span className="text-xs text-muted-foreground">{L('提案を採用', 'Adopt proposals')}</span>
        <div className="ml-auto flex items-center gap-2">
          {/* 対話 CC 設定。「提案フォルダ選択」の**左**（maintainer指定の配置）。
              常時表示のパネルを右ペインへ足すと提案本文の表示を圧迫するのでダイアログへ畳む。 */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSettingsOpen(true)}
            title={L(
              '対話 CC のモデル / effort / PXP（全提案共通）',
              'Dialogue CC model / effort / PXP (shared across all proposals)'
            )}
          >
            <Settings size={14} className="mr-1" />
            {L('設定', 'Settings')}
          </Button>
          <Button variant="outline" size="sm" onClick={chooseFolder}>
            <FolderOpen size={14} className="mr-1" />
            {L('提案フォルダ選択', 'Choose folder')}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void reload(folder)}
            disabled={!folder || busy}
            className="h-8 w-8"
          >
            <RefreshCw size={14} className={cn(busy && 'animate-spin')} />
          </Button>
        </div>
      </div>
      {folder && (
        <div className="text-xs text-muted-foreground truncate shrink-0" title={folder}>
          {folder}
        </div>
      )}

      {!folder && (
        <div className="text-sm text-muted-foreground">
          {L(
            '提案フォルダ（_SkillProposals/）を選択してください。',
            'Choose the proposals folder (_SkillProposals/).'
          )}
        </div>
      )}

      <div className="flex flex-1 gap-3 min-h-0">
        {/* List (H-5: 検索バー付きコンテナ) */}
        <div className="w-2/5 flex flex-col border border-border rounded-md overflow-hidden bg-card/10">
          {/* 検索バー (H-5) */}
          <div className="p-2 border-b border-border bg-card/30 shrink-0">
            <div className="relative">
              <Search
                size={13}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={L('タイトル・スキル名・内容で検索...', 'Search by title, skill, content...')}
                className="w-full h-7 pl-8 pr-7 text-xs rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-primary"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X size={12} />
                </button>
              )}
            </div>
            {searchQuery && (
              <div className="text-[10px] text-muted-foreground mt-1 px-1">
                {L(
                  `全 ${proposals.length} 件中 ${filteredProposals.length} 件を表示`,
                  `Showing ${filteredProposals.length} of ${proposals.length}`
                )}
              </div>
            )}
          </div>

          <div className="flex-1 overflow-auto">
            {filteredProposals.length === 0 && folder && !busy && (
              <div className="p-3 text-sm text-muted-foreground">
                {searchQuery
                  ? L('一致する候補がありません。', 'No matching candidates.')
                  : L('候補がありません。', 'No candidates.')}
              </div>
            )}
            <ul>
              {filteredProposals.map((p) => (
              <li key={p.filePath}>
                <button
                  onClick={() => void select(p)}
                  className={cn(
                    'w-full text-left px-3 py-2 border-b border-border hover:bg-muted/50',
                    selected?.filePath === p.filePath && 'bg-muted'
                  )}
                >
                  {/* 一覧は「何の skill か（日本語名）/ 提案日 / 提案元プロジェクト / バッジ類」に絞る。
                      識別子（skillName）や絶対パスは詳細ペインと title 属性へ逃がし、認知負荷を下げる。 */}
                  <div className="text-sm font-medium truncate" title={p.skillName || undefined}>
                    {p.title}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                    {p.adoptionLabel === 'recommend' && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/15 text-green-600">
                        {L('推奨', 'recommend')}
                      </span>
                    )}
                    {p.adoptionLabel === 'recommend-with-findings' && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-600">
                        {L('指摘つき', 'with findings')}
                      </span>
                    )}
                    {p.adoptionLabel === 'reject' && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        {L('棄却', 'reject')}
                      </span>
                    )}
                    {stateBadge(p.state)}
                    {gateBadge(p.gate)}
                    {/* 同名 skill が採用レジストリに存在＝この提案は**更新提案**。
                        重複警告ではなく「採用すると現行版を差し替える」ことを示す。 */}
                    {p.alreadyAdopted && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-600 inline-flex items-center gap-1">
                        <ShieldCheck size={11} />
                        {L('更新提案', 'update proposal')}
                      </span>
                    )}
                    {p.goldenCollision && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 inline-flex items-center gap-1">
                        <AlertTriangle size={11} />
                        {L('golden 同名', 'golden collision')}
                      </span>
                    )}
                    {p.goldenCollision && p.skillName && (openReceptaclesBySkill.get(p.skillName) ?? 0) > 0 && (
                      <span
                        className="text-xs px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600"
                        data-testid="receptacle-row-badge"
                      >
                        {receptacleBadgeLabel(openReceptaclesBySkill.get(p.skillName) ?? 0, ja)}
                      </span>
                    )}
                    {/* 「壊れた提案」と「そもそも提案でないファイル」を区別して見せる。
                        後者（裁定メモ・引き継ぎメモ・該当なし記録）は直す対象ではない。 */}
                    {p.parseError && p.notAProposal && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        {L('対象外', 'not a proposal')}
                      </span>
                    )}
                    {p.parseError && !p.notAProposal && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/15 text-red-600 inline-flex items-center gap-1">
                        <AlertTriangle size={11} />
                        {L('解析エラー', 'parse error')}
                      </span>
                    )}
                  </div>
                  <div
                    className="text-xs text-muted-foreground truncate mt-0.5"
                    title={p.sourceProject || undefined}
                  >
                    {formatProposedOn(p.createdAt)} · {projectLabel(p.sourceProject)}
                  </div>
                </button>
              </li>
            ))}
            </ul>
          </div>
        </div>

        {/* Detail / review gate */}
        <div className="flex-1 overflow-auto border border-border rounded-md p-3 select-text">
          {!selected && (
            <div className="text-sm text-muted-foreground">
              {L('候補を選択してください。', 'Select a candidate.')}
            </div>
          )}
          {selected && (
            <div className="flex flex-col gap-3 text-sm">
              <div>
                <div className="text-base font-semibold">{selected.title}</div>
                <div className="text-xs text-muted-foreground">
                  {selected.skillName} → {selected.target}
                </div>
                <div
                  className="text-xs text-muted-foreground"
                  title={selected.sourceProject || undefined}
                >
                  {L('出自プロジェクト', 'Source project')}:{' '}
                  {selected.sourceProject || L('(出自不明)', '(unknown source)')}
                </div>
              </div>

              {selected.parseError ? (
                selected.notAProposal ? (
                  // 直す対象ではない。「skill 提案ではないファイルがフォルダに置かれている」だけ。
                  <div className="space-y-1 text-muted-foreground">
                    <div>{L('この文書は skill 提案ではありません', 'Not a skill proposal')}</div>
                    <div className="text-xs">{selected.parseError}</div>
                    <div className="text-xs">
                      {L(
                        '裁定メモ・引き継ぎメモ・「該当なし」記録などが提案フォルダに同居しています。修復は不要です。',
                        'Adjudication notes, handoff notes, and "no candidate" records live in the same folder. No repair needed.'
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="text-red-600 space-y-1">
                      <div>
                        {L('解析エラー: ', 'Parse error: ')}
                        {selected.parseError}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {L(
                          '修復ヒント: §2 評価軸は固定 5 軸（再現性 / 汎用性 / Context節約効果 / 既存Skill重複・統一可能性 / 本質的UX向上への寄与）で、各軸は「- 軸名: 0〜5 の数値 — 根拠」の形。frontmatter に kind: skill と target が必要です。',
                          'Repair hint: §2 uses the fixed five axes, each written as "- name: <0-5> — rationale". The frontmatter needs kind: skill and target.'
                        )}
                      </div>
                    </div>

                    {/* AC16: 祖先設定の告知（断定しない） */}
                    {repairState[selected.filePath]?.detectedSettings &&
                      repairState[selected.filePath].detectedSettings!.length > 0 && (
                        <div className="text-xs rounded p-2 bg-amber-500/10 text-amber-700 border border-amber-500/20">
                          <div className="font-medium">
                            {L('プロジェクト設定が検出されました', 'Project settings detected')}
                          </div>
                          <div className="text-[11px] mt-0.5">
                            {L(
                              `このフォルダまたはその祖先に次の設定があります: ${repairState[selected.filePath].detectedSettings!.join(', ')}。その hooks や規約が修復セッションに適用される可能性があります。`,
                              `The following settings exist in this folder or its ancestors: ${repairState[selected.filePath].detectedSettings!.join(', ')}. Their hooks and rules may apply to the repair session.`
                            )}
                          </div>
                        </div>
                      )}

                    {/* 修復待ち状態の表示（AC10, AC12, AC15） */}
                    {repairState[selected.filePath]?.waiting ? (
                      <div className="space-y-2 border border-blue-500/30 rounded p-2.5 bg-blue-500/5">
                        <div className="text-xs text-blue-700 font-medium">
                          {L(
                            '修復を依頼しました（端末が開きました。端末側で Claude Code の状況を確認してください）',
                            'Repair requested (terminal opened. Please check Claude Code status in the terminal)'
                          )}
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <Button
                            size="sm"
                            className="h-7 px-2 text-xs"
                            disabled={busy}
                            onClick={() => void recheckRepair(selected)}
                          >
                            <RefreshCw size={11} className="mr-1" />
                            {L('再確認', 'Re-check')}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs"
                            onClick={() => clearRepairWaiting(selected.filePath)}
                          >
                            {L('修復待ちを解除', 'Cancel waiting')}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs"
                            disabled={repairLaunching || busy}
                            onClick={() => void launchRepairRequest(selected)}
                          >
                            {L('もう一度依頼する', 'Request again')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs text-muted-foreground"
                            onClick={() => void copyRepairRequest(selected)}
                          >
                            <Copy size={11} className="mr-1" />
                            {L('依頼文をコピー', 'Copy request')}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      /* 通常時: 主ボタン「Claude Code に修復を依頼」+ 副ボタン「依頼文をコピー」 (AC1, D8) */
                      <div className="flex items-center gap-2 flex-wrap">
                        <Button
                          size="sm"
                          className="h-7 px-2 text-xs"
                          disabled={repairLaunching || busy}
                          onClick={() => void launchRepairRequest(selected)}
                        >
                          <Play size={11} className="mr-1" />
                          {repairLaunching
                            ? L('起動中…', 'launching…')
                            : L('Claude Code に修復を依頼', 'Ask Claude Code to repair')}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          onClick={() => void copyRepairRequest(selected)}
                        >
                          <Copy size={11} className="mr-1" />
                          {L('依頼文をコピー', 'Copy repair request')}
                        </Button>
                      </div>
                    )}

                    {/* AC6: plan モードの平文警告 */}
                    {repairState[selected.filePath]?.planWarning && (
                      <div className="text-xs rounded p-2 bg-amber-500/15 text-amber-800 border border-amber-500/30 flex items-start justify-between gap-2">
                        <div>
                          <div className="font-medium">
                            {L('注意: 計画のみの権限モード', 'Warning: Plan-only permission mode')}
                          </div>
                          <div>
                            {L(
                              '現在の設定では Claude Code は計画を立てるだけで、ファイルを書き換えません。ファイルを修復するには対話 CC 設定で権限モードを変更してください。',
                              'In the current setting, Claude Code only creates a plan and does not modify files. Please change permission mode in settings to repair files.'
                            )}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[11px] shrink-0"
                          onClick={() => setSettingsOpen(true)}
                        >
                          <Settings size={11} className="mr-1" />
                          {L('設定を開く', 'Open settings')}
                        </Button>
                      </div>
                    )}

                    {/* AC6: 落とした設定値 */}
                    {repairState[selected.filePath]?.rejectedSettings &&
                      repairState[selected.filePath].rejectedSettings!.length > 0 && (
                        <div className="text-xs rounded p-2 bg-red-500/15 text-red-700">
                          <div className="font-medium">
                            {L('安全でない設定値を無視しました', 'Ignored unsafe setting(s)')}
                          </div>
                          <div className="font-mono">
                            {repairState[selected.filePath].rejectedSettings!.join(', ')}
                          </div>
                        </div>
                      )}

                    {/* AC6: 実際に渡した起動引数 */}
                    {repairState[selected.filePath]?.appliedFlags && (
                      <div className="text-xs rounded p-2 bg-muted/40">
                        <div className="text-muted-foreground">
                          {L('実際に渡した起動引数:', 'Launch arguments actually passed:')}
                        </div>
                        <div className="font-mono break-all">
                          {repairState[selected.filePath].appliedFlags!.length > 0
                            ? repairState[selected.filePath].appliedFlags!.join(' ')
                            : L('（なし＝すべて CLI 既定）', '(none — all CLI defaults)')}
                        </div>
                      </div>
                    )}
                  </div>
                )
              ) : (
                <>
                  {/* 更新提案の What/Why/How は**現行版との差分の体**で書く（Protocol 改定）。
                      「今の skill はどうで、何が足りず、この更新がどう埋めるか」を読者が
                      追えるようにするための約束で、実態が全文すげ替えでも提案文は差分で語る。 */}
                  {selected.alreadyAdopted && (
                    <div className="text-xs text-muted-foreground">
                      {L(
                        '更新提案 — 以下は現行版との差分（追加/修正/削減）の体で記述されています。',
                        'Update proposal — What/Why/How below is written as a delta (add/fix/remove) against the currently adopted version.'
                      )}
                    </div>
                  )}
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                    <dt className="text-muted-foreground">What</dt>
                    <dd>{selected.what}</dd>
                    <dt className="text-muted-foreground">Why</dt>
                    <dd>{selected.why}</dd>
                    <dt className="text-muted-foreground">How</dt>
                    <dd>{selected.how}</dd>
                  </dl>

                  {/* 評価軸 */}
                  <div>
                    <div className="font-medium mb-1">{L('評価軸', 'Evaluation axes')}</div>
                    <table className="w-full text-xs">
                      <tbody>
                        {selected.axes.map((a) => (
                          <tr key={a.axis} className="border-b border-border/50">
                            <td className="py-1 pr-2 text-muted-foreground whitespace-nowrap">
                              {a.axis}
                            </td>
                            <td className="py-1 pr-2 font-mono">{a.score ?? '-'}</td>
                            <td className="py-1">{a.rationale}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* レビューボックス（レビューゲート拡張点） */}
                  <div>
                    <div className="font-medium mb-1 flex items-center gap-2 flex-wrap">
                      <span>
                        {L('レビューボックス（レビューゲート）', 'Review box (review gate)')}
                      </span>
                      {selected.reviewBox.reviewerId && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-mono">
                          {L('レビュー済', 'reviewed')}: {selected.reviewBox.reviewerId}
                        </span>
                      )}
                      {/* B-1/B-3: レビュー導線はここに集約する（一覧行に置くとレイアウトが荒れるため）。
                          表示条件は gate.reviewButtonVisible = 「採用ゲートを解除できる approve でない」。
                          stale approve でも出す — 採用は拒否されるのに再レビュー導線が消えると回復不能になる。 */}
                      <span className="ml-auto flex items-center gap-1">
                        {selected.gate.reviewButtonVisible && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[11px]"
                            title={
                              reviewerStatus && !reviewerStatus.available
                                ? reviewerStatus.detail
                                : L(
                                    '独立レビューを実行（read-only）',
                                    'Run independent review (read-only)'
                                  )
                            }
                            disabled={
                              busy ||
                              reviewingPath !== null ||
                              !!selected.parseError ||
                              (reviewerStatus !== null && !reviewerStatus.available)
                            }
                            onClick={() => void runReview(selected)}
                          >
                            <ShieldCheck size={11} className="mr-1" />
                            {reviewingPath === selected.filePath
                              ? L('実行中…', 'running…')
                              : L('Codex レビュー', 'Codex review')}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[11px]"
                          title={L(
                            'レビュー依頼プロンプトをコピー（ボタンが内部で使う文と同一）',
                            'Copy the review request prompt (same text the button uses)'
                          )}
                          disabled={!!selected.parseError}
                          onClick={() => void copyReviewRequest(selected)}
                        >
                          {L('依頼文コピー', 'Copy request')}
                        </Button>
                      </span>
                    </div>
                    <div className="text-xs bg-muted/40 rounded p-2 space-y-0.5">
                      <div>verdict: {selected.reviewBox.verdict || '(pending)'}</div>
                      <div>findings: {selected.reviewBox.findings || '-'}</div>
                      <div>reviewer: {selected.reviewBox.reviewerId || '-'}</div>
                      <div>cc_rebuttal: {selected.reviewBox.ccRebuttal || '-'}</div>
                    </div>
                  </div>

                  {/* B-2: ゲート状態と「採用ボタンが押せない理由」の可視化。
                      main 側で採用ゲートと同一の判定から導出した値を表示する（表示と実判定の二重実装を作らない）。 */}
                  <div>
                    <div className="font-medium mb-1 flex items-center gap-2">
                      <span>{L('採用ゲートの状態', 'Adoption gate status')}</span>
                      {gateBadge(selected.gate)}
                    </div>
                    <div className="text-xs bg-muted/40 rounded p-2 space-y-2">
                      {/* 「ゲート上は可」で濁さず、押せない理由と、採用時にしか判定できない項目を
                          両方そのまま印字する（maintainer指摘 2026-08-07）。 */}
                      {adoptBlockers(selected).length > 0 ? (
                        <div className="space-y-0.5">
                          <div className="text-red-600">
                            {L('採用不可 — 次を満たす必要があります:', 'Cannot adopt — needs:')}
                          </div>
                          <ul className="list-disc pl-4 space-y-0.5">
                            {adoptBlockers(selected).map((r) => (
                              <li key={r}>{r}</li>
                            ))}
                          </ul>
                        </div>
                      ) : (
                        <div className="text-emerald-700">
                          {L('採用可（いま押せます）', 'Adoptable (the button is enabled)')}
                        </div>
                      )}
                      {selected.gate.adoptTimeChecks.length > 0 && (
                        <div className="space-y-0.5">
                          <div className="text-muted-foreground">
                            {L(
                              'この画面では確認できず、採用を押した瞬間に再判定する項目:',
                              'Verified only at the moment you press adopt (cannot be checked here):'
                            )}
                          </div>
                          <ul className="list-disc pl-4 space-y-0.5 text-muted-foreground">
                            {selected.gate.adoptTimeChecks.map((c) => (
                              <li key={c}>{c}</li>
                            ))}
                          </ul>
                          <div className="text-muted-foreground">
                            {L(
                              'いずれかを満たさない場合は採用が拒否され、変更は一切適用されません。',
                              'If any fails, adoption is refused and nothing is applied.'
                            )}
                          </div>
                        </div>
                      )}
                      {/* レビュー導線のボタンはレビューボックス見出しへ集約済み。ここでは不在理由だけ出す。 */}
                      {reviewerStatus && !reviewerStatus.available && (
                        <div className="text-amber-600">
                          {L('レビュアー不在: ', 'Reviewer unavailable: ')}
                          {reviewerStatus.detail}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 一覧データが旧形式のときは黙って隠さない。握り潰すと
                      「なぜか刈り取り状況が出ない」という別の無言バグになる。 */}
                  {isStaleShape(selected) && (
                    <div className="text-xs rounded p-2 bg-amber-500/10 text-amber-700">
                      {L(
                        '一覧データが旧形式です（刈り取り状況を表示できません）。アプリの再起動が必要な可能性があります。',
                        'The list data is in an older shape (harvest status unavailable). A restart may be required.'
                      )}
                    </div>
                  )}

                  {/* 刈り取り状況。推奨バッジは「レビュアーが approve と言った」ではなく
                      「CC が全指摘を裁定し切った」を意味するので、その内訳と理由を全文で見せる。
                      棄却の妥当性を判定できるのは機械ではなく人間なので、材料をそのまま出す。 */}
                  {harvestOf(selected).findingCount > 0 && (
                    <div>
                      <div className="font-medium mb-1">
                        {L('指摘の刈り取り状況', 'Findings harvest status')}
                      </div>
                      <div className="text-xs bg-muted/40 rounded p-2 space-y-2">
                        <div className="flex flex-wrap gap-x-3 gap-y-1">
                          <span>
                            {L('指摘', 'Findings')} {harvestOf(selected).findingCount}
                          </span>
                          <span className="text-emerald-700">
                            {L('棄却（的外れ）', 'Rejected (off-target)')}{' '}
                            {harvestOf(selected).rejected.length}
                          </span>
                          <span className="text-amber-700">
                            {L('据え置き（妥当・未修正）', 'Deferred (valid, unfixed)')}{' '}
                            {harvestOf(selected).deferred.length}
                          </span>
                          {!harvestOf(selected).ok && (
                            <span className="text-rose-700">
                              {L('未裁定あり', 'Unadjudicated remain')}
                            </span>
                          )}
                        </div>
                        {(selected.adjudications ?? []).map((a) => (
                          <div key={a.id} className="border-t border-border/60 pt-1">
                            <div
                              className={
                                a.decision === 'deferred' ? 'text-amber-700' : 'text-emerald-700'
                              }
                            >
                              [{a.id}]{' '}
                              {a.decision === 'deferred'
                                ? L('妥当だが未修正', 'valid but unfixed')
                                : a.decision === 'rejected'
                                  ? L('CC が棄却', 'rejected by CC')
                                  : a.decision}
                            </div>
                            <div className="whitespace-pre-wrap text-muted-foreground">
                              {a.reason}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/**
                   * ユーザー → CC の対話。**指摘の有無に関わらず全提案に出す**（設計 §3-1）。
                   *
                   * 旧「方針を添えて差し戻す」はここへ統合して廃止した。旧 UI には 2 つの欠陥があった:
                   * (a) 指摘つき提案にしか出ず、**クリーンな推奨提案には意見を言う経路が無かった**
                   *     — CC が「問題なし」と言い切った提案に異議を挟めない統治の非対称
                   * (b) 入力が保存されず、送った記録も残らず、応答も戻ってこなかった
                   *
                   * いまは投稿が永続化され、未応答なら採用がブロックされ、CC の応答が
                   * focus 復帰でこの画面へ戻る。terminal 判定は子側で行う（案内文へ出し分け）。
                   */}
                  <CommentThread
                    requestId={selected.requestId}
                    filePath={selected.filePath}
                    proposalHash={selected.ackBinding?.proposalHash ?? ''}
                    isTerminal={selected.state === 'adopted' || selected.state === 'rejected'}
                    view={commentViewFor(selected)}
                    loadFailed={commentStatusFor(selected) === 'error'}
                    busy={busy}
                    onChanged={() => refreshCommentThread(selected)}
                    L={L}
                  />

                  {/* コメント応答の ack。**findings ack とは独立の操作**（finding#1）。
                      ここを findings 用チェックに相乗りさせると、findings ack が不要な提案では
                      チェックする対象が画面に無く、ack できず採用もできない行き止まりになる。 */}
                  {(commentViewFor(selected)?.gate?.ackRequired.length ?? 0) > 0 && (
                    <label className="flex items-start gap-2 text-xs text-violet-700 select-none cursor-pointer">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={commentsAck}
                        onChange={(e) => setCommentsAck(e.target.checked)}
                      />
                      <span>
                        {L(
                          `上のコメント応答 ${commentViewFor(selected)?.gate?.ackRequired.length} 件を確認した（以前の版に対する応答・機械検証が効かない応答を含む。承知のうえで採用する）`,
                          `I have reviewed the ${commentViewFor(selected)?.gate?.ackRequired.length} comment response(s) above (including responses to earlier versions or ones machine verification cannot confirm) and accept them`
                        )}
                      </span>
                    </label>
                  )}

                  {/* 指摘全文の提示と、承知のうえで採用する明示操作。
                      対象は降格ラベル、または「推奨だが据え置き指摘を含む」提案。
                      ここが本アプリ → ユーザーへの責任譲渡点になる。 */}
                  {selected.gate.findingsAckRequired && (
                    <div>
                      <div className="font-medium mb-1 text-violet-600">
                        {L(
                          '指摘（findings）全文 — 確認のうえ採用してください',
                          'Findings (full) — acknowledge before adopting'
                        )}
                      </div>
                      <pre className="text-xs bg-muted/40 rounded p-2 overflow-auto max-h-60 whitespace-pre-wrap">
                        {selected.reviewBox.findings ||
                          L('(findings が記録されていません)', '(no findings recorded)')}
                      </pre>
                      {/* findings が空なら「確認した」を成立させない（main 側の検証が正だが、UI でも塞ぐ）。 */}
                      <label
                        className={cn(
                          'flex items-center gap-2 text-xs select-none mt-1',
                          selected.reviewBox.findings
                            ? 'text-violet-700 cursor-pointer'
                            : 'text-muted-foreground cursor-not-allowed'
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={findingsAck}
                          disabled={!selected.reviewBox.findings}
                          onChange={(e) => setFindingsAck(e.target.checked)}
                        />
                        {/* 表示と監査記録で同じ文言を使う（ackLabel が単一ソース） */}
                        {ackLabel(selected)}
                      </label>
                    </div>
                  )}

                  {/* 採用される SKILL.md プレビュー */}
                  {skillBody && (
                    <details>
                      <summary className="cursor-pointer text-muted-foreground select-none">
                        {L('採用される SKILL.md を表示', 'Show SKILL.md to be adopted')}
                      </summary>
                      <pre className="text-xs bg-muted/40 rounded p-2 mt-1 overflow-auto max-h-60 whitespace-pre-wrap">
                        {skillBody}
                      </pre>
                    </details>
                  )}

                  {/* 採用される付随ファイルプレビュー (069 追補 01: Z-1) */}
                  {proposedFiles.length > 0 && (
                    <div className="space-y-2 mt-2">
                      <div className="font-medium text-xs text-muted-foreground">
                        {L(
                          `採用される付随ファイル (${proposedFiles.length} 件)`,
                          `Companion files to be adopted (${proposedFiles.length})`
                        )}
                      </div>
                      {proposedFiles.map((file) => (
                        <details key={file.path} className="border border-border/50 rounded p-1.5 text-xs">
                          <summary className="cursor-pointer font-mono font-medium text-primary select-none flex items-center gap-1.5">
                            <span>📄</span>
                            <span>{file.path}</span>
                            <span className="text-[10px] text-muted-foreground font-normal">
                              ({file.content.length} chars)
                            </span>
                          </summary>
                          <pre className="text-xs bg-muted/40 rounded p-2 mt-1.5 overflow-auto max-h-48 whitespace-pre-wrap font-mono">
                            {file.content}
                          </pre>
                        </details>
                      ))}
                    </div>
                  )}

                  {/* 未レビュー recommend の break-glass（採用ゲート）。独立レビュー未実施を承知で採用する明示確認。
                      **指摘つき（未裁定）では出さない** — そこは override でも採用できないので、
                      チェックできるのに何も起きないチェックボックスは嘘になる（maintainer裁定 2026-08-07）。 */}
                  {selected.needsReview && selected.gate.state !== 'downgraded' && (
                    <label className="flex items-center gap-2 text-xs text-amber-600 select-none cursor-pointer">
                      <input
                        type="checkbox"
                        checked={reviewOverride}
                        onChange={(e) => setReviewOverride(e.target.checked)}
                      />
                      {L(
                        '承認（approve）されていないが承知の上で採用する（独立レビュー推奨）',
                        'Adopt without an approving review, understood (independent review recommended)'
                      )}
                    </label>
                  )}

                  {/* golden 同名衝突時の 2 操作 (CCPIT_064 / CCPIT_066) */}
                  {selected.goldenCollision && (() => {
                    const cardModel = getGoldenCollisionCardModel(
                      selected.goldenCollisionStatus === 'none'
                        ? 'unapplied'
                        : selected.goldenCollisionStatus,
                      L
                    )
                    // 合成〜昇格の流れを、このカード 1 枚に集約する（ボタン列と進み具合を別の枠に分けない）。
                    // 反映済み（applied）は流れの対象外で、従来どおり「採用済みにする」だけを出す。
                    const flowOn = cardModel.status !== 'applied' && !!selected.skillName
                    const st = flowOn ? pickStatusForSkill(composeStatuses, selected.skillName!) : null
                    // 取り消しだけの履歴は出さない（改訂の取り消しは、同じ改訂をやり直せるよう出す）
                    // 案件（caseId あり）は取消もカードに出す（表示の行列に取消の行があるため）
                    const view =
                      st && !(st.phase === 'cancelled' && !st.revises && !st.caseId)
                        ? composeStatusView(st, ja)
                        : null
                    const isCase = !!st?.caseId
                    // 主操作は常に 1 つ。進み具合が次の操作を決めているときは、合成の開始ボタンを重ねて出さない
                    // （昇格済みは終端で主操作を持たないので、案件・旧形式とも開始ボタンが戻る）
                    const flowOwnsPrimary = composeFlowOwnsPrimary(st, view, deriveCaseView)
                    return (
                      <div className={cardModel.containerClassName}>
                        <div className="flex items-start gap-2">
                          {cardModel.iconName === 'check-circle-2' ? (
                            <CheckCircle2 className={cardModel.iconClassName} size={16} />
                          ) : (
                            <AlertTriangle className={cardModel.iconClassName} size={16} />
                          )}
                          <div className="text-xs space-y-1 flex-1">
                            <p className="font-semibold">{cardModel.title}</p>
                            <p className="text-muted-foreground">{cardModel.description}</p>
                          </div>
                          <button
                            type="button"
                            aria-label={L('この画面の押し方', 'How to use this panel')}
                            title={L('この画面の押し方', 'How to use this panel')}
                            className="shrink-0 text-muted-foreground hover:text-foreground"
                            onClick={() => setCollisionHelpOpen(true)}
                          >
                            <HelpCircle size={16} />
                          </button>
                        </div>
                        {flowOn && (
                          <div className="rounded border border-border bg-background/60 p-2 space-y-2">
                            {/* いまの段と、次に押すボタン。合成 → 独立レビュー → 昇格画面で承認 */}
                            <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                              {composeFlowSteps(view ? st : null, ja).map((step, i) => (
                                <li key={step.key} className="flex items-center gap-2">
                                  {i > 0 && <span className="text-muted-foreground">→</span>}
                                  <div className="flex flex-col">
                                  <span
                                    className={
                                      step.state === 'current'
                                        ? 'rounded px-2 py-0.5 bg-primary text-primary-foreground font-semibold'
                                        : step.state === 'done'
                                          ? 'rounded px-2 py-0.5 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                                          : step.state === 'attention'
                                            ? 'rounded px-2 py-0.5 bg-red-500/15 text-red-700 dark:text-red-400 font-semibold'
                                            : 'rounded px-2 py-0.5 bg-muted text-muted-foreground'
                                    }
                                  >
                                    {step.state === 'done' ? '✓ ' : ''}
                                    {step.label}
                                  </span>
                                  {step.key === 'compose' && st && sourceNoteFor(st, ja) && (
                                    <span className="text-[10px] text-muted-foreground" data-testid="source-note">
                                      {sourceNoteFor(st, ja)}
                                    </span>
                                  )}
                                  </div>
                                </li>
                              ))}
                            </ol>
                            {view && isCase && st && (
                              <ComposeCaseCard
                                status={st}
                                ja={ja}
                                lastFetchedMs={composeFetchedAt}
                                watching={composeWatching}
                                onOpenPromotion={openPromotionFor}
                                onConsult={() => void consultGoldenMerge(selected)}
                                onCancel={(ws) => void cancelCompose(ws)}
                                onChanged={() => void refreshComposeStatuses()}
                              />
                            )}
                            {view && !isCase && (
                              <div className="text-xs space-y-1">
                                <p className="font-semibold">{view.headline}</p>
                                {view.detail.map((d, i) => (
                                  <p key={i} className="text-muted-foreground whitespace-pre-wrap">
                                    {d}
                                  </p>
                                ))}
                                {view.cancellable && (
                                  <ComposeStaleNotice lastFetchedMs={composeFetchedAt} watching={composeWatching} ja={ja} />
                                )}
                              </div>
                            )}
                            {selected.skillName && (
                              <ReceptaclePanel
                                skillName={selected.skillName}
                                ja={ja}
                                list={receptacles}
                                onClose={closeReceptacle}
                              />
                            )}
                            <div className="flex flex-wrap items-center gap-2">
                              {!isCase && view?.next === 'openPromotion' && view.compositeId && (
                                <Button size="sm" onClick={() => openPromotionFor(view.compositeId!)}>
                                  <Play size={13} className="mr-1" />
                                  {L('昇格画面で開く（承認はそこで）', 'Open in the promotion screen (approve there)')}
                                </Button>
                              )}
                              {!isCase && view?.next === 'revise' && view.compositeId && (
                                <Button size="sm" disabled={busy} onClick={() => void reviseCompose(view.compositeId!)}>
                                  <Play size={13} className="mr-1" />
                                  {L('指摘を反映して改訂する', 'Revise with the findings')}
                                </Button>
                              )}
                              {!isCase && view?.cancellable && st && (
                                <Button size="sm" variant="outline" onClick={() => void cancelCompose(st.workspaceDir)}>
                                  {L('合成を取り消す', 'Cancel the composition')}
                                </Button>
                              )}
                            </div>
                          </div>
                        )}
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          {cardModel.buttons
                            .filter((btn) => !(flowOwnsPrimary && btn.action === 'composeGoldenMerge'))
                            .map((btn) => (
                            <Button
                              key={btn.action}
                              size="sm"
                              variant={btn.variant}
                              disabled={
                                busy ||
                                (btn.action === 'markAsAdoptedMerged' && selected.state === 'adopted')
                              }
                              onClick={() =>
                                void executeGoldenCollisionAction(btn.action, selected, {
                                  composeGoldenMerge,
                                  consultGoldenMerge,
                                  markAsAdoptedMerged
                                })
                              }
                            >
                              {btn.action === 'markAsAdoptedMerged' ? (
                                <Check size={13} className="mr-1" />
                              ) : (
                                <Play size={13} className="mr-1" />
                              )}
                              {btn.label}
                            </Button>
                          ))}
                        </div>
                        {cardModel.markRequiresAck && markAckPendingId === selected.requestId && (
                          <div className="rounded border border-amber-500/40 bg-background/60 p-2 text-xs space-y-2">
                            <p>{cardModel.markAckText}</p>
                            <div className="flex items-center gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() => void markAsAdoptedMerged(selected, true)}
                              >
                                {L('何も適用されないと承知で採用済みにする', 'Mark as adopted, understood')}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setMarkAckPendingId(null)}
                              >
                                {L('やめる', 'Cancel')}
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })()}

                  {/* 合成の元提案の選択: 選べる提案は既定で全件チェック、選べない提案は理由つきで無効。実行は「まとめて合成」の 1 つ */}
                  <Dialog
                    open={picker !== null}
                    onOpenChange={(o) => {
                      // 準備中（IPC の復帰まで）は閉じない。閉じると押した場所の表示が消える
                      if (!o && !composeStarting) setPicker(null)
                    }}
                  >
                    <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
                      <DialogHeader>
                        <DialogTitle>{L('合成の元にする提案を選ぶ', 'Choose the proposals to compose')}</DialogTitle>
                        <DialogDescription>
                          {L(
                            '選んだ提案だけを、今の golden に重ねて 1 本にします。選ばなかった提案は消えず、この合成の昇格が終わるまで昇格候補から外れます（終わると「提案が古い」として戻り、改めて選べます）。',
                            'Only the chosen proposals are composed onto the current golden. Unchosen proposals are not lost; they are set aside until this composition is promoted (then they return as out of date and can be chosen again).'
                          )}
                        </DialogDescription>
                      </DialogHeader>
                      {picker && (
                        <div className="space-y-2 text-sm" data-testid="compose-picker">
                          <p className="text-xs text-muted-foreground">
                            {L(
                              `対象の skill: ${picker.skillName}（他の skill の提案は対象外です）`,
                              `Skill: ${picker.skillName} (proposals for other skills are out of scope)`
                            )}
                          </p>
                          {picker.items.map((it) => (
                            <label
                              key={it.requestId}
                              className={cn(
                                'flex items-start gap-2 rounded border border-border p-2',
                                it.selectable ? 'cursor-pointer' : 'opacity-60 cursor-not-allowed'
                              )}
                            >
                              <input
                                type="checkbox"
                                className="mt-1"
                                disabled={!it.selectable}
                                checked={it.selectable && picker.selected.has(it.requestId)}
                                onChange={() =>
                                  setPicker((cur) =>
                                    cur
                                      ? { ...cur, selected: togglePickerSelection(cur.selected, it.requestId, cur.items) }
                                      : cur
                                  )
                                }
                              />
                              <span className="min-w-0 flex-1">
                                <span className="font-medium break-words">{it.title}</span>
                                <span className="block font-mono text-[11px] text-muted-foreground break-all">
                                  {it.requestId}
                                </span>
                                {!it.selectable && (
                                  <span className="block text-xs text-amber-600 dark:text-amber-400">
                                    {pickerReasonText(it, ja)}
                                  </span>
                                )}
                              </span>
                            </label>
                          ))}
                          {!canSubmitPicker(picker.selected, picker.items) && (
                            <p className="text-xs text-red-600 dark:text-red-400">
                              {L('合成の元にする提案を 1 件以上選んでください', 'Choose at least one proposal')}
                            </p>
                          )}
                        </div>
                      )}
                      <DialogFooter>
                        {composeStarting && <ComposeStartingNotice ja={ja} />}
                        <Button variant="outline" size="sm" disabled={composeStarting} onClick={() => setPicker(null)}>
                          {L('やめる', 'Cancel')}
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy || !picker || !canSubmitPicker(picker.selected, picker.items)}
                          onClick={() => void startComposeWithPicked()}
                        >
                          <Play size={13} className="mr-1" />
                          {L('まとめて合成', 'Compose together')}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>

                  {/* golden 同名カードの「？」: 状態ごとに、いつ・どれを・押すと何が起きるか */}
                  <Dialog open={collisionHelpOpen} onOpenChange={setCollisionHelpOpen}>
                    <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
                      <DialogHeader>
                        <DialogTitle>
                          {L('golden 同名の提案: ボタンの押し方', 'Golden-name proposals: which button to press')}
                        </DialogTitle>
                        <DialogDescription>
                          {L(
                            '提案の中身が golden に入っているかどうかで、押すボタンが決まります。',
                            'Which button to press depends on whether the proposal is already in the golden version.'
                          )}
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-3 text-sm">
                        {getGoldenCollisionHelp(L).map((scene) => (
                          <div key={scene.key} className="rounded border border-border p-3 space-y-1">
                            <p className="font-semibold">{scene.title}</p>
                            <p>
                              <span className="text-muted-foreground">{L('いまの状態: ', 'Situation: ')}</span>
                              {scene.situation}
                            </p>
                            <p>
                              <span className="text-muted-foreground">{L('押すボタン: ', 'Press: ')}</span>
                              {scene.press}
                            </p>
                            <p>
                              <span className="text-muted-foreground">{L('起きること: ', 'What happens: ')}</span>
                              {scene.effect}
                            </p>
                          </div>
                        ))}
                      </div>
                    </DialogContent>
                  </Dialog>

                  {/* 採用アクション */}
                  <div className="flex items-center gap-2 pt-2 border-t border-border select-none">
                    {hasPassword && (
                      <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder={L('パスワード', 'password')}
                        className="px-2 py-1 text-sm border border-border rounded bg-background w-40"
                      />
                    )}
                    <Button
                      size="sm"
                      onClick={() => void adopt(selected)}
                      // 押せない理由の一覧（adoptBlockers）と同一ソース。
                      // 別々に書くと「理由は出ないのに押せない」等のズレが必ず生まれる。
                      disabled={adoptBlockers(selected).length > 0}
                    >
                      <Check size={14} className="mr-1" />
                      {selected.alreadyAdopted
                        ? L('更新として採用 (Update)', 'Adopt as update (Update)')
                        : L('採用 (Apply)', 'Adopt (Apply)')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void changeState(selected, 'held')}
                      disabled={busy}
                    >
                      <PauseCircle size={14} className="mr-1" />
                      {L('保留', 'Hold')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void changeState(selected, 'rejected')}
                      disabled={busy}
                    >
                      <X size={14} className="mr-1" />
                      {L('却下', 'Reject')}
                    </Button>
                  </div>

                  {/* 更新採用の安全弁 3 点をユーザーに約束する（実装は adoptApply Step 3.65）:
                      (1) 採用時に現行版の content hash を CAS 検証（外部変更があれば拒否）
                      (2) 旧版は圧縮アーカイブへ退避（消さない）
                      (3) いつでもロールバック可能。
                      文言だけ約束して実装が無い状態を作らないこと（表示と実判定の同源原則）。 */}
                  {selected.alreadyAdopted && (
                    <div className="text-xs text-purple-600 space-y-0.5">
                      <div>
                        {L(
                          'この採用は「更新（差し替え）」として実行されます。',
                          'This adoption runs as an update (replacement of the adopted version).'
                        )}
                      </div>
                      <ul className="list-disc pl-4 text-muted-foreground">
                        <li>
                          {L(
                            '採用時に現行版の内容一致を検証し、外部変更があれば拒否します。',
                            'The current version is content-verified at adopt time; external changes cause refusal.'
                          )}
                        </li>
                        <li>
                          {L(
                            '旧版は圧縮アーカイブに保存され、いつでもロールバックできます。',
                            'The old version is archived (compressed) and can be rolled back at any time.'
                          )}
                        </li>
                      </ul>
                    </div>
                  )}
                </>
              )}

              {message && (
                <div
                  className={cn(
                    'text-sm rounded p-2',
                    message.kind === 'ok' && 'bg-green-500/15 text-green-700',
                    message.kind === 'err' && 'bg-red-500/15 text-red-700',
                    message.kind === 'info' && 'bg-blue-500/15 text-blue-700'
                  )}
                >
                  {message.text}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <DialogueSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} L={L} />
    </div>
  )
}
