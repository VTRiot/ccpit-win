#!/usr/bin/env node
/*
 * md2html.cjs — CCPIT 決定論的 Markdown→HTML レンダラ (件3 / md-render skill 本体)
 *
 * 設計正本: _Prompt/02_buildai/20260612_0242_CCPIT_Step10Gen1_IndexGate_MdHtmlRenderer_InvestigationReport_r1.md
 *
 * 原則:
 *  - 純関数: HTML = f(MD バイト列, 内蔵テンプレート)。壁時計/環境変数/他ファイルを入力にしない。
 *    生成タイムスタンプは入れない。フッタは「正本ファイル名 + MD sha256 先頭12桁」のみ (data 属性)。
 *  - テンプレートはテキストノードを持たない: <body> 内の全テキストは MD トークン由来。
 *    chrome ラベル (TOC 題 / 要判断一覧題 / 件数バッジ / フッタ sha) は CSS 擬似要素 or data-* 属性。
 *  - 生 HTML 不透過 + エスケープ恒常化: MD 中の生 HTML はリテラル表示。
 *  - 依存ゼロ: Node 組み込み (fs/path/crypto) のみ。対応構文は閉じた 8 種。未対応はリテラル退化。
 *
 * CLI:
 *   node md2html.cjs <in.md> <out.html>     MD → HTML (ファイルへ出力)
 *   node md2html.cjs <in.md> - | --stdout   MD → HTML (画面/stdout へ出力)
 *   node md2html.cjs --verify <in.md>        双方向検証: HTML⊆MD(捏造防止) + MD⊆HTML(欠落防止) + コード引用の実物照合 (違反で exit 1)
 *                                            引用の照合は フェンス info の cite= / include= / rev= を書いた文書だけ (書かなければ従来どおり)。
 *                                            照合できない場合 (UNVERIFIABLE) も失敗。skip の手段は無い
 *     --verify-html / --verify-md            片方向のみ実行 (デバッグ用。引用の照合は行わない)
 *   node md2html.cjs --lint <in.md>          報告書型 frontmatter の必須マーカー欠落を警告 (exit 0 維持)。必須見出しは本物の見出しブロックだけで判定
 *   node md2html.cjs --selftest              内蔵 golden ケースを描画し埋込 sha256 と照合 (破損検出)
 *   node md2html.cjs --check <in.md> <html>  HTML 埋込 sha256 と現 MD sha256 を照合 (_index 鮮度用 / 件2 ④ 先取り)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// 低レベルユーティリティ
// ---------------------------------------------------------------------------

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function sha1(str) {
  return crypto.createHash('sha1').update(str, 'utf8').digest('hex');
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// コード引用の実物照合 (opt-in: フェンスの info に cite= / include= / rev= を書いた文書だけで有効)。
//   cite="パス:開始-終了"    手で写したコード片を、実物のその範囲と照合する (食い違えば --verify が失敗)。
//   include="パス:開始-終了" 本文を書かず、実物のその範囲を HTML に入れる (写さないので写し間違いが起きない)。
//   rev="commit"             実物を git のその commit の版で見る (時点を固定する。省略時は今の作業ツリー)。
//   これらを書かないフェンス・文書は一切影響を受けない (出力 byte 不変)。
// 照合の契約: 行単位の完全一致 (CR のみ無視・行末の空白もインデントも厳密)。実物は 1 プロセス内で 1 度だけ読み、
//   その同じ読みを描画・照合・--check のハッシュで共用する (読みの間に実物が変わっても食い違わない)。
//   照合できない (読めない・commit が無い・git が使えない・起点が決まらない) ときは UNVERIFIABLE として失敗する。
// ---------------------------------------------------------------------------

let _citeSrcPath = null; // 報告書 MD の絶対パス (相対パスの起点の解決に使う)。CLI 入口と check() が setCiteSource で設定
let _citeLenient = false; // verify 内の描画中は、展開に失敗した include でも throw しない (失敗は verifyCites が報告する)
let _citeReads = new Map(); // スナップショット: キー = 実物の絶対パス + rev → 読み出し結果

const citeIoReal = {
  exists: (p) => fs.existsSync(p),
  // ネイティブの realpath: Windows の 8.3 の短い名前・大文字小文字・ジャンクション・シンボリックリンクを、実際の名前に直す。
  // (秘密のパスの規則は、書かれたパスと、この実体のパスの両方に当てる)
  realpath: (p) => fs.realpathSync.native(p),
  // 開いたファイルそのもの (ファイル記述子) から読み、その同一性 (デバイス:inode) も返す。読んだ後に、同じ実体のパスが同じファイルを
  // 指しているかを確かめるため。パスで読み直すと、検査と読み出しの間に差し替えられたファイルを読んでしまう
  readFile: (p) => {
    const fd = fs.openSync(p, 'r');
    try {
      const st = fs.fstatSync(fd, { bigint: true });
      return { buf: fs.readFileSync(fd), id: st.dev + ':' + st.ino };
    } finally {
      fs.closeSync(fd);
    }
  },
  statId: (p) => {
    const st = fs.statSync(p, { bigint: true });
    return st.dev + ':' + st.ino;
  },
  homedir: () => require('os').homedir(),
  git: (args, cwd) => {
    try {
      const r = require('child_process').spawnSync('git', args, {
        cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, windowsHide: true,
      });
      return { status: r.status, stdout: r.stdout, error: r.error };
    } catch (e) {
      return { status: null, stdout: Buffer.alloc(0), error: e }; // 引数が不正などで spawn 自体が投げても、呼び出し側へ例外を出さない
    }
  },
};
let _citeIo = citeIoReal; // selftest が偽の入出力へ差し替える (ディスクに触れず照合ロジックだけを検証する)

function setCiteSource(srcPath) {
  _citeSrcPath = srcPath ? path.resolve(srcPath) : null;
  _citeReads = new Map();
}

const CITE_REV_RE = /^[0-9a-fA-F]{7,40}$/;

// title="..." の中にある cite= 等を属性と取り違えないよう、title の引用部を同じ長さの空白に潰して走査する。
function citeMaskTitles(raw) {
  return raw.replace(/(^|\s)title="[^"]*"/g, (m) => ' '.repeat(m.length));
}

function hasCiteAttrs(info) {
  return /(?:^|\s)(?:cite|include|rev)=/.test(citeMaskTitles(String(info || '')));
}

// info から cite= / include= / rev= を取り除いた残り (言語名・title など)。属性が無ければ入力をそのまま返す。
function stripCiteAttrs(info) {
  const raw = String(info || '');
  if (!hasCiteAttrs(raw)) return raw;
  const masked = citeMaskTitles(raw);
  const re = /(^|\s)(?:cite|include|rev)=(?:"[^"]*"|\S*)/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(masked))) {
    out += raw.slice(last, m.index);
    last = m.index + m[0].length;
  }
  return (out + raw.slice(last)).trim();
}

// 属性の読み取り。cite/include/rev が無ければ null (= 機能を使っていない)。誤用は errors に集める (黙って読み替えない)。
function parseCiteAttrs(info) {
  const raw = String(info || '');
  if (!hasCiteAttrs(raw)) return null;
  const masked = citeMaskTitles(raw);
  const re = /(?:^|\s)(cite|include|rev)=(?:"([^"]*)"|(\S*))/g;
  const seen = { cite: [], include: [], rev: [] };
  const errors = [];
  let m;
  while ((m = re.exec(masked))) {
    if (m[2] === undefined) {
      errors.push(m[1] + '= の値が "..." で囲まれていない');
      continue;
    }
    seen[m[1]].push(m[2]);
  }
  for (const name of ['cite', 'include', 'rev']) {
    if (seen[name].length > 1) errors.push(name + '= が複数ある');
  }
  if (seen.cite.length && seen.include.length) errors.push('cite= と include= は同時に書けない');
  const kind = seen.include.length ? 'include' : seen.cite.length ? 'cite' : null;
  if (!kind) errors.push('rev= は cite= か include= と一緒に書く');
  const spec = kind ? seen[kind][0] : null;
  return { kind, spec, rev: seen.rev.length ? seen.rev[0] : null, errors };
}

// "パス:開始-終了" / "パス:行" の分解。末尾から読むのでドライブ文字の ":" は割らない。範囲は必須。
function parseCiteSpec(spec) {
  const s = String(spec || '');
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 32) return null; // 制御文字 (NUL など) を含む経路は受け付けない
  }
  const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(s);
  if (!m) return null;
  // パスの検査 (秘密のパスの規則を回避する書き方を、読む前に弾く): ドライブ文字の後ろのコロンは Windows の代替データストリーム
  // ("file:stream") になり、"? * < > | に" は拡張パスや無効な名前、末尾のドット・空白は Windows が黙って落として別名のまま同じファイルを指す。
  const pathPart = m[1];
  const afterDrive = /^[A-Za-z]:[\\/]/.test(pathPart) ? pathPart.slice(2) : pathPart;
  if (/[:?*<>|"]/.test(afterDrive)) return null;
  for (const comp of afterDrive.split(/[\\/]/)) {
    if (comp !== '.' && comp !== '..' && /[. ]$/.test(comp)) return null;
  }
  const start = Number(m[2]);
  const end = m[3] === undefined ? start : Number(m[3]);
  if (start < 1 || end < start) return null;
  return { path: m[1], start, end };
}

// 最寄りの .git (ディレクトリでもファイルでも。worktree では .git がファイル) を持つ祖先。無ければ null。
function citeFindRepoRoot(dir) {
  let d = dir;
  for (;;) {
    if (_citeIo.exists(path.join(d, '.git'))) return d;
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

// 実物のパスの決め方は 1 通りだけ (候補を順に試す後退をしない = 別ファイルに偶然合う誤合格を作らない)。
//   "~/" はホーム / 絶対パスはそのまま / 相対パスは「報告書の最寄りの .git を持つ祖先」(無ければ報告書のフォルダ) 起点。
function citeResolveTarget(specPath) {
  if (specPath.startsWith('~/') || specPath.startsWith('~\\')) {
    return { abs: path.join(_citeIo.homedir(), specPath.slice(2)) };
  }
  if (path.isAbsolute(specPath)) return { abs: path.resolve(specPath) };
  if (!_citeSrcPath) return { unverifiable: '報告書のパスが分からないので、相対パスの起点を決められない' };
  const dir = path.dirname(_citeSrcPath);
  return { abs: path.resolve(citeFindRepoRoot(dir) || dir, specPath) };
}

function citeBufToLines(buf) {
  let text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) return null; // UTF-8 として読めない
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM はファイル先頭の 1 個だけ
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop(); // 末尾の改行が作る空の 1 行は行数に数えない
  return lines;
}

// 実物の読み出し (スナップショット)。結果: { lines, abs, fullRev? } | { missing } | { unreadable, why }
function citeReadSnapshot(abs, rev, checkedWhere) {
  // キーは、呼び出し側 (evaluateCite) が検査した実体のパスそのもの。ここで解決し直さない
  // (解決し直すと、検査の後に差し替えられたリンクの先の、別のファイルの読みを引き当ててしまう)。
  // 作業ツリーの読みは、検査済みのパスを開いて同一性を確かめた読み (citeReadUncached) だけが入る。rev 付きは commit の中身が不変。
  const key = abs + '\n' + (rev || '');
  if (_citeReads.has(key)) return _citeReads.get(key);
  const result = citeReadUncached(abs, rev, checkedWhere);
  _citeReads.set(key, result);
  return result;
}

// rev で git から引くときの、リポジトリのルートと、リポジトリ内の正規のパス (rel)。git の中身には一切触れない (パスの解決だけ)。
// リポジトリは「ファイルの実体のパス」から決める (ファイル自体がシンボリックリンクでも、別のリポジトリへ逸れない)。
// ファイルが今の作業ツリーに無いときだけ、「実在する最も深い祖先のフォルダ」の実体のパスから決める。
// include= の拡張子の検査 (許可リスト) は、この rel に対しても、git の中身を読む前に行う (evaluateCite)。
function citeResolveRevPath(abs) {
  let realFile = null;
  if (_citeIo.exists(abs)) {
    try {
      realFile = _citeIo.realpath(abs);
    } catch (e) {
      return { unreadable: true, why: '実体のパスを解決できない' };
    }
  }
  let realDir;
  let tail;
  if (realFile) {
    realDir = path.dirname(realFile);
    tail = [path.basename(realFile)];
  } else {
    let existing = path.dirname(abs);
    tail = [path.basename(abs)];
    for (;;) {
      if (_citeIo.exists(existing)) break;
      const parent = path.dirname(existing);
      if (parent === existing) return { unreadable: true, why: 'rev の照合先のフォルダが無い' };
      tail.unshift(path.basename(existing));
      existing = parent;
    }
    try {
      realDir = _citeIo.realpath(existing);
    } catch (e) {
      return { unreadable: true, why: '実体のパスを解決できない' };
    }
  }
  const root = citeFindRepoRoot(realDir);
  if (!root) return { unreadable: true, why: 'rev を引けるリポジトリ (.git) の下にない' };
  const rel = path.relative(root, path.join(realDir, ...tail)).split(path.sep).join('/');
  if (!rel || rel.startsWith('..')) return { unreadable: true, why: 'rev を引くリポジトリの外のファイル' };
  return { root, rel };
}

// checkedWhere: evaluateCite が拡張子を検査した、rev 用のリポジトリ内のパス (二度解決しない = 検査したのと違うパスを読まない)
function citeReadUncached(abs, rev, checkedWhere) {
  if (!rev) {
    // abs は検査済みの実体のパス。開いたファイルそのものから読み、読んだ後に「同じパスが同じファイルを指している」ことを確かめる。
    // 検査と読み出しの間に、リンクへ差し替えて読ませた後に元へ戻す、という操作も、開いたファイルの同一性が合わず検出できる。
    let rd;
    try {
      rd = _citeIo.readFile(abs);
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { missing: true };
      return { unreadable: true, why: '読めない (' + ((e && e.code) || String(e)) + ')' };
    }
    let samePath = null;
    let sameId = null;
    try {
      samePath = _citeIo.realpath(abs);
      sameId = _citeIo.statId(samePath);
    } catch (e) {
      return { unreadable: true, why: '読んだ後に実体のパスを確かめられない' };
    }
    if (samePath !== abs || sameId !== rd.id) {
      return { unreadable: true, why: '読んでいる間に、ファイルが差し替えられた (リンク先の差し替えの疑い)。もう一度実行する' };
    }
    const lines = citeBufToLines(rd.buf);
    if (!lines) return { unreadable: true, why: 'UTF-8 として読めない' };
    return { lines, abs };
  }
  // rev 指定: 実物が今の作業ツリーに無くてもよい (消えたファイルの過去の版を引ける)。
  const where = checkedWhere || citeResolveRevPath(abs);
  if (where.unreadable) return where;
  const { root, rel } = where;
  const g1 = _citeIo.git(['rev-parse', '--verify', '--quiet', rev + '^{commit}'], root);
  if (g1.error) return { unreadable: true, why: 'git を実行できない' };
  if (g1.status !== 0) return { unreadable: true, why: 'rev の commit がリポジトリに無い (または短縮が曖昧)' };
  const fullRev = g1.stdout.toString('utf8').trim().toLowerCase();
  // 16 進だけのブランチ名・タグ名 (例: deadbeef) も rev-parse は解決する。それは動く参照なので、commit ID そのものを指す
  // (解決した完全な ID が、書かれた rev で始まる) 場合だけ受け付ける。
  if (!fullRev.startsWith(rev.toLowerCase())) {
    return { unreadable: true, why: 'rev が commit ID でなく、動く参照 (ブランチ名・タグ名) に解決された' };
  }
  // 参照の指す先がたまたま同じ先頭で始まっていても、参照は動く。同名の参照 (ブランチ・タグ・リモート追跡) が 1 つでもあれば受け付けない。
  // 40 桁は git が参照より commit ID を優先するので対象外。
  if (rev.length < 40) {
    const g0 = _citeIo.git(
      ['for-each-ref', '--format=%(refname)', 'refs/heads/' + rev, 'refs/tags/' + rev, 'refs/remotes/*/' + rev, 'refs/' + rev],
      root
    );
    if (g0.error || g0.status !== 0) return { unreadable: true, why: 'git で参照名との衝突を確かめられない' };
    if (g0.stdout.toString('utf8').trim() !== '') {
      return { unreadable: true, why: 'rev と同名の参照 (ブランチ・タグ) がある。動く参照と区別できないので、40 桁の commit ID を書く' };
    }
  }
  const g2 = _citeIo.git(['cat-file', '-e', fullRev + ':' + rel], root);
  if (g2.status !== 0) return { missing: true, atRev: fullRev };
  const g3 = _citeIo.git(['cat-file', 'blob', fullRev + ':' + rel], root);
  if (g3.status !== 0) return { unreadable: true, why: 'git で blob を読めない' };
  const lines = citeBufToLines(g3.stdout);
  if (!lines) return { unreadable: true, why: 'UTF-8 として読めない' };
  return { lines, abs, fullRev };
}

function citeShort(s) {
  const t = JSON.stringify(String(s));
  return t.length > 140 ? t.slice(0, 140) + '…"' : t;
}

// 完全一致する連続部分列の開始位置 (1 始まり)。空白だけの引用は探さない (どこにでも合ってしまう)。
function citeFindSequence(lines, quoted) {
  if (!quoted.some((l) => l.trim() !== '')) return [];
  const hits = [];
  for (let i = 0; i + quoted.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < quoted.length; j++) {
      if (lines[i + j] !== quoted[j]) { ok = false; break; }
    }
    if (ok) hits.push(i + 1);
  }
  return hits;
}

// 秘密を含みうるファイルの判定。include= は道具が自動でファイルの中身を HTML に入れるので、書き手が中身を見ずに秘密を
// 報告書へ入れる道になる。cite= も、食い違いの診断が実物の行を出すので同じ入口から漏れうる。だから両方で、
// 「パス」と「引く範囲の中身の形」の 2 段で止める。止めたときは中身を読まない (パス) か、出さない (中身) 。
// 例外を開けるスイッチは作らない (誤検知は、引く範囲を絞る・秘密の行を含まない範囲にする、で避ける)。
const CITE_SECRET_DIRS = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker'];
const CITE_SECRET_CLAUDE_FILES = ['settings.json', 'settings.local.json', '.credentials.json', 'credentials.json'];
const CITE_SENSITIVE_BASENAME_RE =
  /^(?:\.env(?:\..+)?|\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials|\.htpasswd|\.dockercfg|\.claude\.json|credentials(?:\..+)?|secrets?(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:_.+)?|.+\.(?:pem|key|p12|pfx|jks|keystore|kdbx|tfstate|tfvars|ppk|secret))$/i;
const CITE_SECRET_SAFE_SUFFIX_RE = /\.(?:example|sample|template|dist)$/i; // .env.example のように、書き方の見本のファイルは対象外

function citeSecretPathReason(p) {
  const parts = String(p).replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length) return '';
  const base = parts[parts.length - 1].toLowerCase();
  const dirs = parts.slice(0, -1).map((s) => s.toLowerCase());
  const parent = dirs.length ? dirs[dirs.length - 1] : '';
  for (const d of dirs) {
    if (CITE_SECRET_DIRS.includes(d)) return d + ' フォルダの下のファイル';
  }
  if (parent === '.ccpit') return '.ccpit 直下の設定・状態のファイル';
  if (parent === '.claude' && CITE_SECRET_CLAUDE_FILES.includes(base)) return '.claude の設定・認証のファイル (' + base + ')';
  if (CITE_SENSITIVE_BASENAME_RE.test(base) && !CITE_SECRET_SAFE_SUFFIX_RE.test(base)) return 'ファイル名が秘密を含む形 (' + base + ')';
  return '';
}

const CITE_SECRET_CONTENT = [
  ['秘密鍵のブロック', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/], // PGP の "PRIVATE KEY BLOCK" も含む
  // PEM の本文を Base64 にしたもの (Kubernetes の Secret の data など)。"-----BEGIN " の Base64 は固定の接頭辞で始まる
  ['Base64 化された PEM', /\bLS0tLS1CRUdJTi[A-Za-z0-9+/=]{8,}/],
  ['HTTP の認証情報 (Basic など)', /\b(?:Proxy-)?Authorization\b["']?\s*[:=]\s*["']?(?:Basic|Digest|Token|ApiKey)\s+[A-Za-z0-9+/._~=-]{16,}/i],
  ['AWS のアクセスキー ID', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub のトークン', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['API キー (sk-)', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  // ベンダー固有の形式のトークン (接頭辞が固定のもの)。Docker / npm / GitLab / PyPI / Hugging Face / Stripe / GitHub の細粒度 PAT / Google OAuth / Shopify / SendGrid / Twilio / Azure DevOps ほか
  ['ベンダー固有の形式のトークン', /\b(?:dckr_pat_[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{16,}|pypi-[A-Za-z0-9_-]{30,}|hf_[A-Za-z0-9]{30,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{30,}|ya29\.[A-Za-z0-9_-]{20,}|shp(?:at|ss|ca|pa)_[a-f0-9]{24,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|AC[a-f0-9]{32}|SK[a-f0-9]{32}|sk-ant-[A-Za-z0-9_-]{20,}|glc_[A-Za-z0-9+/=]{30,}|lin_api_[A-Za-z0-9]{30,})\b/],
  ['Slack のトークン', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Google の API キー', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['Bearer トークン', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ['認証情報の代入 (引用符つきの値)', /(?:password|passwd|secret|token|api[._-]?key|access[._-]?key|private[._-]?key|tls[._-]?key|client[._-]?key|signing[._-]?key|encryption[._-]?key|auth[._-]?key|credential)[A-Za-z0-9_]*["']?\s*[:=]\s*\$?["'][^"'\s]{8,}["']/i],
  ['認証情報の代入 (環境変数の形)', /^\s*(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Z0-9_]*\s*=\s*[^\s"'#]{8,}/],
  // YAML / TOML / INI の引用符なしの値。実際のキーは長いので、(a) 数字を含む 16 文字以上、または (b) 数字を含まなくても
  // 大文字と小文字が混ざった英字だけの 20 文字以上、に限る (識別子の代入や短い値を誤検知しない。小文字だけ・記号だけの短い値は止められない)
  ['認証情報の代入 (引用符なしの長い値)', (line) => {
    // キー名の判定だけ大文字小文字を区別しない。値の形 (大文字と小文字の混在) は区別して判定する
    // 値の後ろの行内コメント ("# …") は無視する (YAML / TOML / INI の普通の書き方)。YAML のフロー形式 ({a: b}・[a, b]) の閉じ括弧とカンマも外す
    const m = /(?:password|passwd|secret|token|api[._-]?key|access[._-]?key|private[._-]?key|tls[._-]?key|client[._-]?key|signing[._-]?key|encryption[._-]?key|auth[._-]?key|credential)[A-Za-z0-9_]*\s*[:=]\s*(\S+?)(?:\s+#.*)?\s*$/i.exec(line);
    return !!m && citeLooksLikeBareSecretValue(m[1].replace(/[,}\]]+$/, ''));
  }],
  // XML の要素: <password>値</password>・<settings token="…"> の属性 (属性は上の引用符つきの規則が拾う)
  ['認証情報の代入 (XML の要素)', /<[A-Za-z0-9_.:-]*(?:password|passwd|secret|token|api[._-]?key|access[._-]?key|private[._-]?key|tls[._-]?key|client[._-]?key|signing[._-]?key|encryption[._-]?key|auth[._-]?key|credential)[A-Za-z0-9_.-]*(?:\s[^>]*)?>\s*[^<\s]{8,}\s*</i],
  // 名前と値が別の属性・別のキーの対: <add key="ApiKey" value="…" /> ・ {"name": "api_key", "value": "…"} (名前の側が資格情報の名前で、値の側に引用符つきの 8 文字以上)
  ['認証情報の代入 (名前と値が別の属性)', (line) => {
    const cred = '(?:password|passwd|secret|token|api[._-]?key|access[._-]?key|private[._-]?key|tls[._-]?key|client[._-]?key|signing[._-]?key|encryption[._-]?key|auth[._-]?key|credential)';
    const nameFirst = new RegExp('\\b(?:key|name|id)["\']?\\s*[:=]\\s*["\'][^"\']*' + cred + '[^"\']*["\'][^\\n]*?\\bvalue["\']?\\s*[:=]\\s*["\'][^"\'\\s]{8,}["\']', 'i');
    const valueFirst = new RegExp('\\bvalue["\']?\\s*[:=]\\s*["\'][^"\'\\s]{8,}["\'][^\\n]*?\\b(?:key|name|id)["\']?\\s*[:=]\\s*["\'][^"\']*' + cred, 'i');
    return nameFirst.test(line) || valueFirst.test(line);
  }],
  // 接続文字列: Server=x;Password=値;  (値が鍵らしい形のときだけ。getPassword() のような呼び出しは止めない)
  ['認証情報の代入 (接続文字列)', (line) => {
    // キー名は "password / pwd" に限らず、資格情報らしい名前全般 (AccountKey・SharedAccessKey・ClientSecret・AccessToken など)。
    // 値の終わりは ; か、行末か、JSON の文字列の閉じ引用符。Base64 の + / = を含められる形で取る
    const re = /(?:password|pwd|passwd|secret|token|account[._-]?key|shared[._-]?access[._-]?key|access[._-]?key|api[._-]?key|private[._-]?key|tls[._-]?key|client[._-]?key|signing[._-]?key|encryption[._-]?key|auth[._-]?key|credential|sig)[A-Za-z0-9_]*\s*=\s*([^;\s"']+)/gi;
    let m;
    while ((m = re.exec(line))) {
      if (citeLooksLikeBareSecretValue(m[1])) return true;
    }
    return false;
  }],
  // URL に埋め込まれた資格情報: scheme://user:パスワード@host
  ['URL に埋め込まれた資格情報', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{6,}@/i],
];
// 引用符なしの値が鍵らしい形か: (a) 数字を含む 16 文字以上の英数字と記号 (+/=_-)、または (b) 数字を含まなくても
// 大文字と小文字が混ざった英字だけの 20 文字以上。識別子の代入や短い値は止めない (小文字だけ・短い値の秘密は止められない)。
function citeLooksLikeBareSecretValue(v) {
  if (/^[A-Za-z0-9+/=_%.-]{16,}$/.test(v) && /\d/.test(v)) return true;
  return /^[A-Za-z]{20,}$/.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v);
}
// キーだけの行 (値は次の行) と、同じ形の長い 1 語だけの値の行。YAML の複数行の書き方を止める
const CITE_SECRET_KEY_ONLY_RE = /(?:password|passwd|secret|token|api[._-]?key|access[._-]?key|private[._-]?key|tls[._-]?key|client[._-]?key|signing[._-]?key|encryption[._-]?key|auth[._-]?key|credential)[A-Za-z0-9_]*["']?\s*:?[:=]\s*(?:[&!]\S*\s*)*(?:[|>][-+]?[0-9]?[-+]?)?\s*(?:#.*)?$/i;
// 値だけの行: 行内コメント・末尾のカンマ・1 組の引用符 (JSON でキーと値が別の行に書かれた場合) を外して判定する
const CITE_SECRET_VALUE_ONLY_RE = {
  test: (line) => {
    let v = String(line).trim().replace(/\s+#.*$/, '').replace(/,$/, '');
    const q = /^(["'])(.*)\1$/.exec(v);
    if (q) v = q[2];
    return citeLooksLikeBareSecretValue(v);
  },
};
// 資格情報のキーの行から、値の部分を取り出す (":=" や引用符つきのキーも含む)
const CITE_CRED_KEYLINE_RE = /(?:password|passwd|secret|token|api[._-]?key|access[._-]?key|private[._-]?key|tls[._-]?key|client[._-]?key|signing[._-]?key|encryption[._-]?key|auth[._-]?key|credential)[A-Za-z0-9_]*["']?\s*:?[:=]\s*(.*)$/i;

// 引く範囲の行に秘密の形があれば、{ rule, line } (範囲の中の 1 始まりの行番号)。無ければ null。行の中身は返さない。
// prevLine = 範囲の 1 行前の行 (キーだけの行が範囲の外にあり、値の行だけを引く場合のため)。その行自体の秘密は、範囲の外なので数えない。
function citeSecretContentHit(lines, prevLine) {
  const hasPrev = typeof prevLine === 'string';
  const seq = hasPrev ? [prevLine].concat(lines) : lines;
  const off = hasPrev ? 1 : 0;
  for (let i = off; i < seq.length; i++) {
    for (const [rule, test] of CITE_SECRET_CONTENT) {
      if (typeof test === 'function' ? test(seq[i]) : test.test(seq[i])) return { rule, line: i - off + 1 };
    }
    if (i > 0 && CITE_SECRET_KEY_ONLY_RE.test(seq[i - 1]) && CITE_SECRET_VALUE_ONLY_RE.test(seq[i])) {
      return { rule: '認証情報の代入 (キーと値が別の行)', line: i - off + 1 };
    }
  }
  return null;
}

// 資格情報のキーだけの行 (値が空、または YAML の | > の印だけ) の下にインデントされた行は、値の形に関わらず資格情報のブロックとみなして止める
// (複数行に分けて書かれた値は、1 行ずつの形では判定できないため)。キーの行自体を引くだけなら止めない。
// 値を次の行以降に続ける書き方 (資格情報のキーの行の「値の部分」の形):
//   インデント: 値が空、YAML の | > の記号・アンカー (&名前)・タグ (!!str) だけ → 下にインデントされた行
//   バックスラッシュ: 行末が \ (.properties・シェルの継続) → \ で終わる限り次の行
//   三連引用符: TOML の """ や ''' で、同じ行で閉じていない → 閉じる行まで
//   ヒアドキュメント: <<WORD → WORD だけの行まで
//   閉じていない引用符: YAML の複数行の引用符つき文字列・シェルの複数行の代入・JS のテンプレートリテラル → 閉じる引用符のある行まで
// 戻り: { last: ブロックの最後の行の添字 (0 始まり。ブロックの行が無ければ i), withKeyLine: キーの行自体にも値の断片があるか }。
//   withKeyLine が true (バックスラッシュ・三連引用符・閉じていない引用符) なら、キーの行もブロックに含めて止める。
// 閉じる印 (ヒアドキュメントの終端・三連引用符・引用符) がファイル内に見つからないときのブロックの長さの上限 (行数)。
// コメントや説明文に書かれたヒアドキュメントなどの例を、ファイルの終わりまで続くブロックと取り違えて、
// 後ろの普通の行をすべて止めてしまわないための上限。実際の複数行の値はこれより短い。
const CITE_UNTERMINATED_BLOCK_LINES = 20;

function citeCredentialBlockEnd(allLines, i) {
  const none = { last: i, withKeyLine: false };
  const unterminatedEnd = Math.min(allLines.length - 1, i + CITE_UNTERMINATED_BLOCK_LINES);
  const m = CITE_CRED_KEYLINE_RE.exec(allLines[i]);
  if (!m) return none;
  const v = m[1].replace(/\s+#.*$/, '').trim();
  if (/^(?:[&!]\S*\s*)*(?:[|>][-+]?[0-9]?[-+]?)?$/.test(v)) {
    const keyIndent = allLines[i].match(/^\s*/)[0].length;
    let last = i;
    for (let j = i + 1; j < allLines.length; j++) {
      if (allLines[j].trim() === '') continue;
      if (allLines[j].match(/^\s*/)[0].length <= keyIndent) break;
      last = j;
    }
    return { last, withKeyLine: false };
  }
  if (/\\$/.test(m[1].trimEnd())) {
    let j = i;
    while (j + 1 < allLines.length && /\\$/.test(allLines[j].trimEnd())) j++;
    return { last: j, withKeyLine: true };
  }
  // ヒアドキュメントは、行が引用符で始まっていても (コマンド置換の中で <<WORD を使う書き方) 先に判定する
  // 区切り語は、空白と制御記号以外の何でも (EOF-SECRET のような記号つきも)。引用符つきでも、中は字面のまま終端として使う
  const heredoc = /<<-?\s*\\?(?:(['"])([^'"\s]+)\1|([^\s'"<>|&;()]+))/.exec(v);
  if (heredoc) heredoc[2] = heredoc[2] !== undefined ? heredoc[2] : heredoc[3];
  if (heredoc) {
    for (let j = i + 1; j < allLines.length; j++) {
      if (allLines[j].trim() === heredoc[2]) return { last: j, withKeyLine: false };
    }
    return { last: unterminatedEnd, withKeyLine: false };
  }
  const triple = /("""|''')/.exec(v);
  if (triple && (v.split(triple[1]).length - 1) % 2 === 1) {
    for (let j = i + 1; j < allLines.length; j++) {
      if (allLines[j].includes(triple[1])) return { last: j, withKeyLine: true };
    }
    return { last: unterminatedEnd, withKeyLine: true };
  }
  const open = /^\$?(["'`])/.exec(v); // Bash の $'...' (ANSI-C 引用) も同じ
  if (open) {
    const findClose = (s, from) => {
      for (let k = from; k < s.length; k++) {
        if (s[k] === '\\' && open[1] !== "'") {
          k++;
          continue;
        }
        if (s[k] === open[1]) return k;
      }
      return -1;
    };
    if (findClose(v, 1) === -1) {
      for (let j = i + 1; j < allLines.length; j++) {
        if (findClose(allLines[j], 0) !== -1) return { last: j, withKeyLine: true };
      }
      return { last: unterminatedEnd, withKeyLine: true };
    }
  }
  return none;
}

function citeCredentialBlockHit(allLines, start, end) {
  for (let i = 0; i < allLines.length; i++) {
    const { last, withKeyLine } = citeCredentialBlockEnd(allLines, i);
    if (last > i) {
      const blockStart = withKeyLine ? i + 1 : i + 2; // ブロックの最初の行 (1 始まり)
      const blockEnd = last + 1;
      if (blockStart <= end && blockEnd >= start) return Math.max(start, blockStart);
      i = last;
    }
  }
  return null;
}

// 秘密鍵のブロック (BEGIN 〜 END。END が無ければファイルの終わりまで) の内側の行だけを引く場合も止める
// (BEGIN の行を含まない範囲は、1 行ずつの規則では当たらない)。戻り: 範囲の中の最初の該当行 (ファイル全体での 1 始まりの行番号) | null。
function citePrivateKeyBlockHit(allLines, start, end) {
  let blockStart = 0;
  for (let i = 0; i < allLines.length; i++) {
    const n = i + 1;
    // 境界は「行全体がマーカーだけ」の行に限る (本物の PEM の形。コードの中の文字列リテラルを境界と取り違えて、後ろ全部を鍵とみなさない)
    if (!blockStart && /^\s*-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----\s*$/.test(allLines[i])) blockStart = n;
    if (!blockStart) continue;
    const ended = /^\s*-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----\s*$/.test(allLines[i]);
    if (ended || n === allLines.length) {
      if (blockStart <= end && n >= start) return Math.max(start, blockStart);
      blockStart = 0;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// include= の許可リスト (FB 2)。約束 (ここだけが保証):
//   G1. include= は、最後の拡張子が下の一覧にあるファイルだけを引ける。判定は大文字小文字を区別せず、書かれたパスと実体のパス
//       (リンク・ジャンクションの先)、rev= のときはリポジトリ内の正規のパスの全部に当てる。一覧にない拡張子 (拡張子の無い
//       ファイル・ドットで始まるだけの名前を含む) は、ファイルを開く・数える・git から読むより前に拒否する。
//   G2. 一覧にないファイルの cite= は、照合はするが、診断に実物の行を出さない (書き手が書いた行・行番号・行数だけを出す)。
//   約束しない: 名前でなく中身の形式 (許可された拡張子のファイルに設定が入っている場合)、ハードリンク (別名は見分けられない)。
//   パス・中身の形で止める第 2 の網 (FB 1) は、約束の外で「拾える範囲で拾う」。
// 決め方: プログラムやマークアップの本文を書くための形式を許可し、値を保存するための形式と、不明な拡張子は拒否する (既定は拒否)。
// ---------------------------------------------------------------------------
const CITE_INCLUDE_ALLOWED_EXTS = new Set([
  // ソースコード
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'pyi', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'cxx',
  'hpp', 'hh', 'cs', 'rb', 'php', 'lua', 'pl', 'pm', 'r', 'scala', 'dart', 'ex', 'exs', 'erl', 'hs', 'ml', 'clj', 'groovy', 'vue', 'svelte', 'astro',
  // スクリプト
  'sh', 'bash', 'zsh', 'ps1', 'psm1', 'bat', 'cmd',
  // マークアップ・文書・スタイル
  'md', 'mdx', 'html', 'htm', 'css', 'scss', 'sass', 'less',
  // インタフェース・スキーマ言語
  'proto', 'graphql', 'gql',
]);

// パス (区切りは / も \ も) の最後の拡張子 (小文字)。拡張子が無い・ドットで始まるだけの名前 (.env・.json) は ''。
function citeExtOf(p) {
  const base = String(p).replace(/\\/g, '/').split('/').pop();
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

// 許可リストの外なら理由の文字列、中なら ''。
function citeIncludeKindReason(p) {
  const ext = citeExtOf(p);
  if (CITE_INCLUDE_ALLOWED_EXTS.has(ext)) return '';
  return ext ? '拡張子 .' + ext : '拡張子が無い (または名前がドットで始まるだけ)';
}

// 1 つのフェンス (cite 系の属性あり) を評価する。戻り: { ok:true, lines, abs, fullRev } | { ok:false, tag, detail }
//   tag: 指定が不正 / 引けない種類のファイル / 秘密の疑い / ファイル無し / 範囲が実物を超える / 範囲ずれ / 中身違い / UNVERIFIABLE
function evaluateCite(block) {
  const c = block.cite;
  const bad = (tag, detail) => ({ ok: false, tag, detail });
  if (c.errors.length) return bad('指定が不正', c.errors.join(' / '));
  const lang = parseFenceInfo(stripCiteAttrs(block.info)).lang.toLowerCase();
  if (lang === 'mermaid' || lang === 'svg') return bad('指定が不正', '図ブロック (mermaid / svg) には cite= / include= を使えない');
  const sp = parseCiteSpec(c.spec);
  if (!sp) {
    return bad(
      '指定が不正',
      '範囲 "パス:開始-終了" (または "パス:行") が読めない、またはパスに使えない書き方がある (ドライブ文字以外のコロン・? * < > | "・末尾のドットや空白): ' + citeShort(c.spec)
    );
  }
  if (c.rev !== null && !CITE_REV_RE.test(c.rev)) {
    return bad('指定が不正', 'rev は commit の 7〜40 桁の 16 進 (HEAD やブランチ名は動くので不可): ' + citeShort(c.rev));
  }
  // include= は本文を 1 行も書かない (空行・空白だけの行も不可。黙って本文を捨てない)。cite= は空白だけの本文を引用と認めない。
  if (c.kind === 'include' && block.content.length > 0) {
    return bad('指定が不正', 'include= なのに本文がある (空行・空白だけの行も不可。本文を消すか cite= にする)');
  }
  if (c.kind === 'cite' && !block.content.some((l) => l.trim() !== '')) {
    return bad('指定が不正', 'cite= なのに引用本文が空 (写さずに引くなら include=)');
  }
  const target = citeResolveTarget(sp.path);
  if (target.unverifiable) return bad('UNVERIFIABLE', target.unverifiable);
  // 許可リスト (G1・G2)。書かれたパス → 実体のパス → rev= のときはリポジトリ内の正規のパス、の順に拡張子を検査する。
  // どれも、ファイルを開く・数える・git の中身を読む・診断を作るより前 (パスの解決とメタデータだけ)。
  //   include= は、一覧の外なら即座に拒否する。cite= は、一覧の外でも照合するが、診断に実物の行を出さない (restricted)。
  let restricted = false;
  const denyInclude = (why) =>
    bad(
      '引けない種類のファイル',
      'include= で引けるのは、プログラムやマークアップの拡張子のファイルだけ (' + why + ')。設定・データの形式かもしれないので、ファイルは開かない。' +
        '見せたい行は cite= で自分で書いて照合する (許可する拡張子は SKILL.md) : ' + target.abs
    );
  const kindWritten = citeIncludeKindReason(target.abs);
  if (kindWritten) {
    if (c.kind === 'include') return denyInclude(kindWritten);
    restricted = true;
  }
  let realTarget = null;
  try {
    if (_citeIo.exists(target.abs)) realTarget = _citeIo.realpath(target.abs);
  } catch (e) {
    /* 実体を解決できなければ、書かれたパスだけで判定する (読み出しの段階で UNVERIFIABLE になる) */
  }
  if (realTarget) {
    const kindReal = citeIncludeKindReason(realTarget);
    if (kindReal) {
      if (c.kind === 'include') return denyInclude('実体のパスが ' + kindReal);
      restricted = true;
    }
  }
  let revWhere = null; // 検査した rev 用のパス。読み出しにそのまま渡す (二度解決して、検査していない別のパスを読まないため)
  if (c.rev) {
    const where = citeResolveRevPath(target.abs);
    revWhere = where;
    if (!where.unreadable) {
      const kindRel = citeIncludeKindReason(where.rel);
      if (kindRel) {
        if (c.kind === 'include') return denyInclude('git のリポジトリ内のパスが ' + kindRel);
        restricted = true;
      }
    }
  }
  // 秘密を含みうるファイルは、書かれたパスと実体のパス (シンボリックリンクの先) の両方で見て、中身を読む前に止める (第 2 の網)
  const pathsToCheck = realTarget ? [target.abs, realTarget] : [target.abs];
  for (const pth of pathsToCheck) {
    const why = citeSecretPathReason(pth);
    if (why) {
      return bad('秘密の疑い', 'パスが秘密を含みうるファイルの形 (' + why + ')。中身は読まず、HTML にも出力にも入れない : ' + target.abs);
    }
  }
  // 作業ツリーから読むのに、検査の時点でファイルが存在しない (実体のパスが取れない) なら、読まない。
  // 検査の後に同名のリンクが作られても、検査していない別のファイルを読まないため (rev= は git から読むので対象外)。
  if (!realTarget && !c.rev) return bad('ファイル無し', target.abs);
  // 検査したのと同じ実体のパスを読む (検査した後にリンクが張り替えられても、別のファイルを読まない)。
  const snap = citeReadSnapshot(realTarget || target.abs, c.rev, revWhere);
  // 読んだ後に実体のパスが変わっていないか確かめる (検査と読み出しの間にリンク先が差し替えられた場合は、読んだ中身を使わない)
  if (realTarget) {
    let again = null;
    try {
      again = _citeIo.realpath(target.abs);
    } catch (e) {
      again = null;
    }
    if (again !== realTarget) {
      return bad('UNVERIFIABLE', '照合している間に、実体のパスが変わった (リンク先の差し替えの疑い)。もう一度実行する : ' + target.abs);
    }
  }
  if (snap.unreadable) return bad('UNVERIFIABLE', snap.why + ' : ' + target.abs + (c.rev ? ' @' + c.rev : ''));
  if (snap.missing) {
    return bad('ファイル無し', target.abs + (c.rev ? ' (rev ' + (snap.atRev || c.rev) + ' の時点に無い)' : ''));
  }
  if (sp.end > snap.lines.length) {
    return bad('範囲が実物を超える', '指定 ' + sp.start + '-' + sp.end + ' 行・実物は ' + snap.lines.length + ' 行 : ' + target.abs);
  }
  const actual = snap.lines.slice(sp.start - 1, sp.end);
  // 引く範囲の中身に秘密の形があれば止める (include= は HTML に入れず、cite= は食い違いの診断に出さない)。行の中身は出力しない
  const secretHit = citeSecretContentHit(actual, sp.start > 1 ? snap.lines[sp.start - 2] : undefined);
  if (secretHit) {
    return bad(
      '秘密の疑い',
      '引く範囲の ' + (sp.start + secretHit.line - 1) + ' 行目に秘密の形 (' + secretHit.rule + ')。その行の中身は出力にも HTML にも入れない。範囲を絞り、その行を含まない範囲を引く : ' + target.abs
    );
  }
  const pemLine = citePrivateKeyBlockHit(snap.lines, sp.start, sp.end);
  if (pemLine !== null) {
    return bad(
      '秘密の疑い',
      '引く範囲の ' + pemLine + ' 行目が秘密鍵のブロックの内側。その行の中身は出力にも HTML にも入れない。ブロックを含まない範囲を引く : ' + target.abs
    );
  }
  const credBlockLine = citeCredentialBlockHit(snap.lines, sp.start, sp.end);
  if (credBlockLine !== null) {
    return bad(
      '秘密の疑い',
      '引く範囲の ' + credBlockLine + ' 行目が、資格情報のキー (password・token・api_key など) の下に書かれたブロックの内側。その行の中身は出力にも HTML にも入れない。ブロックを含まない範囲を引く : ' + target.abs
    );
  }
  const done = { ok: true, lines: actual, abs: snap.abs, fullRev: snap.fullRev || null, start: sp.start, end: sp.end };
  if (c.kind === 'include') return done;
  // 箇条書きなどの中でインデントされたフェンスは、開きの行頭の空白の数だけ各行の頭から取り除いて比べる
  // (Markdown のコンテナのインデントであって、実物のインデントではない。実物のインデントは厳密なまま)。
  const containerWidth = (block.indent || '').length;
  const quoted = containerWidth
    ? block.content.map((l) => {
        let k = 0;
        while (k < containerWidth && k < l.length && (l[k] === ' ' || l[k] === '\t')) k++;
        return l.slice(k);
      })
    : block.content;
  if (quoted.length === actual.length && quoted.every((l, i) => l === actual[i])) return done;
  const hits = citeFindSequence(snap.lines, quoted);
  if (hits.length) {
    const ranges = hits.slice(0, 3).map((h) => h + '-' + (h + quoted.length - 1)).join(' / ');
    return bad('範囲ずれ', '引用は実物の ' + ranges + ' 行と完全一致するが、指定は ' + sp.start + '-' + sp.end + ' 行');
  }
  const n = Math.min(quoted.length, actual.length);
  for (let i = 0; i < n; i++) {
    if (quoted[i] !== actual[i]) {
      if (restricted) {
        // G2: 許可リストの外のファイルでは、実物の行も、実物との近さの手がかり (行末の空白だけの違いなど) も出さない
        return bad(
          '中身違い',
          '引用の ' + (i + 1) + ' 行目 ' + citeShort(quoted[i]) + ' が、実物の ' + (sp.start + i) + ' 行目と違う (許可リストの外の種類のファイルなので、実物の行は出さない)'
        );
      }
      const ws = quoted[i].trimEnd() === actual[i].trimEnd() ? ' (行末の空白だけが違う)' : '';
      return bad(
        '中身違い',
        '引用の ' + (i + 1) + ' 行目 ' + citeShort(quoted[i]) + ' ≠ 実物の ' + (sp.start + i) + ' 行目 ' + citeShort(actual[i]) + ws
      );
    }
  }
  return bad('中身違い', '行数が違う: 引用 ' + quoted.length + ' 行・実物の範囲 ' + actual.length + ' 行 (先頭から ' + n + ' 行は一致)');
}

// ブロック列の中のフェンスを文書順に走査する (admonition / blockquote の中も。描画と同じ入れ子の辿り方)。
function walkFences(blocks, fn) {
  for (const b of blocks) {
    if (b.type === 'fence') fn(b);
    else if (b.type === 'admonition' && b.content && b.content.join('').trim()) walkFences(tokenize(b.content.join('\n')), fn);
    else if (b.type === 'blockquote') walkFences(tokenize(b.content.join('\n')), fn);
  }
}

// --verify の引用の照合。宣言が無い文書は declared=0 (何も出さない)。
function verifyCites(md) {
  const { body } = parseFrontmatter(md);
  const items = [];
  walkFences(tokenize(body), (b) => {
    if (b.cite) items.push({ kind: b.cite.kind || '不明', spec: b.cite.spec, rev: b.cite.rev, res: b.citeResult });
  });
  return { declared: items.length, items, failures: items.filter((i) => !i.res.ok) };
}

// include (rev なし) の展開内容。実物が変わったら --check が STALE を出せるよう、埋込ハッシュの入力に足す。
//   rev 付きは時点が固定なので足さない。include が無い文書は '' (ハッシュは従来と byte 一致)。
function citeExpansionTail(md) {
  const { body } = parseFrontmatter(md);
  let tail = '';
  walkFences(tokenize(body), (b) => {
    if (b.cite && b.cite.kind === 'include' && b.cite.rev === null && b.citeResult && b.citeResult.ok) {
      tail += '\n--md-render-include-expansion--\n' + b.cite.spec + '\n' + b.citeResult.lines.join('\n');
    }
  });
  return tail;
}

// ---------------------------------------------------------------------------
// ホバー機能 (opt-in) のレンダラ内状態。
// render() 開始時に必ずリセットする。非 hover 文書では _hoverMode=false のため
// renderInline のリンク出力は一切変化しない (既存リンク byte 不変)。
// 決定論: 状態は MD の frontmatter から純粋に導出され、render() 呼び出し毎に確定する。
// ---------------------------------------------------------------------------

let _hoverMode = false;
let _hoverIndex = null; // Map<識別子(URL等), index 文字列>

// ---------------------------------------------------------------------------
// コードブロックのコピーボタン (既定 on) のレンダラ内状態。
// renderFence がコピー対象のコードブロックを 1 つでも出力したら true。render() 開始時に必ずリセットする。
// admonition / blockquote 内のフェンスは描画時に遅延 tokenize されるため、トップレベル blocks の走査
// ではなく実際の出力で判定する。コピー対象が無い文書は CSS/JS を注入しない = 既存出力 byte 不変。
// ---------------------------------------------------------------------------

let _codeCopyUsed = false;
// チェック欄 (- [ ] 文 / - [x] 文) を 1 つでも出した文書にだけ CSS/ローダを注入するためのフラグ。
// render 毎にリセット (決定論)。チェック欄を含まない文書は byte 不変。
let _taskUsed = false;
// チェック欄の opt-in (frontmatter checkboxes: on)。tokenize が [ ] を外すかどうかを決める。
// 文書を読む入口 (renderDoc / verifyCompleteness / lint) で frontmatter から毎回確定する = 決定論。
// 非宣言文書の - [ ] 文 は従来どおり文字のまま (既存文書の再生成で黙って変わらない)。
let _tasksOn = false;
function setTasksFromFm(fm) { _tasksOn = !!(fm && fm.checkboxes === 'on'); }

// 図のビューア (既定 on) のレンダラ内状態。renderFence が svg フェンスを 1 つでも出力したら true。
// render() 開始時に必ずリセットする。svg の図が無い文書は CSS/JS を注入しない = 既存出力 byte 不変。
let _svgFigUsed = false;

// ---------------------------------------------------------------------------
// 成果物の欄 (opt-in: frontmatter の outputs: ブロックを宣言した文書だけで有効)。
//   書き方: "- 名前 || file: パス" / "- 名前 || dir: パス" (パスはドライブ文字から始まる Windows の絶対パス)。
//   出力は MD の中身だけで決まる: ファイルの有無・MD の置き場所・実行 OS を見ない (有無を見るのは --lint だけ)。
//   ファイルか置き場所かは宣言の種別で決める (実体を見ない)。表示とコピーはパスを書かれたとおりに出す
//   (--verify の HTML⊆MD が frontmatter の原文の部分列であることに依存するため、正規化して出さない)。
//   モジュール可変状態を持たない。コピーの部品は既存の .cb を使い、_codeCopyUsed だけを立てる。
//   outputs は予約キー (従来は未知キーとして無視)。値が空でないスカラ・インライン形は宣言とみなさない。
// ---------------------------------------------------------------------------

const OUTPUT_KINDS = ['file', 'dir'];
const OUTPUT_RESERVED_NAME_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

// 1 行 "名前 || 種別: パス" の読み取り (parseFrontmatter と lintFrontmatterRaw が共用する唯一の経路)。形が読めなければ null。
function parseOutputLine(raw) {
  const sep = raw.indexOf('||');
  if (sep === -1) return null;
  const name = raw.slice(0, sep).trim();
  const rest = raw.slice(sep + 2);
  const colon = rest.indexOf(':');
  if (!name || colon === -1) return null;
  const kind = rest.slice(0, colon).trim();
  const p = rest.slice(colon + 1).trim();
  if (OUTPUT_KINDS.indexOf(kind) === -1 || !p) return null;
  return { name, kind, path: p };
}

// パスの契約。受理できなければ理由 (文字列)、受理できれば ''。
//   受理: 「英字 1 文字 + ':' + 区切り (\ か /)」で始まる Windows の絶対パス。区切りは混在可。
//   拒否: ドライブ文字で始まらない (相対・UNC・\\?\ を含む)・制御文字・各部分の < > : " | ? *・'.' と '..' の部分・
//         空の部分 (区切りの連続)・部分の末尾のドットと空白・予約名 (CON など)・file でパスが区切りで終わる。
function outputPathProblem(kind, p) {
  if (/[\x00-\x1f\x7f]/.test(p)) return '制御文字を含む';
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return 'ドライブ文字から始まる Windows の絶対パス (C:\\... か C:/...) でない (相対パス・UNC・\\\\?\\ は不可)';
  let rest = m[2];
  if (rest === '') return kind === 'dir' ? '' : 'ファイル名が無い';
  if (/[\\/]$/.test(rest)) {
    if (kind === 'file') return 'file のパスが区切りで終わっている';
    rest = rest.slice(0, -1);
  }
  const segs = rest.split(/[\\/]/);
  for (const s of segs) {
    if (s === '') return '空の部分 (区切りが連続している)';
    if (s === '.' || s === '..') return "'.' と '..' の部分は書けない";
    if (/[<>:"|?*]/.test(s)) return '使えない文字 (< > : " | ? *) を含む';
    if (/[. ]$/.test(s)) return '部分の末尾がドットか空白';
    if (OUTPUT_RESERVED_NAME_RE.test(s)) return 'Windows の予約名 (CON など)';
  }
  return '';
}

// グルーピングの鍵 (同じ場所を同じ鍵にする): 区切りを \ に統一し、末尾の区切りを除き、小文字にする。
function outputKey(p) {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

// ファイルの親フォルダ (書かれた綴りのまま)。ルート直下のファイルはルート ("C:\") を返す。
function outputDirOf(p) {
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  const dir = p.slice(0, idx);
  return /^[A-Za-z]:$/.test(dir) ? p.slice(0, idx + 1) : dir;
}

// file:/// URL (純関数。url.pathToFileURL はホスト OS に依存するため使わない)。
//   各部分の '%' を '%25'、'~' を '%7E' に先にし (Node の pathToFileURL と同じ結果にそろえる)、
//   残り (日本語・空白・# ・? など) は WHATWG URL の pathname 代入に符号化させる。
//   フォルダは末尾 '/'。入力は outputPathProblem を通った値であること。
function outputFileUrl(p, asDir) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  const segs = m[2].split(/[\\/]/).filter(Boolean).map((s) => s.replace(/%/g, '%25').replace(/~/g, '%7E'));
  const u = new URL('file:///');
  u.pathname = '/' + m[1] + ':/' + segs.join('/') + (asDir && segs.length ? '/' : '');
  return u.href;
}

// 宣言 (frontmatter の outputs ブロックが {name,kind,path} の配列になったもの) のうち、描画できる有効な宣言。
// 無効な行 (形が読めない・パスが契約に反する) と重複 (同じ種別・同じ場所) は描画しない。無ければ null。
function outputsDecls(fm) {
  const v = fm && fm.outputs;
  if (!Array.isArray(v) || v.length === 0) return null;
  const seen = new Set();
  const out = [];
  for (const d of v) {
    if (!d || typeof d.path !== 'string' || OUTPUT_KINDS.indexOf(d.kind) === -1) continue;
    if (outputPathProblem(d.kind, d.path)) continue;
    const key = d.kind + ':' + outputKey(d.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out.length ? out : null;
}

// フォルダごとにまとめる (宣言順・最初の出現順)。file の親フォルダが宣言済みの dir と同じ場所なら同じ組に入れる。
function outputsGroups(decls) {
  const groups = [];
  const index = new Map();
  const ensure = (key, dirPath, dirName) => {
    let g = index.get(key);
    if (!g) {
      g = { dirPath, dirName, files: [] };
      index.set(key, g);
      groups.push(g);
    } else if (dirName !== null && g.dirName === null) {
      g.dirPath = dirPath;
      g.dirName = dirName;
    }
    return g;
  };
  for (const d of decls) {
    if (d.kind === 'dir') ensure(outputKey(d.path), d.path, d.name);
    else {
      const dir = outputDirOf(d.path);
      ensure(outputKey(dir), dir, null).files.push(d);
    }
  }
  return groups;
}

// パスのコピー用ブロック (既存の .cb の部品)。ラベルは data-label → CSS attr()、ボタン文字は CSS 擬似要素 = 静的テキストノードを増やさない。
function outputCopyBlock(label, text) {
  _codeCopyUsed = true;
  return (
    '<div class="cb"><div class="cb-bar" data-label="' + escapeAttr(label) + '">' +
    '<button type="button" class="cb-copy" aria-label="' + escapeAttr('「' + label + '」をコピー') + '"></button>' +
    '</div><pre class="code" data-lang="text"><code>' + escapeHtml(text) + '</code></pre></div>'
  );
}

function renderOutputsPanel(decls) {
  let h = '<section class="panel panel-outputs" aria-label="成果物の置き場所">';
  for (const g of outputsGroups(decls)) {
    h += '<div class="out-group"><div class="out-dir">';
    if (g.dirName !== null) h += '<span class="out-name">' + escapeHtml(g.dirName) + '</span>';
    h +=
      '<a class="out-open" href="' + escapeAttr(outputFileUrl(g.dirPath, true)) +
      '" target="_blank" rel="noopener" aria-label="' + escapeAttr('フォルダを開く: ' + (g.dirName !== null ? g.dirName : g.dirPath)) + '"></a>';
    h += outputCopyBlock('フォルダのパス', g.dirPath) + '</div>';
    if (g.files.length) {
      h += '<ul class="out-files">';
      for (const f of g.files) {
        h += '<li><span class="out-name">' + escapeHtml(f.name) + '</span>' + outputCopyBlock('ファイルのパス', f.path) + '</li>';
      }
      h += '</ul>';
    }
    h += '</div>';
  }
  return h + '</section>';
}

const OUTPUTS_CSS = `
.panel-outputs{border-left:4px solid var(--da)}
.panel-outputs::before{content:"成果物の置き場所";display:block;font-weight:700;color:var(--da);margin:.4em 0 .2em}
.out-dir{display:flex;flex-wrap:wrap;align-items:center;gap:.4em .8em}
.out-name{font-weight:600}
.out-open{display:inline-block;padding:.3em 1em;border:1px solid var(--accent);border-radius:999px;
  background:var(--accent-soft);font-size:.9em}
.out-open::before{content:"フォルダを開く"}
.out-open:hover{text-decoration:none;background:var(--accent);color:var(--bg)}
.out-open:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.panel-outputs .cb{flex:1 1 100%;margin:.25em 0 0;min-width:0}
.panel-outputs .cb-bar{min-height:30px;padding:2px 6px 2px 12px}
.panel-outputs .cb-copy{min-height:24px;padding:.15em .7em}
.panel-outputs .cb>pre.code{padding:6px 12px;font-size:.85em}
.out-files{list-style:none;margin:.3em 0 0;padding-left:1.2em}
.out-files>li{margin:.35em 0}
.out-group{margin:.4em 0 .7em}
@media print{.out-open{display:none}}
`;

// ---------------------------------------------------------------------------
// 押せる図 (opt-in: frontmatter の figure_links: ブロックを宣言した文書だけで有効)。
//   図 (mermaid flowchart) のノードを押すと、見出し / 表の行 / 箇条 (飛び先) へ移り、「図に戻る」で戻る。
//   mermaid の securityLevel は緩めず click 構文も使わない。描画後の SVG に、固定ローダがクリックを結線する。
//   宣言の書き方: "- ノードID || heading|row|item: 文字列"。figure_links は予約キー (従来は未知キーとして無視)。
//   宣言なし・有効な宣言が 0 件の文書は、従来と byte 一致の経路で描画する (_figPlan === null)。
// 状態の契約: このレンダラのモジュール可変状態は _hoverMode / _hoverIndex / _codeCopyUsed / _svgFigUsed / _figPlan / _daScaleTable だけ。
//   いずれも renderDoc() の冒頭で必ずリセットする (発見パス・最終パス・宣言なし経路のどれも同じ)。
// 二段階描画: render() は薄い包み。宣言があれば 発見パス (全飛び先へ id を付けて報告を集める) →
//   有効な宣言の確定 → 最終パス (有効な飛び先にだけ id を付ける)。両パスの差分は「有効な飛び先の <tr>/<li> の id・
//   データ島・専用 CSS/JS/チップ」だけ (selftest の figlink-diff-scope が固定)。
// 個数の正本は描画器: 照合の当たり数 (matches)・id を実際に付けた数 (stamped) は出力点で数える。--lint はこの報告を読む。
// ---------------------------------------------------------------------------

let _figPlan = null;

const FIGLINK_KINDS = ['heading', 'row', 'item'];
const FIGLINK_NODE_RE = /^[A-Za-z0-9_]+$/;

// 1 行 "ノードID || 種別: 文字列" の読み取り (parseFrontmatter と lintFrontmatterRaw が共用する唯一の経路)。読めなければ null。
function parseFigLinkLine(raw) {
  const sep = raw.indexOf('||');
  if (sep === -1) return null;
  const node = raw.slice(0, sep).trim();
  const rest = raw.slice(sep + 2);
  const colon = rest.indexOf(':');
  if (!node || colon === -1) return null;
  const kind = rest.slice(0, colon).trim();
  const text = rest.slice(colon + 1).trim();
  if (FIGLINK_KINDS.indexOf(kind) === -1 || !text) return null;
  return { node, kind, text };
}

// 照合用の正規化 (宣言側・描画側の両方がこの 1 関数を通る): リンク [t](u) → t、** と ` の除去、NFC、
// 全空白 (U+3000 を含む) の畳み込み、前後 trim。
function figLinkPlain(s) {
  return String(s)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|`/g, '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

// heading / row は完全一致。item は完全一致、または「文字列＋空白」で始まる (M2 が M22 を拾わない)。
function figLinkMatches(kind, specNorm, plain) {
  if (kind === 'item') return plain === specNorm || plain.startsWith(specNorm + ' ');
  return plain === specNorm;
}

// 宣言 (frontmatter の figure_links ブロックが {node,kind,text} の配列になったもの)。無ければ null。
// 空値・スカラ・インライン [a, b] は宣言とみなさない (従来どおり未知キーとして無視)。
function figLinkDecls(fm) {
  const v = fm && fm.figure_links;
  if (!Array.isArray(v) || v.length === 0) return null;
  if (!v.every((x) => x && typeof x === 'object' && typeof x.node === 'string')) return null;
  return v;
}

// 図リンク計画 (1 回の描画で使う状態)。飛び先は (種別, 正規化 text) 単位の表に 1 度だけ載せる (多対一を許す)。
// 表の行・箇条の飛び先には宣言順の通し番号 id (fl-1, fl-2, ...) を割り当てる。見出しは既存の id を描画時に記録する。
function figLinkMakePlan(decls) {
  const dests = new Map();
  let seq = 0;
  const items = decls.map((d) => {
    const norm = figLinkPlain(d.text);
    const key = d.kind + ':' + norm;
    if (!dests.has(key)) {
      dests.set(key, {
        kind: d.kind, norm,
        id: d.kind === 'heading' ? null : 'fl-' + (++seq),
        toId: null, matches: 0, stamped: 0,
      });
    }
    return { node: d.node, kind: d.kind, text: d.text, key, nodeFound: 0, nodeOk: FIGLINK_NODE_RE.test(d.node) };
  });
  return { dests, items, headingIds: new Map() };
}

// 表の行 (kind=row: 1 列目) / 箇条 (kind=item: 本文) の出力点。当たり数を数え、飛び先ごとに最初の 1 件だけ id を付ける。
// 同じ要素に別の飛び先も当たったときは同じ id を共有する。計画が無ければ '' (= 従来と同じ文字列)。
function figLinkStamp(kind, raw) {
  if (!_figPlan) return '';
  const plain = figLinkPlain(raw);
  let id = '';
  for (const d of _figPlan.dests.values()) {
    if (d.kind !== kind || !figLinkMatches(kind, d.norm, plain)) continue;
    d.matches++;
    if (d.stamped === 0) {
      if (!id) id = d.id;
      d.stamped = 1;
      d.toId = id;
    }
  }
  return id ? ' id="' + id + '"' : '';
}

// 見出しの出力点。出力された見出し id ごとの数 (id 衝突の検出) と、heading の飛び先の当たり数を数える。
function figLinkNoteHeading(b) {
  if (!_figPlan) return;
  _figPlan.headingIds.set(b.id, (_figPlan.headingIds.get(b.id) || 0) + 1);
  if (b.level < 2) return; // H1 は文書タイトル (本文の 2 つ目以降の H1 を含め) を飛び先にしない。id の衝突だけは上で数える
  const plain = figLinkPlain(b.text);
  for (const d of _figPlan.dests.values()) {
    if (d.kind !== 'heading' || d.norm !== plain) continue;
    d.matches++;
    if (d.stamped === 0) {
      d.stamped = 1;
      d.toId = b.id;
    }
  }
}

// mermaid フェンスの出力点。静的検査は「必要条件」だけ: flowchart/graph の原文に宣言ノード ID が、語の境界つきの
// そのままの文字列として 1 度も現れなければ nodeFound は 0 (コメント・引用符の除去はしない = 誤って error にしない)。
// 実際に SVG ノードになったかは実行時のローダが検証する。
function figLinkNoteFence(raw) {
  if (!_figPlan || !/^\s*(graph|flowchart)\b/m.test(raw)) return;
  for (const it of _figPlan.items) {
    if (!it.nodeOk) continue; // ノード ID の文法を満たすものだけを正規表現に使う
    if (new RegExp('(?<![A-Za-z0-9_])' + it.node + '(?![A-Za-z0-9_])').test(raw)) it.nodeFound++;
  }
}

// 描画後の計画から、宣言ごとの有効性と理由を出す。有効 = ノード ID が文法内で図の原文にあり・他の宣言と重ならず・
// 飛び先が一意 (当たり 1 件・id を付けた) で、見出しなら id が他の見出しと衝突していない。
function figLinkAssess(plan) {
  const nodeCount = new Map();
  plan.items.forEach((it) => nodeCount.set(it.node, (nodeCount.get(it.node) || 0) + 1));
  return plan.items.map((it) => {
    const d = plan.dests.get(it.key);
    const reasons = [];
    if (!it.nodeOk) reasons.push('ノード ID は英数字と _ だけ');
    else if (it.nodeFound < 1) reasons.push('ノード ID が flowchart/graph の図の原文に無い');
    if (nodeCount.get(it.node) > 1) reasons.push('同じノード ID が複数の宣言にある');
    if (d.matches === 0) reasons.push('飛び先が 0 件');
    else if (d.matches > 1) reasons.push('飛び先が ' + d.matches + ' 件あり一意でない');
    else if (d.stamped !== 1) reasons.push('飛び先に id を付けられなかった');
    else if (d.kind === 'heading' && plan.headingIds.get(d.toId) !== 1) reasons.push('見出しの id が他の見出しと衝突している');
    return { item: it, dest: d, valid: reasons.length === 0, reasons };
  });
}

// 発見パス: 全宣言の飛び先へ id を付けて 1 回描画し、報告 (宣言ごとの有効性) を返す。--lint もこれを読む。
function figLinkDiscover(md, srcFileName, decls) {
  const plan = figLinkMakePlan(decls);
  renderDoc(md, srcFileName, plan);
  return { plan, results: figLinkAssess(plan) };
}

// 最終出力に注入する部品 (データ島+戻りチップ)。結線できる宣言が 1 件も無ければ null (何も注入しない)。
function figLinkParts(plan) {
  const links = [];
  plan.items.forEach((it) => {
    const d = plan.dests.get(it.key);
    if (d && d.toId) links.push({ node: it.node, to: d.toId, label: it.text });
  });
  if (!links.length) return null;
  return { html: figLinkDataIsland(links) + FIGLINK_HTML };
}

// ---------------------------------------------------------------------------
// インライン: code span / bold / link のみ (regs §4-2 の 8 種のインライン部)
// 未対応のインライン記法はリテラル退化 (全リテラル文字はエスケープ経由)。
// ---------------------------------------------------------------------------

function renderInline(raw) {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    // code span
    if (c === '`') {
      const end = raw.indexOf('`', i + 1);
      if (end !== -1) {
        out += '<code>' + escapeHtml(raw.slice(i + 1, end)) + '</code>';
        i = end + 1;
        continue;
      }
    }
    // bold **...**
    if (c === '*' && raw[i + 1] === '*') {
      const end = raw.indexOf('**', i + 2);
      if (end !== -1) {
        out += '<strong>' + renderInline(raw.slice(i + 2, end)) + '</strong>';
        i = end + 2;
        continue;
      }
    }
    // link [text](url)
    if (c === '[') {
      const close = raw.indexOf(']', i + 1);
      if (close !== -1 && raw[close + 1] === '(') {
        const paren = raw.indexOf(')', close + 2);
        if (paren !== -1) {
          const text = raw.slice(i + 1, close);
          const url = raw.slice(close + 2, paren);
          // ホバー属性付与は厳密に gating 内に閉じ込める:
          //   hoverMode かつ URL が http/https かつ fm.hover の識別子に一致する時のみ。
          // それ以外 (非 hover 文書 / 非一致 / 相対 / mailto 等) は従来どおり無属性
          //   → 既存リンク出力 byte 不変。
          let extra = '';
          if (_hoverMode && _hoverIndex && /^https?:\/\//.test(url) && _hoverIndex.has(url)) {
            extra =
              ' class="hoverable" data-hkey="' + escapeAttr(_hoverIndex.get(url)) +
              '" target="_blank" rel="noopener"';
          }
          out += '<a href="' + escapeAttr(url) + '"' + extra + '>' + renderInline(text) + '</a>';
          i = paren + 1;
          continue;
        }
      }
    }
    out += escapeHtml(c);
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// frontmatter (最小 YAML サブセット: scalar + インラインリスト [a, b])
// ---------------------------------------------------------------------------

function parseFrontmatter(md) {
  if (!md.startsWith('---\n') && !md.startsWith('---\r\n')) {
    return { fm: null, fmOrder: [], body: md };
  }
  const lines = md.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { fm: null, fmOrder: [], body: md };

  const fm = {};
  const fmOrder = [];
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    // hover: ブロック宣言 (opt-in)。値が空で、次行以降がインデントされた
    //   "- 識別子 || 要約文" の場合のみ配列 fm.hover=[{key,summary}] に捕捉する。
    //   hover: 不在時はこの分岐に入らず既存挙動を一切変えない。
    //   壊れた行 (|| 区切りなし等) は捕捉対象から外す (lint が警告する)。
    if (key === 'hover' && val === '') {
      const items = [];
      let j = i + 1;
      while (j < end && /^\s+\S/.test(lines[j])) {
        const im = lines[j].match(/^\s+-\s+(.*)$/);
        if (im) {
          const raw = im[1];
          const sep = raw.indexOf('||');
          if (sep !== -1) {
            const hk = raw.slice(0, sep).trim();
            const summary = raw.slice(sep + 2).trim();
            if (hk) items.push({ key: hk, summary });
          }
          // || なしの壊れた行は捕捉しない (lint 警告対象)
        }
        j++;
      }
      i = j - 1; // 消費した子行をスキップ
      fm.hover = items;
      fmOrder.push('hover');
      continue;
    }
    // comments_resolved: ブロック宣言 (opt-in)。hover と同型。値が空で、次行以降が
    //   インデントされた以下いずれかの場合のみ fm.comments_resolved に捕捉する。
    //     3 部: "- 見出し || 元コメント || CC 対応メモ" → {key, original, memo}
    //     2 部: "- 見出し || CC 対応メモ"               → {key, memo, original:''}
    //   区切りは "||" (前後の空白は trim)。3 部は最初の "||" を sep1、2 番目を sep2 とする。
    //   後方互換: 2 部 (元コメント無し) は従来どおり original を空文字にし読取専用埋込を出さない。
    //   ※ "||" は本 DSL の予約区切り子。entry 内に 3 個以上 "||" がある場合、最初の 2 個で
    //     見出し/元コメント/メモに 3 分割し、3 個目以降はメモ本文の一部として残る (sep2 は最初の
    //     1 個のみ消費)。よって元コメント・メモ本文に "||" を含めない (含めると分割位置がずれる)。
    //     Codex MINOR 指摘: 旧 2 部メモが "||" を含むと 3 部に再解釈される → 元コメント/メモは
    //     "||" 非含有を前提とする運用契約 (SKILL.md にも明記)。
    //   comments_resolved: 不在時はこの分岐に入らず既存挙動を一切変えない (byte 不変)。
    //   壊れた行 (|| 区切りなし等) は捕捉対象から外す (lint が警告する)。
    if (key === 'comments_resolved' && val === '') {
      const items = [];
      let j = i + 1;
      while (j < end && /^\s+\S/.test(lines[j])) {
        const im = lines[j].match(/^\s+-\s+(.*)$/);
        if (im) {
          const raw = im[1];
          const sep1 = raw.indexOf('||');
          if (sep1 !== -1) {
            const rk = raw.slice(0, sep1).trim();
            const rest = raw.slice(sep1 + 2);
            const sep2 = rest.indexOf('||');
            if (sep2 !== -1) {
              // 3 部: 見出し || 元コメント || CC 対応メモ
              const original = rest.slice(0, sep2).trim();
              const memo = rest.slice(sep2 + 2).trim();
              if (rk) items.push({ key: rk, original, memo });
            } else {
              // 2 部: 見出し || CC 対応メモ (元コメント無し)
              const memo = rest.trim();
              if (rk) items.push({ key: rk, memo, original: '' });
            }
          }
          // || なしの壊れた行は捕捉しない (lint 警告対象)
        }
        j++;
      }
      i = j - 1; // 消費した子行をスキップ
      fm.comments_resolved = items;
      fmOrder.push('comments_resolved');
      continue;
    }
    // figure_links: ブロック宣言 (opt-in・押せる図)。hover と同型で、値が空で次行以降がインデントされた
    //   "- ノードID || heading|row|item: 文字列" の行だけを fm.figure_links=[{node,kind,text}] に捕捉する。
    //   読めない行は捕捉しない (lint が、ブロック形の誤用として警告する)。figure_links: 不在・空値でない
    //   スカラ/インライン形は、この分岐に入らず従来どおり 1 行のスカラ/リストとして扱う (output byte 不変)。
    if (key === 'figure_links' && val === '') {
      const items = [];
      let j = i + 1;
      while (j < end && /^\s+\S/.test(lines[j])) {
        const im = lines[j].match(/^\s+-\s+(.*)$/);
        if (im) {
          const parsed = parseFigLinkLine(im[1]);
          if (parsed) items.push(parsed);
        }
        j++;
      }
      i = j - 1; // 消費した子行をスキップ
      fm.figure_links = items;
      fmOrder.push('figure_links');
      continue;
    }
    // outputs: ブロック宣言 (opt-in・成果物の欄)。figure_links と同型で、値が空で次行以降がインデントされた
    //   "- 名前 || file|dir: パス" の行だけを fm.outputs=[{name,kind,path}] に捕捉する。形の読めない行は捕捉しない
    //   (lint が error にする)。outputs: 不在・値が空でない形は、この分岐に入らず従来どおり 1 行のスカラ/リストとして扱う。
    if (key === 'outputs' && val === '') {
      const items = [];
      let j = i + 1;
      while (j < end && /^\s+\S/.test(lines[j])) {
        const im = lines[j].match(/^\s+-\s+(.*)$/);
        if (im) {
          const parsed = parseOutputLine(im[1]);
          if (parsed) items.push(parsed);
        }
        j++;
      }
      i = j - 1; // 消費した子行をスキップ
      fm.outputs = items;
      fmOrder.push('outputs');
      continue;
    }
    // インラインリストは最初の ']' で閉じる (末尾コメント "[a, b]  # ..." を許容)。
    // スカラ値の ' #' は除去しない (既存文書に "FeatureRequest #7" 等の正当値が実在)。
    if (val.startsWith('[')) {
      const close = val.indexOf(']');
      if (close !== -1) {
        val = val.slice(1, close).split(',').map((x) => x.trim()).filter(Boolean);
      }
    }
    fm[key] = val;
    fmOrder.push(key);
  }
  const body = lines.slice(end + 1).join('\n');
  return { fm, fmOrder, body };
}

// ---------------------------------------------------------------------------
// ブロックトークナイザ (行ベース, 8 種)
//  heading / table / fence(code|mermaid|svg) / blockquote(admonition) /
//  list / hr / paragraph
// ---------------------------------------------------------------------------

function isTableSeparator(line) {
  // |---|:--:|---| 形式
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
}

// 行内の位置 i の '|' がエスケープされているか: 直前の連続するバックスラッシュの個数が奇数なら '\|' (GFM と同じ)。
//   偶数 ('\\|' など) は、バックスラッシュ同士が対になるだけで '|' は区切りのまま。
function isEscapedPipeAt(s, i) {
  let n = 0;
  for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) n++;
  return n % 2 === 1;
}

// セルへ分割する (GFM): エスケープされていない '|' で割り、エスケープされた '\|' はセルの中の '|' に戻す
// (戻すのはエスケープの 1 本だけ。他のバックスラッシュは触らない)。バッククォートの中の裸の '|' も割れる
// (GFM と同じ。セルの中に '|' を書くなら '\|'。列数の食い違いは --lint が知らせる)。
// '\|' を含まない行は、従来の素の split と同じ結果になる。
function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !isEscapedPipeAt(s, s.length - 1)) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '|') {
      if (isEscapedPipeAt(s, i)) {
        cur = cur.slice(0, -1) + '|';
      } else {
        cells.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function tokenize(body) {
  const lines = body.split(/\r?\n/);
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (line.trim() === '') {
      i++;
      continue;
    }

    // フェンス (``` or ~~~, >=3, 可変長)
    const fence = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const indent = fence[1];
      const marker = fence[2];
      const info = fence[3].trim();
      const content = [];
      i++;
      while (i < lines.length) {
        const close = lines[i].match(/^(\s*)(`{3,}|~{3,})\s*$/);
        if (close && lines[i].trim().startsWith(marker[0]) && close[2].length >= marker.length) {
          i++;
          break;
        }
        content.push(lines[i]);
        i++;
      }
      const fenceBlock = { type: 'fence', info, content, indent };
      if (hasCiteAttrs(info)) {
        // cite= / include= / rev= を書いたフェンスだけ、実物と照合する。include は成功したら実物の行を本文にする。
        fenceBlock.cite = parseCiteAttrs(info);
        fenceBlock.citeResult = evaluateCite(fenceBlock);
        if (fenceBlock.citeResult.ok && fenceBlock.cite.kind === 'include') fenceBlock.content = fenceBlock.citeResult.lines;
      }
      blocks.push(fenceBlock);
      continue;
    }

    // 見出し H1-H4
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const htext = heading[2].trim();
      // アンカー: 位置非依存・見出し依存 (sec-+sha1(canon(見出し))[:8])。再レンダリングでも
      // 見出しが同じなら id 不変 = コメントが迷子にならない (RDV 移植の最重要価値)。
      // 接尾辞は付けない (canon 同一見出しは id 共有 = 完全決定論。重複は lint が警告)。
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        text: htext,
        id: 'sec-' + sha1(canon(htext)).slice(0, 8),
      });
      i++;
      continue;
    }

    // 水平線 (--- / *** / ___)  ※ frontmatter は parseFrontmatter で除去済み
    if (/^(\s*)(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // blockquote (admonition 含む)
    if (/^\s*>/.test(line)) {
      const quoteLines = [];
      const quoteLine = i; // 引用の先頭行の本文内の行番号 (0 始まり)。--lint が引用の中の表の位置を MD の行番号で知らせるのに使う (描画には使わない)
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      const first = quoteLines[0] || '';
      const adm = first.match(/^\[!([A-Za-z]+)\]\s*(.*)$/);
      if (adm) {
        blocks.push({
          type: 'admonition',
          adType: adm[1].toUpperCase(),
          title: adm[2].trim(),
          content: quoteLines.slice(1),
          line: quoteLine,
        });
      } else {
        blocks.push({ type: 'blockquote', content: quoteLines, line: quoteLine });
      }
      continue;
    }

    // テーブル (現在行に | があり、次行が区切り行)
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':');
        const r = c.endsWith(':');
        if (l && r) return 'center';
        if (r) return 'right';
        if (l) return 'left';
        return '';
      });
      const rows = [];
      const tableLine = i; // ヘッダ行の本文内の行番号 (0 始まり)。--lint が列数の食い違いの位置を知らせるのに使う (描画には使わない)
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', header, aligns, rows, line: tableLine });
      continue;
    }

    // リスト (- / * / + / 数字., ネスト 2 段まで)
    if (/^(\s*)([-*+]|\d+\.)\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^(\s*)([-*+]|\d+\.)\s+/.test(lines[i])) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        const indent = m[1].length;
        const ordered = /\d+\./.test(m[2]);
        // チェック欄 (checkboxes: on を宣言した文書だけ): 先頭が "[ ] " / "[x] " の項目。
        //   印は text から外す (verify の片も HTML も印なし)。非宣言文書は従来どおり文字のまま = byte 不変。
        const tm = _tasksOn ? m[3].match(/^\[( |x|X)\]\s+(.*)$/) : null;
        if (tm) items.push({ indent, ordered, text: tm[2], task: true, checked: tm[1] !== ' ' });
        else items.push({ indent, ordered, text: m[3] });
        i++;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    // 段落 (連続する非特殊行)
    const para = [];
    while (i < lines.length && lines[i].trim() !== '') {
      const l = lines[i];
      if (
        /^(#{1,4})\s+/.test(l) ||
        /^\s*>/.test(l) ||
        /^(\s*)(`{3,}|~{3,})/.test(l) ||
        /^(\s*)(-{3,}|\*{3,}|_{3,})\s*$/.test(l) ||
        /^(\s*)([-*+]|\d+\.)\s+/.test(l) ||
        (l.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
      ) {
        break;
      }
      para.push(l);
      i++;
    }
    if (para.length) blocks.push({ type: 'paragraph', lines: para });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// admonition 型 → CSS クラス + 表示ラベルは CSS 擬似要素 (テキストノード非生成)
// ---------------------------------------------------------------------------

const ADM_CLASS = {
  DECISION: 'adm-decision',
  DA: 'adm-da',
  NOTE: 'adm-note',
  WARNING: 'adm-warning',
  TIP: 'adm-tip',
  IMPORTANT: 'adm-important',
};

// ---------------------------------------------------------------------------
// ブロック描画
// ---------------------------------------------------------------------------

function renderList(items, summaryBadge) {
  // ネスト 2 段まで。indent でグルーピング
  // summaryBadge: 結論の概要パネル限定。最上位 li の先頭が **OK/FAIL/CAVEAT/INFO** 完全一致なら
  //   状態バッジ (色付きピル) に変換。ラベル文字は MD 由来 (HTML⊆MD・決定論)。集合外/ネスト内は不変。
  const CONC_BADGES = { OK: 'ok', FAIL: 'fail', CAVEAT: 'caveat', INFO: 'info' };
  const topIndent = items.length ? items[0].indent : 0;
  let html = '';
  let idx = 0;
  function consume(minIndent) {
    if (idx >= items.length) return '';
    const baseIndent = items[idx].indent;
    const ordered = items[idx].ordered;
    let out = ordered ? '<ol>' : '<ul>';
    while (idx < items.length && items[idx].indent === baseIndent) {
      const it = items[idx];
      idx++;
      const bm = summaryBadge && baseIndent === topIndent
        ? it.text.match(/^\*\*(OK|FAIL|CAVEAT|INFO)\*\*(\s|$)/) : null;
      const inner = bm
        ? '<span class="conc-badge conc-' + CONC_BADGES[bm[1]] + '">' + bm[1] + '</span>' +
            renderInline(it.text.slice(bm[0].length - bm[2].length))
        : renderInline(it.text);
      let li;
      if (it.task) {
        // チェック欄: <input> はテキストノード非生成 (HTML⊆MD 維持)。初期状態は MD の [x]。
        //   クリックした状態は localStorage (TASK_LOADER) が持ち、HTML 本体は変えない。
        _taskUsed = true;
        li = '<li class="task"' + figLinkStamp('item', it.text) + '><label class="task-label">' +
          '<input type="checkbox" class="task-box"' + (it.checked ? ' checked' : '') + '/>' +
          '<span class="task-text">' + inner + '</span></label>';
      } else {
        li = '<li' + figLinkStamp('item', it.text) + '>' + inner;
      }
      // 子 (より深い indent) を取り込む
      if (idx < items.length && items[idx].indent > baseIndent) {
        li += consume(items[idx].indent);
      }
      li += '</li>';
      out += li;
    }
    out += ordered ? '</ol>' : '</ul>';
    return out;
  }
  while (idx < items.length) {
    html += consume(items[idx].indent);
  }
  return html;
}

// 純数値セル判定 (版数 v1.5.0 / 日付 2026-06-12 は '-'/'v'/二重ドットで弾く)。
// 数の直後に付く注記の印 (* † ‡ ※ ＊ の 1 つ以上。数との間に空白なし) は許す: "93*" は 93 として数える (表示は "93*" のまま)。
// 1 つでも印付きのセルがあると列全体が数値列でなくなりバーも色も抜ける、という読み手を惑わせる表示をなくすため。
const NUM_MARKS = '*†‡※＊';
const NUM_MARKS_TAIL_RE = new RegExp('[' + NUM_MARKS + ']+$');
const NUM_CELL_RE = new RegExp('^[\\d,]+(\\.\\d+)?%?[' + NUM_MARKS + ']*$');
function parsePureNumber(cell) {
  const s = (cell || '').trim();
  if (!NUM_CELL_RE.test(s)) return null;
  const n = parseFloat(s.replace(NUM_MARKS_TAIL_RE, '').replace(/,/g, '').replace('%', ''));
  return Number.isFinite(n) ? n : null;
}

// 表全体で尺度をそろえるモード (frontmatter da_scale: table を宣言した文書だけ。renderDoc の冒頭で毎回確定する)。
let _daScaleTable = false;

// DA 比例バー: 列単位で「全データセルが純数値 (空は許容)」かつ 2 行以上を数値列とみなす。
// バー幅は列内 max に対する比率 (CSS inline style = テキストノード非生成 / r1 §3-2-5 整合)。
// レンダラは割合ラベル等の新規テキストを生成しない (バーは style のみ)。
// scaleTable (da_scale: table): 1 つの表の中で、数値列の max/min を列ごとでなく表全体 (単位の群ごと) にそろえる。
//   群 = 「% を含む数値列」と「含まない数値列」(単位の違う列を 1 つの尺度に混ぜない)。複数の表は混ぜない。
function analyzeNumericColumns(block, scaleTable) {
  const cols = block.header.length;
  const numeric = [];
  const pct = [];
  for (let k = 0; k < cols; k++) {
    let count = 0;
    let max = 0;
    let min = Infinity;
    let allNum = true;
    let hasPct = false;
    for (const row of block.rows) {
      const cell = (row[k] || '').trim();
      if (cell === '') continue;
      const n = parsePureNumber(cell);
      if (n === null) {
        allNum = false;
        break;
      }
      if (cell.replace(NUM_MARKS_TAIL_RE, '').endsWith('%')) hasPct = true;
      count++;
      if (n > max) max = n;
      if (n < min) min = n;
    }
    numeric[k] = allNum && count >= 2 ? { max, min } : null;
    pct[k] = hasPct;
  }
  if (scaleTable) {
    for (const group of [true, false]) {
      let gMax = 0;
      let gMin = Infinity;
      for (let k = 0; k < cols; k++) {
        if (numeric[k] && pct[k] === group) {
          if (numeric[k].max > gMax) gMax = numeric[k].max;
          if (numeric[k].min < gMin) gMin = numeric[k].min;
        }
      }
      for (let k = 0; k < cols; k++) {
        if (numeric[k] && pct[k] === group) numeric[k] = { max: gMax, min: gMin };
      }
    }
  }
  return numeric;
}

// r3: 値依存カラースケール (意味中立 = 列内の大小位置のみを示す。良し悪しを込めない)
// Codex 相談 案A: シアン(低) → 深シアン → エメラルド → 黄 → ピンク → マゼンタ(高)。
// 中間緑 #10B981 は図の意味色ティール #5EEAD4 と非衝突 (設計制約)。
const BAR_ANCHORS = [
  [0.0, [0x22, 0xd3, 0xee]],
  [0.18, [0x06, 0xb6, 0xd4]],
  [0.43, [0x10, 0xb9, 0x81]],
  [0.58, [0xfa, 0xcc, 0x15]],
  [0.84, [0xf4, 0x72, 0xb6]],
  [1.0, [0xd9, 0x46, 0xef]],
];

// t∈[0,1] → {hex, rgba}。両端強調ワープ (γ=2.0: 中間圧縮・0/1 近傍急峻) +
// アンカー区分線形 RGB 補間。純関数 = 同値→同色 (決定論)。
function barColor(t) {
  const x = 2 * t - 1;
  const w = 0.5 + 0.5 * Math.sign(x) * Math.pow(Math.abs(x), 2);
  let rgb = BAR_ANCHORS[BAR_ANCHORS.length - 1][1];
  for (let i = 1; i < BAR_ANCHORS.length; i++) {
    const p0 = BAR_ANCHORS[i - 1][0];
    const c0 = BAR_ANCHORS[i - 1][1];
    const p1 = BAR_ANCHORS[i][0];
    const c1 = BAR_ANCHORS[i][1];
    if (w <= p1) {
      const u = (w - p0) / (p1 - p0);
      rgb = c0.map((a, k) => Math.round(a + (c1[k] - a) * u));
      break;
    }
  }
  const hex = '#' + rgb.map((v) => v.toString(16).toUpperCase().padStart(2, '0')).join('');
  return { hex, rgba: 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',.3)' };
}

function renderTable(block) {
  const numericCols = analyzeNumericColumns(block, _daScaleTable);
  let html = '<div class="table-wrap"><table>';
  html += '<thead><tr>';
  block.header.forEach((cell, k) => {
    const a = block.aligns[k] ? ' style="text-align:' + block.aligns[k] + '"' : '';
    const nc = numericCols[k] ? ' class="num-col"' : '';
    html += '<th' + nc + a + '>' + renderInline(cell) + '</th>';
  });
  html += '</tr></thead><tbody>';
  block.rows.forEach((row) => {
    html += '<tr' + figLinkStamp('row', row[0] || '') + '>';
    row.forEach((cell, k) => {
      const a = block.aligns[k] ? ' style="text-align:' + block.aligns[k] + '"' : '';
      const col = numericCols[k];
      const n = col ? parsePureNumber(cell) : null;
      if (col && n !== null && col.max > 0) {
        const pct = Math.round((n / col.max) * 1000) / 10; // 0.1% 刻み = 決定論
        let style = 'width:' + pct + '%';
        if (col.max > col.min) {
          // 全値同一列は t 不定 → 上書きせず既定シアン (:root --bar) に退化
          const c = barColor((n - col.min) / (col.max - col.min));
          style += ';--bar:' + c.hex + ';--bar-soft:' + c.rgba;
          // 極値の非色シグナル: 列最大のみエッジ 3px (長さが主・色は補助。Codex Q5)
          if (n === col.max) style += ';border-right-width:3px';
        }
        html +=
          '<td class="num-cell"' + a + '><span class="bar" style="' + style + '"></span>' +
          '<span class="num">' + renderInline(cell) + '</span></td>';
      } else {
        html += '<td' + a + '>' + renderInline(cell) + '</td>';
      }
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  return html;
}

// フェンス info 文字列の解釈 (コードブロックのコピーボタン用)。純関数。バーのラベルとボタン有無だけに使う。
//   先頭の非属性トークン = 言語名 (バーのラベルの既定値)。
//   "nocopy" / "no-copy" トークン = コピーボタンを付けない (図・出力例・ログなど貼る物でないブロック)。
//   title="..." = バーに出す人向けラベル (例: title="再起動する")。無ければ言語名がラベルになる。
// <pre> の data-lang 属性と mermaid / svg の判定は、従来どおり info 全体 (小文字化) を使い変えない
// (既存の図判定・属性の値を利用する外部の CSS や後処理を壊さない)。
function parseFenceInfo(info) {
  const raw = String(info || '');
  const tm = /(?:^|\s)title="([^"]*)"/.exec(raw);
  const title = tm ? tm[1].trim() : '';
  const rest = tm ? raw.slice(0, tm.index) + ' ' + raw.slice(tm.index + tm[0].length) : raw;
  const tokens = rest.split(/\s+/).filter(Boolean);
  const isNoCopy = (t) => /^no-?copy$/i.test(t);
  return {
    lang: tokens.filter((t) => !isNoCopy(t))[0] || '',
    title,
    noCopy: tokens.some(isNoCopy),
  };
}

function renderFence(block) {
  if (block.cite && block.cite.kind === 'include' && block.citeResult && !block.citeResult.ok && !_citeLenient) {
    const e = new Error('include の展開に失敗: [' + block.citeResult.tag + '] ' + block.citeResult.detail + ' (include=' + JSON.stringify(block.cite.spec) + ')');
    e.citeFailure = true;
    throw e;
  }
  // cite= / include= / rev= は info から外して扱う (data-lang や図判定に混ぜない)。属性の無いフェンスは入力そのまま。
  const info = (block.cite ? stripCiteAttrs(block.info) : block.info || '').toLowerCase();
  const raw = block.content.join('\n');
  if (info === 'mermaid') {
    figLinkNoteFence(raw);
    // 三段フォールバック: クライアント描画 (未注入なら原文表示) — 原文は常にエスケープ済みで残る
    return '<pre class="mermaid">' + escapeHtml(raw) + '</pre>';
  }
  if (info === 'svg') {
    // (c) data URI 埋め込み: <img> 内 SVG はブラウザ sandbox で script 非実行 = 安全。
    // base64 は決定的 = 決定論維持。原文は data URI 属性に入りテキストノードにならない
    // (完全性検証では図ブロックとして除外)。生 <script> はそのまま実行 HTML にならない。
    const b64 = Buffer.from(raw, 'utf8').toString('base64');
    _svgFigUsed = true;
    return '<img class="svg-fig" alt="" src="data:image/svg+xml;base64,' + b64 + '"/>';
  }
  const langAttr = info ? ' data-lang="' + escapeAttr(info) + '"' : '';
  const pre = '<pre class="code"' + langAttr + '><code>' + escapeHtml(raw) + '</code></pre>';
  const f = parseFenceInfo(block.cite ? stripCiteAttrs(block.info) : block.info);
  if (f.noCopy) return pre;
  // コピーボタン付きの外枠 (.cb)。ボタンは <pre> の外に置く = コピー内容にボタンの文字が混ざらない。
  // ラベル・ボタン文字はテキストノードを作らない: ラベルは data-label → CSS attr()、
  // ボタン文字は CSS ::before、a11y 正本は aria-label (HTML⊆MD / MD⊆HTML は不変)。
  _codeCopyUsed = true;
  const label = f.title || (block.cite && block.cite.spec ? block.cite.spec : f.lang);
  const labelAttr = label ? ' data-label="' + escapeAttr(label) + '"' : '';
  const aria = label ? '「' + label + '」をコピー' : 'コードをコピー';
  return (
    '<div class="cb"><div class="cb-bar"' + labelAttr + '>' +
    '<button type="button" class="cb-copy" aria-label="' + escapeAttr(aria) + '"></button>' +
    '</div>' + pre + '</div>'
  );
}

function renderAdmonition(block, opts) {
  const cls = ADM_CLASS[block.adType] || 'adm-note';
  const id = opts && opts.id ? ' id="' + escapeAttr(opts.id) + '"' : '';
  // data-adm はラベル描画用 (CSS ::before content)。テキストノードではない。
  let html = '<div class="adm ' + cls + '"' + id + ' data-adm="' + escapeAttr(block.adType) + '">';
  if (block.title) html += '<p class="adm-title">' + renderInline(block.title) + '</p>';
  if (block.content && block.content.join('').trim()) {
    html += '<div class="adm-body">' + renderBlocks(tokenize(block.content.join('\n'))) + '</div>';
  }
  html += '</div>';
  return html;
}

function renderBlocks(blocks, decisionIds, summaryBadge) {
  let html = '';
  let decSeq = decisionIds ? decisionIds.seq : { n: 0 };
  for (const b of blocks) {
    switch (b.type) {
      case 'heading': {
        const tag = 'h' + b.level;
        figLinkNoteHeading(b);
        html += '<' + tag + ' id="' + escapeAttr(b.id) + '">' + renderInline(b.text) + '</' + tag + '>';
        break;
      }
      case 'paragraph':
        html += '<p>' + renderInline(b.lines.join(' ')) + '</p>';
        break;
      case 'list':
        html += renderList(b.items, summaryBadge);
        break;
      case 'table':
        html += renderTable(b);
        break;
      case 'fence':
        html += renderFence(b);
        break;
      case 'blockquote':
        html += '<blockquote>' + renderBlocks(tokenize(b.content.join('\n'))) + '</blockquote>';
        break;
      case 'admonition': {
        let id = null;
        if (b.adType === 'DECISION' && decisionIds) {
          decSeq.n++;
          id = 'dec-' + decSeq.n;
          b._decId = id;
        }
        html += renderAdmonition(b, { id });
        break;
      }
      case 'hr':
        html += '<hr/>';
        break;
      default:
        break;
    }
  }
  return html;
}

// ---------------------------------------------------------------------------
// セクション分割 (H2 境界) と特殊セクション識別
// ---------------------------------------------------------------------------

function buildSections(blocks) {
  const sections = [];
  let current = null;
  let preamble = [];
  for (const b of blocks) {
    if (b.type === 'heading' && b.level <= 2) {
      if (b.level === 1) {
        // H1 はタイトル扱い。preamble に残す
        preamble.push(b);
        continue;
      }
      current = { heading: b, blocks: [] };
      sections.push(current);
    } else if (current) {
      current.blocks.push(b);
    } else {
      preamble.push(b);
    }
  }
  return { preamble, sections };
}

// 結論の概要 見出し判定 (classifySection と lint で共有し semantics 乖離を防ぐ・ja/en)。
const SUMMARY_HEADING_RE = /結論の概要|結論サマリ|conclusion\s*summary/i;
// 必須見出しの判定語 (classifySection・tabs 検査・lint で共有)。lint は tokenize が作った見出しブロックだけを
// hasHeadingBlock で判定する。本文の生文字列への正規表現で探してはならない (コードブロックの中の見本の見出しでも合格してしまう)。
const AUDIENCE_HEADING_RE = /^本報告書の読者と目的/;
const CURRENT_POS_HEADING_RE = /^現在地/;
const PENDING_HEADING_RE = /スコープ外提案|Pending|ペンディング/i;

// ブロック列の中に、レベルが minLevel〜maxLevel で、見出しの文字が re に合うものがあるか。
// フェンス・引用・段落の中の「# で始まる行」は tokenize が見出しにしないので、ここには現れない。
function hasHeadingBlock(blocks, re, minLevel, maxLevel) {
  return blocks.some((b) => b.type === 'heading' && b.level >= minLevel && b.level <= maxLevel && re.test(b.text));
}

function classifySection(sec) {
  const t = sec.heading.text;
  if (/読者と目的/.test(t)) return 'audience';
  if (SUMMARY_HEADING_RE.test(t)) return 'summary';
  if (PENDING_HEADING_RE.test(t)) return 'pending';
  return 'body';
}

// 要判断一覧パネルの固定 sectionId (見出しを持たない自動生成パネルのため canon/sha1 でなく
// 決め打ち定数を使う)。実見出し id は必ず 'sec-' + 8桁16進 (sha1 由来) なので、この非16進
// サフィックスの定数と構造的に衝突し得ない。render 毎に不変 (決定論も規約どおり維持)。
const DECISIONS_PANEL_SECTION_ID = 'sec-decisions-panel';

// 次行スタイル ([!DECISION] のみで同一行にタイトル無し) は b.title が空文字になり、
// 要判断一覧パネルのリンクがテキストノード無しの空 <a> になる (Skill構造欠陥#2)。
// フォールバック: title 空時のみ content 先頭の非空行を暫定タイトルとして使う。
// renderAdmonition (本文側 .adm-title 描画) は意図的に触れない: 触るとフォールバック文言が
// 本文側で adm-body の同じ1行目のすぐ上に重複表示される回帰を招く。
function fallbackDecisionTitle(content) {
  if (!content) return '';
  for (const raw of content) {
    const t = String(raw).trim();
    if (t) return t;
  }
  return '';
}

// H2 セクションの blocks を H3 境界で再分割する (comments: atomic 専用)。
//   buildSections は H2 境界でしか割らないため、H3 単位の Composer 注入位置を得るには
//   各 H2 の本文ブロック列を更に H3 (level 3) 見出しで区切る必要がある。
//   返り値: { lead, subsections } 。
//     lead       = 最初の H3 より前のブロック列 (H2 直下〜最初の H3 の直前。H3 が無ければ全ブロック)。
//     subsections = [{ heading: <H3 block>, blocks: [...] }, ...]。
//       各 subsection.blocks は その H3 見出しの後・次の H3 (level 3) の直前まで。
//       level 4 (H4) 以下は直前の H3 サブセクションに内包する (H4 単位の Composer は出さない
//       = Atomic 粒度は H3 = トピック単位)。H3 が現れる前の H4 は lead に残る。
//   純関数: 入力ブロック列のみから決定論的に導出する。atomic 分岐内でのみ呼ぶため
//   非 atomic 文書の出力は一切変化しない。
function splitByH3(blocks) {
  const lead = [];
  const subsections = [];
  let current = null;
  for (const b of blocks) {
    if (b.type === 'heading' && b.level === 3) {
      current = { heading: b, blocks: [] };
      subsections.push(current);
    } else if (current) {
      current.blocks.push(b);
    } else {
      lead.push(b);
    }
  }
  return { lead, subsections };
}

// 報告書型判定 (render / lint 共用)。frontmatter の報告書キー or 「読者と目的」セクションで検出。
function isReportDoc(fm, blocks) {
  return !!(
    (fm && (fm.doc_id || fm.report_id || fm.audience || fm.status)) ||
    hasHeadingBlock(blocks, AUDIENCE_HEADING_RE, 2, 4)
  );
}

// 編集可能 Composer の内側マークアップ (toggle + 編集欄 + 保存カード)。テキストノード非生成。
//   data-section を変えるだけで「基底 id 用」「再コメント (<sid>:re) 用」の両方を生成できる。
//   COMMENT_LOADER / COMMENT_LOADER_RESOLVED が data-section をキーに localStorage を読む。
function editableComposer(sectionId, label) {
  const sid = escapeAttr(sectionId);
  // Skill構造欠陥修正#3: 見出しを持たない合成セクション (要判断一覧等) 用に、呼び出し側が
  // 判明済みの人間可読ラベルを明示的に渡せるようにする (data-label)。省略時は従来 byte 不変。
  const labelAttr = label ? ' data-label="' + escapeAttr(label) + '"' : '';
  return (
    '<div class="cmt" data-section="' + sid + '"' + labelAttr + ' data-state="empty">' +
    '<button class="cmt-toggle" type="button" aria-label="コメントを書く"></button>' +
    '<div class="cmt-edit">' +
    '<textarea class="cmt-input" aria-label="コメント入力" placeholder=""></textarea>' +
    '<div class="cmt-actions">' +
    '<button class="cmt-save" type="button" aria-label="保存"></button>' +
    '<button class="cmt-cancel" type="button" aria-label="キャンセル"></button>' +
    '</div></div>' +
    '<div class="cmt-card"><div class="cmt-display"></div>' +
    '<button class="cmt-editbtn" type="button" aria-label="編集"></button></div>'
  );
}

// コメント Composer (本文 H2 直下)。テキストノードを生成しない: ラベルは CSS ::before / aria 属性、
// textarea と表示領域は空 (本文は実行時に localStorage から JS で textContent 投入)。
// → verify (HTML⊆MD / MD⊆HTML) はテキストノード増分ゼロで不変。
//
// resolvedMap[sectionId] の形:
//   2 部 (元コメント無し): { rk:<index>, hasOrig:false }
//   3 部 (元コメント有り): { rk:<index>, hasOrig:true }
//   不在 / 非該当 sectionId: 既存 Composer 出力 byte 不変 (resolvedMap 自体が null の非 resolved 文書を含む)。
//
// 出力 3 分岐:
//   (i)  非 resolved (resolvedMap 不在 or 非該当): 従来どおり編集 Composer のみ = byte 不変。
//   (ii) resolved・元コメント無し (hasOrig:false): 編集 Composer + 旧 resolvedBlock (バッジ+メモ)
//        = 既存 comments_resolved 文書 (2 部) と byte 不変。再コメントは基底 Composer がそのまま担う。
//   (iii)resolved・元コメント有り (hasOrig:true): レビュアーの確定コメントを読取専用で埋込み
//        (cmt-orig 空コンテナ + データ島 textContent) + バッジ + メモ。基底 id の編集 Composer は
//        出さず (data-readonly="1" の inert な .cmt) 改変不可にする。新規継続コメントは別 key
//        "<sid>:re" の編集 Composer で受ける (集約コピー対象。基底 id は除外集合に入る)。
function commentComposer(sectionId, resolvedMap, label) {
  const sid = escapeAttr(sectionId);
  const entry =
    resolvedMap && Object.prototype.hasOwnProperty.call(resolvedMap, sectionId)
      ? resolvedMap[sectionId]
      : null;

  // (iii) 元コメント有り = 読取専用埋込 + 再コメント欄。
  if (entry && entry.hasOrig) {
    const rk = escapeAttr(String(entry.rk));
    // 基底 .cmt は data-readonly="1" の inert コンテナ:
    //   - cmt-orig: レビュアーの元コメント (読取専用引用)。ローダがデータ島から textContent 投入。
    //   - cmt-resolved: ✓対応済みバッジ + CC 対応メモ (従来同型)。
    //   編集 UI (toggle/textarea/save) を一切含めない = 改変不可。COMMENT_LOADER_RESOLVED は
    //   data-readonly="1" の .cmt をスキップする (querySelector(null) クラッシュ回避)。
    const readonlyBase =
      '<div class="cmt cmt-ro" data-section="' + sid + '" data-readonly="1">' +
      '<div class="cmt-orig" data-rk="' + rk + '"></div>' +
      '<div class="cmt-resolved">' +
      '<span class="cmt-resolved-badge" aria-label="対応済み"></span>' +
      '<div class="cmt-memo" data-rk="' + rk + '"></div>' +
      '</div>' +
      '</div>';
    // 再コメント欄: 別 localStorage key "<sid>:re"。data-recmt="1" で UI を区別 (CSS ラベル)。
    //   data-section が基底 id と異なる (":re" 接尾) ため resolved 除外集合に含まれず集約コピーに入る。
    // 2 巡目以降 (2026-09-13): comments_resolved の key に ":re" を後置した宣言 ("見出し:re") があれば、
    //   再コメント層も同じ 3 分岐で処理する (再帰)。3 部なら読取専用埋込 + バッジ + メモ + さらに次層
    //   "<sid>:re:re" の再コメント欄、2 部ならこの再コメント欄の末尾にバッジ + メモを添える。
    //   ":re" 宣言が無い文書は nextEntry=null で従来経路 = byte 不変。
    const nextId = sectionId + ':re';
    const nextEntry =
      resolvedMap && Object.prototype.hasOwnProperty.call(resolvedMap, nextId)
        ? resolvedMap[nextId]
        : null;
    if (nextEntry && nextEntry.hasOrig) {
      return readonlyBase + commentComposer(nextId, resolvedMap, label);
    }
    let reResolvedBlock = '';
    if (nextEntry) {
      const nrk = escapeAttr(String(nextEntry.rk));
      reResolvedBlock =
        '<div class="cmt-resolved">' +
        '<span class="cmt-resolved-badge" aria-label="対応済み"></span>' +
        '<div class="cmt-memo" data-rk="' + nrk + '"></div>' +
        '</div>';
    }
    const reComposer =
      '<div class="cmt cmt-re" data-section="' + sid + ':re" data-recmt="1" data-state="empty">' +
      '<button class="cmt-toggle" type="button" aria-label="再コメントを書く"></button>' +
      '<div class="cmt-edit">' +
      '<textarea class="cmt-input" aria-label="再コメント入力" placeholder=""></textarea>' +
      '<div class="cmt-actions">' +
      '<button class="cmt-save" type="button" aria-label="保存"></button>' +
      '<button class="cmt-cancel" type="button" aria-label="キャンセル"></button>' +
      '</div></div>' +
      '<div class="cmt-card"><div class="cmt-display"></div>' +
      '<button class="cmt-editbtn" type="button" aria-label="編集"></button></div>' +
      reResolvedBlock +
      '</div>';
    return readonlyBase + reComposer;
  }

  // (ii) 元コメント無し (2 部・後方互換): 編集 Composer + 旧 resolvedBlock。既存出力 byte 不変。
  let resolvedBlock = '';
  if (entry) {
    const rk = String(entry.rk);
    resolvedBlock =
      '<div class="cmt-resolved">' +
      '<span class="cmt-resolved-badge" aria-label="対応済み"></span>' +
      '<div class="cmt-memo" data-rk="' + escapeAttr(rk) + '"></div>' +
      '</div>';
  }
  // (i)/(ii): 基底編集 Composer (+ 2 部時のみ resolvedBlock)。resolvedBlock='' なら従来 byte 不変。
  return editableComposer(sectionId, label) + resolvedBlock + '</div>';
}

// H2 本文セクションの「本文ブロック群」HTML を生成する (見出し <h2> は呼び出し側が別途出力)。
//   atomicComments=false: 従来どおり renderBlocks(s.blocks) を返すだけ (H3 への注入なし = byte 不変)。
//   atomicComments=true : s.blocks を H3 境界で再分割し、各 H3 サブセクションの本文末に
//                         commentComposer(H3.id) を注入する。lead (最初の H3 より前) は素描画。
//                         → 「H3 本文の読み終わりに Composer が来る」配置。H2 末 Composer は
//                         呼び出し側が別途付加する (二層)。
//   Composer はテキストノード非生成 (既存 commentComposer と同型) ゆえ HTML⊆MD 不変。
//   各 H3 は本文中 H3 見出しとして renderBlocks で描画され、その後に Composer が続く配置。
function renderBodyInner(s, decisionIds, atomicComments, resolvedMap) {
  if (!atomicComments) {
    return renderBlocks(s.blocks, decisionIds);
  }
  const { lead, subsections } = splitByH3(s.blocks);
  let html = renderBlocks(lead, decisionIds);
  for (const sub of subsections) {
    html += renderBlocks([sub.heading], decisionIds);
    html += renderBlocks(sub.blocks, decisionIds);
    html += commentComposer(sub.heading.id, resolvedMap);
  }
  return html;
}

// ---------------------------------------------------------------------------
// メイン描画: 固定 7 ブロック
// ---------------------------------------------------------------------------

// 公開の render。押せる図 (figure_links) の宣言があるときだけ二段階 (発見パス → 最終パス) で描画する。
// 宣言なし・有効な宣言が 0 件のときは、宣言なしと同じ経路 (_figPlan === null) で 1 回描画する = 従来と byte 一致。
function render(md, srcFileName) {
  const { fm } = parseFrontmatter(md);
  setTasksFromFm(fm); // 押せる図の探索も同じ規則で tokenize する
  const decls = figLinkDecls(fm);
  if (!decls) return renderDoc(md, srcFileName, null);
  const valid = figLinkDiscover(md, srcFileName, decls).results
    .filter((r) => r.valid)
    .map((r) => ({ node: r.item.node, kind: r.item.kind, text: r.item.text }));
  if (valid.length === 0) return renderDoc(md, srcFileName, null);
  return renderDoc(md, srcFileName, figLinkMakePlan(valid));
}

function renderDoc(md, srcFileName, figPlan) {
  const { fm } = parseFrontmatter(md);
  const { body } = parseFrontmatter(md);

  // 押せる図の計画 (render 毎にリセット = 決定論。null なら従来経路)。
  _figPlan = figPlan;

  // --- テーマ / ホバー opt-in モード判定 (frontmatter 宣言時のみ有効) ---
  // 全注入を themeMode / hoverMode 分岐内に閉じ込めるため、非宣言文書は byte 不変。
  const themeMode = !!(fm && fm.theme === 'toggle');
  const hoverMode = !!(fm && Array.isArray(fm.hover) && fm.hover.length);

  // renderFence が立てるコピーボタン使用フラグ (render 毎にリセット = 決定論)。
  _codeCopyUsed = false;
  // renderFence が立てる図のビューア使用フラグ (render 毎にリセット = 決定論)。
  _svgFigUsed = false;
  _taskUsed = false;
  setTasksFromFm(fm);

  // DA バーの尺度 (render 毎に frontmatter から確定 = 決定論)。da_scale: table を宣言した文書だけ表全体でそろえる。
  _daScaleTable = !!(fm && fm.da_scale === 'table');

  // renderInline が参照するホバー状態を確定 (render 毎にリセット = 決定論)。
  _hoverMode = hoverMode;
  _hoverIndex = null;
  if (hoverMode) {
    _hoverIndex = new Map();
    fm.hover.forEach((h, idx) => {
      // 同一識別子が複数宣言された場合は最初を優先 (決定論)。
      if (!_hoverIndex.has(h.key)) _hoverIndex.set(h.key, String(idx));
    });
  }

  const blocks = tokenize(body);

  // 見出し再採番 (グローバル一意 id) は tokenize 内で付与済み
  const decisionIds = { seq: { n: 0 } };

  // DECISION 収集 (集約パネル用) — 描画前に id を確定させるため本文を先に描画
  const { preamble, sections } = buildSections(blocks);

  // H1 タイトル
  const h1 = preamble.find((b) => b.type === 'heading' && b.level === 1);
  const title = h1 ? h1.text : fm && fm.doc_id ? String(fm.doc_id) : (srcFileName || 'report');

  // 本文セクション描画 (DECISION id をここで採番)
  const audienceSec = sections.find((s) => classifySection(s) === 'audience');
  const summarySec = sections.find((s) => classifySection(s) === 'summary');
  const pendingSec = sections.find((s) => classifySection(s) === 'pending');
  const bodySecs = sections.filter((s) => classifySection(s) === 'body');

  // --- ブロック 5: 本文 ---
  // preamble (H1 タイトルより後・最初の H2 より前) の非 H1 ブロックは欠落させず lead として描画
  let bodyHtml = '';
  const leadBlocks = preamble.filter((b) => b !== h1);
  if (leadBlocks.length) {
    bodyHtml += '<div class="lead">' + renderBlocks(leadBlocks, decisionIds) + '</div>';
  }
  // frontmatter tabs: by-h2 宣言時のみ本文 H2 セクション群をタブ UI に包む (インライン新構文ゼロ)。
  // タブラベルは H2 見出しテキスト (MD 由来の実テキストノード = corpus 内 → HTML⊆MD 維持)。
  // 番号は CSS counter (非テキストノード)。非表示パネルも静的 HTML に全文残り --verify が被覆する。
  // コメント機能: 報告書 (isReport) かつ reportId (report_id/doc_id) があり comments:off でない時のみ。
  // reportId は MD 由来のみ (srcFileName fallback 禁止 = 同一 MD 異名でも byte 不変 = 決定論)。
  const reportId = fm && (fm.report_id || fm.doc_id) ? String(fm.report_id || fm.doc_id) : '';
  const commentsMode = !!(reportId && isReportDoc(fm, blocks) && fm.comments !== 'off');
  // --- Atomic コメント opt-in (comments: atomic): commentsMode が前提 ---
  // commentsMode かつ frontmatter comments の値が 'atomic' の時のみ有効。
  // この時、各 H2 セクション内の H3 (小見出し=トピック) サブセクション直下にも
  // Composer を注入する (H2 末 Composer は維持 = 二層)。
  // 既定 (report_id 有・comments 値なし) / comments: on / off / 非報告書 は
  // atomicComments=false ゆえ従来どおり H2 のみ = 既存 byte 不変。
  const atomicComments = !!(commentsMode && fm && fm.comments === 'atomic');

  // --- コメント解決 opt-in (comments_resolved): commentsMode が前提 ---
  // commentsMode かつ frontmatter に有効な comments_resolved エントリがある時のみ有効。
  // 全注入 (CSS/データ島/ローダ/Composer 内ブロック) を resolvedMode 分岐内に閉じ込め、
  // 非宣言文書 (および comments_resolved 不在のコメント文書) は byte 不変。
  const resolvedMode = !!(commentsMode && fm && Array.isArray(fm.comments_resolved) && fm.comments_resolved.length);
  // resolvedMap: 見出しテキスト key を canon→sha1→'sec-'... で sectionId 化し
  //   {sectionId: {rk:index, hasOrig:bool}} に。index は resolvedMemos (データ島) 上の位置。
  //   resolvedMemos[index] = {memo, orig} (orig は 3 部 entry の元コメント。2 部は '')。
  //   Composer が付くのは本文 H2 (bodySecs)/atomic 時は H3 も。それに一致する key だけ島へ入れる
  //   (Codex 採用: 未参照メモをソースから排除 = 情報最小化。見出し不一致 key は描画せず lint 警告のみ)。
  //   hasOrig は orig が空文字でない時 true → commentComposer が読取専用埋込 + 再コメント欄に分岐。
  //   同一 sectionId への複数宣言は最初を優先 (決定論)。
  let resolvedMap = null;
  let resolvedMemos = null;
  // 読取専用埋込 (元コメント有り) を持つ resolved 見出し id 集合。
  //   返信集約 (REPLY_GEN_RESOLVED) がこの集合の基底 id コメントをスキップするため DOM へ出力する。
  //   元コメント無し (2 部) の resolved は基底 Composer が再コメントを兼ねるため除外しない (従来挙動)。
  let resolvedOrigSids = null;
  if (resolvedMode) {
    resolvedMap = {};
    resolvedMemos = [];
    resolvedOrigSids = [];
    // Composer が付く見出し id の集合。
    //   非 atomic: 本文 H2 (bodySecs) + Composer 付きパネル 3 種 (読者と目的 / 結論の概要 / Pending) の H2。
    //              パネル 3 種は本文 H2 と同じく commentComposer(sec.heading.id) が付く (ブロック 2.5/3/6) ため、
    //              その見出し key の comments_resolved メモも島へ通す (2026-09-06 修正: 従来は bodySecs のみで、
    //              「結論の概要」への返信が lint 無警告のまま黙って落ちていた。lint 2448 行は全見出し照合で整合)。
    //   atomic   : 上記に加え、各 H2 内の H3 サブセクション見出し id も Composer が付くため
    //              renderableIds に含める (H3 見出しに一致する comments_resolved メモを島へ通す)。
    const renderableIds = new Set(bodySecs.map((s) => s.heading.id));
    for (const ps of [audienceSec, summarySec, pendingSec]) {
      if (ps) renderableIds.add(ps.heading.id);
    }
    if (atomicComments) {
      for (const s of bodySecs) {
        for (const b of s.blocks) {
          if (b.type === 'heading' && b.level === 3) renderableIds.add(b.id);
        }
      }
    }
    fm.comments_resolved.forEach((e) => {
      // 2 巡目以降 (2026-09-13): key 末尾の ":re" (反復可) は再コメント層の指定。見出し照合は基底 key で行い、
      //   sectionId は基底 id に接尾をそのまま付ける ("sec-xxxxxxxx:re") = 再コメント Composer の
      //   data-section と一致させる (除外集合にも同じ文字列で入る)。":re" 無しの宣言は従来どおり (byte 不変)。
      const km = /^([\s\S]*?)((?::re)*)$/.exec(String(e.key));
      const baseKey = km ? km[1] : String(e.key);
      const reSuffix = km ? km[2] : '';
      const baseSid = 'sec-' + sha1(canon(baseKey)).slice(0, 8);
      // 描画されない key (本文 H2 見出しに不一致) はデータ島にも入れない。
      if (!renderableIds.has(baseSid)) return;
      const sid = baseSid + reSuffix;
      // 同一 sectionId は最初の宣言のみ採用 (重複後続はスキップ = 島に入れない)。
      if (Object.prototype.hasOwnProperty.call(resolvedMap, sid)) return;
      const orig = (e && typeof e.original === 'string') ? e.original : '';
      const hasOrig = orig.length > 0;
      resolvedMap[sid] = { rk: resolvedMemos.length, hasOrig };
      resolvedMemos.push({ memo: e.memo, orig });
      if (hasOrig) resolvedOrigSids.push(sid);
    });
  }

  const tabsMode = !!(fm && fm.tabs === 'by-h2' && bodySecs.length > 0);
  if (tabsMode) {
    let tabBar = '<div class="tabs" role="tablist">';
    let panelsHtml = '';
    bodySecs.forEach((s, idx) => {
      const on = idx === 0 ? ' active' : '';
      const seld = idx === 0 ? 'true' : 'false';
      tabBar +=
        '<button class="tab' + on + '" type="button" role="tab" aria-selected="' + seld +
        '" data-tab="' + idx + '">' + renderInline(s.heading.text) + '</button>';
      panelsHtml +=
        '<section class="tab-panel' + on + '" role="tabpanel" data-tab-panel="' + idx + '">' +
        renderBlocks([s.heading], decisionIds) +
        renderBodyInner(s, decisionIds, atomicComments, resolvedMap) +
        (commentsMode ? commentComposer(s.heading.id, resolvedMap) : '') +
        '</section>';
    });
    tabBar += '</div>';
    bodyHtml += '<div class="report-tabs">' + tabBar + panelsHtml + '</div>';
  } else {
    for (const s of bodySecs) {
      if (commentsMode) {
        bodyHtml +=
          '<section class="topic">' +
          renderBlocks([s.heading], decisionIds) +
          renderBodyInner(s, decisionIds, atomicComments, resolvedMap) +
          commentComposer(s.heading.id, resolvedMap) +
          '</section>';
      } else {
        bodyHtml += renderBlocks([s.heading], decisionIds);
        bodyHtml += renderBlocks(s.blocks, decisionIds);
      }
    }
  }

  // --- ブロック 3: 要判断一覧 (DECISION 集約) ---
  // bodyHtml 描画で各 DECISION に _decId が付与済み
  const decisions = [];
  function collectDecisions(bs) {
    for (const b of bs) {
      if (b.type === 'admonition' && b.adType === 'DECISION' && b._decId) {
        decisions.push({ id: b._decId, title: b.title || fallbackDecisionTitle(b.content) });
      }
      if (b.type === 'blockquote' || b.type === 'admonition') {
        // ネストは本サブセットでは DECISION を含めない想定。スキップ
      }
    }
  }
  for (const s of bodySecs) collectDecisions(s.blocks);
  if (summarySec) collectDecisions(summarySec.blocks);

  let decisionPanel = '';
  if (decisions.length) {
    decisionPanel =
      '<section class="panel panel-decisions" data-count="' +
      decisions.length +
      '"><ul class="decision-list">';
    for (const d of decisions) {
      decisionPanel +=
        '<li><a href="#' + escapeAttr(d.id) + '">' + renderInline(d.title) + '</a></li>';
    }
    decisionPanel += '</ul>';
    // Skill構造欠陥修正#1: 要判断一覧もリンク文言というテキストノードを持つため他パネル同様
    // コメント欄を付与 (見出しを持たないため専用の固定 sectionId を使う)。
    if (commentsMode) decisionPanel += commentComposer(DECISIONS_PANEL_SECTION_ID, resolvedMap, '要判断一覧');
    decisionPanel += '</section>';
  }

  // --- ブロック 2: 読者と目的パネル ---
  // Skill構造欠陥修正#1: 文章が存在するのにコメント欄が無かった。本文 H2 と同じ Composer を
  // 付与する (sectionId は見出し自身の id を再利用 = 本文と同じ命名規則なので既存の重複見出し
  // lint がそのまま衝突検知の安全網になる)。
  let audiencePanel = '';
  if (audienceSec) {
    audiencePanel =
      '<section class="panel panel-audience">' +
      renderBlocks([audienceSec.heading]) +
      renderBlocks(audienceSec.blocks) +
      (commentsMode ? commentComposer(audienceSec.heading.id, resolvedMap) : '') +
      '</section>';
  }

  // --- ブロック 2.5: 結論の概要パネル (状態バッジ付き・読者と目的と要判断一覧の間) ---
  // Skill構造欠陥修正#1: audiencePanel と同じ理由でコメント欄を付与。
  let summaryPanel = '';
  if (summarySec) {
    summaryPanel =
      '<section class="panel panel-summary">' +
      renderBlocks([summarySec.heading]) +
      renderBlocks(summarySec.blocks, null, true) +
      (commentsMode ? commentComposer(summarySec.heading.id, resolvedMap) : '') +
      '</section>';
  }

  // --- ブロック 6: Pending 台帳 ---
  // Skill構造欠陥修正#1: audiencePanel と同じ理由でコメント欄を付与。
  let pendingPanel = '';
  if (pendingSec) {
    const firstTable = pendingSec.blocks.find((b) => b.type === 'table');
    const count = firstTable ? firstTable.rows.length : pendingSec.blocks
      .filter((b) => b.type === 'list')
      .reduce((acc, b) => acc + b.items.length, 0);
    pendingPanel =
      '<section class="panel panel-pending" data-count="' +
      count +
      '">' +
      renderBlocks([pendingSec.heading]) +
      renderBlocks(pendingSec.blocks) +
      (commentsMode ? commentComposer(pendingSec.heading.id, resolvedMap) : '') +
      '</section>';
  }

  // --- ブロック 4: TOC (H2-H4) ---
  const tocItems = blocks.filter((b) => b.type === 'heading' && b.level >= 2 && b.level <= 4);
  let toc = '';
  if (tocItems.length) {
    toc = '<nav class="toc"><ul>';
    for (const h of tocItems) {
      toc +=
        '<li class="toc-l' + h.level + '"><a href="#' + escapeAttr(h.id) + '">' +
        renderInline(h.text) + '</a></li>';
    }
    toc += '</ul></nav>';
  }

  // --- ブロック 1: ヘッダ ---
  let header = '<header class="report-header">';
  header += '<h1 class="report-title">' + renderInline(title) + '</h1>';
  if (fm) {
    header += '<dl class="meta">';
    const metaKeys = ['doc_id', 'revision', 'status', 'where', 'audience', 'issued_by', 'parent_task'];
    for (const key of metaKeys) {
      if (!(key in fm)) continue;
      const val = fm[key];
      header += '<div class="meta-row meta-' + key + '">';
      header += '<dt>' + escapeHtml(key) + '</dt><dd>';
      if (key === 'where' && typeof val === 'string') {
        const segs = val.split('>').map((x) => x.trim()).filter(Boolean);
        header += '<span class="breadcrumb">';
        segs.forEach((seg, k) => {
          header += '<span class="crumb">' + renderInline(seg) + '</span>';
        });
        header += '</span>';
      } else if (key === 'status' && typeof val === 'string') {
        header += '<span class="badge badge-status" data-status="' + escapeAttr(val) + '">' +
          renderInline(val) + '</span>';
      } else if (Array.isArray(val)) {
        header += '<span class="chips">';
        val.forEach((v) => {
          header += '<span class="chip">' + renderInline(v) + '</span>';
        });
        header += '</span>';
      } else {
        header += renderInline(String(val));
      }
      header += '</dd></div>';
    }
    header += '</dl>';
  }
  header += '</header>';

  // --- 成果物の欄 (opt-in: outputs: の有効な宣言がある文書だけ。header と読者と目的の間 = 最初の画面) ---
  // 先に作るのは、パスのコピー用ブロックが _codeCopyUsed を立てる (下で CSS/ローダの要否に読む) ため。
  const outDecls = outputsDecls(fm);
  const outputsPanel = outDecls ? renderOutputsPanel(outDecls) : '';

  // --- ブロック 7: フッタ (ファイル名 + sha256 は data 属性。テキストノード非生成) ---
  // 埋込ハッシュの入力 = MD + (rev なしの include を使う文書だけ) 展開した実物の行。実物が変われば --check が STALE を出す。
  // include を使わない文書は citeExpansionTail が '' なので従来と byte 一致。
  const mdSha = sha256(md + citeExpansionTail(md));
  const footer =
    '<footer class="report-footer" data-srcfile="' +
    escapeAttr(srcFileName || '') +
    '" data-sha256="' +
    escapeAttr(mdSha.slice(0, 12)) +
    '"></footer>';

  // mermaid フェンス存在判定 (存在時のみローダ注入)
  const hasMermaid = blocks.some((b) => b.type === 'fence' && (b.info || '').toLowerCase() === 'mermaid');
  const mermaidLoader = hasMermaid ? MERMAID_LOADER : '';
  // タブ: head の apply-before-paint で html.js 付与 (無フラッシュ) + body 末でクリック配線。tabs 時のみ注入。
  const tabHead = tabsMode ? TAB_HEAD : '';
  const tabLoader = tabsMode ? TAB_LOADER : '';
  // コメント: 返信プロンプト生成セクション (タブ外・常時可視) + localStorage/集約 JS。commentsMode 時のみ。
  const replyGen = commentsMode ? REPLY_GEN_HTML : '';
  // 返信プロンプト集約 + localStorage 配線。gating の二段構え:
  //   (1) 非 resolvedMode: 従来式 COMMENT_LOADER + (atomic ? REPLY_GEN_ATOMIC : REPLY_GEN) を
  //       1 byte も変えずに使用 (comments-on / atomic / tabs-comments golden を byte 不変に死守)。
  //   (2) resolvedMode のみ: 読取専用基底 .cmt を配線除外する COMMENT_LOADER_RESOLVED と、
  //       対応済み基底 id を集約からスキップする REPLY_GEN(_ATOMIC)_RESOLVED に差し替える。
  //   atomic 時は H3 単位の逆引き集約 (closest('.topic') が最外 H2 を掴む穴を塞ぐ) を維持。
  let commentLoader = '';
  if (commentsMode) {
    if (resolvedMode) {
      commentLoader =
        COMMENT_LOADER_RESOLVED + (atomicComments ? REPLY_GEN_ATOMIC_RESOLVED : REPLY_GEN_RESOLVED);
    } else {
      commentLoader = COMMENT_LOADER + (atomicComments ? REPLY_GEN_ATOMIC : REPLY_GEN);
    }
  }

  // テーマ: apply-before-paint (head 早期同期 script) + body 末ローダ + トグル UI。themeMode 時のみ。
  const themeHead = themeMode ? THEME_HEAD : '';
  const themeToggle = themeMode ? THEME_TOGGLE_HTML : '';
  const themeLoader = themeMode ? THEME_LOADER : '';

  // ホバー: 要約データ島 (JSON) + body 末ローダ。hoverMode 時のみ。
  const hoverData = hoverMode ? hoverDataIsland(fm.hover) : '';
  const hoverLoader = hoverMode ? HOVER_LOADER : '';

  // コメント解決: メモ/元コメントデータ島 (JSON {index:{memo,orig}}) + body 末ローダ。resolvedMode 時のみ。
  const resolvedData = resolvedMode ? resolvedDataIsland(resolvedMemos) : '';
  const resolvedLoader = resolvedMode ? RESOLVED_LOADER : '';

  // 戻りナビ: 報告書 (isReportDoc) は毎回注入 (2026-09-01 maintainer指示)。
  //   アンカー内遷移で右下に「↩ 戻る」チップ。非報告書は注入ゼロ = byte 不変。
  const backnavMode = isReportDoc(fm, blocks);
  const backnavHtml = backnavMode ? BACKNAV_HTML : '';
  const backnavLoader = backnavMode ? BACKNAV_LOADER : '';
  // <html> に対応済み (元コメント有り) 基底見出し id 集合をスペース区切りで埋め込む。
  //   REPLY_GEN(_ATOMIC)_RESOLVED がこれを skip-set として読み、基底 id コメントを集約から除外する。
  //   resolvedMode かつ元コメント有り entry が 1 件以上ある時のみ属性を出す (非該当は属性ごと無し)。
  const resolvedSectionsAttr =
    resolvedMode && resolvedOrigSids && resolvedOrigSids.length
      ? ' data-resolved-sections="' + escapeAttr(resolvedOrigSids.join(' ')) + '"'
      : '';

  // コードブロックのコピーボタン: コピー対象のコードブロックを出力した文書にだけ CSS と body 末ローダを注入。
  //   ここまでで全パネル・本文の描画が済んでいるため、フラグは確定している。対象ゼロの文書は byte 不変。
  const codeCopyMode = _codeCopyUsed;
  const codeCopyLoader = codeCopyMode ? CODE_COPY_LOADER : '';
  // チェック欄: renderList が立てるフラグ。対象ゼロの文書は byte 不変。
  const taskMode = _taskUsed;
  const taskLoader = taskMode ? TASK_LOADER : '';

  // 図のビューア: svg の図を出力した文書にだけ CSS と body 末ローダを注入。無い文書は byte 不変。
  const figViewMode = _svgFigUsed;

  // 押せる図: 最終パス (_figPlan が有効な宣言だけを持つ) で、結線できる宣言が 1 件以上あるときだけ
  //   データ島+戻りチップ・CSS・ローダを注入する。それ以外は注入ゼロ = 従来と byte 一致。
  const figParts = _figPlan ? figLinkParts(_figPlan) : null;

  const inner =
    header +
    themeToggle +
    outputsPanel +
    audiencePanel +
    summaryPanel +
    decisionPanel +
    toc +
    '<main class="report-body">' + bodyHtml + '</main>' +
    pendingPanel +
    replyGen +
    footer;

  return (
    '<!DOCTYPE html>\n<html lang="ja"' +
    (themeMode ? ' data-theme="day"' : '') +
    ' data-src-sha256="' + mdSha + '"' +
    (commentsMode ? ' data-report-id="' + escapeAttr(reportId) + '"' : '') +
    resolvedSectionsAttr +
    // チェック欄の保存キー用。コメント機能の有無 (comments: off 等) に左右されないよう専用属性で渡す。
    //   チェック欄を描いた文書かつ report_id/doc_id がある時だけ = それ以外は byte 不変。
    (taskMode && reportId ? ' data-task-id="' + escapeAttr(reportId) + '"' : '') + '>\n' +
    '<head>\n<meta charset="utf-8"/>\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>\n' +
    // no-cache メタ 3 点 (2026-08-30 maintainer指示): 再レンダ後に旧キャッシュが表示される陳腐化対策。
    // 静的固定文字列のみ = 決定論維持 (壁時計不使用)。HTTP 配信時はヘッダが優先される (SKILL.md 参照)。
    '<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate"/>\n' +
    '<meta http-equiv="Pragma" content="no-cache"/>\n' +
    '<meta http-equiv="Expires" content="0"/>\n' +
    '<title>' + escapeHtml(title) + '</title>\n' +
    '<style>\n' + CSS + (themeMode ? THEME_CSS : '') + (hoverMode ? HOVER_CSS : '') +
      (tabsMode ? TAB_CSS : '') + (commentsMode ? COMMENT_CSS : '') +
      (resolvedMode ? RESOLVED_CSS : '') + (backnavMode ? BACKNAV_CSS : '') +
      (summarySec ? SUMMARY_CSS : '') + (codeCopyMode ? CODE_COPY_CSS : '') +
      (figParts ? FIGLINK_CSS : '') + (outputsPanel ? OUTPUTS_CSS : '') + (figViewMode ? FIGVIEW_CSS : '') + (taskMode ? TASK_CSS : '') + '\n</style>\n' +
      themeHead + tabHead + '</head>\n' +
    '<body>\n<div class="wrap">\n' + inner + '\n</div>\n' +
    hoverData + resolvedData + backnavHtml + (figParts ? figParts.html : '') + mermaidLoader + tabLoader + commentLoader + themeLoader + hoverLoader + resolvedLoader + backnavLoader + codeCopyLoader + (figParts ? FIGLINK_LOADER : '') + (figViewMode ? FIGVIEW_LOADER : '') + taskLoader + '</body>\n</html>\n'
  );
}

// ---------------------------------------------------------------------------
// 戻りナビ (報告書は毎回 on。2026-09-01 maintainer指示):
//   ページ内アンカー遷移 (目次/本文リンク) のクリック時に scrollY を積み、
//   右下固定チップ「↩ 戻る」で復帰する。スタック上限 50。復帰時は hash を除去
//   (同一アンカーを再クリックしても再遷移できるように)。
//   ラベルは CSS ::before content = テキストノード非生成 (HTML⊆MD / --verify 維持)。
//   isReportDoc 真の文書のみ注入。非報告書は注入ゼロ = 既存 byte 不変。
// ---------------------------------------------------------------------------

const BACKNAV_CSS = `
.backnav{position:fixed;right:22px;bottom:22px;z-index:60;display:none}
.backnav.on{display:block}
.backnav-btn{cursor:pointer;border:1px solid var(--line);background:var(--card);color:var(--fg);
  border-radius:999px;padding:.5em 1.1em;font-size:.88em;font-family:inherit;
  box-shadow:0 4px 14px rgba(0,0,0,.35)}
.backnav-btn:hover{border-color:var(--accent);color:var(--accent)}
.backnav-btn::before{content:"\\21A9  戻る"}
@media print{.backnav{display:none!important}}
`;

const BACKNAV_HTML =
  '<div class="backnav" id="backnav">' +
  '<button type="button" class="backnav-btn" id="backnav-btn" aria-label="前の位置に戻る"></button>' +
  '</div>';

const BACKNAV_LOADER = `<script>(function(){
var st=[];var nav=document.getElementById('backnav');var btn=document.getElementById('backnav-btn');
if(!nav||!btn)return;
document.addEventListener('click',function(e){
  if(e.defaultPrevented)return;
  var t=e.target;var a=t&&t.closest?t.closest('a[href^="#"]'):null;
  if(!a)return;var id=a.getAttribute('href').slice(1);
  if(!id)return;var el=document.getElementById(id);
  if(!el||(el.offsetParent===null&&el!==document.body))return;
  st.push(window.scrollY||0);if(st.length>50)st.shift();
  nav.classList.add('on');
},false);
btn.addEventListener('click',function(){
  if(!st.length)return;var y=st.pop();
  if(history.replaceState)history.replaceState(null,'',location.pathname+location.search);
  window.scrollTo(0,y);
  if(!st.length)nav.classList.remove('on');
});
})();</script>`;

// ---------------------------------------------------------------------------
// 押せる図 (opt-in: figure_links 宣言があり、結線できる宣言が 1 件以上ある文書にだけ注入。非該当は byte 不変):
//   データ島 (JSON {links:[{node,to,label}]}・hover と同じエスケープ) + 戻りチップ (ラベルは CSS ::before・
//   aria-label は固定) + CSS + 固定ローダ。文言はすべて CSS 擬似要素・属性・JS の textContent で、静的な
//   テキストノードを増やさない (--verify の HTML⊆MD / MD⊆HTML は不変)。innerHTML は使わない。
//   ローダ: 描画後の SVG の g.node (id = flowchart-<ノードID>-<連番>) を、文字列の等価比較でデータ島の宣言と
//   突き合わせて結線する (宣言値から正規表現・セレクタを組み立てない)。結線は冪等 (data-flwired)。
//   押す → 飛び先へ移動・強調・フォーカス・読み上げ通知。戻りは DOM 参照を持たない小さなスタック (上限 20) で、
//   戻るときにタブを開き現在の DOM からノードを取り直す。強調と一時 tabindex はスタックから再計算する。
//   実行時の検証: 描画済みの図が 1 つ以上あるのに結線できなかった宣言を「押せない宣言」として
//   console.warn / <html data-fl-unwired> / 画面の小さな注意で明示する。描画済みの図が無い間 (オフライン・
//   読み込み失敗・描画待ち) は判定しない。
// ---------------------------------------------------------------------------

const FIGLINK_CSS = `
.fl-node{cursor:pointer}
.fl-node:hover{filter:brightness(1.3)}
.fl-node:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.fl-hit{outline:3px solid var(--accent);outline-offset:2px;background:var(--accent-soft);animation:fl-flash 1.4s ease-out 1}
tr.fl-hit>td,tr.fl-hit>th{background:var(--accent-soft)!important}
tr.fl-hit>td:first-child,tr.fl-hit>th:first-child{box-shadow:inset 5px 0 0 var(--accent)}
@keyframes fl-flash{from{background:var(--accent)}to{background:var(--accent-soft)}}
@media (prefers-reduced-motion:reduce){.fl-hit{animation:none}}
.figback{position:fixed;right:22px;bottom:70px;z-index:60;display:none}
.figback.on{display:block}
.figback-btn{cursor:pointer;border:1px solid var(--accent);background:var(--card);color:var(--fg);
  border-radius:999px;padding:.5em 1.1em;font-size:.88em;font-family:inherit;
  box-shadow:0 4px 14px rgba(0,0,0,.35)}
.figback-btn:hover{color:var(--accent)}
.figback-btn::before{content:"\\21A9  図に戻る"}
.fl-live{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.fl-warn{position:fixed;left:16px;bottom:16px;z-index:60;max-width:70vw;padding:.5em .9em;
  border:1px solid var(--warn);border-radius:8px;background:var(--warn-soft);color:var(--fg);font-size:.85em}
@media print{.figback,.fl-warn,.fl-live{display:none!important}}
`;

const FIGLINK_HTML =
  '<div class="figback" id="figback">' +
  '<button type="button" class="figback-btn" id="figback-btn" aria-label="図に戻る"></button>' +
  '</div>';

function figLinkDataIsland(links) {
  let json = JSON.stringify({ links });
  json = json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return '<script type="application/json" class="mdr-figlink-data">' + json + '</script>\n';
}

const FIGLINK_LOADER = `<script>
(function(){
  var SETTLE_MS=300, TIMEOUT_MS=8000, STACK_MAX=20;
  var island=document.querySelector('script.mdr-figlink-data'); if(!island) return;
  var data={}; try{ data=JSON.parse(island.textContent||'{}'); }catch(e){ return; }
  var links=(data&&data.links)||[]; if(!links.length) return;
  var pres=[].slice.call(document.querySelectorAll('pre.mermaid')); if(!pres.length) return;
  var nav=document.getElementById('figback'), btn=document.getElementById('figback-btn'); if(!nav||!btn) return;
  var byNode=Object.create(null); links.forEach(function(l){ byNode[l.node]=l; });
  var t0=Date.now(), stack=[], tmp=[], timer=null, lastUn='';
  var live=document.createElement('div'); live.className='fl-live';
  live.setAttribute('role','status'); live.setAttribute('aria-live','polite'); document.body.appendChild(live);
  var warn=document.createElement('div'); warn.className='fl-warn'; warn.setAttribute('role','status');
  warn.hidden=true; document.body.appendChild(warn);
  function say(t){ live.textContent=''; live.textContent=t; }
  function nodeIdOf(g){
    var id=g.getAttribute('id')||''; if(id.indexOf('flowchart-')!==0) return null;
    var rest=id.slice(10), m=/-(\\d+)$/.exec(rest); if(!m) return null;
    return rest.slice(0,rest.length-m[0].length);
  }
  function tabIdOf(el){ var p=el.closest?el.closest('.tab-panel'):null; return p?p.getAttribute('data-tab-panel'):null; }
  function openTab(id){
    if(id===null) return;
    var panels=document.querySelectorAll('.tab-panel');
    for(var i=0;i<panels.length;i++){
      if(panels[i].getAttribute('data-tab-panel')===id&&panels[i].classList.contains('active')) return;
    }
    var ts=document.querySelectorAll('.tab');
    for(var j=0;j<ts.length;j++){ if(ts[j].getAttribute('data-tab')===id){ ts[j].click(); return; } }
  }
  function restoreTmp(keepId){
    var keep=[];
    tmp.forEach(function(r){
      if(r.el.id===keepId){ keep.push(r); return; }
      if(r.had) r.el.setAttribute('tabindex',r.val); else r.el.removeAttribute('tabindex');
    });
    tmp=keep;
  }
  function refresh(focusTop){
    var want=Object.create(null); stack.forEach(function(s){ want[s.to]=true; });
    var hit=document.querySelectorAll('.fl-hit');
    for(var i=0;i<hit.length;i++){ if(!want[hit[i].id]) hit[i].classList.remove('fl-hit'); }
    for(var id in want){ var el=document.getElementById(id); if(el) el.classList.add('fl-hit'); }
    var top=stack.length?stack[stack.length-1].to:null;
    restoreTmp(top);
    if(top!==null){
      var te=document.getElementById(top);
      if(te){
        var has=false; for(var k=0;k<tmp.length;k++){ if(tmp[k].el===te) has=true; }
        if(!has){ tmp.push({el:te,had:te.hasAttribute('tabindex'),val:te.getAttribute('tabindex')}); te.setAttribute('tabindex','-1'); }
        if(focusTop){ try{ te.focus({preventScroll:true}); }catch(e){} }
      }
    }
    nav.classList.toggle('on',stack.length>0);
  }
  function go(l,idx,nid){
    var to=document.getElementById(l.to); if(!to) return;
    var y=window.pageYOffset||document.documentElement.scrollTop||0;
    stack.push({y:y,fig:idx,node:nid,to:l.to,tab:tabIdOf(pres[idx])});
    if(stack.length>STACK_MAX) stack.shift();
    openTab(tabIdOf(to));
    var r=to.getBoundingClientRect();
    to.scrollIntoView({block:(r.height>window.innerHeight*0.8)?'start':'center'});
    refresh(true);
    say('「'+l.label+'」へ移動しました');
  }
  function findNode(idx,nid){
    var pre=pres[idx]; if(!pre) return null; wire(pre,idx);
    var gs=pre.querySelectorAll('g.node');
    for(var i=0;i<gs.length;i++){ if(gs[i].__flw&&gs[i].__flnode===nid) return gs[i]; }
    return null;
  }
  btn.addEventListener('click',function(){
    var s=stack.pop(); if(!s) return;
    openTab(s.tab);
    window.scrollTo(0,s.y);
    var node=findNode(s.fig,s.node);
    if(node){ try{ node.focus({preventScroll:true}); }catch(e){} }
    refresh(false);
    say(stack.length?'前の図の位置へ戻りました':'図の位置へ戻りました');
  });
  function bind(g,l,idx,nid){
    g.addEventListener('click',function(e){ e.preventDefault(); go(l,idx,nid); });
    g.addEventListener('keydown',function(e){
      if(e.key==='Enter'||e.key===' '||e.key==='Spacebar'){ e.preventDefault(); go(l,idx,nid); }
    });
  }
  // 結線済みの印は JS 側のプロパティ (__flw) に持つ。mermaid は描画中に pre の中へ一時の SVG を作り、文字列へ
  // 直してから innerHTML で差し替えるので、属性は複製されるが、登録したイベントはノードごと失われる
  // (属性を印にすると、複製されたノードを結線済みと誤認して、クリックが効かなくなる)。
  function wire(pre,idx){
    var gs=pre.querySelectorAll('g.node');
    for(var i=0;i<gs.length;i++){
      var g=gs[i]; if(g.__flw) continue;
      var nid=nodeIdOf(g); if(nid===null) continue;
      var l=byNode[nid]; if(!l) continue;
      var text=(g.textContent||'').replace(/\\s+/g,' ').trim();
      g.__flw=true; g.__flnode=nid;
      g.setAttribute('tabindex','0'); g.setAttribute('role','link');
      g.setAttribute('aria-label',text+'（'+l.label+' へ移動）');
      g.classList.add('fl-node');
      var c=g.firstChild;
      while(c){ var nx=c.nextSibling; if(c.nodeName==='title'&&c.getAttribute('data-fltitle')) g.removeChild(c); c=nx; }
      var ti=document.createElementNS(g.namespaceURI,'title'); ti.setAttribute('data-fltitle','1');
      ti.textContent=l.label+' の詳細へ'; g.insertBefore(ti,g.firstChild);
      bind(g,l,idx,nid);
    }
  }
  function setUnwired(list){
    var s=list.join(','); if(s===lastUn) return; lastUn=s;
    if(list.length){
      document.documentElement.setAttribute('data-fl-unwired',s);
      warn.textContent='押せない宣言: '+list.join(', '); warn.hidden=false;
      if(window.console&&console.warn) console.warn('[figure_links] 押せない宣言 (図にノードが無い): '+s);
    } else {
      document.documentElement.removeAttribute('data-fl-unwired'); warn.hidden=true; warn.textContent='';
    }
  }
  function evaluate(){
    timer=null;
    var rendered=[], pending=0;
    pres.forEach(function(p){ if(p.querySelector('svg')) rendered.push(p); else pending++; });
    if(pending>0&&Date.now()-t0<TIMEOUT_MS){ schedule(); return; }
    if(!rendered.length){
      if(window.console&&console.info) console.info('[figure_links] 図が描画されていないため、宣言の検証は行いません');
      return;
    }
    var un=[];
    links.forEach(function(l){
      var ok=false;
      rendered.forEach(function(p){
        var gs=p.querySelectorAll('g.node');
        for(var i=0;i<gs.length;i++){ if(gs[i].__flw&&gs[i].__flnode===l.node) ok=true; }
      });
      if(!ok) un.push(l.node);
    });
    setUnwired(un);
  }
  function schedule(){ if(timer) clearTimeout(timer); timer=setTimeout(evaluate,SETTLE_MS); }
  function scan(){ pres.forEach(wire); schedule(); }
  if(window.MutationObserver){
    pres.forEach(function(p){ new MutationObserver(scan).observe(p,{childList:true,subtree:true}); });
  }
  document.addEventListener('click',function(e){
    var t=e.target; if(t&&t.closest&&t.closest('.tab')) setTimeout(scan,0);
  },true);
  window.addEventListener('load',scan);
  scan();
})();
</script>
`;

// ---------------------------------------------------------------------------
// コードブロックのコピーボタン (既定 on。コピー対象のコードブロックを出力した文書にだけ注入)。
//   外枠 .cb はテーマに関係なく「端末らしい暗い帯」に固定する。色は .cb 上の --cb-* 変数で持ち、
//   :root を触らないのでテーマ切替 CSS と干渉しない (Day テーマでも「貼る物」がひと目で分かる)。
//   ラベル (data-label) とボタン文字は CSS 擬似要素 = テキストノード非生成 (HTML⊆MD 維持)。
//   ボタンは JS 準備完了 (html.cb-ready) まで visibility:hidden。JS が動かない環境で押しても何も起きない
//   ボタンを見せない (場所は確保済みなので出現時に行はずれない)。
//   配色は WCAG 相対輝度比で 文字 4.5:1 以上・ボタン枠/フォーカス枠 3:1 以上を実測して決めた。
// ---------------------------------------------------------------------------
// チェック欄 (- [ ] 文): 手順書で「OK なら印を付けるだけ」にするための部品。
//   frontmatter checkboxes: on を宣言した文書だけが対象 (_tasksOn)。CSS/ローダは _taskUsed の文書にだけ注入。状態は localStorage
//   ('ccpit-chk:<report-id>:<通し番号>:<文の先頭 40 字>') に保存し、HTML 本体は変えない。
//   report-id が無い文書では保存せず、その場限りのチェックになる。
// ---------------------------------------------------------------------------

const TASK_CSS = `
li.task{list-style:none;margin-left:-1.2em}
.task-label{display:inline-flex;align-items:flex-start;gap:.5em;cursor:pointer}
.task-box{width:1.15em;height:1.15em;margin:.15em 0 0;accent-color:#1E7A4E;cursor:pointer;flex:none}
li.task.done>.task-label>.task-text{color:var(--muted);text-decoration:line-through}
.task-progress{color:var(--muted);font-size:.82em;margin:.2em 0 .8em}
.task-progress::before{content:"チェック " attr(data-n) " / " attr(data-total)}
`;

const TASK_LOADER = `<script>
(function(){
  var rid=document.documentElement.getAttribute('data-task-id')||'';
  var boxes=[].slice.call(document.querySelectorAll('input.task-box'));
  if(!boxes.length) return;
  function key(i,b){
    var t=(b.parentNode.querySelector('.task-text')||{}).textContent||'';
    return 'ccpit-chk:'+rid+':'+i+':'+t.slice(0,40);
  }
  function paint(b){ var li=b.closest('li.task'); if(li){ if(b.checked) li.classList.add('done'); else li.classList.remove('done'); } }
  var prog=null;
  function progress(){
    if(!prog){ prog=document.createElement('div'); prog.className='task-progress';
      var main=document.querySelector('main.report-body'); if(main&&main.parentNode) main.parentNode.insertBefore(prog,main); }
    var n=0; boxes.forEach(function(b){ if(b.checked) n++; });
    prog.setAttribute('data-n',String(n)); prog.setAttribute('data-total',String(boxes.length));
  }
  boxes.forEach(function(b,i){
    if(rid){ try{ var v=localStorage.getItem(key(i,b)); if(v==='1') b.checked=true; else if(v==='0') b.checked=false; }catch(e){} }
    paint(b);
    b.addEventListener('change',function(){
      paint(b);
      if(rid){ try{ localStorage.setItem(key(i,b), b.checked?'1':'0'); }catch(e){} }
      progress();
    });
  });
  progress();
})();
</script>
`;

const CODE_COPY_CSS = `
.cb{--cb-bg:#0B1019;--cb-bar:#151C29;--cb-line:#2B3446;--cb-ink:#E4E9F1;--cb-label:#9DA9BC;
  --cb-btn-bg:#263146;--cb-btn-ink:#E4E9F1;--cb-btn-line:#5A6883;--cb-btn-hover:#31405C;
  --cb-ok:#1E7A4E;--cb-fail:#B02E2E;--cb-focus:#A7BDF5;
  margin:1em 0;background:var(--cb-bg);border:1px solid var(--cb-line);border-radius:8px;overflow:hidden}
.cb-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:40px;
  padding:4px 8px 4px 14px;background:var(--cb-bar);border-bottom:1px solid var(--cb-line)}
.cb-bar::before{content:attr(data-label);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:"Cascadia Code","Consolas",monospace;font-size:.78em;letter-spacing:.04em;color:var(--cb-label)}
.cb-bar:not([data-label])::before{content:"code"}
.cb>pre.code{margin:0;border:0;border-radius:0;background:var(--cb-bg);color:var(--cb-ink);
  padding:12px 16px;overflow-x:auto}
.cb>pre.code code{color:inherit}
.cb-copy{flex:none;visibility:hidden;cursor:pointer;font:inherit;font-size:.8em;font-weight:600;line-height:1.2;
  min-height:32px;padding:.35em .9em;border-radius:6px;background:var(--cb-btn-bg);color:var(--cb-btn-ink);
  border:1px solid var(--cb-btn-line);transition:background .15s,color .15s}
html.cb-ready .cb-copy{visibility:visible}
.cb-copy:hover{background:var(--cb-btn-hover)}
.cb-copy:focus-visible{outline:2px solid var(--cb-focus);outline-offset:2px}
.cb-copy::before{content:"\\30B3\\30D4\\30FC"}
.cb-copy[data-state="done"]{background:var(--cb-ok);color:#FFFFFF;border-color:var(--cb-ok)}
.cb-copy[data-state="done"]::before{content:"\\30B3\\30D4\\30FC\\3057\\305F"}
.cb-copy[data-state="fail"]{background:var(--cb-fail);color:#FFFFFF;border-color:var(--cb-fail)}
.cb-copy[data-state="fail"]::before{content:"\\30B3\\30D4\\30FC\\5931\\6557\\FF1A\\624B\\3067\\9078\\629E\\3057\\3066"}
.cb-live{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:reduce){.cb-copy{transition:none}}
@media print{.cb-copy{display:none}}
`;

// コピーローダ (body 末)。document へのクリック委譲 1 本で全 .cb-copy を扱う (後から足した .cb にも効く)。
//   取り出しは <pre> 内 <code> の textContent: HTML エスケープ (&amp; 等) は元の文字に戻り、
//   閉じた <details> や非表示タブの中でも空にならない (innerText は表示状態に左右されるため使わない)。
//   末尾の改行は全て落とす (貼った瞬間に最終行が実行されるのを防ぐ)。行の途中の改行と行継続の \ は残す。
//   書き込みは両経路とも押した処理の中で同期的に呼ぶ (ユーザー操作の有効期間内に確実に呼ぶため):
//   まず textarea + execCommand('copy')、失敗したら navigator.clipboard.writeText (secure context のみ)。
//   API の拒否を待ってから execCommand へ切り替える順序にすると、拒否が非同期に返る環境 (権限の無い iframe 等)
//   で有効期間が切れて代替経路まで拒否されうるため、同期で完結する execCommand を先にする。
//   結果は見た目 (CSS) に加え、実行時に作る aria-live 領域へ文で知らせる (読み上げソフト向け。静的 HTML には
//   何も足さない = --verify 不変)。innerHTML 不使用・MD 由来文字列の DOM 注入なし・byte 固定 = 決定論維持。
const CODE_COPY_LOADER = `<script>
(function(){
  var root=document.documentElement; if(root.classList) root.classList.add('cb-ready');
  var DONE_MS=1600, live=null;
  function announce(ok){
    if(!live){ live=document.createElement('span'); live.className='cb-live';
      live.setAttribute('role','status'); live.setAttribute('aria-live','polite'); document.body.appendChild(live); }
    var msg=ok?'コピーしました':'コピーできませんでした。コードを選択して手でコピーしてください';
    live.textContent=''; setTimeout(function(){ live.textContent=msg; },50);
  }
  function codeText(btn){
    var box=btn.closest('.cb'), code=box&&box.querySelector('pre code');
    if(!code) return null;
    return code.textContent.replace(/(\\r?\\n)+$/,'');
  }
  function legacyCopy(text,btn){
    var ta=document.createElement('textarea'), ok=false;
    ta.value=text; ta.setAttribute('readonly',''); ta.setAttribute('aria-hidden','true');
    ta.style.position='fixed'; ta.style.top='0'; ta.style.left='-9999px'; ta.style.opacity='0';
    document.body.appendChild(ta);
    try{ ta.focus(); ta.select(); ta.setSelectionRange(0,text.length); ok=document.execCommand('copy'); }catch(e){ ok=false; }
    document.body.removeChild(ta);
    try{ btn.focus(); }catch(e){}
    return ok;
  }
  function copy(text,btn){
    if(legacyCopy(text,btn)) return Promise.resolve(true);
    if(navigator.clipboard&&navigator.clipboard.writeText&&window.isSecureContext){
      return navigator.clipboard.writeText(text).then(function(){ return true; },function(){ return false; });
    }
    return Promise.resolve(false);
  }
  document.addEventListener('click',function(e){
    var t=e.target, btn=t&&t.closest?t.closest('.cb-copy'):null;
    if(!btn) return;
    var text=codeText(btn); if(text===null) return;
    copy(text,btn).then(function(ok){
      btn.setAttribute('data-state',ok?'done':'fail');
      announce(ok);
      clearTimeout(btn._cbTimer);
      btn._cbTimer=setTimeout(function(){ btn.removeAttribute('data-state'); },DONE_MS);
    });
  },false);
})();
</script>
`;

// ---------------------------------------------------------------------------
// テンプレート: CSS (テキストノードを供給しない。ラベルは ::before/::after content)
// ---------------------------------------------------------------------------

const CSS = `
:root{
  --bg:#0F141E; --fg:#E5E7EB; --muted:#94A3B8; --line:#2A3242; --card:#1A2230;
  --accent:#7AA2E8; --accent-soft:#1E2A44; --decision:#E0915A; --decision-soft:#3A2618;
  --da:#5BC49A; --da-soft:#16302A; --warn:#D9B45A; --warn-soft:#332B14; --code-bg:#161C28;
  --bar:#22D3EE; --bar-soft:rgba(34,211,238,.3);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font-family:"Segoe UI","Hiragino Kaku Gothic ProN","Yu Gothic UI",Meiryo,sans-serif;
  line-height:1.7;font-size:15px}
.wrap{max-width:960px;margin:0 auto;padding:32px 24px 80px}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
h1,h2,h3,h4{line-height:1.4;margin:1.6em 0 .6em}
h2{border-bottom:2px solid var(--line);padding-bottom:.25em;font-size:1.4em}
h3{font-size:1.15em}
h4{font-size:1.02em;color:var(--muted)}
hr{border:none;border-top:1px solid var(--line);margin:1.6em 0}
code{background:var(--code-bg);padding:.1em .35em;border-radius:4px;
  font-family:"Cascadia Code","Consolas",monospace;font-size:.88em}
pre.code{background:var(--code-bg);padding:14px 16px;border-radius:8px;overflow:auto;
  border:1px solid var(--line)}
pre.code code{background:none;padding:0}
pre.mermaid{background:var(--card);border:1px dashed var(--line);padding:14px;border-radius:8px}
.table-wrap{overflow-x:auto;margin:1em 0}
table{border-collapse:collapse;width:100%;background:var(--card);font-size:.92em}
th,td{border:1px solid var(--line);padding:7px 11px;text-align:left;vertical-align:top}
th{background:var(--accent-soft);font-weight:600}
tr:nth-child(even) td{background:#1E2735}
blockquote{margin:1em 0;padding:.4em 1em;border-left:3px solid var(--line);color:var(--muted)}
th.num-col{text-align:right;color:#CBD5E1;border-bottom:2px solid rgba(34,211,238,.55)}
td.num-cell{position:relative;text-align:right;font-variant-numeric:tabular-nums}
td.num-cell .bar{position:absolute;left:0;top:0;bottom:0;
  background:linear-gradient(to top,var(--bar) 0,var(--bar) 5px,var(--bar-soft) 5px);
  border-right:2px solid var(--bar);z-index:0}
td.num-cell .num{position:relative;z-index:1}
img.svg-fig{display:block;max-width:100%;margin:1em auto;background:var(--card);
  border:1px solid var(--line);border-radius:8px;padding:8px}

/* --- ヘッダ --- */
.report-header{border-bottom:3px solid var(--accent);padding-bottom:18px;margin-bottom:8px}
.report-title{margin:.2em 0 .5em;font-size:1.7em}
dl.meta{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0;font-size:.9em}
dl.meta .meta-row{display:contents}
dl.meta dt{color:var(--muted);font-weight:600;text-transform:uppercase;font-size:.82em;letter-spacing:.03em}
dl.meta dd{margin:0}
.breadcrumb .crumb:not(:last-child)::after{content:"\\203A";color:var(--muted);margin:0 .5em}
.badge-status{display:inline-block;padding:.1em .6em;border-radius:999px;font-size:.85em;font-weight:600;
  background:var(--warn-soft);color:var(--warn);border:1px solid var(--warn)}
.badge-status[data-status="awaiting-approval"],.badge-status[data-status="in_progress"]{
  background:var(--warn-soft);color:var(--warn);border-color:var(--warn)}
.badge-status[data-status="approved"],.badge-status[data-status="done"],.badge-status[data-status="complete"]{
  background:var(--da-soft);color:var(--da);border-color:var(--da)}
.chips .chip{display:inline-block;background:var(--accent-soft);color:var(--accent);
  padding:.05em .55em;border-radius:999px;font-size:.85em;margin-right:.35em}

/* --- パネル共通 --- */
.panel{background:var(--card);border:1px solid var(--line);border-radius:10px;
  padding:8px 20px 16px;margin:18px 0}
.panel>h2{border-bottom:1px solid var(--line);margin-top:.6em}

/* ブロック2: 読者と目的 */
.panel-audience{border-left:4px solid var(--accent)}

/* ブロック3: 要判断一覧 (題は CSS 擬似要素。テキストノード非生成) */
.panel-decisions{border-left:4px solid var(--decision);position:relative}
.panel-decisions::before{content:"\\8981\\5224\\65AD\\4E00\\89A7\\FF08\\672A\\6C7A\\20" attr(data-count) "\\4EF6\\FF09";display:block;font-weight:700;
  color:var(--decision);font-size:1.05em;margin:.4em 0 .2em}
.decision-list{margin:.4em 0 0;padding-left:1.2em}
.decision-list li{margin:.25em 0}

/* ブロック4: TOC (題は CSS 擬似要素) */
.toc{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 20px 14px;margin:18px 0}
.toc::before{content:"\\76EE\\6B21";display:block;font-weight:700;color:var(--muted);margin:.4em 0 .2em;
  text-transform:uppercase;letter-spacing:.05em;font-size:.85em}
.toc ul{list-style:none;margin:0;padding:0}
.toc li{margin:.15em 0}
.toc-l3{padding-left:1.2em;font-size:.95em}
.toc-l4{padding-left:2.4em;font-size:.9em;color:var(--muted)}

/* ブロック6: Pending 台帳 (件数バッジは data 属性 → CSS content) */
.panel-pending{border-left:4px solid var(--warn)}
.panel-pending>h2::after{content:" (" attr(data-count) ")";color:var(--muted);font-size:.7em;font-weight:400}

/* admonition (ラベルは CSS ::before。テキストノード非生成) */
.adm{border-radius:8px;padding:10px 16px;margin:1em 0;border:1px solid var(--line)}
.adm .adm-title{font-weight:600;margin:.2em 0}
.adm .adm-body{font-size:.95em}
.adm::before{display:inline-block;font-weight:700;font-size:.78em;letter-spacing:.05em;
  padding:.05em .5em;border-radius:4px;margin-bottom:.3em}
.adm-decision{background:var(--decision-soft);border-color:var(--decision)}
.adm-decision::before{content:"\\8981\\5224\\65AD\\FF08\\672A\\6C7A\\FF09";background:var(--decision);color:#0F141E}
.adm-da{background:var(--da-soft);border-color:var(--da)}
.adm-da::before{content:"DA";background:var(--da);color:#0F141E}
.adm-note{background:var(--accent-soft);border-color:var(--accent)}
.adm-note::before{content:"NOTE";background:var(--accent);color:#0F141E}
.adm-warning,.adm-important{background:var(--warn-soft);border-color:var(--warn)}
.adm-warning::before{content:"WARNING";background:var(--warn);color:#0F141E}
.adm-important::before{content:"IMPORTANT";background:var(--warn);color:#0F141E}
.adm-tip::before{content:"TIP";background:var(--da);color:#0F141E}

/* フッタ (ファイル名 + sha は data 属性 → CSS content。テキストノード非生成) */
.report-footer{margin-top:40px;padding-top:14px;border-top:1px solid var(--line);
  color:var(--muted);font-size:.82em}
.report-footer::before{content:attr(data-srcfile)}
.report-footer::after{content:"  ·  sha256:" attr(data-sha256);font-family:monospace}
`;

// 結論の概要 CSS は ## 結論の概要 を持つ報告書にのみ注入 (非該当報告書の <style> を byte 不変に保つ)。
// パネル左帯 + 状態バッジ (OK/FAIL/CAVEAT/INFO・diagram-craft palette)。バッジ文字は MD 由来 (HTML⊆MD)。
const SUMMARY_CSS = `
.panel-summary{border-left:4px solid var(--accent)}
.conc-badge{display:inline-block;font-weight:700;font-size:.78em;letter-spacing:.03em;
  padding:.08em .5em;border-radius:999px;margin-right:.5em;border:1px solid}
.conc-ok{background:#0F766E;border-color:#5EEAD4;color:#F8FAFC}
.conc-fail{background:#7F1D1D;border-color:#FCA5A5;color:#FEF2F2}
.conc-caveat{background:#7C2D12;border-color:#FDBA74;color:#FFF7ED}
.conc-info{background:#1F2937;border-color:#64748B;color:#E5E7EB}
`;

// タブ CSS は tabs: by-h2 報告書にのみ注入する (非タブ報告書の <style> を byte 不変に保つ)。
// JS 無し=全パネル縦表示で全文可読 / html.js 時のみタブ表示。
// タブラベルは H2 見出しテキストそのもの (完全 MD 由来)。番号は付与しない (著者が見出しで付ける)。
const TAB_CSS = `
.report-tabs .tabs{display:none;flex-wrap:wrap;gap:.25em;margin:18px 0 0;padding:.3em .4em 0;
  border:1px solid var(--line);border-radius:8px 8px 0 0;background:var(--card)}
html.js .report-tabs .tabs{display:flex}
.report-tabs .tab{font:inherit;font-size:1.4em;font-weight:600;background:none;border:none;color:var(--muted);
  cursor:pointer;padding:.45em .9em;border-bottom:3px solid transparent;white-space:nowrap}
.report-tabs .tab:hover{color:var(--fg)}
.report-tabs .tab.active{color:var(--accent);border-bottom-color:var(--accent)}
.report-tabs .tab-panel{display:block}
html.js .report-tabs .tab-panel{display:none}
html.js .report-tabs .tab-panel.active{display:block}
`;

const MERMAID_LOADER = `<script>
(function(){
  // 三段フォールバック (1)local vendor → (2)pinned CDN+SRI → (3)原文表示(何もしない)
  function boot(m){ try{ m.initialize({startOnLoad:true,theme:'dark'}); }catch(e){} }
  function tryCdn(){
    var s=document.createElement('script');
    s.src='https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js';
    s.onload=function(){ if(window.mermaid) boot(window.mermaid); };
    document.head.appendChild(s);
  }
  var v=document.createElement('script');
  v.src='./vendor/mermaid.min.js';
  v.onload=function(){ if(window.mermaid) boot(window.mermaid); };
  v.onerror=tryCdn;
  document.head.appendChild(v);
})();
</script>
`;

// タブ: apply-before-paint (head 同期実行で html.js を付与 → JS 有時のみタブ表示・無フラッシュ)。
// 汎用・MD 非依存・byte 固定 = 決定論維持。tabs: by-h2 宣言時のみ注入。
const TAB_HEAD = '<script>document.documentElement.classList.add("js")</script>\n';

// タブ配線 (body 末)。data-* と既存 DOM のみ読み、classList / aria-selected のみ操作。
// innerHTML 不使用・MD 由来文字列の DOM 注入なし = 攻撃面を増やさない。byte 固定 = 決定論維持。
const TAB_LOADER = `<script>
(function(){
  var root=document.querySelector('.report-tabs'); if(!root) return;
  var tabs=[].slice.call(root.querySelectorAll('.tab'));
  var panels=[].slice.call(root.querySelectorAll('.tab-panel'));
  function sel(i){
    tabs.forEach(function(t){var on=t.getAttribute('data-tab')===i;
      t.classList.toggle('active',on); t.setAttribute('aria-selected',on?'true':'false');});
    panels.forEach(function(p){p.classList.toggle('active',p.getAttribute('data-tab-panel')===i);});
  }
  tabs.forEach(function(t){t.addEventListener('click',function(){sel(t.getAttribute('data-tab'));});});
})();
</script>
`;

// ---------------------------------------------------------------------------
// テーマ切替 (opt-in: frontmatter theme: toggle 時のみ注入)。
// 非宣言文書は CSS/HTML/JS いずれも注入されず byte 不変。
// 設計核: 無属性 :root のスタイルに依存しない (Day/Dark を両方明示)。
//         Day を既定とし、html タグに data-theme="day" を静的出力。
//         apply-before-paint で localStorage の保存値を描画前に反映 (無フラッシュ)。
//         トグル UI はラジオ。可視ラベルは CSS 擬似要素 (verify 除外) ＝ 静的
//         テキストノードを生成しない (a11y 正本は aria-label 属性)。
// ---------------------------------------------------------------------------

const THEME_CSS = `
/* Dark パレット (現行ダーク変数を data-theme="dark" に明示複製) */
:root[data-theme="dark"]{
  --bg:#0F141E; --fg:#E5E7EB; --muted:#94A3B8; --line:#2A3242; --card:#1A2230;
  --accent:#7AA2E8; --accent-soft:#1E2A44; --decision:#E0915A; --decision-soft:#3A2618;
  --da:#5BC49A; --da-soft:#16302A; --warn:#D9B45A; --warn-soft:#332B14; --code-bg:#161C28;
  --bar:#22D3EE; --bar-soft:rgba(34,211,238,.3);
}
/* Day パレット (実機FB: 背景をより明るく。本文 WCAG AA 確保。card は純白で paper 感) */
:root[data-theme="day"]{
  --bg:#FCFDFF; --fg:#1A202C; --muted:#566072; --line:#DBE1EA; --card:#FFFFFF;
  --accent:#1F50C0; --accent-soft:#E7EEFC; --decision:#9E4E16; --decision-soft:#FBEAD8;
  --da:#176B49; --da-soft:#DCF3E8; --warn:#8A6000; --warn-soft:#FBF0D2; --code-bg:#F0F3F8;
  --bar:#0E7490; --bar-soft:rgba(14,116,144,.18);
}
/* 数値列バー可読性 (実機FB1: 濃い側でも数値が読める)。
   テーマスコープ限定 = 非テーマ文書 (.num-cell .num) は base CSS のまま byte 不変。
   Day: 暗文字を --fg 強制 + 太字 + 前面化。バーは opacity で淡色化し濃い側でも
        暗文字が読める (任意の barColor 着地でも solid 帯/枠込み AA 以上)。 */
:root[data-theme="day"] .num-cell .num{color:var(--fg);font-weight:600;position:relative;z-index:1}
:root[data-theme="day"] .num-cell .bar{opacity:.55}
/* Dark: 明文字を --fg 強制 + 太字 + 前面化。バーは暗カード側へ寄せて (opacity 低め)
        明文字が明色バー上でも読める (黄/シアン等の明色 barColor でも AA 以上)。 */
:root[data-theme="dark"] .num-cell .num{color:var(--fg);font-weight:600;position:relative;z-index:1}
:root[data-theme="dark"] .num-cell .bar{opacity:.4}
/* 表ゼブラ縞 (実機FB: base の tr:nth-child(even) td が #1E2735 ハードコードで、Day では
   暗背景に暗文字 (--fg) が乗り「2トンカラーの濃いほうが読めん」状態。テーマスコープで
   Day=淡色 / Dark=現行暗色 に上書き。base 規則 (#1E2735) は据え置き = 非テーマ文書 byte 不変。 */
:root[data-theme="day"] tr:nth-child(even) td{background:#EEF2F8}
:root[data-theme="dark"] tr:nth-child(even) td{background:#1E2735}
/* 数値列ヘッダ色 (base #CBD5E1 は Day の白 card 上で低コントラスト) */
:root[data-theme="day"] th.num-col{color:var(--muted)}
:root[data-theme="dark"] th.num-col{color:#CBD5E1}
/* コメントUIのマゼンタ (base #D946EF) は Day の白背景上で約2.6:1=AA未達。
   Day スコープで濃マゼンタ #A21CAF (白上 約6.7:1) へ。base 規則は据え置き=非テーマ文書 byte 不変。 */
:root[data-theme="day"] .cmt-toggle,
:root[data-theme="day"] .cmt-editbtn,
:root[data-theme="day"] .reply-gen-btn{color:#A21CAF;border-color:#A21CAF}
:root[data-theme="day"] .cmt-save{background:#A21CAF;color:#FFFFFF}
/* admonition ラベルチップ (実機FB3): base の濃文字 (#0F141E) は Day の濃い accent/da/decision/warn
   solid 上で AA 未達 (NOTE 2.6:1)。Day スコープで白文字へ上書きし AA 確保 (白 on Day solid = 5.3〜7.1)。
   base ::before 規則は据え置き = 非テーマ文書のラベル色 byte 不変。 */
:root[data-theme="day"] .adm-decision::before,
:root[data-theme="day"] .adm-da::before,
:root[data-theme="day"] .adm-note::before,
:root[data-theme="day"] .adm-warning::before,
:root[data-theme="day"] .adm-important::before,
:root[data-theme="day"] .adm-tip::before{color:#FFFFFF}
/* テーマトグル UI (ラジオ。視覚ラベルは擬似要素 = テキストノード非生成) */
.theme-toggle{display:flex;gap:.4em;align-items:center;margin:10px 0 4px;
  font-size:.85em}
.theme-toggle::before{content:"\\30C6\\30FC\\30DE";color:var(--muted);font-weight:600;
  margin-right:.4em;text-transform:uppercase;letter-spacing:.04em}
.theme-toggle label{display:inline-flex;align-items:center;gap:.3em;cursor:pointer;
  padding:.2em .7em;border:1px solid var(--line);border-radius:999px;color:var(--muted);
  background:var(--card)}
.theme-toggle input{position:absolute;opacity:0;width:1px;height:1px;margin:0}
.theme-toggle label:has(input[value="day"])::after{content:"Day"}
.theme-toggle label:has(input[value="dark"])::after{content:"Dark"}
.theme-toggle label:has(input:checked){border-color:var(--accent);color:var(--accent);
  background:var(--accent-soft);font-weight:600}
.theme-toggle label:has(input:focus-visible){outline:2px solid var(--accent);outline-offset:2px}
`;

// apply-before-paint: head 早期同期 script。描画前に localStorage 値を反映。
// 既定 day。汎用・MD 非依存・byte 固定 = 決定論維持。themeMode 時のみ注入。
const THEME_HEAD = `<script>(function(){try{var t=localStorage.getItem('mdr-theme');if(t==='day'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();</script>
`;

// トグル UI (本文先頭付近)。静的テキストノードを生成しない (commentComposer と同型):
//   視覚ラベルは CSS ::after、a11y 正本は aria-label 属性。
const THEME_TOGGLE_HTML =
  '<div class="theme-toggle" role="radiogroup" aria-label="テーマ切替">' +
  '<label><input type="radio" name="mdr-theme" value="day" aria-label="Day"/></label>' +
  '<label><input type="radio" name="mdr-theme" value="dark" aria-label="Dark"/></label>' +
  '</div>';

// テーマローダ (body 末)。ラジオ change で data-theme 更新 + localStorage 保存。
// innerHTML 不使用・setAttribute/localStorage/checked のみ。byte 固定 = 決定論維持。
const THEME_LOADER = `<script>
(function(){
  var radios=[].slice.call(document.querySelectorAll('.theme-toggle input[name="mdr-theme"]'));
  if(!radios.length) return;
  var cur=document.documentElement.getAttribute('data-theme')||'day';
  radios.forEach(function(r){
    r.checked=(r.value===cur);
    r.addEventListener('change',function(){
      if(!r.checked) return;
      document.documentElement.setAttribute('data-theme',r.value);
      try{ localStorage.setItem('mdr-theme',r.value); }catch(e){}
    });
  });
})();
</script>
`;

// ---------------------------------------------------------------------------
// ホバープレビュー (opt-in: frontmatter hover: ブロック宣言時のみ注入)。
// 非宣言文書は CSS/JS/データ島いずれも注入されず byte 不変。
// 設計核: 要約は実行時 textContent で投入 (innerHTML 禁止 = XSS 面なし)。
//         データ島は <script type="application/json"> = extractTextNodes が除外
//         (verify はホバー要約を本文テキストとして数えない)。実行時 fetch なし。
// ---------------------------------------------------------------------------

const HOVER_CSS = `
a.hoverable{border-bottom:1px dotted var(--accent)}
.mdr-hover-card{position:absolute;z-index:50;max-width:320px;background:var(--card);
  color:var(--fg);border:1px solid var(--accent);border-radius:8px;padding:.55em .8em;
  font-size:.88em;line-height:1.5;box-shadow:0 6px 24px rgba(0,0,0,.35);
  white-space:pre-wrap;pointer-events:none}
`;

// データ島生成: {index:{summary}} の JSON。</script> 破壊防止に "</" を "<\\/" へ、
// HTML 特殊文字は <script> 文脈で危険な '<' '>' '&' をエスケープ。textContent 投入のため
// 値自体の HTML 解釈は起きないが、データ島の早期終了とタグ注入を二重に防ぐ。
function hoverDataIsland(hover) {
  const map = {};
  hover.forEach((h, idx) => {
    map[String(idx)] = { summary: h.summary, key: h.key };
  });
  let json = JSON.stringify(map);
  // <script> 内 JSON の安全化: </script> 等のタグ境界を破壊させない。
  json = json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return '<script type="application/json" class="mdr-hover-data">' + json + '</script>\n';
}

// ホバーローダ (body 末)。.hoverable に hover/focus/tap で要約カードを生成。
// 要約は textContent で投入 (innerHTML 禁止)。データ島 JSON を parse して参照。
// 実行時 fetch なし。byte 固定 = 決定論維持。
const HOVER_LOADER = `<script>
(function(){
  var island=document.querySelector('script.mdr-hover-data'); if(!island) return;
  var data={}; try{ data=JSON.parse(island.textContent||'{}'); }catch(e){ return; }
  var card=null;
  function hide(){ if(card){ card.parentNode&&card.parentNode.removeChild(card); card=null; } }
  function show(a){
    var k=a.getAttribute('data-hkey'); if(k===null) return;
    var rec=data[k]; if(!rec||!rec.summary) return;
    hide();
    card=document.createElement('div');
    card.className='mdr-hover-card';
    card.textContent=rec.summary;
    document.body.appendChild(card);
    var r=a.getBoundingClientRect();
    var top=r.bottom+window.scrollY+6, left=r.left+window.scrollX;
    var maxL=window.scrollX+document.documentElement.clientWidth-card.offsetWidth-8;
    if(left>maxL) left=Math.max(window.scrollX+8,maxL);
    card.style.top=top+'px'; card.style.left=left+'px';
  }
  var links=[].slice.call(document.querySelectorAll('a.hoverable'));
  links.forEach(function(a){
    a.addEventListener('mouseenter',function(){show(a);});
    a.addEventListener('mouseleave',hide);
    a.addEventListener('focus',function(){show(a);});
    a.addEventListener('blur',hide);
    a.addEventListener('click',function(ev){
      // タップ端末: 1 タップ目はプレビュー表示で遷移を抑止、表示中の再タップで遷移。
      if(!card){ ev.preventDefault(); show(a); }
    });
  });
  document.addEventListener('scroll',hide,true);
})();
</script>
`;

// ---------------------------------------------------------------------------
// コメント解決バッジ + CC 対応メモ (opt-in: frontmatter comments_resolved + commentsMode 時のみ注入)。
// 非宣言文書は CSS/JS/データ島いずれも注入されず byte 不変。
// 設計核 (hover と同型):
//   - バッジ可視ラベル「✓ 対応済み」は CSS 擬似要素 (::before content = <style> 内 = extractTextNodes 除外)。
//   - メモ本文は <script type="application/json"> データ島へ ('<' '>' '&' と U+2028/2029 を
//     エスケープし </script> breakout 防止)。extractTextNodes が <script> 除外 → HTML⊆MD 維持。
//   - メモは frontmatter 由来で body piece でないため MD⊆HTML 検査対象外。
//   - ローダは .cmt-memo に data-rk でデータ島から memo を textContent 投入 (innerHTML 禁止・実行時 fetch なし)。
//   - Day/Dark 両テーマでコントラスト確保のためテーマ変数 (--da/--da-soft 等) を使う。
// ---------------------------------------------------------------------------

const RESOLVED_CSS = `
.cmt-resolved{display:flex;align-items:flex-start;gap:.5em;margin:.5em 0 0;
  padding:.45em .7em;background:var(--da-soft);border:1px solid var(--da);border-radius:8px}
.cmt-resolved-badge{flex:0 0 auto;display:inline-block;font-weight:700;font-size:.78em;
  letter-spacing:.03em;padding:.12em .55em;border-radius:999px;background:var(--da);color:var(--bg);
  white-space:nowrap}
.cmt-resolved-badge::before{content:"\\2713 \\5BFE\\5FDC\\6E08\\307F"}
.cmt-memo{flex:1 1 auto;white-space:pre-wrap;font-size:.9em;color:var(--fg);line-height:1.55}
/* 元コメント (レビュアーの確定レビュー) の読取専用引用。編集 UI を持たず textContent 投入のみ。
   題ラベル「レビュアー (確定・編集不可)」は擬似要素 = テキストノード非生成 (HTML⊆MD 維持)。 */
.cmt-orig{margin:.5em 0 0;padding:.45em .7em .5em 1em;background:var(--accent-soft);
  border-left:3px solid var(--accent);border-radius:0 8px 8px 0;white-space:pre-wrap;
  font-size:.9em;color:var(--fg);line-height:1.55}
.cmt-orig::before{content:"\\30EC\\30D3\\30E5\\30A2\\30FC\\FF08\\78BA\\5B9A\\30FB\\7DE8\\96C6\\4E0D\\53EF\\FF09";
  display:block;font-weight:700;font-size:.74em;letter-spacing:.03em;color:var(--accent);
  margin-bottom:.25em;text-transform:uppercase}
/* 再コメント欄 (対応済みでも継続コメント可・集約コピー対象)。トグル/編集ラベルを差し替え。
   題ラベル「再コメント」は擬似要素 = テキストノード非生成。 */
.cmt-re{border-top:none;margin-top:.5em;padding-top:.2em}
.cmt-re::before{content:"\\518D\\30B3\\30E1\\30F3\\30C8";display:block;color:var(--muted);
  font-weight:600;font-size:.78em;letter-spacing:.03em;margin:.2em 0 .1em;text-transform:uppercase}
.cmt-re .cmt-toggle::before{content:"\\518D\\30B3\\30E1\\30F3\\30C8\\3092\\66F8\\304F"}
`;

// データ島生成: {index:{memo, orig}} の JSON。hoverDataIsland と同型の安全化 (</script> breakout 防止)。
//   memo = CC 対応メモ / orig = レビュアーの元コメント (読取専用埋込。2 部 entry では '')。
//   両者とも textContent 投入のため値自体の HTML 解釈は起きないが、データ島の早期終了を二重に防ぐ。
//   ローダは {memo, orig} オブジェクトを期待する (旧 {index:memoString} 形式も後方互換で処理)。
function resolvedDataIsland(memos) {
  const map = {};
  memos.forEach((rec, idx) => {
    // rec は { memo, orig }。防御的に欠損を空文字へ。
    const memo = rec && typeof rec.memo === 'string' ? rec.memo : '';
    const orig = rec && typeof rec.orig === 'string' ? rec.orig : '';
    map[String(idx)] = { memo, orig };
  });
  let json = JSON.stringify(map);
  json = json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return '<script type="application/json" class="mdr-resolved-data">' + json + '</script>\n';
}

// 解決メモ/元コメントローダ (body 末)。
//   .cmt-memo  ← データ島 rec.memo を textContent 投入 (CC 対応メモ)。
//   .cmt-orig  ← データ島 rec.orig を textContent 投入 (レビュアーの元コメント・読取専用)。
//   いずれも data-rk でデータ島の index を参照。後方互換: 値が文字列なら memo として扱う (旧形式)。
//   innerHTML 不使用・実行時 fetch なし = XSS 面なし。byte 固定 = 決定論維持。resolvedMode 時のみ注入。
const RESOLVED_LOADER = `<script>
(function(){
  var island=document.querySelector('script.mdr-resolved-data'); if(!island) return;
  var data={}; try{ data=JSON.parse(island.textContent||'{}'); }catch(e){ return; }
  function rec(k){ var v=data[k]; if(v==null) return null; if(typeof v==='string') return {memo:v,orig:''}; return v; }
  [].slice.call(document.querySelectorAll('.cmt-memo')).forEach(function(el){
    var k=el.getAttribute('data-rk'); if(k===null) return;
    var r=rec(k); if(!r||typeof r.memo!=='string') return;
    el.textContent=r.memo;
  });
  [].slice.call(document.querySelectorAll('.cmt-orig')).forEach(function(el){
    var k=el.getAttribute('data-rk'); if(k===null) return;
    var r=rec(k); if(!r||typeof r.orig!=='string') return;
    el.textContent=r.orig;
  });
})();
</script>
`;

// ---------------------------------------------------------------------------
// コメント機能 (016): 全て commentsMode 時のみ注入 (非コメント文書は byte 不変)。
// 設計核: 静的 HTML にコメント関連テキストノードを置かない (空コンテナ + CSS/aria ラベル + 空 textarea)
//         → verify (HTML⊆MD / MD⊆HTML) はテキストノード増分ゼロで不変。
// 永続は localStorage (HTML 本体外 = 決定論維持)。集約は固定整形 (LLM 不使用)。
// ---------------------------------------------------------------------------

const COMMENT_CSS = `
.topic{margin:0 0 1.4em}
.cmt{margin:.6em 0 0;border-top:1px dashed var(--line);padding-top:.6em}
.cmt-toggle{font:inherit;font-size:.84em;background:rgba(217,70,239,.10);border:1px solid #D946EF;color:#D946EF;
  border-radius:6px;padding:.35em .8em;cursor:pointer}
.cmt-toggle:hover{background:rgba(217,70,239,.22);border-color:#E879F5;color:#F0A6F5}
.cmt-toggle::before{content:"コメントを書く"}
.cmt[data-state="saved"] .cmt-toggle,.cmt[data-state="editing"] .cmt-toggle{display:none}
.cmt-edit{display:none}
.cmt[data-state="editing"] .cmt-edit{display:block}
.cmt-input{display:block;width:100%;min-height:4.5em;background:var(--code-bg);color:var(--fg);
  border:1px solid var(--line);border-radius:6px;padding:.5em;font:inherit;font-size:.9em;resize:vertical}
.cmt-actions{margin-top:.4em}
.cmt-save,.cmt-cancel,.cmt-editbtn{font:inherit;font-size:.82em;border:none;border-radius:6px;
  padding:.32em .8em;margin-right:.4em;cursor:pointer}
.cmt-save{background:#D946EF;color:#0F141E}
.cmt-save:hover{background:#E879F5}
.cmt-save::before{content:"保存"}
.cmt-cancel{background:var(--card);color:var(--muted);border:1px solid var(--line)}
.cmt-cancel::before{content:"キャンセル"}
.cmt-card{display:none;background:var(--decision-soft);border:1px solid var(--decision);
  border-radius:8px;padding:.55em .8em;margin-top:.4em}
.cmt[data-state="saved"] .cmt-card{display:block}
.cmt-display{white-space:pre-wrap;font-size:.92em}
.cmt-editbtn{background:none;color:#D946EF;padding:.25em 0;margin-top:.35em}
.cmt-editbtn:hover{color:#F0A6F5}
.cmt-editbtn::before{content:"編集"}
.reply-gen{margin:30px 0 0;padding:16px 0 0;border-top:2px solid var(--accent)}
.cmt-progress{color:var(--muted);font-size:.82em;margin-bottom:.6em}
.cmt-progress::before{content:"コメント " attr(data-n) " / " attr(data-total) " トピック"}
.reply-gen-btn{font:inherit;font-size:.9em;background:rgba(217,70,239,.10);border:1px solid #D946EF;color:#D946EF;
  border-radius:8px;padding:.55em 1.1em;cursor:pointer}
.reply-gen-btn:hover{background:rgba(217,70,239,.22);border-color:#E879F5;color:#F0A6F5}
.cmt-toggle:focus-visible,.cmt-save:focus-visible,.cmt-editbtn:focus-visible,.reply-gen-btn:focus-visible{outline:2px solid #F0A6F5;outline-offset:2px}
.reply-gen-btn::before{content:"返信プロンプト生成"}
/* 生成=即コピー (1クリック)。完了/失敗フィードバックは生成ボタンに転用 (緑=成功 / warn=fallback) */
.reply-gen[data-copied="1"] .reply-gen-btn{background:var(--da-soft);border-color:var(--da);color:var(--da)}
.reply-gen[data-copied="1"] .reply-gen-btn::before{content:"コピーしました"}
.reply-gen[data-copied="0"] .reply-gen-btn{background:var(--warn-soft);border-color:var(--warn);color:var(--warn)}
.reply-gen[data-copied="0"] .reply-gen-btn::before{content:"Ctrl+C でコピー"}
.reply-out{display:none;width:100%;min-height:8em;margin:.8em 0;background:var(--code-bg);color:var(--fg);
  border:1px solid var(--line);border-radius:6px;padding:.6em;
  font-family:"Cascadia Code","Consolas",monospace;font-size:.85em;white-space:pre;resize:vertical}
.reply-gen[data-generated="1"] .reply-out{display:block}
`;

// 返信プロンプト生成セクション (静的・テキストノードなし。ラベルは CSS、textarea は空)。
const REPLY_GEN_HTML =
  '<section class="reply-gen" data-generated="0">' +
  '<div class="cmt-progress" data-n="0" data-total="0"></div>' +
  '<button class="reply-gen-btn" type="button" aria-label="返信プロンプト生成しコピー"></button>' +
  '<textarea class="reply-out" readonly aria-label="返信プロンプト"></textarea>' +
  '</section>';

// localStorage 永続 (byte 固定 JS)。innerHTML 不使用、textContent/value/classList/setAttribute/localStorage のみ。
const COMMENT_LOADER = `<script>
(function(){
  var rid=document.documentElement.getAttribute('data-report-id'); if(!rid) return;
  function key(sid){return 'ccpit-cmt:'+rid+':'+sid;}
  function load(sid){ try{return JSON.parse(localStorage.getItem(key(sid))||'null');}catch(e){return null;} }
  var cmts=[].slice.call(document.querySelectorAll('.cmt'));
  function progress(){
    var n=0; cmts.forEach(function(c){ if(c.getAttribute('data-state')==='saved') n++; });
    var p=document.querySelector('.cmt-progress');
    if(p){ p.setAttribute('data-n',String(n)); p.setAttribute('data-total',String(cmts.length)); }
  }
  cmts.forEach(function(c){
    var sid=c.getAttribute('data-section');
    var ta=c.querySelector('.cmt-input');
    var disp=c.querySelector('.cmt-display');
    var saved=load(sid);
    function show(){
      if(saved&&saved.text){ disp.textContent=saved.text; c.setAttribute('data-state','saved'); }
      else { c.setAttribute('data-state','empty'); }
    }
    function edit(){ ta.value=(saved&&saved.text)||''; c.setAttribute('data-state','editing'); ta.focus(); }
    c.querySelector('.cmt-toggle').addEventListener('click',edit);
    c.querySelector('.cmt-editbtn').addEventListener('click',edit);
    c.querySelector('.cmt-cancel').addEventListener('click',show);
    c.querySelector('.cmt-save').addEventListener('click',function(){
      var v=ta.value.trim(); if(!v){ return; }
      saved={text:v,at:Date.now()};
      try{ localStorage.setItem(key(sid),JSON.stringify(saved)); }catch(e){}
      show(); progress();
    });
    show();
  });
  progress();
})();
</script>
`;

// 返信プロンプト集約 + ワンクリックコピー (固定整形・LLM 不使用)。clipboard 失敗時 execCommand フォールバック。
const REPLY_GEN = `<script>
(function(){
  var sec=document.querySelector('.reply-gen'); if(!sec) return;
  var btn=sec.querySelector('.reply-gen-btn'), out=sec.querySelector('.reply-out');
  var rid=document.documentElement.getAttribute('data-report-id')||'';
  function load(sid){ try{return JSON.parse(localStorage.getItem('ccpit-cmt:'+rid+':'+sid)||'null');}catch(e){return null;} }
  function excerpt(box){
    var t='', ps=box.querySelectorAll('p,li');
    for(var i=0;i<ps.length;i++){ t+=(t?' ':'')+ps[i].textContent.trim(); if(t.length>=400) break; }
    return t.slice(0,400);
  }
  function feedback(ok){ sec.setAttribute('data-copied',ok?'1':'0'); setTimeout(function(){ sec.removeAttribute('data-copied'); },1800); }
  function legacyCopy(){ var ok=false; try{ out.focus(); out.select(); ok=document.execCommand('copy'); }catch(e){} return ok; }
  btn.addEventListener('click',function(){
    var parts=[], n=0;
    [].slice.call(document.querySelectorAll('.cmt')).forEach(function(c){
      var sid=c.getAttribute('data-section'), s=load(sid);
      if(!(s&&s.text)) return;
      n++;
      var box=c.closest('.tab-panel,.topic')||c.parentNode;
      var h=box.querySelector('h2,h3,h4'), heading=h?h.textContent.trim():(c.getAttribute('data-label')||'（見出し不明）');
      parts.push('### '+heading+'\\n（本文抜粋）'+excerpt(box)+'\\nコメント: '+s.text);
    });
    var head='## CCPIT 報告書コメント返信タスク（'+n+'件）\\n報告書: '+rid+'\\n\\n';
    out.value = n ? head+parts.join('\\n\\n') : head+'（コメントなし）';
    sec.setAttribute('data-generated','1');
    // 生成=即コピー (1クリック)。clipboard 成功→緑、失敗(file:// 等)→execCommand フォールバック
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(out.value).then(function(){feedback(true);},function(){feedback(legacyCopy());});
    } else { feedback(legacyCopy()); }
  });
})();
</script>
`;

// 返信プロンプト集約 (atomic 版): comments: atomic 時のみ使用。
//   各 .cmt の data-section (= その Composer が属する見出しの id "sec-...") から見出し要素を逆引きし、
//   見出しテキストと「その見出し直下の本文だけ」を抜粋する。H2 Composer なら H2 見出し + H2 直下本文
//   (次の H3 までの lead)、H3 Composer なら H3 見出し + H3 本文。これにより H3 単位の Atomic な
//   コメントが、集約段でも正しいトピック名・本文範囲で拾われる。
//   見出し本文の範囲は DOM 兄弟走査: 見出し要素から次の h2/h3/h4 (= 同位/上位見出し) の直前までの
//   p,li を集める (renderBlocks は見出し・本文・.cmt を flat な兄弟として出力するため、この走査で
//   その見出しのサブセクションだけが切り出せる。.cmt 自体は p,li でないため抜粋に混ざらない)。
//   非 atomic の REPLY_GEN とは別 const = 既存コメント文書 (comments-on 等) の出力は byte 不変。
const REPLY_GEN_ATOMIC = `<script>
(function(){
  var sec=document.querySelector('.reply-gen'); if(!sec) return;
  var btn=sec.querySelector('.reply-gen-btn'), out=sec.querySelector('.reply-out');
  var rid=document.documentElement.getAttribute('data-report-id')||'';
  function load(sid){ try{return JSON.parse(localStorage.getItem('ccpit-cmt:'+rid+':'+sid)||'null');}catch(e){return null;} }
  function hLevel(el){ var m=el&&el.tagName&&el.tagName.match(/^H([2-6])$/); return m?+m[1]:0; }
  // 見出し id → 見出し要素 の逆引き表 (本文中の id 付き見出しのみ)。
  var hmap={};
  [].slice.call(document.querySelectorAll('h2[id],h3[id],h4[id]')).forEach(function(h){ hmap[h.id]=h; });
  // 見出し要素から、その見出し直下のサブセクション本文を抜粋する。
  //   抜粋範囲は renderBodyInner / splitByH3 のサブセクション分割と一致させる:
  //   H2 末 Composer は H2 lead (最初の H3 の直前まで)、H3 Composer は H3 本文
  //   (次の H3 か H2 の直前まで。H3 配下の H4 は H3 サブセクションに内包する)。
  //   よって停止する見出しレベルは max(3, 当該見出しレベル):
  //     H2/H3 一致 → レベル<=3 (h2/h3) の見出しで停止 (h4 では停止せず H4 本文を含める)。
  //     H4 一致 (フォールバック経路のみ) → レベル<=4 で停止。
  function excerptOf(h){
    var stop=Math.max(3, hLevel(h));
    var t='', n=h.nextElementSibling;
    while(n){
      var lv=hLevel(n);
      if(lv>0 && lv<=stop) break; // 同位/上位見出し境界で停止
      if(n.matches&&n.matches('p,li')){ if(n.textContent){ t+=(t?' ':'')+n.textContent.trim(); } }
      var qs=n.querySelectorAll?n.querySelectorAll('p,li'):[];
      for(var i=0;i<qs.length;i++){ t+=(t?' ':'')+qs[i].textContent.trim(); if(t.length>=400) break; }
      if(t.length>=400) break;
      n=n.nextElementSibling;
    }
    return t.slice(0,400);
  }
  // 逆引き不能時のフォールバック (従来挙動): topic/panel 内の最初の見出しと全本文。
  function fallbackHeading(c){ var box=c.closest('.tab-panel,.topic')||c.parentNode; var h=box.querySelector('h2,h3,h4'); return h?h.textContent.trim():null; }
  function fallbackExcerpt(c){ var box=c.closest('.tab-panel,.topic')||c.parentNode; var t='',ps=box.querySelectorAll('p,li'); for(var i=0;i<ps.length;i++){ t+=(t?' ':'')+ps[i].textContent.trim(); if(t.length>=400) break; } return t.slice(0,400); }
  function feedback(ok){ sec.setAttribute('data-copied',ok?'1':'0'); setTimeout(function(){ sec.removeAttribute('data-copied'); },1800); }
  function legacyCopy(){ var ok=false; try{ out.focus(); out.select(); ok=document.execCommand('copy'); }catch(e){} return ok; }
  btn.addEventListener('click',function(){
    var parts=[], n=0;
    [].slice.call(document.querySelectorAll('.cmt')).forEach(function(c){
      var sid=c.getAttribute('data-section'), s=load(sid);
      if(!(s&&s.text)) return;
      n++;
      var h=hmap[sid];
      var heading=h?h.textContent.trim():(fallbackHeading(c)||c.getAttribute('data-label')||'（見出し不明）');
      var ex=h?excerptOf(h):fallbackExcerpt(c);
      parts.push('### '+heading+'\\n（本文抜粋）'+ex+'\\nコメント: '+s.text);
    });
    var head='## CCPIT 報告書コメント返信タスク（'+n+'件）\\n報告書: '+rid+'\\n\\n';
    out.value = n ? head+parts.join('\\n\\n') : head+'（コメントなし）';
    sec.setAttribute('data-generated','1');
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(out.value).then(function(){feedback(true);},function(){feedback(legacyCopy());});
    } else { feedback(legacyCopy()); }
  });
})();
</script>
`;

// ---------------------------------------------------------------------------
// resolvedMode 専用ローダ群 (resolvedMode 時のみ注入。非 resolved 文書には一切出ない = byte 不変)。
//   既存 COMMENT_LOADER / REPLY_GEN / REPLY_GEN_ATOMIC は 1 byte も変えず、
//   resolvedMode の時だけ下記の別 const に差し替える (REPLY_GEN_ATOMIC の二変種化と同型の gating)。
// ---------------------------------------------------------------------------

// コメントローダ (resolved 版)。COMMENT_LOADER と同一だが、読取専用埋込の基底 .cmt
//   (data-readonly="1") を配線対象から除外する。読取専用 .cmt は編集 UI 要素 (.cmt-toggle 等) を
//   持たないため、素の COMMENT_LOADER だと querySelector(null).addEventListener で例外になる。
//   除外により progress の total も実際に編集可能な Composer (通常 + 再コメント) 数になる。
const COMMENT_LOADER_RESOLVED = `<script>
(function(){
  var rid=document.documentElement.getAttribute('data-report-id'); if(!rid) return;
  function key(sid){return 'ccpit-cmt:'+rid+':'+sid;}
  function load(sid){ try{return JSON.parse(localStorage.getItem(key(sid))||'null');}catch(e){return null;} }
  var cmts=[].slice.call(document.querySelectorAll('.cmt')).filter(function(c){ return c.getAttribute('data-readonly')!=='1'; });
  function progress(){
    var n=0; cmts.forEach(function(c){ if(c.getAttribute('data-state')==='saved') n++; });
    var p=document.querySelector('.cmt-progress');
    if(p){ p.setAttribute('data-n',String(n)); p.setAttribute('data-total',String(cmts.length)); }
  }
  cmts.forEach(function(c){
    var sid=c.getAttribute('data-section');
    var ta=c.querySelector('.cmt-input');
    var disp=c.querySelector('.cmt-display');
    var saved=load(sid);
    function show(){
      if(saved&&saved.text){ disp.textContent=saved.text; c.setAttribute('data-state','saved'); }
      else { c.setAttribute('data-state','empty'); }
    }
    function edit(){ ta.value=(saved&&saved.text)||''; c.setAttribute('data-state','editing'); ta.focus(); }
    c.querySelector('.cmt-toggle').addEventListener('click',edit);
    c.querySelector('.cmt-editbtn').addEventListener('click',edit);
    c.querySelector('.cmt-cancel').addEventListener('click',show);
    c.querySelector('.cmt-save').addEventListener('click',function(){
      var v=ta.value.trim(); if(!v){ return; }
      saved={text:v,at:Date.now()};
      try{ localStorage.setItem(key(sid),JSON.stringify(saved)); }catch(e){}
      show(); progress();
    });
    show();
  });
  progress();
})();
</script>
`;

// 返信プロンプト集約 (resolved・非 atomic 版)。REPLY_GEN と同一だが、対応済み (元コメント有り) の
//   基底見出し id 集合を data-resolved-sections から読み、その基底 id の .cmt を集約からスキップする。
//   → レビュアーの確定コメント (読取専用埋込) は集約コピーに二度と乗らない (冗長 + 改変リスク回避)。
//   再コメント (<sid>:re) は基底 id と異なるためスキップされず集約に入る (継続コメントは届く)。
const REPLY_GEN_RESOLVED = `<script>
(function(){
  var sec=document.querySelector('.reply-gen'); if(!sec) return;
  var btn=sec.querySelector('.reply-gen-btn'), out=sec.querySelector('.reply-out');
  var rid=document.documentElement.getAttribute('data-report-id')||'';
  var skip=(document.documentElement.getAttribute('data-resolved-sections')||'').split(' ').filter(Boolean);
  function load(sid){ try{return JSON.parse(localStorage.getItem('ccpit-cmt:'+rid+':'+sid)||'null');}catch(e){return null;} }
  function excerpt(box){
    var t='', ps=box.querySelectorAll('p,li');
    for(var i=0;i<ps.length;i++){ t+=(t?' ':'')+ps[i].textContent.trim(); if(t.length>=400) break; }
    return t.slice(0,400);
  }
  function feedback(ok){ sec.setAttribute('data-copied',ok?'1':'0'); setTimeout(function(){ sec.removeAttribute('data-copied'); },1800); }
  function legacyCopy(){ var ok=false; try{ out.focus(); out.select(); ok=document.execCommand('copy'); }catch(e){} return ok; }
  btn.addEventListener('click',function(){
    var parts=[], n=0;
    [].slice.call(document.querySelectorAll('.cmt')).forEach(function(c){
      var sid=c.getAttribute('data-section');
      if(skip.indexOf(sid)>=0) return; // 対応済み (元コメント) 基底 id は集約から除外
      var s=load(sid);
      if(!(s&&s.text)) return;
      n++;
      var box=c.closest('.tab-panel,.topic')||c.parentNode;
      var h=box.querySelector('h2,h3,h4'), heading=h?h.textContent.trim():(c.getAttribute('data-label')||'（見出し不明）');
      parts.push('### '+heading+'\\n（本文抜粋）'+excerpt(box)+'\\nコメント: '+s.text);
    });
    var head='## CCPIT 報告書コメント返信タスク（'+n+'件）\\n報告書: '+rid+'\\n\\n';
    out.value = n ? head+parts.join('\\n\\n') : head+'（コメントなし）';
    sec.setAttribute('data-generated','1');
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(out.value).then(function(){feedback(true);},function(){feedback(legacyCopy());});
    } else { feedback(legacyCopy()); }
  });
})();
</script>
`;

// 返信プロンプト集約 (resolved・atomic 版)。REPLY_GEN_ATOMIC と同一だが、対応済み基底 id を
//   data-resolved-sections から読みスキップする (REPLY_GEN_RESOLVED と同じ除外規律)。
//   再コメント (<sid>:re) は hmap に無いため fallbackHeading で正しい H2/H3 トピック名に解決される。
const REPLY_GEN_ATOMIC_RESOLVED = `<script>
(function(){
  var sec=document.querySelector('.reply-gen'); if(!sec) return;
  var btn=sec.querySelector('.reply-gen-btn'), out=sec.querySelector('.reply-out');
  var rid=document.documentElement.getAttribute('data-report-id')||'';
  var skip=(document.documentElement.getAttribute('data-resolved-sections')||'').split(' ').filter(Boolean);
  function load(sid){ try{return JSON.parse(localStorage.getItem('ccpit-cmt:'+rid+':'+sid)||'null');}catch(e){return null;} }
  function hLevel(el){ var m=el&&el.tagName&&el.tagName.match(/^H([2-6])$/); return m?+m[1]:0; }
  var hmap={};
  [].slice.call(document.querySelectorAll('h2[id],h3[id],h4[id]')).forEach(function(h){ hmap[h.id]=h; });
  function excerptOf(h){
    var stop=Math.max(3, hLevel(h));
    var t='', n=h.nextElementSibling;
    while(n){
      var lv=hLevel(n);
      if(lv>0 && lv<=stop) break;
      if(n.matches&&n.matches('p,li')){ if(n.textContent){ t+=(t?' ':'')+n.textContent.trim(); } }
      var qs=n.querySelectorAll?n.querySelectorAll('p,li'):[];
      for(var i=0;i<qs.length;i++){ t+=(t?' ':'')+qs[i].textContent.trim(); if(t.length>=400) break; }
      if(t.length>=400) break;
      n=n.nextElementSibling;
    }
    return t.slice(0,400);
  }
  function fallbackHeading(c){ var box=c.closest('.tab-panel,.topic')||c.parentNode; var h=box.querySelector('h2,h3,h4'); return h?h.textContent.trim():null; }
  function fallbackExcerpt(c){ var box=c.closest('.tab-panel,.topic')||c.parentNode; var t='',ps=box.querySelectorAll('p,li'); for(var i=0;i<ps.length;i++){ t+=(t?' ':'')+ps[i].textContent.trim(); if(t.length>=400) break; } return t.slice(0,400); }
  function feedback(ok){ sec.setAttribute('data-copied',ok?'1':'0'); setTimeout(function(){ sec.removeAttribute('data-copied'); },1800); }
  function legacyCopy(){ var ok=false; try{ out.focus(); out.select(); ok=document.execCommand('copy'); }catch(e){} return ok; }
  btn.addEventListener('click',function(){
    var parts=[], n=0;
    [].slice.call(document.querySelectorAll('.cmt')).forEach(function(c){
      var sid=c.getAttribute('data-section');
      if(skip.indexOf(sid)>=0) return; // 対応済み基底 id は集約から除外 (除外判定は exact sid)
      var s=load(sid);
      if(!(s&&s.text)) return;
      n++;
      // 再コメント (<baseSid>:re) は hmap に無いため、基底 id へ正規化して H3 見出し/抜粋を引く。
      //   こうしないと closest('.topic') が最外 H2 を掴み、H3 再コメントが誤った H2 トピック名で
      //   集約される (Codex MAJOR 指摘: atomic 集約の取り違え穴の再発防止)。
      var baseSid=sid.replace(/:re$/,'');
      var h=hmap[sid]||hmap[baseSid];
      var heading=h?h.textContent.trim():(fallbackHeading(c)||c.getAttribute('data-label')||'（見出し不明）');
      var ex=h?excerptOf(h):fallbackExcerpt(c);
      parts.push('### '+heading+'\\n（本文抜粋）'+ex+'\\nコメント: '+s.text);
    });
    var head='## CCPIT 報告書コメント返信タスク（'+n+'件）\\n報告書: '+rid+'\\n\\n';
    out.value = n ? head+parts.join('\\n\\n') : head+'（コメントなし）';
    sec.setAttribute('data-generated','1');
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(out.value).then(function(){feedback(true);},function(){feedback(legacyCopy());});
    } else { feedback(legacyCopy()); }
  });
})();
</script>
`;

// ---------------------------------------------------------------------------
// --verify: HTML ⊆ MD テキストノード包含検証
// ---------------------------------------------------------------------------

function extractTextNodes(html) {
  // <script> と <style> はここで全除外する。これらにはレンダラ制御データと装飾のみを置く
  // (mermaid/タブ/コメント/テーマ/ホバーのローダ、ホバー要約データ島 JSON、CSS 擬似要素ラベル等)。
  // 本文由来の可視テキストをここに置いてはならない。置けば verify (HTML⊆MD / MD⊆HTML) の
  // 被覆検証をすり抜け、捏造・欠落の検出網に穴が空く。
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  // タグを区切り文字へ (隣接テキストノードの癒着を防ぐ)
  s = s.replace(/<[^>]+>/g, '\n');
  s = decodeEntities(s);
  return s
    .split('\n')
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// 統一正規化 canon: MD ソーステキストと HTML 描画テキストを比較可能にする。
// マーカー (renderInline が消費する ** ` / tokenize が剥がす # > | / リンク url / [!TYPE])
// と「全空白」を両側から除去し、内容文字のみ残す。
//  - インライン要素境界 (<strong>/<code>/<a>) が HTML テキストノードを分割して挿入する
//    空白を、全空白除去で吸収 (誰が読む: ⇔ 誰が読む :  の不一致を解消)。
//  - リテラル | や 対なし ** が内容に出ても、両側で同じく除去するため誤検出しない
//    ("Edit|Write" ⇔ buildCorpus が | を空白化して不一致、という M1 の穴を塞ぐ)。
function canon(s) {
  return decodeEntities(s)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // リンク [t](u) → t (url は href 属性=非テキストノード)
    .replace(/\[!([A-Za-z]+)\]/g, '') // admonition マーカー
    .replace(/[*`|>#]/g, '') // renderInline 消費マーカー + 構造記号
    .replace(/\s+/g, '') // 全空白除去 (インライン境界の分割空白を吸収)
    .trim();
}

// verify 系の描画。展開に失敗した include は throw せず空の本文で描き、失敗は verifyCites が報告する。
function renderLenient(md, srcFileName) {
  const prev = _citeLenient;
  _citeLenient = true;
  try {
    return render(md, srcFileName);
  } finally {
    _citeLenient = prev;
  }
}

// include= が成功した範囲の行 (HTML⊆MD のコーパスに足す)。include が無い文書は ''。
function citeIncludedText(md) {
  const { body } = parseFrontmatter(md);
  const parts = [];
  walkFences(tokenize(body), (b) => {
    if (b.cite && b.cite.kind === 'include' && b.citeResult && b.citeResult.ok) parts.push(b.citeResult.lines.join('\n'));
  });
  return parts.join('\n');
}

// 後方互換エイリアス (export 済み)。corpus = 全 MD を canon 正規化した文字列。
function buildCorpus(md) {
  return canon(md);
}

// verify 系が render へ渡すダミーファイル名。H1 も doc_id も無い MD では render の
// title フォールバックがこの名前を <title> 等のテキストノードへ注入するため、
// 検証から除外できるよう衝突しない固有トークンにする (2026-08-11 自己汚染誤報の修正)。
const VERIFY_SENTINEL = 'verify-sentinel-x7q4z9.md';

// 直前の連続バックスラッシュが奇数個の '\|' から、エスケープの 1 本を除く ('\\|' のような偶数個は触らない)。splitTableRow と同じ規則。
function unescapeTablePipes(s) {
  return s.replace(/(?<!\\)((?:\\\\)*)\\\|/g, '$1|');
}

// HTML ⊆ MD (捏造防止): 各 HTML テキストノードが MD コーパスに含まれるか
function verify(md) {
  const html = renderLenient(md, VERIFY_SENTINEL);
  // include= で展開した実物の行は「宣言された実物由来の MD 相当」としてコーパスに足す (cite= の本文は MD にあるので足さない)。
  // 表のセルの '\|' は描画で '|' に戻る (GFM)。HTML のセル文字は MD の '\|' の書き方から導けるので、'\|' を戻した写しもコーパスに足す
  // (足すだけ = 従来合格した文書は引き続き合格する)。canon 自体は変えない (見出し id の sha1 が canon を使うため)。
  const corpus = canon(md + '\n' + citeIncludedText(md) + '\n' + unescapeTablePipes(md));
  const sentinel = canon(VERIFY_SENTINEL);
  const nodesRaw = extractTextNodes(html);
  const violations = [];
  for (const node of nodesRaw) {
    const c = canon(node);
    if (c.includes(sentinel)) continue; // レンダラ注入 (title fallback) は MD 由来でない
    if (c && !corpus.includes(c)) {
      violations.push(node);
    }
  }
  return { ok: violations.length === 0, violations, total: nodesRaw.length };
}

// ---------------------------------------------------------------------------
// 完全性検証 (MD ⊆ HTML): MD 本文の各描画ブロック片が HTML に被覆されているか。
// silent omission (preamble バグ級の欠落) を検出。HTML⊆MD の鏡像。
//
// 正規化注意 (005 追加1):
//  - frontmatter は body 抽出で除外 (非描画メタ)
//  - マーカー記号 (# > | ** ` [!TYPE] リンク url) は除去 (描画されない)
//  - フェンス言語識別子は info string 行を片に含めない
//  - 図ブロック (mermaid/svg) は片に含めない (図中テキストは被覆検証から除外)
// ---------------------------------------------------------------------------

// 完全性検証も同じ canon を使う (両方向対称)。エイリアスを残す。
function normForMatch(s) {
  return canon(s);
}

// MD ブロック列から「描画されるテキスト片」を抽出 (図ブロックは除外)
function collectPieces(blocks) {
  const pieces = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
        pieces.push(b.text);
        break;
      case 'paragraph':
        pieces.push(b.lines.join(' '));
        break;
      case 'list':
        for (const it of b.items) pieces.push(it.text);
        break;
      case 'table':
        for (const cell of b.header) pieces.push(cell);
        for (const row of b.rows) for (const cell of row) pieces.push(cell);
        break;
      case 'fence':
        // 図ブロック (mermaid/svg) は完全性検証から除外。通常コードは内容として含める
        if (!['mermaid', 'svg'].includes((b.cite ? stripCiteAttrs(b.info) : b.info || '').toLowerCase())) {
          pieces.push(b.content.join(' '));
        }
        break;
      case 'admonition':
        if (b.title) pieces.push(b.title);
        if (b.content && b.content.join('').trim()) {
          pieces.push(...collectPieces(tokenize(b.content.join('\n'))));
        }
        break;
      case 'blockquote':
        pieces.push(...collectPieces(tokenize(b.content.join('\n'))));
        break;
      default:
        break;
    }
  }
  return pieces;
}

function verifyCompleteness(md) {
  const html = renderLenient(md, VERIFY_SENTINEL);
  const { fm: vfm, body } = parseFrontmatter(md);
  setTasksFromFm(vfm); // render と同じ規則で片を切る (チェック欄の印を外すかどうか)
  const blocks = tokenize(body);
  // HTML 側コーパス (全テキストノードを canon 連結。センチネル注入ノードは対称に除外)
  const sentinel = canon(VERIFY_SENTINEL);
  const htmlCorpus = canon(
    extractTextNodes(html)
      .filter((n) => !canon(n).includes(sentinel))
      .join('\n')
  );
  // MD 側ブロック片 (canon 正規化)
  const pieces = collectPieces(blocks)
    .map(canon)
    .filter((p) => p.length > 0);
  const omissions = [];
  for (const p of pieces) {
    if (!htmlCorpus.includes(p)) omissions.push(p);
  }
  return { ok: omissions.length === 0, omissions, total: pieces.length };
}

// 双方向検証 (HTML⊆MD 捏造防止 + MD⊆HTML 欠落防止)
function verifyBidirectional(md) {
  const fwd = verify(md); // HTML ⊆ MD
  const bwd = verifyCompleteness(md); // MD ⊆ HTML
  return { ok: fwd.ok && bwd.ok, fwd, bwd };
}

// ---------------------------------------------------------------------------
// --lint: 報告書型 frontmatter の必須マーカー欠落を警告 (exit 0)
//         + figures 宣言-実体一致の機械判定 (違反は errors → exit 1)。
//         意味判定 (図が必要か) は diagram-craft skill 側に置き lint はしない。
//         移行措置 (grandfather): 本検査は改定後の新規報告書にのみ実行する運用。
//         既存報告書への遡及 lint・一括 lint 適用は禁止 (report skill 規約)。
// ---------------------------------------------------------------------------

// frontmatter 生スキャン (lint 専用): hover: ブロックの宣言有無と壊れた子行を抽出する。
// parseFrontmatter は壊れた行を捕捉しない (出力 byte 不変が最優先) ため、警告用に別途走査する。
function lintFrontmatterRaw(md) {
  const res = {
    hoverDeclared: false, brokenHoverLines: [],
    resolvedDeclared: false, brokenResolvedLines: [],
    figBrokenLines: [], // figure_links: ブロック形の誤用 (読めない子行)。空値・スカラ・インライン形は数えない
    outputsBrokenLines: [], // outputs: ブロックの読めない子行
    outputsScalar: false, // outputs: に値が空でない形 (1 行・リスト形) を書いた = 宣言とみなされない
  };
  if (!md.startsWith('---\n') && !md.startsWith('---\r\n')) return res;
  const lines = md.split(/\r?\n/);
  let fmEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { fmEnd = i; break; }
  }
  if (fmEnd === -1) return res;
  for (let i = 1; i < fmEnd; i++) {
    const m = lines[i].match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (m && m[1] === 'hover' && m[2].trim() === '') {
      res.hoverDeclared = true;
      let j = i + 1;
      while (j < fmEnd && /^\s+\S/.test(lines[j])) {
        const im = lines[j].match(/^\s+-\s+(.*)$/);
        if (!im) {
          res.brokenHoverLines.push(lines[j]);
        } else if (im[1].indexOf('||') === -1) {
          res.brokenHoverLines.push(lines[j]);
        }
        j++;
      }
      i = j - 1;
    } else if (m && m[1] === 'comments_resolved' && m[2].trim() === '') {
      // hover と同型: 子行のうち "- 見出し || メモ" 形式でない行を壊れた行として記録。
      res.resolvedDeclared = true;
      let j = i + 1;
      while (j < fmEnd && /^\s+\S/.test(lines[j])) {
        const im = lines[j].match(/^\s+-\s+(.*)$/);
        if (!im) {
          res.brokenResolvedLines.push(lines[j]);
        } else if (im[1].indexOf('||') === -1) {
          res.brokenResolvedLines.push(lines[j]);
        }
        j++;
      }
      i = j - 1;
    } else if (m && m[1] === 'figure_links' && m[2].trim() === '') {
      // 値が空でインデントされた子行がある (= ブロック形の宣言の意図) のに、読めない行がある場合だけ記録する。
      // コメント行 (# で始まる) は数えない。空値・スカラ・インライン形は子行が無い / この分岐に入らず無警告。
      let j = i + 1;
      while (j < fmEnd && /^\s+\S/.test(lines[j])) {
        if (!/^\s+#/.test(lines[j])) {
          const im = lines[j].match(/^\s+-\s+(.*)$/);
          if (!im || !parseFigLinkLine(im[1])) res.figBrokenLines.push(lines[j]);
        }
        j++;
      }
      i = j - 1;
    } else if (m && m[1] === 'outputs') {
      if (m[2].trim() !== '') {
        res.outputsScalar = true;
      } else {
        let j = i + 1;
        while (j < fmEnd && /^\s+\S/.test(lines[j])) {
          if (!/^\s+#/.test(lines[j])) {
            const im = lines[j].match(/^\s+-\s+(.*)$/);
            if (!im || !parseOutputLine(im[1])) res.outputsBrokenLines.push(lines[j]);
          }
          j++;
        }
        i = j - 1;
      }
    }
  }
  return res;
}

// da_scale の値の検査 (theme の流儀): 未知の値は無視されるので警告する。宣言の無い文書は無警告。
function lintDaScale(fm, warnings) {
  if (fm && fm.da_scale !== undefined && fm.da_scale !== 'table') {
    warnings.push('未知の da_scale 値: frontmatter "da_scale:" は "table" のみ許容されます (未宣言は列ごとの尺度)');
  }
}

// checkboxes の検査 (da_scale・theme の流儀): on 以外の値は無効 = チェック欄は描かれず "[ ]" が文字のまま残るので警告する。
//   on を宣言したのに有効なチェック項目 (リスト項目の先頭 "[ ] " / "[x] ") が 1 件も無い場合も警告する。
//   引用 (>) と注記ブロックの中の項目も render と同じく数える。宣言の無い文書は無警告 = 従来どおり。
function hasTaskItem(blocks) {
  return blocks.some((b) => {
    if (b.type === 'list') return b.items.some((it) => it.task);
    if ((b.type === 'blockquote' || b.type === 'admonition') && Array.isArray(b.content)) {
      return hasTaskItem(tokenize(b.content.join('\n')));
    }
    return false;
  });
}
function lintCheckboxes(fm, blocks, warnings) {
  if (!fm || fm.checkboxes === undefined) return;
  if (fm.checkboxes !== 'on') {
    warnings.push('未知の checkboxes 値: "' + fm.checkboxes + '" (対応値は on のみ。チェック欄は描かれず、"[ ]" は文字のまま残る)');
    return;
  }
  if (!hasTaskItem(blocks)) {
    warnings.push('checkboxes: on の宣言があるが有効なチェック項目が 1 件も無い ("- [ ] 文" / "- [x] 文" の形のリスト項目。チェック欄は描かれない)');
  }
}

// 表の検査 (報告書型かどうかに依らず全文書)。tokenize が表と読んだブロックについて、
//   ヘッダの列数と各データ行のセル数、区切り行の列数を比べ、食い違いを warning にする (列数のそろった表は無警告)。
//   位置は MD の行番号 (frontmatter の行数を足す)。引用・注記の中の表も、引用の先頭行からの行の対応 (引用の各行は
//   元の 1 行に 1:1 で対応する) を足して、元の MD の行番号で出す。
//   セルが多い行 = 確実な崩れ (セルの中の '|' が割れた等)。少ない行 = 末尾の空セルの省略かもしれないが崩れの可能性もある。
//   表として採用されない候補 (区切り行が無い等) は対象外。リストの項目の下に字下げして書いた表は、描画と同じく
//   トップレベルの表として読まれるので対象に入る。
// base: blocks の先頭行が、本文 (frontmatter を除く) の何行目 (0 始まり) にあたるか。
function collectTablesForLint(blocks, out, heading, nested, base) {
  blocks.forEach((b) => {
    if (b.type === 'heading') heading.text = b.text;
    else if (b.type === 'table') out.push({ block: b, heading: heading.text, nested, bodyLine: base + b.line });
    else if ((b.type === 'blockquote' || b.type === 'admonition') && Array.isArray(b.content)) {
      // admonition の content は先頭の "[!TYPE]" の行を除いた残りなので、その 1 行ぶん下がる
      const childBase = base + b.line + (b.type === 'admonition' ? 1 : 0);
      collectTablesForLint(tokenize(b.content.join('\n')), out, heading, true, childBase);
    }
  });
}

function lintTables(md, body, blocks, warnings) {
  const found = [];
  collectTablesForLint(blocks, found, { text: '' }, false, 0);
  if (!found.length) return;
  const offset = md.split(/\r?\n/).length - body.split(/\r?\n/).length;
  found.forEach((t, idx) => {
    const b = t.block;
    const h = b.header.length;
    const where =
      '表 ' + (idx + 1) + ' 番目' + (t.heading ? '（直前の見出し「' + t.heading + '」）' : '') +
      (t.nested ? '・引用または注記の中' : '') + '・MD の ' + (offset + t.bodyLine + 1) + ' 行目から';
    const bad = [];
    b.rows.forEach((r, k) => {
      if (r.length !== h) bad.push({ n: k + 1, line: offset + t.bodyLine + 3 + k, c: r.length });
    });
    if (bad.length) {
      const shown = bad.slice(0, 3).map((x) =>
        'データ ' + x.n + ' 行目（MD の ' + x.line + ' 行）が ' + x.c + ' セル（' + (x.c > h ? '多い' : '少ない') + '）'
      );
      warnings.push(
        '表の列数の食い違い: ' + where + '、ヘッダは ' + h + ' 列だが、' + shown.join('、') +
          (bad.length > 3 ? ' ほか ' + (bad.length - 3) + ' 行' : '') +
          '。セルの中に "|" を書くときは "\\|" と書く（バッククォートの中でも同じ）'
      );
    }
    if (b.aligns.length !== h) {
      warnings.push('表の区切り行の列数の食い違い: ' + where + '、ヘッダは ' + h + ' 列だが区切り行は ' + b.aligns.length + ' 列');
    }
  });
}

// 成果物の欄 (outputs) の検査。報告書型かどうかに依らず、宣言のある文書で呼ぶ。宣言の無い文書は warnings/errors とも空。
//   errors: 壊れた行・値が空でない形・パスが契約に反する・重複。描画は無効な宣言を無視するので、黙って欠けないよう error にする。
//   warnings: パスの実在と種別の食い違い (ここだけがファイルシステムを見る。描画は見ない。別の PC で読むと常に出る)。
function lintOutputs(md, fm, warnings, errors) {
  const raw = lintFrontmatterRaw(md);
  if (raw.outputsScalar) {
    errors.push('outputs 宣言: 値が空のブロック形で書く ("outputs:" の次の行から字下げした "- 名前 || file|dir: パス")。1 行形・リスト形は宣言とみなされない');
  }
  if (raw.outputsBrokenLines.length) {
    errors.push(
      'outputs 宣言の不正行: "- 名前 || file|dir: パス" の形でない行が ' + raw.outputsBrokenLines.length +
        ' 件ある (その行は無視される): ' + raw.outputsBrokenLines[0].trim()
    );
  }
  const v = fm && fm.outputs;
  if (!Array.isArray(v)) return;
  const seen = new Map();
  v.forEach((d) => {
    if (!d || typeof d !== 'object') return; // 値が空でない形の残骸 (文字列)。outputsScalar が error 済み
    const label = 'outputs: ' + d.name + ' || ' + d.kind + ': ' + d.path;
    const problem = outputPathProblem(d.kind, d.path);
    if (problem) {
      errors.push(label + ' — ' + problem);
      return;
    }
    const key = outputKey(d.path);
    if (seen.has(key)) {
      errors.push(label + ' — ' + (seen.get(key) === d.kind ? '同じ場所の宣言が重複している' : '同じ場所を file と dir の両方で宣言している'));
      return;
    }
    seen.set(key, d.kind);
    let st = null;
    try { st = fs.statSync(d.path); } catch (e) { st = null; }
    if (!st) {
      warnings.push(label + ' — パスが実在しない (別の PC で読むと常にこの警告が出る。描画は有無を見ない)');
    } else if (d.kind === 'file' && !st.isFile()) {
      warnings.push(label + ' — file と宣言したが実体はファイルでない');
    } else if (d.kind === 'dir' && !st.isDirectory()) {
      warnings.push(label + ' — dir と宣言したが実体はフォルダでない');
    }
  });
}

// 押せる図 (figure_links) の検査。報告書型かどうかに依らず、宣言のある文書で呼ぶ。
//   errors: 宣言ごとの有効性 (発見パスの報告 = 描画器が数えた当たり数・id を読む。lint 独自の再走査はしない)。
//   warnings: ブロック形の誤用 (読めない行)。空値・スカラ・インライン形は無警告 (従来と完全に同じ)。
function lintFigureLinks(md, fm, warnings, errors) {
  const raw = lintFrontmatterRaw(md);
  if (raw.figBrokenLines.length) {
    warnings.push(
      'figure_links 宣言の不正行: "- ノードID || heading|row|item: 文字列" 形式でない行が ' + raw.figBrokenLines.length +
        ' 件ある (その行は無視される)'
    );
  }
  const decls = figLinkDecls(fm);
  if (!decls) return;
  figLinkDiscover(md, VERIFY_SENTINEL, decls).results.forEach((r) => {
    if (!r.valid) {
      errors.push(
        'figure_links: ' + r.item.node + ' || ' + r.item.kind + ': ' + r.item.text + ' — ' + r.reasons.join(' / ')
      );
    }
  });
}

function lint(md) {
  const { fm, body } = parseFrontmatter(md);
  const warnings = [];
  const errors = [];
  // 必須見出しは、本文の生文字列ではなく tokenize が作った見出しブロックだけで判定する (hasHeadingBlock)。
  setTasksFromFm(fm);
  const blocks = tokenize(body);
  const isReport = isReportDoc(fm, blocks);

  if (!isReport) {
    // 押せる図の宣言だけは、非報告書でも検査する (宣言の無い文書は warnings/errors とも空 = 従来どおり)。
    lintFigureLinks(md, fm, warnings, errors);
    lintOutputs(md, fm, warnings, errors);
    lintTables(md, body, blocks, warnings);
    lintDaScale(fm, warnings);
    lintCheckboxes(fm, blocks, warnings);
    return { isReport: false, warnings, errors };
  }
  if (!hasHeadingBlock(blocks, AUDIENCE_HEADING_RE, 2, 4)) {
    warnings.push('必須セクション欠落: "## 本報告書の読者と目的"');
  }
  if (
    !hasHeadingBlock(blocks, SUMMARY_HEADING_RE, 2, 2) &&
    !(fm && fm.conclusion_summary === 'none' && fm.conclusion_summary_reason &&
      String(fm.conclusion_summary_reason).trim())
  ) {
    warnings.push('必須セクション欠落: "## 結論の概要" (読者と目的の直後・各結論に **OK/FAIL/CAVEAT/INFO** バッジ。免除は frontmatter conclusion_summary: none ＋ conclusion_summary_reason 必須)');
  }
  if (!(fm && fm.where) && !hasHeadingBlock(blocks, CURRENT_POS_HEADING_RE, 2, 4)) {
    warnings.push('Where 情報欠落: frontmatter "where:" も "## 現在地" も無い');
  }
  // decisions 免除 & トークンベース実体 DECISION 検査
  const hasDecisionsExemption = Boolean(
    fm && fm.decisions === 'none' && fm.decisions_reason && String(fm.decisions_reason).trim().length > 0
  );
  if (fm && fm.decisions !== undefined && fm.decisions !== 'none') {
    warnings.push('未知の decisions 値: frontmatter "decisions:" は "none" のみ許容されます');
  }

  // figures 宣言-実体一致 (双方向・機械判定可能なシグナルのみ block)。
  // 実体検出はレンダラと同一コードパス (tokenize / analyzeNumericColumns) を再利用し判定乖離を排除。
  // mermaid は種別分類する (stateDiagram → state / graph・flowchart → flow, where-map)。
  // where-map と flow の区別は意味判定 (ツリー+現在地か否か) のため lint では行わず
  // diagram-craft skill 側に置く (機械判定可能なシグナルのみ block する設計原則)。
  // 逆方向 (実体→宣言) の強度区分: mermaid/svg フェンスは執筆者が意図して書く図ソース → error。
  // 数値列表は付随的 (任意の数値列にバーが自動描画される過剰近似) → warning に留める (誤爆防止)。
  let decisionCount = 0;
  for (const b of blocks) {
    if (b.type === 'admonition' && b.adType === 'DECISION') {
      decisionCount++;
    }
  }

  if (hasDecisionsExemption && decisionCount > 0) {
    warnings.push('矛盾した宣言: frontmatter で decisions: none が指定されていますが、本文に [!DECISION] が存在します');
  } else if (!hasDecisionsExemption && decisionCount === 0) {
    warnings.push('設計判断マーカー欠落: [!DECISION] が本文にありません (未決の判断事項が無い場合は frontmatter で decisions: none ＋ decisions_reason を明記)');
  }

  if (!hasHeadingBlock(blocks, PENDING_HEADING_RE, 2, 4)) {
    warnings.push('スコープ外会計欠落: "## スコープ外提案（Pending）" が無い');
  }
  let hasGraph = false;
  let hasState = false;
  let hasSvg = false;
  let hasNumTable = false;
  let hasMermaidAny = false;
  let hasUnsupportedMermaid = false; // sequenceDiagram 等 (renderFence は全 mermaid を描画するため検査対象)
  for (const b of blocks) {
    if (b.type === 'fence') {
      const info = (b.info || '').toLowerCase();
      if (info === 'mermaid') {
        hasMermaidAny = true;
        const src = (b.content || []).join('\n');
        const isState = /^\s*stateDiagram/m.test(src);
        const isGraph = /^\s*(graph|flowchart)\b/m.test(src);
        if (isState) hasState = true;
        if (isGraph) hasGraph = true;
        if (!isState && !isGraph) hasUnsupportedMermaid = true;
      }
      if (info === 'svg') hasSvg = true;
    } else if (b.type === 'table') {
      if (analyzeNumericColumns(b).some(Boolean)) hasNumTable = true;
    }
  }
  const figures = fm ? fm.figures : undefined;
  // 移行措置 (grandfather) の機械判定 (2026-09-09 導入)。
  // 従来は「改定後の新規報告書にのみ --lint を実行する」という散文規約で、対象か否かの判断が
  // 実行者に委ねられていた = --lint を丸ごと飛ばせば無検出になる。実際に飛ばされた実例あり。
  // doc_id 先頭の YYYYMMDD を境界として機械が決める。epoch 前は warning へ降格 (遡及ブロック無し)、
  // epoch 以降は error (block)。日付が読めない報告書は fail-closed で error 扱い
  // (doc_id は report skill の必須 frontmatter 項目のため、欠落自体が規約違反)。
  const FIGURES_EPOCH = '20260909';
  const docDateM = fm && typeof fm.doc_id === 'string' ? fm.doc_id.match(/^(\d{8})/) : null;
  const figuresGrandfathered = !!(docDateM && docDateM[1] < FIGURES_EPOCH);
  if (figures === undefined || figures === '') {
    const figMsg =
      'figures 宣言欠落: frontmatter に "figures: [図種]" か "figures: none" + figures_reason を書け';
    if (figuresGrandfathered) {
      warnings.push(
        figMsg + ' (移行措置: doc_id ' + docDateM[1] + ' < epoch ' + FIGURES_EPOCH + ' のため警告に降格)'
      );
    } else {
      errors.push(figMsg + ' (epoch ' + FIGURES_EPOCH + ' 以降の新規報告書は宣言必須)');
    }
  } else if (figures === 'none') {
    if (!fm.figures_reason) {
      errors.push('figures: none に figures_reason が無い (省略理由の明文化義務)');
    }
    if (hasMermaidAny || hasSvg) {
      errors.push('宣言矛盾: figures: none なのに本文に図ソース (mermaid/svg フェンス) がある。実体に合わせて宣言せよ');
    }
    if (hasNumTable) {
      warnings.push('figures: none だが数値列を持つ表があり DA バーが自動描画される (DA 比較の意図があるなら figures: [da-table] を宣言せよ)');
    }
  } else if (Array.isArray(figures) && figures.length === 0) {
    errors.push('figures: [] は不可: 図種を 1 つ以上書くか "figures: none" + figures_reason を使え');
  } else {
    const declared = Array.isArray(figures) ? figures : [figures];
    const present = {
      'da-table': hasNumTable,
      'where-map': hasGraph,
      flow: hasGraph,
      state: hasState,
      'arch-svg': hasSvg,
    };
    for (const kind of declared) {
      if (!(kind in present)) {
        errors.push('未知の図種: "' + kind + '" (da-table / where-map / flow / state / arch-svg のみ)');
      } else if (!present[kind]) {
        errors.push(
          '宣言-実体不一致: figures に "' + kind + '" があるが本文に実体が無い' +
            ' (da-table=数値列を持つ表, where-map/flow=graph・flowchart フェンス, state=stateDiagram フェンス, arch-svg=svg フェンス)'
        );
      }
    }
    // 逆方向: 本文実体が宣言に無い = 図プランのドリフト検出
    const has = (k) => declared.includes(k);
    if (hasState && !has('state')) {
      errors.push('未宣言の図: stateDiagram フェンスがあるが figures に state が無い');
    }
    if (hasGraph && !has('flow') && !has('where-map')) {
      errors.push('未宣言の図: graph/flowchart フェンスがあるが figures に flow か where-map が無い');
    }
    if (hasSvg && !has('arch-svg')) {
      errors.push('未宣言の図: svg フェンスがあるが figures に arch-svg が無い');
    }
    if (hasUnsupportedMermaid) {
      errors.push(
        '規約外の mermaid 図: stateDiagram / graph / flowchart 以外の mermaid フェンスがある' +
          ' (図種規約は flow / where-map / state に対応する形式のみ。sequenceDiagram 等は使用しない)'
      );
    }
    if (hasNumTable && !has('da-table')) {
      warnings.push('数値列を持つ表があるが figures に da-table が無い (DA バーが自動描画される。DA 比較なら宣言を推奨)');
    }
  }

  // tabs 宣言検査 (タブ UI は決定論レンダラ拡張。宣言時のみ render がタブ化。警告のみ・非ブロック)。
  if (fm && fm.tabs !== undefined && fm.tabs !== '') {
    if (fm.tabs !== 'by-h2') {
      warnings.push('未知の tabs 値: "' + fm.tabs + '" (対応値は by-h2 のみ。タブ化されない)');
    } else {
      const tabbable = blocks.filter(
        (b) =>
          b.type === 'heading' &&
          b.level === 2 &&
          !/読者と目的/.test(b.text) &&
          !PENDING_HEADING_RE.test(b.text)
      ).length;
      if (tabbable < 2) {
        warnings.push('tabs: by-h2 だがタブ化対象の H2 セクションが ' + tabbable + ' 件 (2 件以上推奨)');
      }
    }
  }

  // comments 値検査 (既定は報告書で有効。on/off/atomic のみ受理。未知値は警告・非ブロック)。
  //   atomic = H3 (小見出し=トピック) 単位にも Composer を出す Atomic コメント (H2 末 Composer も維持)。
  if (fm && fm.comments !== undefined && fm.comments !== '') {
    if (fm.comments !== 'on' && fm.comments !== 'off' && fm.comments !== 'atomic') {
      warnings.push('未知の comments 値: "' + fm.comments + '" (on / off / atomic のみ。既定はコメント有効)');
    }
  }

  // theme 宣言検査 (opt-in テーマ切替。toggle のみ受理。未知値は警告・非ブロック)。
  if (fm && fm.theme !== undefined && fm.theme !== '') {
    if (fm.theme !== 'toggle') {
      warnings.push('未知の theme 値: "' + fm.theme + '" (対応値は toggle のみ。テーマ切替は注入されない)');
    }
  }

  // hover 宣言検査 (opt-in ホバープレビュー)。frontmatter の hover: ブロックの子行のうち
  // "|| 区切り無し" 等の壊れた行を警告する (parseFrontmatter は壊れた行を黙って捨てるため)。
  const fmRaw = lintFrontmatterRaw(md);
  if (fmRaw.hoverDeclared) {
    if (fmRaw.brokenHoverLines.length) {
      warnings.push(
        'hover 宣言の不正行: "- 識別子 || 要約" 形式でない行が ' + fmRaw.brokenHoverLines.length +
          ' 件 (これらは無視される。例: ' + JSON.stringify(fmRaw.brokenHoverLines[0]) + ')'
      );
    }
    if (!(fm && Array.isArray(fm.hover) && fm.hover.length)) {
      warnings.push('hover 宣言があるが有効な "- 識別子 || 要約" 行が 1 件も無い (ホバーは注入されない)');
    }
  }

  // comments_resolved 宣言検査 (opt-in コメント解決バッジ・非ブロック)。
  //   (a) 壊れた子行 (|| 区切り無し) を警告 (parseFrontmatter は黙って捨てる)。
  //   (b) commentsMode 前提が満たされない (= report_id/doc_id 無し or comments:off) のに宣言した場合を警告。
  //   (c) 見出しに一致しない key を警告 (描画されない)。判定は render と同一の
  //       canon→sha1→'sec-'... sectionId 化で全見出し集合と突き合わせる。
  if (fmRaw.resolvedDeclared) {
    if (fmRaw.brokenResolvedLines.length) {
      warnings.push(
        'comments_resolved 宣言の不正行: "- 見出し || メモ" 形式でない行が ' + fmRaw.brokenResolvedLines.length +
          ' 件 (これらは無視される。例: ' + JSON.stringify(fmRaw.brokenResolvedLines[0]) + ')'
      );
    }
    const hasResolvedEntries = !!(fm && Array.isArray(fm.comments_resolved) && fm.comments_resolved.length);
    if (!hasResolvedEntries) {
      warnings.push('comments_resolved 宣言があるが有効な "- 見出し || メモ" 行が 1 件も無い (バッジは注入されない)');
    } else {
      const reportIdL = fm && (fm.report_id || fm.doc_id) ? String(fm.report_id || fm.doc_id) : '';
      const commentsModeL = !!(reportIdL && isReportDoc(fm, blocks) && fm.comments !== 'off');
      if (!commentsModeL) {
        warnings.push('comments_resolved 宣言があるがコメント機能が無効 (report_id/doc_id 不在 or comments:off) のため描画されない');
      } else {
        // 全見出しの sectionId 集合を構築し、key 不一致を検出。
        const headingIds = new Set(
          blocks.filter((b) => b.type === 'heading').map((b) => 'sec-' + sha1(canon(b.text)).slice(0, 8))
        );
        // ":re" 接尾 (2 巡目以降の再コメント層) は基底 key で照合する (render と同一規則)。
        const stripRe = (k) => String(k).replace(/(?::re)+$/, '');
        const unmatched = fm.comments_resolved
          .map((e) => e.key)
          .filter((k) => !headingIds.has('sec-' + sha1(canon(stripRe(k))).slice(0, 8)));
        // ":re" 層は 1 つ浅い層が 3 部 (元コメント有り) で宣言されている時だけ描画される。
        const origKeys = new Set(
          fm.comments_resolved
            .filter((e) => typeof e.original === 'string' && e.original.length)
            .map((e) => String(e.key))
        );
        const orphanRe = fm.comments_resolved
          .map((e) => String(e.key))
          .filter((k) => /:re$/.test(k) && !origKeys.has(k.replace(/:re$/, '')));
        if (orphanRe.length) {
          warnings.push(
            'comments_resolved の ":re" 宣言に対応する 1 つ浅い層の 3 部宣言 (元コメント有り) が無い: ' + orphanRe.length +
              ' 件 (これらは描画されない。例: ' + JSON.stringify(orphanRe[0]) + ')'
          );
        }
        if (unmatched.length) {
          warnings.push(
            'comments_resolved の見出し不一致: 一致する見出しが無い key が ' + unmatched.length +
              ' 件 (これらのメモは描画されない。例: ' + JSON.stringify(unmatched[0]) + ')'
          );
        }
      }
    }
  }

  // 重複見出し警告: 同一 canon の H2 が複数 = sha1 アンカー/コメントが合流する (書き手に通知)。
  const h2canon = blocks
    .filter((b) => b.type === 'heading' && b.level === 2)
    .map((b) => canon(b.text));
  const seenH2 = {};
  const dupH2 = {};
  for (const t of h2canon) {
    if (seenH2[t]) dupH2[t] = true;
    seenH2[t] = true;
  }
  if (Object.keys(dupH2).length) {
    warnings.push(
      '重複見出し: 同一テキストの H2 が複数あり sha1 アンカー/コメントが合流する (' +
        Object.keys(dupH2).length + ' 種。見出しを一意にせよ)'
    );
  }

  // comments: atomic 時のみ: H3 (小見出し) にも Composer・localStorage key・返信集約の逆引きが
  //   H3 id (= sec-sha1(canon(text))) に依存するため、同一テキストの H3 が複数あると
  //   コメントが合流する。atomic 文書に限り H3 の重複も警告する (非 atomic 文書は H3 id が
  //   Composer に使われないため従来どおり警告しない = lint 出力も互換)。
  if (fm && fm.comments === 'atomic') {
    const h3canon = blocks
      .filter((b) => b.type === 'heading' && b.level === 3)
      .map((b) => canon(b.text));
    const seenH3 = {};
    const dupH3 = {};
    for (const t of h3canon) {
      if (seenH3[t]) dupH3[t] = true;
      seenH3[t] = true;
    }
    if (Object.keys(dupH3).length) {
      warnings.push(
        '重複見出し (atomic): 同一テキストの H3 が複数あり sha1 アンカー/コメントが合流する (' +
          Object.keys(dupH3).length + ' 種。H3 を一意にせよ。comments: atomic では H3 がコメント単位)'
      );
    }
  }

  lintFigureLinks(md, fm, warnings, errors);
  lintOutputs(md, fm, warnings, errors);
  lintTables(md, body, blocks, warnings);
  lintDaScale(fm, warnings);
  lintCheckboxes(fm, blocks, warnings);

  return { isReport: true, warnings, errors };
}

// ---------------------------------------------------------------------------
// --selftest: 内蔵 golden ケース描画 → 埋込 sha256 と照合 (破損検出)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 図のビューア (svg フェンスの図に既定で付く)。
//   本文の図 (img.svg-fig) を押す / Enter で、全画面のビューアを開く: ホイール・ボタン・キーで拡大縮小、
//   ドラッグで移動、ダブルクリックで 2 倍、2 本指でつまむ。十字カーソルが付き、図の SVG に軸の情報
//   (<metadata data-mdr="axes">) があれば、カーソルの位置の値を軸の単位で読み上げる。
//   単一 HTML のまま動く: 図の data URI をその場で読み、外部ファイルを使わない。
//   注入は svg フェンスを 1 つでも出力した文書だけ (_svgFigUsed)。図の無い文書は byte 不変。
//   部品は文字列でなく本物の関数で書き、toString() でローダに埋め込む (selftest が同じ関数を Node で呼ぶ)。
//   関数の本文に "</" を書かない (<script> を閉じてしまうため。selftest が検査する)。
// 軸の情報の形 (JSON・座標は SVG の viewBox の単位で、y は下向き):
//   {"version":1,"axes":[{"bbox":[左,上,右,下],"xlim":[左端の値,右端の値],"ylim":[下端の値,上端の値],
//     "xscale":"linear|log","yscale":"linear|log","xlabel":"..","ylabel":"..","title":".."}]}
//   形が合わない軸は黙って捨てる (カーソルは出るが値は出ない)。見るのは先頭の 64 要素・JSON は 20 万字まで。
// ---------------------------------------------------------------------------

function figViewCore() {
  var MAX_AXES = 64;
  var MAX_TEXT = 200;
  // 軸の情報の JSON の文字数の上限。軸 64 本 × ラベル 3 つ × 200 字に余裕を持たせた値（壊れた・悪意のある図で固まらないため）
  var MAX_META_CHARS = 200000;
  var META_END = '<' + '/metadata>'; // 関数の本文に "<" と "/" を続けて書かない（埋め込んだスクリプトの要素が閉じてしまうため）
  function num(v) {
    return typeof v === 'number' && isFinite(v);
  }
  function parseSize(svg) {
    var m = /<svg\b[^>]*>/i.exec(svg || '');
    if (!m) return null;
    var tag = m[0];
    var vb = /\sviewBox\s*=\s*["']\s*([-+0-9.eE]+)[\s,]+([-+0-9.eE]+)[\s,]+([-+0-9.eE]+)[\s,]+([-+0-9.eE]+)\s*["']/.exec(tag);
    if (vb) {
      var x = Number(vb[1]), y = Number(vb[2]), w = Number(vb[3]), h = Number(vb[4]);
      if (num(x) && num(y) && num(w) && num(h) && w > 0 && h > 0) return { x: x, y: y, w: w, h: h };
    }
    var wm = /\swidth\s*=\s*["']\s*([0-9.]+)(px)?\s*["']/.exec(tag);
    var hm = /\sheight\s*=\s*["']\s*([0-9.]+)(px)?\s*["']/.exec(tag);
    if (wm && hm) {
      var w2 = Number(wm[1]), h2 = Number(hm[1]);
      if (num(w2) && num(h2) && w2 > 0 && h2 > 0) return { x: 0, y: 0, w: w2, h: h2 };
    }
    return null;
  }
  function text(v) {
    return typeof v === 'string' ? v.slice(0, MAX_TEXT) : '';
  }
  function scaleOf(s) {
    if (s === undefined || s === 'linear') return 'linear';
    if (s === 'log') return 'log';
    return null;
  }
  function checkAxis(a) {
    if (!a || typeof a !== 'object') return null;
    var b = a.bbox, xl = a.xlim, yl = a.ylim;
    if (!Array.isArray(b) || !Array.isArray(xl) || !Array.isArray(yl)) return null;
    if (b.length !== 4 || xl.length !== 2 || yl.length !== 2) return null;
    var all = b.concat(xl, yl);
    for (var i = 0; i < all.length; i++) if (!num(all[i])) return null;
    if (!(b[2] > b[0] && b[3] > b[1]) || xl[0] === xl[1] || yl[0] === yl[1]) return null;
    var xs = scaleOf(a.xscale), ys = scaleOf(a.yscale);
    if (!xs || !ys) return null;
    if (xs === 'log' && !(xl[0] > 0 && xl[1] > 0)) return null;
    if (ys === 'log' && !(yl[0] > 0 && yl[1] > 0)) return null;
    return {
      bbox: b.slice(), xlim: xl.slice(), ylim: yl.slice(), xscale: xs, yscale: ys,
      xlabel: text(a.xlabel), ylabel: text(a.ylabel), title: text(a.title),
    };
  }
  function parseAxes(svg) {
    // 開始タグを見つけてから、終わりのタグは上限の文字数の範囲内でだけ探す（範囲外なら読まない。全文を走査・複製しない）
    var m = /<metadata\b[^>]*\bdata-mdr\s*=\s*["']axes["'][^>]*>/i.exec(svg || '');
    if (!m) return [];
    var from = m.index + m[0].length;
    var end = svg.slice(from, from + MAX_META_CHARS + META_END.length).indexOf(META_END);
    if (end < 0) return [];
    var o;
    try {
      o = JSON.parse(svg.substr(from, end));
    } catch (e) {
      return [];
    }
    if (!o || o.version !== 1 || !Array.isArray(o.axes)) return [];
    var out = [];
    // 見るのは先頭の MAX_AXES 要素だけ（不正な要素を大量に並べられても走査が増えない）
    var n = Math.min(o.axes.length, MAX_AXES);
    for (var i = 0; i < n; i++) {
      var a = checkAxis(o.axes[i]);
      if (a) out.push(a);
    }
    return out;
  }
  function lerp(lim, scale, f) {
    if (scale === 'log') {
      var l0 = Math.log(lim[0]), l1 = Math.log(lim[1]);
      return Math.exp(l0 + f * (l1 - l0));
    }
    // 両端の重み付きの和にする (lim[1] - lim[0] は ±1e308 のような範囲で無限大にあふれる)
    return lim[0] * (1 - f) + lim[1] * f;
  }
  function hit(axes, u, v) {
    for (var i = 0; i < axes.length; i++) {
      var b = axes[i].bbox;
      if (u >= b[0] && u <= b[2] && v >= b[1] && v <= b[3]) return axes[i];
    }
    return null;
  }
  function toData(a, u, v) {
    var b = a.bbox;
    var fx = (u - b[0]) / (b[2] - b[0]);
    var fy = (b[3] - v) / (b[3] - b[1]);
    return { x: lerp(a.xlim, a.xscale, fx), y: lerp(a.ylim, a.yscale, fy) };
  }
  // 桁: 軸の幅の 1/1000 が見える桁まで (log の軸は値そのものの 1/1000)。
  // 小数 6 桁で足りない小さな幅と、7 桁を超える大きな値は、有効数字 4 桁の表記にする (0 や桁あふれに見せない)
  var MAX_FIXED = 6, BIG = 1e7, SIG = 4;
  function fmt(val, lim, scale) {
    if (!num(val)) return '';
    var span = scale === 'log' ? Math.abs(val) : Math.abs(lim[1] - lim[0]);
    var d = span > 0 ? Math.ceil(-Math.log(span / 1000) / Math.LN10) : 0;
    if (d > MAX_FIXED || Math.abs(val) >= BIG) return val.toPrecision(SIG);
    return val.toFixed(Math.max(0, d));
  }
  return { parseSize: parseSize, parseAxes: parseAxes, hit: hit, toData: toData, fmt: fmt };
}

function figViewUi(C) {
  var imgs = document.querySelectorAll('img.svg-fig');
  if (!imgs.length) return;
  var ZOOM_STEP = 1.25, WHEEL_GAIN = 0.0015, PAN_STEP = 60, FIT_MARGIN = 0.96;
  var MIN_OF_FIT = 0.5, MAX_OF_FIT = 40, READ_GAP = 16, CAP_MAX = 160;
  var ov = null, stage, pic, vl, hl, rd, cap, closeBtn, bar, opener = null;
  var S = { s: 1, tx: 0, ty: 0, w: 1, h: 1, ox: 0, oy: 0, axes: [], fitS: 1 };
  var ptrs = {}, drag = null, pinch = null, last = null;
  function el(tag, cls, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }
  function decode(src) {
    var i = src.indexOf('base64,');
    if (src.indexOf('data:image/svg+xml') !== 0 || i < 0) return '';
    try {
      var bin = atob(src.slice(i + 7));
      var u8 = new Uint8Array(bin.length);
      for (var k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
      return new TextDecoder('utf-8').decode(u8);
    } catch (e) {
      return '';
    }
  }
  function button(label, title, fn) {
    var b = el('button', 'mdr-fv-btn', bar);
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', fn);
    return b;
  }
  function midX() {
    return stage.clientWidth / 2;
  }
  function midY() {
    return stage.clientHeight / 2;
  }
  function build() {
    ov = el('div', 'mdr-fv', document.body);
    ov.hidden = true;
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', '図のビューア');
    bar = el('div', 'mdr-fv-bar', ov);
    button('＋', '拡大（+ キー）', function () { zoomAt(ZOOM_STEP, midX(), midY()); });
    button('－', '縮小（- キー）', function () { zoomAt(1 / ZOOM_STEP, midX(), midY()); });
    button('全体', '全体を表示（0 キー）', fit);
    cap = el('span', 'mdr-fv-cap', bar);
    closeBtn = button('✕', '閉じる（Esc キー）', close);
    stage = el('div', 'mdr-fv-stage', ov);
    pic = el('img', 'mdr-fv-img', stage);
    pic.alt = '';
    pic.draggable = false;
    vl = el('div', 'mdr-fv-v', stage);
    hl = el('div', 'mdr-fv-h', stage);
    rd = el('div', 'mdr-fv-read', stage);
    el('div', 'mdr-fv-hint', ov).textContent =
      'ホイール・＋－: 拡大縮小 ／ ドラッグ・矢印キー: 移動 ／ ダブルクリック: 2 倍 ／ 0: 全体 ／ Esc: 閉じる';
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
    stage.addEventListener('pointerleave', function (e) {
      if (e.pointerType === 'mouse') hideCursor();
    });
    stage.addEventListener('dblclick', function (e) {
      var p = rel(e);
      zoomAt(2, p.x, p.y);
    });
    // キーは文書全体で受ける (図をドラッグした後はフォーカスがビューアの外にあるため)。開いている間だけ処理する
    document.addEventListener('keydown', function (e) {
      if (ov && !ov.hidden) onKey(e);
    });
    window.addEventListener('resize', function () {
      if (!ov.hidden) fit();
    });
  }
  function rel(e) {
    var r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function apply() {
    pic.style.width = S.w * S.s + 'px';
    pic.style.height = S.h * S.s + 'px';
    pic.style.left = S.tx + 'px';
    pic.style.top = S.ty + 'px';
  }
  function zoomAt(f, px, py) {
    var ns = Math.max(S.fitS * MIN_OF_FIT, Math.min(S.fitS * MAX_OF_FIT, S.s * f));
    var k = ns / S.s;
    S.tx = px - (px - S.tx) * k;
    S.ty = py - (py - S.ty) * k;
    S.s = ns;
    apply();
    if (last) cursor(last.x, last.y);
  }
  function fit() {
    var W = stage.clientWidth, H = stage.clientHeight;
    var s = Math.min(W / S.w, H / S.h) * FIT_MARGIN;
    if (!(s > 0)) s = 1;
    S.fitS = s;
    S.s = s;
    S.tx = (W - S.w * s) / 2;
    S.ty = (H - S.h * s) / 2;
    apply();
  }
  function hideCursor() {
    vl.style.display = 'none';
    hl.style.display = 'none';
    rd.style.display = 'none';
    last = null;
  }
  function line(text) {
    el('div', null, rd).textContent = text;
  }
  function cursor(px, py) {
    last = { x: px, y: py };
    vl.style.display = 'block';
    hl.style.display = 'block';
    vl.style.left = px + 'px';
    hl.style.top = py + 'px';
    var u = S.ox + (px - S.tx) / S.s, v = S.oy + (py - S.ty) / S.s;
    var a = C.hit(S.axes, u, v);
    if (!a) {
      rd.style.display = 'none';
      return;
    }
    var d = C.toData(a, u, v);
    rd.textContent = '';
    if (a.title) el('div', 'mdr-fv-rt', rd).textContent = a.title;
    line((a.xlabel || 'x') + ' = ' + C.fmt(d.x, a.xlim, a.xscale));
    line((a.ylabel || 'y') + ' = ' + C.fmt(d.y, a.ylim, a.yscale));
    rd.style.display = 'block';
    var W = stage.clientWidth, H = stage.clientHeight, rw = rd.offsetWidth, rh = rd.offsetHeight;
    var x = px + READ_GAP, y = py + READ_GAP;
    if (x + rw > W - 4) x = px - READ_GAP - rw;
    if (y + rh > H - 4) y = py - READ_GAP - rh;
    rd.style.left = Math.max(4, x) + 'px';
    rd.style.top = Math.max(4, y) + 'px';
  }
  function dist(a, b) {
    return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)) || 1;
  }
  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try {
      stage.setPointerCapture(e.pointerId);
    } catch (err) {
      /* 捕捉できない環境でも動かす */
    }
    ptrs[e.pointerId] = rel(e);
    var ids = Object.keys(ptrs);
    if (ids.length === 1) {
      drag = { x: ptrs[ids[0]].x, y: ptrs[ids[0]].y, tx: S.tx, ty: S.ty };
      pinch = null;
    } else if (ids.length === 2) {
      pinch = { d: dist(ptrs[ids[0]], ptrs[ids[1]]), s: S.s };
      drag = null;
    }
  }
  function onMove(e) {
    var p = rel(e);
    if (ptrs[e.pointerId]) ptrs[e.pointerId] = p;
    var ids = Object.keys(ptrs);
    if (pinch && ids.length === 2) {
      var a = ptrs[ids[0]], b = ptrs[ids[1]];
      zoomAt((dist(a, b) / pinch.d) * pinch.s / S.s, (a.x + b.x) / 2, (a.y + b.y) / 2);
      hideCursor();
      return;
    }
    if (drag && ids.length === 1) {
      S.tx = drag.tx + (p.x - drag.x);
      S.ty = drag.ty + (p.y - drag.y);
      apply();
      stage.classList.add('mdr-fv-drag');
    }
    cursor(p.x, p.y);
  }
  function onUp(e) {
    delete ptrs[e.pointerId];
    var ids = Object.keys(ptrs);
    pinch = null;
    if (ids.length === 1) {
      drag = { x: ptrs[ids[0]].x, y: ptrs[ids[0]].y, tx: S.tx, ty: S.ty };
    } else {
      drag = null;
      stage.classList.remove('mdr-fv-drag');
    }
  }
  function onWheel(e) {
    e.preventDefault();
    var p = rel(e);
    var dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * stage.clientHeight : e.deltaY;
    zoomAt(Math.exp(-dy * WHEEL_GAIN), p.x, p.y);
  }
  function pan(dx, dy) {
    S.tx += dx;
    S.ty += dy;
    apply();
  }
  function onKey(e) {
    var k = e.key;
    if (k === 'Escape') close();
    else if (k === '+' || k === '=') zoomAt(ZOOM_STEP, midX(), midY());
    else if (k === '-' || k === '_') zoomAt(1 / ZOOM_STEP, midX(), midY());
    else if (k === '0') fit();
    else if (k === 'ArrowLeft') pan(PAN_STEP, 0);
    else if (k === 'ArrowRight') pan(-PAN_STEP, 0);
    else if (k === 'ArrowUp') pan(0, PAN_STEP);
    else if (k === 'ArrowDown') pan(0, -PAN_STEP);
    else if (k === 'Tab') {
      var bs = bar.querySelectorAll('button');
      var i = Array.prototype.indexOf.call(bs, document.activeElement);
      var n = e.shiftKey ? (i <= 0 ? bs.length - 1 : i - 1) : (i < 0 || i >= bs.length - 1 ? 0 : i + 1);
      bs[n].focus();
    } else return;
    e.preventDefault();
  }
  function caption(img) {
    var p = img.previousElementSibling;
    var t = p && p.tagName === 'P' ? (p.textContent || '').trim() : '';
    return t.length <= CAP_MAX ? t : t.slice(0, CAP_MAX - 1) + '…';
  }
  function open(img) {
    if (!ov) build();
    var src = img.currentSrc || img.src;
    var svg = decode(src);
    var sz = C.parseSize(svg) || { x: 0, y: 0, w: img.naturalWidth || 800, h: img.naturalHeight || 600 };
    S.w = sz.w;
    S.h = sz.h;
    S.ox = sz.x;
    S.oy = sz.y;
    S.axes = C.parseAxes(svg);
    pic.src = src;
    cap.textContent = caption(img);
    opener = img;
    document.documentElement.classList.add('mdr-fv-open');
    ov.hidden = false;
    hideCursor();
    fit();
    closeBtn.focus();
  }
  function close() {
    ov.hidden = true;
    document.documentElement.classList.remove('mdr-fv-open');
    hideCursor();
    ptrs = {};
    drag = null;
    pinch = null;
    stage.classList.remove('mdr-fv-drag');
    if (opener) opener.focus();
  }
  Array.prototype.forEach.call(imgs, function (img) {
    img.classList.add('mdr-fv-zoom');
    img.tabIndex = 0;
    img.setAttribute('role', 'button');
    img.setAttribute('aria-label', '図を拡大して見る（ビューアを開く）');
    img.addEventListener('click', function () {
      open(img);
    });
    img.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open(img);
      }
    });
  });
}

const FIGVIEW_CSS = `
img.svg-fig.mdr-fv-zoom{cursor:zoom-in}
img.svg-fig.mdr-fv-zoom:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
html.mdr-fv-open,html.mdr-fv-open body{overflow:hidden}
.mdr-fv{position:fixed;inset:0;z-index:1000;display:flex;flex-direction:column;background:var(--bg);color:var(--fg)}
.mdr-fv[hidden]{display:none!important}
.mdr-fv-bar{display:flex;align-items:center;gap:6px;padding:6px 10px;background:var(--card);border-bottom:1px solid var(--line)}
.mdr-fv-btn{cursor:pointer;min-width:2.4em;border:1px solid var(--line);background:var(--bg);color:var(--fg);
  border-radius:6px;padding:.25em .7em;font:inherit;font-size:.9em}
.mdr-fv-btn:hover,.mdr-fv-btn:focus-visible{border-color:var(--accent);color:var(--accent)}
.mdr-fv-cap{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:.85em}
.mdr-fv-stage{position:relative;flex:1;overflow:hidden;cursor:crosshair;touch-action:none;user-select:none}
.mdr-fv-stage.mdr-fv-drag{cursor:grabbing}
.mdr-fv-img{position:absolute;max-width:none;max-height:none;margin:0;-webkit-user-drag:none;user-select:none}
.mdr-fv-v,.mdr-fv-h{position:absolute;display:none;pointer-events:none;background:#E11D48;opacity:.85}
.mdr-fv-v{top:0;bottom:0;width:1px}
.mdr-fv-h{left:0;right:0;height:1px}
.mdr-fv-read{position:absolute;display:none;pointer-events:none;padding:4px 8px;border-radius:6px;white-space:nowrap;
  background:rgba(15,20,30,.9);color:#F8FAFC;font:12px/1.45 ui-monospace,Consolas,monospace}
.mdr-fv-rt{color:#93C5FD}
.mdr-fv-hint{padding:4px 10px;font-size:.78em;color:var(--muted);background:var(--card);border-top:1px solid var(--line)}
@media print{.mdr-fv{display:none!important}}
`;

const FIGVIEW_LOADER =
  '<script>(function(){var C=(' + figViewCore.toString() + ')();(' + figViewUi.toString() + ')(C);})();</script>\n';

function selftestFigView() {
  let ok = true;
  const check = (name, cond) => {
    if (cond) console.error('[SELFTEST OK]   figview-' + name);
    else {
      ok = false;
      console.error('[SELFTEST FAIL] figview-' + name);
    }
  };
  const count = (s, sub) => s.split(sub).length - 1;
  const svgDoc = '# T\n\n## 1. 図\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg>\n```\n';
  const plain = '# T\n\n## 1. 本文\n\n本文だけ。\n';
  const plainOut = render(plain, 'p.md');
  check('absent-without-svg', !plainOut.includes('mdr-fv') && !plainOut.includes('figViewUi'));
  const svgOut = render(svgDoc, 's.md');
  check('injected-once', count(svgOut, 'function figViewUi') === 1 && count(svgOut, 'function figViewCore') === 1);
  check('css-injected', svgOut.includes('.mdr-fv-stage'));
  check('state-does-not-leak', !render(plain, 'p.md').includes('mdr-fv') && plainOut === render(plain, 'p.md'));
  const nested = '# T\n\n## 1. 図\n\n> [!NOTE] 図\n> ```svg\n> <svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"/>\n> ```\n';
  const nestedOut = render(nested, 'n.md');
  check('nested-svg-also-injects', !nestedOut.includes('img class="svg-fig"') || nestedOut.includes('function figViewUi'));
  check('no-script-close-in-sources', !figViewCore.toString().includes('</') && !figViewUi.toString().includes('</'));
  check('no-html-comment-in-sources', !/<!--|<script/i.test(figViewCore.toString() + figViewUi.toString()));
  check('verify-still-passes', verifyBidirectional(svgDoc).ok);

  const C = figViewCore();
  const meta = (o) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><metadata data-mdr="axes">' +
    JSON.stringify(o) + '</metadata></svg>';
  const ax = { bbox: [20, 10, 120, 90], xlim: [0, 100], ylim: [0, 50], xlabel: 'X', ylabel: 'Y', title: 'T' };
  const sz = C.parseSize(meta({ version: 1, axes: [ax] }));
  check('size-viewbox', sz && sz.x === 0 && sz.w === 200 && sz.h === 100);
  check('size-width-height', (() => { const s = C.parseSize('<svg width="30px" height="20">'); return s && s.w === 30 && s.h === 20; })());
  check('size-none', C.parseSize('<svg>') === null && C.parseSize('') === null);
  const axes = C.parseAxes(meta({ version: 1, axes: [ax] }));
  check('axes-parsed', axes.length === 1 && axes[0].xscale === 'linear' && axes[0].title === 'T');
  const close = (a, b) => Math.abs(a - b) < 1e-9;
  const p0 = C.toData(axes[0], 20, 90), p1 = C.toData(axes[0], 120, 10), pm = C.toData(axes[0], 70, 50);
  check('to-data-corners', close(p0.x, 0) && close(p0.y, 0) && close(p1.x, 100) && close(p1.y, 50));
  check('to-data-middle', close(pm.x, 50) && close(pm.y, 25));
  const huge = C.parseAxes(meta({ version: 1, axes: [Object.assign({}, ax, { bbox: [0, 0, 100, 100], xlim: [-1e308, 1e308] })] }));
  check('to-data-no-overflow', huge.length === 1 && C.toData(huge[0], 50, 50).x === 0 &&
    C.fmt(C.toData(huge[0], 50, 50).x, huge[0].xlim, 'linear') === '0');
  check('hit-inside-outside', C.hit(axes, 70, 50) === axes[0] && C.hit(axes, 10, 50) === null);
  const lg = C.parseAxes(meta({ version: 1, axes: [Object.assign({}, ax, { xscale: 'log', xlim: [1, 1000] })] }));
  check('log-scale', lg.length === 1 && close(C.toData(lg[0], 70, 50).x, Math.sqrt(1000) * 1));
  check('log-needs-positive', C.parseAxes(meta({ version: 1, axes: [Object.assign({}, ax, { xscale: 'log' })] })).length === 0);
  check('reject-bad-shapes', C.parseAxes(meta({ version: 1, axes: [
    Object.assign({}, ax, { bbox: [120, 10, 20, 90] }),
    Object.assign({}, ax, { xlim: [5, 5] }),
    Object.assign({}, ax, { ylim: [0, 'a'] }),
    Object.assign({}, ax, { xscale: 'symlog' }),
    null,
  ] })).length === 0);
  check('reject-version', C.parseAxes(meta({ version: 2, axes: [ax] })).length === 0);
  check('reject-broken-json', C.parseAxes('<svg><metadata data-mdr="axes">{oops</metadata></svg>').length === 0);
  check('no-metadata', C.parseAxes('<svg viewBox="0 0 1 1"/>').length === 0);
  // 走査の上限: 不正な要素を並べた後ろに有効な軸があっても、先頭 64 要素より後ろは見ない。長すぎる JSON は読まない
  const padded = new Array(64).fill(null).concat([ax]);
  check('inspect-at-most-64', C.parseAxes(meta({ version: 1, axes: padded })).length === 0 &&
    C.parseAxes(meta({ version: 1, axes: padded.slice(1) })).length === 1);
  check('reject-oversized-json', C.parseAxes(meta({ version: 1, axes: [ax], pad: 'x'.repeat(200000) })).length === 0);
  check('accept-json-at-limit', (() => {
    const base = JSON.stringify({ version: 1, axes: [ax], pad: '' });
    const j = JSON.stringify({ version: 1, axes: [ax], pad: 'x'.repeat(200000 - base.length) });
    return j.length === 200000 && C.parseAxes('<svg><metadata data-mdr="axes">' + j + '</metadata></svg>').length === 1;
  })());
  check('reject-unterminated', C.parseAxes('<svg><metadata data-mdr="axes">' + '{"version":1,"axes":[]}' + ' '.repeat(300000)).length === 0);
  check('fmt-digits', C.fmt(12.3456, [0, 100], 'linear') === '12.3' && C.fmt(1234.5, [0, 10000], 'linear') === '1235' &&
    C.fmt(NaN, [0, 1], 'linear') === '');
  check('fmt-tiny-and-huge', C.fmt(5e-11, [0, 1e-10], 'linear') === '5.000e-11' && C.fmt(2e-12, [1e-13, 1e-10], 'log') === '2.000e-12' &&
    C.fmt(123456789, [0, 2e8], 'linear') === '1.235e+8' && C.fmt(0, [0, 1e-10], 'linear') === '0.000');
  return ok;
}


const GOLDEN = [
  {
    name: 'minimal-heading-para',
    md: '# Title\n\n## 1. 概要\n\n本文 **強調** と `code`。\n',
    sha: '5f73062376884dfc8903ea3221ed6ac8dadf9d1e239e296fcde3a6e4ff7adf21',
  },
  {
    name: 'table-numeric-admonition',
    md:
      '---\ndoc_id: T\nstatus: in_progress\nwhere: A > B\n---\n\n# T\n\n## 本報告書の読者と目的\n\n- **誰が読む**: x\n\n## 1. 比較\n\n| 観点 | スコア |\n|---|---|\n| 案1 | 10 |\n| 案2 | 40 |\n\n> [!DECISION] 決裁A\n\n## スコープ外提案（Pending）\n\n| 項目 | 状態 |\n|---|---|\n| P1 | 未着手 |\n',
    sha: 'af961049042012e5db1f83a8390ca9a3c89c8808bfe859c933d21b3db3e668e5',
  },
  {
    name: 'svg-data-uri',
    md: '# S\n\n## 1. 図\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>\n```\n',
    sha: 'da342c173cf82bee9cb2fab020d305293f7f412c5136fb0e9c507827f352f519',
  },
  {
    name: 'tabs-by-h2',
    md: '---\ntabs: by-h2\n---\n\n# TT\n\n## 1. 目的\n\nfoo **強調**\n\n## 2. 次\n\nbar `code`\n',
    sha: '1af4716f9eb43a9cebd96602a1a8286f871839e33de6312010f2b3c5491d9e32',
  },
  {
    name: 'comments-on',
    md: '---\nreport_id: R1\n---\n\n# CR\n\n## 1. 目的\n\nfoo\n\n## 2. 次\n\nbar\n',
    sha: '05d6c8dc47481b88066d7f7669c8037cf733f725f837b3c848d2ba563ebbfe73',
  },
  {
    name: 'tabs-comments',
    md: '---\nreport_id: R2\ntabs: by-h2\n---\n\n# CT\n\n## 1. 目的\n\nfoo\n\n## 2. 次\n\nbar\n',
    sha: '807d2f3fff64a54681e46955261b2977d55dd70b694e95db0dea7e11fd3178bb',
  },
  // --- theme/hover 拡張ケース (8 件) ---
  {
    name: 'theme-toggle-only',
    md: '---\ntheme: toggle\n---\n\n# TH\n\n## 1. 概要\n\n本文 **強調**。\n',
    sha: '78cc7c7761b764e3b454188a0f5c0e7ce05c721523e963296b6e89aba8441988',
  },
  {
    name: 'hover-only',
    md:
      '---\nhover:\n  - https://example.com/a || A の要約\n  - https://example.com/b || B の要約\n---\n\n' +
      '# HV\n\n## 1. 参照\n\n[A](https://example.com/a) と [B](https://example.com/b) を参照。\n',
    sha: '0059e7167ed378a59382845e3ac35c87600997a93af2855e53a546298f93925a',
  },
  {
    name: 'theme-hover-combo',
    md:
      '---\ntheme: toggle\nhover:\n  - https://example.com/x || X 要約\n---\n\n' +
      '# THV\n\n## 1. 本文\n\n[X](https://example.com/x) リンク。\n',
    sha: '207791b3033751501bb9431187176f746ea0aa1641bd3645bedf4db9caab257c',
  },
  {
    name: 'hover-nomatch-link',
    md:
      '---\nhover:\n  - https://example.com/known || 既知\n---\n\n' +
      '# NM\n\n## 1. 本文\n\n[未一致](https://example.com/other) は target/rel が付かない。\n',
    sha: 'c1310672f3728db6c7a5221648106147f60602dd0e4d570bc475239b51a7a4b4',
  },
  {
    name: 'hover-non-http-link',
    md:
      '---\nhover:\n  - mailto:a@b.c || メール\n  - ./rel.md || 相対\n---\n\n' +
      '# NH\n\n## 1. 本文\n\n[メール](mailto:a@b.c) と [相対](./rel.md) は target/rel が付かない。\n',
    sha: 'da08eb7927f0a8d9bc11820a21e325e86c8137435901d52ebadc6887f57cbb83',
  },
  {
    name: 'hover-special-chars',
    md:
      '---\nhover:\n  - https://example.com/s || < > & " \' を含む 日本語\n---\n\n' +
      '# SP\n\n## 1. 本文\n\n[S](https://example.com/s) の要約に特殊文字。\n',
    sha: '3fe039beaa0bb3491a756dca65ac28747a5cdae1d19d71e78616ff889db1bcc3',
  },
  {
    name: 'theme-unknown-value',
    md: '---\ndoc_id: U\ntheme: neon\n---\n\n# U\n\n## 1. 概要\n\n本文。\n',
    sha: '13ba66e0baa3569f3d435f003ec0f4eb78f84a3a9af46a11c261b61620eace1e',
  },
  {
    name: 'hover-broken-line',
    md:
      '---\ndoc_id: B\nhover:\n  - https://example.com/ok || 正常\n  - これは区切り無しの壊れた行\n---\n\n' +
      '# B\n\n## 1. 本文\n\n[OK](https://example.com/ok) リンク。\n',
    sha: '68542eb4b228eb9b4f84501d518f40368ebfea1c5eaa7d8a7fca55d635615b51',
  },
  // --- comments_resolved 拡張ケース: commentsMode + comments_resolved opt-in ---
  // 注: 下記 3 件は 2 部記法 (元コメント無し)。candidate5 で データ島形式が
  //   {index:memo} → {index:{memo,orig}} へ拡張され RESOLVED_LOADER も .cmt-orig 投入を追加したため
  //   sha を再算出 (可視出力 = バッジ+メモ+編集 Composer は従来と機能等価。読取専用埋込は出ない)。
  {
    name: 'comments-resolved-basic',
    md:
      '---\nreport_id: RR1\ncomments_resolved:\n  - 1. 目的 || この節は対応済み。\n---\n\n' +
      '# CRB\n\n## 1. 目的\n\nfoo\n\n## 2. 次\n\nbar\n',
    sha: '1ded044b924ec79fe05f2cfe1a8a50846b9b8cd5725505e0d4b6cc6782acad5c',
  },
  {
    name: 'comments-resolved-mismatch',
    md:
      '---\nreport_id: RR2\ncomments_resolved:\n  - 存在しない見出し || 描画されないメモ。\n  - 1. 目的 || 対応済み。\n---\n\n' +
      '# CRM\n\n## 1. 目的\n\nfoo\n\n## 2. 次\n\nbar\n',
    sha: '791b34fe8ac1fd1668baae74dfecf4fa69eaefe78852991488566726ef4016fb',
  },
  {
    name: 'comments-resolved-specialchars',
    md:
      '---\nreport_id: RR3\ncomments_resolved:\n  - 1. 目的 || 特殊 < > & " \' を含む メモ\n---\n\n' +
      '# CRS\n\n## 1. 目的\n\nfoo\n\n## 2. 次\n\nbar\n',
    sha: 'ef7928a3eb36e5ab52894818caff5922262d73c84bdedc40d6225d70bd7263dd',
  },
  // --- comments_resolved 3 部記法 (元コメント埋込 = 読取専用 + 再コメント欄) 拡張ケース (2 件) ---
  {
    // 3 部: 見出し || 元コメント || CC 対応メモ。§1 が読取専用埋込 (cmt-orig) + ✓対応済み + メモ +
    //   再コメント Composer (sec-...:re) になる。<html> に data-resolved-sections=§1基底id。§2 は通常。
    name: 'comments-resolved-embed',
    md:
      '---\nreport_id: RE1\ncomments_resolved:\n  - 1. 目的 || 元コメント本文。 || CC 対応メモ。\n---\n\n' +
      '# CRE\n\n## 1. 目的\n\nfoo\n\n## 2. 次\n\nbar\n',
    sha: 'e704a47bc5fededcac5c61b4aaa7c5d8cab9ac34406f524b909bc94b3e70f63e',
  },
  {
    // 3 部 + atomic: 元コメント埋込が H3 (1.2 細目B) に付く。読取専用埋込 + 再コメント (sec-...:re) が
    //   H3 欄に共存し、H2 末・他 H3 の Composer は編集可能なまま (対応済みでも再コメント可を atomic 粒度で実証)。
    name: 'comments-resolved-recomment-atomic',
    md:
      '---\nreport_id: RE2\ncomments: atomic\ncomments_resolved:\n  - 1.2 細目B || 元コメント。 || 対応済みメモ。\n---\n\n' +
      '# CRR\n\n## 1. 概要\n\nlead。\n\n### 1.1 細目A\n\nfoo\n\n### 1.2 細目B\n\nbar\n',
    sha: '1f914274dabfaf655f578924d533479d0887a5a5ff0f73d4ae95fea75a913c16',
  },
  // --- comments: atomic 拡張ケース (2 件): H3 (小見出し=トピック) 直下にも Composer ---
  {
    // H2 複数 (1. / 2.) + 各 H2 内 H3 複数 (1.1/1.2, 2.1) + lead 段落。
    // 各 H3 直下に Composer + 各 H2 末に総括 Composer (二層) が出る。
    name: 'comments-atomic',
    md:
      '---\nreport_id: AT1\ncomments: atomic\n---\n\n' +
      '# AT\n\n## 1. 概要\n\nlead 段落。\n\n### 1.1 細目A\n\nfoo\n\n### 1.2 細目B\n\nbar\n\n' +
      '## 2. 次\n\nbaz\n\n### 2.1 細目C\n\nqux\n',
    sha: 'c2b1e3e7b0b8d85c6ae9d3b0d3fdadfb4e7e2e9a885615f4c1a6cb19395e66b5',
  },
  {
    // atomic + H3 に対する 2 部 comments_resolved (元コメント無し)。対応済みバッジが H3 Composer の
    // 欄に共存し、その H3 でも編集 Composer が残る (再コメント可) ことを sha で固定する。
    // candidate5 でデータ島形式拡張 ({memo,orig}) のため sha 再算出 (元コメント無し = 読取専用埋込は出ない)。
    name: 'comments-atomic-resolved',
    md:
      '---\nreport_id: AT2\ncomments: atomic\ncomments_resolved:\n  - 1.2 細目B || この H3 は対応済み。\n---\n\n' +
      '# ATR\n\n## 1. 概要\n\nlead。\n\n### 1.1 細目A\n\nfoo\n\n### 1.2 細目B\n\nbar\n',
    sha: '8aec3b3d9e7932fd7a47314ed9eb432eafc27bf76ca3fe3944071e59aa0809bd',
  },
  {
    // 結論の概要パネル (読者と目的の後・要判断一覧の前に hoist) + 4 状態バッジ化を固定。
    name: 'conclusion-summary-badges',
    md:
      '---\nreport_id: CS1\n---\n\n# T\n\n## 本報告書の読者と目的\n\n- x\n\n' +
      '## 結論の概要\n\n- **OK** — a\n- **FAIL** — b\n- **CAVEAT** — c\n- **INFO** — d\n\n## 1. 詳細\n\nfoo\n',
    sha: 'd502871c360ebdc13d3b290b2bfd35408cd0a8d25e0395077f2536f18072b7bf',
  },
  {
    // 誤爆防止: summary 内でも exact 不一致 (OK: / OK x) は非変換、パネル外 (本文) の OK も非変換を固定。
    name: 'summary-badge-scope',
    md:
      '---\nreport_id: CS2\n---\n\n# T\n\n## 本報告書の読者と目的\n\n- x\n\n' +
      '## 結論の概要\n\n- **OK** — yes\n- **OK:** — no\n- **OK x** — no\n\n## 1. 詳細\n\n- **OK** — body not badge\n',
    sha: 'cedff4a0c8b89edb27757af647f29354987c12f714d5098a7b5191c504971226',
  },
  {
    // 重複見出し周辺で hoist しても anchor id (sha1) が安定 = 決定論を固定。
    name: 'summary-duplicate-heading',
    md:
      '---\nreport_id: CS3\n---\n\n# T\n\n## 本報告書の読者と目的\n\n- x\n\n' +
      '## 結論の概要\n\n- **OK** — a\n\n## 重複\n\np\n\n## 重複\n\nq\n',
    sha: 'f747e06e5397ac1900e69341f3e39c4fc27cf95bbefa6d3effa84fd1aeb6bb08',
  },
  // --- コードブロックのコピーボタン (既定 on) 拡張ケース (3 件) ---
  // コピー対象のコードブロックを出力した文書にだけ外枠 .cb・CSS・ローダが入ることを sha で固定する。
  {
    // 言語名ラベル / nocopy は外枠なし / title="..." ラベル / HTML エスケープ対象文字を含む行。
    name: 'code-copy-basic',
    md: '# CC\n\n## 1. コマンド\n\n```bash\ncd /tmp && echo "a <b>" | grep \'x\'\n```\n\n```text nocopy\n出力例\n```\n\n```bash title="再起動する"\nsudo reboot\n```\n',
    sha: '199f0eabd4532ae438078891426c4f37a0988a8a7eea6d23ff2041a10ef62d46',
  },
  {
    // mermaid 図だけの文書: 図は包まず、コピー用 CSS/JS も注入しない (旧レンダラと byte 一致)。
    name: 'code-copy-mermaid-only',
    md: '# MM\n\n## 1. 図\n\n```mermaid\nflowchart LR\n  A --> B\n```\n',
    sha: '63ad1812633a225b322d5449b62e94139cfaebc83a3ab5ef3ec2ad8bdc70e2d9',
  },
  {
    // admonition 内のフェンス (描画時に遅延 tokenize) も検出して注入する + theme: toggle との同居。
    name: 'code-copy-admonition-theme',
    md: '---\ntheme: toggle\n---\n\n# AT\n\n## 1. 注意\n\n> [!NOTE] 囲みの中\n> ```powershell\n> Get-ChildItem C:\\Users\n> ```\n',
    sha: '052ee0f8cc61aaf99e12faa8867c80b6cc14fabf382a35c247a1efeb0c4cf2b9',
  },
  // --- 押せる図 (figure_links) 拡張ケース (2 件) ---
  // 宣言あり: 有効な飛び先の <tr>/<li> の id・データ島・専用 CSS/JS/チップが入ることを sha で固定する。
  // 宣言なし (同じ図・表・箇条): 何も入らない。両者の関係 (差分の範囲・宣言なし扱いの同一性) は selftestFigLink が固定する。
  {
    name: 'figlink-declared',
    md:
      '---\nreport_id: FG1\nfigure_links:\n  - A || row: M1\n  - B || item: M2\n  - C || heading: 2. 詳細\n---\n\n# T\n\n## 1. 図\n\n' +
      '```mermaid\nflowchart TD\n  A["a"]\n  B["b"]\n  C["c"]\n  A --> B\n```\n\n' +
      '## 2. 詳細\n\n| # | 何 |\n|---|---|\n| M1 | 行 |\n| M22 | 別 |\n\n- M2 箇条\n- M22 別の箇条\n',
    sha: '5ffd193a1151d576d6fa077344ffd5ca96e701f5c097647741c57df24b06c792',
  },
  {
    name: 'figlink-undeclared',
    md:
      '---\nreport_id: FG1\n---\n\n# T\n\n## 1. 図\n\n' +
      '```mermaid\nflowchart TD\n  A["a"]\n  B["b"]\n  C["c"]\n  A --> B\n```\n\n' +
      '## 2. 詳細\n\n| # | 何 |\n|---|---|\n| M1 | 行 |\n| M22 | 別 |\n\n- M2 箇条\n- M22 別の箇条\n',
    sha: '0cc1df815c882de60eccc11a9c1b64dc07a1881ce35d5f7bc41cab11f326858e',
  },
];

// 押せる図 (figure_links) の不変条件の自己検査 (sha 固定ではなく、関係を両側から確かめる):
//   宣言なし扱い (空値・スカラ・インライン・読めない行・有効 0 件) の出力は、キー無し文書の出力と同一
//   / 有効な宣言の出力から、有効な飛び先の id・データ島・専用 CSS/JS/チップを取り除くと、キー無し文書の出力と同一
//   (figlink-diff-scope) / データ島の全 to が出力中にちょうど 1 度 id 属性として現れる / 通し番号 id が他の id と重ならない /
//   lint は死んだ宣言を error にし、空値・スカラ・インラインには警告を出さない。
// データ島・属性の差 (data-src-sha256・フッタの sha) は MD 本文のハッシュ由来なので、比較前に正規化する。
const FIGLINK_SAMPLE_BODY =
  '---\n\n# T\n\n## 本報告書の読者と目的\n\n- x\n\n## 1. 図\n\n' +
  '```mermaid\nflowchart TD\n  A["a"]\n  B["b"]\n  C["c"]\n  A --> B\n```\n\n' +
  '## 2. 詳細\n\n| # | 何 |\n|---|---|\n| M1 | 行 |\n| M22 | 別 |\n\n- M2 箇条\n- M22 別の箇条\n';

function figLinkSampleDoc(keyLines) {
  return '---\nreport_id: FLT\ndoc_id: 20261001_FLT\nfigures: [flow]\ndecisions: none\ndecisions_reason: 見本\n' + keyLines + FIGLINK_SAMPLE_BODY;
}

function selftestFigLink() {
  let ok = true;
  const check = (name, cond, detail) => {
    if (cond) {
      console.error('[SELFTEST OK]   ' + name);
    } else {
      ok = false;
      console.error('[SELFTEST FAIL] ' + name + (detail ? '\n  ' + detail : ''));
    }
  };
  const norm = (h) => h.replace(/ data-src-sha256="[0-9a-f]{64}"/, '').replace(/ data-sha256="[0-9a-f]{12}"/, '');
  const plainHtml = norm(render(figLinkSampleDoc(''), 'x.md'));
  const plainLint = lint(figLinkSampleDoc(''));

  // 宣言なし扱い: 出力はキー無しと同一。警告は、ブロック形の誤用 (読めない行) のときだけ増える。
  const notDeclared = [
    ['empty', 'figure_links:\n', false],
    ['scalar', 'figure_links: foo\n', false],
    ['inline-list', 'figure_links: [a, b]\n', false],
    ['broken-line', 'figure_links:\n  - 壊れた行\n', true],
    ['zero-valid-dest-missing', 'figure_links:\n  - A || row: 存在しない\n', false],
    ['zero-valid-node-missing', 'figure_links:\n  - NOPE || row: M1\n', false],
    ['zero-valid-dup-node', 'figure_links:\n  - A || row: M1\n  - A || row: M22\n', false],
  ];
  for (const [name, key, warns] of notDeclared) {
    const md = figLinkSampleDoc(key);
    check('figlink-not-declared-' + name, norm(render(md, 'x.md')) === plainHtml);
    const lr = lint(md);
    const sameWarn = JSON.stringify(lr.warnings) === JSON.stringify(plainLint.warnings);
    check('figlink-lint-warn-' + name, warns ? !sameWarn : sameWarn);
  }
  // 有効 0 件でも、死んだ宣言は lint error (図リンクの宣言を持つ文書だけ)
  ['zero-valid-dest-missing', 'zero-valid-node-missing', 'zero-valid-dup-node'].forEach((name) => {
    const key = notDeclared.find((x) => x[0] === name)[1];
    const lr = lint(figLinkSampleDoc(key));
    check('figlink-lint-error-' + name, lr.errors.length > 0 && plainLint.errors.length === 0, JSON.stringify(lr.errors));
  });
  // 飛び先が 0 件 (item は「文字列＋空白」で始まるものだけ。M は M2 / M22 を拾わない)・文法外のノード ID・
  // 同じ文字列の見出しが複数 (飛び先が一意でない) は error
  const zeroDest = lint(figLinkSampleDoc('figure_links:\n  - A || item: M\n'));
  check('figlink-lint-dest-zero', zeroDest.errors.some((e) => /飛び先が 0 件/.test(e)), JSON.stringify(zeroDest.errors));
  const grammar = lint(figLinkSampleDoc('figure_links:\n  - A-B || row: M1\n'));
  check('figlink-lint-node-grammar-error', grammar.errors.some((e) => /英数字/.test(e)), JSON.stringify(grammar.errors));
  const dupHeading = lint(
    figLinkSampleDoc('figure_links:\n  - A || heading: 2. 詳細\n').replace('## 2. 詳細', '## 2. 詳細\n\n## 2. 詳細')
  );
  check('figlink-lint-heading-duplicate', dupHeading.errors.some((e) => /2 件/.test(e)), JSON.stringify(dupHeading.errors));

  // 有効な宣言: 注入される。差分は図リンクの部品だけ。
  const declMd = figLinkSampleDoc('figure_links:\n  - A || row: M1\n  - B || item: M2\n  - C || heading: 2. 詳細\n  - A2 || row: M1\n');
  const declRaw = render(declMd, 'x.md');
  const declHtml = norm(declRaw);
  check('figlink-declared-injected',
    declHtml.includes('class="mdr-figlink-data"') && declHtml.includes('<tr id="fl-1">') && declHtml.includes('<li id="fl-2">') &&
    declHtml.includes(FIGLINK_CSS) && declHtml.includes(FIGLINK_LOADER) && declHtml.includes(FIGLINK_HTML));
  // A2 はノード ID として図の原文に無いので無効 (A2 の宣言だけが落ちる)。A・B・C は有効。
  const lrDecl = lint(declMd);
  check('figlink-lint-partial-invalid', lrDecl.errors.length === 1 && /A2/.test(lrDecl.errors[0]), JSON.stringify(lrDecl.errors));
  const stripped = declHtml
    .replace(/ id="fl-\d+"/g, '')
    .replace(/<script type="application\/json" class="mdr-figlink-data">[^<]*<\/script>\n/, '')
    .split(FIGLINK_HTML).join('')
    .split(FIGLINK_CSS).join('')
    .split(FIGLINK_LOADER).join('');
  check('figlink-diff-scope', stripped === plainHtml);
  // データ島の全 to が、出力中に id 属性としてちょうど 1 度だけ現れる。通し番号 id は他の生成 id と重ならない。
  const island = JSON.parse(/<script type="application\/json" class="mdr-figlink-data">([^<]*)<\/script>/.exec(declHtml)[1]);
  const countId = (id) => declHtml.split(' id="' + id + '"').length - 1;
  check('figlink-island-to-unique', island.links.length === 3 && island.links.every((l) => countId(l.to) === 1), JSON.stringify(island));
  check('figlink-no-foreign-fl-id', (plainHtml.match(/ id="fl-/g) || []).length === 0);
  // 描画は決定論: 同じ入力は byte 一致
  check('figlink-deterministic', render(declMd, 'x.md') === declRaw);
  // 見出し id の衝突 (別の文字列の見出しが同じ sec-<sha1 先頭 8 桁> になる) は、自然な入力では作れないので、
  // 計画を直接組んで判定関数を両側から固定する (衝突 → 無効 / 衝突なし → 有効)。
  const mkHeadingPlan = (count) => {
    const p = figLinkMakePlan([{ node: 'A', kind: 'heading', text: 'H' }]);
    const d = p.dests.values().next().value;
    d.matches = 1; d.stamped = 1; d.toId = 'sec-x';
    p.items[0].nodeFound = 1;
    p.headingIds.set('sec-x', count);
    return figLinkAssess(p)[0];
  };
  // H1 (本文の 2 つ目以降の H1 を含む) は飛び先にならない。リンク記法の正規化は、描画される文字 (renderInline が
  // 最初の ')' でリンク先を閉じた結果の文字) と一致する。
  const h1Doc = lint(figLinkSampleDoc('figure_links:\n  - A || heading: 二つ目の H1\n').replace('## 2. 詳細', '# 二つ目の H1\n\n## 2. 詳細'));
  check('figlink-heading-h1-excluded', h1Doc.errors.some((e) => /飛び先が 0 件/.test(e)), JSON.stringify(h1Doc.errors));
  const linkCell = '[詳細](a/b_(c))';
  check('figlink-plain-matches-rendered-link', figLinkPlain(linkCell) === '詳細)' &&
    renderInline(linkCell) === '<a href="a/b_(c">詳細</a>)');
  check('figlink-assess-heading-id-collision', mkHeadingPlan(2).valid === false && /衝突/.test(mkHeadingPlan(2).reasons.join('')));
  check('figlink-assess-heading-id-unique', mkHeadingPlan(1).valid === true);
  return ok;
}

// コード引用の照合の自己検査。ディスクにも git にも触れず、偽の入出力 (_citeIo) だけで関係を固定する。
function selftestCite() {
  let ok = true;
  const check = (name, cond, detail) => {
    if (cond) {
      console.error('[SELFTEST OK]   ' + name);
    } else {
      ok = false;
      console.error('[SELFTEST FAIL] ' + name + (detail ? '\n  ' + detail : ''));
    }
  };
  const R = path.resolve('/fake/repo');
  const R2 = path.resolve('/fake/other');
  const FULL = 'a'.repeat(40);
  const FULL2 = 'b'.repeat(40);
  const files = new Map();
  const links = new Map(); // シンボリックリンク: リンクのパス → 実体のパス
  // リポジトリごと (git の cwd ごと) の commit・参照・blob。別のリポジトリの blob を引いてしまったら食い違いで分かる
  const repos = new Map([
    [R, { full: FULL, refs: { cafe1234: FULL, aaaaaaa: FULL }, objs: new Map([[FULL + ':src/a.ts', 'l1\nOLD2\nl3\n']]) }],
    [R2, { full: FULL2, refs: {}, objs: new Map([[FULL2 + ':src/x.ts', 'X1\nX2\n']]) }],
  ]);
  const put = (rel, text) => files.set(path.join(R, ...rel.split('/')), text);
  put('.git', '');
  put('src/a.ts', 'l1\nl2\nl3\nl4\nl5\n');
  put('src/crlf.ts', 'a\r\nb\r\n');
  put('src/bom.ts', String.fromCharCode(0xfeff) + 'x\ny\n');
  files.set(path.join(R2, '.git'), '');
  files.set(path.join(R2, 'src', 'x.ts'), 'X1\nX2\n');
  links.set(path.join(R, 'src', 'link.ts'), path.join(R2, 'src', 'x.ts'));
  files.set(path.join(R, 'src', 'link.ts'), 'X1\nX2\n');
  const dirs = new Set([R, path.join(R, 'src'), path.join(R, 'docs'), R2, path.join(R2, 'src')]);
  const gitLog = []; // 偽の入出力が受けた git の呼び出し (許可リストの外の include= では、git の中身の読み出しが 1 度も起きないことを確かめる)
  const readLog = []; // 偽の入出力が実際に読んだファイル (秘密のパスのファイルは、読まれていないことを確かめる)
  const rpCalls = new Map(); // realpath の呼び出し回数 (リンクの張り替えを再現する: race に指定した回数を超えたら別の先を返す)
  const race = new Map();
  const swapRead = new Map();
  const fake = {
    exists: (p) => files.has(p) || dirs.has(p),
    realpath: (p) => {
      const n = (rpCalls.get(p) || 0) + 1;
      rpCalls.set(p, n);
      const r = race.get(p);
      if (r && r.only !== undefined) {
        if (n === r.only) return r.to; // n 回目の呼び出しだけ別の先を返す
      } else if (r && n > r.after) return r.to;
      return links.get(p) || p;
    },
    // ファイルの同一性 (id) は、リンクを辿った先の実体のパスで決める。swapRead は「検査の後、読む瞬間だけ別のファイルを指していた」状況を再現する
    // (開いたファイルは差し替え先のもの。読んだ後に元へ戻っているので、パスだけを見る確認では気付けない)
    readFile: (p) => {
      readLog.push(p);
      const src = swapRead.get(p) || p;
      if (!files.has(src)) {
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      return { buf: Buffer.from(files.get(src), 'utf8'), id: 'id:' + (links.get(src) || src) };
    },
    statId: (p) => 'id:' + (links.get(p) || p),
    homedir: () => path.resolve('/fake/home'),
    git: (args, cwd) => {
      gitLog.push(args.join(' '));
      const none = { status: 1, stdout: Buffer.alloc(0) };
      const repo = repos.get(cwd);
      if (!repo) return none;
      if (args[0] === 'for-each-ref') {
        // args[2] が 'refs/heads/<名前>'。同名のブランチがあればその参照名を 1 行返す (無ければ空)
        const name = args[2].slice('refs/heads/'.length);
        return { status: 0, stdout: Buffer.from(repo.refs[name] ? 'refs/heads/' + name + '\n' : '') };
      }
      if (args[0] === 'rev-parse') {
        const rev = args[3].replace('^{commit}', '').toLowerCase();
        if (repo.refs[rev]) return { status: 0, stdout: Buffer.from(repo.refs[rev] + '\n') }; // 16 進だけのブランチ名・タグ名も解決される
        return rev.length >= 7 && repo.full.startsWith(rev) ? { status: 0, stdout: Buffer.from(repo.full + '\n') } : none;
      }
      if (args[0] === 'cat-file' && args[1] === '-e') return repo.objs.has(args[2]) ? { status: 0, stdout: Buffer.alloc(0) } : none;
      if (args[0] === 'cat-file' && args[1] === 'blob') {
        return repo.objs.has(args[2]) ? { status: 0, stdout: Buffer.from(repo.objs.get(args[2]), 'utf8') } : none;
      }
      return none;
    },
  };
  const prevIo = _citeIo;
  const prevSrc = _citeSrcPath;
  const prevReads = _citeReads;
  _citeIo = fake;
  setCiteSource(path.join(R, 'docs', 'r.md'));
  try {
    const ev = (info, content, indent) => evaluateCite({ type: 'fence', info, content, indent: indent || '', cite: parseCiteAttrs(info) });
    const tagOf = (r) => (r.ok ? 'ok' : r.tag);

    check('cite-ok', tagOf(ev('ts cite="src/a.ts:2-3"', ['l2', 'l3'])) === 'ok');
    check('cite-single-line', tagOf(ev('ts cite="src/a.ts:4"', ['l4'])) === 'ok');
    check('cite-content-differs', tagOf(ev('ts cite="src/a.ts:2-3"', ['l2', 'X'])) === '中身違い');
    const shift = ev('ts cite="src/a.ts:2-3"', ['l4', 'l5']);
    check('cite-range-shifted', tagOf(shift) === '範囲ずれ' && /4-5/.test(shift.detail), JSON.stringify(shift));
    check('cite-file-missing', tagOf(ev('ts cite="src/none.ts:1-1"', ['l1'])) === 'ファイル無し');
    check('cite-beyond-end', tagOf(ev('ts cite="src/a.ts:4-9"', ['l4', 'l5'])) === '範囲が実物を超える');
    const ws = ev('ts cite="src/a.ts:2-3"', ['l2 ', 'l3']);
    check('cite-trailing-space-is-a-difference', tagOf(ws) === '中身違い' && /行末の空白/.test(ws.detail), JSON.stringify(ws));
    check('cite-indent-is-strict', tagOf(ev('ts cite="src/a.ts:2-3"', [' l2', 'l3'])) === '中身違い');
    check('cite-crlf-source-ok', tagOf(ev('ts cite="src/crlf.ts:1-2"', ['a', 'b'])) === 'ok');
    check('cite-bom-only-at-start', tagOf(ev('ts cite="src/bom.ts:1-2"', ['x', 'y'])) === 'ok');
    const inc = ev('ts include="src/a.ts:2-3"', []);
    check('include-ok', inc.ok && inc.lines.join('|') === 'l2|l3', JSON.stringify(inc));
    check('include-with-body-rejected', tagOf(ev('ts include="src/a.ts:2-3"', ['x'])) === '指定が不正');
    check('include-with-whitespace-only-body-rejected', tagOf(ev('ts include="src/a.ts:2-3"', ['   '])) === '指定が不正' && tagOf(ev('ts include="src/a.ts:2-3"', [''])) === '指定が不正');
    check('control-char-in-path-rejected', tagOf(ev('ts cite="src/' + String.fromCharCode(0) + 'bad.ts:1" rev="' + FULL.slice(0, 12) + '"', ['l1'])) === '指定が不正');
    // 箇条書きの中のインデントされたフェンス: コンテナの字下げは比べず、実物の字下げは厳密に比べる
    check('indented-fence-container-indent-ignored', tagOf(ev('ts cite="src/a.ts:2-3"', ['    l2', '    l3'], '    ')) === 'ok');
    put('src/ind.ts', '  a\n    b\n');
    check('indented-fence-source-indent-strict', tagOf(ev('ts cite="src/ind.ts:1-2"', ['      a', '        b'], '    ')) === 'ok' && tagOf(ev('ts cite="src/ind.ts:1-2"', ['    a', '      b'], '    ')) === '中身違い');
    check('cite-empty-body-rejected', tagOf(ev('ts cite="src/a.ts:2-3"', [])) === '指定が不正');
    check('cite-and-include-both-rejected', tagOf(ev('ts cite="src/a.ts:1" include="src/a.ts:1"', ['l1'])) === '指定が不正');
    check('duplicate-attr-rejected', tagOf(ev('ts cite="src/a.ts:1" cite="src/a.ts:2"', ['l1'])) === '指定が不正');
    check('unquoted-attr-rejected', tagOf(ev('ts cite=src/a.ts:1', ['l1'])) === '指定が不正');
    check('no-range-rejected', tagOf(ev('ts cite="src/a.ts"', ['l1'])) === '指定が不正');
    check('reversed-range-rejected', tagOf(ev('ts cite="src/a.ts:3-2"', ['l1'])) === '指定が不正');
    check('rev-alone-rejected', tagOf(ev('ts rev="aaaaaaa"', ['l1'])) === '指定が不正');
    check('diagram-fence-rejected', tagOf(ev('mermaid include="src/a.ts:1"', [])) === '指定が不正');
    const rv = ev('ts cite="src/a.ts:1-3" rev="' + FULL.slice(0, 12) + '"', ['l1', 'OLD2', 'l3']);
    check('rev-reads-that-commit', rv.ok && rv.fullRev === FULL, JSON.stringify(rv));
    check('rev-head-rejected', tagOf(ev('ts cite="src/a.ts:1-3" rev="HEAD"', ['l1'])) === '指定が不正');
    check('rev-unknown-is-unverifiable', tagOf(ev('ts cite="src/a.ts:1-3" rev="bbbbbbb"', ['l1'])) === 'UNVERIFIABLE');
    check('rev-file-absent-at-commit', tagOf(ev('ts cite="src/a2.ts:1-1" rev="' + FULL + '"', ['l1'])) === 'ファイル無し');
    // 16 進だけのブランチ名・タグ名は rev-parse が解決するが、動く参照なので commit ID としては受け付けない
    const refRev = ev('ts cite="src/a.ts:1-3" rev="cafe1234"', ['l1', 'OLD2', 'l3']);
    check('rev-hex-named-ref-is-unverifiable', tagOf(refRev) === 'UNVERIFIABLE' && /動く参照/.test(refRev.detail), JSON.stringify(refRev));
    // 参照の指す先がたまたま同じ先頭で始まっていても、同名の参照があれば動くので受け付けない
    const collide = ev('ts cite="src/a.ts:1-3" rev="aaaaaaa"', ['l1', 'OLD2', 'l3']);
    check('rev-colliding-ref-name-is-unverifiable', tagOf(collide) === 'UNVERIFIABLE' && /同名の参照/.test(collide.detail), JSON.stringify(collide));
    check('rev-uppercase-hex-ok', tagOf(ev('ts cite="src/a.ts:1-3" rev="' + FULL.slice(0, 12).toUpperCase() + '"', ['l1', 'OLD2', 'l3'])) === 'ok');
    // ファイル自体がシンボリックリンクのとき、リポジトリは実体のパスから決める (リンクのあるリポジトリの commit では引かない)
    const viaLink = ev('ts cite="src/link.ts:1-2" rev="' + FULL2.slice(0, 12) + '"', ['X1', 'X2']);
    check('rev-follows-file-symlink-to-its-repo', viaLink.ok && viaLink.fullRev === FULL2, JSON.stringify(viaLink));
    check('rev-symlink-does-not-use-link-repo-commit', tagOf(ev('ts cite="src/link.ts:1-2" rev="' + FULL.slice(0, 12) + '"', ['X1', 'X2'])) === 'UNVERIFIABLE');
    // 実物のスナップショット: 同じ読みを使い続ける (読みの間に実物が変わっても描画・照合が食い違わない)
    put('src/a.ts', 'CHANGED\n');
    check('snapshot-keeps-first-read', tagOf(ev('ts cite="src/a.ts:2-3"', ['l2', 'l3'])) === 'ok');
    setCiteSource(path.join(R, 'docs', 'r.md'));
    check('snapshot-reset-rereads', tagOf(ev('ts cite="src/a.ts:2-3"', ['l2', 'l3'])) !== 'ok');
    put('src/a.ts', 'l1\nl2\nl3\nl4\nl5\n');
    // 秘密を含みうるファイル: パスの形で止め、中身は読まない。診断・結果に秘密の文字列を入れない
    const SECRETVAL = 'hunter2hunter2';
    const leaks = (r) => JSON.stringify(r).includes(SECRETVAL);
    put('src/.env', 'TOKEN=' + SECRETVAL + '\n');
    put('src/.env.example', 'FOO=bar\n');
    put('.ssh/id_rsa', 'KEYDATA ' + SECRETVAL + '\n');
    put('src/id_rsa.pub', 'ssh-rsa PUBLICKEYDATA\n');
    put('keys/server.pem', 'PEMDATA ' + SECRETVAL + '\n');
    put('.claude/settings.json', '{"auth":{"password":"' + SECRETVAL + '"}}\n');
    put('.claude/skills/x/SKILL.md', 'normal\n');
    put('.ccpit/app-config.json', '{"password":"' + SECRETVAL + '"}\n');
    put('.ccpit/proposals/p.md', 'proposal text\n');
    put('src/innocent.txt', 'KEYDATA ' + SECRETVAL + '\n');
    links.set(path.join(R, 'src', 'innocent.txt'), path.join(R, '.ssh', 'id_rsa'));
    const secretPathCases = [
      ['env', 'src/.env'], ['ssh-key', '.ssh/id_rsa'], ['pem', 'keys/server.pem'], ['claude-settings', '.claude/settings.json'],
      ['ccpit-config', '.ccpit/app-config.json'], ['symlink-into-ssh', 'src/innocent.txt'],
    ];
    for (const [nm, rel] of secretPathCases) {
      readLog.length = 0;
      const incl = ev('ts include="' + rel + ':1-1"', []);
      const cit = ev('ts cite="' + rel + ':1-1"', ['x']);
      // include= は許可リスト (G1) が先に断る。cite= は第 2 の網 (パス) が読む前に断る。どちらも読まず、漏らさない
      check(
        'secret-path-' + nm + '-refused-unread-unleaked',
        tagOf(incl) === '引けない種類のファイル' && tagOf(cit) === '秘密の疑い' && !leaks(incl) && !leaks(cit) && !readLog.some((p) => /\.env$|id_rsa$|server\.pem$|settings\.json$|app-config\.json$|innocent\.txt$/.test(p)),
        JSON.stringify([incl, cit, readLog])
      );
    }
    check('secret-path-home-claude-settings-refused', tagOf(ev('json include="~/.claude/settings.json:1-3"', [])) === '引けない種類のファイル');
    // ===== FB 2: include= の許可リスト (G1) と、許可リストの外の cite= の診断 (G2) =====
    const PLAIN = 'recovery code: blue-otter-river'; // 秘密の「形」を持たない秘密 (第 2 の網では拾えない。許可リストだけが止める)
    const leakPlain = (r) => JSON.stringify(r).includes('blue-otter-river');
    check('ext-of-helper', citeExtOf('a/b/c.TS') === 'ts' && citeExtOf('a\\b\\c.Json') === 'json' && citeExtOf('.json') === '' && citeExtOf('Makefile') === '' && citeExtOf('a.b.c.yml') === 'yml' && citeExtOf('x.') === '');
    const denied = ['a.json', 'b.yaml', 'c.yml', 'd.toml', 'e.ini', 'f.properties', 'g.xml', 'h.config', 'Makefile', '.json', 'Dockerfile', 'x.JSON', 'y.Yaml', 'data.json.txt', 'data.ts.json', 's.sql', 'n.txt', 'c.env', 'k.pem', 'noext'];
    denied.forEach((nm) => put('src/' + nm, PLAIN + '\n'));
    readLog.length = 0;
    gitLog.length = 0;
    const deniedRes = denied.map((nm) => [nm, ev('text include="src/' + nm + ':1-1"', [])]);
    const deniedBad = deniedRes.filter(([, r]) => tagOf(r) !== '引けない種類のファイル' || leakPlain(r) || !/cite=/.test(r.detail));
    check('allowlist-denies-config-data-and-extensionless-before-read', deniedBad.length === 0 && !readLog.some((p) => denied.some((nm) => p.endsWith(path.join('src', nm)))), JSON.stringify(deniedBad.map(([n, r]) => [n, r.tag, r.detail && r.detail.slice(0, 60)])));
    const allowedNames = ['ok.ts', 'OK.TS', 'data.json.ts', 'x.ps1', 'y.sh', 'z.md', 'w.html', 'v.py', 'u.cjs'];
    allowedNames.forEach((nm) => put('src/' + nm, 'line\n'));
    const allowedBad = allowedNames.filter((nm) => tagOf(ev('text include="src/' + nm + ':1-1"', [])) !== 'ok');
    check('allowlist-allows-source-script-markup-kinds', allowedBad.length === 0, allowedBad.join(','));
    // リンク: 書かれた名前は許可、実体は許可外 (逆も) → どちらも断る。実体は読まない
    put('src/real.json', PLAIN + '\n');
    put('src/safe.ts', PLAIN + '\n');
    links.set(path.join(R, 'src', 'safe.ts'), path.join(R, 'src', 'real.json'));
    put('src/real2.ts', 'code\n');
    put('src/lookalike.json', 'code\n');
    links.set(path.join(R, 'src', 'lookalike.json'), path.join(R, 'src', 'real2.ts'));
    readLog.length = 0;
    const viaLink1 = ev('ts include="src/safe.ts:1-1"', []);
    const viaLink2 = ev('ts include="src/lookalike.json:1-1"', []);
    check(
      'allowlist-checks-real-path-of-symlink-both-ways',
      tagOf(viaLink1) === '引けない種類のファイル' && /実体のパス/.test(viaLink1.detail) && tagOf(viaLink2) === '引けない種類のファイル' && !leakPlain(viaLink1) && !readLog.some((p) => /real\.json$|safe\.ts$/.test(p)),
      JSON.stringify([viaLink1, viaLink2, readLog])
    );
    // パスの書き方: 代替データストリーム・末尾のドットや空白は、そもそも指定不正
    check(
      'allowlist-spelling-tricks-malformed',
      ['src/a.json.:1-1', 'src/a.json :1-1', 'src/a.json:stream:1-1', 'src/a.json::$DATA:1-1'].every((sp) => tagOf(ev('ts include="' + sp + '"', [])) === '指定が不正')
    );
    // rev=: リポジトリ内の正規のパスにも同じ許可リストを、git の中身を読む前に当てる。履歴にしか無い設定ファイルも読まない
    repos.get(R).objs.set(FULL + ':src/y.yaml', PLAIN + '\n');
    repos.get(R).objs.set(FULL + ':src/old.json', PLAIN + '\n');
    gitLog.length = 0;
    const revDenied = [ev('text include="src/y.yaml:1-1" rev="' + FULL.slice(0, 12) + '"', []), ev('text include="src/old.json:1-1" rev="' + FULL.slice(0, 12) + '"', [])];
    check(
      'allowlist-rev-denies-before-any-git-call',
      revDenied.every((r) => tagOf(r) === '引けない種類のファイル' && !leakPlain(r)) && gitLog.length === 0,
      JSON.stringify([revDenied, gitLog])
    );
    // rev= で、作業ツリーのリンクが別の名前の blob を指す場合: リポジトリ内の正規のパスが許可外なら断る (書かれた名前が .ts でも)
    put('src/viarev.ts', 'x\n');
    links.set(path.join(R, 'src', 'viarev.ts'), path.join(R, 'src', 'a.json'));
    gitLog.length = 0;
    const revLink = ev('text include="src/viarev.ts:1-1" rev="' + FULL.slice(0, 12) + '"', []);
    check('allowlist-rev-with-symlink-to-config-denied-before-git', tagOf(revLink) === '引けない種類のファイル' && gitLog.length === 0, JSON.stringify([revLink, gitLog]));
    // G2: 許可リストの外のファイルの cite= は、どの失敗の診断にも実物の行を出さない。許可リストの内側は従来どおり出す
    const confLines = ['{', '  "note": "blue-otter-river",', '  "k": 1', '}'];
    put('src/conf.json', confLines.join('\n') + '\n');
    put('src/conf.ts', confLines.join('\n') + '\n');
    const g2cases = {
      mismatch: ['  "note": "WRONG"'],
      lengthDiffers: ['  "x"', '  "y"'],
    };
    const g2 = [
      ev('json cite="src/conf.json:2-2"', g2cases.mismatch),
      ev('json cite="src/conf.json:2-3"', g2cases.lengthDiffers),
      ev('json cite="src/conf.json:1-1"', ['}']),
      ev('json cite="src/conf.json:3-9"', ['  "k": 1']),
      ev('json cite="src/none.json:1-1"', ['x']),
      ev('json cite="src/conf.json:3-3" rev="bbbbbbb"', ['x']),
    ];
    check('cite-on-restricted-file-never-prints-real-lines', g2.every((r) => !r.ok && !leakPlain(r)), JSON.stringify(g2.map((r) => [r.tag, r.detail && r.detail.slice(0, 90)])));
    const wsHint = ev('json cite="src/conf.json:3-3"', ['  "k": 1 ']);
    check('cite-on-restricted-file-prints-no-closeness-hint', tagOf(wsHint) === '中身違い' && !/行末の空白/.test(wsHint.detail) && !/"k": 1"?,?\s*≠/.test(wsHint.detail), JSON.stringify(wsHint));
    const shifted = ev('json cite="src/conf.json:1-1"', ['  "k": 1']);
    check('cite-on-restricted-file-shift-reports-only-line-numbers', tagOf(shifted) === '範囲ずれ' && /3-3/.test(shifted.detail), JSON.stringify(shifted));
    const sameCodeAsTs = ev('ts cite="src/conf.ts:2-2"', g2cases.mismatch);
    check('cite-on-allowed-kind-still-shows-real-line', tagOf(sameCodeAsTs) === '中身違い' && /blue-otter-river/.test(sameCodeAsTs.detail), JSON.stringify(sameCodeAsTs));
    check('cite-on-restricted-file-still-verifies-exact-match', tagOf(ev('json cite="src/conf.json:3-3"', ['  "k": 1'])) === 'ok');
    // 検査の時点で存在しないファイルは、読む試みもしない (検査の後に同名のリンクが作られても、検査していない別のファイルを読まない)
    readLog.length = 0;
    const absent = ev('ts include="src/not-yet-created.ts:1-1"', []);
    const absentCite = ev('ts cite="src/not-yet-created.ts:1-1"', ['x']);
    check('absent-at-check-time-is-never-read', tagOf(absent) === 'ファイル無し' && tagOf(absentCite) === 'ファイル無し' && !readLog.some((p) => /not-yet-created/.test(p)), JSON.stringify([absent, readLog]));
    // 差し替え (許可 → 許可外 → 許可): 検査の時点では許可された .ts、読む瞬間だけ設定ファイルを指し、読んだ後は元に戻る。
    // パスの再確認だけでは同じに見えるが、開いたファイルの同一性が合わないので、読んだ中身は使わない (include= も cite= も)
    put('src/swap.ts', 'public line\n');
    put('src/swapsecret.json', PLAIN + '\n');
    swapRead.set(path.join(R, 'src', 'swap.ts'), path.join(R, 'src', 'swapsecret.json'));
    const swapInc = ev('ts include="src/swap.ts:1-1"', []);
    const swapCite = ev('ts cite="src/swap.ts:1-1"', ['wrong guess']);
    swapRead.clear();
    check(
      'swap-allowed-restricted-allowed-during-read-is-not-used',
      tagOf(swapInc) === 'UNVERIFIABLE' && tagOf(swapCite) === 'UNVERIFIABLE' && !leakPlain(swapInc) && !leakPlain(swapCite),
      JSON.stringify([swapInc, swapCite])
    );
    // rev=: 検査したリポジトリ内のパスを、そのまま git の読み出しに渡す。読み出しの瞬間にリンクが別のファイルを指しても、検査していない blob を読まない
    put('src/rv.ts', 'x\n');
    repos.get(R).objs.set(FULL + ':src/rv.ts', 'checked-line\n');
    repos.get(R).objs.set(FULL + ':src/rvsecret.json', PLAIN + '\n');
    put('src/rvsecret.json', PLAIN + '\n');
    race.set(path.join(R, 'src', 'rv.ts'), { only: 3, to: path.join(R, 'src', 'rvsecret.json') });
    const revRace = ev('text include="src/rv.ts:1-1" rev="' + FULL.slice(0, 12) + '"', []);
    race.clear();
    check('rev-reads-the-checked-path-not-a-re-resolved-one', !leakPlain(revRace), JSON.stringify(revRace));
    // スナップショットの索引は検査済みのパスそのもの: 設定ファイルの読みが先にスナップショットへ入っていても、その後に「許可されたファイルが
    // 読む瞬間だけ設定ファイルを指す」差し替えが起きても、設定ファイルの読みを引き当てない (include= も、食い違う cite= も)
    ev('json cite="src/conf.json:3-3"', ['  "k": 1']); // 設定ファイルの読みをスナップショットに入れる
    put('src/swap2.ts', 'public line\n');
    race.set(path.join(R, 'src', 'swap2.ts'), { only: 2, to: path.join(R, 'src', 'conf.json') });
    const cacheSwapInc = ev('ts include="src/swap2.ts:2-2"', []);
    rpCalls.clear();
    race.set(path.join(R, 'src', 'swap2.ts'), { only: 2, to: path.join(R, 'src', 'conf.json') });
    const cacheSwapCite = ev('ts cite="src/swap2.ts:2-2"', ['wrong guess']);
    race.clear();
    check('snapshot-cache-seeded-by-restricted-file-is-not-reused-after-swap', !leakPlain(cacheSwapInc) && !leakPlain(cacheSwapCite), JSON.stringify([cacheSwapInc, cacheSwapCite]));
    // 第 2 の網 (パス) は、許可された拡張子のファイルにも効く: 名前や場所が秘密の形なら、読まずに断る
    put('src/secrets.ts', 'x = "' + SECRETVAL + '"\n');
    put('src/.env.ts', 'x = "' + SECRETVAL + '"\n');
    put('.ssh/note.md', 'NOTE ' + SECRETVAL + '\n');
    put('.ccpit/notes.md', 'NOTE ' + SECRETVAL + '\n');
    readLog.length = 0;
    const net2 = ['src/secrets.ts', 'src/.env.ts', '.ssh/note.md', '.ccpit/notes.md'].map((rel) => ev('ts include="' + rel + ':1-1"', []));
    check('secret-second-net-path-applies-to-allowed-extensions', net2.every((r) => tagOf(r) === '秘密の疑い' && !leaks(r)) && !readLog.some((p) => /secrets\.ts$|\.env\.ts$|note\.md$|notes\.md$/.test(p)), JSON.stringify(net2));
    check(
      'secret-safe-names-cite-ok-and-allowed-md-include-ok',
      tagOf(ev('text cite="src/.env.example:1-1"', ['FOO=bar'])) === 'ok' && tagOf(ev('text cite="src/id_rsa.pub:1-1"', ['ssh-rsa PUBLICKEYDATA'])) === 'ok' &&
        tagOf(ev('md include=".claude/skills/x/SKILL.md:1-1"', [])) === 'ok' && tagOf(ev('md include=".ccpit/proposals/p.md:1-1"', [])) === 'ok'
    );
    const revLeak = ev('ts include="src/leak.ts:1-1" rev="' + FULL.slice(0, 12) + '"', []);
    repos.get(R).objs.set(FULL + ':src/leak.ts', 'const cfg = { password: "' + SECRETVAL + '" };\n');
    setCiteSource(path.join(R, 'docs', 'r.md'));
    const revLeak2 = ev('ts include="src/leak.ts:1-1" rev="' + FULL.slice(0, 12) + '"', []);
    check('secret-content-via-rev-refused-unleaked', tagOf(revLeak2) === '秘密の疑い' && !leaks(revLeak2) && revLeak.tag !== 'ok', JSON.stringify([revLeak, revLeak2]));
    // 中身の形: 引用符つきの値・秘密鍵・各種トークンは止め、普通のコードの行は止めない
    put('src/cfg.ts', [
      'const apiKey = "sk_live_' + SECRETVAL + '";',
      '-----BEGIN RSA ' + 'PRIVATE KEY-----',
      '-----END RSA ' + 'PRIVATE KEY-----',
      'AKIA' + 'ABCDEFGHIJKLMNOP',
      'const token = nextToken();',
      'token: string;',
      'PASSWORD=' + SECRETVAL,
      '"password": "' + SECRETVAL + '"',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123',
      'const t = "ghp_' + 'a'.repeat(36) + '";',
      'const password = askUser();',
    ].join('\n') + '\n');
    setCiteSource(path.join(R, 'docs', 'r.md'));
    const contentCases = [[1, true], [2, true], [3, true], [4, true], [5, false], [6, false], [7, true], [8, true], [9, true], [10, true], [11, false]];
    const wrong = [];
    for (const [ln, refused] of contentCases) {
      const r = ev('ts include="src/cfg.ts:' + ln + '-' + ln + '"', []);
      if ((tagOf(r) === '秘密の疑い') !== refused || leaks(r)) wrong.push(ln + ':' + JSON.stringify(r));
    }
    check('secret-content-refused-and-plain-code-allowed', wrong.length === 0, wrong.join(' / '));
    const citeMismatch = ev('ts cite="src/cfg.ts:1-1"', ['const apiKey = "different";']);
    check('secret-content-cite-mismatch-does-not-echo-actual-line', tagOf(citeMismatch) === '秘密の疑い' && !leaks(citeMismatch), JSON.stringify(citeMismatch));
    // 鍵の本体の行だけを引く場合 (BEGIN の行を含まない範囲) も、ブロックの内側なので止める。END が無ければファイルの終わりまで
    put('src/notes.md', ['top', '-----BEGIN ' + 'PRIVATE KEY-----', 'MIIEvQIBADANBgkqhkiG9w0BAQEF', '-----END ' + 'PRIVATE KEY-----', 'bottom'].join('\n') + '\n');
    put('src/tail.md', ['x', '-----BEGIN ' + 'PRIVATE KEY-----', 'BODYBODYBODY', 'y'].join('\n') + '\n');
    setCiteSource(path.join(R, 'docs', 'r.md'));
    const pemBody = ev('ts include="src/notes.md:3-3"', []);
    check(
      'secret-private-key-body-only-refused',
      tagOf(pemBody) === '秘密の疑い' && !JSON.stringify(pemBody).includes('MIIEvQ') && tagOf(ev('ts include="src/notes.md:1-1"', [])) === 'ok' && tagOf(ev('ts include="src/notes.md:5-5"', [])) === 'ok',
      JSON.stringify(pemBody)
    );
    check('secret-private-key-unterminated-runs-to-eof', tagOf(ev('ts include="src/tail.md:3-4"', [])) === '秘密の疑い' && tagOf(ev('ts include="src/tail.md:1-1"', [])) === 'ok');
    // YAML / TOML の引用符なしの値と、キーと値が別の行 (値の行だけを引く場合も、1 行前のキーを見て止める)
    const HEX32 = '0123456789abcdef0123456789abcdef';
    put('src/cfgy.md', [
      'api_key: ' + HEX32, 'name: example', 'other: ' + HEX32, 'api_key:', '  ' + HEX32,
      'sha256: ' + HEX32 + HEX32, 'token: abc123', 'const token = nextTokenFromQueue;',
    ].join('\n') + '\n');
    setCiteSource(path.join(R, 'docs', 'r.md'));
    const yamlWant = [[1, true], [2, false], [3, false], [4, false], [5, true], [6, false], [7, false], [8, false]];
    const yamlWrong = [];
    for (const [ln, refused] of yamlWant) {
      const r = ev('yaml include="src/cfgy.md:' + ln + '-' + ln + '"', []);
      // 止める行は、結果に値が入っていないことも確かめる (通す行には、その行の値が入るのが正しい)
      if ((tagOf(r) === '秘密の疑い') !== refused || (refused && JSON.stringify(r).includes(HEX32))) yamlWrong.push(ln + ':' + JSON.stringify(r).slice(0, 160));
    }
    check('secret-yaml-unquoted-and-split-key-value', yamlWrong.length === 0, yamlWrong.join(' / '));
    // 数字を含まない引用符なしの値も、大文字と小文字が混ざった 20 文字以上なら止める。識別子らしい短い値・小文字だけの値は止めない (限界として文書化)
    const MIXED = 'AbCdEfGhIjKlMnOpQrStUvWx';
    put('src/cfg2y.md', ['api_key: ' + MIXED, 'token: nextTokenFromQueue', 'api_key: abcdefghijklmnopqrstuvwx', 'secret:', '  ' + MIXED].join('\n') + '\n');
    setCiteSource(path.join(R, 'docs', 'r.md'));
    const mixedWrong = [];
    for (const [ln, refused] of [[1, true], [2, false], [3, false], [4, false], [5, true]]) {
      const r = ev('yaml include="src/cfg2y.md:' + ln + '-' + ln + '"', []);
      if ((tagOf(r) === '秘密の疑い') !== refused || (refused && JSON.stringify(r).includes(MIXED))) mixedWrong.push(ln + ':' + JSON.stringify(r).slice(0, 140));
    }
    check('secret-yaml-letters-only-mixed-case-long-value', mixedWrong.length === 0, mixedWrong.join(' / '));
    // 資格情報のキーの下のブロック (YAML の | > や、値が次の行以降にある書き方) は、値が短い行に分かれていても止める
    put('src/blocky.md', ['api_key: |', '  AbCdEfGhIjKl', '  MnOpQrStUvWx', 'next: 1', 'password:', '  user: demo'].join('\n') + '\n');
    setCiteSource(path.join(R, 'docs', 'r.md'));
    const blockWrong = [];
    for (const [rng, refused] of [['1-1', false], ['2-2', true], ['3-3', true], ['1-3', true], ['4-4', false], ['5-5', false], ['6-6', true], ['4-5', false]]) {
      const r = ev('yaml include="src/blocky.md:' + rng + '"', []);
      if ((tagOf(r) === '秘密の疑い') !== refused || (refused && /AbCdEfGhIjKl|MnOpQrStUvWx/.test(JSON.stringify(r)))) blockWrong.push(rng + ':' + JSON.stringify(r).slice(0, 140));
    }
    check('secret-credential-key-block-scalar-and-nested-lines', blockWrong.length === 0, blockWrong.join(' / '));
    // YAML のブロックスカラーの記号 (インデントの桁数・chomping の記号) が付いたヘッダでも、その下の行を止める
    const headerWrong = [];
    for (const hdr of ['|', '>', '|-', '|+', '>-', '|2', '>2', '|-2', '|2-', '>+1']) {
      put('src/hdry.md', ['api_key: ' + hdr, '  AbCdEfGhIjKl', '  MnOpQrStUvWx', 'next: 1'].join('\n') + '\n');
      setCiteSource(path.join(R, 'docs', 'r.md'));
      const r2 = ev('yaml include="src/hdry.md:2-3"', []);
      const r4 = ev('yaml include="src/hdry.md:4-4"', []);
      if (tagOf(r2) !== '秘密の疑い' || /AbCdEfGhIjKl|MnOpQrStUvWx/.test(JSON.stringify(r2)) || tagOf(r4) !== 'ok') headerWrong.push(hdr + ':' + tagOf(r2) + '/' + tagOf(r4));
    }
    check('secret-yaml-block-scalar-header-indicators', headerWrong.length === 0, headerWrong.join(' / '));
    // 値を次の行以降に続ける書き方 (Codex の列挙で挙がった変種): .properties の継続行・YAML のアンカー・TOML の複数行文字列・
    // JSON のキーと値の分割 (インデントが同じ)・ヒアドキュメント。各行は短く、行単位の形では判定できない
    const multiline = {
      properties: { lines: ['api_key=AbcD1234\\', 'EfGh5678IjKl9012', 'other=1'], want: [[1, 2, true], [2, 2, true], [3, 3, false]] },
      anchor: { lines: ['api_key: &production', '  AbcD1234', '  EfGh5678IjKl', 'next: 1'], want: [[2, 3, true], [4, 4, false]] },
      toml: { lines: ['name = "x"', 'token = """\\', 'AbcD1234\\', 'EfGh5678IjKl\\', '"""', 'other = 1'], want: [[1, 1, false], [3, 4, true], [5, 5, true], [6, 6, false]] },
      tomlPlain: { lines: ['token = """', 'AbcD1234', 'EfGh5678IjKl', '"""', 'other = 1'], want: [[2, 3, true], [4, 4, true], [5, 5, false]] },
      tomlClosedSameLine: { lines: ['token = """AbcD"""', 'next = 1'], want: [[2, 2, false]] },
      json: { lines: ['{', '"api_key":', '"AbcD1234EfGh5678"', '}'], want: [[3, 3, true], [4, 4, false]] },
      heredoc: { lines: ['api_key="$(cat <<EOF', 'AbcD1234EfGh5678', 'EOF', ')"', 'x=1'], want: [[2, 2, true], [3, 3, true], [5, 5, false]] },
      heredocEscaped: { lines: ['api_key=$(cat <<\\EOF', 'AbcD1234', 'EfGh5678', 'EOF', 'x=1'], want: [[2, 3, true], [4, 4, true], [5, 5, false]] },
      yamlQuotedMultiline: { lines: ['api_key: "AbcD1234', '  EfGh5678"', 'next: ok'], want: [[1, 1, true], [2, 2, true], [3, 3, false]] },
      shellQuotedMultiline: { lines: ['api_key="AbcD1234', 'EfGh5678"', 'next=ok'], want: [[1, 1, true], [2, 2, true], [3, 3, false]] },
      templateLiteral: { lines: ['const token = `AbcD1234', 'EfGh5678`;', 'x = 1'], want: [[1, 1, true], [2, 2, true], [3, 3, false]] },
      flowMapping: { lines: ['config: {api_key: AbcD1234EfGh5678}', 'next: ok'], want: [[1, 1, true], [2, 2, false]] },
      xmlElement: { lines: ['<settings>', '<password>AbcD1234EfGh5678</password>', '</settings>'], want: [[1, 1, false], [2, 2, true], [3, 3, false]] },
      connectionString: { lines: ['Server=db;Database=x;Password=AbcD1234EfGh5678;Trusted=1', 'x=getPassword();', 'password=getPassword();'], want: [[1, 1, true], [2, 2, false], [3, 3, false]] },
      // Azure などの接続文字列 (AccountKey・SharedAccessKey)。JSON の文字列の中に入っていても止める
      azureConnectionStrings: {
        lines: [
          '{"AzureWebJobsStorage": "DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=AbcD1234EfGh5678IjKl9012MnOp3456QrStUvWxYz+/=;EndpointSuffix=core.windows.net"}',
          'Endpoint=sb://x.servicebus.windows.net/;SharedAccessKeyName=root;SharedAccessKey=AbcD1234EfGh5678IjKl9012MnOp3456=',
          'DefaultEndpointsProtocol=https;AccountName=demo;EndpointSuffix=core.windows.net',
          'Server=db;Database=x;Trusted_Connection=True',
        ],
        want: [[1, 1, true], [2, 2, true], [3, 3, false], [4, 4, false]],
      },
      urlCredentials: { lines: ['git remote add o https://user:AbcD1234EfGh@host/repo.git', 'see https://example.com/path'], want: [[1, 1, true], [2, 2, false]] },
      // コメントに書かれた閉じない例 (api_key="$(cat <<EOF ) が、ファイルの終わりまでを止めない: 上限 (CITE_UNTERMINATED_BLOCK_LINES) の外の行は通る
      unterminatedExampleInComment: {
        lines: ['# example: api_key="$(cat <<EOF )"'].concat(Array.from({ length: 40 }, (_, k) => 'plain line ' + k)),
        want: [[2, 2, true], [21, 21, true], [30, 30, false], [41, 41, false]],
      },
      // ドット区切りのキー (Java / Spring の設定)
      dottedKeys: {
        lines: ['api.key=AbcD1234EfGh5678', 'name=x', 'client.secret=', 'AbcD1234EfGh5678', 'spring.datasource.password = AbcD1234EfGh5678', 'access.key: |', '  AbcD1234', 'z=1'],
        want: [[1, 1, true], [2, 2, false], [4, 4, true], [5, 5, true], [7, 7, true], [8, 8, false]],
      },
      // Bash の ANSI-C 引用 ($'...') と、記号つきのヒアドキュメント区切り語
      ansiCAndPunctHeredoc: {
        lines: ["API_KEY=$'AbcD1234EfGh5678'", 'mode=production', "api_key=$(cat <<'EOF-SECRET'", 'AbcD1234EfGh5678', 'EOF-SECRET', ')', 'x=1'],
        want: [[1, 1, true], [2, 2, false], [4, 4, true], [5, 5, true], [7, 7, false]],
      },
      // 名前と値が別の属性 (.NET の appSettings など)・JSON の name/value の対
      nameValuePairs: {
        lines: [
          '<add key="ApiKey" value="AbcD1234EfGh5678" />', '<add key="Timeout" value="30000000" />', '<add value="AbcD1234EfGh5678" key="Db.Password" />',
          '{"name": "client_secret", "value": "AbcD1234EfGh5678"}', '{"name": "title", "value": "Hello world long text"}', '<add key="ApiKey" value="x" />',
        ],
        want: [[1, 1, true], [2, 2, false], [3, 3, true], [4, 4, true], [5, 5, false], [6, 6, false]],
      },
      // ベンダー固有の形式のトークンは、キー名が資格情報らしくなくても (DOCKERHUB_PAT など) 形で止める。形が似ているだけの普通の文字列は通す
      vendorTokens: {
        lines: [
          'DOCKERHUB_PAT: dckr_pat_' + '01H8Z7V6T5R4Q3P2N1M0LKJIHGFEDCBA98', 'NPM_AUTH=npm_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8', 'x = "glpat-' + 'abcdefghij0123456789"',
          'pk = "' + 'sk_live_' + 'abcdefghij0123456789"', 'const label = "hf_model_name";', 'see npm_config_registry and dckr_pat_ prefix docs', 'x = 1',
        ],
        want: [[1, 1, true], [2, 2, true], [3, 3, true], [4, 4, true], [5, 5, false], [6, 6, false], [7, 7, false]],
      },
      // Kubernetes の Secret (tls.key)・Base64 化された PEM は、キー名が何でも形で止める。普通のキー名の長い値は通す
      kubeSecrets: {
        lines: [
          'kind: Secret', 'data:', '  tls.key: LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktTUFURVJJQUwtQkFTRTY0', '  ca.crt: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSURERENDQWZT',
          '  signing.key: AbcD1234EfGh5678IjKl9012', '  note: AbcD1234EfGh5678IjKl9012MnOp3456',
        ],
        want: [[1, 1, false], [3, 3, true], [4, 4, true], [5, 5, true], [6, 6, false]],
      },
      closedQuotes: { lines: ['title: "Token usage"', "label: 'it''s fine'", 'token: "short"'], want: [[1, 1, false], [2, 2, false], [3, 3, false]] },
    };
    const mlWrong = [];
    for (const [nm, spec] of Object.entries(multiline)) {
      put('src/ml_' + nm + '.md', spec.lines.join('\n') + '\n');
      setCiteSource(path.join(R, 'docs', 'r.md'));
      for (const [a, b, refused] of spec.want) {
        const r = ev('text include="src/ml_' + nm + '.md:' + a + '-' + b + '"', []);
        if ((tagOf(r) === '秘密の疑い') !== refused || (refused && /AbcD|EfGh5678/.test(JSON.stringify(r)))) mlWrong.push(nm + ' ' + a + '-' + b + ':' + tagOf(r));
      }
    }
    check('secret-multiline-value-forms-continuation-anchor-toml-json-heredoc', mlWrong.length === 0, mlWrong.join(' / '));
    // インデントの無い値の行 (INI の "secret=" の次の行など)。ブロックの規則 (インデントが深い行) では当たらないので、キーと値が別の行の規則で止める
    put('src/flati.md', ['name=x', 'secret=', HEX32, 'other=1'].join('\n') + '\n');
    setCiteSource(path.join(R, 'docs', 'r.md'));
    const flatWrong = [];
    for (const [ln, refused] of [[1, false], [2, false], [3, true], [4, false]]) {
      const r = ev('ini include="src/flati.md:' + ln + '-' + ln + '"', []);
      if ((tagOf(r) === '秘密の疑い') !== refused || (refused && JSON.stringify(r).includes(HEX32))) flatWrong.push(ln + ':' + JSON.stringify(r).slice(0, 140));
    }
    check('secret-key-and-value-on-separate-unindented-lines', flatWrong.length === 0, flatWrong.join(' / '));
    // OpenPGP の秘密鍵 (PRIVATE KEY BLOCK)・値の後ろの行内コメント・HTTP の Basic 認証
    put('keys/release.md', ['-----BEGIN PGP ' + 'PRIVATE KEY BLOCK-----', 'lQVYBGBODYBODY', '-----END PGP ' + 'PRIVATE KEY BLOCK-----'].join('\n') + '\n');
    put('src/cfg3y.md', [
      'api_key: AbcD1234EfGh5678 # production', 'token: | # prod', '  AbCdEfGhIjKl', '  MnOpQrStUvWx',
      'Authorization: Basic YWxpY2U6Y29ycmVjdC1ob3JzZS1iYXR0ZXJ5LXN0YXBsZQ==', 'note: hello # world',
    ].join('\n') + '\n');
    setCiteSource(path.join(R, 'docs', 'r.md'));
    check('secret-pgp-private-key-block-refused', tagOf(ev('text include="keys/release.md:2-2"', [])) === '秘密の疑い' && tagOf(ev('text include="keys/release.md:1-1"', [])) === '秘密の疑い');
    const cfg3Wrong = [];
    for (const [ln, refused] of [[1, true], [2, false], [3, true], [4, true], [5, true], [6, false]]) {
      const r = ev('yaml include="src/cfg3y.md:' + ln + '-' + ln + '"', []);
      if ((tagOf(r) === '秘密の疑い') !== refused || (refused && /AbcD1234EfGh5678|AbCdEfGhIjKl|MnOpQrStUvWx|YWxpY2U6/.test(JSON.stringify(r)))) cfg3Wrong.push(ln + ':' + JSON.stringify(r).slice(0, 140));
    }
    check('secret-inline-comment-suffix-and-basic-auth', cfg3Wrong.length === 0, cfg3Wrong.join(' / '));
    // 検査した後にリンク先が差し替えられても (TOCTOU)、別のファイルの中身を使わない
    put('src/safe-link.md', 'public-line\n');
    setCiteSource(path.join(R, 'docs', 'r.md'));
    race.set(path.join(R, 'src', 'safe-link.md'), { after: 1, to: path.join(R, '.ssh', 'id_rsa') });
    const raced = ev('ts include="src/safe-link.md:1-1"', []);
    race.clear();
    check('secret-toctou-link-repointed-after-check-not-used', tagOf(raced) === 'UNVERIFIABLE' && !JSON.stringify(raced).includes('public-line') && !leaks(raced), JSON.stringify(raced));
    // パスの書き方: 代替データストリーム・末尾のドットや空白・無効な文字は読む前に弾く。ドライブ文字のコロンと ".." は従来どおり
    const specOk = (s) => parseCiteSpec(s) !== null;
    check(
      'path-spelling-ads-trailing-dot-invalid-char-rejected',
      !specOk('src/notes.md:private:1-1') && !specOk('src/.env.:1-1') && !specOk('src/.env :1-1') && !specOk('src/a?.ts:1') && !specOk('a/b:c/d.ts:3') &&
        specOk('C:/x/y.ts:12-20') && specOk('a/../b.ts:1') && specOk('./x.ts:1-2') && parseCiteSpec('C:/x/y.ts:12-20').path === 'C:/x/y.ts'
    );
    check('path-ads-on-protected-file-is-malformed', tagOf(ev('json include="~/.claude/settings.json:private:1-1"', [])) === '指定が不正');
    // 同じ実ファイルをリンク経由と直接のパスで引いても、同じ読み (スナップショット) を共有する
    setCiteSource(path.join(R, 'docs', 'r.md'));
    const linkPath = path.join(R, 'src', 'link.ts');
    const targetPath = path.join(R2, 'src', 'x.ts');
    const viaLinkFirst = ev('ts cite="src/link.ts:1-2"', ['X1', 'X2']);
    files.set(linkPath, 'Y1\nY2\n');
    files.set(targetPath, 'Y1\nY2\n');
    const viaTargetSecond = ev('ts cite="' + targetPath.split(path.sep).join('/') + ':1-2"', ['X1', 'X2']);
    check('snapshot-shared-between-link-and-target', tagOf(viaLinkFirst) === 'ok' && tagOf(viaTargetSecond) === 'ok', JSON.stringify([viaLinkFirst.ok, viaTargetSecond]));
    files.set(linkPath, 'X1\nX2\n');
    files.set(targetPath, 'X1\nX2\n');
    setCiteSource(null);
    check('relative-without-source-is-unverifiable', tagOf(ev('ts cite="src/a.ts:2-3"', ['l2', 'l3'])) === 'UNVERIFIABLE');
    setCiteSource(path.join(R, 'docs', 'r.md'));

    // 属性の読み取り: title の中の cite= は属性ではない / 属性が無ければ null (= 機能を使っていない)
    check('attrs-none-is-null', parseCiteAttrs('ts') === null && parseCiteAttrs('') === null && parseCiteAttrs('ts title="cite=x"') === null);
    check('attrs-stripped', stripCiteAttrs('ts cite="src/a.ts:1" title="t"') === 'ts title="t"' && stripCiteAttrs('ts nocopy') === 'ts nocopy');

    // 文書全体: 宣言のある文書は照合され、include は HTML に実物が入り、HTML⊆MD / MD⊆HTML も通る
    const doc =
      '# T\n\n```ts cite="src/a.ts:2-3"\nl2\nl3\n```\n\n```ts include="src/a.ts:4-5"\n```\n\n> [!NOTE] n\n> ```ts include="src/a.ts:1"\n> ```\n';
    const vc = verifyCites(doc);
    check('doc-declared-and-all-ok', vc.declared === 3 && vc.failures.length === 0, JSON.stringify(vc.items.map((i) => i.res)));
    const dh = render(doc, 'r.md');
    check('doc-include-lines-in-html', dh.includes('<code>l4\nl5</code>') && dh.includes('<code>l1</code>'));
    check('doc-bidirectional-ok', verifyBidirectional(doc).ok);
    check('doc-nested-fence-failure-reported', verifyCites(doc.replace('include="src/a.ts:1"', 'include="src/a.ts:1-99"')).failures.length === 1);
    check('doc-without-declaration-reports-zero', verifyCites('# T\n\n```ts\nx\n```\n').declared === 0);
  } finally {
    _citeIo = prevIo;
    _citeSrcPath = prevSrc;
    _citeReads = prevReads;
  }
  return ok;
}

// ---------------------------------------------------------------------------
// SKILL.md の章立ての検査。本体 (SKILL.md) は道案内と必ず守る規則だけを持ち、機能ごとの規則は chapters/ の章にある。
//   checkChapterLinks は純関数: 本体の本文・chapters/ にあるファイル名の一覧・上限から、問題の文字列の配列を返す (空 = 問題なし)。
//   章の無い版 (英語版など) は「参照も章も無い」ので該当なし (空)。参照だけある・章だけある・上限超えは問題。
//   checkChapterSet(dir, opts) はフォルダを読んで上の純関数を呼ぶ。opts.strict (配布物の検査用) は、章の名前が
//   SKILL_CHAPTERS と過不足なく一致し、SKILL.md が必ずあることを求める (梱包漏れを「該当なし」で通さない)。
// ---------------------------------------------------------------------------

const SKILL_CHAPTERS = [
  'figures.md', 'tables.md', 'outputs.md', 'figure-colors.md', 'figure-colors-script.md', 'clickable-figures.md',
  'code-blocks.md', 'code-quotes.md', 'review-comments.md', 'opt-in-display.md', 'delivery.md', 'maintaining.md',
];
const SKILL_BODY_MAX_LINES = 140;
const SKILL_BODY_MAX_BYTES = 12288;
const CHAPTER_REF_RE = /`chapters\/([A-Za-z0-9._-]+\.md)`/g;

// opts.strict (既定 true): false のとき、本体から参照されない章 (配った後に残った古い章など。配布は上書きだけでファイルを消さない)
//   は問題にせず、戻り値の配列の notes プロパティに名前を入れて知らせるだけにする。本体が参照する章が無い (欠け)・上限超えは
//   strict でなくても問題。
function checkChapterLinks(skillMd, chapterNames, limits, opts) {
  const strict = !(opts && opts.strict === false);
  const lim = limits || { maxLines: SKILL_BODY_MAX_LINES, maxBytes: SKILL_BODY_MAX_BYTES };
  const problems = [];
  problems.notes = [];
  const refs = new Set();
  let m;
  const re = new RegExp(CHAPTER_REF_RE.source, 'g');
  while ((m = re.exec(skillMd))) refs.add(m[1]);
  const names = new Set(chapterNames);
  if (refs.size === 0 && names.size === 0) return problems; // 章立てでない版
  for (const r of refs) if (!names.has(r)) problems.push('本体が参照する章が無い: chapters/' + r);
  // 本体に章への参照が 1 つも無いのに章がある、は欠けではない (章の無い版 = 英語版などに、日本語版の古い章が残った状態でありうる)。
  // 厳格でないときは失敗にせず、別の文言で知らせる (配布物の検査 = 厳格モードと台帳の照合が、道案内を失った日本語版の本体を止める)。
  const noPointers = refs.size === 0;
  for (const n of names) {
    if (refs.has(n)) continue;
    if (strict) problems.push('本体から参照されない章がある: chapters/' + n);
    else if (noPointers) problems.notes.push('本体に章への道案内が 1 つも無いのに章がある (章の無い版に古い章が残ったのかもしれない。失敗にはしない): chapters/' + n);
    else problems.notes.push('本体から参照されない章がある (古い章の残りかもしれない。失敗にはしない): chapters/' + n);
  }
  const lines = skillMd.split('\n').length - (skillMd.endsWith('\n') ? 1 : 0);
  const bytes = Buffer.byteLength(skillMd, 'utf8');
  if (lines > lim.maxLines) problems.push('本体の行数が上限を超えた: ' + lines + ' > ' + lim.maxLines);
  if (bytes > lim.maxBytes) problems.push('本体のバイト数が上限を超えた: ' + bytes + ' > ' + lim.maxBytes);
  return problems;
}

function checkChapterSet(dir, opts) {
  const strict = !!(opts && opts.strict);
  const skillPath = path.join(dir, 'SKILL.md');
  const chDir = path.join(dir, 'chapters');
  let skillMd = null;
  try { skillMd = fs.readFileSync(skillPath, 'utf8'); } catch (e) { skillMd = null; }
  let names = [];
  try { names = fs.readdirSync(chDir).filter((n) => /\.md$/.test(n)); } catch (e) { names = []; }
  if (skillMd === null) return strict ? ['SKILL.md が無い: ' + skillPath] : [];
  const problems = checkChapterLinks(skillMd, names, undefined, { strict });
  if (strict) {
    for (const n of SKILL_CHAPTERS) if (names.indexOf(n) === -1) problems.push('期待する章が無い: chapters/' + n);
    for (const n of names) if (SKILL_CHAPTERS.indexOf(n) === -1) problems.push('期待に無い章がある: chapters/' + n);
  }
  return problems;
}

function selftestChapters() {
  let ok = true;
  const check = (name, cond, detail) => {
    if (cond) {
      console.error('[SELFTEST OK]   ' + name);
    } else {
      ok = false;
      console.error('[SELFTEST FAIL] ' + name + (detail ? '\n  ' + detail : ''));
    }
  };
  const body = '# t\n\n| 作業 | 章 |\n|---|---|\n| a | `chapters/a.md` |\n| b | `chapters/b.md` |\n';
  check('chapters-good-sample', checkChapterLinks(body, ['a.md', 'b.md']).length === 0);
  check('chapters-not-applicable', checkChapterLinks('# t\n\nplain\n', []).length === 0);
  const missing = checkChapterLinks(body, ['a.md']);
  check('chapters-broken-missing-file', missing.length === 1 && missing[0].indexOf('chapters/b.md') !== -1, JSON.stringify(missing));
  const orphan = checkChapterLinks(body, ['a.md', 'b.md', 'c.md']);
  check('chapters-broken-orphan', orphan.length === 1 && orphan[0].indexOf('chapters/c.md') !== -1, JSON.stringify(orphan));
  // 配った後の実物のフォルダ (厳格でない検査) では、参照されない章 (古い章の残り) は失敗にせず名前を知らせるだけ。
  // 配布は上書きだけでファイルを消さないので、章を減らす・名前を変えると古い章が各 PC に残る。
  const orphanLoose = checkChapterLinks(body, ['a.md', 'b.md', 'c.md'], undefined, { strict: false });
  check('chapters-orphan-not-failure-when-not-strict', orphanLoose.length === 0 && orphanLoose.notes.length === 1 && orphanLoose.notes[0].indexOf('chapters/c.md') !== -1, JSON.stringify(orphanLoose.notes));
  // 本体に道案内が 1 つも無い版 (英語版など) に古い章が残っても、厳格でないときは通る (別の文言で知らせる)。厳格モードでは失敗。
  const noPtrLoose = checkChapterLinks('# t\n\nplain\n', ['a.md'], undefined, { strict: false });
  check('chapters-no-pointer-with-leftover-is-note-when-not-strict', noPtrLoose.length === 0 && noPtrLoose.notes.length === 1 && noPtrLoose.notes[0].indexOf('道案内が 1 つも無い') !== -1, JSON.stringify(noPtrLoose.notes));
  check('chapters-no-pointer-with-leftover-fails-when-strict', checkChapterLinks('# t\n\nplain\n', ['a.md'], undefined, { strict: true }).length === 1);
  check('chapters-orphan-still-fails-when-strict', checkChapterLinks(body, ['a.md', 'b.md', 'c.md'], undefined, { strict: true }).length === 1);
  check('chapters-missing-still-fails-when-not-strict', checkChapterLinks(body, ['a.md'], undefined, { strict: false }).length === 1);
  check('chapters-over-limit-still-fails-when-not-strict', checkChapterLinks(body, ['a.md', 'b.md', 'c.md'], { maxLines: 3, maxBytes: 10 }, { strict: false }).length === 2);
  const noPointer = checkChapterLinks('# t\n\nplain\n', ['a.md']);
  check('chapters-broken-no-pointer', noPointer.length === 1, JSON.stringify(noPointer));
  const over = checkChapterLinks(body, ['a.md', 'b.md'], { maxLines: 3, maxBytes: 10 });
  check('chapters-broken-over-limit', over.length === 2, JSON.stringify(over));
  // 実物 (md2html.cjs と同じ場所の SKILL.md と chapters/)。章の無い版・SKILL.md の無い場所 (作業コピー) は該当なし。
  const real = checkChapterSet(__dirname, { strict: false });
  check('chapters-real-folder', real.length === 0, JSON.stringify(real));
  (real.notes || []).forEach((n) => console.error('[SELFTEST NOTE]   ' + n));
  return ok;
}

// 成果物の欄 (outputs)・表・DA バーの自己検査。
function selftestOutputsTables() {
  let ok = true;
  const check = (name, cond, detail) => {
    if (cond) {
      console.error('[SELFTEST OK]   ' + name);
    } else {
      ok = false;
      console.error('[SELFTEST FAIL] ' + name + (detail ? '\n  ' + detail : ''));
    }
  };
  const norm = (h) => h.replace(/data-src-sha256="[0-9a-f]+"/, 'data-src-sha256=""').replace(/data-sha256="[0-9a-f]+"/, 'data-sha256=""');
  const HEAD = '---\nreport_id: OT\n';
  const BODY = '\n# T\n\n## 本文\n\n文。\n';
  const OUT_FM =
    'outputs:\n  - 提案 CSV || file: C:\\ホーム\\成果 データ\\a b.csv\n  - 置き場 || dir: C:\\ホーム\\成果 データ\\\n  - 控え || file: D:\\x\\y#1%.json\n';
  // --- URL の固定値 (OS に依らない) ---
  check('outputs-url-ja-space', outputFileUrl('C:\\ホーム\\成果 データ\\a b.csv', false) === 'file:///C:/%E3%83%9B%E3%83%BC%E3%83%A0/%E6%88%90%E6%9E%9C%20%E3%83%87%E3%83%BC%E3%82%BF/a%20b.csv');
  check('outputs-url-dir-slash', outputFileUrl('C:\\work\\out', true) === 'file:///C:/work/out/' && outputFileUrl('C:\\', true) === 'file:///C:/');
  check('outputs-url-hash-percent-tilde', outputFileUrl('D:\\x\\y#1%~.json', false) === 'file:///D:/x/y%231%25%7E.json');
  if (process.platform === 'win32') {
    const u = require('url');
    for (const p of ['C:\\a b\\日本語 #1\\x%41.csv', "C:\\it's (1)&2\\f$.txt", 'C:\\~x\\y.csv']) {
      check('outputs-url-equals-pathToFileURL ' + p, outputFileUrl(p, false) === u.pathToFileURL(p).href);
    }
  }
  // --- 描画: 宣言あり ---
  const withOut = HEAD + OUT_FM + '---\n' + BODY;
  const htmlOut = render(withOut, 'o.md');
  check('outputs-panel-appears', htmlOut.indexOf('class="panel panel-outputs"') !== -1 && htmlOut.indexOf('class="out-open"') !== -1);
  check('outputs-folder-href', htmlOut.indexOf('href="file:///C:/%E3%83%9B%E3%83%BC%E3%83%A0/%E6%88%90%E6%9E%9C%20%E3%83%87%E3%83%BC%E3%82%BF/"') !== -1);
  check('outputs-file-in-dir-group-merged', (htmlOut.match(/class="out-open"/g) || []).length === 2, String((htmlOut.match(/class="out-open"/g) || []).length));
  check('outputs-panel-before-audience', htmlOut.indexOf('panel-outputs') < htmlOut.indexOf('<main'));
  // 決定論: 描画は fs に触れない (ファイルの有無・MD の置き場所を見ない)
  const savedStat = fs.statSync, savedExists = fs.existsSync, savedRead = fs.readFileSync;
  let touched = '';
  fs.statSync = () => { touched = 'statSync'; throw new Error('fs touched'); };
  fs.existsSync = () => { touched = 'existsSync'; throw new Error('fs touched'); };
  fs.readFileSync = () => { touched = 'readFileSync'; throw new Error('fs touched'); };
  let htmlAgain = '';
  try { htmlAgain = render(withOut, 'elsewhere/o.md'); } finally { fs.statSync = savedStat; fs.existsSync = savedExists; fs.readFileSync = savedRead; }
  check('outputs-render-does-not-touch-fs', touched === '', touched);
  check('outputs-render-deterministic', htmlAgain.replace(/data-srcfile="[^"]*"/, '') === htmlOut.replace(/data-srcfile="[^"]*"/, ''));
  // --- 宣言なし・無効だけの宣言は従来どおり ---
  const plain = HEAD + '---\n' + BODY;
  const onlyBad = HEAD + 'outputs:\n  - 相対 || file: a\\b.csv\n  - 壊れ\n---\n' + BODY;
  const htmlPlain = render(plain, 'p.md');
  check('outputs-absent-no-panel-no-css', htmlPlain.indexOf('panel-outputs') === -1 && htmlPlain.indexOf('.out-open') === -1);
  check('outputs-only-invalid-same-as-absent', norm(render(onlyBad, 'p.md')) === norm(htmlPlain));
  // --- 状態の漏れ: 宣言あり → なし → あり、コードフェンスとの組み合わせを同じプロセスで順不同に描画 ---
  const fence = '\n```bash\necho 1\n```\n';
  const plainFence = HEAD + '---\n' + BODY + fence;
  const dsFm = 'da_scale: table\n';
  const tbl = '\n| a | b |\n|---|---|\n| 10 | 100 |\n| 20 | 200 |\n';
  const plainTbl = HEAD + '---\n' + BODY + tbl;
  const scaledTbl = HEAD + dsFm + '---\n' + BODY + tbl;
  const b0 = render(plainFence, 'b.md'), c0 = render(plain, 'c.md'), t0 = render(plainTbl, 't.md');
  const a1 = render(withOut + fence, 'a.md');
  const s1 = render(scaledTbl, 's.md');
  const b1 = render(plainFence, 'b.md'), c1 = render(plain, 'c.md'), t1 = render(plainTbl, 't.md');
  const a2 = render(withOut + fence, 'a.md');
  check('state-no-leak-after-outputs-doc', b1 === b0 && c1 === c0);
  check('state-no-leak-after-da-scale-doc', t1 === t0 && s1 !== t0);
  check('state-outputs-doc-repeatable', a1 === a2);
  // --- lint: 両側 ---
  const lintMd = (fmLines) => lint(HEAD + fmLines + '---\n' + BODY);
  const goodPath = process.platform === 'win32' ? __filename : null;
  if (goodPath) {
    const g = lintMd('outputs:\n  - 自身 || file: ' + goodPath + '\n');
    check('lint-outputs-clean-sample', !g.errors.some((e) => e.indexOf('outputs') !== -1) && !g.warnings.some((w) => w.indexOf('outputs') !== -1), JSON.stringify(g));
  }
  check('lint-outputs-broken-line', lintMd('outputs:\n  - 壊れた行\n').errors.some((e) => e.indexOf('outputs 宣言の不正行') !== -1));
  check('lint-outputs-not-absolute', lintMd('outputs:\n  - 相対 || file: a\\b.csv\n').errors.some((e) => e.indexOf('outputs: 相対') !== -1));
  check('lint-outputs-scalar-form', lintMd('outputs: [a, b]\n').errors.some((e) => e.indexOf('outputs 宣言: 値が空のブロック形') !== -1));
  check('lint-outputs-duplicate', lintMd('outputs:\n  - a || file: C:\\x\\y.csv\n  - b || file: c:/X/y.csv\n').errors.some((e) => e.indexOf('重複') !== -1));
  check('lint-outputs-missing-path-is-warning', (function () {
    const r = lintMd('outputs:\n  - 無い || file: Z:\\no\\such\\file.csv\n');
    return r.warnings.some((w) => w.indexOf('パスが実在しない') !== -1) && !r.errors.some((e) => e.indexOf('outputs') !== -1);
  })());
  check('lint-outputs-absent-silent', !lint(plain).warnings.concat(lint(plain).errors).some((x) => x.indexOf('outputs') !== -1));
  // --- 表: セル分割 (GFM) ---
  const sp = splitTableRow;
  const J = JSON.stringify;
  check('table-escaped-pipe-one-cell', J(sp('| x \\| y | z | w |')) === J(['x | y', 'z', 'w']), J(sp('| x \\| y | z | w |')));
  check('table-escaped-pipe-in-code', J(sp('| `p\\|q` | z |')) === J(['`p|q`', 'z']));
  check('table-two-backslashes-splits', J(sp('| a \\\\| b |')) === J(['a \\\\', 'b']), J(sp('| a \\\\| b |')));
  check('table-three-backslashes-escapes', J(sp('| a \\\\\\| b |')) === J(['a \\\\| b']), J(sp('| a \\\\\\| b |')));
  check('table-four-backslashes-splits', J(sp('| a \\\\\\\\| b |')) === J(['a \\\\\\\\', 'b']));
  check('table-trailing-escaped-pipe-is-content', J(sp('| a | b \\|')) === J(['a', 'b |']), J(sp('| a | b \\|')));
  check('table-no-pipe-escape-same-as-plain-split', ['| a | b | c |', 'a|b|c', '| a | b |', '|a||c|', '| `x|y` | z |', '| a \\ b | c |'].every((l) => {
    let s = l.trim(); if (s.startsWith('|')) s = s.slice(1); if (s.endsWith('|')) s = s.slice(0, -1);
    return J(sp(l)) === J(s.split('|').map((c) => c.trim()));
  }));
  // '\|' を含む表は、描画が '|' に戻しても --verify が両方向とも通る (従来合格した文書が退行しない)
  const escDoc = HEAD + '---\n' + BODY + '\n| a | b |\n|---|---|\n| x \\| y | `p\\|q` |\n| \\\\| z | w |\n';
  check('table-escaped-pipe-verify-both-ways', verifyBidirectional(escDoc).ok, J(verifyBidirectional(escDoc).fwd.violations));
  // --- 表: lint 両側 ---
  const tw = (t) => lint(HEAD + '---\n' + BODY + '\n' + t).warnings.filter((w) => w.indexOf('表の') !== -1);
  check('lint-table-aligned-silent', tw('| a | b |\n|---|---|\n| 1 | 2 |\n| x \\| y | 3 |\n').length === 0);
  check('lint-table-too-many-cells', tw('| a | b |\n|---|---|\n| `p|q` | 2 |\n').some((w) => w.indexOf('多い') !== -1));
  check('lint-table-too-few-cells', tw('| a | b |\n|---|---|\n| 1 |\n').some((w) => w.indexOf('少ない') !== -1));
  check('lint-table-separator-mismatch', tw('| a | b | c |\n|---|---|\n| 1 | 2 | 3 |\n').some((w) => w.indexOf('区切り行') !== -1));
  check('lint-table-line-number', tw('| a | b |\n|---|---|\n| 1 | 2 | 3 |\n').some((w) => /MD の (\d+) 行/.test(w)));
  // 引用・注記の中の表も、元の MD の行番号で知らせる (引用の各行は元の 1 行に 1:1 で対応する)
  const nestedDoc = '---\nreport_id: NL\n---\n\n# T\n\n> | a | b |\n> |---|---|\n> | 1 | 2 | 3 |\n\n> [!NOTE] x\n> | p | q |\n> |---|---|\n> | 1 |\n';
  const nestedW = lint(nestedDoc).warnings.filter((w) => w.indexOf('表の列数の食い違い') !== -1).join('\n');
  check('lint-table-nested-line-numbers', nestedW.indexOf('MD の 9 行') !== -1 && nestedW.indexOf('MD の 14 行') !== -1, nestedW);
  // --- DA バー: 印付き数・版数・日付 ---
  const numCol = (cells) => render(HEAD + '---\n' + BODY + '\n| k | v |\n|---|---|\n' + cells.map((c, i) => '| r' + i + ' | ' + c + ' |').join('\n') + '\n', 'n.md');
  const bars = (h) => (h.match(/class="bar"/g) || []).length;
  check('da-mark-column-has-bars', bars(numCol(['93*', '50', '20'])) === 3 && numCol(['93*', '50', '20']).indexOf('class="num-col"') !== -1);
  check('da-mark-display-keeps-mark', numCol(['93*', '50', '20']).indexOf('>93*<') !== -1);
  check('da-mark-variants', bars(numCol(['93†', '50‡', '20※'])) === 3 && bars(numCol(['93＊', '50%*', '20'])) === 3);
  check('da-version-and-date-not-numeric', bars(numCol(['v1.5.0', 'v1.6.0', 'v2.0.0'])) === 0 && bars(numCol(['2026-06-12', '2026-06-13', '2026-06-14'])) === 0);
  check('da-space-before-mark-not-numeric', bars(numCol(['93 *', '50', '20'])) === 0);
  // --- DA バー: da_scale: table ---
  const widths = (h) => (h.match(/class="bar" style="width:([0-9.]+)%/g) || []).map((x) => /width:([0-9.]+)%/.exec(x)[1]);
  // 幅は行の順 (1 行目の a・b、2 行目の a・b)。列ごとの尺度なら a=10,20 / b=100,200 → 50,50,100,100。表全体なら最大 200 → 5,50,10,100。
  check('da-scale-default-per-column', J(widths(t0)) === J(['50', '50', '100', '100']), J(widths(t0)));
  check('da-scale-table-shared', J(widths(s1)) === J(['5', '50', '10', '100']), J(widths(s1)));
  const pctMix = render(HEAD + dsFm + '---\n' + BODY + '\n| a | b |\n|---|---|\n| 10% | 100 |\n| 20% | 200 |\n', 'm.md');
  check('da-scale-table-percent-group-separate', J(widths(pctMix)) === J(['50', '50', '100', '100']), J(widths(pctMix)));
  check('lint-da-scale-unknown-value', lint(HEAD + 'da_scale: row\n---\n' + BODY).warnings.some((w) => w.indexOf('da_scale') !== -1));
  check('lint-da-scale-absent-silent', !lint(plain).warnings.some((w) => w.indexOf('da_scale') !== -1));
  return ok;
}

// 必須見出しの検査の自己検査: 見出しがコードブロック・引用・行の途中にあるだけでは合格しない。外に置けば合格する。
function selftestHeadings() {
  let ok = true;
  const check = (name, cond, detail) => {
    if (cond) {
      console.error('[SELFTEST OK]   ' + name);
    } else {
      ok = false;
      console.error('[SELFTEST FAIL] ' + name + (detail ? '\n  ' + detail : ''));
    }
  };
  const FM = '---\nreport_id: HD\n---\n\n# T\n\n';
  const PHRASES = ['## 本報告書の読者と目的', '## 結論の概要', '## 現在地', '## スコープ外提案（Pending）'];
  const MARKS = ['読者と目的', '結論の概要', 'Where 情報欠落', 'スコープ外会計欠落'];
  const missing = (md) => {
    const w = lint(md).warnings.join('\n');
    return MARKS.map((m) => w.includes(m));
  };
  const inFence = missing(FM + '```md\n' + PHRASES.join('\n') + '\n```\n');
  check('headings-only-in-fence-all-missing', inFence.every(Boolean), JSON.stringify(inFence));
  const inQuote = missing(FM + PHRASES.map((p) => '> ' + p).join('\n') + '\n');
  check('headings-only-in-blockquote-all-missing', inQuote.every(Boolean), JSON.stringify(inQuote));
  const midLine = missing(FM + PHRASES.map((p) => '文の途中の ' + p).join('\n\n') + '\n');
  check('headings-mid-line-all-missing', midLine.every(Boolean), JSON.stringify(midLine));
  const real = missing(FM + PHRASES.join('\n\n') + '\n');
  check('real-headings-none-missing', real.every((x) => !x), JSON.stringify(real));
  const closing = missing(FM + '## 現在地 ##\n\n');
  check('closing-hashes-still-match', closing[2] === false, JSON.stringify(closing));
  check('fence-heading-is-not-a-report', lint('# T\n\n```md\n## 本報告書の読者と目的\n```\n').isReport === false);
  check('real-heading-makes-a-report', lint('# T\n\n## 本報告書の読者と目的\n\n- x\n').isReport === true);
  return ok;
}

// チェック欄 (- [ ] 文 / - [x] 文) の不変条件。
//   描画・初期状態・印がテキストに残らないこと・双方向 verify・決定論・
//   チェック欄の無い文書には CSS/ローダを注入しないこと (render 毎のリセットを含む)。
function selftestTasks() {
  let ok = true;
  const check = (name, cond, detail) => {
    if (cond) console.error('[SELFTEST OK]   ' + name);
    else {
      ok = false;
      console.error('[SELFTEST FAIL] ' + name + (detail ? '\n  ' + detail : ''));
    }
  };
  const TASK_BODY =
    '# T\n\n## 本報告書の読者と目的\n\n- x\n\n## 手順\n\n### 手 1: 控え\n\n本文。\n\n' +
    '- [ ] 手 1 OK（期待値 A）\n- [x] 済みの項目\n- [X] 大文字の済み\n- 普通の項目\n- [ ]\n';
  const TASK_MD = '---\nreport_id: TK\ncomments: atomic\ncheckboxes: on\n---\n\n' + TASK_BODY;
  const UNDECL_MD = '---\nreport_id: TK\ncomments: atomic\n---\n\n' + TASK_BODY; // 宣言なし = 従来どおり文字
  const PLAIN_MD = '---\nreport_id: PL\n---\n\n# T\n\n## 本報告書の読者と目的\n\n- x\n- y\n';
  const h = render(TASK_MD, 'tk.md');
  const boxes = (h.match(/<input type="checkbox" class="task-box"/g) || []).length;
  check('tasks-three-boxes', boxes === 3, 'boxes=' + boxes);
  const checked = (h.match(/class="task-box" checked\/>/g) || []).length;
  check('tasks-x-and-X-start-checked', checked === 2, 'checked=' + checked);
  const texts = extractTextNodes(h).join('\n');
  check('tasks-marker-not-in-text', !/\[ \] 手 1|\[x\] 済み|\[X\] 大文字/.test(texts));
  check('tasks-bare-bracket-stays-literal', texts.includes('[ ]'));
  check('tasks-css-and-loader-once',
    (h.match(/li\.task\{list-style:none/g) || []).length === 1 &&
    (h.match(/ccpit-chk:/g) || []).length === 1);
  const vb = verifyBidirectional(TASK_MD);
  check('tasks-verify-bidirectional', vb.ok,
    JSON.stringify({ fwd: vb.fwd.ok, bwd: vb.bwd.ok, om: vb.bwd.omissions.slice(0, 3) }));
  check('tasks-deterministic', sha256(render(TASK_MD, 'tk.md')) === sha256(h));
  const p = render(PLAIN_MD, 'pl.md'); // TASK の直後に描く = フラグのリセット確認
  check('tasks-plain-doc-no-injection',
    !p.includes('task-box') && !p.includes('li.task{') && !p.includes('ccpit-chk:'));
  // 宣言なし (checkboxes 無し) の文書: TASK の直後に描いても - [ ] 文 は文字のまま・注入ゼロ・verify OK
  const u = render(UNDECL_MD, 'un.md');
  const utext = extractTextNodes(u).join('\n');
  check('tasks-undeclared-stays-literal',
    !u.includes('task-box') && !u.includes('ccpit-chk:') &&
    utext.includes('[ ] 手 1 OK') && utext.includes('[x] 済みの項目'));
  check('tasks-undeclared-verify-bidirectional', verifyBidirectional(UNDECL_MD).ok);
  // lint も同じ規則で読む (宣言の有無で必須見出し判定が変わらない)
  check('tasks-lint-same-report-judgement', lint(TASK_MD).isReport === lint(UNDECL_MD).isReport);
  // 保存キー: コメント機能を切った文書でも report_id があれば data-task-id が出る / id が無ければ出ない
  const off = render('---\nreport_id: OFF\ncomments: off\ncheckboxes: on\n---\n\n' + TASK_BODY, 'off.md');
  check('tasks-key-without-comments', off.includes(' data-task-id="OFF"') && off.includes('task-box'));
  const noid = render('---\ncheckboxes: on\n---\n\n# T\n\n- [ ] a\n', 'noid.md');
  // 属性として出たかで判定する (ローダの JS 本文にも属性名の文字列があるため)
  check('tasks-no-id-no-attr', noid.includes('task-box') && !noid.includes(' data-task-id="'));
  check('tasks-plain-doc-no-attr', !p.includes(' data-task-id="') && !u.includes(' data-task-id="'));
  // lint: checkboxes の値と中身の検査 (静かな無効化を警告にする。宣言の無い文書は無警告)
  const hasW = (r, re) => r.warnings.some((w) => re.test(w));
  check('tasks-lint-ok-no-warning',
    !hasW(lint(TASK_MD), /checkboxes/) && !hasW(lint(UNDECL_MD), /checkboxes/));
  check('tasks-lint-unknown-value-warns',
    hasW(lint('---\nreport_id: W\ncheckboxes: yes\n---\n\n' + TASK_BODY), /未知の checkboxes 値: "yes"/));
  check('tasks-lint-unknown-value-warns-non-report',
    hasW(lint('---\ncheckboxes: ture\n---\n\n# T\n\n- [ ] a\n'), /未知の checkboxes 値: "ture"/));
  check('tasks-lint-on-without-items-warns',
    hasW(lint('---\nreport_id: W\ncheckboxes: on\n---\n\n# T\n\n- a\n- b\n'), /有効なチェック項目が 1 件も無い/));
  check('tasks-lint-on-with-item-in-quote-ok',
    !hasW(lint('---\ncheckboxes: on\n---\n\n# T\n\n> - [ ] a\n'), /checkboxes/));
  check('tasks-lint-warning-not-blocking', lint('---\ncheckboxes: yes\n---\n\n# T\n\n- [ ] a\n').errors.length === 0);
  return ok;
}

function selftest() {
  let ok = true;
  for (const g of GOLDEN) {
    const got = sha256(render(g.md, g.name + '.md'));
    if (got !== g.sha) {
      ok = false;
      console.error('[SELFTEST FAIL] ' + g.name + '\n  expected ' + g.sha + '\n  got      ' + got);
    } else {
      console.error('[SELFTEST OK]   ' + g.name);
    }
  }
  if (!selftestFigLink()) ok = false; // 押せる図 (figure_links) の不変条件 (宣言なし扱いの同一性・差分の範囲・id の一意性)
  if (!selftestCite()) ok = false; // コード引用の実物照合 (偽の入出力で、ディスクにも git にも触れない)
  if (!selftestHeadings()) ok = false; // 必須見出しの検査 (コードブロック・引用・行の途中では合格しない)
  if (!selftestRedact()) ok = false; // redaction (--redact-apply / --leak-check) の positive+negative
  if (!selftestOutputsTables()) ok = false; // 成果物の欄・表のセル分割と列数の lint・DA バーの印付き数と尺度
  if (!selftestChapters()) ok = false; // SKILL.md の章立て (参照の切れ・梱包漏れ・本体の上限)
  if (!selftestFigView()) ok = false; // 図のビューア (注入の有無・状態の漏れ・軸の情報の読み取りと座標の換算)
  if (!selftestTasks()) ok = false; // チェック欄 (描画・初期状態・verify・非注入)
  return ok;
}

// ---------------------------------------------------------------------------
// --check: HTML 埋込 sha256 と現 MD sha256 を照合 (_index 鮮度 / 件2 ④ 先取り)
// ---------------------------------------------------------------------------

function check(mdPath, htmlPath) {
  setCiteSource(mdPath); // include の相対パスの起点と、実物のスナップショットを MD に合わせる
  const md = fs.readFileSync(mdPath, 'utf8');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const m = html.match(/data-src-sha256="([0-9a-f]{64})"/);
  if (!m) return { ok: false, reason: 'HTML に data-src-sha256 が無い' };
  const embedded = m[1];
  const current = sha256(md + citeExpansionTail(md));
  return { ok: embedded === current, embedded, current };
}

// ---------------------------------------------------------------------------
// redaction (件: 共有版=対外 の話者明示オフレコ/ぼかしを機械除去し漏えいを hard-fail)
//   --redact-apply <config.json> <in.md> <out.md>
//       alias を replacement へ置換 (テキストノード限定・URL/コードは触らない)・drop_hover の
//       hover エントリ/本文リンクを除去 → 匿名版 MD を機械生成 (DO NOT EDIT・来歴付き)。
//   --leak-check  <config.json> <file...>
//       alias(実名=どこでも禁止) と forbidden_headings(見出し文脈=機微章の取りこぼし) の
//       出現を全面走査 (正規化+デコード後) し、1 件でも exit≠0 (共有版ビルドの完了ゲート)。
//   config(JSON)= operator 専用・実名を持つ唯一の所在。配布物には一切置かない。
//   設計: redact-apply は壊さないため意図的にコード/URL を素通りさせ、その取りこぼしは
//         leak-check(より広い検査) が捕捉して人手対応に回す (置換と検査の責務分離)。
// ---------------------------------------------------------------------------

const REDACT_TOP_KEYS = new Set(['version', 'entries', 'forbidden_headings', 'contextual_terms']);
const REDACT_ENTRY_KEYS = new Set(['id', 'class', 'aliases', 'replacement', 'drop_hover', 'mode', 'leak_terms', 'note']);

// 厳格スキーマ: 未知キーは hard-fail (typo を無効設定として黙殺しない: Codex#11)。
function validateRedactConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('redact-config: オブジェクトでない');
  // "_" 接頭辞キーは注釈(無視)。それ以外の未知キーは hard-fail (typo を黙殺しない: Codex#11)。
  for (const k of Object.keys(cfg)) {
    if (k.startsWith('_')) continue;
    if (!REDACT_TOP_KEYS.has(k)) throw new Error('redact-config: 未知のトップキー "' + k + '"');
  }
  if (!Array.isArray(cfg.entries)) throw new Error('redact-config: entries[] が必要');
  for (const e of cfg.entries) {
    for (const k of Object.keys(e)) {
      if (k.startsWith('_')) continue;
      if (!REDACT_ENTRY_KEYS.has(k)) throw new Error('redact-config: entry 未知キー "' + k + '" (id=' + (e.id || '?') + ')');
    }
    if (!e.id) throw new Error('redact-config: entry に id が必要');
    if (!Array.isArray(e.aliases) || e.aliases.length === 0) throw new Error('redact-config: entry.aliases[] が必要 (id=' + e.id + ')');
    for (const a of e.aliases) if (typeof a !== 'string' || a === '') throw new Error('redact-config: alias は非空文字列 (id=' + e.id + ')');
    if (typeof e.replacement !== 'string' || e.replacement === '') throw new Error('redact-config: entry.replacement(非空文字列) が必要 (id=' + e.id + ')');
  }
  // replacement が秘匿語(alias/leak_term)を含むと再置換/漏えいの原因 (Codex impl#6)。
  const secretTerms = [];
  for (const e of cfg.entries) { secretTerms.push(...e.aliases); if (Array.isArray(e.leak_terms)) secretTerms.push(...e.leak_terms); }
  for (const e of cfg.entries) {
    for (const t of secretTerms) {
      if (t && e.replacement.includes(t)) throw new Error('redact-config: replacement "' + e.replacement + '" が秘匿語 "' + t + '" を含む (id=' + e.id + ')');
    }
  }
  if (cfg.forbidden_headings && !Array.isArray(cfg.forbidden_headings)) throw new Error('redact-config: forbidden_headings は配列');
  return cfg;
}

function loadRedactConfig(p) {
  return validateRedactConfig(JSON.parse(fs.readFileSync(p, 'utf8')));
}

// %XX 連を安全にデコード (壊れた % は素通り)。
function safePercentDecode(s) {
  return String(s).replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
    try { return decodeURIComponent(seq); } catch (_) { return seq; }
  });
}
// 多重 %エンコード (%25E5… 二重) を不動点まで展開 (上限3回・無限展開防止)。
function multiPercentDecode(s) {
  let prev = String(s);
  for (let k = 0; k < 3; k++) { const next = safePercentDecode(prev); if (next === prev) break; prev = next; }
  return prev;
}
// 数値文字参照 &#DDD; / &#xHHH; を復号 (decodeEntities は名前付き5種のみ=穴: Codex impl#1)。
//   HTML 成果物で alias を &#23665;&#37326; 形式に隠す経路を塞ぐ。leak-check 専用 (検出器を生成器より強く)。
function decodeNumericEntities(s) {
  return String(s)
    .replace(/&#x([0-9A-Fa-f]+);?/g, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return m; } })
    .replace(/&#(\d+);?/g, (m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (_) { return m; } });
}
// JS/CSS の \uXXXX / \u{…} / \xNN エスケープを復号 (script/style 内に alias を隠す経路: Codex impl#3)。
function decodeJsUnicode(s) {
  return String(s)
    .replace(/\\u\{([0-9A-Fa-f]+)\}/g, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return m; } })
    .replace(/\\u([0-9A-Fa-f]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

// leak 検査用の強正規化: 実体参照/URL%デコード + NFKC + ゼロ幅除去 + 全空白畳み込み + ASCII casefold。
//   分割/エンコード/全半角/異体字越しの alias 出現も拾う (置換より検査を広く: Codex#3/#6)。
//   canon と異なり URL 内容は捨てない (alias が URL に潜む経路を塞ぐ)。
function normForLeak(s) {
  let t = String(s);
  // 混在/多重エンコード(%26%23x..%3B のように percent×数値文字参照を入れ子化した経路) を
  //   不動点まで展開 (順序非依存・上限6回・無限展開防止: Codex impl2#1)。
  for (let k = 0; k < 6; k++) {
    const before = t;
    t = safePercentDecode(t);
    t = decodeEntities(t);
    t = decodeNumericEntities(t);
    t = decodeJsUnicode(t);
    if (t === before) break;
  }
  t = t.normalize('NFKC');
  t = t.replace(/[​‌‍⁠﻿]/g, ''); // ゼロ幅
  t = t.replace(/\s+/g, '');                              // 全空白
  return t.toLowerCase();
}

// inline トークナイズ (renderInline と同じ文法): code span(`...`) / link [t](u) / autolink<u> / bare URL / text。
//   code と URL(リンク url 部・autolink・bare) は置換対象外として分離する (Codex#4: URL/コード破壊回避)。
function tokenizeInlineForRedact(s) {
  const toks = [];
  let i = 0, buf = '';
  const flush = () => { if (buf) { toks.push({ t: 'text', v: buf }); buf = ''; } };
  while (i < s.length) {
    const c = s[i];
    if (c === '`') { // code span
      const end = s.indexOf('`', i + 1);
      if (end !== -1) { flush(); toks.push({ t: 'keep', v: s.slice(i, end + 1) }); i = end + 1; continue; }
    }
    if (c === '[') { // link [text](url)
      const close = s.indexOf(']', i + 1);
      if (close !== -1 && s[close + 1] === '(') {
        const paren = s.indexOf(')', close + 2);
        if (paren !== -1) { flush(); toks.push({ t: 'link', text: s.slice(i + 1, close), url: s.slice(close + 2, paren) }); i = paren + 1; continue; }
      }
    }
    if (c === '<') { // autolink <url>
      const gt = s.indexOf('>', i + 1);
      if (gt !== -1 && /^<https?:\/\/[^>]+>$/.test(s.slice(i, gt + 1))) { flush(); toks.push({ t: 'keep', v: s.slice(i, gt + 1) }); i = gt + 1; continue; }
    }
    if ((c === 'h' || c === 'H') && /^https?:\/\//i.test(s.slice(i))) { // bare URL
      const m = s.slice(i).match(/^https?:\/\/\S+/i);
      if (m) { flush(); toks.push({ t: 'keep', v: m[0] }); i += m[0].length; continue; }
    }
    buf += c; i++;
  }
  flush();
  return toks;
}

// テキストノード内の alias を最長一致優先で置換し、実置換数を report に積む。
function replaceAliasesInText(text, sortedAliases, aliasRepl, report) {
  let out = text;
  for (const a of sortedAliases) {
    if (!a || out.indexOf(a) === -1) continue;
    const parts = out.split(a);
    const n = parts.length - 1;
    out = parts.join(aliasRepl.get(a));
    if (report) report.replaced[a] = (report.replaced[a] || 0) + n;
  }
  return out;
}

// MD → 匿名版 MD。frontmatter の hover: ブロックと本文を node 種別で処理する。
function redactApply(md, cfg) {
  const report = { replaced: {}, droppedHover: 0, delinked: 0 };
  const aliasRepl = new Map();
  const dropHoverAliases = [];
  for (const e of cfg.entries) {
    for (const a of e.aliases) aliasRepl.set(a, e.replacement);
    if (e.drop_hover) dropHoverAliases.push(...e.aliases);
  }
  const sortedAliases = Array.from(aliasRepl.keys()).sort((x, y) => y.length - x.length); // 最長一致優先
  const urlHasDropAlias = (url) => dropHoverAliases.some((a) => a && url.includes(a));

  const lines = md.split(/\r?\n/);
  let fmEnd = -1;
  if (lines[0] === '---') {
    for (let i = 1; i < lines.length; i++) { if (lines[i].trim() === '---') { fmEnd = i; break; } }
  }
  const out = [];
  let inHover = false;
  let inFence = false, fenceCh = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // ---- frontmatter ----
    if (fmEnd !== -1 && i <= fmEnd) {
      if (i === 0 || i === fmEnd) { out.push(line); continue; }
      if (/^hover:\s*$/.test(line)) { inHover = true; out.push(line); continue; }
      if (inHover) {
        if (!/^\s+\S/.test(line)) { inHover = false; out.push(line); continue; }
        const cm = line.match(/^(\s+-\s+)([^|]*?)\s*\|\|\s*(.*)$/);
        if (cm) {
          const key = cm[2].trim();      // 識別子(URL)
          const summary = cm[3];
          if (dropHoverAliases.some((a) => a && (key.includes(a) || summary.includes(a)))) { report.droppedHover++; continue; }
          out.push(cm[1] + key + ' || ' + replaceAliasesInText(summary, sortedAliases, aliasRepl, report));
          continue;
        }
        out.push(line); continue;
      }
      out.push(line); continue; // 他 frontmatter キーは値を触らない (leak-check が捕捉)
    }
    // ---- body ----
    const fmark = line.match(/^(\s*)(```+|~~~+)/);
    if (fmark) {
      if (!inFence) { inFence = true; fenceCh = fmark[2][0]; }
      else if (fmark[2][0] === fenceCh) { inFence = false; fenceCh = ''; }
      out.push(line); continue;
    }
    if (inFence) { out.push(line); continue; }
    const toks = tokenizeInlineForRedact(line);
    let rebuilt = '';
    for (const tk of toks) {
      if (tk.t === 'text') rebuilt += replaceAliasesInText(tk.v, sortedAliases, aliasRepl, report);
      else if (tk.t === 'keep') rebuilt += tk.v;
      else if (tk.t === 'link') {
        if (urlHasDropAlias(tk.url)) { report.delinked++; rebuilt += replaceAliasesInText(tk.text, sortedAliases, aliasRepl, report); }
        else rebuilt += '[' + replaceAliasesInText(tk.text, sortedAliases, aliasRepl, report) + '](' + tk.url + ')';
      }
    }
    out.push(rebuilt);
  }
  return { out: out.join('\n'), report };
}

// 漏えい検査 (file ベースでなく {name, content} で受け selftest を純粋化)。
function leakCheckContents(items, cfg) {
  const aliasNeedles = [];
  for (const e of cfg.entries) {
    for (const a of e.aliases) aliasNeedles.push({ id: e.id, term: a, norm: normForLeak(a) });
    if (Array.isArray(e.leak_terms)) for (const t of e.leak_terms) aliasNeedles.push({ id: e.id, term: t, norm: normForLeak(t) });
  }
  const headingNeedles = (cfg.forbidden_headings || []).map((h) => ({ term: h, norm: normForLeak(h) }));
  const violations = [];
  const warnings = [];
  for (const it of items) {
    const base = it.name;
    const isMd = /\.md$/i.test(base);
    const nameNorm = normForLeak(base);
    for (const n of aliasNeedles) if (n.norm && nameNorm.includes(n.norm)) violations.push({ file: base, kind: 'alias(filename)', id: n.id, term: n.term });
    const raw = it.content;
    const whole = normForLeak(raw); // 全面 (本文/属性/data/meta/url …)
    for (const n of aliasNeedles) if (n.norm && whole.includes(n.norm)) violations.push({ file: base, kind: 'alias', id: n.id, term: n.term });
    // forbidden_headings: 見出し文脈のみ (散文 FP 回避)
    const headingTexts = [];
    if (isMd) raw.split(/\r?\n/).forEach((ln) => { const m = ln.match(/^#{1,6}\s+(.*)$/); if (m) headingTexts.push(m[1]); });
    else { const re = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi; let m; while ((m = re.exec(raw))) headingTexts.push(m[1].replace(/<[^>]+>/g, '')); }
    const headNorm = headingTexts.map(normForLeak);
    for (const h of headingNeedles) if (h.norm && headNorm.some((ht) => ht.includes(h.norm))) violations.push({ file: base, kind: 'forbidden_heading', term: h.term });
    // 金額 mention は WARN のみ (正当な金額表記=売上/予算/支援額 等で FP しブロックしないため: Codex#7)
    const money = raw.match(/[0-9０-９]+\s*(?:億|万)\s*円?/g);
    if (money) warnings.push({ file: base, kind: 'money_mention', samples: Array.from(new Set(money)).slice(0, 12) });
  }
  return { ok: violations.length === 0, violations, warnings };
}

// positive(匿名版 PASS) + negative(alias/コード内/見出し/原文 で必ず落ちる) selftest。
function selftestRedact() {
  let ok = true;
  const fail = (msg) => { ok = false; console.error('[SELFTEST FAIL] redact: ' + msg); };
  const cfg = validateRedactConfig({ version: 1, entries: [{ id: 'org', class: 'explicit', aliases: ['アクメ社', 'アクメ'], replacement: '某社', drop_hover: true }], forbidden_headings: ['機微情報'] });

  // positive: alias を text/link/hover のみに持つ → 完全匿名化 → leak PASS
  const clean = '---\nhover:\n  - https://ja.wikipedia.org/wiki/アクメ社 || アクメ社の説明。\n  - https://example.com/x || 無関係。\n---\n\n# T\n\n## 概要\n\n- **[アクメ社](https://ja.wikipedia.org/wiki/アクメ社)**の社員。一般に アクメ社 と呼ぶ。\n';
  const r1 = redactApply(clean, cfg);
  if (r1.report.droppedHover !== 1) fail('positive droppedHover=1 のはず: ' + r1.report.droppedHover);
  if (r1.report.delinked !== 1) fail('positive delinked=1 のはず: ' + r1.report.delinked);
  if (!/\*\*某社\*\*の社員/.test(r1.out)) fail('positive delink 置換失敗');
  if (/アクメ/.test(r1.out)) fail('positive alias 残存: ' + r1.out);
  const lc1 = leakCheckContents([{ name: 'clean.md', content: r1.out }], cfg);
  if (!lc1.ok) fail('positive leak PASS のはず: ' + JSON.stringify(lc1.violations));

  // negative1: 原文(alias 残) → leak FAIL
  if (leakCheckContents([{ name: 'dirty.md', content: clean }], cfg).ok) fail('negative 原文は FAIL のはず');
  // negative2: code span 内 alias は redact-apply が触らない → leak が捕捉
  const r3 = redactApply('---\n---\n\n# T\n\nコード `アクメ社API` を参照。\n', cfg);
  if (!/`アクメ社API`/.test(r3.out)) fail('negative code span 不変のはず: ' + r3.out);
  if (leakCheckContents([{ name: 'code.md', content: r3.out }], cfg).ok) fail('negative code 内 alias を捕捉のはず');
  // negative3: forbidden_heading 見出し → FAIL
  if (leakCheckContents([{ name: 'h.md', content: '# T\n\n## 機微情報\n\n秘密。\n' }], cfg).ok) fail('negative forbidden_heading 捕捉のはず');
  // negative4: ファイル名に alias → FAIL
  if (leakCheckContents([{ name: 'アクメ社_share.html', content: '<h1>x</h1>' }], cfg).ok) fail('negative filename alias 捕捉のはず');
  // negative5: 数値文字参照で隠した alias も捕捉 (検出器強化: アクメ=U+30A2/30AF/30E1)
  if (leakCheckContents([{ name: 'ent.html', content: '<p>&#x30A2;&#x30AF;&#x30E1;社</p>' }], cfg).ok) fail('negative 数値文字参照 alias を捕捉のはず');
  // negative6: JS \uXXXX で隠した alias も捕捉 ('\\u' はソース上のリテラル \u)
  if (leakCheckContents([{ name: 'js.html', content: '<script>var x="\\u30A2\\u30AF\\u30E1社"</script>' }], cfg).ok) fail('negative JS \\u alias を捕捉のはず');
  // negative7: percent×数値文字参照の入れ子 (%26%23x30A2%3B…) も不動点デコードで捕捉
  if (leakCheckContents([{ name: 'nest.html', content: '<p>%26%23x30A2%3B%26%23x30AF%3B%26%23x30E1%3B社</p>' }], cfg).ok) fail('negative 多重エンコード alias を捕捉のはず');
  // strict schema: 未知キー → throw
  let threw = false; try { validateRedactConfig({ version: 1, entries: [], bogus: 1 }); } catch (_) { threw = true; }
  if (!threw) fail('strict schema 未知キーで throw のはず');
  // config footgun: replacement が alias を含む → throw (再置換/漏えい防止)
  let threw2 = false; try { validateRedactConfig({ version: 1, entries: [{ id: 'x', aliases: ['社'], replacement: '某社' }] }); } catch (_) { threw2 = true; }
  if (!threw2) fail('config: replacement が alias を含むとき throw のはず');

  if (ok) console.error('[SELFTEST OK]   redact (positive + negative 9)');
  return ok;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === '--selftest') {
    process.exit(selftest() ? 0 : 1);
  }

  if (argv[0] === '--verify' || argv[0] === '--verify-html' || argv[0] === '--verify-md') {
    const inPath = argv[1];
    if (!inPath) {
      console.error('usage: md2html.cjs --verify <in.md>  (双方向: HTML⊆MD + MD⊆HTML)');
      process.exit(2);
    }
    setCiteSource(inPath);
    const md = fs.readFileSync(inPath, 'utf8');
    const base = path.basename(inPath);
    const onlyHtml = argv[0] === '--verify-html';
    const onlyMd = argv[0] === '--verify-md';
    let bad = false;

    if (!onlyMd) {
      const f = verify(md); // HTML ⊆ MD (捏造防止)
      if (f.ok) {
        console.error('[VERIFY HTML⊆MD OK] ' + f.total + ' text nodes ⊆ MD : ' + base);
      } else {
        bad = true;
        console.error('[VERIFY HTML⊆MD FAIL] ' + f.violations.length + ' / ' + f.total + ' 捏造テキスト:');
        f.violations.slice(0, 30).forEach((v) => console.error('  ✗(捏造) ' + JSON.stringify(v)));
      }
    }
    if (!onlyHtml) {
      const b = verifyCompleteness(md); // MD ⊆ HTML (欠落防止)
      if (b.ok) {
        console.error('[VERIFY MD⊆HTML OK] ' + b.total + ' blocks 被覆 : ' + base);
      } else {
        bad = true;
        console.error('[VERIFY MD⊆HTML FAIL] ' + b.omissions.length + ' / ' + b.total + ' 欠落ブロック:');
        b.omissions.slice(0, 30).forEach((v) => console.error('  ✗(欠落) ' + JSON.stringify(v)));
      }
    }
    // コード引用 (cite= / include=) の実物照合を --verify に連結する。宣言が 1 つも無い文書は何も出さず、結果も変えない。
    // 照合できない (UNVERIFIABLE) も失敗。スキップする手段は作らない (--verify は出力要件 3 で必須のため、走らせ忘れの穴を増やさない)。
    if (!onlyHtml && !onlyMd) {
      const cr = verifyCites(md);
      if (cr.declared > 0) {
        if (cr.failures.length === 0) {
          const nInc = cr.items.filter((i) => i.kind === 'include').length;
          console.error('[VERIFY CITE OK] ' + cr.declared + ' 件 実物と一致 (cite ' + (cr.declared - nInc) + ' / include ' + nInc + ') : ' + base);
          cr.items.forEach((i) =>
            console.error('  ✓ ' + i.kind + ' ' + i.spec + ' → ' + i.res.abs + (i.res.fullRev ? ' @' + i.res.fullRev : ' (作業ツリー)'))
          );
        } else {
          bad = true;
          console.error('[VERIFY CITE FAIL] ' + cr.failures.length + ' / ' + cr.declared + ' 件が実物と合わない : ' + base);
          cr.items.forEach((i) => {
            if (i.res.ok) return;
            const tag = i.res.tag === 'UNVERIFIABLE' ? '[UNVERIFIABLE 照合できない]' : '[' + i.res.tag + ']';
            console.error('  ✗ ' + tag + ' ' + i.kind + '=' + JSON.stringify(i.spec) + (i.rev ? ' rev=' + i.rev : '') + ' — ' + i.res.detail);
          });
        }
      }
    }
    // figures 宣言-実体検査を --verify に連結する (2026-09-09)。
    // --lint は任意実行だったため丸ごと飛ばせた (実発生: 完了報告が --verify OK のまま --lint exit 1 で提出された)。
    // --verify は出力要件 3 で必須のため、ここに繋げば figures 検査を飛ばす経路が無くなる。
    // 移行措置は lint() 内で doc_id 日付により機械判定され epoch 前は警告へ降格するので遡及ブロックは起きない。
    // 部分モード (--verify-html / --verify-md) は純粋な部分検査として据え置く。
    if (!onlyHtml && !onlyMd) {
      const lr = lint(md);
      // 非報告書の lint は押せる図 (figure_links) の errors だけを返す。報告書型は従来どおり figures 検査の errors。
      if (lr.errors.length > 0) {
        bad = true;
        console.error('[VERIFY FIGURES FAIL] 宣言-実体検査 (figures・figure_links・outputs) ' + lr.errors.length + ' 件 : ' + base);
        lr.errors.forEach((e) => console.error('  ✗ ' + e));
      }
    }
    process.exit(bad ? 1 : 0);
  }

  if (argv[0] === '--lint') {
    const inPath = argv[1];
    if (!inPath) {
      console.error('usage: md2html.cjs --lint <in.md>');
      process.exit(2);
    }
    setCiteSource(inPath);
    const md = fs.readFileSync(inPath, 'utf8');
    const r = lint(md);
    if (!r.isReport && r.warnings.length === 0 && r.errors.length === 0) {
      console.error('[LINT] 非報告書 (frontmatter 報告書型でない) — スキップ: ' + path.basename(inPath));
      process.exit(0);
    }
    if (r.warnings.length === 0) {
      console.error('[LINT OK] 必須マーカー充足: ' + path.basename(inPath));
    } else {
      console.error('[LINT WARN] ' + r.warnings.length + ' 件 (' + path.basename(inPath) + '):');
      r.warnings.forEach((w) => console.error('  ⚠ ' + w));
    }
    if (r.errors.length > 0) {
      console.error('[LINT ERROR] 宣言-実体検査 (figures・figure_links・outputs) ' + r.errors.length + ' 件 (' + path.basename(inPath) + '):');
      r.errors.forEach((e) => console.error('  ✗ ' + e));
      process.exit(1); // figures 違反はブロック (新規報告書にのみ実行する運用 = 移行措置)
    }
    process.exit(0); // 警告のみ。ブロックしない
  }

  if (argv[0] === '--check') {
    const mdPath = argv[1];
    const htmlPath = argv[2];
    if (!mdPath || !htmlPath) {
      console.error('usage: md2html.cjs --check <in.md> <out.html>');
      process.exit(2);
    }
    const r = check(mdPath, htmlPath);
    if (r.ok) {
      console.error('[CHECK OK] HTML は最新: ' + path.basename(htmlPath));
      process.exit(0);
    }
    console.error('[CHECK STALE] ' + (r.reason || 'sha256 不一致') + ' : ' + path.basename(htmlPath));
    if (r.embedded) console.error('  embedded=' + r.embedded.slice(0, 12) + ' current=' + r.current.slice(0, 12));
    process.exit(1);
  }

  if (argv[0] === '--redact-apply') {
    const cfgPath = argv[1], inPath = argv[2], outPath = argv[3];
    if (!cfgPath || !inPath || !outPath) {
      console.error('usage: md2html.cjs --redact-apply <config.json> <in.md> <out.md>');
      process.exit(2);
    }
    const cfg = loadRedactConfig(cfgPath);
    const md = fs.readFileSync(inPath, 'utf8');
    const { out, report } = redactApply(md, cfg);
    const cfgSha = sha256(fs.readFileSync(cfgPath, 'utf8')).slice(0, 16);
    // DO NOT EDIT + 来歴を frontmatter 内の単独行 (キー扱い・renderには出ない) で付す。
    const stamp = 'generated_do_not_edit: redact-apply src=' + path.basename(inPath) + ' config-sha=' + cfgSha;
    let final;
    if (out.startsWith('---\n')) final = '---\n' + stamp + '\n' + out.slice(4);
    else if (out.startsWith('---\r\n')) final = '---\n' + stamp + '\n' + out.slice(5);
    else final = out; // frontmatter 無し文書はスタンプ省略
    fs.writeFileSync(outPath, final, 'utf8');
    const auditPath = outPath.replace(/\.md$/i, '') + '.redact-report.json';
    fs.writeFileSync(auditPath, JSON.stringify({ source: path.basename(inPath), configSha: cfgSha, report }, null, 2), 'utf8');
    console.error('[REDACT-APPLY] ' + path.basename(inPath) + ' → ' + path.basename(outPath) +
      ' | replaced=' + JSON.stringify(report.replaced) + ' droppedHover=' + report.droppedHover + ' delinked=' + report.delinked);
    process.exit(0);
  }

  if (argv[0] === '--leak-check') {
    const cfgPath = argv[1];
    const files = argv.slice(2);
    if (!cfgPath || files.length === 0) {
      console.error('usage: md2html.cjs --leak-check <config.json> <file...>');
      process.exit(2);
    }
    const cfg = loadRedactConfig(cfgPath);
    const items = files.map((f) => ({ name: path.basename(f), content: fs.readFileSync(f, 'utf8') }));
    const r = leakCheckContents(items, cfg);
    r.warnings.forEach((w) => console.error('[LEAK-CHECK WARN] ' + w.file + ' ' + w.kind + ': ' + (w.samples || []).join(' ')));
    if (r.ok) {
      console.error('[LEAK-CHECK OK] ' + files.length + ' files: alias / forbidden-heading 0 件 (正規化+デコード後 全面)');
      process.exit(0);
    }
    console.error('[LEAK-CHECK FAIL] ' + r.violations.length + ' 件:');
    r.violations.forEach((v) => console.error('  ✗ ' + v.file + ' [' + v.kind + '] ' + (v.id ? v.id + ':' : '') + v.term));
    process.exit(1);
  }

  // 既定: render
  const stdoutCount = argv.filter((a) => a === '--stdout').length;
  if (stdoutCount > 1) {
    console.error('[ERROR] --stdout が重複して指定されています。');
    console.error('usage: md2html.cjs <in.md> <out.html | - | --stdout>');
    process.exit(2);
  }

  const posArgs = argv.filter((a) => a !== '--stdout');
  if (posArgs.length === 0) {
    console.error('usage: md2html.cjs <in.md> <out.html | - | --stdout> | --verify | --lint | --selftest | --check');
    process.exit(2);
  }

  const inPath = posArgs[0];
  let isStdout = false;
  let outPath = null;

  if (posArgs.length === 1) {
    if (stdoutCount === 1) {
      isStdout = true;
    } else {
      console.error('[ERROR] 出力先が指定されていません。ファイル出力は <out.html>、画面出力（標準出力）は \'-\' または \'--stdout\' を明示してください。');
      console.error('usage: md2html.cjs <in.md> <out.html | - | --stdout>');
      process.exit(2);
    }
  } else if (posArgs.length === 2) {
    if (posArgs[1] === '-') {
      if (stdoutCount === 1) {
        console.error('[ERROR] 画面出力の指定が重複しています (\'-\' と \'--stdout\')。');
        console.error('usage: md2html.cjs <in.md> <out.html | - | --stdout>');
        process.exit(2);
      }
      isStdout = true;
    } else {
      if (stdoutCount === 1) {
        console.error('[ERROR] 出力先が矛盾しています。ファイル出力 (<out.html>) と画面出力 (--stdout) を同時に指定することはできません。');
        console.error('usage: md2html.cjs <in.md> <out.html | - | --stdout>');
        process.exit(2);
      }
      outPath = posArgs[1];
    }
  } else {
    console.error('[ERROR] 引数が多すぎます。');
    console.error('usage: md2html.cjs <in.md> <out.html | - | --stdout>');
    process.exit(2);
  }

  // 引数検査をすべて通過した後に初めて入力読み込み・レンダリングを実行（副作用・無駄処理ゼロ）
  setCiteSource(inPath);
  const md = fs.readFileSync(inPath, 'utf8');
  let html;
  try {
    html = render(md, path.basename(inPath));
  } catch (e) {
    if (!e || !e.citeFailure) throw e;
    // include の展開に失敗した文書は HTML を作らない (本文の欠けた HTML を黙って出さない)。出力先も書き換えない。
    console.error('[RENDER FAIL] ' + e.message);
    process.exit(1);
  }
  if (isStdout) {
    console.error('[RENDER] ' + path.basename(inPath) + ' → stdout (' + html.length + ' chars / ' + Buffer.byteLength(html, 'utf8') + ' bytes)');
    process.stdout.write(html);
  } else {
    fs.writeFileSync(outPath, html, 'utf8');
    console.error('[RENDER] ' + path.basename(inPath) + ' → ' + outPath + ' (' + html.length + ' chars / ' + Buffer.byteLength(html, 'utf8') + ' bytes)');
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  render, verify, verifyCompleteness, verifyBidirectional, lint, selftest, check,
  sha256, tokenize, parseFrontmatter, extractTextNodes, buildCorpus, canon, normForMatch, collectPieces,
  validateRedactConfig, redactApply, leakCheckContents, normForLeak, selftestRedact,
  selftestFigLink, figLinkDiscover, figLinkDecls,
  verifyCites, setCiteSource, hasHeadingBlock, citeSecretPathReason, citeSecretContentHit, citeCredentialBlockHit,
  parseOutputLine, outputPathProblem, outputFileUrl, outputsDecls, outputKey, outputDirOf,
  splitTableRow, checkChapterLinks, checkChapterSet, SKILL_CHAPTERS,
};
