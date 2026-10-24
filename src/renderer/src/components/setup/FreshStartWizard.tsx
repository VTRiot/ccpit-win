import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Eye, EyeOff, Check, X, Loader2, AlertTriangle } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Checkbox } from '../ui/checkbox'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card'
import { cn } from '../../lib/utils'
import { platformToTemplate } from '../../lib/platformTemplate'

interface FreshStartWizardProps {
  onBack: () => void
  onSetupCompleted: () => void
}

type Step = 'password' | 'preview' | 'confirm' | 'deploying' | 'result'

const STEP_IDS: Step[] = ['password', 'preview', 'result']

interface DeployResult {
  deployed: string[]
  backedUp: string[]
  errors: string[]
}

type LayersResult = Awaited<ReturnType<typeof window.api.goldenPreviewSettingsLayers>>
type LayersPreview = NonNullable<LayersResult['preview']>

/** 下見の段に出す settings.json の層の要約（値は出さない。件数と名前だけ） */
function summarizeLayers(p: LayersPreview): {
  added: number
  updated: number
  removed: number
  unchanged: number
  kept: number
  duplicate: number
  unidentifiable: number
  overlap: number
  goldenKeys: number
  localKeys: number
} {
  const golden = p.hooks.filter((h) => h.layer === 'golden')
  const local = p.hooks.filter((h) => h.layer === 'local')
  return {
    added: golden.filter((h) => h.change === 'added' || h.change === 'readded').length,
    updated: golden.filter((h) => h.change === 'updated' || h.change === 'replaced-local-change' || h.change === 'moved-to-golden').length,
    removed: golden.filter((h) => h.change === 'removed').length,
    unchanged: golden.filter((h) => h.change === 'unchanged').length,
    kept: local.length,
    duplicate: local.filter((h) => h.marks.includes('duplicate')).length,
    unidentifiable: local.filter((h) => h.marks.includes('unidentifiable')).length,
    overlap: local.filter((h) => h.marks.includes('may-overlap-golden')).length,
    goldenKeys: p.keys.filter((k) => k.layer === 'golden' && k.change !== 'removed').length,
    localKeys: p.keys.filter((k) => k.layer === 'local').length
  }
}

/** OS に応じたテンプレートを自動選択（Marshal F6: darwin→macau を含む正しいマッピング、純関数に委譲） */
function detectTemplate(): string {
  const platform = window.electron?.process?.platform ?? 'win32'
  return platformToTemplate(platform)
}

