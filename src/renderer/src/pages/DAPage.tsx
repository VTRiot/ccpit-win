import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, ExternalLink, Copy, Check, Save, ShieldAlert, Trash2 } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Label } from '../components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card'
import { Toast } from '../components/ui/toast'
import { toNativePath } from '../lib/utils'

const STORAGE_KEY_DA_OUTPUT = 'ccpit-da-output'
const STORAGE_KEY_DA_PATH = 'ccpit-da-custom-path'

type ObsoleteOverride = Awaited<ReturnType<typeof window.api.emergencyOverrideListObsolete>>[number]

export function DAPage(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const ja = i18n.language.startsWith('ja')
  const L = (j: string, e: string): string => (ja ? j : e)
  const [symptom, setSymptom] = useState('')
  const [packContent, setPackContent] = useState('')
  const [generating, setGenerating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [savedPath, setSavedPath] = useState('')
  const [defaultOutputDir, setDefaultOutputDir] = useState('')
  const [outputMode, setOutputMode] = useState<'desktop' | 'custom'>(
    () => (localStorage.getItem(STORAGE_KEY_DA_OUTPUT) as 'desktop' | 'custom') || 'desktop'
  )
  const [customPath, setCustomPath] = useState(
    () => localStorage.getItem(STORAGE_KEY_DA_PATH) || ''
  )
  // 緊急避難 override（判断H, golden バグ時の同名一時許可。Doctor 経由でのみ）
  const [ovName, setOvName] = useState('')
  const [ovReason, setOvReason] = useState('')
  const [ovDr, setOvDr] = useState('')
  const [obsolete, setObsolete] = useState<ObsoleteOverride[]>([])
  const [ovMsg, setOvMsg] = useState('')

  const loadObsolete = (): void => {
    window.api.emergencyOverrideListObsolete().then(setObsolete)
  }

  useEffect(() => {
    window.api.daDefaultOutputDir().then(setDefaultOutputDir)
    loadObsolete()
  }, [])

  const createOverride = async (): Promise<void> => {
    if (!ovName.trim() || !ovReason.trim() || !ovDr.trim()) {
      setOvMsg(L('skill 名 / 理由 / Dr 決定 ID は必須です。', 'name / reason / Dr decision id are required.'))
      return
    }
    await window.api.emergencyOverrideCreate({ name: ovName.trim(), reason: ovReason.trim(), drDecisionId: ovDr.trim() })
    setOvMsg(
      L(
        `緊急避難 override を作成しました（${ovName.trim()}）。golden 版が進むと自動失効します。`,
        `Emergency override created (${ovName.trim()}). It auto-expires when the golden version advances.`
      )
    )
    setOvName('')
    setOvReason('')
    setOvDr('')
    loadObsolete()
  }

  const removeOverride = async (name: string): Promise<void> => {
    await window.api.emergencyOverrideRemove(name)
    setOvMsg(L(`override を削除しました（${name}）。`, `Removed override (${name}).`))
    loadObsolete()
  }

  const handleOutputModeChange = (mode: 'desktop' | 'custom'): void => {
    setOutputMode(mode)
    localStorage.setItem(STORAGE_KEY_DA_OUTPUT, mode)
  }

  const handleSelectCustomPath = async (): Promise<void> => {
    const selected = await window.api.selectFolder()
    if (selected) {
      setCustomPath(selected)
      localStorage.setItem(STORAGE_KEY_DA_PATH, selected)
    }
  }

  const getOutputDir = (): string => {
    const mode = localStorage.getItem(STORAGE_KEY_DA_OUTPUT) || 'desktop'
    if (mode === 'custom') {
      return localStorage.getItem(STORAGE_KEY_DA_PATH) || defaultOutputDir
    }
    return defaultOutputDir
  }

  const handleGenerate = async (): Promise<void> => {
    if (!symptom.trim()) return
    setGenerating(true)
    setPackContent('')
    setSavedPath('')
    const pack = await window.api.daGenerate(symptom)
    setPackContent(pack)

    // 自動保存
    const outputDir = getOutputDir()
    const path = await window.api.daSave(pack, outputDir)
    setSavedPath(path)

    setGenerating(false)
  }

  const handleCopy = async (): Promise<void> => {
    await window.api.clipboardWrite(packContent)
    setCopied(true)
  }

  const handleOpenClaudeAi = async (): Promise<void> => {
    await window.api.clipboardWrite(packContent)
    await window.api.openExternal('https://claude.ai/new')
  }

  return (
    <div className="max-w-3xl space-y-6">
      <Toast open={copied} message={t('common.copied')} onClose={() => setCopied(false)} />
      <h1 className="text-xl font-bold">{t('pages.da.title')}</h1>

      {/* Output path settings */}
      <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
        <p className="text-xs font-medium text-muted-foreground">{t('settings.doctorPackOutput')}</p>
        <div className="flex gap-2">
          <button
            onClick={() => handleOutputModeChange('desktop')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
              outputMode === 'desktop'
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:bg-accent'
            }`}
          >
            {t('settings.desktop')}
          </button>
          <button
            onClick={() => handleOutputModeChange('custom')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
              outputMode === 'custom'
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:bg-accent'
            }`}
          >
            {t('settings.customPath')}
          </button>
        </div>
        {outputMode === 'custom' && (
          <div className="flex gap-2 items-center">
            <code className="text-xs font-mono text-foreground flex-1 truncate">
              {toNativePath(customPath || defaultOutputDir)}
            </code>
            <Button variant="outline" size="sm" onClick={handleSelectCustomPath}>
              {t('pages.projects.selectPath')}
            </Button>
          </div>
        )}
        {outputMode === 'desktop' && (
          <code className="text-xs font-mono text-muted-foreground">{toNativePath(defaultOutputDir)}</code>
        )}
      </div>

      {/* Symptom Input */}
      <Card>
        <CardHeader>
          <CardTitle>{t('pages.da.symptomNote')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <textarea
            value={symptom}
            onChange={(e) => setSymptom(e.target.value)}
            placeholder={t('pages.da.symptomPlaceholder')}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 h-32 resize-none"
          />
          <Button onClick={handleGenerate} disabled={generating || !symptom.trim()}>
            {generating ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {generating ? t('pages.da.generating') : t('pages.da.generatePack')}
          </Button>
        </CardContent>
      </Card>

      {/* Generated Pack */}
      {packContent && (
        <Card>
          <CardHeader>
            <CardTitle>{t('pages.da.packGenerated')}</CardTitle>
            {savedPath && (
              <CardDescription>{t('pages.da.saved', { path: toNativePath(savedPath) })}</CardDescription>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Button onClick={handleOpenClaudeAi}>
                <ExternalLink size={16} /> {t('pages.da.openClaudeAi')}
              </Button>
              <Button variant="outline" onClick={handleCopy}>
                {copied ? <Check size={16} /> : <Copy size={16} />}
                {copied ? t('pages.da.copied') : t('pages.da.copyPack')}
              </Button>
            </div>

            {/* Continue hint */}
            <p className="text-sm text-[#22c55e]">
              {'\u26A0'} {t('pages.da.continueHint')}
            </p>

            {/* Browser guide */}
            <div className="rounded-md border border-border bg-muted/30 p-3 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">{t('pages.da.browserGuide')}</p>
              <p className="text-xs text-muted-foreground">{t('pages.da.browserStep1')}</p>
              <p className="text-xs text-muted-foreground">{t('pages.da.browserStep2')}</p>
              <p className="text-xs text-muted-foreground">{t('pages.da.browserStep3')}</p>
            </div>

            <div>
              <Label className="mb-2 block">{t('pages.da.packPreview')}</Label>
              <div className="border border-border rounded-md p-3 max-h-64 overflow-auto bg-muted/30">
                <pre className="text-xs font-mono whitespace-pre-wrap text-muted-foreground">{packContent}</pre>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 緊急避難 override (判断H): golden skill バグ時の同名一時許可。Doctor 経由でのみ。 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert size={16} />
            {L('緊急避難 override（golden バグ時）', 'Emergency override (golden bug)')}
          </CardTitle>
          <CardDescription>
            {L(
              'golden skill にバグがあり同名の修正版を一時採用する必要がある時のみ使う。スコープ＋失効付き。golden 版が進むと自動失効。',
              'Use only when a golden skill is buggy and a same-name fix must be adopted temporarily. Scoped + expiring; auto-expires when the golden version advances.'
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-2">
            <input
              value={ovName}
              onChange={(e) => setOvName(e.target.value)}
              placeholder={L('対象 golden skill 名', 'target golden skill name')}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <input
              value={ovReason}
              onChange={(e) => setOvReason(e.target.value)}
              placeholder={L('理由（どのバグか）', 'reason (which bug)')}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <input
              value={ovDr}
              onChange={(e) => setOvDr(e.target.value)}
              placeholder={L('Dr 決定 ID（診断の識別子）', 'Dr decision id')}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <Button variant="outline" size="sm" onClick={createOverride}>
            <ShieldAlert size={14} /> {L('緊急避難 override を作成', 'Create emergency override')}
          </Button>

          {obsolete.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-500/10 p-3 space-y-2">
              <p className="text-xs font-medium text-amber-700">
                {L(
                  '不要になった override（golden 修正済 or 失効）— 削除推奨:',
                  'Obsolete overrides (golden fixed or expired) — recommended to delete:'
                )}
              </p>
              {obsolete.map((o) => (
                <div key={o.name} className="flex items-center gap-2 text-xs">
                  <code className="font-mono flex-1 truncate" title={o.reason}>
                    {o.name} (golden {o.goldenVersion})
                  </code>
                  <Button variant="outline" size="sm" onClick={() => removeOverride(o.name)}>
                    <Trash2 size={12} /> {L('削除', 'Delete')}
                  </Button>
                </div>
              ))}
            </div>
          )}

          {ovMsg && <p className="text-xs text-muted-foreground">{ovMsg}</p>}
        </CardContent>
      </Card>
    </div>
  )
}
