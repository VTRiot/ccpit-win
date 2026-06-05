import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Inbox,
  FolderOpen,
  Loader2,
  Check,
  AlertTriangle,
  Lock,
  History,
  RotateCcw,
  ChevronDown,
  ChevronRight
} from 'lucide-react'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { cn } from '../lib/utils'
import ReactDiffViewer from 'react-diff-viewer-continued'

type RequestStatus = 'pending' | 'applied' | 'rolled_back' | 'rejected'
type RequestKind = 'settings' | 'skill'

interface ChangeRequestFrontmatter {
  request_id: string
  created_at: string
  purpose: string
  target: string
  status: RequestStatus
  kind: RequestKind
}

interface ChangeRequestBase {
  filePath: string
  frontmatter: ChangeRequestFrontmatter
  rawMarkdown: string
  parseError: string | null
}

interface SettingsChangeRequest extends ChangeRequestBase {
  kind: 'settings'
  proposedSettingsJson: string
  proposedSettingsParsed: unknown | null
}

interface SkillChangeRequest extends ChangeRequestBase {
  kind: 'skill'
  proposedSkillBody: string
}

type ChangeRequest = SettingsChangeRequest | SkillChangeRequest

/** PIKES r1.4 §7-3-A: 3 種エラー区別 + その他失敗事由 */
type ApplyResultReason =
  | 'authentication-failed'
  | 'auth-missing-for-skill'
  | 'json-syntax-error'
  | 'allowlist-violation'
  | 'kind-target-mismatch'
  | 'glob-not-allowed'
  | 'unc-not-allowed'
  | 'parent-not-found'
  | 'realpath-failed'
  | 'write-failed'
  | 'post-verify-failed'
  | 'golden-name-collision'

interface ApplyResult {
  success: boolean
  backupPath?: string
  appliedAt?: string
  error?: string
  reason?: ApplyResultReason
  rolledBack?: boolean
}

interface ChangeLogEntry {
  timestamp: string
  request_id: string
  purpose: string
  result: 'applied' | 'rolled_back' | 'failed'
  backup_path: string
  error?: string
}

interface SettingsBackup {
  id: string
  path: string
  sizeBytes: number
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    const y = d.getFullYear()
    const mo = String(d.getMonth() + 1).padStart(2, '0')
    const da = String(d.getDate()).padStart(2, '0')
    const h = String(d.getHours()).padStart(2, '0')
    const mi = String(d.getMinutes()).padStart(2, '0')
    return `${y}/${mo}/${da} ${h}:${mi}`
  } catch {
    return iso
  }
}

/** Backup id is "YYYY-MM-DDTHH-mm-ss-sssZ"; convert it to readable format. */
function formatBackupId(id: string): string {
  const m = id.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/)
  if (!m) return id
  return `${m[1]} ${m[2]}:${m[3]}:${m[4]}`
}

