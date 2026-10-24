---
name: vendor-safeguard-refusal-triage
description: ベンダー側の非公開分類器（API の safeguards 等）にリクエストを丸ごと拒否され、現在のセッションが停止しているときに発火する。表示文言でなく transcript の生レコードで拒否カテゴリを確定し、全セッションのコホート集計で原因仮説を反証し、公式一次資料で判定対象と申請窓口の有無を確かめ、停止条件つきの復帰動線を出す。判定ロジックを手元で再現できる検出器（lint・ヘルスチェック・自己診断 UI）の誤検知判定には使わない（detector-signal-fidelity-triage の領分）。停止していない過去事例の説明だけが目的なら発火しない（investigation で足りる）。

---

# ベンダー分類器による拒否の切り分けと復帰

## 適用範囲と、この手順で分かること

**対象**: 判定ロジックが非公開で手元で再現できない外部分類器による拒否。再現による二値判定ができないため、観察データのコホートで**仮説を反証する**しかない。

**この手順で分かること・分からないこと**: 観察データゆえ**因果の特定はできない**。できるのは (1) 立てた仮説の反証 (2) 実務判断に足る確度の高い相関の提示 (3) 一次資料との照合、の 3 つ。未観測の交絡は残る。結論は必ずこの限界つきで書く。

**非対象**: 手元で再現できる検出器は `detector-signal-fidelity-triage` が扱う。停止しておらず説明だけが要るなら `investigation` で足りる。

## 手順

### 1. 表示文言でなく生レコードで拒否を確定する

画面に出る文言は定型文で、**実際の拒否カテゴリと食い違うことがある**（画面は一般的な利用規約ページを指し、生データは別条項を挙げている、等）。必ず transcript の実レコードを読む。

下のスクリプトを作業用ディレクトリへ置いて実行する。JSONL の構造（1 行 1 イベント、`type` / `message.content` のブロック配列）は `session-transcript-excavation` が正本。

