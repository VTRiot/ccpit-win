import { useState, useCallback, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, FolderOpen, Loader2, Check, X, Copy, ExternalLink, FileUp, Eye, EyeOff, FileArchive, AlertTriangle } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card'
import { cn } from '../../lib/utils'

interface MigrationWizardProps {
  onBack: () => void
  onSetupCompleted: () => void
}

type Step = 'scan' | 'scanning' | 'scanResult' | 'packGenerated' | 'import' | 'pitPreview' | 'password' | 'deploying' | 'result'

interface ScannedFile {
  path: string
  name: string
  lines: number
  sizeBytes: number
  category: string
}

interface PitEntry {
  path: string
  content: string
  lines: number
}

interface PitPreview {
  entries: PitEntry[]
  claudeMdPreview: string
  claudeMdLines: number
  rulesCount: number
  skillsCount: number
  coverageMapSummary: { totalRows: number; uncoveredCount: number } | null
  metricsRaw: string | null
  validationErrors: string[]
}

interface DeployResult {
  deployed: string[]
  backedUp: string[]
  errors: string[]
}

const STEP_KEYS = ['scan', 'pack', 'import', 'deploy'] as const

function getStepGroupIndex(step: Step): number {
  if (step === 'scan' || step === 'scanning' || step === 'scanResult') return 0
  if (step === 'packGenerated') return 1
  if (step === 'import' || step === 'pitPreview') return 2
  return 3
}

