/**
 * composeHeadlessLaunch — 合成の改訂 AI を、窓を出さずに起動する（CCPIT_L0_011 W2「改訂 AI は窓を出さない」）。
 *
 * 最初の合成は従来どおり可視の窓（launchCc）。改訂の巡だけ、既存の `runBackstageCc`（hidden・stream-json）に
 * 作業場の cwd・作業場の権限設定・acceptEdits・読み書き系のツールだけを渡して `claude -p` を動かす。
 * 範囲外への書込みは従来どおり作業場の権限規則（settings.json）と、finalize の目録の検査が止める。
 * 隔離起動では runBackstageCc 自体が止まる（既存）ので、ここでは別に止めない。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  COMPOSE_REVISE_MAX_BUDGET_USD,
  COMPOSE_REVISE_TIMEOUT_MS
} from '../../shared/composeContract'
import { runBackstageCc, type BackstageCcResult } from './backstageCc'

/** 改訂 AI に許す道具。作業場の中の読み書きだけ（Bash・Web・MCP は渡さない） */
export const COMPOSE_REVISE_ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'] as const
/** 作業場の設定ファイルの相対パス（startCompose が `.claude/settings.local.json` に書く権限規則とは別に、起動時に渡す） */
export const COMPOSE_WORKSPACE_SETTINGS_REL = '.claude/settings.json'
/** BG-CC のアクティビティ表示の帰属 */
export const COMPOSE_REVISION_SOURCE = 'composeRevision'

export interface StartComposeRevisionHeadlessArgs {
  workspaceDir: string
  /** 依頼文（stdin で渡る） */
  promptText: string
  /** 合成の設定のモデル。無ければモデル指定を付けず CLI の既定に任せる */
  model?: string
  /** pxpipe の環境変数など。process.env に重ねる */
  extraEnv?: Record<string, string>
  /**
   * 渡す設定ファイル。既定は <workspaceDir>/.claude/settings.json。
   * 注意: startCompose が権限規則を書くのは settings.local.json（--setting-sources= が空の本実行では読まれない）。
   * 統合側が規則の入ったファイルを指すか、settings.json を書くかを決める（申し送り）。
   */
  settingsPath?: string
  /** 試験用の差し込み口（既定は runBackstageCc） */
  run?: typeof runBackstageCc
}

export type StartComposeRevisionHeadlessResult =
  | { started: true; done: Promise<BackstageCcResult> }
  | { started: false; error: string }

export function startComposeRevisionHeadless(
  args: StartComposeRevisionHeadlessArgs
): StartComposeRevisionHeadlessResult {
  const settingsPath = args.settingsPath ?? join(args.workspaceDir, COMPOSE_WORKSPACE_SETTINGS_REL)
  if (!existsSync(settingsPath)) {
    return {
      started: false,
      error: `作業場の設定ファイルが無いため、改訂 AI を起動しません: ${settingsPath.replace(/\\/g, '/')}`
    }
  }
  const run = args.run ?? runBackstageCc
  const done = run({
    prompt: args.promptText,
    cwd: args.workspaceDir,
    settingsPath,
    permissionMode: 'acceptEdits',
    allowedTools: [...COMPOSE_REVISE_ALLOWED_TOOLS],
    ...(args.model ? { model: args.model } : { omitModel: true }),
    ...(args.extraEnv ? { env: args.extraEnv } : {}),
    timeoutMs: COMPOSE_REVISE_TIMEOUT_MS,
    maxBudgetUsd: COMPOSE_REVISE_MAX_BUDGET_USD,
    source: COMPOSE_REVISION_SOURCE
  })
  return { started: true, done }
}
