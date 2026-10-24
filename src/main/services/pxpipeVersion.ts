import versionData from '../../../resources/pxpipe-version.json'

/**
 * pxpipe の対象バージョンおよびパッケージ指定の一本化モジュール。
 * 正本: ccpit/resources/pxpipe-version.json
 */
export const PXPIPE_TARGET_VERSION: string = versionData.version
export const PXPIPE_PACKAGE: string = `pxpipe-proxy@${PXPIPE_TARGET_VERSION}`

