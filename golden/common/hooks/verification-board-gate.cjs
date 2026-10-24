'use strict'
// 入口の殻。実体の読み込み・実行に失敗しても（欠落・構文エラー・例外）、標準入力を読み捨てて無出力・終了コード 0。
// 出力は main() が返した Buffer を、成功した後に 1 回だけ書く（途中まで書いてから例外、を作らない）。
const fs = require('fs')
function drain(io) {
  const readSync = (io && io.readSync) || ((b) => fs.readSync(0, b, 0, b.length, null))
  const now = (io && io.now) || Date.now
  const sleep = (io && io.sleep) || ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms))
  const buf = Buffer.alloc(1 << 16)
  const until = now() + 5000 // hook の timeout 10 秒の半分
  for (;;) {
    let n
    try {
      n = readSync(buf)
    } catch (e) {
      if (e && e.code === 'EAGAIN' && now() < until) { sleep(5); continue } // busy loop にしない
      break
    }
    if (n === 0) break
  }
}
function run() {
  try {
    const out = require('./verification-board-gate.run.cjs').main()
    if (out && out.length > 0) process.stdout.write(out)
  } catch {
    try { drain() } catch { /* 無視 */ }
  }
  process.exitCode = 0
}
// run は BOOT（.sh の node -e）から呼ぶ。直接起動（node 殻.cjs）でも動く
module.exports = { drain, run }
if (require.main === module) { process.stdout.on('error', () => {}); run() }
// STOPGATE-SHELL-END
