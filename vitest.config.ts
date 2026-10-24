import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/main/**/*.test.ts', 'src/renderer/**/*.test.ts'],
    globals: false,
    reporters: ['default'],
    // git を何度も起動する試験は単独で 4 秒近くかかり、複数の作業者が同時に動く環境では既定の 5 秒を負荷で超える
    // （goldenPromotion.test.ts は 30 秒を個別に指定している先例）。全体の上限だけを広げる
    testTimeout: 20000,
    // 試験が本物のデータ（実ホームの .ccpit / .claude）に触れないようにする（069 発注 4）。
    // ホーム差し替えは process.env の書き換えが実環境変数になる forks でのみ効く。
    pool: 'forks',
    globalSetup: ['./src/main/testSetup/globalIsolation.ts'],
    setupFiles: ['./src/main/testSetup/isolateHome.ts']
  }
})
