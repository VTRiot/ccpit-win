import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, writeFile, readFile, readdir, symlink } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseChangeRequestMd,
  applyChange,
  verifyPassword,
  hasPasswordRegistered,
  listChangeLogs,
  listSettingsBackups,
  rollbackToBackup,
  type SettingsPaths,
  type ChangeRequest
} from '../settingsChange'
import {
  readAdoptedRegistry,
  upsertAdoptedSkill,
  createEmergencyOverride,
  removeEmergencyOverride,
  listObsoleteOverrides,
  isEmergencyOverrideValid,
  readEmergencyOverrides,
  type ProvenancePaths,
  type EmergencyOverride
} from '../skillProvenance'

let workdir: string
let paths: SettingsPaths

beforeEach(async () => {
  workdir = join(
    tmpdir(),
    `ccpit-settings-change-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await mkdir(workdir, { recursive: true })
  const claudeDir = join(workdir, '.claude')
  const parcFermeDir = join(workdir, '.ccpit')
  paths = {
    claudeDir,
    settingsJsonPath: join(claudeDir, 'settings.json'),
    settingsLocalJsonPath: join(claudeDir, 'settings.local.json'),
    parcFermeDir,
    backupsDir: join(parcFermeDir, 'settings-backups'),
    changeLogPath: join(parcFermeDir, 'settings-change-log.jsonl'),
    skillsRoot: join(claudeDir, 'skills'),
    skillBackupRoot: join(parcFermeDir, 'skill-backups')
  }
  await mkdir(claudeDir, { recursive: true })
  await mkdir(paths.skillsRoot!, { recursive: true })
})

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true })
})

async function writeSettings(content: object | string): Promise<void> {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
  await writeFile(paths.settingsJsonPath, text, 'utf-8')
}

/**
 * 既存 kind:settings 用 fixture。
 * target デフォルトを `paths.settingsJsonPath` にして allowlist 完全一致判定が成立するようにする
 * （PIKES r1.4 §7-3-A 第 3 項 + Phase 1 改修。fixture 整合のための更新であり、
 *  既存 19 件のテストロジックは不変）。
 */
function buildValidMd(
  opts: {
    requestId?: string
    status?: string
    proposedJson?: string
    target?: string
    kind?: string
  } = {}
): string {
  const requestId = opts.requestId ?? 'test-req-001'
  const status = opts.status ?? 'pending'
  const proposedJson = opts.proposedJson ?? '{"hello": "world", "auth": {"password": "kept"}}'
  const target = opts.target ?? paths.settingsJsonPath
  const kindLine = opts.kind !== undefined ? `\nkind: ${opts.kind}` : ''
  return `---
request_id: ${requestId}
created_at: 2026-05-01T19:00:00Z
purpose: test change request
target: ${target}
status: ${status}${kindLine}
---

## 1. 変更概要

A test change.

## 2. 現状の関連箇所

\`\`\`json
{}
\`\`\`

## 3. 変更後の完成版

\`\`\`json
${proposedJson}
\`\`\`

## 4. 変更理由

For test.

## 5. 影響範囲

None.

## 6. ロールバック手順

Use the Rollback button.
`
}

/** kind:skill 用 fixture (Phase 1 で新設、MN-1/MN-3 対応含む)。 */
function buildValidSkillMd(
  opts: {
    requestId?: string
    status?: string
    target?: string
    body?: string
  } = {}
): string {
  const requestId = opts.requestId ?? 'test-skill-001'
  const status = opts.status ?? 'pending'
  const target = opts.target ?? join(paths.skillsRoot!, 'test-skill', 'SKILL.md')
  const body = opts.body ?? '# Test Skill\n\nThis is a test skill body.\n'
  return `---
request_id: ${requestId}
created_at: 2026-05-01T19:00:00Z
purpose: test skill change request
target: ${target}
status: ${status}
kind: skill
---

## 1. 変更概要

A test skill change.

## 2. 現状の関連箇所

(skill body)

## 3. 変更後の完成版

\`\`\`markdown
${body}
\`\`\`

## 4. 変更理由

For test.

## 5. 影響範囲

None.

## 6. ロールバック手順

Use the Rollback button.
`
}

async function writeRequestMd(filename: string, content: string): Promise<string> {
  const filePath = join(workdir, filename)
  await writeFile(filePath, content, 'utf-8')
  return filePath
}

// =============================================================================
//   Existing tests (19 件) — kind:settings 経路の挙動不変を保証
// =============================================================================

describe('parseChangeRequestMd', () => {
  it('parses a well-formed change request', async () => {
    const fp = await writeRequestMd('req.md', buildValidMd())
    const req = await parseChangeRequestMd(fp)
    expect(req.frontmatter.request_id).toBe('test-req-001')
    expect(req.frontmatter.status).toBe('pending')
    // fixture 整合: target は paths.settingsJsonPath
    expect(req.frontmatter.target).toBe(paths.settingsJsonPath)
    // kind 未指定なら既定 'settings' (§7-3-A 第 5 項 後方互換)
    expect(req.kind).toBe('settings')
    expect(req.frontmatter.kind).toBe('settings')
    expect(req.parseError).toBeNull()
    if (req.kind === 'settings') {
      expect(req.proposedSettingsParsed).toEqual({
        hello: 'world',
        auth: { password: 'kept' }
      })
    }
  })

  it('rejects when frontmatter is missing', async () => {
    const fp = await writeRequestMd('no-fm.md', 'plain markdown without frontmatter')
    await expect(parseChangeRequestMd(fp)).rejects.toThrow(/frontmatter not found/)
  })

  it('captures JSON syntax errors in parseError', async () => {
    const fp = await writeRequestMd(
      'bad-json.md',
      buildValidMd({ proposedJson: '{ invalid json,, }' })
    )
    const req = await parseChangeRequestMd(fp)
    expect(req.parseError).not.toBeNull()
    if (req.kind === 'settings') {
      expect(req.proposedSettingsParsed).toBeNull()
      // The raw string is still preserved
      expect(req.proposedSettingsJson).toContain('invalid json')
    }
  })

  it('rejects when status is not in the valid set', async () => {
    const fp = await writeRequestMd('bad-status.md', buildValidMd({ status: 'unknown_status' }))
    await expect(parseChangeRequestMd(fp)).rejects.toThrow(/invalid status/)
  })
})

describe('verifyPassword / hasPasswordRegistered', () => {
  it('hasPasswordRegistered returns false when settings.json is missing', async () => {
    expect(await hasPasswordRegistered(paths)).toBe(false)
  })

  it('hasPasswordRegistered returns true when auth.password is set', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    expect(await hasPasswordRegistered(paths)).toBe(true)
  })

  it('verifyPassword returns true on match', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    expect(await verifyPassword('sesame', paths)).toBe(true)
  })

  it('verifyPassword returns false on mismatch', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    expect(await verifyPassword('wrong', paths)).toBe(false)
  })

  it('verifyPassword returns true when no password is registered', async () => {
    await writeSettings({ hello: 'world' })
    expect(await verifyPassword('anything', paths)).toBe(true)
  })
})

