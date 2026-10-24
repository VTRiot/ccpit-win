import { app, BrowserWindow, type WebContents } from 'electron'
import { getIsolationStatus, isIsolatedLaunch } from './isolation'

export const ISOLATION_BANNER_ID = 'app-isolation-banner'
export const ISOLATION_TITLE_PREFIX = '【隔離】'

export function isolationBannerText(root: string): string {
  return `隔離中（本物のデータ・動作中の本物のアプリには触れません） root: ${root}`
}

/**
 * 画面の最上部に固定の帯を差し込む JS。何度実行しても帯は 1 つ（既にあれば文言だけ更新する）。
 * renderer のソースを編集せず、主処理から差し込む。
 */
export function buildIsolationBannerScript(text: string): string {
  const css =
    'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:2px 8px;font:12px/1.5 sans-serif;' +
    'background:#b45309;color:#fff;text-align:center;pointer-events:none;opacity:.95'
  return `(() => {
    const id = ${JSON.stringify(ISOLATION_BANNER_ID)};
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.setAttribute('style', ${JSON.stringify(css)});
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = ${JSON.stringify(text)};
    return true;
  })()`
}

function isWindowContents(wc: WebContents): boolean {
  try {
    return wc.getType() === 'window'
  } catch {
    return false
  }
}

/**
 * 隔離中だけ、全ての窓に「隔離中」の帯と窓タイトルの印を付ける。
 * reload・遷移・エラーページ・窓の再作成のたびに差し込み直し、成否を標準出力へ記録する
 * （帯が出せなくても、窓タイトルの印は renderer の DOM に依存せず残る）。
 */
export function installIsolationBanner(): void {
  if (!isIsolatedLaunch()) return
  const text = isolationBannerText(getIsolationStatus().root ?? '')
  const script = buildIsolationBannerScript(text)

  app.on('web-contents-created', (_e, wc) => {
    if (!isWindowContents(wc)) return

    const inject = (why: string): void => {
      if (wc.isDestroyed()) return
      wc.executeJavaScript(script).then(
        () =>
          console.log(`[CCPIT-Isolation] banner injected (${why}) url=${wc.getURL().slice(0, 80)}`),
        (err: unknown) =>
          console.error(`[CCPIT-Isolation] banner inject failed (${why}): ${String(err)}`)
      )
    }
    const markTitle = (): void => {
      const win = BrowserWindow.fromWebContents(wc)
      if (!win || win.isDestroyed()) return
      const cur = win.getTitle()
      if (!cur.startsWith(ISOLATION_TITLE_PREFIX)) win.setTitle(ISOLATION_TITLE_PREFIX + cur)
    }

    wc.on('dom-ready', () => {
      markTitle()
      inject('dom-ready')
    })
    wc.on('did-finish-load', () => inject('did-finish-load'))
    wc.on('did-navigate', () => inject('did-navigate'))
    wc.on('did-navigate-in-page', () => inject('did-navigate-in-page'))
    wc.on('page-title-updated', (e, title) => {
      if (title.startsWith(ISOLATION_TITLE_PREFIX)) return
      e.preventDefault()
      markTitle()
    })
  })
}
