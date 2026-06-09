# DS9 → Web Viewer 対応表

SAOImage DS9（ネイティブ版）の各機能が、この Web ビュワーのどこにあるかの対応表です。
DS9 のメニュー構成に沿って並べています。✅=実装、△=簡略版、❌=未実装。

## File
| DS9 | Web | 状態 |
|---|---|---|
| File ▸ Open | ツールバー **Open FITS…**（複数選択／D&D 可） | ✅ |
| File ▸ Open as ▸ Multiple frames | 複数ファイル選択＝複数フレーム＋自動 tile | ✅ |
| File ▸ Display Header | ツールバー **header** | ✅ |
| File ▸ Save / Export Image | — | ❌ |
| File ▸ Print | — | ❌ |

## Edit（操作モード）
| DS9 | Web | 状態 |
|---|---|---|
| Edit ▸ Pan | 画像をドラッグ | ✅ |
| Edit ▸ Zoom | ホイール（カーソル中心） | ✅ |
| Edit ▸ Colorbar（contrast/bias） | 右ドラッグ（または Shift＋ドラッグ） | ✅ |
| Edit ▸ Crosshair | Overlay **crosshair** | ✅ |
| Edit ▸ Region / Pointer | Regions バー **pointer** ツール | ✅ |

## View
| DS9 | Web | 状態 |
|---|---|---|
| View ▸ Colorbar | 右サイド **Colorbar** パネル | ✅ |
| View ▸ Panner | 右サイド **Panner** パネル | ✅ |
| View ▸ Magnifier | 右サイド **Magnifier** パネル | ✅ |
| Analysis ▸ Pixel Table | 右サイド **Pixel Table** パネル | ✅ |
| View ▸ Horizontal/Vertical Graph | **plot** ▸ horizontal/vertical cut | ✅ |
| View ▸ Info（座標・値） | ステータスバー（最下部） | ✅ |

## Frame
| DS9 | Web | 状態 |
|---|---|---|
| Frame ▸ New / Delete | Frame タブ（`×` で削除）/ **delete** | ✅ |
| Frame ▸ Next / Previous / Tab | タブクリック / **◀ ▶** | ✅ |
| Frame ▸ Single / Tile / Blink | **single / tile / blink** | ✅ |
| Frame ▸ Lock ▸ Scale/Colorbar/Frame | **lock frames**（まとめて1つ） | △ |
| Frame ▸ Lock ▸ WCS | **lock frames** の WCS 整列 | ✅ |
| Frame ▸ New Frame RGB | **＋RGB** | ✅ |
| Frame ▸ New Frame 3D | **＋3D**（MIP/mean/sum、ドラッグ回転） | △ |

## Bin
| DS9 | Web | 状態 |
|---|---|---|
| Bin ▸ Block（画像ビニング） | Image グループ **bin** | ✅ |
| Bin ▸ Binning Parameters（イベント） | Table ▸ **bin to image**（X/Y 列） | △ |

## Zoom
| DS9 | Web | 状態 |
|---|---|---|
| Zoom ▸ In/Out/Fit/1:1 | **+ / − / fit / 1:1**（`+ - f` キー） | ✅ |
| Zoom ▸ Rotate 90 / Orient（flip） | Image グループ **rot 90 / flip X / flip Y** | ✅ |
| Zoom ▸ Pan To | Panner クリック | ✅ |

## Scale
| DS9 | Web | 状態 |
|---|---|---|
| Scale ▸ linear/log/pow/sqrt/squared/asinh/sinh/histequ | **Scale** セレクタ | ✅ |
| Scale ▸ minmax/zscale/zmax/user/99.5..90% | **Limits** セレクタ | ✅ |
| Scale ▸ Scale Parameters（low/high） | **Low / High** 入力欄 | ✅ |
| Scale Parameters のヒストグラム上でドラッグして上下限設定 | **plot ▸ histogram** 上でクリック=Low／Shift+クリック=High | ✅ |

## Color
| DS9 | Web | 状態 |
|---|---|---|
| Color ▸ （各カラーマップ） | **Colormap** セレクタ（DS9 16色を移植） | ✅ |
| Color ▸ Invert Colormap | **invert** | ✅ |
| Color ▸ Contrast/Bias | 右ドラッグ | ✅ |

## Region
| DS9 | Web | 状態 |
|---|---|---|
| Region ▸ Shape（circle/ellipse/box/line/point/polygon） | Regions バーの図形ツール | ✅ |
| Region ▸ List Regions | 右サイド **Region List** | ✅ |
| Region ▸ Load / Save Regions | **import / export**（DS9 形式） | ✅ |
| Region ▸ Centroid / Get Information / Statistics | 右サイド **Region Stats** | ✅ |
| Analysis ▸ Projection（line 領域の断面） | **plot ▸ projection**（line 選択時） | ✅ |

## WCS
| DS9 | Web | 状態 |
|---|---|---|
| WCS ▸ fk5 / icrs / galactic / image | ステータスバー **coord** セレクタ | ✅ |
| WCS ▸ Sexagesimal / Degrees | coord の `fk5(sexg)` / `fk5(deg)` | ✅ |
| Analysis ▸ Coordinate Grid | Overlay **grid** | ✅ |
| 投影法 | TAN/SIN/ARC/STG/CAR に対応（全投影網羅ではない） | △ |

## Analysis
| DS9 | Web | 状態 |
|---|---|---|
| Analysis ▸ Image Examine / Histogram | **plot ▸ histogram** | ✅ |
| Analysis ▸ Radial Profile | **plot ▸ radial**（Gaussian フィット付き） | ✅ |
| Analysis ▸ Horizontal/Vertical Cut | **plot ▸ horizontal/vertical cut** | ✅ |
| Analysis ▸ Smooth | Image グループ **smooth**（gaussian/boxcar） | ✅ |
| Analysis ▸ Contours | Overlay **contour** | ✅ |
| Analysis ▸ Plot（データ書き出し） | plot モーダル **export**（CSV） | ✅ |
| Analysis ▸ Catalog / Image Server（DSS 等） | — | ❌ |
| Analysis ▸ SAMP / XPA | — | ❌ |

## Table（バイナリテーブル / イベント）
| DS9 | Web | 状態 |
|---|---|---|
| バイナリテーブル HDU の認識 | **Table** バー（列一覧） | △ |
| イベントリストを画像にビニング | Table ▸ **bin to image**（X/Y 列→画像フレーム） | △ |
| テーブル列のプロット | Table ▸ **plot column**（列ヒストグラム） | △ |

---
凡例: ✅ 実装 / △ 簡略版 / ❌ 未実装。
詳細な操作は [USAGE.md](USAGE.md) を参照。
