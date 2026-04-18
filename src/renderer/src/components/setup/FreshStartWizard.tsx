import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Eye, EyeOff, Check, X, Loader2 } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card'
import { cn } from '../../lib/utils'

interface FreshStartWizardProps {
  onBack: () => void
  onSetupCompleted: () => void
}

type Step = 'password' | 'preview' | 'deploying' | 'result'

const STEP_IDS: Step[] = ['password', 'preview', 'result']

interface DeployResult {
  deployed: string[]
  backedUp: string[]
  errors: string[]
}

/** OS に応じたテンプレートを自動選択 */
function detectTemplate(): string {
  const platform = window.electron?.process?.platform ?? 'win32'
  return platform === 'linux' ? 'asama' : 'manx'
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

  const passwordValid = password.length >= 4 && password === passwordConfirm

  const handlePreview = async (): Promise<void> => {
    const items = await window.api.goldenPreview(selectedTemplate)
    setPreview(items)
    setStep('preview')
  }

  const handleDeploy = async (): Promise<void> => {
    setStep('deploying')
    const res = await window.api.goldenDeploy(selectedTemplate, password)
    setResult(res)
    if (res.errors.length === 0) {
      await window.api.configSet({ setupCompleted: true })
    }
    setStep('result')
  }

  const currentStepIndex = STEP_IDS.indexOf(step === 'deploying' ? 'result' : step)
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
            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setStep('password')}>{t('common.back')}</Button>
              <Button onClick={handleDeploy}>{t('common.runSetup')}</Button>
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
