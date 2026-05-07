import CodeMirror from '@uiw/react-codemirror'
import { json } from '@codemirror/lang-json'
import { useEffect, useMemo } from 'react'

interface McpJsonEditorProps {
  value: string
  onChange: (value: string) => void
  /** parse 失敗時に呼ばれる。null は parse OK を示す。 */
  onParseStateChange?: (error: string | null) => void
  height?: string
}

export function McpJsonEditor({
  value,
  onChange,
  onParseStateChange,
  height = '320px'
}: McpJsonEditorProps): React.JSX.Element {
  const parseError = useMemo<string | null>(() => {
    if (value.trim().length === 0) return null
    try {
      JSON.parse(value)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }, [value])

  useEffect(() => {
    onParseStateChange?.(parseError)
  }, [parseError, onParseStateChange])

  return (
    <div className="space-y-1">
      <div className="border border-border rounded overflow-hidden">
        <CodeMirror
          value={value}
          height={height}
          extensions={[json()]}
          onChange={(v) => onChange(v)}
          theme="dark"
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: true,
            tabSize: 2
          }}
        />
      </div>
      {parseError && (
        <div className="text-xs text-destructive font-mono">{parseError}</div>
      )}
    </div>
  )
}
