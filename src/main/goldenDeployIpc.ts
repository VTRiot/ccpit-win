import type { IpcMain } from 'electron'
import { previewDeploy, previewSettingsLayers, deploy, type DeployOptions } from './services/golden'

/**
 * golden の配り直しの IPC（L0_013）。試験が handler を直接呼べるよう `ipc.ts` から切り出した。
 *
 * `golden:deploy` の第 3 引数は下見（`golden:previewSettingsLayers`）が返した承認の印。
 * 手元の層を外す・書き換える項目があるとき、印が今の計画と一致しなければ main が何も書かずに拒否する
 * （画面を通らない呼び出しでも同じ）。
 */
export function registerGoldenDeployIpc(ipcMain: Pick<IpcMain, 'handle'>): void {
  ipcMain.handle('golden:preview', (_e, templateName: string) => previewDeploy(templateName))
  ipcMain.handle('golden:previewSettingsLayers', (_e, templateName: string) =>
    previewSettingsLayers(templateName)
  )
  ipcMain.handle('golden:deploy', (_e, templateName: string, password: string, opts?: unknown) =>
    deploy(templateName, password, toDeployOptions(opts))
  )
}

/** renderer から来た値は信用しない: 印は文字列のときだけ渡す */
function toDeployOptions(raw: unknown): DeployOptions {
  if (raw && typeof raw === 'object') {
    const s = (raw as { settingsApproval?: unknown }).settingsApproval
    if (typeof s === 'string') return { settingsApproval: s }
  }
  return {}
}
