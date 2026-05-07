import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Plus, Trash2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Button } from '../ui/button'
import { McpJsonEditor } from './McpJsonEditor'
import { MCP_PRESETS, findPreset } from './presets'
import {
  classifyRiskView,
  isWriteToolName,
  looksLikePlainSecretView
} from '../../lib/mcp/writeKeywordsView'

export interface McpEditValue {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  disabledTools: string[]
}

interface McpEditDialogProps {
  open: boolean
  onClose: () => void
  initial: {
    name: string
    command?: string
    args?: string[]
    env?: Record<string, string>
    disabledTools?: string[]
  } | null
  onSave: (value: McpEditValue) => void | Promise<void>
}

type Mode = 'a' | 'c'

const PRESET_CUSTOM = 'custom'

interface EnvRow {
  key: string
  value: string
}

function toEnvRows(env: Record<string, string> | undefined): EnvRow[] {
  if (!env) return []
  return Object.entries(env).map(([key, value]) => ({ key, value }))
}

function rowsToEnv(rows: EnvRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) {
    if (r.key.trim().length === 0) continue
    out[r.key.trim()] = r.value
  }
  return out
}

function argsToString(args: string[]): string {
  return args.join(' ')
}

function stringToArgs(s: string): string[] {
  // 単純なスペース区切り。引用符の中の空白は保持する簡易パーサ。
  const result: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (const ch of s) {
    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        result.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current.length > 0) result.push(current)
  return result
}