describe('applyChange', () => {
  it('applies the proposed JSON when authenticated', async () => {
    await writeSettings({ auth: { password: 'sesame' }, before: 'orig' })
    const fp = await writeRequestMd(
      'req.md',
      buildValidMd({
        proposedJson: '{\n  "auth": {"password": "sesame"},\n  "after": "new"\n}'
      })
    )
    const req = await parseChangeRequestMd(fp)
    const result = await applyChange(req, 'sesame', paths)

    expect(result.success).toBe(true)
    expect(result.backupPath).toBeDefined()
    expect(existsSync(result.backupPath!)).toBe(true)
    const written = JSON.parse(await readFile(paths.settingsJsonPath, 'utf-8'))
    expect(written).toEqual({ auth: { password: 'sesame' }, after: 'new' })

    // Backup contains original
    const backedUp = JSON.parse(await readFile(result.backupPath!, 'utf-8'))
    expect(backedUp).toEqual({ auth: { password: 'sesame' }, before: 'orig' })

    // Log appended
    const logs = await listChangeLogs(paths)
    expect(logs).toHaveLength(1)
    expect(logs[0].result).toBe('applied')
  })

  it('refuses to write when authentication fails', async () => {
    await writeSettings({ auth: { password: 'sesame' }, before: 'orig' })
    const fp = await writeRequestMd('req.md', buildValidMd())
    const req = await parseChangeRequestMd(fp)
    const result = await applyChange(req, 'wrong', paths)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/authentication failed/)
    // settings.json unchanged
    const after = JSON.parse(await readFile(paths.settingsJsonPath, 'utf-8'))
    expect(after).toEqual({ auth: { password: 'sesame' }, before: 'orig' })
    // No backup created (auth failed before backup step)
    expect(await listSettingsBackups(paths)).toEqual([])
  })

  it('refuses to write when the proposed JSON has a syntax error', async () => {
    await writeSettings({ before: 'orig' })
    const fp = await writeRequestMd('req.md', buildValidMd({ proposedJson: '{ broken' }))
    const req = await parseChangeRequestMd(fp)
    const result = await applyChange(req, '', paths)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/JSON syntax error/)
    const after = JSON.parse(await readFile(paths.settingsJsonPath, 'utf-8'))
    expect(after).toEqual({ before: 'orig' })

    // Failure log was appended
    const logs = await listChangeLogs(paths)
    expect(logs).toHaveLength(1)
    expect(logs[0].result).toBe('failed')
  })

  it('appends a log entry on every apply', async () => {
    // Start with settings without auth.password so empty password works for both applies
    await writeSettings({ v: 0 })
    const proposedNoAuth = '{"v": 1}'
    const fp1 = await writeRequestMd(
      'a.md',
      buildValidMd({ requestId: 'a', proposedJson: proposedNoAuth })
    )
    const fp2 = await writeRequestMd(
      'b.md',
      buildValidMd({ requestId: 'b', proposedJson: proposedNoAuth })
    )
    const r1 = await parseChangeRequestMd(fp1)
    const r2 = await parseChangeRequestMd(fp2)
    await applyChange(r1, '', paths)
    // Ensure log timestamp differs (ISO millisecond precision)
    await new Promise((r) => setTimeout(r, 50))
    await applyChange(r2, '', paths)
    const logs = await listChangeLogs(paths)
    // Newest first
    expect(logs[0].request_id).toBe('b')
    expect(logs[1].request_id).toBe('a')
  })

  it('lists backups newest first', async () => {
    await writeSettings({ v: 1 })
    const proposedNoAuth = '{"v": 2}'
    const fp = await writeRequestMd('req.md', buildValidMd({ proposedJson: proposedNoAuth }))
    const req = await parseChangeRequestMd(fp)
    await applyChange(req, '', paths)
    // Ensure backup-id timestamp differs
    await new Promise((r) => setTimeout(r, 50))
    await applyChange(req, '', paths)
    const backups = await listSettingsBackups(paths)
    expect(backups.length).toBeGreaterThanOrEqual(2)
    // Sorted newest first
    expect(backups[0].id >= backups[1].id).toBe(true)
  })
})

