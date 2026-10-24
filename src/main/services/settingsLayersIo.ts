import { readFile } from 'fs/promises'

/**
 * `settings.json` の 2 階建て（L0_013）のファイル読み取り。
 *
 * 本番の配り直しは、計画の時点と書く直前の 2 回、手元の `settings.json` を読む。
 * 2 回目との食い違いで割り込みを見つけるため、読み取りを別モジュールに置き、
 * 試験が 2 回目の直前に割り込めるようにする（同じモジュールの中の呼び出しは差し替えられない）。
 */

/** ファイルの生バイト。無ければ null（それ以外の失敗は投げる） */
export async function readBytesOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw err
  }
}

/** 手元の `~/.claude/settings.json` の生バイト。無ければ null */
export async function readLocalSettingsBytes(path: string): Promise<Buffer | null> {
  return readBytesOrNull(path)
}
