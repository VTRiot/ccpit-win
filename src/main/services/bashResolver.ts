/**
 * bashResolver — hook の exec form 起動に使う bash.exe 実体パスを解決する
 * （起動形不一致 order で master 正取込）。
 *
 * 背景（Phase 0 V1 実機実証）: 端末起動 Windows CC では bare `.sh` hook が PowerShell
 * ParserError / ファイル関連付けで不発、`shell:"bash"` も「Git Bash not found」で失敗する。
 * exec form `{"command":"<bash 実体パス>","args":["<script 絶対パス>", ...]}` だけが確実に発火する。
 * よって golden deploy 時に bash.exe の実体パスを解決して settings.json に焼き込む。
 *
 * 解決失敗は呼び出し側（deploy / health）で surface する（Codex #8: silent fallback 禁止）。
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { whichExe } from './ccLaunch'

export interface BashResolution {
  /** bash.exe の絶対パス。解決不能なら null */
  path: string | null
  /** 解決元（scoop-git-current / git-for-windows / path / none） */
  source: string
}

/**
 * 候補リストから最初に存在するものを選ぶ純関数（テスト用に exists を注入可能）。
 */
export function pickBash(
  candidates: { path: string; source: string }[],
  exists: (p: string) => boolean
): BashResolution {
  for (const c of candidates) {
    if (exists(c.path)) return { path: c.path, source: c.source }
  }
  return { path: null, source: 'none' }
}

/** win32 の bash.exe 候補（優先順）。scoop git → Git for Windows。 */
export function win32BashCandidates(home: string): { path: string; source: string }[] {
  return [
    { path: join(home, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'), source: 'scoop-git-current' },
    { path: 'C:\\Program Files\\Git\\bin\\bash.exe', source: 'git-for-windows' },
    { path: 'C:\\Program Files\\Git\\usr\\bin\\bash.exe', source: 'git-for-windows-usr' },
    { path: 'C:\\Program Files (x86)\\Git\\bin\\bash.exe', source: 'git-for-windows-x86' }
  ]
}

/**
 * bash.exe を解決する。win32 は既知の候補パス（scoop git → Git for Windows）**のみ**。
 * POSIX は PATH の bash（Git Bash 概念が無く PATH の bash が正当）。
 *
 * win32 で PATH フォールバックを置かない理由（Codex 実装レビュー [high]#1）:
 * PATH 上の bash.exe は WSL ランチャ（C:\Windows\System32）・Cygwin・MSYS 等の非 Git Bash であり得、
 * それを settings.json に焼き込むと deploy 成功・health 緑のまま hook が誤環境で不発になる
 * （$HOME/.claude/... が解決できない）= green-but-dead。既知パスに無ければ path:null を返し、
 * deploy 側が fail-closed（中止＋Git for Windows / scoop git の導入案内）で受ける。
 */
export function resolveBashBin(): BashResolution {
  if (process.platform !== 'win32') {
    const bare = whichExe('bash')
    return { path: bare, source: bare ? 'path' : 'none' }
  }
  return pickBash(win32BashCandidates(homedir()), existsSync)
}

/** C:\Windows\System32\ 配下の bash.exe（WSL ランチャ）を判定する。Git Bash はここに置かれない。 */
export function isWslLauncher(p: string): boolean {
  return /[\\/]windows[\\/]system32[\\/]/i.test(p)
}

/**
 * settings.json hooks の exec form `command:"bash"` を解決済み bash 実体パスへ注入する（in-place）。
 * 起動形 order: 端末 Windows CC は bare `bash` を「Git Bash not found」で解決できないため、deploy 時に
 * 実体パスを焼き込む（46fc171 Phase 0 V1）。既に full-path の command（実機由来）は 'bash' と一致しない
 * ため二重注入されない。args の `$HOME/...` は bash 自身が展開するので変換不要（runner 非依存）。
 * electron 非依存の純関数として export しテスト可能にする（golden.ts deploy が呼ぶ）。
 */
export function injectResolvedBash(hooksSection: unknown, bashPath: string): void {
  if (!hooksSection || typeof hooksSection !== 'object') return
  for (const ev of Object.keys(hooksSection as Record<string, unknown>)) {
    const groups = (hooksSection as Record<string, unknown>)[ev]
    if (!Array.isArray(groups)) continue
    for (const grp of groups) {
      const hooks = (grp as { hooks?: unknown })?.hooks
      if (!Array.isArray(hooks)) continue
      for (const h of hooks) {
        const hk = h as { type?: unknown; command?: unknown }
        if (hk && hk.type === 'command' && hk.command === 'bash') hk.command = bashPath
      }
    }
  }
}
