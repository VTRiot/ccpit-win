import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, writeFile, readFile } from 'fs/promises'
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
    parcFermeDir,
    backupsDir: join(parcFermeDir, 'settings-backups'),
    changeLogPath: join(parcFermeDir, 'settings-change-log.jsonl')
  }
  await mkdir(claudeDir, { recursive: true })
})

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true })
})

async function writeSettings(content: object | string): Promise<void> {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
  await writeFile(paths.settingsJsonPath, text, 'utf-8')
}

function buildValidMd(
  opts: {
    requestId?: string
    status?: string
    proposedJson?: string
  } = {}
): string {
  const requestId = opts.requestId ?? 'test-req-001'
  const status = opts.status ?? 'pending'
  const proposedJson = opts.proposedJson ?? '{"hello": "world", "auth": {"password": "kept"}}'
  return `---
request_id: ${requestId}
created_at: 2026-05-01T19:00:00Z
purpose: test change request
target: ~/.claude/settings.json
status: ${status}
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

async function writeRequestMd(filename: string, content: string): Promise<string> {
  const filePath = join(workdir, filename)
  await writeFile(filePath, content, 'utf-8')
  return filePath
}

describe('parseChangeRequestMd', () => {
  it('parses a well-formed change request', async () => {
    const fp = await writeRequestMd('req.md', buildValidMd())
    const req = await parseChangeRequestMd(fp)
    expect(req.frontmatter.request_id).toBe('test-req-001')
    expect(req.frontmatter.status).toBe('pending')
    expect(req.frontmatter.target).toBe('~/.claude/settings.json')
    expect(req.parseError).toBeNull()
    expect(req.proposedSettingsParsed).toEqual({
      hello: 'world',
      auth: { password: 'kept' }
    })
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
    expect(req.proposedSettingsParsed).toBeNull()
    // The raw string is still preserved
    expect(req.proposedSettingsJson).toContain('invalid json')
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
