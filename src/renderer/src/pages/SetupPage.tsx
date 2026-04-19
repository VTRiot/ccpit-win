import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FreshStartWizard } from '../components/setup/FreshStartWizard'
import { MigrationWizard } from '../components/setup/MigrationWizard'
import { Sparkles, ArrowRightLeft } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardDescription } from '../components/ui/card'
import { Toast } from '../components/ui/toast'
import logoImg from '../assets/Logo.png'

type SetupMode = 'choose' | 'fresh' | 'migration'

const DEBUG_TAP_COUNT = 5
const DEBUG_TAP_INTERVAL_MS = 500

interface SetupPageProps {
  onSetupCompleted: () => void
}

export function SetupPage({ onSetupCompleted }: SetupPageProps): React.JSX.Element {
  const [mode, setMode] = useState<SetupMode>('choose')
  const { t } = useTranslation()
  const tapStampsRef = useRef<number[]>([])
  const [toastOpen, setToastOpen] = useState(false)
  const [toastMessage, setToastMessage] = useState('')
  const [toastVariant, setToastVariant] = useState<'success' | 'error'>('success')

  const handleLogoTap = (): void => {
    const now = Date.now()
    const stamps = tapStampsRef.current
    if (stamps.length > 0 && now - stamps[stamps.length - 1] > DEBUG_TAP_INTERVAL_MS) {
      stamps.length = 0
    }
    stamps.push(now)
    if (stamps.length < DEBUG_TAP_COUNT) return
    stamps.length = 0
    void window.api.configGet().then((config) => {
      const next = !config.debugMode
      void window.api.configSet({ debugMode: next }).then(() => {
        setToastMessage(next ? t('common.debugModeOn') : t('common.debugModeOff'))
        setToastVariant(next ? 'success' : 'error')
        setToastOpen(true)
      })
    })
  }

  if (mode === 'fresh') {
    return <FreshStartWizard onBack={() => setMode('choose')} onSetupCompleted={onSetupCompleted} />
  }

  if (mode === 'migration') {
    return <MigrationWizard onBack={() => setMode('choose')} onSetupCompleted={onSetupCompleted} />
  }

  return (
    <div className="max-w-xl mx-auto mt-16">
      <div className="flex flex-col items-center mb-8">
        <img
          src={logoImg}
          alt="CCPIT"
          style={{ width: 400 }}
          className="w-auto cursor-pointer select-none"
          draggable={false}
          onClick={handleLogoTap}
        />
        <p className="text-xs text-muted-foreground mt-2 tracking-widest">Protocol Interlock Tower</p>
      </div>
      <h1 className="text-2xl font-bold mb-2">{t('setup.welcome')}</h1>
      <p className="text-muted-foreground mb-8">{t('setup.welcomeDescription')}</p>

      <div className="flex flex-col gap-4">
        <Card className="cursor-pointer hover:bg-accent/50 transition-colors" onClick={() => setMode('fresh')}>
          <CardHeader className="flex-row items-center gap-4">
            <div className="rounded-md bg-primary/10 p-2.5">
              <Sparkles size={22} className="text-primary" />
            </div>
            <div className="flex-1">
              <CardTitle>{t('setup.freshStart')}</CardTitle>
              <CardDescription className="mt-1">{t('setup.freshStartDescription')}</CardDescription>
            </div>
          </CardHeader>
        </Card>

        <Card className="cursor-pointer hover:bg-accent/50 transition-colors" onClick={() => setMode('migration')}>
          <CardHeader className="flex-row items-center gap-4">
            <div className="rounded-md bg-primary/10 p-2.5">
              <ArrowRightLeft size={22} className="text-primary" />
            </div>
            <div className="flex-1">
              <CardTitle>{t('setup.migration')}</CardTitle>
              <CardDescription className="mt-1">{t('setup.migrationDescription')}</CardDescription>
            </div>
          </CardHeader>
        </Card>
      </div>

      <Toast
        open={toastOpen}
        message={toastMessage}
        onClose={() => setToastOpen(false)}
        variant={toastVariant}
      />
    </div>
  )
}
