import { writeFile, mkdir, readFile, readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { diffSnapshot, listSnapshots } from './recovery'
import { getDenyList } from './health'
import { getConfig, type Language } from './appConfig'
import { CCPIT_VERSION, GITHUB_URL, CLAUDE_CODE_DOCS, AI_GUIDES } from './constants'

/** Doctor Pack 役割定義（日本語） */
function dpRoleSectionJa(docs: typeof CLAUDE_CODE_DOCS): string {
  return `---
## あなたの役割

あなたは CCPIT（Claude Code Protocol Interlock Tower）の診断 AI です。
ユーザーの Claude Code 環境に問題が発生した際に、Doctor Pack の情報をもとに原因分析と修正手順を提供します。

## MANX Protocol の安全設計（詳細は以下を参照）

以下の URL にアクセスし、MANX の安全設計を理解した上で診断してください:
${AI_GUIDES.ja.diagnosis}

MANX Protocol の全体像:
${AI_GUIDES.ja.summary}

## 重要: 最新の Claude Code 仕様を確認してください

診断にあたり、以下の公式ドキュメントを参照して最新仕様と照合してください:

- CLAUDE.md の仕様: ${docs.memory}
- settings.json の仕様: ${docs.settings}
- hooks の仕様: ${docs.hooks}`
}

/** Doctor Pack role section (English) */
function dpRoleSectionEn(docs: typeof CLAUDE_CODE_DOCS): string {
  return `---
## Your Role

You are the diagnostic AI for CCPIT (Claude Code Protocol Interlock Tower).
When issues occur in the user's Claude Code environment, you provide root cause analysis and remediation steps based on the Doctor Pack information.

## MANX Protocol Safety Design (See details below)

Access the following URL to understand MANX safety design before diagnosis:
${AI_GUIDES.en.diagnosis}

MANX Protocol overview:
${AI_GUIDES.en.summary}

## Important: Check the Latest Claude Code Specifications

Before diagnosis, review the following official documentation to cross-reference with the latest specs:

- CLAUDE.md specs: ${docs.memory}
- settings.json specs: ${docs.settings}
- hooks specs: ${docs.hooks}`
}

/** Doctor Pack ガイドテキスト（日本語） */
function dpGuideSectionJa(): string {
  return `---
## claude.ai への依頼（このまま送信してください）

上記の Doctor Pack を分析し、以下について回答してください:

1. **症状の原因分析:** Symptom Note と Diff Summary（特に High-Risk Changes）を照合し、考えられる原因を特定してください。deny / hooks / CLAUDE.md / rules / skills のどの層に問題があるかを切り分けてください
2. **推奨される修正手順:** 具体的な修正手順を優先度付きで提示してください。settings.json の修正が必要な場合は、ユーザーが手動で編集する必要がある旨を明記してください（CC は settings.json を変更できません）
3. **再発防止策:** 同じ問題が再発しないための対策を、MANX Protocol の設計原則に沿って提案してください
4. **公式仕様との矛盾チェック:** Deny Rules や Hooks の設定に、現在の Claude Code 公式仕様と矛盾するものがないか確認してください`
}

/** Doctor Pack guide section (English) */
function dpGuideSectionEn(): string {
  return `---
## Request for claude.ai (Send as-is)

Please analyze the Doctor Pack above and respond to the following:

1. **Root Cause Analysis:** Cross-reference the Symptom Note with the Diff Summary (especially High-Risk Changes) and identify likely causes. Determine which layer is affected: deny / hooks / CLAUDE.md / rules / skills
2. **Recommended Fix Steps:** Provide specific remediation steps with priority ranking. If settings.json needs modification, note that the user must edit it manually (CC cannot modify settings.json)
3. **Recurrence Prevention:** Propose measures to prevent the same issue from recurring, aligned with MANX Protocol design principles
4. **Official Spec Conflict Check:** Verify that the Deny Rules and Hooks configurations do not conflict with current Claude Code official specifications`
}

/** Doctor Pack を生成 */
export async function generateDoctorPack(symptom: string): Promise<string> {
  const sections: string[] = []
  const now = new Date().toISOString()
  const lang: Language = getConfig().language

  // Metadata
  sections.push('# Doctor Pack — CCPIT Diagnostic Report')
  sections.push('')
  sections.push(`Generated: ${now}`)
  sections.push(`Platform: ${process.platform}`)
  sections.push(`Electron: ${process.versions.electron}`)
  sections.push('')

  // Role definition + official docs reference
  if (lang === 'ja') {
    sections.push(dpRoleSectionJa(CLAUDE_CODE_DOCS))
  } else {
    sections.push(dpRoleSectionEn(CLAUDE_CODE_DOCS))
  }
  sections.push('')

  // Symptom
  sections.push('---')
  sections.push('## Symptom')
  sections.push('')
  sections.push(symptom)
  sections.push('')

  // Deny rules
  const denyList = await getDenyList()
  sections.push('---')
  sections.push(`## Deny Rules (${denyList.length})`)
  sections.push('')
  if (denyList.length > 0) {
    for (const rule of denyList) {
      sections.push(`- \`${rule}\``)
    }
  } else {
    sections.push('No deny rules configured.')
  }
  sections.push('')

  // Hooks status (MANX hooks Phase 1)
  const claudeDir = join(app.getPath('home'), '.claude')
  const hooksDir = join(claudeDir, 'hooks')
  const settingsPath = join(claudeDir, 'settings.json')
  sections.push('---')
  sections.push('## Hooks')
  sections.push('')
  if (existsSync(settingsPath)) {
    try {
      const j = JSON.parse(await readFile(settingsPath, 'utf-8'))
      if (j.hooks) {
        sections.push('### Definitions (from settings.json)')
        sections.push('')
        sections.push('```json')
        sections.push(JSON.stringify(j.hooks, null, 2))
        sections.push('```')
        sections.push('')
      } else {
        sections.push('No hooks configured in settings.json')
        sections.push('')
      }
    } catch {
      sections.push('Invalid settings.json — cannot read hooks')
      sections.push('')
    }
  }
  sections.push('### Script Files')
  sections.push('')
  if (existsSync(hooksDir)) {
    const entries = (await readdir(hooksDir)).filter((n) => n.endsWith('.sh'))
    if (entries.length === 0) {
      sections.push('- (no .sh scripts in hooks/)')
    } else {
      for (const name of entries) {
        const p = join(hooksDir, name)
        const st = await stat(p)
        const mode = (st.mode & 0o777).toString(8)
        const exec = (st.mode & 0o111) !== 0 ? 'exec' : 'NOT-EXEC'
        sections.push(`- ${name} — size=${st.size}, mode=${mode}, ${exec}`)
      }
    }
  } else {
    sections.push('- hooks/ directory not found')
  }
  sections.push('')

  // Diff summary (vs latest snapshot)
  const snapshots = await listSnapshots()
  if (snapshots.length > 0) {
    const latestId = snapshots[0].id
    const diffs = await diffSnapshot(latestId)

    sections.push('---')
    sections.push(`## Diff Summary (vs snapshot ${latestId})`)
    sections.push('')

    if (diffs.length === 0) {
      sections.push('No differences found.')
    } else {
      // Risk scoring
      const highRisk = diffs.filter((d) => d.risk === 'high')
      const mediumRisk = diffs.filter((d) => d.risk === 'medium')
      const lowRisk = diffs.filter((d) => d.risk === 'low')

      sections.push(`| Risk | Count |`)
      sections.push(`|------|-------|`)
      sections.push(`| High | ${highRisk.length} |`)
      sections.push(`| Medium | ${mediumRisk.length} |`)
      sections.push(`| Low | ${lowRisk.length} |`)
      sections.push('')

      // High-risk details
      if (highRisk.length > 0) {
        sections.push('### High-Risk Changes')
        sections.push('')
        for (const diff of highRisk) {
          sections.push(`#### ${diff.relativePath} (${diff.status})`)
          if (diff.status === 'modified' && diff.currentContent) {
            sections.push('```')
            sections.push(diff.currentContent)
            sections.push('```')
          }
          sections.push('')
        }
      }

      // All changes list
      sections.push('### All Changes')
      sections.push('')
      for (const diff of diffs) {
        sections.push(`- [${diff.risk.toUpperCase()}] ${diff.relativePath} — ${diff.status}`)
      }
    }
  } else {
    sections.push('---')
    sections.push('## Diff Summary')
    sections.push('')
    sections.push('No snapshots available for comparison.')
  }

  // claude.ai への依頼ガイド
  sections.push('')
  if (lang === 'ja') {
    sections.push(dpGuideSectionJa())
  } else {
    sections.push(dpGuideSectionEn())
  }
  sections.push('')
  sections.push('---')
  sections.push(`> Generated by CCPIT v${CCPIT_VERSION} | Protocol Interlock Tower`)
  sections.push(`> ${GITHUB_URL}`)

  return sections.join('\n')
}

/** Doctor Pack をファイルに保存 */
export async function saveDoctorPack(
  content: string,
  outputDir: string
): Promise<string> {
  await mkdir(outputDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `doctor-pack-${timestamp}.md`
  const filePath = join(outputDir, filename)
  await writeFile(filePath, content, 'utf-8')
  return filePath
}

/** Doctor Pack のデフォルト出力先を取得 */
export function getDefaultOutputDir(): string {
  return app.getPath('desktop')
}
