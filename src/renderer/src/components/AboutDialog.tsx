import { X, ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/button'
import logoImg from '../assets/Logo.png'

interface AboutDialogProps {
  open: boolean
  onClose: () => void
}

export function AboutDialog({ open, onClose }: AboutDialogProps): React.JSX.Element | null {
  const { t } = useTranslation()

  if (!open) return null

  const handleOpenGithub = async (): Promise<void> => {
    await window.api.openExternal('https://github.com/(placeholder)')
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-lg shadow-lg w-full max-w-sm mx-4 flex flex-col overflow-hidden">
        {/* Logo area with dark background */}
        <div className="bg-[#1a1a2e] px-8 pt-10 pb-6 flex flex-col items-center relative">
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="absolute top-3 right-3 h-7 w-7 text-white/50 hover:text-white hover:bg-white/10"
          >
            <X size={14} />
          </Button>
          <img src={logoImg} alt="CCPIT" style={{ width: 240 }} className="w-auto mb-3" />
          <p className="text-[10px] text-white/30 tracking-[3px] uppercase">Protocol Interlock Tower</p>
        </div>

        {/* Info area */}
        <div className="p-6 flex flex-col items-center gap-3 text-center">
          <div className="text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground text-sm">{t('about.version')}</p>
            <p>{t('about.license')}</p>
            <p>{t('about.builtWith')}</p>
          </div>
          <Button variant="outline" size="sm" className="gap-1.5 mt-1" onClick={handleOpenGithub}>
            <ExternalLink size={14} />
            GitHub
          </Button>
        </div>
      </div>
    </div>
  )
}
