import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  appendProtocolEntry,
  parseAppliedAtToIso,
} from '../protocolWriter'
import {
  readProtocol,
  readProtocolHistory,
  getLatestManualEntry,
  getCurrentMarker,
  getProtocolFilePath,
} from '../protocolReader'
import type {
  ProtocolMarker,
  ProtocolHistoryEntry,
  ProtocolHistoryFile,
} from '../types'

let workdir: string

beforeEach(async () => {
  workdir = join(
    tmpdir(),
    `ccpit-protocol-history-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await mkdir(workdir, { recursive: true })
})

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true })
})

function makeMarker(overrides: Partial<ProtocolMarker> = {}): ProtocolMarker {
  return {
    protocol: 'manx',
    revision: 'r5',
    stage: 'experimental',
    stage_inferred: false,
    variant: null,
    variant_alias: null,
    applied_at: null,
    applied_by: 'ccpit-1.0.0',
    detection_evidence: null,
    detection_confidence: 'explicit',
    ...overrides,
  }
}

describe('034-B: 不変条件テスト（型 7 違反の物理保証）', () => {
  it('TC-INV-1: appendProtocolEntry 後、過去エントリ全件の marker フィールドが byte-identical で不変', async () => {
    const m1 = makeMarker({ protocol: 'manx', revision: 'r5' })
    const m2 = makeMarker({ protocol: 'legacy', revision: '?' })
    const m3 = makeMarker({ protocol: 'asama', revision: 'r1' })

    await appendProtocolEntry(workdir, 'manual', m1, new Date('2026-05-01T00:00:00Z'))
    await appendProtocolEntry(workdir, 'auto', m2, new Date('2026-05-02T00:00:00Z'))
    await appendProtocolEntry(workdir, 'manual', m3, new Date('2026-05-03T00:00:00Z'))

    const history = await readProtocolHistory(workdir)
    expect(history).not.toBeNull()
    expect(history!.length).toBe(3)
    // 過去エントリの marker が完全に保存されている
    expect(history![0].marker).toEqual(m1)
    expect(history![1].marker).toEqual(m2)
    expect(history![2].marker).toEqual(m3)
    // source も保持
    expect(history![0].source).toBe('manual')
    expect(history![1].source).toBe('auto')
    expect(history![2].source).toBe('manual')
  })

  it('TC-INV-2: appendProtocolEntry を N 回呼んだ後、history.length === N（重複削除されない）', async () => {
    for (let i = 0; i < 10; i++) {
      await appendProtocolEntry(workdir, 'auto', makeMarker(), new Date(2026, 4, 1, 0, i))
    }
    const history = await readProtocolHistory(workdir)
    expect(history!.length).toBe(10)
  })

  it('TC-INV-3: 同じ marker を 3 回 append しても 3 エントリ保持される', async () => {
    const m = makeMarker()
    await appendProtocolEntry(workdir, 'manual', m, new Date('2026-05-01T00:00:00Z'))
    await appendProtocolEntry(workdir, 'manual', m, new Date('2026-05-02T00:00:00Z'))
    await appendProtocolEntry(workdir, 'manual', m, new Date('2026-05-03T00:00:00Z'))
    const history = await readProtocolHistory(workdir)
    expect(history!.length).toBe(3)
  })

  it('TC-INV-4: getCurrentMarker は manual を auto より優先する', () => {
    const manual1 = makeMarker({ protocol: 'manx' })
    const auto1 = makeMarker({ protocol: 'legacy' })
    const auto2 = makeMarker({ protocol: 'unknown' })
    const history: ProtocolHistoryEntry[] = [
      { timestamp: '2026-05-01T00:00:00.000Z', source: 'auto', app_version: 'v', marker: auto1 },
      { timestamp: '2026-05-02T00:00:00.000Z', source: 'manual', app_version: 'v', marker: manual1 },
      { timestamp: '2026-05-03T00:00:00.000Z', source: 'auto', app_version: 'v', marker: auto2 },
    ]
    const current = getCurrentMarker(history)
    expect(current).toEqual(manual1)
    expect(current!.protocol).toBe('manx')
  })

  it('TC-INV-5: history が空なら getCurrentMarker は null', () => {
    expect(getCurrentMarker([])).toBeNull()
  })
})

describe('034-B: derived ロジックテスト', () => {
  it('TC-DER-1: history=[manual A, auto B] → manual A', () => {
    const a = makeMarker({ protocol: 'manx' })
    const b = makeMarker({ protocol: 'legacy' })
    const history: ProtocolHistoryEntry[] = [
      { timestamp: '2026-05-01T00:00:00.000Z', source: 'manual', app_version: 'v', marker: a },
      { timestamp: '2026-05-02T00:00:00.000Z', source: 'auto', app_version: 'v', marker: b },
    ]
    expect(getCurrentMarker(history)).toEqual(a)
  })

  it('TC-DER-2: history=[auto A, manual B, auto C] → manual B', () => {
    const a = makeMarker({ protocol: 'unknown' })
    const b = makeMarker({ protocol: 'manx' })
    const c = makeMarker({ protocol: 'legacy' })
    const history: ProtocolHistoryEntry[] = [
      { timestamp: '2026-05-01T00:00:00.000Z', source: 'auto', app_version: 'v', marker: a },
      { timestamp: '2026-05-02T00:00:00.000Z', source: 'manual', app_version: 'v', marker: b },
      { timestamp: '2026-05-03T00:00:00.000Z', source: 'auto', app_version: 'v', marker: c },
    ]
    expect(getCurrentMarker(history)).toEqual(b)
  })

  it('TC-DER-3: history=[auto A, auto B] → auto B（最新 auto）', () => {
    const a = makeMarker({ protocol: 'unknown', revision: 'r1' })
    const b = makeMarker({ protocol: 'legacy', revision: 'r2' })
    const history: ProtocolHistoryEntry[] = [
      { timestamp: '2026-05-01T00:00:00.000Z', source: 'auto', app_version: 'v', marker: a },
      { timestamp: '2026-05-02T00:00:00.000Z', source: 'auto', app_version: 'v', marker: b },
    ]
    expect(getCurrentMarker(history)).toEqual(b)
  })
})

describe('034-B: readProtocol の v1/v2 両対応', () => {
  it('TC-COMPAT-1: v2 形式から readProtocol が getCurrentMarker と同じ値を返す', async () => {
    const m1 = makeMarker({ protocol: 'manx' })
    const m2 = makeMarker({ protocol: 'legacy' })
    await appendProtocolEntry(workdir, 'manual', m1, new Date('2026-05-01T00:00:00Z'))
    await appendProtocolEntry(workdir, 'auto', m2, new Date('2026-05-02T00:00:00Z'))

    const current = await readProtocol(workdir)
    expect(current).toEqual(m1) // manual 優先
  })

  it('TC-COMPAT-2: v1 (旧フラット) 形式の protocol.json を直接読む（後方互換）', async () => {
    // 手動で v1 形式のファイルを作成
    const v1Marker = makeMarker({ protocol: 'manx', revision: 'r5' })
    const ccpitDir = join(workdir, '.ccpit')
    await mkdir(ccpitDir, { recursive: true })
    await writeFile(getProtocolFilePath(workdir), JSON.stringify(v1Marker, null, 2), 'utf-8')

    const result = await readProtocol(workdir)
    expect(result).toEqual(v1Marker)
  })

  it('TC-COMPAT-3: v1 形式から appendProtocolEntry を呼ぶと v2 に in-place 変換される', async () => {
    const v1Marker = makeMarker({
      protocol: 'manx',
      revision: 'r5',
      detection_confidence: 'explicit',
    })
    const ccpitDir = join(workdir, '.ccpit')
    await mkdir(ccpitDir, { recursive: true })
    await writeFile(getProtocolFilePath(workdir), JSON.stringify(v1Marker, null, 2), 'utf-8')

    const newMarker = makeMarker({ protocol: 'asama', revision: 'r1' })
    await appendProtocolEntry(workdir, 'auto', newMarker, new Date('2026-05-04T00:00:00Z'))

    const fileContent = await readFile(getProtocolFilePath(workdir), 'utf-8')
    const parsed = JSON.parse(fileContent) as ProtocolHistoryFile
    expect(parsed.version).toBe(2)
    // v1 マーカーが履歴の最初のエントリとして変換され、source='manual' になる
    expect(parsed.history.length).toBe(2)
    expect(parsed.history[0].source).toBe('manual') // confidence='explicit' → manual
    expect(parsed.history[0].marker).toEqual(v1Marker)
    expect(parsed.history[1].source).toBe('auto')
    expect(parsed.history[1].marker).toEqual(newMarker)
  })

  it('TC-COMPAT-4: 不在ファイル → readProtocol は null', async () => {
    expect(await readProtocol(workdir)).toBeNull()
    expect(await readProtocolHistory(workdir)).toBeNull()
  })
})

describe('034-B: getLatestManualEntry', () => {
  it('TC-LAT-1: manual エントリがあれば最新の manual エントリを返す', async () => {
    const a = makeMarker({ protocol: 'manx' })
    const b = makeMarker({ protocol: 'legacy' })
    const c = makeMarker({ protocol: 'unknown' })
    await appendProtocolEntry(workdir, 'manual', a, new Date('2026-05-01T00:00:00Z'))
    await appendProtocolEntry(workdir, 'auto', b, new Date('2026-05-02T00:00:00Z'))
    await appendProtocolEntry(workdir, 'manual', c, new Date('2026-05-03T00:00:00Z'))

    const latest = await getLatestManualEntry(workdir)
    expect(latest).not.toBeNull()
    expect(latest!.source).toBe('manual')
    expect(latest!.marker).toEqual(c)
  })

  it('TC-LAT-2: manual エントリが無ければ null（auto のみ）', async () => {
    await appendProtocolEntry(workdir, 'auto', makeMarker())
    await appendProtocolEntry(workdir, 'auto', makeMarker())
    const latest = await getLatestManualEntry(workdir)
    expect(latest).toBeNull()
  })

  it('TC-LAT-3: 履歴空なら null', async () => {
    expect(await getLatestManualEntry(workdir)).toBeNull()
  })
})

describe('034-B: parseAppliedAtToIso', () => {
  it('TC-PARSE-1: "2604300643" → 2026-04-30 06:43 (local) → ISO', () => {
    const iso = parseAppliedAtToIso('2604300643')
    const d = new Date(iso)
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(3) // 0-indexed: April = 3
    expect(d.getDate()).toBe(30)
    expect(d.getHours()).toBe(6)
    expect(d.getMinutes()).toBe(43)
  })

  it('TC-PARSE-2: 不正な形式 → 現在時刻に fallback', () => {
    const before = Date.now()
    const iso = parseAppliedAtToIso('invalid')
    const after = Date.now()
    const t = new Date(iso).getTime()
    expect(t).toBeGreaterThanOrEqual(before - 100)
    expect(t).toBeLessThanOrEqual(after + 100)
  })
})
