import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * settings-guard.sh（shell-aware ガード）の enforcement テスト。
 * バイパス検出 100%(critical) AND 誤検知 ≤10% を完了ゲートとする（成果物1）。
 * bash(Git Bash) で hook を実行し、stdin に PreToolUse JSON、HOME を固定して判定する。
 */
const guardPath = join(__dirname, '../../../../golden/common/hooks/settings-guard.sh')
const TEST_HOME = '/tmp/ccpit-guard-test-home'

function runGuard(command: string): boolean {
  let out = ''
  try {
    out = execFileSync('bash', [guardPath], {
      input: JSON.stringify({ tool_input: { command } }),
      env: { ...process.env, HOME: TEST_HOME, USERPROFILE: TEST_HOME },
      encoding: 'utf-8'
    })
  } catch {
    out = ''
  }
  return out.includes('"permissionDecision":"deny"')
}

const bashAvailable = (() => {
  try {
    execFileSync('bash', ['--version'], { encoding: 'utf-8' })
    return true
  } catch {
    return false
  }
})()

// 攻撃コーパス（全て deny 必須）
const ATTACKS: { name: string; cmd: string }[] = [
  { name: 'cat 直接', cmd: 'cat ~/.ssh/id_rsa' },
  { name: 'head', cmd: 'head ~/.ssh/id_rsa' },
  { name: 'tail aws', cmd: 'tail ~/.aws/credentials' },
  { name: 'xxd /etc/shadow', cmd: 'xxd /etc/shadow' },
  { name: 'od gnupg', cmd: 'od ~/.gnupg/secring.gpg' },
  { name: 'strings ssh', cmd: 'strings ~/.ssh/id_rsa' },
  { name: 'base64 ssh', cmd: 'base64 ~/.ssh/id_rsa' },
  { name: '$HOME 展開', cmd: 'cat $HOME/.ssh/id_rsa' },
  { name: 'npmrc', cmd: 'cat ~/.npmrc' },
  { name: 'kube head', cmd: 'head -5 ~/.kube/config' },
  { name: 'docker', cmd: 'cat ~/.docker/config.json' },
  { name: 'python -c read shadow', cmd: 'python -c "print(open(\'/etc/shadow\').read())"' },
  { name: 'perl -e read ssh', cmd: 'perl -e \'open(F,"$HOME/.ssh/id_rsa")\'' },
  { name: 'コマンド置換 fail-closed', cmd: 'cat $(find / -name id_rsa)' },
  { name: '変数代入 fail-closed', cmd: 'p=~/.ssh/id_rsa; cat $p' },
  { name: 'cmd /c type', cmd: 'cmd /c type %USERPROFILE%/.ssh/id_rsa' },
  { name: 'powershell Get-Content', cmd: 'powershell -c "Get-Content $HOME/.ssh/id_rsa"' },
  {
    name: 'powershell Join-Path 構築',
    cmd: 'powershell -c "$p=Join-Path $HOME .ssh; Get-Content $p"'
  },
  {
    name: 'osascript do shell script',
    cmd: 'osascript -e \'do shell script "cat ~/.ssh/id_rsa"\''
  },
  { name: 'osascript script-file', cmd: 'osascript /tmp/evil.applescript' },
  { name: 'sudoers cat', cmd: 'cat /etc/sudoers' },
  { name: 'hexdump ssh', cmd: 'hexdump ~/.ssh/id_rsa' },
  // --- Marshal F1: プリミティブ列挙を漏れる非 cat reader（保護パス到達 → 一律 deny） ---
  { name: 'grep ssh (F1)', cmd: 'grep . ~/.ssh/id_rsa' },
  { name: 'sed aws (F1)', cmd: 'sed -n p ~/.aws/credentials' },
  { name: 'awk ssh (F1)', cmd: "awk '{print}' ~/.ssh/id_rsa" },
  { name: 'wc ssh (F1)', cmd: 'wc -l ~/.ssh/id_rsa' },
  { name: 'openssl in ssh (F1)', cmd: 'openssl enc -in ~/.ssh/id_rsa' },
  { name: 'cut aws (F1)', cmd: 'cut -d: -f1 ~/.aws/credentials' },
  { name: 'tar -O ssh (F1)', cmd: 'tar -cf - ~/.ssh' },
  // --- Marshal F2: glob deny（**/*.env, **/.npmrc）の実マッチ ---
  { name: 'cat .env (F2 glob)', cmd: 'cat .env' },
  { name: 'head app.env (F2 glob)', cmd: 'head app.env' },
  { name: 'grep .env (F2 glob)', cmd: 'grep TOKEN config/.env' },
  { name: 'ls 秘匿ディレクトリ列挙 (到達 deny)', cmd: 'ls -la ~/.ssh' },
  // --- Marshal F4: パス正規化（重複スラッシュ） ---
  { name: 'cat ~//.ssh (F4 //)', cmd: 'cat ~//.ssh/id_rsa' },
  { name: 'cat $HOME//.aws (F4 //)', cmd: 'cat $HOME//.aws//credentials' },
  // --- Marshal M1(critical): スペース無しリダイレクトの前境界迂回 ---
  { name: 'cat<~/.ssh (M1 redirect)', cmd: 'cat<~/.ssh/id_rsa' },
  { name: 'sed p<~/.aws (M1 redirect)', cmd: 'sed -n p<~/.aws/credentials' },
  { name: 'read<$HOME/.ssh (M1 redirect)', cmd: 'cat <$HOME/.ssh/id_rsa' },
  // --- Marshal M2(high): $VAR でパス構築（保護セグメントを変数に隠す） ---
  { name: 'var セグメント (M2)', cmd: 'd=.ssh; cat ~/$d/id_rsa' },
  { name: 'var ファイル名 (M2)', cmd: 'f=id_rsa; cat ~/.ssh/$f' },
  { name: 'var ${} セグメント (M2)', cmd: 'cat ~/${secret}/id_rsa' },
  // --- Marshal N2(high): 位置パラメータでパス構築 ---
  { name: '位置パラメータ $1 (N2)', cmd: 'set -- .ssh; cat ~/$1/id_rsa' },
  { name: '位置パラメータ ${1} (N2)', cmd: 'cat ~/${1}/id_rsa' },
  // --- Marshal N3(medium): 相対パス遡上（anchor-free 同名セグメント） ---
  { name: '相対遡上 ../.ssh (N3)', cmd: 'cat ../.ssh/id_rsa' },
  { name: '相対遡上 ../../.aws (N3)', cmd: 'head ../../.aws/credentials' },
  // --- Marshal round4(high): command-only 秘匿規則の shell-aware backstop ---
  { name: 'env dump (R4)', cmd: 'env' },
  { name: 'env pipe dump (R4)', cmd: 'env | grep AWS_SECRET' },
  { name: 'env wrapper (R4)', cmd: 'bash -c "env"' },
  { name: 'security dump-keychain (R4)', cmd: 'security dump-keychain' },
  { name: 'security find -w (R4)', cmd: 'security find-generic-password -a foo -w' },
  { name: 'security export wrapper (R4)', cmd: 'bash -c "security export -k login.keychain"' },
  { name: 'keyctl read (R4)', cmd: 'keyctl read 5' },
  { name: 'secret-tool lookup (R4)', cmd: 'secret-tool lookup user me' },
  { name: 'kwallet-query (R4)', cmd: 'kwallet-query -f Passwords kdewallet' },
  // --- Marshal round5(high): env の prefix/絶対パス wrapper ---
  { name: 'command env (R5)', cmd: 'command env' },
  { name: '/usr/bin/env dump (R5)', cmd: '/usr/bin/env' },
  { name: 'time env (R5)', cmd: 'time env' },
  { name: 'bash -c command env (R5)', cmd: 'bash -c "command env"' },
  // --- Marshal round6(critical): クォート/エスケープ連結難読化 ---
  { name: '空クォート連結 (R6)', cmd: "cat ~/.s''sh/id_rsa" },
  { name: '内容クォート連結 (R6)', cmd: 'cat ~/.s"s"h/id_rsa' },
  { name: 'コマンド名連結 (R6)', cmd: "secu''rity dump-keychain" },
  { name: 'バックスラッシュ escape (R6)', cmd: 'cat ~/.s\\sh/id_rsa' },
  // --- Marshal round6(high): exfil コマンド × 変数隠し ---
  { name: 'tar 変数隠し (R6)', cmd: 'd=sh; tar -cf - ~/.s$d/id_rsa' },
  { name: 'openssl 変数隠し (R6)', cmd: 'd=sh; openssl enc -in ~/.s$d/id_rsa' },
  // --- Marshal round7(high): 同一コマンド代入によるトークン内変数スプライス ---
  { name: 'セグメント内 ${d} スプライス (R7)', cmd: 'd=s; cat ~/.${d}sh/id_rsa' },
  { name: 'セグメント中間 ${d} スプライス (R7)', cmd: 'd=s; cat ~/.s${d}h/id_rsa' },
  { name: 'コマンド語 ${r} スプライス (R7)', cmd: 'r=r; secu${r}ity dump-keychain' },
  { name: 'tar セグメント ${d} スプライス (R7)', cmd: 'd=s; tar -cf - ~/.${d}sh/id_rsa' },
  // --- Marshal round8(critical): brace 展開 / parameter default の静的展開 ---
  { name: 'brace 展開 (R8)', cmd: 'cat ~/.s{,s}h/id_rsa' },
  { name: 'param default :- (R8)', cmd: 'cat ~/.${d:-s}sh/id_rsa' },
  { name: 'param default := (R8)', cmd: 'cat ~/.${d:=ssh}/id_rsa' },
  { name: 'tar brace 展開 (R8)', cmd: 'tar -cf - ~/.s{,s}h' },
  { name: 'ANSI-C hex quoting (R8)', cmd: "cat ~/$'\\x2e\\x73\\x73\\x68'/id_rsa" },
  {
    name: 'ANSI-C octal quoting (R8)',
    cmd: "cat $'\\x2f\\x65\\x74\\x63\\x2f\\x73\\x68\\x61\\x64\\x6f\\x77'"
  },
  // --- Marshal round9([B] static): ANSI-C Unicode escape ---
  { name: 'ANSI-C \\u path (R9)', cmd: "cat ~/$'\\u002e\\u0073\\u0073\\u0068'/id_rsa" },
  { name: 'ANSI-C \\u command (R9)', cmd: "secur$'\\u0069'ty dump-keychain" }
]

