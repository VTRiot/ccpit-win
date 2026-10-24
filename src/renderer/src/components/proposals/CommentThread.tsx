import { useState } from 'react'
import { MessageSquare, Play, Copy, Undo2, ShieldAlert, RefreshCw } from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'

type CommentThreadView = Awaited<ReturnType<typeof window.api.skillProposalsCommentThread>>
type ProposalComment = CommentThreadView['comments'][number]

/**
 * ユーザーコメント → CC 対話のスレッド UI。
 *
 * **このコンポーネントは自分でデータを取得しない。** 親（SkillProposalsPage）が
 * `CommentThreadView` を単一 state として所有し、props で配る。子が独自に fetch すると
 * 「スレッド表示」と「採用ボタンの disabled」が別々の読み取り結果に基づくことになり、
 * 投稿直後に “未応答なのに採用ボタンが押せる” というズレが生まれる（Plan Codex レビュー finding#3）。
 * 変更操作のあとは `onChanged()` を呼び、**親が 1 回だけ**取り直す。
 *
 * 既存規律との同型: 本ページは「表示と disabled を別々に書くと必ずずれる」ため
 * `adoptBlockers()` を単一ソースにしている（SkillProposalsPage の設計コメント参照）。
 * コメント系もその原則へ合流させる。
 */
export interface CommentThreadProps {
  requestId: string
  filePath: string
  /** 現在の提案 content hash。投稿時の CAS と「以前の版へのコメント」判定に使う */
  proposalHash: string
  /** terminal（採用済 / 却下済）では投稿欄を出さない */
  isTerminal: boolean
  view: CommentThreadView | null
  /** スレッド取得に失敗した（`view` が null でも「コメント無し」ではない・finding#4） */
  loadFailed?: boolean
  busy: boolean
  /** 変更操作の後に親へ再取得を促す */
  onChanged: () => void | Promise<void>
  /** 親と同じ i18n ヘルパを共有する（文言の二重管理を作らない） */
  L: (j: string, e: string) => string
}

