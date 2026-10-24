#!/usr/bin/env python3
"""svg_figure.py — matplotlib の図を、md-render の図のビューアで値を読める svg フェンスにする。

md-render は Markdown の画像記法を描かない。svg フェンスは data URI の <img> として描くので、
PNG を <image> に入れた SVG を svg フェンスに置けば、HTML 1 枚で図が見える。
さらに SVG に軸の情報（<metadata data-mdr="axes">）を入れると、ビューアの十字カーソルが値を読み上げる。

使い方（2 段）:
  1. 図を保存するとき: save_png_with_axes(fig, "fig1.png", dpi=110)
     → fig1.png と、軸の情報 fig1.png.axes.json を書く
  2. 報告書を作るとき: 雛形（.md.tpl）の行 `<<PNG fig1.png>>` を svg フェンスに置き換える
     python svg_figure.py <雛形.md.tpl> <出力.md>
     （fig1.png.axes.json があれば軸の情報も入る。無ければ図だけ）

決まり:
  - savefig に bbox_inches="tight" を使わない（余白を切ると軸の位置がずれる）。本関数はこの引数を受け付けない
  - 軸の位置は図の中の割合（get_position）から PNG の画素へ換算する。dpi に依らない
  - 対数・線形以外の目盛り（symlog など）の軸は軸の情報に入れない（カーソルは出るが値は出ない）
  - 複数の図を並べるときは縦に並べる（nrows）。横に並べると本文の幅に縮んで読めない
"""
from __future__ import annotations

import base64
import json
import re
import struct
import sys
from pathlib import Path

MARK = re.compile(r"^<<PNG\s+(\S+)>>\s*$")
PNG_SIG = b"\x89PNG\r\n\x1a\n"
SIDE = ".axes.json"
SCALES = ("linear", "log")
MAX_AXES = 64           # ビューアが見る軸の数の上限（md2html.cjs の figViewCore と同じ）
MAX_META_CHARS = 200000  # ビューアが読む軸の情報の JSON の文字数の上限（同上）


def png_size(b: bytes):
    if b[:8] != PNG_SIG:
        raise ValueError("PNG ではない")
    return struct.unpack(">II", b[16:24])  # IHDR の幅・高さ


def _label(ax, which):
    """軸のラベル。sharex/sharey で自分のラベルが空なら、共有している軸のラベルを使う。"""
    own = ax.get_xlabel() if which == "x" else ax.get_ylabel()
    if own:
        return own
    group = ax.get_shared_x_axes() if which == "x" else ax.get_shared_y_axes()
    for sib in group.get_siblings(ax):
        lab = sib.get_xlabel() if which == "x" else sib.get_ylabel()
        if lab:
            return lab
    return ""


def axes_meta(fig, width: int, height: int):
    """図の全軸の位置（PNG の画素・y は下向き）と目盛りの範囲を、ビューアの形で返す。"""
    out = []
    for ax in fig.get_axes():
        if not ax.get_visible() or ax.name != "rectilinear":
            continue
        xs, ys = ax.get_xscale(), ax.get_yscale()
        if xs not in SCALES or ys not in SCALES:
            continue
        p = ax.get_position()
        bbox = [p.x0 * width, (1 - p.y1) * height, p.x1 * width, (1 - p.y0) * height]
        out.append({
            "bbox": [round(v, 2) for v in bbox],
            "xlim": [float(v) for v in ax.get_xlim()],
            "ylim": [float(v) for v in ax.get_ylim()],
            "xscale": xs, "yscale": ys,
            "xlabel": _label(ax, "x"), "ylabel": _label(ax, "y"), "title": ax.get_title(),
        })
    return {"version": 1, "axes": out}


def save_png_with_axes(fig, path, dpi=None, **kwargs):
    """fig を PNG に保存し、同じ名前に .axes.json を足したファイルへ軸の情報を書く。"""
    if "bbox_inches" in kwargs:
        raise ValueError("bbox_inches は使えない（軸の位置がずれる）")
    import matplotlib
    if matplotlib.rcParams.get("savefig.bbox") == "tight":
        raise ValueError("rcParams['savefig.bbox'] が 'tight'（余白が切られて軸の位置がずれる）")
    path = Path(path)
    fig.savefig(path, dpi=dpi, **kwargs)
    w, h = png_size(path.read_bytes())
    meta = axes_meta(fig, w, h)
    Path(str(path) + SIDE).write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    return path


def _json_for_xml(obj):
    # SVG（XML）の中に置くので ASCII だけで書く: ASCII 以外は JSON の \uXXXX（XML で使えない文字も入らない）、
    # < > & も JSON のエスケープにする（JSON としての意味は変わらない）。ASCII だけなので、文字数は
    # Python とブラウザ（UTF-16）で同じに数えられる（上限 MAX_META_CHARS の判定が両側で一致する）
    s = json.dumps(obj, ensure_ascii=True, separators=(",", ":"))
    return s.replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e")


def svg_fence(png_path):
    """PNG（と、あれば軸の情報）から svg フェンスの行を作る。"""
    png_path = Path(png_path)
    b = png_path.read_bytes()
    w, h = png_size(b)
    side = Path(str(png_path) + SIDE)
    meta = ""
    if side.exists():
        obj = json.loads(side.read_text(encoding="utf-8"))
        text = _json_for_xml(obj)
        # ビューアの上限を超える軸の情報は黙って読まれなくなるので、作る側で止める
        if len(obj.get("axes", [])) > MAX_AXES or len(text) > MAX_META_CHARS:
            raise ValueError(f"軸の情報がビューアの上限を超える: {side}（軸 {MAX_AXES} 本・{MAX_META_CHARS} 字まで）")
        meta = '<metadata data-mdr="axes">' + text + "</metadata>"
    b64 = base64.b64encode(b).decode("ascii")
    return ["```svg",
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">{meta}'
            f'<image width="{w}" height="{h}" href="data:image/png;base64,{b64}"/></svg>',
            "```"]


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2
    tpl, out = Path(argv[0]), Path(argv[1])
    lines = []
    for line in tpl.read_text(encoding="utf-8").splitlines():
        m = MARK.match(line)
        lines += svg_fence(tpl.parent / m.group(1)) if m else [line]
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("written:", out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
