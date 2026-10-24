/**
 * composeHash — 合成ルート（compose*.ts）が共有する指紋の規則（葉モジュール。他の compose モジュールにも
 * goldenPromotion にも依存しない。循環 import を避けるため、`goldenPromotion.computeGoldenContentHash` と同じ規則を
 * ここへ写している。写しがずれないよう `composeHash.test.ts` が両者の一致を固定する）。
 *
 * 規則（契約ツールと鏡写し）:
 * - `.md` と `.json` は CRLF→LF にそろえてから sha256（latin1 経由）
 * - それ以外（.cjs・.js・.sh・バイナリ等）は生バイトの sha256
 */

import { createHash } from 'node:crypto'

export function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256')
    .update(typeof buf === 'string' ? Buffer.from(buf, 'utf-8') : buf)
    .digest('hex')
    .toLowerCase()
}

function isEolNormalized(relPath: string): boolean {
  return /\.(md|json)$/i.test(relPath)
}

/** golden に書かれるバイト（テキストは LF）にそろえた sha256。改行だけが違うファイルは同じ値になる */
export function contentHash(relPath: string, buf: Buffer): string {
  if (isEolNormalized(relPath)) {
    return sha256Hex(Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1'))
  }
  return sha256Hex(buf)
}

/** 文字列の中身を LF にそろえて改行で区切った行の列にする（末尾の空行 1 つは落とす） */
export function toLines(text: string): string[] {
  const lf = text.replace(/\r\n/g, '\n')
  const lines = lf.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}
