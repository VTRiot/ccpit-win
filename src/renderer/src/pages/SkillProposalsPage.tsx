import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FolderOpen,
  RefreshCw,
  Check,
  X,
  PauseCircle,
  AlertTriangle,
  ShieldCheck,
  Copy
} from 'lucide-react'
import { Button } from '../components/ui/button'
import { cn } from '../lib/utils'

type Proposal = Awaited<ReturnType<typeof window.api.skillProposalsList>>[number]
type ProposalState = Proposal['state']
/** WS2: 推奨バッジ提案の Codex レビューゲート判定（Main 側 evaluateProposalCodexGate の結果） */
type CodexGate = Awaited<ReturnType<typeof window.api.skillProposalsCodexGate>>

// v2: 集約先 ~/.ccpit/proposals/ への移行に伴い新キー。旧キー(_Prompt 残骸)は参照しない（クリーンブレイク）
const STORAGE_KEY_FOLDER = 'ccpit-skill-proposals-folder-v2'

export function SkillProposalsPage(): React.JSX.Element {
  const { i18n } = useTranslation()
  const ja = i18n.language.startsWith('ja')
  const L = (j: string, e: string): string => (ja ? j : e)

  const [folder, setFolder] = useState<string>('')
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [selected, setSelected] = useState<Proposal | null>(null)
  const [skillBody, setSkillBody] = useState<string>('')
  const [password, setPassword] = useState('')
  const [hasPassword, setHasPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null)
  const [codexGate, setCodexGate] = useState<CodexGate | null>(null)

  const reload = useCallback(async (dir: string): Promise<void> => {
    if (!dir) {
      setProposals([])
      return
    }
    setBusy(true)
    try {
      const list = await window.api.skillProposalsList(dir)
      setProposals(list)
    } finally {
      setBusy(false)
    }
  }, [])

  // 起動時: localStorage の明示選択(v2)があれば尊重、無ければ既定プリセット ~/.ccpit/proposals/
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
  }

  const select = async (p: Proposal): Promise<void> => {
    setSelected(p)
    setSkillBody('')
    setMessage(null)
    setCodexGate(null)
    if (p.parseError) return
    // WS2: 推奨バッジ × Codex 検出時のみ required が立つ（Codex 未導入環境では表示ごと不変）
    void window.api.skillProposalsCodexGate(p.adoptionLabel, p.requestId).then(setCodexGate)
    try {
      const req = await window.api.settingsReadRequest(p.filePath)
      if (req.kind === 'skill') setSkillBody(req.proposedSkillBody)
    } catch {
      /* preview 失敗は致命でない */
    }
  }

  const changeState = async (p: Proposal, state: ProposalState): Promise<void> => {
    await window.api.skillProposalsSetState(p.requestId, state)
    await reload(folder)
    setSelected((cur) => (cur && cur.requestId === p.requestId ? { ...cur, state } : cur))
  }

  /** WS2: レビュー実施後の再判定（CC セッションでのレビュー完了を UI に反映する動線） */
  const refreshGate = async (): Promise<void> => {
    if (!selected) return
    setCodexGate(
      await window.api.skillProposalsCodexGate(selected.adoptionLabel, selected.requestId)
    )
  }

  /** WS2: Codex レビュー依頼プロンプト（maintainer裁定原文＝棄却権条項を逐語で含む）をコピー */
  const copyReviewPrompt = async (): Promise<void> => {
    if (!selected) return
    const prompt = await window.api.skillProposalsCodexReviewPrompt({
      filePath: selected.filePath,
      requestId: selected.requestId,
      skillName: selected.skillName,
      title: selected.title
    })
    await navigator.clipboard.writeText(prompt)
    setMessage({
      kind: 'info',
      text: L(
        'レビュー依頼プロンプトをコピーしました。CC セッションに貼り付けて Codex レビューを実施し、完了後「再判定」を押してください。',
        'Review request prompt copied. Paste it into a CC session, run the Codex review, then click Re-check.'
      )
    })
  }

  const adopt = async (p: Proposal): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const req = await window.api.settingsReadRequest(p.filePath)
      const result = await window.api.settingsApplyChange(req, password)
      if (result.success) {
        await window.api.skillProposalsSetState(p.requestId, 'adopted')
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
      } else {
        const hint =
          result.reason === 'golden-name-collision'
            ? L(
                ' — golden 配布 skill と同名です。提案 skill 名を変更してください。',
                ' — same name as a golden skill. Rename the proposed skill.'
              )
            : result.reason === 'codex-review-missing'
              ? L(
                  ' — Codex レビュー未実施です。「レビュー依頼プロンプトをコピー」から実施してください。',
                  ' — Codex review missing. Use "Copy review request prompt" first.'
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
  // WS2: UI 側の先回りブロック（真の強制は Main 側 applyChange Step 3.7。ここは動線案内）
  const codexBlocked = codexGate !== null && codexGate.required && !codexGate.satisfied

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Header: folder + reload */}
      <div className="flex items-center gap-2 shrink-0">
        <h2 className="text-base font-semibold">
          {L('Skill 候補ブラウザ', 'Skill candidate browser')}
        </h2>
        <span className="text-xs text-muted-foreground">
          {L('提案を採用', 'Adopt proposals')}
        </span>
        <div className="ml-auto flex items-center gap-2">
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
        {/* List */}
        <div className="w-2/5 overflow-auto border border-border rounded-md">
          {proposals.length === 0 && folder && !busy && (
            <div className="p-3 text-sm text-muted-foreground">
              {L('候補がありません。', 'No candidates.')}
            </div>
          )}
          <ul>
            {proposals.map((p) => (
              <li key={p.filePath}>
                <button
                  onClick={() => void select(p)}
                  className={cn(
                    'w-full text-left px-3 py-2 border-b border-border hover:bg-muted/50',
                    selected?.filePath === p.filePath && 'bg-muted'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{p.title}</span>
                    {p.adoptionLabel === 'recommend' && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/15 text-green-600">
                        {L('推奨', 'recommend')}
                      </span>
                    )}
                    {p.adoptionLabel === 'reject' && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        {L('棄却', 'reject')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    {stateBadge(p.state)}
                    {p.alreadyAdopted && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-600 inline-flex items-center gap-1">
                        <ShieldCheck size={11} />
                        {L('採用済みの skill 名', 'already adopted')}
                      </span>
                    )}
                    {p.parseError && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/15 text-red-600 inline-flex items-center gap-1">
                        <AlertTriangle size={11} />
                        {L('解析エラー', 'parse error')}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground truncate">{p.skillName}</span>
                  </div>
                  <div
                    className="text-xs text-muted-foreground truncate mt-0.5"
                    title={p.sourceProject || undefined}
                  >
                    {L('出自', 'from')}: {p.sourceProject || L('(出自不明)', '(unknown source)')}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Detail / review gate */}
        <div className="flex-1 overflow-auto border border-border rounded-md p-3">
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
                <div className="text-red-600">
                  {L('解析エラー: ', 'Parse error: ')}
                  {selected.parseError}
                </div>
              ) : (
                <>
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
                    <div className="font-medium mb-1 flex items-center gap-2">
                      <span>{L('レビューボックス（レビューゲート）', 'Review box (review gate)')}</span>
                      {selected.reviewBox.reviewerId && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-mono">
                          {L('レビュー済', 'reviewed')}: {selected.reviewBox.reviewerId}
                        </span>
                      )}
                    </div>
                    <div className="text-xs bg-muted/40 rounded p-2 space-y-0.5">
                      <div>verdict: {selected.reviewBox.verdict || '(pending)'}</div>
                      <div>findings: {selected.reviewBox.findings || '-'}</div>
                      <div>reviewer: {selected.reviewBox.reviewerId || '-'}</div>
                      <div>cc_rebuttal: {selected.reviewBox.ccRebuttal || '-'}</div>
                    </div>
                  </div>

                  {/* WS2: Codex レビューゲート（推奨バッジ × Codex 検出時のみ表示） */}
                  {codexGate?.required && (
                    <div
                      className={cn(
                        'text-xs rounded p-2 space-y-1.5',
                        codexGate.satisfied
                          ? 'bg-green-500/10 text-green-700'
                          : 'bg-amber-500/15 text-amber-700'
                      )}
                    >
                      <div className="flex items-center gap-1.5 font-medium">
                        {codexGate.satisfied ? (
                          <ShieldCheck size={12} />
                        ) : (
                          <AlertTriangle size={12} />
                        )}
                        {codexGate.satisfied
                          ? L(
                              `Codex レビュー済（${codexGate.reviewerId ?? 'codex'} / verdict: ${codexGate.verdict ?? '-'}）`,
                              `Codex review done (${codexGate.reviewerId ?? 'codex'} / verdict: ${codexGate.verdict ?? '-'})`
                            )
                          : L(
                              'Codex レビュー必須（maintainer裁定 2026-07-13）: 未実施のため採用できません。',
                              'Codex review required (maintainer ruling 2026-07-13): adoption is blocked until reviewed.'
                            )}
                      </div>
                      {!codexGate.satisfied && (
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void copyReviewPrompt()}
                            disabled={busy}
                          >
                            <Copy size={12} className="mr-1" />
                            {L('レビュー依頼プロンプトをコピー', 'Copy review request prompt')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void refreshGate()}
                            disabled={busy}
                          >
                            <RefreshCw size={12} className="mr-1" />
                            {L('再判定', 'Re-check')}
                          </Button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* 採用される SKILL.md プレビュー */}
                  {skillBody && (
                    <details>
                      <summary className="cursor-pointer text-muted-foreground">
                        {L('採用される SKILL.md を表示', 'Show SKILL.md to be adopted')}
                      </summary>
                      <pre className="text-xs bg-muted/40 rounded p-2 mt-1 overflow-auto max-h-60 whitespace-pre-wrap">
                        {skillBody}
                      </pre>
                    </details>
                  )}

                  {/* 採用アクション */}
                  <div className="flex items-center gap-2 pt-2 border-t border-border">
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
                      disabled={busy || !passwordOk || selected.state === 'adopted' || codexBlocked}
                    >
                      <Check size={14} className="mr-1" />
                      {L('採用 (Apply)', 'Adopt (Apply)')}
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

                  {selected.alreadyAdopted && (
                    <div className="text-xs text-purple-600">
                      {L(
                        'この skill 名は既に採用済みです（重複の可能性）。',
                        'This skill name is already adopted (possible duplicate).'
                      )}
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
    </div>
  )
}