```javascript
// refusal-census.cjs — 拒否イベントの全数抽出とコホート集計
// 使い方: node refusal-census.cjs [projectsDir]
const fs = require('fs'), path = require('path');
const BASE = process.argv[2] || path.join(require('os').homedir(), '.claude', 'projects');
const files = [];
(function walk(d) {
  let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (x) { return; }
  for (const n of e) { const p = path.join(d, n.name); if (n.isDirectory()) walk(p); else if (n.name.endsWith('.jsonl')) files.push(p); }
})(BASE);

const events = [], sessions = [];
let excluded = 0, excludedWithRefusal = 0;
for (const fp of files) {
  let txt; try { txt = fs.readFileSync(fp, 'utf8'); } catch (e) { continue; }
  const mb = Buffer.byteLength(txt) / 1048576;
  // 2 パス: 先に uuid -> レコードの索引を作る（refusedUserMessageUuid を解決するため）
  const objs = [], byUuid = new Map(), idxByUuid = new Map();
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    if (o.uuid) { byUuid.set(o.uuid, o); idxByUuid.set(o.uuid, objs.length); }
    objs.push(o);
  }
  // 区間 (from, to) の tool_use 数。UUID 基準の指標を直近 user 基準と別に出すために使う。
  const countTools = (from, to) => {
    let c = 0;
    for (let i = from + 1; i < to; i++) {
      const mm = objs[i].message || {};
      if (objs[i].type === 'assistant' && Array.isArray(mm.content)) for (const b of mm.content) if (b && b.type === 'tool_use') c++;
    }
    return c;
  };
  const fam = { }; let refusals = 0; let lastUserTs = null, toolsSince = 0;
  for (let oi = 0; oi < objs.length; oi++) {
    const o = objs[oi];
    const m = o.message || {};
    if (m.model && m.model !== '<synthetic>') {
      const k = String(m.model).replace(/\[.*$/, '');
      fam[k] = (fam[k] || 0) + 1;
    }
    if (o.type === 'user' && typeof m.content === 'string' && m.content.trim() && !m.content.startsWith('<')) { lastUserTs = o.timestamp; toolsSince = 0; }
    if (o.type === 'assistant' && Array.isArray(m.content)) for (const b of m.content) if (b && b.type === 'tool_use') toolsSince++;
    // 実イベントのみ計上（テキスト中の文字列出現は数えない＝自己汚染ガード）
    if (o.type === 'system' && typeof o.subtype === 'string' && o.subtype.indexOf('refusal') >= 0) {
      refusals++;
      // 指標は「拒否対象として記録されたメッセージ」を基準に取る。直近 user 基準も併記し、
      // 食い違い（= 拒否対象が直前の発言ではない）を見えるようにする。
      const ru = o.refusedUserMessageUuid ? byUuid.get(o.refusedUserMessageUuid) : null;
      const refTs = ru && ru.timestamp ? ru.timestamp : null;
      const mins = (from) => from && o.timestamp ? ((new Date(o.timestamp) - new Date(from)) / 60000).toFixed(1) : '-';
      const startIdx = o.refusedUserMessageUuid ? idxByUuid.get(o.refusedUserMessageUuid) : undefined;
      events.push({
        ts: o.timestamp, cat: o.apiRefusalCategory || '?', sub: o.subtype,
        model: o.originalModel || '?',
        refUuid: o.refusedUserMessageUuid ? String(o.refusedUserMessageUuid).slice(0, 8) : 'none',
        refResolved: ru ? 'yes' : (o.refusedUserMessageUuid ? 'UNRESOLVED' : 'n/a'),
        minFromRefused: mins(refTs), minFromLastUser: mins(lastUserTs),
        toolsFromRefused: (startIdx !== undefined && startIdx < oi) ? countTools(startIdx, oi) : '-',
        toolsFromLastUser: toolsSince, sess: path.basename(fp).slice(0, 8)
      });
    }
  }
  const tot = Object.values(fam).reduce((a, b) => a + b, 0);
  if (tot >= 5) {
    let dom = '?', best = 0;
    for (const k in fam) if (fam[k] > best) { best = fam[k]; dom = k; }
    sessions.push({ dom, mb, refused: refusals > 0, file: path.basename(fp).slice(0, 8) });
  } else { excluded++; if (refusals > 0) excludedWithRefusal++; }
}

console.log('scanned .jsonl files:', files.length);
console.log('COHORT POPULATION (>=5 model-tagged msgs):', sessions.length, '| EXCLUDED (too few msgs):', excluded, '| of excluded, with refusal:', excludedWithRefusal);
console.log('NOTE: 群ごとの件数の合計は COHORT POPULATION と突き合わせる（scanned files ではない）。');
console.log('      excluded, with refusal が 0 でなければ、コホート外に拒否が落ちている＝比較が不完全。');
console.log('REAL refusal event records:', events.length, '\n');
events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
console.log('when(UTC)        | category            | model at refusal      | refusedMsg | resolved   | minFromRefused | minFromLastUser | toolsFromRefused | toolsFromLastUser | session');
for (const e of events) console.log('%s | %s | %s | %s | %s | %s | %s | %s | %s | %s', String(e.ts).slice(0, 16),
  String(e.cat).padEnd(19), String(e.model).padEnd(21), String(e.refUuid).padEnd(10), String(e.refResolved).padEnd(10),
  String(e.minFromRefused).padStart(14), String(e.minFromLastUser).padStart(15),
  String(e.toolsFromRefused).padStart(16), String(e.toolsFromLastUser).padStart(17), e.sess);
console.log('\nNOTE: FromRefused 系（拒否対象メッセージ基準）と FromLastUser 系（直近 user 基準）が');
console.log('      食い違う拒否は、拒否対象が直前の発言ではない（走行中のターンへ合流したメッセージ等）。');
console.log('      ターン指標をどちらの発言へ帰属させるか、結論を書く前に必ず確かめる。');
console.log('      resolved=UNRESOLVED は対象メッセージが記録内に無い（指標は FromLastUser しか取れない）。');

const byCat = {}, byModel = {};
for (const e of events) { byCat[e.cat] = (byCat[e.cat] || 0) + 1; byModel[e.model] = (byModel[e.model] || 0) + 1; }
console.log('\nBY CATEGORY', JSON.stringify(byCat));
console.log('BY MODEL AT REFUSAL', JSON.stringify(byModel));

// コホート: 支配的モデル別に「大きい会話がどれだけあるか(=検出力)」と「拒否の有無」
const coh = {};
for (const s of sessions) {
  const c = coh[s.dom] = coh[s.dom] || { n: 0, refused: 0, big: 0, bigRefused: 0, maxMb: 0, mbs: [] };
  c.n++; c.mbs.push(s.mb); if (s.mb > c.maxMb) c.maxMb = s.mb;
  if (s.refused) c.refused++;
  if (s.mb >= 3) { c.big++; if (s.refused) c.bigRefused++; }
}
const med = a => { if (!a.length) return 0; const t = a.slice().sort((x, y) => x - y); return t[Math.floor(t.length / 2)]; };
console.log('\ndominant model | sessions | withRefusal | >=3MB | of those refused | maxMB | medianMB');
for (const k in coh) { const c = coh[k];
  console.log('%s | %s | %s | %s | %s | %s | %s', k.padEnd(14), String(c.n).padStart(8), String(c.refused).padStart(11),
    String(c.big).padStart(5), String(c.bigRefused).padStart(16), c.maxMb.toFixed(1).padStart(5), med(c.mbs).toFixed(2).padStart(8)); }
```