describe('rollbackToBackup', () => {
  it('restores settings.json from a chosen backup', async () => {
    // Apply a change to create a backup
    await writeSettings({ original: true })
    const fp = await writeRequestMd('req.md', buildValidMd({ proposedJson: '{"changed": true}' }))
    const req = await parseChangeRequestMd(fp)
    const applied = await applyChange(req, '', paths)
    expect(applied.success).toBe(true)

    const backups = await listSettingsBackups(paths)
    expect(backups.length).toBeGreaterThan(0)
    const id = backups[0].id

    // Now rollback
    const r = await rollbackToBackup(id, paths)
    expect(r.success).toBe(true)
    const after = JSON.parse(await readFile(paths.settingsJsonPath, 'utf-8'))
    expect(after).toEqual({ original: true })

    // Rollback was logged
    const logs = await listChangeLogs(paths)
    expect(logs[0].result).toBe('rolled_back')
    expect(logs[0].request_id).toMatch(/^rollback:/)
  })

  it('returns success=false when the backup does not exist', async () => {
    const r = await rollbackToBackup('does-not-exist', paths)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/backup not found/)
  })
})

describe('listChangeLogs', () => {
  it('returns empty when no log file exists', async () => {
    expect(await listChangeLogs(paths)).toEqual([])
  })

  it('skips malformed JSONL lines', async () => {
    await mkdir(paths.parcFermeDir, { recursive: true })
    await writeFile(
      paths.changeLogPath,
      `{"timestamp":"x","request_id":"a","purpose":"p","result":"applied","backup_path":""}
{this is not json}
{"timestamp":"y","request_id":"b","purpose":"p","result":"applied","backup_path":""}
`,
      'utf-8'
    )
    const logs = await listChangeLogs(paths)
    expect(logs).toHaveLength(2)
  })
})

// Sanity check: type compatibility — parsed request can be re-applied via the public API
describe('end-to-end smoke', () => {
  it('parse → apply → rollback round trip', async () => {
    await writeSettings({ permissions: { deny: ['Read(**/*.env)'] } })
    const fp = await writeRequestMd(
      'req.md',
      buildValidMd({
        requestId: 'smoke-001',
        proposedJson: JSON.stringify(
          {
            permissions: { deny: ['Read(**/*.env)', 'Read(**/*.secret)'] },
            hooks: {
              Stop: [
                {
                  matcher: '',
                  hooks: [
                    { type: 'command', command: '$HOME/.claude/hooks/report-gate.sh', timeout: 10 }
                  ]
                }
              ]
            }
          },
          null,
          2
        )
      })
    )
    const req: ChangeRequest = await parseChangeRequestMd(fp)
    const applyRes = await applyChange(req, '', paths)
    expect(applyRes.success).toBe(true)

    const backups = await listSettingsBackups(paths)
    const rb = await rollbackToBackup(backups[0].id, paths)
    expect(rb.success).toBe(true)

    const restored = JSON.parse(await readFile(paths.settingsJsonPath, 'utf-8'))
    expect(restored).toEqual({ permissions: { deny: ['Read(**/*.env)'] } })
  })
})

// =============================================================================
//   Part B Phase 1: kind:skill 可変長フェンス + 見出し堅牢性
//   (SKILL.md 本文が内側 ``` / `## N.` を含んでも section3 抽出が切れない)
// =============================================================================

