import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { ISOLATION_BLOCK_REASON, isIsolatedLaunch, noteBlocked } from '../isolation'
import { resolveClaudeBin } from './cliResolver'
import { emitBgccActivity } from './bgccActivityBus'
import {
  createStreamJsonAccumulator,
  sanitizeEventText,
  STDERR_CAP_BYTES,
  type StreamVerdict
} from './bgccStream'
import { createRunLogWriter } from './bgccRawLog'

/**
 * 裏CC定石（Backstage CC Pattern）共通ランチャー（040 初出、040_FB01 是正、040_FB02 stream 化）。
 * headless `claude -p` を常時 hidden でBG起動し、stream-json（JSONL）を逐次解析して
 * アクティビティイベント（bgccActivityBus）を流しつつ、最終 result イベントを厳密検証する。
 * 第二利用者はこの1関数を呼べば乗れる（クラス階層/レジストリなし＝過剰抽象回避）。
 *
 * R-0実測（040 Plan段階）に基づく設計:
 * - `--setting-sources` を空にするとユーザーCLAUDE.md/hooksを完全不発火にできる。
 * - `--tools` だけでは非対話 `-p` のツール利用は承認されない。`--allowedTools` の明示指定が必須
 *   （未指定だと黙って permission 拒否され、モデルが訓練知識へフォールバックした「説明文+JSON混在」
 *   の偽装成功応答を返す。envelope の subtype は "success" のまま — FB02 実キャプチャで再確認済み）。
 * - 対策: `.result` 文字列全体への厳密 JSON.parse のみ信頼する（validateResultEvent）。
 *   `permission_denials` 非空チェックも二重の安全網として併用。
 * - `-p` は positional prompt 省略時、標準入力からプロンプトを読む（実測確認済み）。
 *
 * 040_FB01 是正の継承（hidden 経路に残る分）:
 * - 全フラグは equals-form 単一トークン（空文字の独立引数は PowerShell/cmd シム経路で脱落する）。
 * - prompt は stdin 供給（shell:true での空白/引用符分割事故を構造的に排除）。
 * - cwd=tmpdir で auto-memory 注入を排除（注入は cwd のプロジェクト帰属で決まる — 実測）。
 * - useShell 時は command を二重引用符で包む（空白入りパスの分割即死対策）。
 *
 * 040_FB02（D2）: 可視ターミナル窓経路（runVisible / .ps1 生成 / wt.exe / ExecutionPolicy /
 * -NoExit / UTF-16 リダイレクトの罠層）は全削除した。可視性はアプリ内アクティビティパネル
 * （bgcc:activity push）が代替し、診断は bgccRawLog の生ログ保全が担う。
 * `--output-format=stream-json` は `-p` 併用時 `--verbose` が必須（欠落時は即 exit 1。
 * 実測証跡: __tests__/fixtures/bgcc-stream/noverbose-error.stderr.txt）。
 */

/** BG CC 実行モデル（§3 制約: Sonnet級軽量）。 */
const BACKSTAGE_CC_MODEL = 'claude-sonnet-4-6'
/** R-0実測: 公式Doc経路 $0.049/回。約10倍の安全マージンを既定上限とする。 */
const BACKSTAGE_CC_MAX_BUDGET_USD = 0.5
/**
 * FB01 F2（発注目安30s・実装裁量）: FB01実機E2E実測で P1=21.7秒（R-0時11秒から増加）を確認した
 * ため、実測の約2倍=45sを既定とする。30sだと P1 が時折 timeout→P2 fallback となり、env経路には
 * 存在しない最新モデル（例: sonnet-5）がプリセットから落ちる（S4 再発リスク）。
 */
const BACKSTAGE_CC_TIMEOUT_MS = 45_000
/**
 * FB02: timeout で killTree した後、close イベントを待って残余バッファを flush する（F3）。
 * kill 自体が失敗して close が永遠に来ないケースの保険として、この猶予で強制決着する。
 */
const KILL_GRACE_MS = 5_000