確定すべき項目: 拒否カテゴリ／説明文の逐語／`refusedUserMessageUuid`／そのターンの所要時間とツール実行数／**拒否時に実行されていたモデル**（`originalModel`。セッションの支配的モデルとは別物ゆえ混同しない）。

**自己汚染ガード**: 検索語を自分が会話に書くと、その transcript が文字列検索でヒットする。上のスクリプトは `type=system` かつ subtype に refusal を含む**実イベントレコードだけ**を計上する。単純な `grep` の出現数を拒否件数として報告しない。

### 2. コホートで仮説を反証する

1 件だけ見ても原因は出ない。スクリプト後半のコホート表を使い、「拒否された群」と「されなかった群」を比べる。

**母数を必ず突き合わせる**。群ごとの件数の合計は、走査ファイル数ではなく **`COHORT POPULATION`**（スクリプトが出力する、モデル記録が閾値以上あるセッション数）と一致しなければならない。併せて `EXCLUDED` と `of excluded, with refusal` を読む。**除外側に拒否イベントが 1 件でもあれば、その比較は不完全**であり、閾値を下げて取り直す。フィルタ条件が群ごとに違っていると比較そのものが評価不能になる。

**検出力を先に見る**。「対照群で 0 件」は、対照群に同等の露出（同規模・同件数の会話）がある場合にのみ意味を持つ。`>=3MB` 列と `maxMB` 列がそのための欄である。露出量を示さずに 0 件を証拠として使わない。

### 3. 交絡を切る対照を掘る

群間比較には交絡が残る。**なるべく条件の近い対照**を母集団から探す。有力なのは「**同一セッション内で、ある属性だけが切り替わった前後**」——支配的モデルが A のセッションで拒否が起きており、拒否時の実行モデルが B なら、「作業内容だけでは説明しにくい」と言える（`BY MODEL AT REFUSAL` と `dominant model` の食い違いがその痕跡）。

**ただしこれは対照実験ではない。** 同一セッション内でも、会話履歴・時点・累積コンテキストは切り替えの前後で変わっている。得られるのは**仮説の生成と、作業内容仮説の弱化**までであって、属性の効果を確定したことにはならない。結論にはこの限界を書く。

対照が見つからなければ「交絡を切れなかった」と書く。無いものを見つけたことにしない。

### 4. 自分の仮説を反証しに行く

思いついた原因は、支持ではなく**反証**を先に取る。とくに「手元の変わった構成（proxy・プラグイン・独自設定）が原因」は魅力的に見えるが、対照を取ると落ちることが多い。

反証の型: その構成を通していない群でも同じ現象が出るか／その構成の対象に入っている別条件では起きていないか。

潰した仮説は**消さずに記録する**。報告の反証チェック表に残す。

### 5. 公式一次資料で判定対象と窓口を確定する

ベンダーのサポート記事・規約を当たり、次の 3 点を**逐語で**取る。要約で代替しない。

1. **何が検知対象か**（カテゴリの定義）
2. **何が判定に入るか**（最新の入力だけか、会話・添付・接続先を含む全体か）
3. **誤検知を個別に解除する窓口があるか**

3 は、**あるとみなして手順を書くと利用者を無い窓口へ歩かせる**ため必ず確認する。ただし書き方に注意する。

- 断定しない: 言えるのは「**公開資料の範囲では個別解除の窓口が見当たらない**」まで。サポートへの問い合わせ経路が別にある可能性は否定しない。誤検知の報告窓口があるなら、その利用は勧める。
- **回避を設計しない**: 窓口が見当たらないときに取る道は、**正当な利用の範囲で入力を整えること**（不要になった履歴を畳む、目的に必要な資料だけを渡す等）に限る。検知を潜り抜けることを目的とした難読化・分割送信・表現の偽装・分類器の推定条件の探索は**手順に書かないし、勧めない**。それは safeguard の回避であり、規約の側の問題になる。
- 復帰しない可能性を残す: 正当な範囲で整えても通らないなら、「このモデルでは続行できない」も正当な結論である。

