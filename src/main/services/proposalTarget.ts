/**
 * proposalTarget — 提案 MD の frontmatter `target` から、宛先の skill 名を取り出す（葉モジュール）。
 *
 * 候補の走査（goldenPromotion.scanProposalCandidates）と、合成の元提案の選択（composeIpc の composeSelectable）が
 * 同じ規則で skill を決めるため、1 か所に置く。取れない target は null。
 */
export function skillNameFromProposalTarget(target: string): string | null {
  // target 例: '~/.claude/skills/foo/SKILL.md', 'ccpit/golden/common/ja/skills/foo/SKILL.md', 'skills/foo' 等
  const m =
    target.match(
      /(?:[/\\]\.claude[/\\]skills|(?:\.agents|ccpit\/golden\/common\/ja)[/\\]skills|^skills)[/\\]([^/\\]+)/i
    ) || target.match(/~[/\\]\.claude[/\\]skills[/\\]([^/\\]+)/i)
  return m ? m[1] : null
}
