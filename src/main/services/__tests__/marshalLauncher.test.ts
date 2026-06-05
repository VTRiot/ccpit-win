import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  compareSemver,
  resolveCompanion,
  sha256File,
  loadPinStore,
  loadPinStoreStrict,
  savePinStore,
  checkIntegrity,
  validateReviewSchema,
  extractResult,
  nextReviewIndex,
  persistReview,
  runMarshalReview,
  makeDefaultSpawn
} from '../marshalLauncher'

let TMP: string
beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'ccpit-marshal-'))
})
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
})

function makeCompanion(cacheDir: string, version: string, body = "console.log('x')"): string {
  const dir = join(cacheDir, version, 'scripts')
  mkdirSync(dir, { recursive: true })
  const entry = join(dir, 'codex-companion.mjs')
  writeFileSync(entry, body, 'utf-8')
  return entry
}

const VALID_RESULT = {
  verdict: 'needs-attention',
  summary: 's',
  findings: [{ severity: 'high', title: 't' }]
}
const VALID_STDOUT = JSON.stringify({ result: VALID_RESULT, rawOutput: '{}' })

describe('compareSemver', () => {
  it('数値順で比較', () => {
    expect(compareSemver('1.0.4', '1.0.3')).toBeGreaterThan(0)
    expect(compareSemver('1.0.3', '1.0.10')).toBeLessThan(0)
    expect(compareSemver('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0)
  })
  it('prerelease は無視', () => {
    expect(compareSemver('1.0.4-beta', '1.0.4')).toBe(0)
  })
})

describe('resolveCompanion (semver 最大解決)', () => {
  it('不在ディレクトリは null（＝absence）', () => {
    expect(resolveCompanion(join(TMP, 'nope'))).toBeNull()
  })
  it('version 無しは null', () => {
    mkdirSync(join(TMP, 'codex'), { recursive: true })
    expect(resolveCompanion(join(TMP, 'codex'))).toBeNull()
  })
  it('複数版から最大を選ぶ', () => {
    const cache = join(TMP, 'codex')
    makeCompanion(cache, '1.0.3')
    makeCompanion(cache, '1.0.10')
    makeCompanion(cache, '1.0.4')
    const r = resolveCompanion(cache)
    expect(r?.version).toBe('1.0.10')
  })
  it('最大版に entry が無ければ次点へフォールバック', () => {
    const cache = join(TMP, 'codex')
    makeCompanion(cache, '1.0.4')
    mkdirSync(join(cache, '2.0.0', 'scripts'), { recursive: true }) // entry 無し
    const r = resolveCompanion(cache)
    expect(r?.version).toBe('1.0.4')
  })
})

describe('sha256File + integrity (TOFU)', () => {
  it('同内容は同 hash、異内容は別 hash', () => {
    const a = join(TMP, 'a')
    writeFileSync(a, 'hello')
    const b = join(TMP, 'b')
    writeFileSync(b, 'hello')
    const c = join(TMP, 'c')
    writeFileSync(c, 'world')
    expect(sha256File(a)).toBe(sha256File(b))
    expect(sha256File(a)).not.toBe(sha256File(c))
    expect(sha256File(a)).toMatch(/^[0-9a-f]{64}$/)
  })
  const HEX_A = 'a'.repeat(64)
  const HEX_B = 'b'.repeat(64)
  it('pin 未記録は firstUse=ok / 一致は ok / 不一致は fail-closed', () => {
    expect(checkIntegrity('1.0.4', HEX_A, {})).toEqual({ ok: true, firstUse: true })
    expect(checkIntegrity('1.0.4', HEX_A, { '1.0.4': HEX_A }).ok).toBe(true)
    const mismatch = checkIntegrity('1.0.4', HEX_A, { '1.0.4': HEX_B })
    expect(mismatch.ok).toBe(false)
    expect(mismatch.reason).toContain('mismatch')
  })
  it('pin store の保存と読込（atomic）', () => {
    const p = join(TMP, '.ccpit', 'pin.json')
    savePinStore(p, { '1.0.4': HEX_A })
    expect(loadPinStore(p)).toEqual({ '1.0.4': HEX_A })
    expect(loadPinStore(join(TMP, 'missing.json'))).toEqual({})
  })
  it('strict: 不在は store:{}、破損は error（不在と破損を区別 F1）', () => {
    expect(loadPinStoreStrict(join(TMP, 'missing.json'))).toEqual({ store: {} })
    const bad = join(TMP, 'bad.json')
    writeFileSync(bad, '{ not json')
    expect('error' in loadPinStoreStrict(bad)).toBe(true)
    const arr = join(TMP, 'arr.json')
    writeFileSync(arr, '[1,2,3]')
    expect('error' in loadPinStoreStrict(arr)).toBe(true)
  })
})

describe('validateReviewSchema', () => {
  it('正常は ok', () => {
    expect(validateReviewSchema(VALID_RESULT).ok).toBe(true)
  })
  it('verdict 欠落は fail', () => {
    expect(validateReviewSchema({ summary: 's', findings: [] }).ok).toBe(false)
  })
  it('findings 非配列は fail', () => {
    expect(validateReviewSchema({ verdict: 'v', summary: 's', findings: {} }).ok).toBe(false)
  })
  it('非オブジェクトは fail', () => {
    expect(validateReviewSchema(null).ok).toBe(false)
    expect(validateReviewSchema('x').ok).toBe(false)
  })
  it('findings 要素が非オブジェクトは fail（F4）', () => {
    expect(validateReviewSchema({ verdict: 'v', summary: 's', findings: ['x'] }).ok).toBe(false)
  })
  it('findings 要素の severity/title 欠落は fail（F4）', () => {
    expect(
      validateReviewSchema({ verdict: 'v', summary: 's', findings: [{ title: 't' }] }).ok
    ).toBe(false)
    expect(
      validateReviewSchema({ verdict: 'v', summary: 's', findings: [{ severity: 'high' }] }).ok
    ).toBe(false)
  })
  it('空 findings は ok（クリーンレビュー）', () => {
    expect(validateReviewSchema({ verdict: 'pass', summary: 's', findings: [] }).ok).toBe(true)
  })
})

describe('extractResult', () => {
  it('result ラッパから抽出', () => {
    expect(extractResult(VALID_STDOUT)?.verdict).toBe('needs-attention')
  })
  it('verdict を持つ素のオブジェクトも可', () => {
    expect(extractResult(JSON.stringify(VALID_RESULT))?.verdict).toBe('needs-attention')
  })
  it('先頭ログ混在でも抽出', () => {
    expect(extractResult('LOG line\n' + VALID_STDOUT)?.verdict).toBe('needs-attention')
  })
  it('JSON でなければ null', () => {
    expect(extractResult('not json at all')).toBeNull()
  })
})

describe('nextReviewIndex + persistReview', () => {
  it('連番が 01 から増える', () => {
    const dir = join(TMP, 'out')
    expect(nextReviewIndex(dir)).toBe(1)
    const r1 = persistReview(dir, VALID_STDOUT, {
      version: '1.0.4',
      hash: 'h',
      entry: 'e',
      scope: 'auto',
      focus: 'f',
      timestamp: '2026-05-31T00:00:00Z'
    })
    expect(r1.index).toBe(1)
    expect(existsSync(r1.rawPath)).toBe(true)
    expect(existsSync(r1.metaPath)).toBe(true)
    expect(nextReviewIndex(dir)).toBe(2)
    const r2 = persistReview(dir, VALID_STDOUT, {
      version: '1.0.4',
      hash: 'h',
      entry: 'e',
      scope: 'auto',
      focus: 'f',
      timestamp: '2026-05-31T00:01:00Z'
    })
    expect(r2.index).toBe(2)
    const meta = JSON.parse(readFileSync(r2.metaPath, 'utf-8'))
    expect(meta.version).toBe('1.0.4')
    expect(meta.hash).toBe('h')
    expect(meta.index).toBe(2)
  })
})

describe('runMarshalReview (orchestration, spawn 注入)', () => {
  function setup(): { cache: string; out: string; pin: string; entry: string } {
    const cache = join(TMP, 'codex')
    const entry = makeCompanion(cache, '1.0.4', 'companion-body')
    return { cache, out: join(TMP, 'reports'), pin: join(TMP, '.ccpit', 'pin.json'), entry }
  }

  it('companion 不在は status=absent（エラーではない）', async () => {
    const r = await runMarshalReview({
      scope: 'auto',
      focus: 'f',
      outDir: join(TMP, 'reports'),
      timestamp: 't',
      codexCacheDir: join(TMP, 'nope'),
      pinPath: join(TMP, 'pin.json'),
      spawnFn: async () => ({ status: 0, stdout: VALID_STDOUT, stderr: '' })
    })
    expect(r.status).toBe('absent')
  })

  const okSpawn = (stdout: string) => async () => ({ status: 0, stdout, stderr: '' })

  it('正常系: pin 記録 + raw/meta 保全 + result 返却', async () => {
    const { cache, out, pin } = setup()
    let calledWith: string[] = []
    const r = await runMarshalReview({
      scope: 'auto',
      focus: 'my focus',
      outDir: out,
      timestamp: '2026-05-31T00:00:00Z',
      codexCacheDir: cache,
      pinPath: pin,
      spawnFn: async (_e, args) => {
        calledWith = args
        return { status: 0, stdout: VALID_STDOUT, stderr: '' }
      }
    })
    expect(r.status).toBe('ok')
    expect(r.result?.verdict).toBe('needs-attention')
    expect(existsSync(r.rawPath!)).toBe(true)
    expect(existsSync(r.metaPath!)).toBe(true)
    expect(calledWith).toEqual([
      'adversarial-review',
      '--wait',
      '--json',
      '--scope',
      'auto',
      'my focus'
    ])
    expect(loadPinStore(pin)['1.0.4']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('2 回目は記録済み pin と一致して ok（TOFU 後の照合）', async () => {
    const { cache, out, pin } = setup()
    const opts = {
      scope: 'auto',
      focus: 'f',
      outDir: out,
      timestamp: 't',
      codexCacheDir: cache,
      pinPath: pin,
      spawnFn: okSpawn(VALID_STDOUT)
    }
    expect((await runMarshalReview(opts)).status).toBe('ok')
    expect((await runMarshalReview(opts)).status).toBe('ok')
  })

  it('integrity_failure: pin 不一致は fail-closed（result 無し・保全しない）', async () => {
    const { cache, out, pin } = setup()
    savePinStore(pin, { '1.0.4': 'a'.repeat(64) }) // 有効形式だが別 hash
    const r = await runMarshalReview({
      scope: 'auto',
      focus: 'f',
      outDir: out,
      timestamp: 't',
      codexCacheDir: cache,
      pinPath: pin,
      spawnFn: okSpawn(VALID_STDOUT)
    })
    expect(r.status).toBe('integrity_failure')
    expect(r.result).toBeUndefined()
    expect(existsSync(out)).toBe(false)
  })

  it('integrity_failure: pin store 破損は fail-closed（不在 TOFU と区別 F1）', async () => {
    const { cache, out, pin } = setup()
    mkdirSync(join(pin, '..'), { recursive: true })
    writeFileSync(pin, '{ corrupt')
    const r = await runMarshalReview({
      scope: 'auto',
      focus: 'f',
      outDir: out,
      timestamp: 't',
      codexCacheDir: cache,
      pinPath: pin,
      spawnFn: okSpawn(VALID_STDOUT)
    })
    expect(r.status).toBe('integrity_failure')
    expect(existsSync(out)).toBe(false)
  })

  it('integrity_failure: pin 値が空文字/null は TOFU に化けず fail-closed（F1 round2）', async () => {
    for (const bad of ['{"1.0.4":""}', '{"1.0.4":null}', '{"1.0.4":false}', '{"1.0.4":"xyz"}']) {
      const { cache, out, pin } = setup()
      mkdirSync(join(pin, '..'), { recursive: true })
      writeFileSync(pin, bad)
      const r = await runMarshalReview({
        scope: 'auto',
        focus: 'f',
        outDir: out,
        timestamp: 't',
        codexCacheDir: cache,
        pinPath: pin,
        spawnFn: okSpawn(VALID_STDOUT)
      })
      expect(r.status, `pin=${bad}`).toBe('integrity_failure')
      expect(existsSync(out)).toBe(false)
    }
  })

  it('版置換: 既存 pin あり + 未登録の高版投入は fail-closed（自動信頼しない、F round5）', async () => {
    const { cache, out, pin } = setup() // 1.0.4
    // 1.0.4 を正規 enrollment（bootstrap）
    await runMarshalReview({
      scope: 'auto',
      focus: 'f',
      outDir: out,
      timestamp: 't',
      codexCacheDir: cache,
      pinPath: pin,
      spawnFn: okSpawn(VALID_STDOUT)
    })
    // 攻撃: 別 body の高版 999.0.0 を投入
    makeCompanion(cache, '999.0.0', 'malicious-body')
    const r = await runMarshalReview({
      scope: 'auto',
      focus: 'f',
      outDir: out,
      timestamp: 't',
      codexCacheDir: cache,
      pinPath: pin,
      spawnFn: okSpawn(VALID_STDOUT)
    })
    expect(r.status).toBe('integrity_failure')
    expect(r.version).toBe('999.0.0')
    // 新版が pin に保存されていない（自動信頼していない）
    expect(loadPinStore(pin)['999.0.0']).toBeUndefined()
  })

  it('enrollNewVersions:true なら明示信頼フローで新版を登録実行', async () => {
    const { cache, out, pin } = setup()
    await runMarshalReview({
      scope: 'auto',
      focus: 'f',
      outDir: out,
      timestamp: 't',
      codexCacheDir: cache,
      pinPath: pin,
      spawnFn: okSpawn(VALID_STDOUT)
    })
    makeCompanion(cache, '999.0.0', 'new-legit-body')
    const r = await runMarshalReview({
      scope: 'auto',
      focus: 'f',
      outDir: out,
      timestamp: 't',
      codexCacheDir: cache,
      pinPath: pin,
      enrollNewVersions: true,
      spawnFn: okSpawn(VALID_STDOUT)
    })
    expect(r.status).toBe('ok')
    expect(loadPinStore(pin)['999.0.0']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('schema_failure: 不正出力は fail-closed', async () => {
    const { cache, out, pin } = setup()
    const r = await runMarshalReview({
      scope: 'auto',
      focus: 'f',
      outDir: out,
      timestamp: 't',
      codexCacheDir: cache,
      pinPath: pin,
      spawnFn: okSpawn(JSON.stringify({ result: { summary: 'no verdict' } }))
    })
    expect(r.status).toBe('schema_failure')
    expect(r.result).toBeUndefined()
  })

  it('spawn_failure: 非ゼロ終了は fail-closed', async () => {
    const { cache, out, pin } = setup()
    const r = await runMarshalReview({
      scope: 'auto',
      focus: 'f',
      outDir: out,
      timestamp: 't',
      codexCacheDir: cache,
      pinPath: pin,
      spawnFn: async () => ({ status: 1, stdout: '', stderr: 'boom' })
    })
    expect(r.status).toBe('spawn_failure')
    expect(r.reason).toContain('boom')
  })

  it('parse_failure: JSON でない stdout は fail-closed', async () => {
    const { cache, out, pin } = setup()
    const r = await runMarshalReview({
      scope: 'auto',
      focus: 'f',
      outDir: out,
      timestamp: 't',
      codexCacheDir: cache,
      pinPath: pin,
      spawnFn: okSpawn('garbage output')
    })
    expect(r.status).toBe('parse_failure')
  })
})

describe('makeDefaultSpawn（実 spawn・プロセスツリー cleanup F2 round3）', () => {
  it('timeout で孫プロセスごと kill し close を待って resolve', async () => {
    const script = join(TMP, 'tree.mjs')
    const pidFile = join(TMP, 'gc.pid')
    writeFileSync(
      script,
      [
        "import { spawn } from 'child_process'",
        "import { writeFileSync } from 'fs'",
        "const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{},100000)'], { stdio: 'ignore' })",
        'writeFileSync(process.argv[2], String(gc.pid))',
        'setInterval(() => {}, 100000)'
      ].join('\n')
    )
    const spawnFn = makeDefaultSpawn(600)
    const start = Date.now()
    const r = await spawnFn(script, [pidFile])
    const elapsed = Date.now() - start
    // timeout で status=null、30s 完走でなく速やかに終了
    expect(r.status).toBeNull()
    expect(r.stderr).toContain('timeout')
    expect(elapsed).toBeLessThan(8000)
    // resolve 時点で孫プロセスは既に dead（gate は cleanup 完了まで維持された＝早期解放でない、round4）
    const gcPid = parseInt(readFileSync(pidFile, 'utf-8'), 10)
    let alive = true
    try {
      process.kill(gcPid, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  }, 20000)
})