describe('Part B Phase 1: kind:skill fence/heading robustness (parseChangeRequestMd)', () => {
  it('extracts skill body containing inner triple-backtick fences (outer 4-backtick)', async () => {
    const target = join(paths.skillsRoot!, 'inner-fence-skill', 'SKILL.md')
    const skillBody =
      '---\nname: inner-fence-skill\ndescription: has inner fences\n---\n\n# Example\n\n```bash\necho hi\n```\n\nDone.'
    const md = `---
request_id: pb-fence-001
created_at: 2026-05-29T16:00:00+09:00
purpose: inner fence test
target: ${target}
status: pending
kind: skill
---

## 3. 変更後の完成版

\`\`\`\`markdown
${skillBody}
\`\`\`\`

## 4. 採用推奨
recommend
`
    const fp = await writeRequestMd('pb-fence.md', md)
    const req = await parseChangeRequestMd(fp)
    expect(req.kind).toBe('skill')
    if (req.kind === 'skill') {
      // 内側の ```bash フェンスで切れず、末尾 'Done.' まで保持
      expect(req.proposedSkillBody).toContain('```bash')
      expect(req.proposedSkillBody).toContain('echo hi')
      expect(req.proposedSkillBody.endsWith('Done.')).toBe(true)
    }
  })

  it('extracts skill body with nested fences (outer 5-backtick / inner 4-backtick)', async () => {
    const target = join(paths.skillsRoot!, 'nested-fence-skill', 'SKILL.md')
    const skillBody =
      '---\nname: nested-fence-skill\ndescription: nested\n---\n\n## 例\n````bash\necho deep\n````\n\nfin.'
    const md = `---
request_id: pb-nest-001
created_at: 2026-05-29T16:00:00+09:00
purpose: nested fence test
target: ${target}
status: pending
kind: skill
---

## 3. 変更後の完成版

\`\`\`\`\`markdown
${skillBody}
\`\`\`\`\`

## 4. 採用推奨
recommend
`
    const fp = await writeRequestMd('pb-nest.md', md)
    const req = await parseChangeRequestMd(fp)
    expect(req.kind).toBe('skill')
    if (req.kind === 'skill') {
      expect(req.proposedSkillBody).toContain('````bash') // 内側 4-backtick が保持
      expect(req.proposedSkillBody).toContain('echo deep')
      expect(req.proposedSkillBody.endsWith('fin.')).toBe(true)
    }
  })

  it('does not truncate skill body at inner "## N." headings', async () => {
    const target = join(paths.skillsRoot!, 'heading-skill', 'SKILL.md')
    const skillBody =
      '---\nname: heading-skill\ndescription: numbered headings\n---\n\n## 1. First\n\nalpha\n\n## 2. Second\n\nbeta'
    const md = `---
request_id: pb-head-001
created_at: 2026-05-29T16:00:00+09:00
purpose: inner heading test
target: ${target}
status: pending
kind: skill
---

## 3. 変更後の完成版

\`\`\`markdown
${skillBody}
\`\`\`

## 4. 採用推奨
recommend
`
    const fp = await writeRequestMd('pb-head.md', md)
    const req = await parseChangeRequestMd(fp)
    expect(req.kind).toBe('skill')
    if (req.kind === 'skill') {
      // 内側 "## 1." で section3 が早期終了せず "## 2. Second"/'beta' まで保持
      expect(req.proposedSkillBody).toContain('## 2. Second')
      expect(req.proposedSkillBody.endsWith('beta')).toBe(true)
    }
  })

  it('round-trips apply of a skill body with inner fences (byte-equal post-verify)', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    const skillDir = join(paths.skillsRoot!, 'rt-fence-skill')
    await mkdir(skillDir, { recursive: true })
    const target = join(skillDir, 'SKILL.md')
    await writeFile(target, '# orig\n', 'utf-8')
    const skillBody = '---\nname: rt-fence-skill\ndescription: x\n---\n\n```js\nconst a = 1\n```\n\nend.'
    const md = `---
request_id: pb-rt-001
created_at: 2026-05-29T16:00:00+09:00
purpose: rt
target: ${target}
status: pending
kind: skill
---

## 3. 変更後の完成版

\`\`\`\`markdown
${skillBody}
\`\`\`\`
`
    const fp = await writeRequestMd('pb-rt.md', md)
    const req = await parseChangeRequestMd(fp)
    const result = await applyChange(req, 'sesame', paths)
    expect(result.success).toBe(true)
    const written = await readFile(target, 'utf-8')
    expect(written).toBe(skillBody)
    expect(written).toContain('```js')
  })
})

// =============================================================================
//   Phase 1 新規 14 件 (#1-14) — PIKES r1.4 §7-3-A 第 1-7 項対応
// =============================================================================

