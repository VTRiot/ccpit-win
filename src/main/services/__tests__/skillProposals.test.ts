import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseProposalMd,
  listProposals,
  readProposalStates,
  setProposalState,
  readProposalReviews,
  setProposalReview,
  getDefaultProposalsFolder,
  type ProposalStorePaths,
  type StoredProposalReview
} from '../skillProposals'
import { upsertAdoptedSkill, type ProvenancePaths } from '../skillProvenance'
import {
  parseChangeRequestMd,
  applyChange,
  type SettingsPaths
} from '../settingsChange'

let workdir: string
let folder: string
let storePaths: ProposalStorePaths
let provPaths: ProvenancePaths

beforeEach(async () => {
  workdir = join(tmpdir(), `ccpit-proposals-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  folder = join(workdir, '_SkillProposals')
  await mkdir(folder, { recursive: true })
  storePaths = {
    statesPath: join(workdir, '.ccpit', 'proposal-states.json'),
    reviewsPath: join(workdir, '.ccpit', 'proposal-reviews.json')
  }
  provPaths = {
    adoptedRegistryPath: join(workdir, '.ccpit', 'adopted-skills.json'),
    emergencyOverridesPath: join(workdir, '.ccpit', 'emergency-overrides.json')
  }
})

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true })
})

function jaProposal(name = 'pdf-flow', label = 'recommend'): string {
  return `---
request_id: ${name}-001
created_at: 2026-05-29T16:00:00+09:00
purpose: ${name} を skill 化
target: ~/.claude/skills/${name}/SKILL.md
status: pending
kind: skill
adoption_label: ${label}
source_project: C:\\proj\\${name}
---

## 1. サマリ

- タイトル: ${name} フロー
- What: PDF を抽出する
- Why: 毎回手順が同じ
- How: セッションで PDF を渡されたら発火

## 2. 評価軸

- 再現性: 4 — 手順固定
- 汎用性: 3 — 他PRJでも使える
- Context節約効果: 5 — 指示省略
- 既存Skill重複・統一可能性: 2 — 重複なし
- 本質的UX向上への寄与: 4 — 手数削減

## 3. 変更後の完成版

\`\`\`markdown
---
name: ${name}
description: x
---
# body
\`\`\`

## 4. 採用推奨 / 棄却の判定と理由

- 判定: ${label}
- 理由: 有用

## 5. レビューボックス

- review_verdict: pending
- findings:
- reviewer_id:
- cc_rebuttal:
`
}

function enProposal(name = 'csv-flow'): string {
  return `---
request_id: ${name}-001
created_at: 2026-05-29T16:00:00+09:00
purpose: turn ${name} into a skill
target: ~/.claude/skills/${name}/SKILL.md
status: pending
kind: skill
adoption_label: recommend
---

## 1. Summary

- Title: ${name} flow
- What: parse csv
- Why: repeated steps
- How: fires on csv input

## 2. Evaluation axes

- Reproducibility: 5 — fixed
- Generality: 4 — broad
- ContextSaving: 3 — some
- OverlapWithExisting: 1 — none
- EssentialUXGain: 4 — fewer steps

## 3. Final content after change

\`\`\`markdown
---
name: ${name}
description: x
---
# body
\`\`\`

## 5. Review box

- review_verdict: pending
- findings:
- reviewer_id:
- cc_rebuttal:
`
}

describe('parseProposalMd', () => {
  it('parses a ja proposal (summary/axes/review box/target)', async () => {
    const fp = join(folder, '20260529_1600_pdf-flow.md')
    await writeFile(fp, jaProposal('pdf-flow'), 'utf-8')
    const p = await parseProposalMd(fp)
    expect(p.parseError).toBeNull()
    expect(p.requestId).toBe('pdf-flow-001')
    expect(p.skillName).toBe('pdf-flow')
    expect(p.adoptionLabel).toBe('recommend')
    expect(p.title).toBe('pdf-flow フロー')
    expect(p.what).toBe('PDF を抽出する')
    expect(p.why).toBe('毎回手順が同じ')
    expect(p.how).toContain('発火')
    expect(p.axes).toHaveLength(5)
    const repro = p.axes.find((a) => a.axis === '再現性')
    expect(repro?.score).toBe(4)
    expect(repro?.rationale).toBe('手順固定')
    expect(p.reviewBox.verdict).toBe('pending')
    expect(p.sourceProject).toBe('C:\\proj\\pdf-flow')
  })

  it('fails safe (sourceProject = "") when source_project is absent', async () => {
    const fp = join(folder, 'no-src.md')
    await writeFile(
      fp,
      // recommend は A2 ゲートで軸必須のため有効な §2 を含める（本テストの主眼は sourceProject フェイルセーフ）
      `---\nrequest_id: x-1\ncreated_at: t\npurpose: p\ntarget: ~/.claude/skills/x/SKILL.md\nstatus: pending\nkind: skill\nadoption_label: recommend\n---\n\n## 1. サマリ\n- タイトル: X\n\n## 2. 評価軸\n- 再現性: 4 — x\n- 汎用性: 3 — y\n`,
      'utf-8'
    )
    const p = await parseProposalMd(fp)
    expect(p.parseError).toBeNull()
    expect(p.sourceProject).toBe('')
  })

  it('getDefaultProposalsFolder points at ~/.ccpit/proposals', () => {
    const f = getDefaultProposalsFolder().replace(/\\/g, '/')
    expect(f.endsWith('.ccpit/proposals')).toBe(true)
  })

  it('parses an en proposal (Title/What/Why/How + en axis keys)', async () => {
    const fp = join(folder, '20260529_1600_csv-flow.md')
    await writeFile(fp, enProposal('csv-flow'), 'utf-8')
    const p = await parseProposalMd(fp)
    expect(p.parseError).toBeNull()
    expect(p.title).toBe('csv-flow flow')
    expect(p.what).toBe('parse csv')
    expect(p.axes.find((a) => a.axis === 'Reproducibility')?.score).toBe(5)
    expect(p.reviewBox.verdict).toBe('pending')
  })

  it('flags parseError when kind is not skill', async () => {
    const fp = join(folder, 'bad.md')
    await writeFile(
      fp,
      `---\nrequest_id: x\ncreated_at: t\npurpose: p\ntarget: ~/.claude/settings.json\nstatus: pending\nkind: settings\n---\n\n## 1. サマリ\n- タイトル: x\n`,
      'utf-8'
    )
    const p = await parseProposalMd(fp)
    expect(p.parseError).toMatch(/expected 'skill'/)
  })
})

// --- A2 評価軸ゲート（FSA §5-a / Phase2b） ---
// 空欄(score===null)・範囲外・定型句(FILL)を弾き、該当なし(reject)はスキップする。
function proposalWithAxes(axesBody: string, label = 'recommend'): string {
  return `---
request_id: ax-001
created_at: 2026-06-04T00:00:00+09:00
purpose: axis gate test
target: ~/.claude/skills/ax/SKILL.md
status: pending
kind: skill
adoption_label: ${label}
source_project: C:\\proj\\ax
---

## 1. サマリ
- タイトル: ax
- What: x
- Why: y
- How: z

## 2. 評価軸
${axesBody}

## 3. 変更後の完成版
\`\`\`markdown
---
name: ax
description: x
---
# body
\`\`\`

## 4. 採用推奨 / 棄却の判定と理由
- 判定: ${label}
- 理由: r

## 5. レビューボックス
- review_verdict: pending
`
}

const VALID_AXES = `- 再現性: 4 — 手順固定
- 汎用性: 3 — 他PRJでも使える
- Context節約効果: 5 — 指示省略
- 既存Skill重複・統一可能性: 2 — 重複なし
- 本質的UX向上への寄与: 4 — 手数削減`

describe('Phase2b: A2 評価軸ゲート', () => {
  it('空欄スコアの軸を弾く（score===null）', async () => {
    const body = `- 再現性: — 手順固定\n${VALID_AXES}`
    const fp = join(folder, 'a2-empty.md')
    await writeFile(fp, proposalWithAxes(body), 'utf-8')
    const p = await parseProposalMd(fp)
    expect(p.parseError).toMatch(/スコア/)
  })

  it('定型句(FILL)根拠を弾く', async () => {
    const body = `- 再現性: 4 — <FILL: 根拠>\n- 汎用性: 3 — ok\n- Context節約効果: 5 — ok\n- 既存Skill重複・統一可能性: 2 — ok\n- 本質的UX向上への寄与: 4 — ok`
    const fp = join(folder, 'a2-fill.md')
    await writeFile(fp, proposalWithAxes(body), 'utf-8')
    const p = await parseProposalMd(fp)
    expect(p.parseError).toMatch(/定型句|FILL/)
  })

  it('## 2. 評価軸 欠落を弾く（軸が空）', async () => {
    const md = proposalWithAxes(VALID_AXES).replace(/## 2\. 評価軸[\s\S]*?(?=## 3\.)/, '')
    const fp = join(folder, 'a2-missing.md')
    await writeFile(fp, md, 'utf-8')
    const p = await parseProposalMd(fp)
    expect(p.parseError).toMatch(/評価軸が空/)
  })

  it('範囲外スコア(>5)を弾く', async () => {
    const body = `- 再現性: 9 — 過大\n- 汎用性: 3 — ok\n- Context節約効果: 5 — ok\n- 既存Skill重複・統一可能性: 2 — ok\n- 本質的UX向上への寄与: 4 — ok`
    const fp = join(folder, 'a2-range.md')
    await writeFile(fp, proposalWithAxes(body), 'utf-8')
    const p = await parseProposalMd(fp)
    expect(p.parseError).toMatch(/範囲外/)
  })

  it('正常な評価軸は通す（parseError null）', async () => {
    const fp = join(folder, 'a2-ok.md')
    await writeFile(fp, proposalWithAxes(VALID_AXES), 'utf-8')
    const p = await parseProposalMd(fp)
    expect(p.parseError).toBeNull()
  })

  it('該当なし(adoption_label: reject)は軸検査をスキップ（空軸でも null）', async () => {
    // 候補ゼロ＝評価対象なし。偽スコアを要求しない（修正1）。§2 を FILL のまま/空でも通す。
    const body = `- 再現性: <FILL: 0-5> — <FILL: 根拠>`
    const fp = join(folder, 'a2-none.md')
    await writeFile(fp, proposalWithAxes(body, 'reject'), 'utf-8')
    const p = await parseProposalMd(fp)
    expect(p.parseError).toBeNull()
  })
})

// --- skill-proposal-gate.sh smoke（B1 / A1。実機の「セッション1回」は段階3 で確認） ---
const gatePath = join(__dirname, '../../../../golden/common/hooks/skill-proposal-gate.sh')
const bashAvailable = (() => {
  try {
    execFileSync('bash', ['--version'], { encoding: 'utf-8' })
    return true
  } catch {
    return false
  }
})()

function setupGateHome(mode?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'ccpit-gate-home-'))
  mkdirSync(join(home, '.ccpit'), { recursive: true })
  if (mode) {
    writeFileSync(join(home, '.ccpit', 'app-config.json'), JSON.stringify({ emissionMode: mode }), 'utf-8')
  }
  return home
}

function runGate(home: string, input: object): boolean {
  let out = ''
  try {
    out = execFileSync('bash', [gatePath], {
      input: JSON.stringify(input),
      env: { ...process.env, HOME: home.replace(/\\/g, '/'), USERPROFILE: home },
      encoding: 'utf-8'
    })
  } catch {
    out = ''
  }
  return out.includes('"decision": "block"')
}

describe.runIf(bashAvailable)('Phase2b: skill-proposal-gate.sh smoke', () => {
  it('off は通過（block しない）', () => {
    const home = setupGateHome('off')
    expect(runGate(home, { session_id: 's', hook_event_name: 'Stop' })).toBe(false)
  })

  it('soft 初回は block する', () => {
    const home = setupGateHome('soft')
    expect(runGate(home, { session_id: 's1', hook_event_name: 'Stop' })).toBe(true)
  })

  it('soft は同一 session_id の2回目を通過（センチネル＝セッション1回）', () => {
    const home = setupGateHome('soft')
    expect(runGate(home, { session_id: 's1', hook_event_name: 'Stop' })).toBe(true)
    expect(runGate(home, { session_id: 's1', hook_event_name: 'Stop' })).toBe(false)
  })

  it('soft は別 session_id では再び block（センチネルはセッション単位）', () => {
    const home = setupGateHome('soft')
    expect(runGate(home, { session_id: 's1', hook_event_name: 'Stop' })).toBe(true)
    expect(runGate(home, { session_id: 's2', hook_event_name: 'Stop' })).toBe(true)
  })

  it('soft + stop_hook_active=true は通過（無限ループ防止）', () => {
    const home = setupGateHome('soft')
    expect(runGate(home, { session_id: 's3', stop_hook_active: true, hook_event_name: 'Stop' })).toBe(false)
  })

  it('strict は同一 session_id の2回目も block（抑制なし＝毎ターン催促）', () => {
    const home = setupGateHome('strict')
    expect(runGate(home, { session_id: 't1', hook_event_name: 'Stop' })).toBe(true)
    expect(runGate(home, { session_id: 't1', hook_event_name: 'Stop' })).toBe(true)
  })

  it('strict + stop_hook_active=true は通過', () => {
    const home = setupGateHome('strict')
    expect(runGate(home, { session_id: 't2', stop_hook_active: true, hook_event_name: 'Stop' })).toBe(false)
  })

  it('config 不在は既定 soft（初回 block）', () => {
    const home = setupGateHome() // app-config.json なし
    expect(runGate(home, { session_id: 'd1', hook_event_name: 'Stop' })).toBe(true)
  })
})

describe('proposal state store', () => {
  it('round-trips state and rejects invalid state', async () => {
    expect(await readProposalStates(storePaths)).toEqual({})
    await setProposalState('pdf-flow-001', 'adopted', storePaths)
    await setProposalState('csv-flow-001', 'held', storePaths)
    const states = await readProposalStates(storePaths)
    expect(states['pdf-flow-001']).toBe('adopted')
    expect(states['csv-flow-001']).toBe('held')
    await expect(
      // @ts-expect-error invalid state at runtime
      setProposalState('x', 'bogus', storePaths)
    ).rejects.toThrow(/invalid proposal state/)
  })

  it('returns {} on corrupt states file (fail-safe)', async () => {
    await mkdir(join(workdir, '.ccpit'), { recursive: true })
    await writeFile(storePaths.statesPath, '{ not json', 'utf-8')
    expect(await readProposalStates(storePaths)).toEqual({})
  })
})

describe('proposal review store (codex 第二レビュアー findings)', () => {
  const review: StoredProposalReview = {
    verdict: 'needs-attention',
    findings: '[codex] body の description が薄い',
    reviewerId: 'codex',
    ccRebuttal: '次回 emitter で補強する',
    reviewedAt: '2026-05-30T10:00:00+09:00'
  }

  it('round-trips a review and requires requestId', async () => {
    expect(await readProposalReviews(storePaths)).toEqual({})
    await setProposalReview('pdf-flow-001', review, storePaths)
    const reviews = await readProposalReviews(storePaths)
    expect(reviews['pdf-flow-001']).toEqual(review)
    await expect(setProposalReview('', review, storePaths)).rejects.toThrow(/requestId is required/)
  })

  it('returns {} on corrupt reviews file (fail-safe)', async () => {
    await mkdir(join(workdir, '.ccpit'), { recursive: true })
    await writeFile(storePaths.reviewsPath, '{ not json', 'utf-8')
    expect(await readProposalReviews(storePaths)).toEqual({})
  })

  it('listProposals merges a stored review over the MD pending review box', async () => {
    await writeFile(join(folder, '20260529_1600_pdf-flow.md'), jaProposal('pdf-flow'), 'utf-8')
    // マージ前: MD §5 は pending
    const before = await listProposals(folder, { storePaths, provenancePaths: provPaths })
    expect(before[0].reviewBox.verdict).toBe('pending')
    expect(before[0].reviewBox.reviewerId).toBe('')

    await setProposalReview('pdf-flow-001', review, storePaths)
    const after = await listProposals(folder, { storePaths, provenancePaths: provPaths })
    const pdf = after.find((p) => p.skillName === 'pdf-flow')!
    expect(pdf.reviewBox.verdict).toBe('needs-attention')
    expect(pdf.reviewBox.reviewerId).toBe('codex')
    expect(pdf.reviewBox.findings).toContain('description が薄い')
    expect(pdf.reviewBox.ccRebuttal).toBe('次回 emitter で補強する')
  })

  it('listProposals survives a corrupt reviews file (falls back to MD pending)', async () => {
    await writeFile(join(folder, '20260529_1600_pdf-flow.md'), jaProposal('pdf-flow'), 'utf-8')
    await mkdir(join(workdir, '.ccpit'), { recursive: true })
    await writeFile(storePaths.reviewsPath, '{ not json', 'utf-8')
    const list = await listProposals(folder, { storePaths, provenancePaths: provPaths })
    expect(list[0].reviewBox.verdict).toBe('pending')
  })
})

describe('listProposals', () => {
  it('lists proposals with state and alreadyAdopted flag', async () => {
    await writeFile(join(folder, '20260529_1600_pdf-flow.md'), jaProposal('pdf-flow'), 'utf-8')
    await writeFile(join(folder, '20260529_1601_csv-flow.md'), enProposal('csv-flow'), 'utf-8')
    // csv-flow を採用済みにする (レジストリ + 状態)
    await upsertAdoptedSkill(
      {
        name: 'csv-flow',
        target: '~/.claude/skills/csv-flow/SKILL.md',
        hash: 'h',
        adoptedAt: '2026-05-29T00:00:00Z',
        source: 'adopted'
      },
      provPaths
    )
    await setProposalState('csv-flow-001', 'adopted', storePaths)

    const list = await listProposals(folder, { storePaths, provenancePaths: provPaths })
    expect(list).toHaveLength(2)
    const pdf = list.find((p) => p.skillName === 'pdf-flow')!
    const csv = list.find((p) => p.skillName === 'csv-flow')!
    expect(pdf.state).toBe('candidate')
    expect(pdf.alreadyAdopted).toBe(false)
    expect(csv.state).toBe('adopted')
    expect(csv.alreadyAdopted).toBe(true)
    // candidate が adopted より前に並ぶ
    expect(list[0].skillName).toBe('pdf-flow')
  })

  it('returns [] for a non-existent folder', async () => {
    expect(await listProposals(join(workdir, 'nope'))).toEqual([])
  })
})

// 関数レベル e2e: 候補ブラウザの採用フロー（list → read → applyChange → setState）。
// renderer ページはこの呼び出し列の薄い View であり、本テストで「ほぼ手数0 採用」の論理を貫通検証する。
describe('adopt flow e2e (list -> read -> applyChange -> setState)', () => {
  it('adopts a candidate end-to-end and reflects state + alreadyAdopted', async () => {
    const claudeDir = join(workdir, '.claude')
    const skillsRoot = join(claudeDir, 'skills')
    const parcFermeDir = join(workdir, '.ccpit')
    await mkdir(skillsRoot, { recursive: true })
    await mkdir(parcFermeDir, { recursive: true })
    // 認証あり settings
    await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({ auth: { password: 'pw' } }), 'utf-8')
    const settingsPaths: SettingsPaths = {
      claudeDir,
      settingsJsonPath: join(claudeDir, 'settings.json'),
      settingsLocalJsonPath: join(claudeDir, 'settings.local.json'),
      parcFermeDir,
      backupsDir: join(parcFermeDir, 'settings-backups'),
      changeLogPath: join(parcFermeDir, 'settings-change-log.jsonl'),
      skillsRoot,
      skillBackupRoot: join(parcFermeDir, 'skill-backups')
    }
    // target を test の skillsRoot 内の絶対パスにした提案を作る（~ は normalize 非対象のため）
    const skillName = 'adopt-flow-skill'
    const skillDir = join(skillsRoot, skillName)
    await mkdir(skillDir, { recursive: true })
    const absTarget = join(skillDir, 'SKILL.md')
    const proposal = jaProposal(skillName).replace(
      `target: ~/.claude/skills/${skillName}/SKILL.md`,
      `target: ${absTarget}`
    )
    const fp = join(folder, `20260529_1600_${skillName}.md`)
    await writeFile(fp, proposal, 'utf-8')

    // 1) list → candidate
    let list = await listProposals(folder, { storePaths, provenancePaths: provPaths })
    const cand = list.find((p) => p.skillName === skillName)!
    expect(cand.state).toBe('candidate')
    expect(cand.alreadyAdopted).toBe(false)

    // 2) read (settings:readRequest 相当) → ChangeRequest
    const req = await parseChangeRequestMd(cand.filePath)
    expect(req.kind).toBe('skill')

    // 3) applyChange (settings:applyChange 相当)
    const result = await applyChange(req, 'pw', settingsPaths, {
      goldenSkillNames: ['report'], // adopt-flow-skill は非同名 → 通る
      provenancePaths: provPaths,
      currentGoldenVersion: '1.4.0'
    })
    expect(result.success).toBe(true)

    // 4) setState(adopted)
    await setProposalState(req.frontmatter.request_id, 'adopted', storePaths)

    // 検証: skill 本体が書かれた + 状態 adopted + alreadyAdopted true
    const { readFile: rf } = await import('fs/promises')
    const written = await rf(absTarget, 'utf-8')
    expect(written).toContain('name: adopt-flow-skill')
    list = await listProposals(folder, { storePaths, provenancePaths: provPaths })
    const after = list.find((p) => p.skillName === skillName)!
    expect(after.state).toBe('adopted')
    expect(after.alreadyAdopted).toBe(true) // provenance に記録された
  })

  // Part B 実機 FB: 親ディレクトリ未作成の新規 skill 採用（実機で parent-not-found が露呈した回帰防止）
  it('adopts a brand-new skill whose parent dir does not exist yet (auto-create)', async () => {
    const claudeDir = join(workdir, '.claude')
    const skillsRoot = join(claudeDir, 'skills')
    const parcFermeDir = join(workdir, '.ccpit')
    await mkdir(skillsRoot, { recursive: true }) // skills/ はあるが <name>/ は作らない
    await mkdir(parcFermeDir, { recursive: true })
    await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({ auth: { password: 'pw' } }), 'utf-8')
    const settingsPaths: SettingsPaths = {
      claudeDir,
      settingsJsonPath: join(claudeDir, 'settings.json'),
      settingsLocalJsonPath: join(claudeDir, 'settings.local.json'),
      parcFermeDir,
      backupsDir: join(parcFermeDir, 'settings-backups'),
      changeLogPath: join(parcFermeDir, 'settings-change-log.jsonl'),
      skillsRoot,
      skillBackupRoot: join(parcFermeDir, 'skill-backups')
    }
    const skillName = 'fresh-skill'
    const absTarget = join(skillsRoot, skillName, 'SKILL.md')
    // 親 <name>/ は意図的に未作成
    const { existsSync } = await import('fs')
    expect(existsSync(join(skillsRoot, skillName))).toBe(false)

    const proposal = jaProposal(skillName).replace(
      `target: ~/.claude/skills/${skillName}/SKILL.md`,
      `target: ${absTarget}`
    )
    const fp = join(folder, `20260530_0000_${skillName}.md`)
    await writeFile(fp, proposal, 'utf-8')

    const list = await listProposals(folder, { storePaths, provenancePaths: provPaths })
    const cand = list.find((p) => p.skillName === skillName)!
    const req = await parseChangeRequestMd(cand.filePath)
    const result = await applyChange(req, 'pw', settingsPaths, {
      goldenSkillNames: ['report'],
      provenancePaths: provPaths,
      currentGoldenVersion: '1.4.0'
    })
    expect(result.success).toBe(true)
    const { readFile: rf } = await import('fs/promises')
    expect(existsSync(absTarget)).toBe(true)
    expect(await rf(absTarget, 'utf-8')).toContain('name: fresh-skill')
  })
})