export function MigrationWizard({ onBack, onSetupCompleted }: MigrationWizardProps): React.JSX.Element {
  const { t } = useTranslation()
  const [step, setStep] = useState<Step>('scan')
  const [scannedFiles, setScannedFiles] = useState<ScannedFile[]>([])
  const [packContent, setPackContent] = useState('')
  const [pitPreview, setPitPreview] = useState<PitPreview | null>(null)
  const [pitLoading, setPitLoading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [deployResult, setDeployResult] = useState<DeployResult | null>(null)

  const passwordValid = password.length >= 4 && password === passwordConfirm
  const currentGroup = getStepGroupIndex(step)

  const handleSelectFolder = async (): Promise<void> => {
    const folder = await window.api.selectFolder()
    if (!folder) return
    setStep('scanning')
    const files = await window.api.migrationScan(folder)
    setScannedFiles(files)
    setStep('scanResult')
  }

  const handleGeneratePack = async (): Promise<void> => {
    const pack = await window.api.migrationGeneratePack(scannedFiles)
    setPackContent(pack)
    setStep('packGenerated')
  }

  const handleOpenClaudeAi = async (): Promise<void> => {
    await window.api.clipboardWrite(packContent)
    await window.api.openExternal('https://claude.ai/new')
  }

  const loadPitFile = useCallback(async (filePath: string): Promise<void> => {
    setPitLoading(true)
    try {
      const preview = await window.api.migrationImportPit(filePath)
      setPitPreview(preview)
      setStep('pitPreview')
    } catch (err) {
      setPitPreview({
        entries: [],
        claudeMdPreview: '',
        claudeMdLines: 0,
        rulesCount: 0,
        skillsCount: 0,
        coverageMapSummary: null,
        metricsRaw: null,
        validationErrors: [err instanceof Error ? err.message : String(err)],
      })
      setStep('pitPreview')
    } finally {
      setPitLoading(false)
    }
  }, [])

  const handleSelectPitFile = async (): Promise<void> => {
    const filePath = await window.api.selectPitFile()
    if (!filePath) return
    await loadPitFile(filePath)
  }

  const handleDrop = useCallback(async (e: DragEvent<HTMLDivElement>): Promise<void> => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (!file || !file.name.endsWith('.pit')) return
    // Electron extends File with a `path` property
    const filePath = (file as File & { path: string }).path
    await loadPitFile(filePath)
  }, [loadPitFile])

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((): void => {
    setDragOver(false)
  }, [])

  const handleDeployPit = async (): Promise<void> => {
    if (!pitPreview) return
    setStep('password')
  }

  const handleDeploy = async (): Promise<void> => {
    if (!pitPreview) return
    setStep('deploying')
    const res = await window.api.migrationDeployPit(pitPreview.entries)
    setDeployResult(res)
    if (res.errors.length === 0) {
      await window.api.configSet({ setupCompleted: true })
    }
    setStep('result')
  }

  const stepLabels = STEP_KEYS.map((key) => t(`migration.steps.${key}`))

  const pitHasErrors = pitPreview && pitPreview.validationErrors.length > 0

  return (
    <div className="max-w-2xl mx-auto mt-8">
      <Button variant="ghost" size="sm" onClick={onBack} className="mb-6 -ml-2 text-muted-foreground">
        <ArrowLeft size={16} /> {t('common.back')}
      </Button>

      <h2 className="text-xl font-bold mb-6">{t('migration.title')}</h2>

      {/* Step Indicator */}
      <div className="flex items-center gap-2 mb-8">
        {stepLabels.map((label, i) => (
          <div key={i} className="flex items-center gap-2">
            <div
              className={cn(
                'w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium transition-colors',
                i < currentGroup
                  ? 'bg-primary text-primary-foreground'
                  : i === currentGroup
                    ? 'bg-primary text-primary-foreground ring-2 ring-primary/30'
                    : 'bg-muted text-muted-foreground'
              )}
            >
              {i < currentGroup ? <Check size={14} /> : i + 1}
            </div>
            <span className={cn('text-xs hidden sm:inline', i === currentGroup ? 'text-foreground font-medium' : 'text-muted-foreground')}>
              {label}
            </span>
            {i < stepLabels.length - 1 && <div className="w-8 h-px bg-border" />}
          </div>
        ))}
      </div>

      {step === 'scan' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('migration.scanTitle')}</CardTitle>
            <CardDescription>{t('migration.scanDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={handleSelectFolder}>
              <FolderOpen size={16} /> {t('migration.selectFolder')}
            </Button>
          </CardContent>
        </Card>
      )}

      {step === 'scanning' && (
        <Card>
          <CardContent className="flex items-center justify-center gap-3 py-12 text-muted-foreground">
            <Loader2 size={20} className="animate-spin" /> {t('common.scanning')}
          </CardContent>
        </Card>
      )}

      {step === 'scanResult' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('migration.scanResult', { count: scannedFiles.length })}</CardTitle>
          </CardHeader>
          <CardContent>
            {scannedFiles.length === 0 ? (
              <div className="text-muted-foreground py-4">
                {t('migration.noFilesFound')}
                <Button variant="link" onClick={() => setStep('scan')} className="ml-1 px-0">
                  {t('migration.selectAnother')}
                </Button>
              </div>
            ) : (
              <>
                <div className="border border-border rounded-md mb-6 max-h-48 overflow-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/50">
                        <th className="text-left p-2.5 text-muted-foreground font-medium">{t('common.file')}</th>
                        <th className="text-left p-2.5 text-muted-foreground font-medium">{t('common.lines')}</th>
                        <th className="text-left p-2.5 text-muted-foreground font-medium">{t('common.size')}</th>
                        <th className="text-left p-2.5 text-muted-foreground font-medium">{t('common.category')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scannedFiles.map((f) => (
                        <tr key={f.path} className="border-b border-border/50">
                          <td className="p-2.5 font-mono text-xs">{f.name}</td>
                          <td className="p-2.5 text-xs">{f.lines}</td>
                          <td className="p-2.5 text-xs">{f.sizeBytes} B</td>
                          <td className="p-2.5 text-xs text-muted-foreground">{f.category}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Button onClick={handleGeneratePack}>{t('migration.generatePack')}</Button>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {step === 'packGenerated' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('migration.packTitle')}</CardTitle>
            <CardDescription>{t('migration.packDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="border border-border rounded-md p-3 max-h-48 overflow-auto bg-muted/30">
              <pre className="text-xs font-mono whitespace-pre-wrap text-muted-foreground">{packContent}</pre>
            </div>
            <div className="flex gap-3">
              <Button onClick={handleOpenClaudeAi}>
                <ExternalLink size={16} /> {t('migration.openClaudeAi')}
              </Button>
              <Button variant="outline" onClick={async () => { await window.api.clipboardWrite(packContent) }}>
                <Copy size={16} /> {t('common.copy')}
              </Button>
            </div>
            {/* Browser guide */}
            <div className="rounded-md border border-border bg-muted/30 p-3 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">{t('migration.browserGuide')}</p>
              <p className="text-xs text-muted-foreground">{t('migration.browserStep1')}</p>
              <p className="text-xs text-muted-foreground">{t('migration.browserStep2')}</p>
              <p className="text-xs text-muted-foreground">{t('migration.browserStep3')}</p>
            </div>

            <div className="border-t border-border pt-4">
              <p className="text-sm text-muted-foreground mb-3">{t('migration.packImportHint')}</p>
              <Button variant="secondary" onClick={() => setStep('import')}>
                <FileUp size={16} /> {t('common.import')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'import' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('migration.importTitle')}</CardTitle>
            <CardDescription>{t('migration.importDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {pitLoading ? (
              <div className="flex items-center justify-center gap-3 py-12 text-muted-foreground">
                <Loader2 size={20} className="animate-spin" /> {t('migration.pitLoading')}
              </div>
            ) : (
              <>
                {/* ファイル選択ボタン */}
                <Button onClick={handleSelectPitFile}>
                  <FileArchive size={16} /> {t('migration.selectPitFile')}
                </Button>

                {/* D&D エリア */}
                <div
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  className={cn(
                    'flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-8 transition-colors',
                    dragOver
                      ? 'border-primary bg-primary/5 text-primary'
                      : 'border-border text-muted-foreground'
                  )}
                >
                  <FileUp size={24} />
                  <p className="text-sm">
                    {dragOver ? t('migration.dropPitActive') : t('migration.dropPitHint')}
                  </p>
                </div>

                <div className="flex gap-3">
                  <Button variant="outline" onClick={() => setStep('packGenerated')}>{t('common.back')}</Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {step === 'pitPreview' && pitPreview && (
        <Card>
          <CardHeader>
            <CardTitle>{t('migration.pitPreviewTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* 検証エラー */}
            {pitHasErrors && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 space-y-1">
                <div className="flex items-center gap-2 text-destructive text-sm font-medium">
                  <AlertTriangle size={16} />
                  {t('migration.pitValidationErrors', { count: pitPreview.validationErrors.length })}
                </div>
                <ul className="list-disc list-inside text-xs text-destructive space-y-0.5">
                  {pitPreview.validationErrors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}

            {/* ファイルツリー */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">{t('migration.pitFileTree')}</p>
              <div className="bg-muted/50 rounded-md p-3 max-h-40 overflow-auto">
                <ul className="text-xs font-mono space-y-0.5">
                  {pitPreview.entries.map((e) => (
                    <li key={e.path} className="flex justify-between">
                      <span>{e.path}</span>
                      <span className="text-muted-foreground">{e.lines} L</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* サマリー */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md border border-border p-3">
                <p className="text-xs text-muted-foreground">{t('migration.pitClaudeMd', { lines: pitPreview.claudeMdLines })}</p>
                {pitPreview.claudeMdPreview && (
                  <pre className="text-xs font-mono mt-2 whitespace-pre-wrap text-muted-foreground max-h-24 overflow-auto">
                    {pitPreview.claudeMdPreview}
                  </pre>
                )}
              </div>
              <div className="rounded-md border border-border p-3 space-y-1">
                <p className="text-xs text-muted-foreground">{t('migration.pitRules', { count: pitPreview.rulesCount })}</p>
                <p className="text-xs text-muted-foreground">{t('migration.pitSkills', { count: pitPreview.skillsCount })}</p>
                {pitPreview.coverageMapSummary && (
                  <p className="text-xs text-muted-foreground">
                    {t('migration.pitCoverage', {
                      total: pitPreview.coverageMapSummary.totalRows,
                      uncovered: pitPreview.coverageMapSummary.uncoveredCount,
                    })}
                  </p>
                )}
              </div>
            </div>

            {/* メトリクス */}
            {pitPreview.metricsRaw && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">{t('migration.pitMetrics')}</p>
                <pre className="text-xs font-mono bg-muted/50 rounded-md p-3 whitespace-pre-wrap max-h-32 overflow-auto">
                  {pitPreview.metricsRaw}
                </pre>
              </div>
            )}

            {/* アクションボタン */}
            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setStep('import')}>{t('common.back')}</Button>
              <Button onClick={handleDeployPit} disabled={!!pitHasErrors}>
                {t('migration.pitDeploy')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'password' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('migration.passwordTitle')}</CardTitle>
            <CardDescription>{t('migration.passwordDescription')}</CardDescription>
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
            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setStep('pitPreview')}>{t('common.back')}</Button>
              <Button onClick={handleDeploy} disabled={!passwordValid}>{t('common.runSetup')}</Button>
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

      {step === 'result' && deployResult && (
        <Card>
          <CardHeader>
            {deployResult.errors.length === 0 ? (
              <div className="flex items-center gap-2 text-green-500">
                <Check size={20} />
                <CardTitle>{t('migration.setupComplete')}</CardTitle>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-destructive">
                <X size={20} />
                <CardTitle>{t('migration.hasErrors')}</CardTitle>
              </div>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground mb-2">{t('common.deployedFiles', { count: deployResult.deployed.length })}</p>
              <div className="bg-muted/50 rounded-md p-3">
                <ul className="list-disc list-inside text-xs font-mono space-y-0.5">
                  {deployResult.deployed.map((f) => <li key={f}>{f}</li>)}
                </ul>
              </div>
            </div>
            {deployResult.backedUp.length > 0 && (
              <div>
                <p className="text-sm text-muted-foreground mb-2">{t('common.backups', { count: deployResult.backedUp.length })}</p>
                <div className="bg-muted/50 rounded-md p-3">
                  <ul className="list-disc list-inside text-xs font-mono space-y-0.5">
                    {deployResult.backedUp.map((f) => <li key={f}>{f}</li>)}
                  </ul>
                </div>
              </div>
            )}
            {deployResult.errors.length > 0 && (
              <div>
                <p className="text-sm text-destructive mb-2">{t('common.errors', { count: deployResult.errors.length })}</p>
                <div className="bg-destructive/10 rounded-md p-3">
                  <ul className="list-disc list-inside text-xs font-mono space-y-0.5 text-destructive">
                    {deployResult.errors.map((e) => <li key={e}>{e}</li>)}
                  </ul>
                </div>
              </div>
            )}
            {deployResult.errors.length === 0 && (
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