export interface BackstageCcRequest {
  prompt: string
  /** 省略時 BACKSTAGE_CC_MODEL。 */
  model?: string
  /** 例 ['WebFetch','WebSearch']。省略時は `--tools=` でツール無効化。 */
  allowedTools?: string[]
  maxBudgetUsd?: number
  timeoutMs?: number
  /** FB02: アクティビティイベント/生ログの帰属表示（例 'modelCatalog'）。 */
  source: string
  /** FB02: 実行フェーズ表示（例 'P1 official docs'）。 */
  phase?: string
  /** FB02: パネル自動オープン判定用（A1: manual の start で開く / A2: startup は失敗時のみ）。 */
  trigger?: 'manual' | 'startup'
  /**
   * L0_011: 作業場の中で動かす窓の無い実行（合成の改訂 AI）のための任意項目。
   * いずれも省略したときは従来と同じ挙動（cwd=tmpdir・設定なし・モデル既定・環境は process.env のまま・bus へ流す）。
   */
  /** 子プロセスの cwd。省略時は tmpdir()（auto-memory の注入を避ける従来の分離） */
  cwd?: string
  /** `--settings=<path>`。区切りは / に直してから SAFE_VALUE_RE で検査する */
  settingsPath?: string
  /** `--permission-mode=<v>`（例 acceptEdits） */
  permissionMode?: string
  /** true ならモデル指定（--model）を付けず、CLI の既定に任せる */
  omitModel?: boolean
  /** spawn の env。process.env に重ねる（pxpipe の環境変数など） */
  env?: Record<string, string>
  /** false なら bgccActivityBus へ流さない（既定 true）。生ログと結果は従来どおり */
  streamToBus?: boolean
}

export interface BackstageCcResult {
  /** true = result イベントちょうど1件 かつ envelope 正常 かつ 厳密JSON かつ permission拒否なし。 */
  ok: boolean
  /** ok=true 時のみ有効。`.result` の trim 済み生文字列（呼び出し側が2次パースする）。 */
  resultText?: string
  permissionDenied?: boolean
  error?: string
  durationMs: number
  /** FB02: 生ログ突合用の run 識別子。 */
  runId?: string
  /** FB02: result イベントの total_cost_usd（取得できた場合のみ）。 */
  costUsd?: number
}

/**
 * equals-form トークンの値として全経路（PowerShell 引数配列 / cmd.exe シムの %* / Node
 * shell:true の素結合）で安全な文字集合。空白・引用符・cmd メタ文字（& | < > ^ %）を含む値は
 * fail-fast で拒否する（第二利用者が動的値を渡した場合のインジェクション/分割事故の予防線）。
 */
export const SAFE_VALUE_RE = /^[A-Za-z0-9._,@:/=-]+$/
function assertSafeValue(label: string, value: string): void {
  if (!SAFE_VALUE_RE.test(value)) {
    throw new Error(`backstageCc: ${label} が安全でない文字を含む: ${JSON.stringify(value)}`)
  }
}

/** 純関数のみ export（テスト用）。spawn/fs を伴わないため DI コンテナは不要（過剰抽象回避）。 */
export function buildBaseArgs(req: BackstageCcRequest): string[] {
  const model = req.model ?? BACKSTAGE_CC_MODEL
  if (!req.omitModel) assertSafeValue('model', model)
  const args = [
    '-p',
    // FB02 F1: 逐次イベント取得のため stream-json 化。`-p` 併用時 `--verbose` 必須（実測 exit 1）。
    '--output-format=stream-json',
    '--verbose',
    ...(req.omitModel ? [] : [`--model=${model}`]),
    // FB01: 空文字の「独立引数」は PowerShell/cmd シム経路で脱落する（実測）。空値は equals-form で表現する。
    '--setting-sources=',
    '--strict-mcp-config',
    '--no-session-persistence',
    `--max-budget-usd=${req.maxBudgetUsd ?? BACKSTAGE_CC_MAX_BUDGET_USD}`
  ]
  if (req.allowedTools && req.allowedTools.length > 0) {
    const csv = req.allowedTools.join(',')
    assertSafeValue('allowedTools', csv)
    args.push(`--tools=${csv}`, `--allowedTools=${csv}`)
  } else {
    args.push('--tools=')
  }
  // L0_011: 任意項目。渡されたときだけ末尾へ足す（渡さなければ従来の出力と同じ）
  if (req.settingsPath !== undefined) {
    const p = req.settingsPath.replace(/\\/g, '/')
    assertSafeValue('settingsPath', p)
    args.push(`--settings=${p}`)
  }
  if (req.permissionMode !== undefined) {
    assertSafeValue('permissionMode', req.permissionMode)
    args.push(`--permission-mode=${req.permissionMode}`)
  }
  return args
}