describe('Phase 1: kind:skill apply (§7-3-A)', () => {
  // #1: 正常 | kind:skill + 認証 OK + allowlist 内 target → 全文置換成功
  it('#1 applies the proposed SKILL.md body when authenticated (kind:skill)', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    const skillDir = join(paths.skillsRoot!, 'test-skill')
    await mkdir(skillDir, { recursive: true })
    const targetPath = join(skillDir, 'SKILL.md')
    await writeFile(targetPath, '# Original\n', 'utf-8')

    const fp = await writeRequestMd(
      's1.md',
      buildValidSkillMd({ target: targetPath, body: '# New skill body\n' })
    )
    const req = await parseChangeRequestMd(fp)
    expect(req.kind).toBe('skill')

    const result = await applyChange(req, 'sesame', paths)
    expect(result.success).toBe(true)
    expect(result.backupPath).toBeDefined()
    const written = await readFile(targetPath, 'utf-8')
    expect(written).toBe('# New skill body\n')
  })

  // #2: 正常 | kind:skill apply 後 post-verify がバイト列等価 PASS
  it('#2 post-verifies skill body with byte-level equality (kind:skill)', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    const skillDir = join(paths.skillsRoot!, 'byte-equal-skill')
    await mkdir(skillDir, { recursive: true })
    const targetPath = join(skillDir, 'SKILL.md')
    await writeFile(targetPath, '# Orig\n', 'utf-8')
    const body = '# Skill A\n\n## Section\n\nContent with\nmultiple lines.\n'
    const fp = await writeRequestMd('s2.md', buildValidSkillMd({ target: targetPath, body }))
    const req = await parseChangeRequestMd(fp)
    const result = await applyChange(req, 'sesame', paths)
    expect(result.success).toBe(true)
    const written = await readFile(targetPath, 'utf-8')
    expect(Buffer.from(written).equals(Buffer.from(body))).toBe(true)
  })

  // #3: 正常 | kind:skill apply 時 backup が取られ、内容が元 body と一致
  //       (rollback 直接テストは fail シナリオ強制が困難なため、rollback 機構の前提となる backup 担保)
  it('#3 takes a backup before overwriting SKILL.md (kind:skill, rollback prerequisite)', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    const skillDir = join(paths.skillsRoot!, 'backup-test-skill')
    await mkdir(skillDir, { recursive: true })
    const targetPath = join(skillDir, 'SKILL.md')
    const originalBody = '# Original skill body\n'
    await writeFile(targetPath, originalBody, 'utf-8')
    const fp = await writeRequestMd(
      's3.md',
      buildValidSkillMd({ target: targetPath, body: '# Updated\n' })
    )
    const req = await parseChangeRequestMd(fp)
    const result = await applyChange(req, 'sesame', paths)
    expect(result.success).toBe(true)
    expect(result.backupPath).toBeDefined()
    expect(existsSync(result.backupPath!)).toBe(true)
    const backupContent = await readFile(result.backupPath!, 'utf-8')
    expect(backupContent).toBe(originalBody)
  })

  // #4: 異常 | allowlist 外 target 拒否
  it('#4 rejects target outside allowlist (e.g. ~/.claude/CLAUDE.md)', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    const outOfList = join(paths.claudeDir, 'CLAUDE.md')
    const fp = await writeRequestMd('s4.md', buildValidSkillMd({ target: outOfList }))
    const req = await parseChangeRequestMd(fp)
    const result = await applyChange(req, 'sesame', paths)
    expect(result.success).toBe(false)
    expect(result.reason).toBe('allowlist-violation')
  })

  // #5: 異常 | kind/target 不整合 (kind:skill + target:settings.json)
  it('#5 rejects mismatched kind/target (kind:skill + target:settings.json)', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    const fp = await writeRequestMd(
      's5.md',
      buildValidSkillMd({ target: paths.settingsJsonPath })
    )
    const req = await parseChangeRequestMd(fp)
    const result = await applyChange(req, 'sesame', paths)
    expect(result.success).toBe(false)
    expect(result.reason).toBe('kind-target-mismatch')
  })

  // #6: 異常 | kind/target 不整合 (kind:settings + target:SKILL.md)
  it('#6 rejects mismatched kind/target (kind:settings + target:SKILL.md)', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    const skillDir = join(paths.skillsRoot!, 'kt-mismatch-skill')
    await mkdir(skillDir, { recursive: true })
    const targetPath = join(skillDir, 'SKILL.md')
    await writeFile(targetPath, '', 'utf-8')
    const fp = await writeRequestMd(
      's6.md',
      buildValidMd({ target: targetPath, proposedJson: '{"x":1}' })
    )
    const req = await parseChangeRequestMd(fp)
    const result = await applyChange(req, 'sesame', paths)
    expect(result.success).toBe(false)
    expect(result.reason).toBe('kind-target-mismatch')
  })

  // #7: 異常 | パストラバーサル ../ 拒否（resolve で .. が解消されると allowlist 外になる）
  it('#7 rejects path traversal via .. (resolves outside allowlist)', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    // skills/foo/../../<escape>/SKILL.md → workdir/<escape>/SKILL.md (allowlist 外)
    const traversal = join(paths.skillsRoot!, 'foo', '..', '..', 'evil', 'SKILL.md')
    const fp = await writeRequestMd('s7.md', buildValidSkillMd({ target: traversal }))
    const req = await parseChangeRequestMd(fp)
    const result = await applyChange(req, 'sesame', paths)
    expect(result.success).toBe(false)
    // resolve で .. が解消され、結果として allowlist 外
    expect(result.reason === 'allowlist-violation' || result.reason === 'parent-not-found').toBe(
      true
    )
  })

  // #8: 異常 | symlink を介した allowlist 逸脱拒否 (realpath で外部に解決される)
  it('#8 rejects symlink targets that escape allowlist via realpath', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    const skillDir = join(paths.skillsRoot!, 'sym-skill')
    await mkdir(skillDir, { recursive: true })
    const realDir = join(workdir, 'external')
    await mkdir(realDir, { recursive: true })
    const realFile = join(realDir, 'SKILL.md')
    await writeFile(realFile, '# External\n', 'utf-8')
    const symPath = join(skillDir, 'SKILL.md')
    try {
      await symlink(realFile, symPath)
    } catch {
      // Windows で symlink 作成権限なし等: テストを skip 扱い（vitest 仕様で early return は PASS）
      return
    }
    const fp = await writeRequestMd('s8.md', buildValidSkillMd({ target: symPath }))
    const req = await parseChangeRequestMd(fp)
    const result = await applyChange(req, 'sesame', paths)
    expect(result.success).toBe(false)
    // realpath で外部 (workdir/external/SKILL.md) に解決され、allowlist 外
    expect(result.reason).toBe('allowlist-violation')
  })

  // #9: 異常 | UNC パス拒否
  it('#9 rejects UNC paths', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    const fp = await writeRequestMd(
      's9.md',
      buildValidSkillMd({ target: '\\\\server\\share\\foo\\SKILL.md' })
    )
    const req = await parseChangeRequestMd(fp)
    const result = await applyChange(req, 'sesame', paths)
    expect(result.success).toBe(false)
    expect(result.reason).toBe('unc-not-allowed')
  })

  // #10: 異常 | glob メタ文字含む target 拒否
  it('#10 rejects glob metacharacters in target', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    const globTarget = join(paths.skillsRoot!, '*', 'SKILL.md')
    const fp = await writeRequestMd('s10.md', buildValidSkillMd({ target: globTarget }))
    const req = await parseChangeRequestMd(fp)
    const result = await applyChange(req, 'sesame', paths)
    expect(result.success).toBe(false)
    expect(result.reason).toBe('glob-not-allowed')
  })

  // #11: 異常 | auth.password 未設定 + kind:skill 拒否
  it('#11 rejects kind:skill apply when auth.password is not configured', async () => {
    await writeSettings({ hello: 'world' }) // no auth.password
    const skillDir = join(paths.skillsRoot!, 'noauth-skill')
    await mkdir(skillDir, { recursive: true })
    const targetPath = join(skillDir, 'SKILL.md')
    await writeFile(targetPath, '', 'utf-8')
    const fp = await writeRequestMd('s11.md', buildValidSkillMd({ target: targetPath }))
    const req = await parseChangeRequestMd(fp)
    const result = await applyChange(req, '', paths)
    expect(result.success).toBe(false)
    expect(result.reason).toBe('auth-missing-for-skill')
  })

  // #12: 後方互換 | auth.password 未設定 + kind:settings 引き続き許可
  it('#12 allows kind:settings apply when auth.password is not configured (backwards compat)', async () => {
    await writeSettings({ hello: 'world' }) // no auth.password
    const fp = await writeRequestMd('s12.md', buildValidMd({ proposedJson: '{"foo":"bar"}' }))
    const req = await parseChangeRequestMd(fp)
    const result = await applyChange(req, '', paths)
    expect(result.success).toBe(true)
  })

  // #13: 異常 (MN-1) | 不明な kind 値 (kind: invalid) → parseError
  it('#13 rejects MD with unknown kind value (MN-1)', async () => {
    const fp = await writeRequestMd('s13.md', buildValidMd({ kind: 'invalid' }))
    await expect(parseChangeRequestMd(fp)).rejects.toThrow(/invalid kind/)
  })

  // #14 (Part B FB で仕様反転): 新規 skill 採用で親 <name>/ が未作成でも、
  //     skills/ が存在し allowlist 深さ1 に合致するなら親を自動作成して採用成功する。
  it('#14 auto-creates the parent dir for a new skill adoption (parent absent → success)', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    // skills root はあるが、その下の <name> ディレクトリは未作成（新規採用の常態）
    const newTarget = join(paths.skillsRoot!, 'brand-new-skill', 'SKILL.md')
    expect(existsSync(join(paths.skillsRoot!, 'brand-new-skill'))).toBe(false)
    const fp = await writeRequestMd(
      's14.md',
      buildValidSkillMd({ target: newTarget, body: '# brand new\n' })
    )
    const req = await parseChangeRequestMd(fp)
    const result = await applyChange(req, 'sesame', paths)
    expect(result.success).toBe(true)
    expect(existsSync(newTarget)).toBe(true)
    expect(await readFile(newTarget, 'utf-8')).toBe('# brand new\n')
  })

  // #14b: 深さ2 以降は allowlist (深さ1 glob) が拒否（自動作成は深さ1 の skill のみ）
  it('#14b still rejects depth>1 targets under skills/ (allowlist-violation)', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    const deep = join(paths.skillsRoot!, 'a', 'b', 'SKILL.md')
    const fp = await writeRequestMd('s14b.md', buildValidSkillMd({ target: deep }))
    const req = await parseChangeRequestMd(fp)
    const result = await applyChange(req, 'sesame', paths)
    expect(result.success).toBe(false)
    expect(result.reason).toBe('allowlist-violation')
  })
})

