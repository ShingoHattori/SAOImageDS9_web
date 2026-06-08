# DS9 Web Viewer

SAOImage DS9 の「基本ビュワー」機能を **ブラウザネイティブ**（クライアントサイド完結）で
再現した FITS ビュワーです。サーバーは静的ファイルを配るだけで、FITS の解析・スケーリング・
カラーマップ・描画はすべてブラウザ内（JavaScript / Canvas）で行います。アップロードした
ファイルが外部に送られることはありません。

## 機能

- **ファイルを開く** — 「Open FITS…」ボタン / ドラッグ＆ドロップ（`.fits .fit .fts .fz`）
- **画像表示** — BITPIX 8 / 16 / 32 / 64 / -32 / -64、BZERO/BSCALE/BLANK 対応
- **複数 HDU** — 拡張に含まれる画像 HDU を選択して切り替え
- **データキューブ / 視線速度** — 3次元 FITS（PPV キューブ）の速度チャンネルを送りながら、
  各速度での強度マップを表示。第3軸 WCS（VRAD/VELO/FREQ/WAVE）から視線速度を計算して表示。
  スライダー・前後ボタン・▶再生・矢印キー・Shift+ホイールで切り替え（DS9 Cube 相当）
- **スケール関数** — linear / log / power / sqrt / squared / asinh / sinh / histequ
  （式は DS9 `tksao/frame/colorscale.C` と一致）
- **表示レンジ** — zscale / zmax / minmax / user / 99.5 / 99 / 98 / 95 / 90%、Low/High 直接入力
- **カラーマップ** — grey / a / b / bb / he / i8 / aips0 / heat / cool / rainbow / standard /
  staircase / color / red / green / blue（DS9 `colorbar/default.C` の定義を移植、invert 可）
- **コントラスト/バイアス** — 右ドラッグ（または Shift + ドラッグ）で DS9 風に調整
- **ズーム / パン** — ホイールでズーム、ドラッグでパン、fit / 1:1 ボタン、`+` `-` `f` キー
- **サイドパネル（DS9相当）** — Panner（全体ナビ・クリック/ドラッグでパン）、Magnifier（カーソル拡大）、
  Colorbar（カラーマップ表示・low/high目盛）、Pixel Table（カーソル周辺 7×7 の画素値）、Region List
- **Regions（DS9 看板機能）** — circle / ellipse / box / line / point / polygon の作成・選択・移動・
  リサイズ・回転（ellipse/box）・削除、色設定、リージョン一覧、**DS9 region 形式（image座標）の
  import / export**。ツールバーで図形を選び画像上でドラッグ（polygon は頂点クリック→始点クリックで閉じる）。
  Del で削除、Esc でツール解除
- **座標系** — image / fk5 (sexagesimal) / fk5 (degrees) / galactic を切り替えて読み取り
- **カーソル読み取り** — ピクセル座標・ピクセル値・選択座標系での天球座標
- **ヘッダ表示** — FITS ヘッダカードをそのまま表示

## 使い方

### 1. そのまま開く（サーバー不要）

`web/index.html` をブラウザで開くだけで動きます（`file://` でも可）。
「Open FITS…」からローカルの FITS を選択してください。

### 2. ローカルの簡易サーバー

```bash
cd web
python3 -m http.server 8080
# → http://localhost:8080/
```

### 3. Docker

```bash
cd web
docker build -t ds9-web .
docker run --rm -p 8080:80 ds9-web
# → http://localhost:8080/
```

## サンプル

- `samples/demo.fits` — 256×256 float32、星3つ + ノイズ + TAN WCS（`samples/make_demo.py` で生成）
- `samples/cube.fits` — 64×64×32 の電波スペクトルキューブ（RA・Dec・VRAD）。速度の異なる3つの
  輝線雲を含み、チャンネルを送ると各視線速度での強度マップが切り替わる（`samples/make_cube.py` で生成）
- `samples/test_int32.fits` — リポジトリ同梱の 15×15 int32 画像

ブラウザで `http://localhost:8080/?file=samples/cube.fits` のように開くと自動で読み込みます
（`&ch=5` で開始チャンネル指定）。サンプルは numpy 不要の Python で再生成できます。

## 構成

| ファイル | 役割 |
|----------|------|
| `index.html` | UI レイアウト |
| `js/fits.js` | FITS パーサ（HDU 分割・ヘッダ・画像読み込み） |
| `js/scale.js` | 転送関数と zscale / percentile レンジ推定 |
| `js/colormap.js` | カラーマップ LUT |
| `js/wcs.js` | TAN 投影の最小 WCS（カーソル読み取り用） |
| `js/viewer.js` | Canvas 描画・ズーム/パン・コントラスト/バイアス |
| `js/main.js` | UI と Viewer の接続 |

## 制限

ビュワー（画像閲覧）に特化しています。リージョン編集、解析タスク連携（XPA/SAMP）、
バイナリテーブルのプロット等、DS9 本体の高度な機能は対象外です。WCS はカーソル読み取り
向けの TAN 投影簡易実装で、厳密な測地計算用ではありません。