/**
 * FB01: shell:true（cmd ラッパー）配下の node を含めて確実に殺す tree-kill。
 * marshalLauncher.ts / pxpipeProxy.ts の既存イディオムと同型。
 */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    try {
      const tk = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      // FB01内部レビュー: 'error' リスナー不在の非同期 spawn 失敗（ENOENT等）は
      // uncaughtException になる。同型元と同じく child.kill() へフォールバックし、
      // taskkill 非0終了（アクセス拒否等）時のゾンビ残置も塞ぐ。
      tk.on('error', () => {
        try {
          child.kill()
        } catch {
          /* best-effort */
        }
      })
      tk.on('close', (code) => {
        if (code !== 0) {
          try {
            child.kill()
          } catch {
            /* best-effort */
          }
        }
      })
      return
    } catch {
      /* fallthrough */
    }
  }
  try {
    child.kill()
  } catch {
    /* best-effort */
  }
}

/**
 * FB02: BG-CC 実行本体（常時 hidden・stream-json 逐次解析）。
 * イベント発行の不変条件（テストで固定）:
 * - 最初のイベントは `start`、以降 seq は単調増加。
 * - 終端イベント（`result` か `error`）は spawn 失敗・timeout・close のどの経路でも「ちょうど1回」。
 * - 中間イベントは表示専用で判定に使わない（判定は bgccStream の finalize が一元化）。
 */
