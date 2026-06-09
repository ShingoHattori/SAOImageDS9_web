# DS9 Web Viewer

SAOImage DS9 の主要機能を **ブラウザネイティブ**（クライアントサイド完結）で再現した FITS
ビュワーです。サーバーは静的ファイルを配るだけで、FITS の解析・スケーリング・カラーマップ・
描画はすべてブラウザ内（JavaScript / Canvas）で行います。アップロードしたファイルが外部に
送られることはありません。

**ドキュメント**: 使い方は [USAGE.md](USAGE.md)、DS9 ネイティブ版との機能対応は
[DS9_MAPPING.md](DS9_MAPPING.md) を参照してください。

## 機能

- **ファイルを開く** — 「Open FITS…」ボタン / ドラッグ＆ドロップ（`.fits .fit .fts .fz`）
- **画像表示** — BITPIX 8 / 16 / 32 / 64 / -32 / -64、BZERO/BSCALE/BLANK 対応
- **複数 HDU** — 拡張に含まれる画像 HDU を選択して切り替え
- **複数フレーム（DS9 Frame）** — タブ列で切替/削除。複数ファイル同時オープン（multiple 選択 /
  ドラッグ＆ドロップ）で各ファイルがフレームになり、自動で tile 表示。各フレームは
  画像・ビュー・スケール・カラーマップ・リージョンを独立保持。**blink**（フレーム巡回表示）、
  **lock frames**（スケール／カラーマップ／pan・zoom をフレーム間で共有 → ブリンク比較に最適）、
  **tile**（全フレームをグリッド表示、クリックでそのフレームをアクティブ化）
- **RGB フレーム** — 3つの FITS を R/G/B チャンネルに割り当てて合成表示（チャンネルごとに low/high）。
  「＋RGB」ボタンのダイアログから作成（同梱キューブの3速度chで合成する demo ボタン付き）
- **3D フレーム** — データキューブを MIP（最大値投影）で立体表示、ドラッグで回転。
  「＋3D」ボタン（アクティブがキューブならそれを、無ければ同梱キューブを 3D 化）
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
- **オーバーレイ** — Contour（等値線・レベル数指定、marching squares）、Coordinate grid
  （RA/Dec 等値線）、Crosshair（カーソル十字線）
- **画像処理** — Smoothing（gaussian / boxcar・半径指定）、Binning（block average, ×2/4/8）、
  Flip X / Flip Y / Rotate 90°（座標変換として実装、リージョン・オーバーレイも追従）
- **プロット** — Histogram（画素値分布、**クリックでスケール上下限設定**）、Horizontal/Vertical cut
  （カーソル行・列の断面、追従）、Radial profile（**Gaussian フィット**で FWHM/σ/peak）、
  Projection（line リージョンに沿った断面）。**export ボタンで CSV 保存**
- **バイナリテーブル / イベント** — BINTABLE を認識し、X/Y 列を画像にビニング（イベントファイル表示）、
  任意列のヒストグラム（`samples/events.fits` サンプル付き）
- **領域統計** — 選択領域内の npix / sum / mean / median / stddev / min / max / centroid を
  サイドバー Region Stats に表示（circle / box / ellipse / polygon）
- **座標系 / WCS** — image / fk5(sexg) / fk5(deg) / galactic、投影法 TAN/SIN/ARC/STG/CAR、
  フレーム間の WCS 整列ロック（lock frames）
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
| `js/fits.js` | FITS パーサ（HDU 分割・ヘッダ・画像読み込み・BINTABLE） |
| `js/scale.js` | 転送関数と zscale / percentile レンジ推定 |
| `js/colormap.js` | DS9 カラーマップ LUT |
| `js/wcs.js` | WCS（TAN/SIN/ARC/STG/CAR、pix↔sky、galactic） |
| `js/smoothing.js` | 平滑化（gaussian/boxcar）・ビニング |
| `js/viewer.js` | Canvas 描画・ズーム/パン・コントラスト/バイアス・RGB/3D・向き |
| `js/panels.js` | Panner / Magnifier / Colorbar / Pixel Table |
| `js/regions.js` | リージョン（作成・編集・統計・DS9 形式 I/O） |
| `js/overlays.js` | Contour / Grid / Crosshair（marching squares） |
| `js/plots.js` | Histogram / cut / radial(fit) / projection / 列ヒストグラム |
| `js/main.js` | UI と各モジュールの接続 |

## 制限

DS9 の主要なビュワー＋解析機能をブラウザネイティブに再実装したものです。次は対象外です：
外部連携（XPA / SAMP）、画像サーバ取得（DSS 等）、カタログ、ASCII テーブル（BINTABLE は対応）。
3D はフルボリュームレンダラではなく MIP/mean/sum 投影。WCS は TAN/SIN/ARC/STG/CAR の5投影
（全投影網羅ではない）で、厳密な測地計算用ではありません。