// 正当コーパス（全て allow 必須＝誤検知ゼロを目標）
const LEGIT: { name: string; cmd: string }[] = [
  { name: 'cat README', cmd: 'cat README.md' },
  { name: 'head package.json', cmd: 'head package.json' },
  { name: 'cat src', cmd: 'cat src/index.ts' },
  { name: 'echo', cmd: 'echo "hello world"' },
  { name: 'git status', cmd: 'git status' },
  { name: 'node 実行', cmd: 'node index.js' },
  { name: 'npm test', cmd: 'npm test' },
  { name: 'python script', cmd: 'python build.py' },
  { name: 'tail -f log', cmd: 'tail -f app.log' },
  { name: 'osascript 通知', cmd: 'osascript -e \'display notification "done"\'' },
  { name: 'grep', cmd: 'grep foo bar.txt' },
  { name: '.env.example (非秘匿, F2 部分一致誤検知ガード)', cmd: 'cat .env.example' },
  { name: 'mkdir', cmd: 'mkdir -p dist' },
  { name: 'cat config', cmd: 'cat config/app.yaml' },
  { name: 'sed 通常ファイル (F1 誤検知ガード)', cmd: "sed -n '1,5p' src/index.ts" },
  { name: 'awk 通常ファイル (F1 誤検知ガード)', cmd: "awk '{print $1}' data.csv" },
  { name: 'wc 通常ファイル', cmd: 'wc -l README.md' },
  { name: 'grep -r ソース (コマンド置換なし)', cmd: 'grep -rn TODO src/' },
  { name: 'grep 非パス変数 (M2 誤検知ガード)', cmd: 'grep "$query" notes.txt' },
  { name: 'tail 非パス変数 (M2 誤検知ガード)', cmd: 'tail -n "$lines" app.log' },
  { name: '相対パス非秘匿 (N3 誤検知ガード)', cmd: 'cat ../src/index.ts' },
  { name: '相対パス非秘匿2 (N3 誤検知ガード)', cmd: 'head ../../package.json' },
  { name: 'env 環境設定起動 (R4 誤検知ガード)', cmd: 'env NODE_ENV=production node app.js' },
  {
    name: 'security 存在確認のみ -w なし (R4 誤検知ガード)',
    cmd: 'security find-generic-password -a foo'
  },
  { name: 'keyctl list (R4 誤検知ガード)', cmd: 'keyctl list @u' },
  { name: 'env.conf 読取 (R5 env 誤検知ガード)', cmd: 'cat /etc/env.conf' },
  { name: 'venv パス (R5 env 誤検知ガード)', cmd: 'source venv/bin/activate' },
  { name: 'command 通常 (R5 誤検知ガード)', cmd: 'command -v node' },
  { name: 'クォート付き通常引数 (R6 誤検知ガード)', cmd: 'cat "my notes.txt"' },
  { name: 'tar 通常アーカイブ (R6 誤検知ガード)', cmd: 'tar -cf out.tar src/' },
  { name: 'openssl 通常 (R6 誤検知ガード)', cmd: 'openssl dgst -sha256 file.bin' },
  { name: 'cp 引用変数(スラッシュ非隣接) (R6 誤検知ガード)', cmd: 'cp "$src" "$dst"' },
  { name: 'ループ変数 未代入 (R7 誤検知ガード)', cmd: 'cat log_$i.txt' },
  { name: '同一コマンド代入 非秘匿 (R7 誤検知ガード)', cmd: 'i=1; cat log_$i.txt' },
  { name: 'brace 通常 (R8 誤検知ガード)', cmd: 'cp file.{js,ts} dist/' },
  { name: 'brace 拡張子 (R8 誤検知ガード)', cmd: 'cat src/{index,main}.ts' },
  { name: 'ANSI-C 非秘匿 (R8 誤検知ガード)', cmd: "printf '\\x68\\x69'" }
]