export function runBackstageCc(req: BackstageCcRequest): Promise<BackstageCcResult> {
  if (isIsolatedLaunch()) {
    noteBlocked('backstageCc.runBackstageCc')
    return Promise.resolve({ ok: false, error: ISOLATION_BLOCK_REASON, durationMs: 0 })
  }
  const start = Date.now()
  const startedAtIso = new Date().toISOString()
  const runId = randomUUID()
  const model = req.omitModel ? '(CLI 既定)' : (req.model ?? BACKSTAGE_CC_MODEL)
  let seq = 0
  let terminalEmitted = false

  const emit = (
    kind: 'start' | 'assistant' | 'tool' | 'raw_stdout' | 'stderr' | 'result' | 'error',
    text: string,
    meta?: {
      ok?: boolean
      durationMs?: number
      costUsd?: number
      permissionDenied?: boolean
      exitCode?: number | null
      resultEventCount?: number
    }
  ): void => {
    if (terminalEmitted) return
    if (kind === 'result' || kind === 'error') terminalEmitted = true
    if (req.streamToBus === false) return
    emitBgccActivity({
      runId,
      source: req.source,
      seq: seq++,
      ts: new Date().toISOString(),
      kind,
      text: sanitizeEventText(text),
      phase: req.phase,
      trigger: req.trigger,
      ...(meta ? { meta } : {})
    })
  }

  const claudeBin = resolveClaudeBin()
  let args: string[]
  try {
    args = buildBaseArgs(req)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    emit('error', `引数組み立て失敗: ${msg}`, { ok: false })
    return Promise.resolve({ ok: false, error: msg, durationMs: Date.now() - start, runId })
  }

  emit('start', `BG-CC 起動（model=${model}${req.phase ? ` / ${req.phase}` : ''}）`)
  // 生ログは best-effort（内部で fs 失敗を握って no-op 化。run 本体を絶対に壊さない）。
  const log = createRunLogWriter(runId)
  const acc = createStreamJsonAccumulator()

  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    let overflowKilled = false
    let stderrBuf = ''
    let graceTimer: ReturnType<typeof setTimeout> | null = null
    const timeoutMs = req.timeoutMs ?? BACKSTAGE_CC_TIMEOUT_MS

    const finish = (verdict: StreamVerdict, exitCode: number | null): void => {
      if (settled) return
      settled = true
      const durationMs = Date.now() - start
      log.writeMeta({
        runId,
        source: req.source,
        phase: req.phase,
        trigger: req.trigger,
        model,
        startedAt: startedAtIso,
        durationMs,
        exitCode,
        timedOut,
        stderrExcerpt: stderrBuf,
        verdict: {
          ok: verdict.ok,
          error: verdict.error,
          permissionDenied: verdict.permissionDenied,
          resultEventCount: verdict.resultEventCount
        }
      })
      const meta = {
        ok: verdict.ok,
        durationMs,
        costUsd: verdict.costUsd,
        permissionDenied: verdict.permissionDenied,
        exitCode,
        resultEventCount: verdict.resultEventCount
      }
      if (verdict.ok) {
        const cost = verdict.costUsd !== undefined ? ` / $${verdict.costUsd.toFixed(3)}` : ''
        emit('result', `完了（${(durationMs / 1000).toFixed(1)}s${cost}）`, meta)
      } else {
        emit('error', `失敗: ${verdict.error ?? '不明なエラー'}`, meta)
      }
      resolve({
        ok: verdict.ok,
        resultText: verdict.resultText,
        permissionDenied: verdict.permissionDenied,
        error: verdict.error,
        durationMs,
        runId,
        costUsd: verdict.costUsd
      })
    }

    let child: ChildProcess
    try {
      // FB01: cwd=tmpdir で §3 の cwd 分離を適用（auto-memory は cwd のプロジェクト帰属で注入
      // される — 実測）。prompt は argv でなく stdin 供給。useShell 時は空白入りパス対策の二重引用符。
      const command = claudeBin.useShell ? `"${claudeBin.command}"` : claudeBin.command
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: claudeBin.useShell,
        cwd: req.cwd ?? tmpdir(),
        ...(req.env ? { env: { ...process.env, ...req.env } } : {})
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      finish(acc.finalize({ exitCode: null, timedOut: false, spawnError: msg }), null)
      return
    }

    child.stdin?.on('error', () => {
      /* EPIPE等はclose側で結果化されるため握る */
    })
    child.stdin?.write(req.prompt, 'utf8')
    child.stdin?.end()

    const timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      emit('raw_stdout', `timeout (${timeoutMs}ms) — プロセスを強制終了します`)
      killTree(child)
      // kill 失敗で close が来ない場合の強制決着（通常は close 側が先に finish する）。
      graceTimer = setTimeout(() => {
        finish(acc.finalize({ exitCode: null, timedOut: true }), null)
      }, KILL_GRACE_MS)
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      log.appendStdout(chunk)
      for (const de of acc.feed(chunk)) emit(de.kind, de.text)
      if (acc.overflowed && !overflowKilled) {
        overflowKilled = true
        killTree(child)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled) return
      if (stderrBuf.length < STDERR_CAP_BYTES) {
        const text = chunk.toString('utf8')
        stderrBuf = (stderrBuf + text).slice(0, STDERR_CAP_BYTES)
        // stderr は診断表示のみ（JSON 解析に混ぜない — F3）。
        if (text.trim() !== '') emit('stderr', text.trim())
      }
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      finish(acc.finalize({ exitCode: null, timedOut, spawnError: e.message }), null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      if (settled) return
      for (const de of acc.end()) emit(de.kind, de.text)
      const verdict = acc.finalize({ exitCode: code, timedOut })
      // 失敗時は stderr 先頭を診断として添える（FB01 の同挙動を継承）。
      if (verdict.error && stderrBuf.trim()) {
        verdict.error += `; stderr: ${stderrBuf.trim().slice(0, 200)}`
      }
      finish(verdict, code)
    })
  })
}