export function FreshStartWizard({ onBack, onSetupCompleted }: FreshStartWizardProps): React.JSX.Element {
  const { t } = useTranslation()
  const [step, setStep] = useState<Step>('password')
  const selectedTemplate = detectTemplate()
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [preview, setPreview] = useState<{ relativePath: string; source: string }[]>([])
  const [result, setResult] = useState<DeployResult | null>(null)
  /** D8: 既存設定の有無。populated 環境では実行前に確認ゲートを挟む */
  const [existing, setExisting] = useState<{ hasSettings: boolean; hasClaude: boolean } | null>(
    null
  )
  const [acknowledged, setAcknowledged] = useState(false)
  /** L0_013: settings.json の層の下見と、手元の層を外す・書き換える項目への承認（確認の箱とは別の 1 動作） */
  const [layers, setLayers] = useState<LayersResult | null>(null)
  const [layersApproved, setLayersApproved] = useState(false)

  const passwordValid = password.length >= 4 && password === passwordConfirm
  const isPopulated = existing !== null && (existing.hasSettings || existing.hasClaude)
  const approvalItems = layers?.preview?.approvalItems ?? []
  const needsLayersApproval = approvalItems.length > 0

  const handlePreview = async (): Promise<void> => {
    const [items, found, layerResult] = await Promise.all([
      window.api.goldenPreview(selectedTemplate),
      window.api.goldenCheckExisting(),
      window.api.goldenPreviewSettingsLayers(selectedTemplate)
    ])
    setPreview(items)
    setExisting({ hasSettings: found.hasSettings, hasClaude: found.hasClaude })
    setLayers(layerResult)
    setLayersApproved(false)
    setStep('preview')
  }

  const handleDeploy = async (): Promise<void> => {
    setStep('deploying')
    // 承認の印は (ii) があり、承認のチェックが入っているときだけ渡す。main が下見に結び付いた印かを確かめる
    const approval = needsLayersApproval && layersApproved ? layers?.approvalToken : undefined
    const res = await window.api.goldenDeploy(selectedTemplate, password, approval)
    setResult(res)
    if (res.errors.length === 0) {
      await window.api.configSet({ setupCompleted: true })
    }
    setStep('result')
  }

  /** D8: 空の環境はそのまま実行、既存ありは確認ゲートを経由させる */
  const handleRunSetup = (): void => {
    // 手元の層を外す・書き換える項目があれば、既存設定の有無に関わらず確認の段を通す
    if (isPopulated || needsLayersApproval) {
      setAcknowledged(false)
      setLayersApproved(false)
      setStep('confirm')
      return
    }
    void handleDeploy()
  }

  // confirm は preview の延長、deploying は result の前段としてインジケータに反映する
  const indicatorStep: Step =
    step === 'deploying' ? 'result' : step === 'confirm' ? 'preview' : step
  const currentStepIndex = STEP_IDS.indexOf(indicatorStep)
  const stepLabels = STEP_IDS.map((id) => t(`fresh.steps.${id}`))

  return (
    <div className="max-w-xl mx-auto mt-8">
      <Button variant="ghost" size="sm" onClick={onBack} className="mb-6 -ml-2 text-muted-foreground">
        <ArrowLeft size={16} /> {t('common.back')}
      </Button>

      <h2 className="text-xl font-bold mb-6">{t('fresh.title')}</h2>

      {/* Step Indicator */}
      <div className="flex items-center gap-2 mb-8">
        {stepLabels.map((label, i) => (
          <div key={i} className="flex items-center gap-2">
            <div
              className={cn(
                'w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium transition-colors',
                i < currentStepIndex
                  ? 'bg-primary text-primary-foreground'
                  : i === currentStepIndex
                    ? 'bg-primary text-primary-foreground ring-2 ring-primary/30'
                    : 'bg-muted text-muted-foreground'
              )}
            >
              {i < currentStepIndex ? <Check size={14} /> : i + 1}
            </div>
            <span className={cn('text-xs hidden sm:inline', i === currentStepIndex ? 'text-foreground font-medium' : 'text-muted-foreground')}>
              {label}
            </span>
            {i < stepLabels.length - 1 && <div className="w-8 h-px bg-border" />}
          </div>
        ))}
      </div>

      {step === 'password' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('fresh.passwordTitle')}</CardTitle>
            <CardDescription>{t('fresh.passwordDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>{t('common.password')}</Label>
              <div className="relative">
                <Input type={showPassword ? 'text' : 'password'} placeholder={t('common.passwordPlaceholder')} value={password} onChange={(e) => setPassword(e.target.value)} />
                <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t('common.passwordConfirm')}</Label>
              <Input type={showPassword ? 'text' : 'password'} placeholder={t('common.passwordConfirmPlaceholder')} value={passwordConfirm} onChange={(e) => setPasswordConfirm(e.target.value)} />
            </div>
            {passwordConfirm && !passwordValid && (
              <p className="text-sm text-destructive">{password !== passwordConfirm ? t('common.passwordMismatch') : t('common.passwordTooShort')}</p>
            )}
            <div className="flex gap-3 pt-2">
              <Button variant="outline" onClick={onBack}>{t('common.back')}</Button>
              <Button onClick={handlePreview} disabled={!passwordValid}>{t('common.next')}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'preview' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('fresh.previewTitle')}</CardTitle>
            <CardDescription>{t('fresh.previewDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="border border-border rounded-md mb-6 max-h-64 overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="text-left p-2.5 text-muted-foreground font-medium">{t('common.file')}</th>
                    <th className="text-left p-2.5 text-muted-foreground font-medium">{t('common.source')}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((item) => (
                    <tr key={item.relativePath} className="border-b border-border/50">
                      <td className="p-2.5 font-mono text-xs">{item.relativePath}</td>
                      <td className="p-2.5 text-muted-foreground text-xs">{item.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {layers && <LayersSummary layers={layers} />}
            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setStep('password')}>{t('common.back')}</Button>
              <Button onClick={handleRunSetup}>{t('common.runSetup')}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'confirm' && (
        <Card className="border-destructive/50">
          <CardHeader>
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle size={20} />
              <CardTitle>{t('fresh.confirmTitle')}</CardTitle>
            </div>
            <CardDescription>{t('fresh.confirmDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-destructive/10 rounded-md p-3">
              <ul className="list-disc list-inside text-sm space-y-0.5 text-destructive">
                {existing?.hasSettings && <li>{t('fresh.confirmFoundSettings')}</li>}
                {existing?.hasClaude && <li>{t('fresh.confirmFoundClaude')}</li>}
              </ul>
            </div>
            <p className="text-xs text-muted-foreground">{t('fresh.confirmBackupNote')}</p>
            <label className="flex items-start gap-2.5 cursor-pointer">
              <Checkbox
                checked={acknowledged}
                onCheckedChange={(c) => setAcknowledged(c === true)}
                className="mt-0.5"
              />
              <span className="text-sm">{t('fresh.confirmAcknowledge')}</span>
            </label>
            {needsLayersApproval && (
              <div className="space-y-2 border border-destructive/40 rounded-md p-3">
                <p className="text-sm font-medium text-destructive">
                  {t('fresh.layers.approvalTitle', { count: approvalItems.length })}
                </p>
                <p className="text-xs text-muted-foreground">{t('fresh.layers.approvalDescription')}</p>
                <ul className="list-disc list-inside text-xs space-y-0.5">
                  {approvalItems.map((a, i) => (
                    <li key={`${a.case}-${a.target}-${i}`}>
                      <span className="font-mono">{a.target}</span>: {t(`fresh.layers.case.${a.case}`)}
                    </li>
                  ))}
                </ul>
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <Checkbox
                    checked={layersApproved}
                    onCheckedChange={(c) => setLayersApproved(c === true)}
                    className="mt-0.5"
                  />
                  <span className="text-sm">
                    {t('fresh.layers.approvalAcknowledge', { count: approvalItems.length })}
                  </span>
                </label>
              </div>
            )}
            <div className="flex gap-3 pt-2">
              <Button variant="outline" onClick={() => setStep('preview')}>
                {t('common.back')}
              </Button>
              <Button
                variant="destructive"
                onClick={handleDeploy}
                disabled={!acknowledged || (needsLayersApproval && !layersApproved)}
              >
                {t('fresh.confirmProceed')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'deploying' && (
        <Card>
          <CardContent className="flex items-center justify-center gap-3 py-12 text-muted-foreground">
            <Loader2 size={20} className="animate-spin" /> {t('common.deploying')}
          </CardContent>
        </Card>
      )}

      {step === 'result' && result && (
        <Card>
          <CardHeader>
            {result.errors.length === 0 ? (
              <div className="flex items-center gap-2 text-green-500">
                <Check size={20} />
                <CardTitle>{t('fresh.setupComplete')}</CardTitle>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-destructive">
                <X size={20} />
                <CardTitle>{t('fresh.hasErrors')}</CardTitle>
              </div>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground mb-2">{t('common.deployedFiles', { count: result.deployed.length })}</p>
              <div className="bg-muted/50 rounded-md p-3">
                <ul className="list-disc list-inside text-xs font-mono space-y-0.5">
                  {result.deployed.map((f) => <li key={f}>{f}</li>)}
                </ul>
              </div>
            </div>
            {result.backedUp.length > 0 && (
              <div>
                <p className="text-sm text-muted-foreground mb-2">{t('common.backups', { count: result.backedUp.length })}</p>
                <div className="bg-muted/50 rounded-md p-3">
                  <ul className="list-disc list-inside text-xs font-mono space-y-0.5">
                    {result.backedUp.map((f) => <li key={f}>{f}</li>)}
                  </ul>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  {t('goldenReconcile.undo.wizardFollowUpHint')}
                </p>
              </div>
            )}
            {result.errors.length > 0 && (
              <div>
                <p className="text-sm text-destructive mb-2">{t('common.errors', { count: result.errors.length })}</p>
                <div className="bg-destructive/10 rounded-md p-3">
                  <ul className="list-disc list-inside text-xs font-mono space-y-0.5 text-destructive">
                    {result.errors.map((e) => <li key={e}>{e}</li>)}
                  </ul>
                </div>
                <Button variant="outline" size="sm" className="mt-3" onClick={() => void handlePreview()}>
                  {t('fresh.layers.retryPreview')}
                </Button>
              </div>
            )}
            {result.errors.length === 0 && (
              <div className="pt-2">
                <Button onClick={onSetupCompleted} className="w-full">
                  {t('common.doneGoToProjects')}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

/** 下見の段の「settings.json の層」の要約 */
function LayersSummary({ layers }: { layers: LayersResult }): React.JSX.Element {
  const { t } = useTranslation()
  if (!layers.preview) {
    if (layers.errors.length === 0) return <></>
    return (
      <div className="bg-destructive/10 rounded-md p-3 mb-6 text-xs text-destructive">
        <p className="font-medium mb-1">{t('fresh.layers.errorsTitle')}</p>
        <ul className="list-disc list-inside space-y-0.5">
          {layers.errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      </div>
    )
  }
  const p = layers.preview
  const s = summarizeLayers(p)
  return (
    <div className="border border-border rounded-md p-3 mb-6 text-xs space-y-1">
      <p className="text-sm font-medium">{t('fresh.layers.title')}</p>
      {p.record.status !== 'ok' && p.local !== 'absent' && (
        <p className="text-muted-foreground">{t('fresh.layers.noRecord', { status: p.record.status })}</p>
      )}
      <p>{t('fresh.layers.golden', s)}</p>
      <p>{t('fresh.layers.local', s)}</p>
      <p>{t('fresh.layers.deny', { golden: p.deny.golden, local: p.deny.local, folded: p.deny.folded })}</p>
      <p>{t('fresh.layers.keys', { golden: s.goldenKeys, local: s.localKeys })}</p>
      {p.passwordReplaced && <p className="text-muted-foreground">{t('fresh.layers.password')}</p>}
      {p.approvalItems.length > 0 && (
        <p className="text-destructive">{t('fresh.layers.approvalTitle', { count: p.approvalItems.length })}</p>
      )}
    </div>
  )
}
