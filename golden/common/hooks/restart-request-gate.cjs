'use strict'
// 入口の殻。実体 restart-request-gate.run.cjs を呼び、返された Buffer を成功した後に 1 回だけ書く（途中まで書いてから例外、を作らない）。
// 入口の .sh の BOOT から run(標準入力のバイト列) で呼ばれる。実体の欠落・構文エラー・例外はここで握りつぶさず BOOT の catch へ伝える
// （BOOT が保持した標準入力で旧の bash 本体を呼び直す＝再起動を促す義務を黙って落とさない）。
// 直接起動（node 殻.cjs）は試験・調査用: 失敗したら標準入力を読み捨てて無出力・終了コード 0。
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
function run(inp) {
  const out = require('./restart-request-gate.run.cjs').main(inp === undefined ? undefined : { input: inp })
  if (out && out.length > 0) process.stdout.write(out)
  process.exitCode = 0
}
module.exports = { drain, run }
if (require.main === module) {
  process.stdout.on('error', () => {})
  try {
    run()
  } catch {
    try { drain() } catch { /* 無視 */ }
    process.exitCode = 0
  }
}
// STOPGATE-SHELL-END