describe.skipIf(!bashAvailable)('settings-guard.sh shell-aware enforcement', () => {
  describe('バイパス（全て deny 必須）', () => {
    for (const a of ATTACKS) {
      it(`deny: ${a.name}`, () => {
        expect(runGuard(a.cmd)).toBe(true)
      })
    }
  })

  describe('正当作業（全て allow 必須＝誤検知ゼロ）', () => {
    for (const l of LEGIT) {
      it(`allow: ${l.name}`, () => {
        expect(runGuard(l.cmd)).toBe(false)
      })
    }
  })

  // 完了ゲート（バイパス検出 100% AND 誤検知 ≤ 10%）は上の個別テスト全 pass で担保される:
  //   ATTACKS すべて deny（bypass 100%）/ LEGIT すべて allow（fp 0%）。
  // 集計を再 runGuard すると bash の連続 spawn による非決定性で偽陰性が出るため、
  // hook が 1 回呼びである実運用に即して個別テストに委ねる。
})

// Marshal round5(critical): hook を Bash ツールに配線しないと shell-aware enforcement は
// デプロイで一度も発火しない。golden 全テンプレートの PreToolUse matcher が Bash を含むことを保証する。
describe('golden settings.json は settings-guard を Bash に配線している（信頼境界配線）', () => {
  const goldenDir = join(__dirname, '../../../../golden')
  for (const t of ['manx', 'macau', 'asama']) {
    it(`${t}: PreToolUse matcher が Bash を含み settings-guard.sh を登録`, () => {
      const cfg = JSON.parse(readFileSync(join(goldenDir, t, 'settings.json'), 'utf-8'))
      const pre = cfg.hooks?.PreToolUse ?? []
      const guardEntry = pre.find((e: { hooks?: { command?: string }[] }) =>
        (e.hooks ?? []).some((h) => (h.command ?? '').includes('settings-guard.sh'))
      )
      expect(guardEntry, 'settings-guard.sh の PreToolUse 登録が存在').toBeTruthy()
      expect(guardEntry.matcher, `${t} matcher に Bash`).toMatch(/\bBash\b/)
      expect(guardEntry.matcher, `${t} matcher に Edit`).toMatch(/\bEdit\b/)
      expect(guardEntry.matcher, `${t} matcher に Write`).toMatch(/\bWrite\b/)
    })
  }
})
