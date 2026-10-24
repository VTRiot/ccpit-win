/**
 * atomicFile — 同一ディレクトリの一時ファイルへ書いてから `rename` で差し替える共有ヘルパー。
 *
 * `goldenManifest.ts` の private `writeFileAtomic` をそのまま抽出したもの（挙動不変のリファクタ）。
 * 直接 `writeFile` すると、ENOSPC・権限変更・プロセス終了で中途半端な内容の実体が残りうる。
 * `rename` は同一ボリューム内で原子的（Windows でも既存を置換する）ため、
 * 観測されるのは「旧内容」か「新内容」のどちらかだけになる。
 * 失敗時は一時ファイルを掃除し、元の実体には触れないまま例外を投げる。
 */

import { readFile, open, mkdir, rm, rename } from 'fs/promises'
import { dirname } from 'path'

export async function writeFileAtomic(
  targetPath: string,
  data: Buffer | string,
  options?: { beforeRename?: () => Promise<void> | void }
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true })
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  try {
    const handle = await open(tmpPath, 'w')
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (options?.beforeRename) {
      await options.beforeRename()
    }
    await rename(tmpPath, targetPath)
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * JSON 配列ファイルを atomic に書く。書込後に読み直して `JSON.parse` で検証する。
 *
 * この検証は「自分が `JSON.stringify` した内容が壊れている」ことを検出するのではない
 * （`JSON.stringify` は循環参照が無ければ常に valid JSON を返すため、その種の不整合は
 * 書込前の `JSON.stringify` 自体が例外を投げて防ぐ）。書込/rename 時点でのディスク破損
 * （途中切断等）を事後検出するための安全網であり、失敗時はロールバックを試みず
 * （試みると別の不整合を生みうる）、呼び出し側へそのまま例外を伝える。
 */
export async function writeJsonArrayAtomic(targetPath: string, arr: unknown[]): Promise<void> {
  const serialized = JSON.stringify(arr, null, 2)
  await writeFileAtomic(targetPath, serialized)
  const verify = await readFile(targetPath, 'utf-8')
  const parsed: unknown = JSON.parse(verify)
  if (!Array.isArray(parsed)) {
    throw new Error(`writeJsonArrayAtomic: post-write verification failed, not an array: ${targetPath}`)
  }
}