// =============================================================================
//   Part B Phase 1 (B4前半): 同名採用基本禁止 + provenance 記録 + 緊急 override 判定 (判断H)
// =============================================================================

describe('Part B Phase 1: golden-name-collision guard + provenance (applyChange opts)', () => {
  const provPaths = (): ProvenancePaths => ({
    adoptedRegistryPath: join(paths.parcFermeDir, 'adopted-skills.json'),
    emergencyOverridesPath: join(paths.parcFermeDir, 'emergency-overrides.json')
  })

  async function prepSkillDir(name: string): Promise<string> {
    const skillDir = join(paths.skillsRoot!, name)
    await mkdir(skillDir, { recursive: true })
    return join(skillDir, 'SKILL.md')
  }

  it('rejects adopting a skill whose name collides with a golden skill', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    const target = await prepSkillDir('report') // golden skill name
    const fp = await writeRequestMd('coll.md', buildValidSkillMd({ target, body: '# x\n' }))
    const req = await parseChangeRequestMd(fp)
    const result = await applyChange(req, 'sesame', paths, {
      goldenSkillNames: ['report', 'investigation'],
      provenancePaths: provPaths()
    })
    expect(result.success).toBe(false)
    expect(result.reason).toBe('golden-name-collision')
    expect(existsSync(target)).toBe(false) // backup/write 前に弾く
  })

  it('allows a non-colliding skill and records provenance (source=adopted)', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    const target = await prepSkillDir('my-new-flow')
    const fp = await writeRequestMd('ok.md', buildValidSkillMd({ target, body: '# new\n' }))
    const req = await parseChangeRequestMd(fp)
    const pp = provPaths()
    const result = await applyChange(req, 'sesame', paths, {
      goldenSkillNames: ['report', 'investigation'],
      provenancePaths: pp,
      currentGoldenVersion: '1.4.0'
    })
    expect(result.success).toBe(true)
    const reg = await readAdoptedRegistry(pp)
    const entry = reg.find((e) => e.name === 'my-new-flow')
    expect(entry).toBeDefined()
    expect(entry!.source).toBe('adopted')
    expect(entry!.goldenVersionAtAdoption).toBe('1.4.0')
    expect(entry!.hash.length).toBeGreaterThan(0)
  })

  it('allows same-name adoption when a valid emergency override exists (source=emergency)', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    const target = await prepSkillDir('report')
    const pp = provPaths()
    await mkdir(paths.parcFermeDir, { recursive: true })
    const override: EmergencyOverride = {
      name: 'report',
      goldenVersion: '1.4.0',
      reason: 'golden report skill bug',
      drDecisionId: 'dr-001',
      createdAt: '2026-05-29T00:00:00Z'
    }
    await writeFile(pp.emergencyOverridesPath, JSON.stringify([override]), 'utf-8')
    const fp = await writeRequestMd('emg.md', buildValidSkillMd({ target, body: '# patched\n' }))
    const req = await parseChangeRequestMd(fp)
    const result = await applyChange(req, 'sesame', paths, {
      goldenSkillNames: ['report'],
      provenancePaths: pp,
      currentGoldenVersion: '1.4.0' // 未前進 → override 有効
    })
    expect(result.success).toBe(true)
    const reg = await readAdoptedRegistry(pp)
    expect(reg.find((e) => e.name === 'report')?.source).toBe('emergency')
  })

  it('rejects same-name when golden version advanced past the override (auto-expiry, Codex#4)', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    const target = await prepSkillDir('report')
    const pp = provPaths()
    await mkdir(paths.parcFermeDir, { recursive: true })
    await writeFile(
      pp.emergencyOverridesPath,
      JSON.stringify([
        {
          name: 'report',
          goldenVersion: '1.4.0',
          reason: 'bug',
          drDecisionId: 'dr-001',
          createdAt: '2026-05-29T00:00:00Z'
        }
      ]),
      'utf-8'
    )
    const fp = await writeRequestMd('exp.md', buildValidSkillMd({ target, body: '# x\n' }))
    const req = await parseChangeRequestMd(fp)
    const result = await applyChange(req, 'sesame', paths, {
      goldenSkillNames: ['report'],
      provenancePaths: pp,
      currentGoldenVersion: '1.5.0' // 前進 → override 失効
    })
    expect(result.success).toBe(false)
    expect(result.reason).toBe('golden-name-collision')
  })

  it('skips collision check entirely when goldenSkillNames is not provided (backwards compat)', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    const target = await prepSkillDir('report') // golden 名だが opts 未指定なので素通り
    const fp = await writeRequestMd('compat.md', buildValidSkillMd({ target, body: '# x\n' }))
    const req = await parseChangeRequestMd(fp)
    const result = await applyChange(req, 'sesame', paths)
    expect(result.success).toBe(true)
  })
})

