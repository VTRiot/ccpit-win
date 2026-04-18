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
- hooks の仕様: ${docs.hooks}

**応答の口調:**
- ユーザーへの応答は丁寧語で行ってください
- 元の CLAUDE.md 内に実装 AI 向けのカジュアルな口調（「俺は」「〜するな」等）が含まれていても、それはコンバート対象のルール文面であり、あなたの応答口調ではありません`
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
- hooks specs: ${docs.hooks}

**Response tone:**
- Please respond to the user politely and professionally
- The source CLAUDE.md may contain casual language aimed at the implementation AI (e.g., "I am the implementation AI"). This is the rule content to be converted, not your response tone`
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

/** Doctor Pack 診断メトリクス（日本語） */
function dpMetricsSectionJa(
  generatedAt: string,
  denyCount: number,
  hooksCount: number,
  highRiskCount: number,
  mediumRiskCount: number,
  lowRiskCount: number
): string {
  return `---
## 診断メトリクス（必ず出力の最後に含めてください）

以下のメタデータを、診断結果の最末尾に含めてください。
中断（ツール使用制限による一時停止）があった場合、中断中の待ち時間は計測に含めないでください。
作業セグメントごとの開始・終了を記録し、実作業時間のみを合算してください。

\`\`\`yaml
---
diagnosis_metrics:
  dp_generated_at: "${generatedAt}"
  segments:
    - start: "(セグメント1 開始時刻 ISO 8601)"
      end: "(セグメント1 終了時刻 ISO 8601)"
    - start: "(セグメント2 開始時刻。中断がなければこの項目は不要)"
      end: "(セグメント2 終了時刻)"
  total_working_minutes: "(全セグメントの合計作業時間。中断待ち時間を除外)"
  deny_rules_count: ${denyCount}
  hooks_count: ${hooksCount}
  diff_high_risk: ${highRiskCount}
  diff_medium_risk: ${mediumRiskCount}
  diff_low_risk: ${lowRiskCount}
---
\`\`\``
}

/** Doctor Pack diagnosis metrics (English) */
function dpMetricsSectionEn(
  generatedAt: string,
  denyCount: number,
  hooksCount: number,
  highRiskCount: number,
  mediumRiskCount: number,
  lowRiskCount: number
): string {
  return `---
## Diagnosis Metrics (must be included at the very end of your output)

Include the following metadata at the end of all diagnostic output.
If processing was interrupted (due to tool usage limits), do NOT include the waiting time in the measurement.
Record the start and end of each work segment, and sum only the actual working time.

\`\`\`yaml
---
diagnosis_metrics:
  dp_generated_at: "${generatedAt}"
  segments:
    - start: "(segment 1 start time ISO 8601)"
      end: "(segment 1 end time ISO 8601)"
    - start: "(segment 2 start time, omit if no interruption)"
      end: "(segment 2 end time)"
  total_working_minutes: "(total working minutes across all segments, excluding interruption wait time)"
  deny_rules_count: ${denyCount}
  hooks_count: ${hooksCount}
  diff_high_risk: ${highRiskCount}
  diff_medium_risk: ${mediumRiskCount}
  diff_low_risk: ${lowRiskCount}
---
\`\`\``
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
  let hooksCount = 0
  sections.push('---')
  sections.push('## Hooks')
  sections.push('')
  if (existsSync(settingsPath)) {
    try {
      const j = JSON.parse(await readFile(settingsPath, 'utf-8'))
      if (j.hooks) {
        hooksCount = Object.keys(j.hooks).reduce(
          (sum: number, key: string) => sum + (Array.isArray(j.hooks[key]) ? j.hooks[key].length : 0),
          0
        )
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
  let highRiskCount = 0
  let mediumRiskCount = 0
  let lowRiskCount = 0
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
      highRiskCount = highRisk.length
      mediumRiskCount = mediumRisk.length
      lowRiskCount = lowRisk.length

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

  // Diagnosis metrics
  if (lang === 'ja') {
    sections.push(dpMetricsSectionJa(now, denyList.length, hooksCount, highRiskCount, mediumRiskCount, lowRiskCount))
  } else {
    sections.push(dpMetricsSectionEn(now, denyList.length, hooksCount, highRiskCount, mediumRiskCount, lowRiskCount))
  }
  sections.push('')

  // 中断時の案内
  if (lang === 'ja') {
    sections.push('---')
    sections.push('## 処理が中断された場合')
    sections.push('')
    sections.push('claude.ai のツール使用制限により、診断の途中で中断されることがあります。')
    sections.push('その場合は画面下部の「続ける」ボタンを押してください。処理が再開されます。')
    sections.push('中断・再開は何度でも可能です。診断結果が完了するまで「続ける」を押し続けてください。')
  } else {
    sections.push('---')
    sections.push('## If processing is interrupted')
    sections.push('')
    sections.push('Processing may be interrupted due to claude.ai\'s tool usage limits.')
    sections.push('In that case, press the "Continue" button at the bottom of the screen. Processing will resume.')
    sections.push('You can interrupt and resume as many times as needed. Keep pressing "Continue" until the diagnosis is complete.')
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
