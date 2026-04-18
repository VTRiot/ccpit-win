import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'

export function DebugPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [splashDurationMs, setSplashDurationMs] = useState(3000)
  const [splashRareChance, setSplashRareChance] = useState(0.033)

  useEffect(() => {
    window.api.configGet().then((config) => {
      setSplashDurationMs(config.splashDurationMs)
      setSplashRareChance(config.splashRareChance)
    })
  }, [])

  const handleSplashDurationChange = (value: number): void => {
    setSplashDurationMs(value)
    window.api.configSet({ splashDurationMs: value })
  }

  const handleSplashRareChange = (value: number): void => {
    setSplashRareChance(value)
    window.api.configSet({ splashRareChance: value })
  }

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-xl font-bold">Debug 🕷️</h1>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.splashSettings')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('settings.splashDuration')}</p>
            <p className="text-xs text-muted-foreground">{t('settings.splashDurationDescription')}</p>
            <div className="flex items-center gap-3 mt-1">
              <input
                type="range"
                min="500"
                max="10000"
                step="100"
                value={splashDurationMs}
                onChange={(e) => handleSplashDurationChange(parseInt(e.target.value))}
                className="flex-1"
              />
              <span className="text-sm font-mono w-20 text-right">
                {(splashDurationMs / 1000).toFixed(1)}s
              </span>
            </div>
          </div>

          <div className="space-y-1">
            <p className="text-sm font-medium">{t('settings.splashRareChance')}</p>
            <p className="text-xs text-muted-foreground">{t('settings.splashRareChanceDescription')}</p>
            <div className="flex items-center gap-3 mt-1">
              <input
                type="range"
                min="0"
                max="1"
                step="0.001"
                value={splashRareChance}
                onChange={(e) => handleSplashRareChange(parseFloat(e.target.value))}
                className="flex-1"
              />
              <span className="text-sm font-mono w-16 text-right">
                {(splashRareChance * 100).toFixed(1)}%
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
