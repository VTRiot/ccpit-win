/*
 * pxpipe dashboard JA i18n overlay (upstream-unchanged).
 *
 * 上流 pxpipe (src/dashboard/fragments.ts) を一切改変せず、翻訳ラッパ(serve-ja.mjs)が
 * この script と辞書(window.__PXPIPE_JA_DICT)を配信 HTML の </body> 直前に注入する。
 *
 * 方針:
 *  - テキストノードの trim 完全一致で辞書置換。miss は fail-open で英語のまま(混在文字列の部分未訳を許容)。
 *  - 動的文言（数字・比率・モデル名を含むもの）は PATTERNS 配列の正規表現で置換。
 *  - 数値・モデル名・pxpipe ブランド・生の計算式は辞書に載せない = 自然に未訳(汚染ゼロ)。
 *    さらに <code>/<pre>/<script>/<style>/<textarea> 配下は無条件スキップ(モデル名/ソース保護)。
 *  - dashboard は htmx polling(2s/5s)で fragment を innerHTML 置換するため htmx:afterSwap で追随。
 *    Alpine の toast 等 htmx 外の挿入や画像の遅延属性変更は MutationObserver で拾う。
 *  - ロケール: localStorage('pp-lang') > navigator.language(ja*) > 'en'。右上に切替、変更は reload。
 *  - en のときは何も置換しない(素の上流表示)。ja のときのみ翻訳する。
 */
