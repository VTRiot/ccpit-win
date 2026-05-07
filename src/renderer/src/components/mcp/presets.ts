/**
 * MCP server プリセット集（Mode A 用）。
 * 新しいプリセットを足すときは id をユニークに、disabledTools には write 系のみ列挙する。
 */

import { isWriteToolName } from '../../lib/mcp/writeKeywordsView'

export interface McpPreset {
  id: string
  name: string
  description: string
  command: string
  args: string[]
  env: Record<string, string>
  /** disabledTools に登録する候補。write 系を初期 disable する設計。 */
  disabledTools: string[]
}

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: 'deepwiki',
    name: 'deepwiki',
    description: 'Read-only public docs/wiki access',
    command: 'npx',
    args: ['-y', 'mcp-deepwiki@latest'],
    env: {},
    disabledTools: []
  },
  {
    id: 'github',
    name: 'github',
    description: 'GitHub API access — write tools auto-disabled',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' },
    disabledTools: [
      'create_or_update_file',
      'delete_file',
      'create_issue',
      'update_issue',
      'create_pull_request',
      'merge_pull_request',
      'create_repository',
      'delete_repository',
      'push_files',
      'add_issue_comment'
    ]
  }
] as const

export function findPreset(id: string): McpPreset | undefined {
  return MCP_PRESETS.find((p) => p.id === id)
}

/** disabledTools のうち write と判定された tools のみ抽出。UI 表示用。 */
export function filterAutoDisabled(tools: readonly string[]): string[] {
  return tools.filter(isWriteToolName)
}