export function McpEditDialog({
  open,
  onClose,
  initial,
  onSave
}: McpEditDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const [mode, setMode] = useState<Mode>('a')
  const [presetId, setPresetId] = useState<string>(PRESET_CUSTOM)
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [envRows, setEnvRows] = useState<EnvRow[]>([])
  const [disabledTools, setDisabledTools] = useState<string[]>([])
  const [presetDisabledCandidates, setPresetDisabledCandidates] = useState<string[]>([])
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [showRiskOverride, setShowRiskOverride] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // initial / open 切替時に state を初期化
  useEffect(() => {
    if (!open) return
    setMode('a')
    setPresetId(PRESET_CUSTOM)
    setValidationError(null)
    setShowRiskOverride(false)
    if (initial) {
      setName(initial.name)
      setCommand(initial.command ?? '')
      setArgsText(argsToString(initial.args ?? []))
      setEnvRows(toEnvRows(initial.env))
      setDisabledTools(initial.disabledTools ?? [])
      setPresetDisabledCandidates(initial.disabledTools ?? [])
      setJsonText(
        JSON.stringify(
          {
            command: initial.command,
            args: initial.args ?? [],
            env: initial.env ?? {},
            disabledTools: initial.disabledTools ?? []
          },
          null,
          2
        )
      )
    } else {
      setName('')
      setCommand('')
      setArgsText('')
      setEnvRows([])
      setDisabledTools([])
      setPresetDisabledCandidates([])
      setJsonText(JSON.stringify({ command: '', args: [], env: {}, disabledTools: [] }, null, 2))
    }
  }, [open, initial])

  const previewServer = useMemo(
    () => ({ env: rowsToEnv(envRows), disabledTools }),
    [envRows, disabledTools]
  )
  const risk = classifyRiskView(previewServer)

  const applyPreset = (id: string): void => {
    setPresetId(id)
    setShowRiskOverride(false)
    if (id === PRESET_CUSTOM) {
      return
    }
    const p = findPreset(id)
    if (!p) return
    setName(p.name)
    setCommand(p.command)
    setArgsText(argsToString(p.args))
    setEnvRows(toEnvRows(p.env))
    setDisabledTools([...p.disabledTools])
    setPresetDisabledCandidates([...p.disabledTools])
  }

  const switchMode = (next: Mode): void => {
    if (next === mode) return
    if (next === 'c') {
      // A → C: フォーム内容を JSON へ
      const value = {
        command,
        args: stringToArgs(argsText),
        env: rowsToEnv(envRows),
        disabledTools
      }
      setJsonText(JSON.stringify(value, null, 2))
      setJsonError(null)
      setMode('c')
      return
    }
    // C → A: JSON を parse してフォームへ反映。parse 失敗ならブロック。
    try {
      const parsed = JSON.parse(jsonText) as {
        command?: string
        args?: string[]
        env?: Record<string, string>
        disabledTools?: string[]
      }
      setCommand(parsed.command ?? '')
      setArgsText(argsToString(parsed.args ?? []))
      setEnvRows(toEnvRows(parsed.env))
      setDisabledTools(parsed.disabledTools ?? [])
      setMode('a')
      setValidationError(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setValidationError(t('pages.mcp.edit.invalidJson', { msg }))
    }
  }

  const toggleDisabledTool = (tool: string): void => {
    setDisabledTools((prev) =>
      prev.includes(tool) ? prev.filter((x) => x !== tool) : [...prev, tool]
    )
  }

  const enableAll = (): void => {
    setShowRiskOverride(false)
    setDisabledTools([])
  }

  const handleSave = async (): Promise<void> => {
    setValidationError(null)
    let value: McpEditValue
    if (mode === 'c') {
      if (jsonError) {
        setValidationError(t('pages.mcp.edit.invalidJson', { msg: jsonError }))
        return
      }
      try {
        const parsed = JSON.parse(jsonText) as {
          command?: string
          args?: string[]
          env?: Record<string, string>
          disabledTools?: string[]
        }
        if (!name.trim()) {
          setValidationError(t('pages.mcp.edit.nameRequired'))
          return
        }
        if (!parsed.command || parsed.command.trim().length === 0) {
          setValidationError(t('pages.mcp.edit.commandRequired'))
          return
        }
        value = {
          name: name.trim(),
          command: parsed.command.trim(),
          args: parsed.args ?? [],
          env: parsed.env ?? {},
          disabledTools: parsed.disabledTools ?? []
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setValidationError(t('pages.mcp.edit.invalidJson', { msg }))
        return
      }
    } else {
      if (!name.trim()) {
        setValidationError(t('pages.mcp.edit.nameRequired'))
        return
      }
      if (!command.trim()) {
        setValidationError(t('pages.mcp.edit.commandRequired'))
        return
      }
      value = {
        name: name.trim(),
        command: command.trim(),
        args: stringToArgs(argsText),
        env: rowsToEnv(envRows),
        disabledTools
      }
    }

    // env 値のシークレット直書き検出
    for (const [k, v] of Object.entries(value.env)) {
      if (looksLikePlainSecretView(v)) {
        setValidationError(t('pages.mcp.edit.plainSecret', { key: k }))
        return
      }
    }

    setSaving(true)
    try {
      await onSave(value)
    } finally {
      setSaving(false)
    }
  }

  // disabledTools の選択肢: presetDisabledCandidates をベースに、現在登録されているものを union
  const allDisabledOptions = useMemo(() => {
    const set = new Set<string>([...presetDisabledCandidates, ...disabledTools])
    return Array.from(set).sort()
  }, [presetDisabledCandidates, disabledTools])

  const writeOnlyOptions = useMemo(
    () => allDisabledOptions.filter(isWriteToolName),
    [allDisabledOptions]
  )

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} modal={false}>
      <DialogContent className="z-[70] max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {initial ? t('pages.mcp.edit.titleEdit') : t('pages.mcp.edit.titleAdd')}
          </DialogTitle>
          <DialogDescription>{t('pages.mcp.edit.description')}</DialogDescription>
        </DialogHeader>

        {/* Mode switch */}
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('pages.mcp.edit.mode')}</span>
          {(['a', 'c'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => switchMode(m)}
              className={`px-3 py-1 rounded border transition-colors ${
                mode === m
                  ? 'border-primary bg-primary/10'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {t(`pages.mcp.edit.mode${m.toUpperCase()}`)}
            </button>
          ))}
        </div>

        {mode === 'a' ? (
          <div className="space-y-3">
            {/* Preset */}
            <div className="space-y-1">
              <label className="text-sm">{t('pages.mcp.edit.preset')}</label>
              <select
                value={presetId}
                onChange={(e) => applyPreset(e.target.value)}
                disabled={!!initial}
                className="w-full bg-background border border-border rounded px-2 py-1 text-sm"
              >
                <option value={PRESET_CUSTOM}>{t('pages.mcp.edit.presetCustom')}</option>
                {MCP_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.description}
                  </option>
                ))}
              </select>
            </div>

            {/* Name */}
            <div className="space-y-1">
              <label className="text-sm">{t('pages.mcp.edit.name')}</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!!initial}
                className="w-full bg-background border border-border rounded px-2 py-1 text-sm font-mono"
                placeholder="github"
              />
            </div>

            {/* Command */}
            <div className="space-y-1">
              <label className="text-sm">{t('pages.mcp.edit.command')}</label>
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                className="w-full bg-background border border-border rounded px-2 py-1 text-sm font-mono"
                placeholder="npx"
              />
            </div>

            {/* Args */}
            <div className="space-y-1">
              <label className="text-sm">{t('pages.mcp.edit.args')}</label>
              <input
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                className="w-full bg-background border border-border rounded px-2 py-1 text-sm font-mono"
                placeholder="-y @modelcontextprotocol/server-github"
              />
              <div className="text-xs text-muted-foreground">{t('pages.mcp.edit.argsHelp')}</div>
            </div>

            {/* Env */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-sm">{t('pages.mcp.edit.env')}</label>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEnvRows((prev) => [...prev, { key: '', value: '' }])}
                >
                  <Plus size={12} />
                  <span className="ml-1">{t('pages.mcp.edit.addEnv')}</span>
                </Button>
              </div>
              <div className="space-y-1">
                {envRows.map((row, idx) => (
                  <div key={idx} className="flex gap-1">
                    <input
                      value={row.key}
                      onChange={(e) =>
                        setEnvRows((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, key: e.target.value } : r))
                        )
                      }
                      className="w-1/3 bg-background border border-border rounded px-2 py-1 text-xs font-mono"
                      placeholder="GITHUB_PERSONAL_ACCESS_TOKEN"
                    />
                    <input
                      value={row.value}
                      onChange={(e) =>
                        setEnvRows((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, value: e.target.value } : r))
                        )
                      }
                      className="flex-1 bg-background border border-border rounded px-2 py-1 text-xs font-mono"
                      placeholder="${GITHUB_PERSONAL_ACCESS_TOKEN}"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setEnvRows((prev) => prev.filter((_, i) => i !== idx))
                      }
                    >
                      <Trash2 size={12} />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="text-xs text-muted-foreground">{t('pages.mcp.edit.envHelp')}</div>
            </div>

            {/* Disabled tools */}
            {writeOnlyOptions.length > 0 && (
              <div className="space-y-1 border border-border rounded p-3">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">
                    {t('pages.mcp.edit.disabledTools')}
                  </label>
                  <span className="text-xs text-muted-foreground">
                    {t('pages.mcp.edit.disabledToolsCount', { count: disabledTools.length })}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-1">
                  {writeOnlyOptions.map((tool) => {
                    const checked = disabledTools.includes(tool)
                    return (
                      <label key={tool} className="flex items-center gap-2 text-xs font-mono">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleDisabledTool(tool)}
                        />
                        <span className={checked ? '' : 'text-muted-foreground line-through'}>
                          {tool}
                        </span>
                      </label>
                    )
                  })}
                </div>
                <div className="pt-1">
                  {!showRiskOverride ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setShowRiskOverride(true)}
                      disabled={disabledTools.length === 0}
                    >
                      {t('pages.mcp.edit.enableAll')}
                    </Button>
                  ) : (
                    <div className="border border-destructive/50 bg-destructive/10 rounded p-2 space-y-2">
                      <div className="flex items-start gap-2 text-xs">
                        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-destructive" />
                        <span>{t('pages.mcp.edit.enableAllWarning')}</span>
                      </div>
                      <div className="flex gap-1">
                        <Button size="sm" variant="destructive" onClick={enableAll}>
                          {t('pages.mcp.edit.enableAllConfirm')}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setShowRiskOverride(false)}
                        >
                          {t('common.cancel')}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="text-xs text-muted-foreground">
              {t(`pages.mcp.risk.${risk}.label`)} — {t(`pages.mcp.risk.${risk}.tooltip`)}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="space-y-1">
              <label className="text-sm">{t('pages.mcp.edit.name')}</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!!initial}
                className="w-full bg-background border border-border rounded px-2 py-1 text-sm font-mono"
                placeholder="github"
              />
            </div>
            <McpJsonEditor
              value={jsonText}
              onChange={setJsonText}
              onParseStateChange={setJsonError}
            />
            <div className="text-xs text-muted-foreground">{t('pages.mcp.edit.modeCHelp')}</div>
          </div>
        )}

        {validationError && (
          <div className="text-xs text-destructive border border-destructive/50 rounded p-2 whitespace-pre-wrap">
            {validationError}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? t('pages.mcp.edit.saving') : t('pages.mcp.edit.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
