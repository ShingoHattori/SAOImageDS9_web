# DS9 Web Viewer — 使い方ガイド

ブラウザネイティブな FITS ビュワー（SAOImage DS9 の主要機能をブラウザ内で再現）の操作マニュアルです。
機能概要は [README.md](README.md) を参照してください。

---

## 1. 起動

いずれの方法でもブラウザ内で完結し、開いたファイルが外部に送られることはありません。

```bash
# A. そのまま開く（サーバ不要）
#    web/index.html をブラウザにドラッグ、または file:// で開く

# B. 簡易サーバ
cd web && python3 -m http.server 8080      # → http://localhost:8080/

# C. Docker
cd web
docker build -t ds9-web .
docker run -d --name ds9web -p 8080:80 ds9-web   # → http://localhost:8080/
#   停止: docker stop ds9web  /  削除: docker rm -f ds9web
#   コード更新後は build し直して run し直す（ブラウザはハードリロード）
```

---

## 2. ファイルを開く

- **Open FITS…** ボタン … 1つ以上の FITS を選択（複数選択可）
- **ドラッグ＆ドロップ** … 画像エリアにファイルを落とす（複数可）
- 複数同時に開くと**各ファイルがフレームになり、自動で tile 表示**されます
- 対応: `.fits .fit .fts .fz`、BITPIX 8/16/32/64/-32/-64、BZERO/BSCALE/BLANK、複数 HDU、3次元キューブ

サンプル: `samples/demo.fits`（星）, `samples/demo2.fits`（拡散源）, `samples/cube.fits`（速度キューブ）。
URL で直接開く例: `http://localhost:8080/?file=samples/cube.fits`

---

## 3. 基本操作（マウス／キーボード）

### マウス
| 操作 | 動作 |
|---|---|
| ドラッグ | パン（画像移動）／3D フレームでは回転 |
| ホイール | ズーム（カーソル位置を中心） |
| 右ドラッグ（または Shift＋ドラッグ） | コントラスト／バイアス調整（DS9 風） |
| Shift＋ホイール | キューブの速度チャンネル送り |
| Panner をクリック／ドラッグ | その位置へパン |

### キーボード
| キー | 動作 |
|---|---|
| `+` / `-` | ズームイン／アウト |
| `f` | 画面にフィット |
| `←` `→` `↑` `↓` | キューブのチャンネル送り |
| `Space` | キューブ再生／停止 |
| `Delete` / `Backspace` | 選択中リージョン削除 |
| `Esc` | polygon 作成キャンセル／ツールを pointer に戻す |

ツールバーの **fit / 1:1** ボタンでも倍率変更できます。

---

## 4. スケール・表示レンジ・カラーマップ

上部ツールバー（1段目）:

- **Scale** … `linear / log / power / sqrt / squared / asinh / sinh / histequ`（式は DS9 準拠）
- **Limits** … `zscale / zmax / minmax / user / 99.5 / 99 / 98 / 95 / 90%`
- **Low / High** … 数値を直接入力すると `user` モードになり手動上下限を設定
- **Colormap** … `grey / a / b / bb / he / i8 / aips0 / heat / cool / rainbow / standard / staircase / color / red / green / blue`
- **invert** … カラーマップ反転
- 右ドラッグでコントラスト／バイアスを動かすと Colorbar パネルに反映されます

---

## 5. データキューブ（視線速度）

3次元 FITS を開くと下部に**キューブバー**が出ます。

- スライダー／`⏮ ◀ ⏯ ▶ ⏭`／矢印キー／`Shift＋ホイール`でチャンネル送り
- `⏯`（または `Space`）で連続再生
- 各チャンネルの**視線速度**（VRAD/VELO/FREQ/WAVE から計算）を表示（例 `v = -40.65 km/s`）
- **lock scale**（1段目）を ON にすると全チャンネル同一レンジ → 輝線の出入りが見える

---

## 6. サイドパネル（右）

- **Panner** … 全体ナビ。青枠が現在の表示範囲。クリック／ドラッグでパン
- **Magnifier** … カーソル周辺の拡大（十字線つき）
- **Colorbar** … 現在のカラーマップと low/high 目盛
- **Pixel Table** … カーソル周辺 7×7 の画素値（中央セル強調）
- **Region List** … リージョン一覧（クリックで選択）
- **Region Stats** … 選択リージョンの統計（§9）

ステータスバー（最下部）: 画素座標・画素値・天球座標（座標系は **coord** セレクタ：`image / fk5(sexg) / fk5(deg) / galactic`）・zoom・low/high。

---

## 7. フレーム（複数画像の管理）

2段目の **Frame** バー。各フレームは画像・ビュー・スケール・カラー・リージョンを独立保持します。

- **タブ** … クリックで切替、`×` で削除
- **◀ ▶** … 前後フレーム
- **single / tile / blink**
  - **tile** … 全フレームをグリッド表示。タイルをクリックでそのフレームをアクティブ化
  - **blink** … フレームを巡回表示（比較用）
- **lock frames** … スケール／カラー／pan・zoom をフレーム間で共有（ブリンク比較に最適）
- **＋RGB** … 3つの FITS を R/G/B に割当てて合成（§8）
- **＋3D** … キューブを立体表示（§8）
- **delete** … 現在のフレームを削除

### 8. RGB フレーム / 3D フレーム
- **RGB**: `＋RGB` → ダイアログで R/G/B 各チャンネルにファイルを割当て（low/high は zscale 自動・編集可）→ **create frame**。
  `demo (cube ch)` ボタンで同梱キューブの3速度チャンネルから即合成できます。
- **3D**: `＋3D` → アクティブがキューブならそれを、無ければ同梱キューブを立体表示。
  **画像をドラッグで回転**、投影法は **MIP / mean / sum** を `＋3D` 隣のセレクタで切替。

