#!/usr/bin/env node
/*
 * pxpipe dashboard JA translation wrapper (upstream-unchanged).
 *
 * 上流 pxpipe の dashboard(既定 127.0.0.1:47821) を別ポート(既定 47822)で「全メソッド透過プロキシ」し、
 * フルページ HTML(GET / , /dashboard)にだけ overlay script + 辞書を </body> 直前へ注入する。
 *
 * 重要: これは表示だけの飾りではなく完全な透過プロキシ。POST 等の操作
 *   (kill switch のトグル、model チップ)も 47821 にそのまま届く = 47822 上の操作が実際に効く。
 *   fragment(/fragments/*) と PNG は透過し、翻訳は client 側の htmx:afterSwap が担う。
 *
 * 使い方: node serve-ja.mjs   (上流は別途 start-pxpipe で 47821 に起動しておく)
 *   環境変数: PXPIPE_JA_PORT(既定 47822) / PXPIPE_UPSTREAM_PORT(既定 47821)
 *             PXPIPE_JA_YEN_RATE(既定 無効) — 推定削減額の円併記。有効にすると overlay が
 *             外部の為替 API へ接続する。**配布物として出荷されるため既定は無効**
 *             (明示的に有効化しない限り第三者へ一切通信しない)。
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = Number(process.env.PXPIPE_UPSTREAM_PORT || 47821);
const LISTEN_PORT = Number(process.env.PXPIPE_JA_PORT || 47822);
// 円併記(外部為替 API への接続)の有効化。未設定・空・それ以外の値は全て「無効」に倒す。
const YEN_RATE = /^(1|true|on|yes)$/i.test(String(process.env.PXPIPE_JA_YEN_RATE || ''));

const here = dirname(fileURLToPath(import.meta.url));
const overlayJs = readFileSync(join(here, 'i18n-overlay.js'), 'utf8');
const dictJson = readFileSync(join(here, 'dict.ja.json'), 'utf8');

// <script> 内に JSON/JS を埋め込むための最小サニタイズ。
//   - "</script" を無害化(早期クローズ防止)
//   - U+2028 / U+2029 は JS 文字列/式中で行終端子扱いされ得るのでエスケープ。
//     (正規表現リテラルへの生コードポイント直書きはソースを壊し得るので fromCharCode で表現)
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
function safeForScript(s) {
  return s
    .replace(/<\/script/gi, '<\\/script')
    .split(LS).join('\\u2028')
    .split(PS).join('\\u2029');
}

const INJECT =
  '\n<script>window.__PXPIPE_JA_OPTS=' +
  JSON.stringify({ yenRate: YEN_RATE }) +
  ';window.__PXPIPE_JA_DICT=' +
  safeForScript(dictJson) +
  ';</script>\n<script>' +
  safeForScript(overlayJs) +
  '</script>\n';

function isFullPage(url) {
  const path = (url || '').split('?')[0];
  return path === '/' || path === '/dashboard';
}

const server = http.createServer((req, res) => {
  const headers = Object.assign({}, req.headers, {
    host: UPSTREAM_HOST + ':' + UPSTREAM_PORT,
    // gzip 応答だと注入前の decode が要るので、identity を強制して素の本文で扱う(ローカルなので無害)。
    'accept-encoding': 'identity',
  });

  const up = http.request(
    { host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: req.url, headers },
    (ur) => {
      const ct = ur.headers['content-type'] || '';
      const injectable = req.method === 'GET' && isFullPage(req.url) && ct.includes('text/html');

      if (!injectable) {
        // 透過: fragment / PNG / POST 応答など。ヘッダ・本文をそのまま流す(操作が上流に効く)。
        res.writeHead(ur.statusCode || 502, ur.headers);
        ur.pipe(res);
        return;
      }

      // フルページ HTML: バッファして </body> 前に overlay を注入。
      const chunks = [];
      ur.on('data', (c) => chunks.push(c));
      ur.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        // htmx 等の埋め込み script 内にも "</body>" という文字列が現れるため、最初の一致に
        // replace すると script の内部を壊す(=htmx 不動作・レイアウト崩壊)。真のページ終端＝
        // 最後の </body> の直前に注入する(根治)。
        const bodyClose = body.lastIndexOf('</body>');
        body = bodyClose >= 0
          ? body.slice(0, bodyClose) + INJECT + body.slice(bodyClose)
          : body + INJECT;
        const outHeaders = Object.assign({}, ur.headers);
        delete outHeaders['content-length'];
        delete outHeaders['transfer-encoding'];
        outHeaders['content-length'] = Buffer.byteLength(body);
        res.writeHead(ur.statusCode || 200, outHeaders);
        res.end(body);
      });
    },
  );

  up.on('error', (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end(
      'pxpipe-ja: 上流 http://' +
        UPSTREAM_HOST + ':' + UPSTREAM_PORT +
        '/ に接続できません (' + e.message + ')。先に pxpipe proxy を起動してください。',
    );
  });

  req.pipe(up); // POST 等のリクエスト本文を透過。
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(
      '[pxpipe-ja] ポート ' + LISTEN_PORT + ' は使用中です。翻訳ラッパが既に起動済みか、' +
        'PXPIPE_JA_PORT=<別ポート> で変更してください。',
    );
  } else {
    console.error('[pxpipe-ja] listen error:', e.message);
  }
  process.exit(1);
});

server.listen(LISTEN_PORT, UPSTREAM_HOST, () => {
  console.log('pxpipe 日本語ダッシュボード: http://127.0.0.1:' + LISTEN_PORT + '/');
  console.log('  上流 pxpipe(透過翻訳元): http://127.0.0.1:' + UPSTREAM_PORT + '/');
  console.log('  停止: Ctrl+C');
});