(function () {
  'use strict';

  var BUNDLE = window.__PXPIPE_JA_DICT || {};
  var DICT = BUNDLE.dict || {};
  // serve-ja が env から注入するオプション。**既定は全て無効**。
  // 配布物として出荷される以上、ユーザーが明示的に有効化しない限り
  // 外部への通信は一切行わない（既定オフ = 配布時に第三者へ接続しない）。
  var OPTS = window.__PXPIPE_JA_OPTS || {};
  var SKIP_PARENTS = { SCRIPT: 1, STYLE: 1, CODE: 1, PRE: 1, TEXTAREA: 1, NOSCRIPT: 1 };
  var ATTRS = ['title', 'aria-label', 'hx-confirm', 'alt'];

  function hasSkippedAncestor(node) {
    var cur = node;
    while (cur && cur.nodeType === 1) {
      if (SKIP_PARENTS[cur.nodeName]) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  var PATTERNS = [
    // 1. バナー: Since start · N requests imaged / 1 request imaged
    {
      re: /^Since start · ([0-9,]+) requests? imaged$/,
      sub: function (m) { return '開始以降 · ' + m[1] + ' 件のリクエストを画像化'; }
    },
    // 2. タイル: N turned into images
    {
      re: /^([0-9,]+) turned into images$/,
      sub: function (m) { return m[1] + ' 件を画像化'; }
    },
    // 3. タイル: vs $X without pxpipe
    {
      re: /^vs \$([0-9,.]+) without pxpipe$/,
      sub: function (m) { return 'pxpipe なしの $' + m[1] + ' との比較'; }
    },
    // 4. バナー: Provider-token basis; ... output untouched (X) · no $ assumptions
    {
      re: /^Provider-token basis; cache discounts applied where measurable · output untouched \(([0-9.]+[kMGT]?)\) · no \$ assumptions$/,
      sub: function (m) {
        return 'プロバイダトークン基準; 計測可能なキャッシュ割引を適用 · 出力は無変更 (' + m[1] + ') · 金額仮定なし';
      }
    },
    // 5. タイル: N provider-priced requests excluded / 1 provider-priced request excluded
    {
      re: /^([0-9,]+) provider-priced requests? excluded$/,
      sub: function (m) { return 'プロバイダ価格設定の ' + m[1] + ' 件を除外'; }
    },
    // 6. セッション数: N sessions tracked / 1 session tracked
    {
      re: /^([0-9,]+) sessions? tracked$/,
      sub: function (m) { return m[1] + ' セッションを記録'; }
    },
    // 7. セッション削減: tokens saved per session (cache-aware) · top N of M
    {
      re: /^tokens saved per session \(cache-aware\) · top ([0-9,]+) of ([0-9,]+)$/,
      sub: function (m) { return 'セッションあたりの削減トークン (キャッシュ考慮) · 上位 ' + m[1] + ' / ' + m[2] + ' 件'; }
    },
    // 8. イベント数: N events parsed from disk
    {
      re: /^([0-9,]+) events? parsed from disk$/,
      sub: function (m) { return 'ディスクから ' + m[1] + ' 件のイベントを解析'; }
    },
    // 9. ヘッダー稼働情報: live · port N · uptime X
    {
      re: /^live · port (\d+) · uptime ([0-9hms ]+)$/,
      sub: function (m) { return '稼働中 · ポート ' + m[1] + ' · 稼働時間 ' + m[2]; }
    },
    // 10. 数式詳細: actual imaged (n=N):
    {
      re: /^actual imaged \(n=([0-9,]+)\):$/,
      sub: function (m) { return '実際の画像化 (n=' + m[1] + '):'; }
    },
    // 11. コンテキストマップ (テキスト & title 属性): Click to read the source text behind page N
    {
      re: /^Click to read the source text behind page (\d+)$/,
      sub: function (m) { return 'ページ ' + m[1] + ' の元のテキストを表示'; }
    },
    // 12. コンテキストマップ (テキスト & alt 属性): page N
    {
      re: /^page (\d+)$/,
      sub: function (m) { return 'ページ ' + m[1]; }
    },
    // 13. コンテキストマップ (alt 属性 / onerror 動的設定): page N expired from buffer
    {
      re: /^page (\d+) expired from buffer$/,
      sub: function (m) { return 'ページ ' + m[1] + ' はバッファから期限切れ'; }
    },
    // 14. コンテキストマップ (見出し): N image pages sent to MODEL (slash 許容モデルID形式: moonshotai/kimi-k3 等、先頭末尾記号や .. を拒否)
    {
      re: /^([0-9,]+) image pages sent to ([a-zA-Z0-9]+(?:[._-][a-zA-Z0-9]+)*(?:\/[a-zA-Z0-9]+(?:[._-][a-zA-Z0-9]+)*)?) — click one to read the exact text behind it:$/,
      sub: function (m) { return m[2] + ' に送信された ' + m[1] + ' ページの画像 — クリックして元のテキストを表示:'; }
    },
    // 15. コンテキストマップ (見出し): N image pages were sent — thumbnails expired when the proxy restarted...
    {
      re: /^([0-9,]+) image pages were sent — thumbnails expired when the proxy restarted\. The breakdown above is reconstructed from the saved log\.$/,
      sub: function (m) { return m[1] + ' ページの画像が送信されました — proxy 再起動時にサムネイルは期限切れとなりました。上記の内訳は保存ログから再構成されたものです。'; }
    },
    // 16. コンテキストマップ (説明): Raw content shrank N%. / Raw content grew N%.
    {
      re: /^Raw content shrank (\d+)%\.$/,
      sub: function (m) { return '生コンテンツは ' + m[1] + '% 縮小。'; }
    },
    {
      re: /^Raw content grew (\d+)%\.$/,
      sub: function (m) { return '生コンテンツは ' + m[1] + '% 増加。'; }
    },
    // 17. 節約見込みサブタイトル (価格動的対応): at $10/M base input price, at $3.50/M base input price, etc.
    {
      re: /^at \$(\d+(?:,\d{3})*(?:\.\d+)?)\/M base input price$/,
      sub: function (m) { return '基本入力単価 $' + m[1] + '/Mtok 時'; }
    },
    // 18. 数式ドロワー counterfactual 注記: (unproxied counterfactual, same ×1.5 on output)
    {
      re: /^\(unproxied counterfactual, same ×(\d+(?:\.\d+)?)\s+on\s+output\)$/,
      sub: function (m) { return '(プロキシなしの反実仮想、出力は同一の ×' + m[1] + ')'; }
    },
    // 19. 数式ドロワー出所注記: source: Anthropic docs ... (verified 2026-03-30)
    {
      re: /^source:\s+([\s\S]+?)(?:\s+\(verified\s+(\d{4}-\d{2}-\d{2})\))?$/,
      sub: function (m) { return '出所: ' + m[1] + (m[2] ? ' (確認日: ' + m[2] + ')' : ''); }
    },
    // 20. 数式ドロワー平均リクエスト価格: total · avg $0.003/req
    {
      re: /^total · avg \$(\d+(?:,\d{3})*(?:\.\d+)?)\/req$/,
      sub: function (m) { return '合計 · 平均 $' + m[1] + '/req'; }
    }
  ];

  function translatePattern(key) {
    for (var i = 0; i < PATTERNS.length; i++) {
      var m = PATTERNS[i].re.exec(key);
      if (m) return PATTERNS[i].sub(m);
    }
    if (key.indexOf('came from your side') >= 0 || key.indexOf('never went out') >= 0 || key.indexOf('image cap was full') >= 0) {
      var parts = key.split(' · ');
      var changed = false;
      var translatedParts = parts.map(function (part) {
        var m1 = /^([0-9,]+) images? came from your side and count against the same 100-image request cap$/.exec(part);
        if (m1) { changed = true; return m1[1] + ' 枚の画像はクライアント側から送信され同一の 100 画像/リクエスト上限にカウントされます'; }
        var m2 = /^([0-9,]+) rendered pages? never went out — the history collapse absorbed those messages \(([0-9,]+) on the wire\)$/.exec(part);
        if (m2) { changed = true; return m2[1] + ' ページのレンダリング済み画像は送信されませんでした — 履歴集約によりこれらのメッセージが吸収されました (送信実数: ' + m2[2] + ')'; }
        var m3 = /^([0-9,]+) blocks? stayed as text because the image cap was full$/.exec(part);
        if (m3) { changed = true; return m3[1] + ' ブロックは画像上限に達したためテキストのまま維持されました'; }
        return part;
      });
      if (changed) return translatedParts.join(' · ');
    }
    return null;
  }

  function detectLang() {
    try {
      var saved = localStorage.getItem('pp-lang');
      if (saved === 'ja' || saved === 'en') return saved;
    } catch (e) { /* private mode etc. */ }
    var nav = (navigator.language || navigator.userLanguage || 'en').toLowerCase();
    return nav.indexOf('ja') === 0 ? 'ja' : 'en';
  }

  var lang = detectLang();

  // 前後空白を保持したまま、trim 部分だけ辞書またはパターン置換する。
  function translateTextNode(node) {
    var parent = node.parentNode;
    if (!parent || hasSkippedAncestor(parent)) return;
    var raw = node.nodeValue;
    if (!raw) return;
    var key = raw.trim();
    if (!key) return;
    var hit = DICT[key] || translatePattern(key);
    if (hit === null || hit === undefined || hit === key) return; // fail-open / 恒等訳は触らない
    var m = /^(\s*)[\s\S]*?(\s*)$/.exec(raw);
    var lead = m ? m[1] : '';
    var trail = m ? m[2] : '';
    node.nodeValue = lead + hit + trail;
  }

  function translateAttrs(el) {
    if (el.nodeType !== 1) return;
    if (hasSkippedAncestor(el)) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      if (!el.hasAttribute(a)) continue;
      var v = el.getAttribute(a);
      if (!v) continue;
      var key = v.trim();
      if (!key) continue;
      var hit = DICT[key] || translatePattern(key);
      if (hit === null || hit === undefined || hit === key) continue;
      var m = /^(\s*)[\s\S]*?(\s*)$/.exec(v);
      var lead = m ? m[1] : '';
      var trail = m ? m[2] : '';
      el.setAttribute(a, lead + hit + trail);
    }
  }

  function walk(root) {
    if (lang !== 'ja' || !root) return;
    if (root.nodeType === 3) { translateTextNode(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    // テキストノード
    var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var batch = [];
    var n;
    while ((n = tw.nextNode())) batch.push(n);
    for (var i = 0; i < batch.length; i++) translateTextNode(batch[i]);
    // 属性(root 自身 + 子孫)
    if (root.nodeType === 1) translateAttrs(root);
    var els = root.querySelectorAll ? root.querySelectorAll('[title],[aria-label],[hx-confirm],[alt]') : [];
    for (var j = 0; j < els.length; j++) translateAttrs(els[j]);
  }

  function mountSwitcher() {
    if (document.getElementById('pp-lang-switch')) return;
    var box = document.createElement('div');
    box.id = 'pp-lang-switch';
    ['en', 'ja'].forEach(function (l) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = l === 'ja' ? '日本語' : 'EN';
      b.setAttribute('aria-pressed', String(l === lang));
      b.style.cssText =
        'padding:2px 9px;border-radius:6px;cursor:pointer;border:1px solid rgba(128,128,128,.45);' +
        (l === lang ? 'background:#f59e0b;color:#fff;font-weight:600;' : 'background:transparent;color:inherit;');
      b.addEventListener('click', function () {
        if (l === lang) return;
        try { localStorage.setItem('pp-lang', l); } catch (e) { /* ignore */ }
        location.reload(); // en<->ja は再取得で確実に切り替える
      });
      box.appendChild(b);
    });
    // 上流 .controls は flex-direction:column(右上で theme ボタン + 圧縮トグルを縦積み)。
    // その先頭に挿入して縦列に整列させ、重なりを構造的に回避する。
    // .controls が無ければ従来どおり右上 fixed にフォールバック。
    var controls = document.querySelector('.controls');
    if (controls && typeof controls.insertBefore === 'function') {
      box.style.cssText = 'display:flex;gap:4px;font:12px system-ui,-apple-system,sans-serif;margin-bottom:2px;';
      controls.insertBefore(box, controls.firstChild);
    } else {
      box.style.cssText =
        'position:fixed;top:8px;right:10px;z-index:2147483647;display:flex;gap:4px;' +
        'font:12px system-ui,-apple-system,sans-serif;';
      document.body.appendChild(box);
    }
  }

  // ---- 推定削減額の円併記(ja 時のみ・fail-open) --------------------------
  // USD/JPY レートを取得し、「推定削減額 / Estimated saved」tile の $ 値に「(約¥Y)」を併記する。
  // レートだけを外部(frankfurter/ECB)から取得し、削減額そのものは外部に送らない。
  var jpyRate = null;
  function fetchYenRate(cb) {
    try {
      fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          jpyRate = j && j.rates && typeof j.rates.JPY === 'number' ? j.rates.JPY : null;
          if (cb) cb();
        })
        .catch(function () { jpyRate = null; });
    } catch (e) { jpyRate = null; }
  }
  function annotateYen(root) {
    if (lang !== 'ja' || !jpyRate || !root || !root.querySelectorAll) return;
    var tiles = root.querySelectorAll('.tile');
    for (var i = 0; i < tiles.length; i++) {
      var label = tiles[i].querySelector('.tile-label');
      var val = tiles[i].querySelector('.tile-value');
      if (!label || !val) continue;
      var lt = label.textContent || '';
      if (lt.indexOf('推定削減額') < 0 && lt.indexOf('Estimated saved') < 0) continue;
      var m = (val.textContent || '').match(/\$\s*([0-9,]+(?:\.[0-9]+)?)/);
      if (!m) continue;
      var usd = parseFloat(m[1].replace(/,/g, ''));
      if (!isFinite(usd)) continue;
      var yen = Math.round(usd * jpyRate);
      var shown = '$' + usd.toFixed(2) + ' (約¥' + yen.toLocaleString('ja-JP') + ')';
      if (val.textContent !== shown) val.textContent = shown;
    }
  }

  var observer = null;
  function observe() {
    if (observer || typeof MutationObserver === 'undefined') return;
    observer = new MutationObserver(function (muts) {
      if (lang !== 'ja') return;
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'childList') {
          var added = m.addedNodes;
          if (added) {
            for (var j = 0; j < added.length; j++) walk(added[j]);
          }
        } else if (m.type === 'attributes') {
          if (m.target && m.target.nodeType === 1) translateAttrs(m.target);
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ATTRS
    });
  }

  function boot() {
    try {
      mountSwitcher();
      if (lang === 'ja') {
        document.documentElement.lang = 'ja';
        walk(document.body);
      }
      // htmx polling(2s/5s)の innerHTML 差し替えに追随。
      document.body.addEventListener('htmx:afterSwap', function (e) {
        var t = (e && e.target) || document.body;
        walk(t);
        annotateYen(t);
      });
      observe();
      // 「推定削減額」の円併記用に USD/JPY レートを取得(ja 時のみ・fail-open)。
      // **既定では実行しない**。第三者 API への接続なので、明示的に有効化された時だけ行う
      // (opt-in)。無効時は jpyRate が null のままなので annotateYen は何もしない。
      if (lang === 'ja' && OPTS.yenRate) {
        fetchYenRate(function () { annotateYen(document.body); });
      }
    } catch (err) {
      // fail-open: overlay がコケても素の英語 dashboard は生きている。
      if (window.console && console.warn) console.warn('[pxpipe-ja] overlay error:', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