export function CCRequestInboxPage(): React.JSX.Element {
  const { t } = useTranslation()

  const [request, setRequest] = useState<ChangeRequest | null>(null)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [currentSettings, setCurrentSettings] = useState<string>('')
  const [hasPassword, setHasPassword] = useState<boolean>(false)
  const [password, setPassword] = useState<string>('')
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<ApplyResult | null>(null)

  const [showLogs, setShowLogs] = useState(false)
  const [logs, setLogs] = useState<ChangeLogEntry[]>([])

  const [showRollback, setShowRollback] = useState(false)
  const [backups, setBackups] = useState<SettingsBackup[]>([])
  const [rollbackResult, setRollbackResult] = useState<{ success: boolean; error?: string } | null>(
    null
  )

  // Load current settings + auth.password status on mount
  useEffect(() => {
    void (async () => {
      try {
        const [s, hp] = await Promise.all([
          window.api.settingsRead(),
          window.api.settingsHasPassword()
        ])
        setCurrentSettings(s)
        setHasPassword(hp)
      } catch {
        // silent fail; the user can still operate
      }
    })()
  }, [])

  const loadRequest = async (): Promise<void> => {
    const filePath = await window.api.selectFile()
    if (!filePath) return
    setRequest(null)
    setRequestError(null)
    setResult(null)
    try {
      const r = await window.api.settingsReadRequest(filePath)
      setRequest(r as ChangeRequest)
      // Refresh current settings (in case it changed)
      const s = await window.api.settingsRead()
      setCurrentSettings(s)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setRequestError(msg)
    }
  }

  const handleApply = async (): Promise<void> => {
    if (!request) return
    setApplying(true)
    setResult(null)
    try {
      const r = await window.api.settingsApplyChange(request, password)
      setResult(r)
      // Refresh current settings to reflect the new state
      const s = await window.api.settingsRead()
      setCurrentSettings(s)
      // If logs panel is open, refresh
      if (showLogs) {
        const l = await window.api.settingsListLogs()
        setLogs(l as ChangeLogEntry[])
      }
    } finally {
      setApplying(false)
    }
  }

  const toggleLogs = async (): Promise<void> => {
    const next = !showLogs
    setShowLogs(next)
    if (next) {
      const l = await window.api.settingsListLogs()
      setLogs(l as ChangeLogEntry[])
    }
  }

  const toggleRollback = async (): Promise<void> => {
    const next = !showRollback
    setShowRollback(next)
    if (next) {
      const b = await window.api.settingsListBackups()
      setBackups(b)
    }
  }

  const handleRollback = async (id: string): Promise<void> => {
    if (!confirm(t('requestInbox.rollback.confirm'))) return
    setRollbackResult(null)
    const r = await window.api.settingsRollback(id)
    setRollbackResult(r)
    const s = await window.api.settingsRead()
    setCurrentSettings(s)
  }

  // Apply guard: request loaded, content valid (kind 別), password (if required) provided, not in flight.
  const passwordOk = !hasPassword || password.length > 0
  // kind:settings の JSON syntax error のみ apply 禁止。kind:skill は raw text のため常に valid。
  const proposedJsonInvalid =
    request !== null && request.kind === 'settings' && request.parseError !== null
  const canApply = request !== null && !proposedJsonInvalid && passwordOk && !applying

  return (
    <div className="max-w-4xl space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Inbox size={20} /> {t('requestInbox.title')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t('requestInbox.description')}</p>
        </div>
        <Button onClick={loadRequest} size="sm" variant="outline">
          <FolderOpen size={16} />
          {t('requestInbox.openRequest')}
        </Button>
      </div>

      {requestError && (
        <Card className="border-destructive/40">
          <CardContent className="pt-4 flex items-start gap-2 text-sm text-destructive">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">{t('requestInbox.parseError')}</div>
              <div className="font-mono text-xs mt-1 break-all">{requestError}</div>
            </div>
          </CardContent>
        </Card>
      )}

      {!request && !requestError && (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground space-y-2">
            <p>{t('requestInbox.empty.line1')}</p>
            <p>{t('requestInbox.empty.line2')}</p>
            <code className="block text-xs font-mono bg-muted/40 p-2 rounded">
              ${'{cwd}'}/_Prompt/_SettingsChangeRequests/&lt;timestamp&gt;_&lt;id&gt;.md
            </code>
          </CardContent>
        </Card>
      )}

      {request && (
        <>
          {/* Frontmatter */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('requestInbox.detail.title')}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-1.5">
              <KV label={t('requestInbox.detail.purpose')} value={request.frontmatter.purpose} />
              <KV
                label={t('requestInbox.detail.requestId')}
                value={request.frontmatter.request_id}
              />
              <KV
                label={t('requestInbox.detail.createdAt')}
                value={formatTimestamp(request.frontmatter.created_at)}
              />
              <KV label={t('requestInbox.detail.target')} value={request.frontmatter.target} />
              <KV label="kind" value={request.frontmatter.kind} />
              <KV label={t('requestInbox.detail.status')} value={request.frontmatter.status} />
              <KV label={t('requestInbox.detail.filePath')} value={request.filePath} mono />
            </CardContent>
          </Card>

          {/* Parse error (kind:settings の JSON syntax error のみ) */}
          {proposedJsonInvalid && request.kind === 'settings' && (
            <Card className="border-destructive/40">
              <CardContent className="pt-4 flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <div>
                  <div className="font-medium">{t('requestInbox.jsonError')}</div>
                  <div className="font-mono text-xs mt-1 break-all">{request.parseError}</div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Diff — kind で表示内容切替 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('requestInbox.diff.title')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="border border-border rounded-md overflow-auto max-h-[28rem] text-xs">
                {request.kind === 'settings' ? (
                  <ReactDiffViewer
                    oldValue={currentSettings}
                    newValue={
                      request.proposedSettingsParsed !== null
                        ? JSON.stringify(request.proposedSettingsParsed, null, 2)
                        : request.proposedSettingsJson
                    }
                    splitView={false}
                    useDarkTheme
                  />
                ) : (
                  // kind:skill — 対象 SKILL.md の現在内容と提案 raw body を text diff として表示。
                  // 現在内容の取得は将来拡張枠（Phase 2 で target 別 read API 追加予定）のため、
                  // v1 では新規内容のみ提示 (oldValue 空文字)。Phase 2 でフルテキスト diff 化。
                  <ReactDiffViewer
                    oldValue=""
                    newValue={request.proposedSkillBody}
                    splitView={false}
                    useDarkTheme
                  />
                )}
              </div>
            </CardContent>
          </Card>

          {/* Auth */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Lock size={16} /> {t('requestInbox.auth.title')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {hasPassword ? (
                <>
                  <p className="text-sm text-muted-foreground">{t('requestInbox.auth.required')}</p>
                  <div className="space-y-1">
                    <Label htmlFor="inbox-password">{t('common.password')}</Label>
                    <Input
                      id="inbox-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={t('requestInbox.auth.placeholder')}
                    />
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">{t('requestInbox.auth.notSet')}</p>
              )}
            </CardContent>
          </Card>

          {/* Apply */}
          <Card>
            <CardContent className="pt-5 space-y-3">
              <Button
                onClick={handleApply}
                disabled={!canApply}
                className="w-full h-12 text-base font-semibold"
                size="lg"
              >
                {applying ? (
                  <>
                    <Loader2 size={18} className="animate-spin" /> {t('requestInbox.applying')}
                  </>
                ) : (
                  <>
                    <Check size={18} /> {t('requestInbox.apply')}
                  </>
                )}
              </Button>

              {result && (
                <div
                  className={cn(
                    'p-3 rounded-md border text-sm',
                    result.success
                      ? 'border-green-500/30 bg-green-500/5 text-green-500'
                      : result.rolledBack
                        ? 'border-yellow-500/30 bg-yellow-500/5 text-yellow-500'
                        : 'border-destructive/40 bg-destructive/5 text-destructive'
                  )}
                >
                  <div className="font-medium flex items-center gap-1.5">
                    {result.success ? (
                      <>
                        <Check size={14} /> {t('requestInbox.result.success')}
                      </>
                    ) : result.rolledBack ? (
                      <>
                        <RotateCcw size={14} /> {t('requestInbox.result.rolledBack')}
                      </>
                    ) : (
                      <>
                        <AlertTriangle size={14} /> {t('requestInbox.result.failed')}
                      </>
                    )}
                  </div>
                  {result.appliedAt && (
                    <div className="text-xs mt-1">
                      {t('requestInbox.result.appliedAt')}: {formatTimestamp(result.appliedAt)}
                    </div>
                  )}
                  {result.backupPath && (
                    <div className="text-xs mt-1 font-mono break-all">
                      {t('requestInbox.result.backup')}: {result.backupPath}
                    </div>
                  )}
                  {result.reason && (
                    <div className="text-xs mt-1">
                      reason: <span className="font-mono">{result.reason}</span>
                      {/* PIKES r1.4 §7-3-A: 3 種エラー区別ヒント */}
                      {result.reason === 'allowlist-violation' && (
                        <span className="ml-2 text-muted-foreground">
                          (target は allowlist 外。kind と target を確認してください)
                        </span>
                      )}
                      {result.reason === 'kind-target-mismatch' && (
                        <span className="ml-2 text-muted-foreground">
                          (kind と target が不整合。kind:settings なら settings.json 系、kind:skill
                          なら ~/.claude/skills/&lt;name&gt;/SKILL.md を指定)
                        </span>
                      )}
                      {result.reason === 'auth-missing-for-skill' && (
                        <span className="ml-2 text-muted-foreground">
                          (auth.password 未設定環境では skill apply は許可されません。先に
                          settings 経路でパスワードを登録してください)
                        </span>
                      )}
                    </div>
                  )}
                  {result.error && (
                    <div className="text-xs mt-1 break-all">
                      {t('common.error')}: {result.error}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* Logs */}
      <Card>
        <CardHeader
          className="cursor-pointer hover:bg-muted/30 transition-colors"
          onClick={toggleLogs}
        >
          <CardTitle className="text-base flex items-center gap-2">
            {showLogs ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <History size={16} /> {t('requestInbox.logs.title')}
          </CardTitle>
        </CardHeader>
        {showLogs && (
          <CardContent>
            {logs.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('requestInbox.logs.empty')}</p>
            ) : (
              <div className="space-y-2">
                {logs.map((log, idx) => (
                  <div
                    key={idx}
                    className="text-xs p-2 rounded border border-border/50 bg-muted/20 space-y-0.5"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono">{formatTimestamp(log.timestamp)}</span>
                      <span
                        className={cn(
                          'px-1.5 py-0.5 rounded border',
                          log.result === 'applied' &&
                            'bg-green-500/10 text-green-500 border-green-500/20',
                          log.result === 'rolled_back' &&
                            'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
                          log.result === 'failed' && 'bg-red-500/10 text-red-500 border-red-500/20'
                        )}
                      >
                        {log.result}
                      </span>
                      <span className="font-medium">{log.purpose}</span>
                    </div>
                    <div className="text-muted-foreground">request_id: {log.request_id}</div>
                    {log.error && <div className="text-destructive break-all">{log.error}</div>}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* Rollback */}
      <Card>
        <CardHeader
          className="cursor-pointer hover:bg-muted/30 transition-colors"
          onClick={toggleRollback}
        >
          <CardTitle className="text-base flex items-center gap-2">
            {showRollback ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <RotateCcw size={16} /> {t('requestInbox.rollback.title')}
          </CardTitle>
        </CardHeader>
        {showRollback && (
          <CardContent className="space-y-3">
            {rollbackResult && (
              <div
                className={cn(
                  'p-2 rounded text-xs border',
                  rollbackResult.success
                    ? 'border-green-500/30 bg-green-500/5 text-green-500'
                    : 'border-destructive/40 bg-destructive/5 text-destructive'
                )}
              >
                {rollbackResult.success
                  ? t('requestInbox.rollback.success')
                  : `${t('requestInbox.rollback.failed')}: ${rollbackResult.error ?? ''}`}
              </div>
            )}
            {backups.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('requestInbox.rollback.empty')}</p>
            ) : (
              <div className="space-y-1.5">
                {backups.map((b) => (
                  <div
                    key={b.id}
                    className="flex items-center gap-3 text-xs p-2 rounded border border-border/50 bg-muted/20"
                  >
                    <span className="font-mono flex-1">{formatBackupId(b.id)}</span>
                    <span className="text-muted-foreground">{b.sizeBytes} B</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleRollback(b.id)}
                      title={t('requestInbox.rollback.button')}
                    >
                      <RotateCcw size={14} />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  )
}

interface KVProps {
  label: string
  value: string
  mono?: boolean
}

function KV({ label, value, mono }: KVProps): React.JSX.Element {
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground min-w-[5.5rem]">{label}:</span>
      <span className={cn(mono && 'font-mono text-xs break-all')}>{value}</span>
    </div>
  )
}