### 6. 停止条件つきの復帰動線を出す

- 各手を**一度だけ試す**と明記し、落ちたら次の手へ移ることを書く。分類器は確率的に見えるため連打したくなるが、連打は枠を消費するだけである
- **副作用で成果物を失う操作を名指しで禁止する**（ファイルを巻き戻す復元操作など）。利用者は焦って近接したメニュー項目を押す
- 手順の冒頭に**成果物の生存確認**（バージョン管理の状態確認など）を置く。「失われていない」は拒否イベントだけからは立証できない
- 未コミットの変更が多い環境では、巻き戻し系の誤爆が**バージョン管理でも救えない**ことを明記する
- どの手にも**通る保証はない**。保証のない手を「最善手」と呼ばない

### 7. 反証チェック（結論前に必須）

**この表は本文の全要求の再掲ではない。** 手順そのものは本文が正で、ここは**実際に踏みやすい罠**だけを並べた最終ゲートである（全要求を 1 対 1 で写すと表が長くなり、最後に流し読みされて機能しなくなる）。本文に要求を足したときは、それが「黙って通り抜けやすいか」で判断し、該当するものだけをここへ足す。

**§1 由来**
- [ ] 拒否カテゴリを画面でなく生レコードで確認したか
- [ ] 件数を**実イベントレコード**で数えたか（文字列出現数を拒否件数にしていないか＝自己汚染ガード）
- [ ] 拒否時の実行モデルと、セッションの支配的モデルを区別したか
- [ ] `refusedUserMessageUuid` を辿って**実際に拒否対象となったメッセージ**を読んだか（直前の発言だと思い込んでいないか）

**§2 由来**
- [ ] 群ごとの件数の合計を `COHORT POPULATION` と突き合わせたか（走査ファイル数と混同していないか）
- [ ] `of excluded, with refusal` が 0 か確認したか（0 でなければ比較は不完全。閾値を下げて取り直したか）
- [ ] 対照群の露出量（同規模の会話数・最大規模）を示したか

**§3 由来**
- [ ] 近い条件の対照を探し、無ければ「切れなかった」と書いたか
- [ ] 得られたのが**仮説の生成まで**であることを結論に添えたか（対照実験として書いていないか）

**§4 由来**
- [ ] 自分の仮説を**反証しに行った**か（支持の材料だけ集めていないか）
- [ ] 潰した仮説を消さずに記録したか

**§5 由来（3 点すべてを個別に確認する）**
- [ ] **検知対象の定義**を一次資料から逐語で引いたか
- [ ] **判定に入る範囲**（最新入力だけか、会話全体か）を一次資料から逐語で引いたか
- [ ] **個別解除窓口の有無**を一次資料で確認し、「公開資料の範囲では」と限定して書いたか
- [ ] 回避（難読化・分割送信・偽装・条件の探索）を手順に書いていないか

**§6 由来**
- [ ] 手順の冒頭に成果物の生存確認を置いたか
- [ ] 各手を「一度だけ」と書き、停止条件を示したか
- [ ] 成果物を失う操作を名指しで禁止したか（未コミットが多い環境では復元不能になる旨も）
- [ ] どの手にも保証がないことを書いたか（「最善手」と呼んでいないか）

**報告の書き方 由来**
- [ ] **何が判定されたのか**（有害性の判定か、別カテゴリか）を報告の先頭に置いたか
- [ ] 「違反していない」と書く前に、それが未判定であることと区別したか
- [ ] 規模の指標を**代理指標**と断ったか
- [ ] 相関を因果として書いていないか（未観測の交絡が残る旨を添えたか）

## 報告の書き方

- 利用者は「自分が咎められた」と受け取る。**まず何が判定されたのか**（有害性の判定なのか、別カテゴリなのか）を先に置く
- ただし「違反していない」と断定しない。記録が示すのは**自動分類による拒否**であって、ベンダーが違反と認定した事実でも、誤検知と認めた事実でもない
- 規模の指標（ファイルサイズ等）は**代理指標**であり、実際に判定へ渡る量とは別物である旨を添える
- 相関を因果として書かない。「観察データゆえ未観測の交絡は残る」を結論に添える