export function CommentThread({
  requestId,
  filePath,
  proposalHash,
  isTerminal,
  view,
  loadFailed,
  busy,
  onChanged,
  L
}: CommentThreadProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [launching, setLaunching] = useState(false)
  /** 直近の起動で実際に CC へ渡した引数（設定が効いているかの物理証拠として出す） */
  const [appliedFlags, setAppliedFlags] = useState<string[] | null>(null)
  /** 安全でないため落とした設定値（黙って捨てず、目立つ形で出す） */
  const [rejected, setRejected] = useState<string[]>([])
  /** 直近の起動が成功したか。**失敗時に「渡した」と言わない**ためのラベル切替（finding#4） */
  const [launchOk, setLaunchOk] = useState(false)

  const comments = view?.comments ?? []
  const brokenIds = new Set(view?.brokenIds ?? [])
  const gate = view?.gate ?? null
  const openCount = gate?.openCount ?? comments.filter((c) => c.status === 'open').length

  /**
   * 投稿。**hash 不一致（retryable）でも入力を捨てない。**
   * 書いた文章を消されるのは、書き直しコストが最も高い失敗であり、
   * 「提案が更新された」は利用者の過失ではない。
   */
  const post = async (): Promise<void> => {
    if (!draft.trim() || sending) return
    setSending(true)
    setNotice(null)
    try {
      const r = await window.api.skillProposalsAddComment(requestId, filePath, draft, proposalHash)
      if (r.ok) {
        setDraft('') // 成功時のみクリア
        setNotice({ kind: 'ok', text: L('コメントを投稿しました。', 'Comment posted.') })
        await onChanged()
      } else if (r.retryable) {
        // 入力は保持したまま、取り直してから再送させる
        setNotice({
          kind: 'err',
          text: L(
            '提案が更新されています。内容を確認して、そのまま再送してください（入力は保持しています）。',
            'The proposal changed. Review it and re-send (your text is kept).'
          )
        })
        await onChanged()
      } else {
        setNotice({ kind: 'err', text: r.reason ?? L('投稿に失敗しました。', 'Failed to post.') })
      }
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setSending(false)
    }
  }

  const withdraw = async (commentId: string): Promise<void> => {
    const r = await window.api.skillProposalsWithdrawComment(requestId, filePath, commentId)
    if (!r.ok) setNotice({ kind: 'err', text: r.reason ?? 'failed' })
    await onChanged()
  }

  const supersede = async (commentId: string): Promise<void> => {
    const r = await window.api.skillProposalsSupersedeComment(requestId, filePath, commentId)
    if (!r.ok) setNotice({ kind: 'err', text: r.reason ?? 'failed' })
    await onChanged()
  }

  const quarantine = async (commentId: string): Promise<void> => {
    const r = await window.api.skillProposalsQuarantineComment(
      requestId,
      commentId,
      'broken-record',
      L('UI の検査で壊れたレコードとして検出', 'Detected as a broken record by the UI check')
    )
    if (!r.ok) setNotice({ kind: 'err', text: r.reason ?? 'failed' })
    await onChanged()
  }

  /** 導線①: アプリが CC を起動する（設定が効くのはこちらだけ） */
  const launchDialogue = async (): Promise<void> => {
    setLaunching(true)
    setNotice(null)
    // 前回の診断表示を必ず消す（finding#4: IPC 例外時に前回値が「今回渡した」ように残る）
    setAppliedFlags(null)
    setRejected([])
    setLaunchOk(false)
    try {
      const r = await window.api.skillProposalsLaunchDialogue(requestId, filePath)
      // 実際に渡した引数を保持し、下に常時表示する。
      // 「設定したのに効いていない気がする」を推測でなく即断できるようにするため（maintainer FB）。
      setAppliedFlags(r.appliedFlags ?? null)
      setRejected(r.rejectedSettings ?? [])
      setLaunchOk(r.ok)
      setNotice(
        r.ok
          ? {
              kind: 'ok',
              text: L(
                'CC を起動しました。応答が保存されると、この画面に戻ってきたとき自動で反映されます。',
                'Launched CC. The response will appear here automatically when you come back to this window.'
              )
            }
          : { kind: 'err', text: r.error ?? L('起動に失敗しました。', 'Launch failed.') }
      )
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setLaunching(false)
    }
  }

  /** 導線②: 依頼文をコピー（開いている別セッションへ貼る用。設定は効かない） */
  const copyDialogue = async (): Promise<void> => {
    try {
      const text = await window.api.skillProposalsCommentDialogueText(requestId, filePath)
      await window.api.clipboardWrite(text)
      setNotice({
        kind: 'ok',
        text: L('依頼文をコピーしました。', 'Copied the dialogue request.')
      })
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    }
  }

  const statusBadge = (c: ProposalComment): React.JSX.Element => {
    const map: Record<string, { j: string; e: string; cls: string }> = {
      open: { j: '未応答', e: 'open', cls: 'bg-amber-500/15 text-amber-600' },
      resolved: { j: '応答済', e: 'resolved', cls: 'bg-green-500/15 text-green-600' },
      withdrawn: { j: '取り下げ', e: 'withdrawn', cls: 'bg-muted text-muted-foreground' },
      quarantined: { j: '隔離', e: 'quarantined', cls: 'bg-red-500/15 text-red-600' },
      superseded: { j: '無効化', e: 'superseded', cls: 'bg-violet-500/15 text-violet-600' }
    }
    const m = map[c.status] ?? { j: c.status, e: c.status, cls: 'bg-muted text-muted-foreground' }
    return (
      <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-mono', m.cls)}>
        {L(m.j, m.e)}
      </span>
    )
  }

  return (
    <div>
      <div className="font-medium mb-1 flex items-center gap-2">
        <MessageSquare size={14} />
        <span>{L('CC と対話する', 'Talk to CC')}</span>
        {openCount > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 font-mono">
            {L(`未応答 ${openCount}`, `${openCount} unanswered`)}
          </span>
        )}
      </div>

      {/* 取得失敗を「コメント無し」に見せない（finding#4）。採用側も fail-closed で止める。 */}
      {loadFailed && (
        <div className="text-xs rounded p-2 mb-1 bg-red-500/10 text-red-700">
          {L(
            'コメントの状態を取得できませんでした。採用は安全側で止めています（更新して再試行してください）。',
            'Could not load the comment state. Adoption is blocked fail-closed (please refresh and retry).'
          )}
        </div>
      )}

      {/* ストアが読めない / 修復未確認は**全提案に影響するグローバル状態**なので、
          黙って隠さず理由を出す（握り潰すと「なぜか全部採用できない」になる） */}
      {view?.storeProblem && (
        <div className="text-xs rounded p-2 mb-1 bg-red-500/10 text-red-700">
          {L('コメントストアを読めません: ', 'Cannot read the comment store: ')}
          {view.storeProblem}
        </div>
      )}
      {view?.repairPending && !view?.storeProblem && (
        <div className="text-xs rounded p-2 mb-1 bg-amber-500/10 text-amber-700">
          {L(
            'コメントストアの修復が未確認です（全提案の採用がブロックされます）。',
            'A comment-store repair is unacknowledged (adoption is blocked for all proposals).'
          )}
        </div>
      )}

      {/* terminal では投稿させない。CC に応答を強制する手段が無く、
          「書いたのに誰も答える義務を負わない意見箱」になるため（設計 §3-1） */}
      {isTerminal ? (
        <div className="text-xs text-muted-foreground bg-muted/40 rounded p-2">
          {L(
            'この提案は確定済みです。要望がある場合は、新しい提案として出してください。',
            'This proposal is finalized. Please raise new requests as a new proposal.'
          )}
        </div>
      ) : (
        <>
          <div className="text-xs text-muted-foreground mb-1">
            {L(
              '「こうしてほしい」を書いて送ると、CC が応答するまで採用できなくなります。反映か、理由つきの却下か、必ずどちらかが返ります。',
              'Post a request. Adoption is blocked until CC responds — either applied, or declined with a reason.'
            )}
          </div>
          <textarea
            className="w-full text-xs rounded border border-border bg-background p-2 min-h-16"
            placeholder={L(
              '例: 発火条件を絞る方向で直して。既存 skill との重複は統合ではなく棲み分けで。',
              'e.g. Narrow the trigger conditions. Separate concerns rather than merging with the existing skill.'
            )}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <Button
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={!draft.trim() || sending || busy}
              onClick={() => void post()}
            >
              {sending ? L('送信中…', 'sending…') : L('送信', 'Post')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={launching || busy || openCount === 0}
              title={
                openCount === 0
                  ? L('未応答のコメントがありません', 'No unanswered comments')
                  : L('依頼文を渡して CC を起動する', 'Launch CC with the dialogue request')
              }
              onClick={() => void launchDialogue()}
            >
              <Play size={11} className="mr-1" />
              {launching
                ? L('起動中…', 'launching…')
                : L('CC を起動して応答させる', 'Launch CC to respond')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={openCount === 0}
              title={L(
                '開いている別の CC セッションへ貼る用（設定のモデル/effort/PXP は効きません）',
                'For pasting into an already-open CC session (the model/effort/PXP settings do NOT apply)'
              )}
              onClick={() => void copyDialogue()}
            >
              <Copy size={11} className="mr-1" />
              {L('依頼文をコピー', 'Copy request')}
            </Button>
          </div>
          <div className="text-[11px] text-muted-foreground mt-1">
            {L(
              '※ 設定（モデル / effort / PXP / 権限）が効くのは「CC を起動して応答させる」および「Claude Code に修復を依頼」です。コピーは起動しないため効きません。',
              '※ The settings (model / effort / PXP / permissions) apply only to "Launch CC to respond" and "Ask Claude Code to repair". Copying does not launch, so they do not apply.'
            )}
          </div>
        </>
      )}

      {notice && (
        <div
          className={cn(
            'text-xs rounded p-2 mt-1',
            notice.kind === 'ok' && 'bg-green-500/15 text-green-700',
            notice.kind === 'err' && 'bg-red-500/15 text-red-700'
          )}
        >
          {notice.text}
        </div>
      )}

      {/* 落とした設定値は**独立した赤枠**で出す（成功メッセージの末尾に埋もれさせない） */}
      {rejected.length > 0 && (
        <div className="text-xs rounded p-2 mt-1 bg-red-500/15 text-red-700">
          <div className="font-medium">
            {L('安全でない設定値を無視しました', 'Ignored unsafe setting(s)')}
          </div>
          <div className="font-mono">{rejected.join(', ')}</div>
          <div>
            {L(
              '使えるのは 英数字 . _ - [ ] のみです（空白やシェル記号は起動コマンドを壊すため拒否しています）。',
              'Only alphanumerics and . _ - [ ] are allowed (spaces and shell characters are rejected because they break the launch command).'
            )}
          </div>
        </div>
      )}

      {/* **設定が効いているかの物理証拠**。「効いてない気がする」を推測させない。 */}
      {appliedFlags && (
        <div className="text-xs rounded p-2 mt-1 bg-muted/40">
          <div className="text-muted-foreground">
            {launchOk
              ? L('実際に CC へ渡した起動引数:', 'Launch arguments actually passed to CC:')
              : L(
                  '渡そうとした起動引数（起動は失敗しています）:',
                  'Launch arguments that were attempted (the launch failed):'
                )}
          </div>
          <div className="font-mono break-all">
            {appliedFlags.length > 0
              ? appliedFlags.join(' ')
              : L('（なし＝すべて CLI 既定）', '(none — all CLI defaults)')}
          </div>
        </div>
      )}

      {/* スレッド本体 */}
      {comments.length > 0 && (
        <div className="mt-2 space-y-2">
          {comments.map((c) => {
            const stale = !!c.proposalHashAtComment && c.proposalHashAtComment !== proposalHash
            const broken = brokenIds.has(c.id)
            const res = c.response ?? null
            const resStale = !!res && res.proposalHashAtResponse !== proposalHash
            return (
              <div key={c.id} className="text-xs border border-border/60 rounded p-2 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{L('あなた', 'You')}</span>
                  <span className="text-muted-foreground font-mono text-[10px]">{c.at}</span>
                  {statusBadge(c)}
                  {broken && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-600 font-mono">
                      {L('壊れたレコード', 'broken record')}
                    </span>
                  )}
                </div>
                <div className="whitespace-pre-wrap">{c.body}</div>

                {/* 改稿でコメントが古くなったことを黙って隠さない（誤読防止・設計 §3-5） */}
                {stale && (
                  <div className="text-amber-700">
                    {L(
                      '※ このコメントは以前の版に対するものです。',
                      '※ This comment refers to an earlier version.'
                    )}
                  </div>
                )}

                {res && (
                  <div className="border-t border-border/60 pt-1 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">CC</span>
                      <span className="text-muted-foreground font-mono text-[10px]">{res.at}</span>
                      <span
                        className={cn(
                          'text-[10px] px-1.5 py-0.5 rounded font-mono',
                          res.decision === 'applied'
                            ? 'bg-green-500/15 text-green-600'
                            : 'bg-orange-500/15 text-orange-600'
                        )}
                      >
                        {res.decision}
                      </span>
                    </div>
                    {/* 応答理由は全文。ユーザーが妥当性を判断する材料なので省略しない */}
                    <div className="whitespace-pre-wrap text-muted-foreground">{res.body}</div>
                    {(res.evidence ?? []).map((ev, i) => (
                      <div key={i} className="bg-muted/40 rounded p-1">
                        <div className="font-mono text-[10px] text-muted-foreground">
                          evidence: {ev.kind}
                        </div>
                        {ev.quote && <div className="whitespace-pre-wrap">{ev.quote}</div>}
                        {/* already_absent は機械検証がほぼ効かない。ユーザー文言と CC 引用を
                            対で並べ、人間が対応を確かめられるようにする（設計 §3-2 / r53#4） */}
                        {ev.kind === 'already_absent' && ev.userPhraseQuote && (
                          <div className="mt-1 border-t border-border/60 pt-1">
                            <div className="font-mono text-[10px] text-violet-600">
                              {L(
                                'あなたの文言（機械検証が効かないため対で確認してください）',
                                'Your phrase (machine verification is weak — please check the pairing)'
                              )}
                            </div>
                            <div className="whitespace-pre-wrap">{ev.userPhraseQuote}</div>
                          </div>
                        )}
                      </div>
                    ))}
                    {resStale && (
                      <div className="text-amber-700">
                        {L(
                          '※ この応答は以前の版に対するものです（採用には確認が要ります）。',
                          '※ This response refers to an earlier version (acknowledgement required to adopt).'
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* 操作は状態ごとに 1 つだけ出す（できない操作のボタンを見せない） */}
                <div className="flex items-center gap-2">
                  {c.status === 'open' && !isTerminal && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[11px]"
                      disabled={busy}
                      title={L('このコメントを取り下げる', 'Withdraw this comment')}
                      onClick={() => void withdraw(c.id)}
                    >
                      <Undo2 size={10} className="mr-1" />
                      {L('取り下げ', 'Withdraw')}
                    </Button>
                  )}
                  {c.status === 'resolved' && !isTerminal && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[11px]"
                      disabled={busy}
                      title={L(
                        '応答に納得できない場合、この応答を無効化して再度応答させる',
                        'If the response is unsatisfactory, invalidate it and require a new one'
                      )}
                      onClick={() => void supersede(c.id)}
                    >
                      <RefreshCw size={10} className="mr-1" />
                      {L('応答を無効化', 'Supersede')}
                    </Button>
                  )}
                  {broken && c.status !== 'quarantined' && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[11px]"
                      disabled={busy}
                      title={L(
                        '壊れたレコードを隔離する（採用には別途確認が要ります）',
                        'Quarantine the broken record (adoption still requires acknowledgement)'
                      )}
                      onClick={() => void quarantine(c.id)}
                    >
                      <ShieldAlert size={10} className="mr-1" />
                      {L('隔離', 'Quarantine')}
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 警告は要否を変えないが、判断材料として出す */}
      {(gate?.warnings.length ?? 0) > 0 && (
        <div className="text-xs bg-muted/40 rounded p-2 mt-2 space-y-0.5">
          {gate?.warnings.map((w, i) => (
            <div key={i} className={w.level === 'strong' ? 'text-rose-700' : 'text-amber-700'}>
              {w.message}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