// =============================================================================
//   Part B Phase 1 (B4後半): ケース2 先行衝突 / ロック / 緊急 override ライフサイクル
// =============================================================================

describe('Part B Phase 1 (B4後半): case-2 collision / lock / emergency lifecycle', () => {
  const provPaths = (): ProvenancePaths => ({
    adoptedRegistryPath: join(paths.parcFermeDir, 'adopted-skills.json'),
    emergencyOverridesPath: join(paths.parcFermeDir, 'emergency-overrides.json')
  })

  it('case-2: adopts under a temp name when a non-golden pre-existing skill collides (no clobber)', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    const dir = join(paths.skillsRoot!, 'preexist')
    await mkdir(dir, { recursive: true })
    const target = join(dir, 'SKILL.md')
    await writeFile(target, '# preexisting user skill\n', 'utf-8') // 先行（レジストリ未登録）

    const fp = await writeRequestMd(
      'c2.md',
      buildValidSkillMd({
        target,
        body: '---\nname: preexist\ndescription: new\n---\n\n# new body\n'
      })
    )
    const req = await parseChangeRequestMd(fp)
    const pp = provPaths()
    const result = await applyChange(req, 'sesame', paths, {
      goldenSkillNames: ['report'], // 'preexist' は非 golden
      provenancePaths: pp
    })
    expect(result.success).toBe(true)
    expect(result.renamedTo).toMatch(/^preexist-adopted-/)
    // 先行は無傷（clobber しない）
    expect(await readFile(target, 'utf-8')).toBe('# preexisting user skill\n')
    // 一時名で採用 + 警告ヘッダ
    const tempTarget = join(paths.skillsRoot!, result.renamedTo!, 'SKILL.md')
    expect(existsSync(tempTarget)).toBe(true)
    const written = await readFile(tempTarget, 'utf-8')
    expect(written).toContain('name: preexist')
    expect(written).toContain('name-collision')
    // ~/.ccpit/reports/ にレポート
    const reportsDir = join(paths.parcFermeDir, 'reports')
    const reports = existsSync(reportsDir) ? await readdir(reportsDir) : []
    expect(reports.some((f) => f.includes('name-collision'))).toBe(true)
  })

  it('case-2: does NOT trigger for an own adopted skill update (in registry → overwrite)', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    const dir = join(paths.skillsRoot!, 'mine')
    await mkdir(dir, { recursive: true })
    const target = join(dir, 'SKILL.md')
    await writeFile(target, '# v1\n', 'utf-8')
    const pp = provPaths()
    await upsertAdoptedSkill(
      { name: 'mine', target, hash: 'h', adoptedAt: 't', source: 'adopted' },
      pp
    )
    const fp = await writeRequestMd('mine.md', buildValidSkillMd({ target, body: '# v2\n' }))
    const req = await parseChangeRequestMd(fp)
    const result = await applyChange(req, 'sesame', paths, {
      goldenSkillNames: ['report'],
      provenancePaths: pp
    })
    expect(result.success).toBe(true)
    expect(result.renamedTo).toBeUndefined()
    expect(await readFile(target, 'utf-8')).toBe('# v2\n') // 更新上書き
  })

  it('lock: concurrent adoptions serialize without losing registry entries', async () => {
    await writeSettings({ auth: { password: 'sesame' } })
    const pp = provPaths()
    const mk = async (name: string): Promise<ChangeRequest> => {
      await mkdir(join(paths.skillsRoot!, name), { recursive: true })
      const fp = await writeRequestMd(
        `${name}.md`,
        buildValidSkillMd({ target: join(paths.skillsRoot!, name, 'SKILL.md'), body: `# ${name}\n` })
      )
      return parseChangeRequestMd(fp)
    }
    const reqs = await Promise.all([mk('lk1'), mk('lk2'), mk('lk3')])
    const results = await Promise.all(
      reqs.map((r) =>
        applyChange(r, 'sesame', paths, { goldenSkillNames: ['report'], provenancePaths: pp })
      )
    )
    expect(results.every((r) => r.success)).toBe(true)
    const reg = await readAdoptedRegistry(pp)
    expect(reg.filter((e) => ['lk1', 'lk2', 'lk3'].includes(e.name))).toHaveLength(3)
  })

  it('emergency override: create → valid → remove; version-advance marks obsolete', async () => {
    const pp = provPaths()
    await createEmergencyOverride(
      {
        name: 'report',
        goldenVersion: '1.4.0',
        reason: 'golden report skill bug',
        drDecisionId: 'dr-100',
        createdAt: '2026-05-30T00:00:00Z'
      },
      pp
    )
    const overrides = await readEmergencyOverrides(pp)
    expect(isEmergencyOverrideValid('report', overrides, { currentGoldenVersion: '1.4.0' })).toBe(true)
    // 版前進 → 陳腐化リストに乗る（自動失効）
    const obsolete = await listObsoleteOverrides({ currentGoldenVersion: '1.5.0' }, pp)
    expect(obsolete.some((o) => o.name === 'report')).toBe(true)
    // Dr 削除導線
    await removeEmergencyOverride('report', pp)
    expect(await readEmergencyOverrides(pp)).toHaveLength(0)
  })

  it('emergency override: create rejects missing scope fields', async () => {
    const pp = provPaths()
    await expect(
      createEmergencyOverride(
        // @ts-expect-error 故意に不足
        { name: 'report' },
        pp
      )
    ).rejects.toThrow(/requires/)
  })
})