---

## 9. リージョン（図形マーカー）

3段目の **Regions** バー。

### 作成
1. 図形ツールを選ぶ: `pointer / ◯circle / ⬭ellipse / ▭box / ╱line / ⬠polygon / ✛point`
2. 画像上でドラッグして作成
   - **polygon** は頂点を順にクリック→**始点をクリックで閉じる**（`Esc` でキャンセル）
   - **point** はクリックで配置

### 編集（pointer ツール）
- 図形をクリックで選択 → ドラッグで移動
- 角／辺のハンドルでリサイズ、ellipse/box は**回転ハンドル**で回転
- **color** で色変更、`Delete` で削除、**clear** で全削除

### 入出力
- **export** … DS9 region 形式（image 座標）で `.reg` 保存
- **import** … DS9 region ファイル読み込み（image/physical 座標）

### 領域統計（Region Stats パネル）
circle / box / ellipse / polygon を選択すると、領域内画素の
`npix / sum / mean / median / stddev / min / max / 強度重心(centroid)` を表示します。

---

## 10. オーバーレイ

Regions バー右の **Overlay** グループ:

- **contour** … 等値線（隣の数値でレベル数）。marching squares で計算
- **grid** … RA/Dec 座標グリッド（WCS がある場合）
- **crosshair** … カーソル追従の十字線

---

## 11. 画像処理（Image グループ）

- **smooth** … 平滑化。`gaussian / boxcar` と半径を指定
- **bin** … ビニング（ブロック平均）`1 / 2 / 4 / 8`
- **flip X / flip Y / rot 90 / ⟲(reset)** … 反転・90°回転（リージョン・オーバーレイも追従）

---

## 12. プロット（plot ボタン）

1段目右の **plot** ボタン（※ファイルを開くと有効化）。モーダルで種類を選択:

- **histogram** … 画素値分布
- **horizontal cut / vertical cut** … カーソル行・列の断面（カーソル追従）
- **radial profile** … 中心まわりの方位平均
  - **選択中の circle があればその中心**、無ければカーソル位置が中心
  - **Gaussian フィット**を青破線で重畳し、`FWHM / σ / peak` を表示
- **projection (line)** … 選択中の **line リージョン**に沿った断面（距離 vs 値）
- **histogram 上でクリック=Low／Shift+クリック=High** … その場でスケール上下限を設定（青/赤の破線が現在値）
- **export**（モーダル右上） … 現在のプロット値を CSV 保存

---

## 13. バイナリテーブル / イベントデータ

BINTABLE を含む FITS を開くと **Table バー**が出ます（イベントリスト等）。

- **Table HDU** セレクタ … テーブル HDU を選択
- **X / Y** セレクタ＋**bin to image** … X/Y 列を 2D カウント画像にビニングして画像フレーム化
  （`TLMIN/TLMAX` を範囲に使用、最大辺 512px 目安）
- **col** セレクタ＋**plot column** … 任意の数値列のヒストグラム
- イベントのみの FITS（画像 HDU 無し）はビニングするまでキャンバスは空です
- サンプル: `samples/events.fits`（30000 行、X/Y/ENERGY）

## 14. WCS / 座標系の補足

- 座標系: `image / fk5(sexg) / fk5(deg) / galactic`
- 投影法: **TAN / SIN / ARC / STG / CAR** に対応（pixToSky と逆変換 skyToPix の両方）
- **lock frames** は WCS がある場合、フレーム間で**天球座標で位置と縮尺を整列**（無ければピクセル共有）

## 15. その他

- **header** … FITS ヘッダカードを表示
- **HDU** セレクタ … 複数 HDU を切替

---

## 16. URL パラメータ（デモ・自動化用）

`?` 以降に指定すると読み込み時に自動適用されます（動作確認やデモ用）。

| パラメータ | 例 | 内容 |
|---|---|---|
| `file` | `?file=samples/cube.fits` | ファイルを開く |
| `frames` | `?frames=a.fits,b.fits` | 複数ファイルをフレームとして開く |
| `frame` | `&frame=1` | アクティブフレーム指定（0始まり） |
| `ch` | `&ch=5` | 開始チャンネル |
| `tile` | `&tile=1` | tile 表示 |
| `lock` | `&lock=1` | lock frames ON |
| `overlay` | `&overlay=contour,grid,cross` | オーバーレイ ON |
| `smooth` / `bin` | `&smooth=2` `&bin=4` | 平滑化／ビニング |
| `orient` | `&orient=rot90` (`flipx`/`flipy`/`rot180`/`rot270`) | 向き |
| `plot` | `&plot=radial` | プロットを開く |
| `rgb` | `?rgb=demo` | サンプルキューブで RGB フレーム作成 |
| `cube3d` / `proj3d` | `?cube3d=1&proj3d=mean` | 3D フレーム作成／投影法 |
| `tablebin` | `?file=samples/events.fits&tablebin=1` | テーブルの X/Y を画像にビニング |
| `plotcol` | `?file=samples/events.fits&plotcol=ENERGY` | 列のヒストグラムを表示 |
| `probe` | `&probe=170,150` | カーソル位置をシミュレート（列,行 / 0始まり） |
| `addregions` / `select` | `&addregions=1&select=0` | デモ用リージョンを追加／N番を選択 |

---

## 17. 対象外（DS9 にあるが未実装）

外部連携（XPA / SAMP）、画像サーバ取得（DSS 等）、カタログ、ASCII テーブル（BINTABLE は対応）、
WCS は TAN/SIN/ARC/STG/CAR の5投影（全投影網羅ではない）、3D はフルボリュームではなく MIP/mean/sum 投影、
印刷／PDF 出力、画像の保存／エクスポート。
