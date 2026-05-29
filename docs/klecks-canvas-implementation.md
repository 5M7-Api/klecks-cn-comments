# Klecks 画布实现深度解析

> 关联源文件速查表附在每节标题后，方便对照阅读代码。

---

## 一、总体架构：三层分离

Klecks 的画布系统严格分为三层，各层职责清晰：

```
┌─────────────────────────────────────────────────────────┐
│  渲染层  ProjectViewport                                │  ← 只管"怎么显示"
│          将 KlCanvas 的数据画到屏幕上                   │
├─────────────────────────────────────────────────────────┤
│  数据层  KlCanvas                                       │  ← 只管"数据是什么"
│          图层数组 + 对每层 Canvas 的读写操作            │
├─────────────────────────────────────────────────────────┤
│  历史层  KlHistory                                      │  ← 只管"记录发生了什么"
│          差异条目链表 + 合成状态 (composed)             │
└─────────────────────────────────────────────────────────┘
```

三层通过以下两个接口联系：
- `KlCanvas` → `KlHistory`：每次操作后调用 `klHistory.push(diff)` 写入差异
- `KlHistory` → `KlCanvas`：撤销/重做后调用 `klCanvas.updateViaComposed(before, after)` 回放到画布
- `KlHistory` → `ProjectViewport`：历史变更后广播，触发 `EaselProjectUpdater.update()` 刷新显示

---

## 二、数据层：`KlCanvas`

**源文件**：`src/app/script/klecks/canvas/kl-canvas.ts`

### 2.1 图层的数据结构

每个图层是一个 `TKlCanvasLayer` 对象：

```typescript
type TKlCanvasLayer = {
    id: TLayerId;           // 唯一字符串 ID（UUID）
    index: number;          // 在图层数组中的位置
    name: string;
    mixModeStr: TMixMode;   // 对应 Canvas2D globalCompositeOperation
    isVisible: boolean;
    opacity: number;        // 0.0 ~ 1.0
    compositeObj?: TLayerComposite; // 临时合成步骤（变换预览时使用）
    canvas: HTMLCanvasElement;      // 实际像素数据
    context: CanvasRenderingContext2D;
};
```

**关键设计**：每个图层是一块独立的 `HTMLCanvasElement`，最多 16 层（`MAX_LAYERS = 16`）。图层不挂载到 DOM 中——它们只是内存中的离屏 Canvas，由渲染层负责合成显示。

### 2.2 图层操作一览

| 方法 | 作用 | 是否写入历史 |
|---|---|---|
| `reset(p)` | 重置为新项目（1~N 层） | ✅（整张快照） |
| `addLayer(index, data?)` | 在指定位置上方插入新层 | ✅ |
| `duplicateLayer(srcIndex)` | 复制图层 | ✅ |
| `removeLayer(index)` | 删除图层，释放 Canvas 内存 | ✅ |
| `moveLayer(index, delta)` | 上移/下移图层 | ✅（仅更新 index） |
| `mergeLayers(bottom, top)` | 合并两层（通过 globalCompositeOperation） | ✅ |
| `mergeAll()` | 合并全部图层到第 0 层 | ✅ |
| `resize(w, h, algorithm)` | 缩放所有图层（smooth/pixelated） | ✅ |
| `resizeCanvas(p)` | 裁剪/扩展画布（偏移量方式） | ✅ |
| `rotate(deg)` | 旋转整个画布（90/180/270°） | ✅ |
| `flip(h, v, layerIndex?)` | 翻转（支持翻转单层） | ✅ |
| `layerFill(index, color)` | 纯色填充图层 | ✅（优化为 fill 标记） |
| `eraseLayer(p)` | 清除图层（支持 AlphaLock/选区剪切） | ✅ |
| `floodFill(...)` | 洪水填充，支持多种采样模式 | ✅（仅记录变化区域） |
| `drawShape(...)` | 绘制矩形/椭圆/直线 | ✅（仅变化区域） |
| `drawGradient(...)` | 绘制渐变 | ✅ |
| `text(...)` | 渲染文字 | ✅（仅文字包围盒区域） |
| `drawOperation(index, fn)` | 任意 Canvas 绘制操作 | ✅ |
| `setOpacity / setMixMode / setLayerIsVisible / renameLayer` | 属性变更 | ✅（仅对应属性字段） |
| `setComposite(index, obj)` | 设置临时合成步骤（变换预览） | ❌（不进历史） |
| `setSelection(polygon?)` | 更新当前选区 | ✅ |
| `updateViaComposed(before, after)` | 撤销/重做时回放历史 | ❌（由历史系统驱动） |

### 2.3 选区如何与画布操作结合

`KlCanvas` 内部持有一个 `selection?: MultiPolygon`（来自 `polygon-clipping` 库的多边形格式）。

凡涉及像素写入的操作（`layerFill`、`eraseLayer`、`floodFill`、`drawShape`、`drawGradient`、`text`）都会判断 `this.selection` 是否存在：

```typescript
// 如果有选区，用 Path2D 剪切
if (this.selection) {
    const selectionPath = getSelectionPath2d(this.selection);
    ctx.clip(selectionPath);
}
```

画布变换操作（`resize`、`rotate`、`flip`、`resizeCanvas`）会同步变换选区多边形的坐标（通过 `transformMultiPolygon` / `translateMultiPolygon`）。

### 2.4 合成输出

`getCompleteCanvas(factor, maskSelection?)` — 把所有图层合并成一张图：

**源文件**：`src/app/script/klecks/canvas/draw-project.ts`

```
遍历 layers（从底到顶）
  → 跳过 isVisible=false 或 opacity=0 的层
  → ctx.globalAlpha = layer.opacity
  → ctx.globalCompositeOperation = layer.mixModeStr
  → ctx.drawImage(layer.image, ...)
```

这是 PSD 导出、PNG 保存、完整预览的底层逻辑。

### 2.5 取色器的特殊实现

**源文件**：`src/app/script/klecks/canvas/eyedropper.ts`

取色器 **不从 canvas 读取像素**，而是从 `KlHistory` 的 `composed`（合成状态）里直接读 `ImageData` 的 Tile 数据，然后用一个 1×1 的临时 canvas 做合成计算颜色。

这样做的好处是**避免 GPU 回读**（`getImageData` 触发 GPU→CPU 的同步回读性能较差），直接在 CPU 侧计算颜色。

---

## 三、历史层：`KlHistory` 与 Tile 差异系统

**源文件**：
- `src/app/script/klecks/history/kl-history.ts`
- `src/app/script/klecks/history/history.types.ts`
- `src/app/script/klecks/history/compose-history-state-data.ts`
- `src/app/script/klecks/history/image-data-tile.ts`
- `src/app/script/klecks/history/estimate-bytes.ts`
- `src/app/script/klecks/history/trim-oldest-entries.ts`
- `src/app/script/klecks/history/push-helpers/canvas-to-layer-tiles.ts`
- `src/app/script/klecks/history/push-helpers/create-layer-map.ts`

### 3.1 核心数据结构

历史系统有两种数据形态：

**① 差异条目 `THistoryEntryData`（每步操作记录的变化）**

```typescript
type THistoryEntryData = {
    projectId?: { value: string };   // 项目 ID 改变时才有
    size?: { width; height };        // 尺寸改变时才有
    selection?: { value?: MultiPolygon }; // 选区改变时才有
    activeLayerId?: string;          // 活动层改变时才有
    layerMap?: Record<TLayerId, THistoryEntryLayer>; // 有变化的层
};
```

`THistoryEntryLayer` 也是**稀疏的**——只有变化了的属性才会出现：

```typescript
type THistoryEntryLayer = {
    name?: string;
    opacity?: number;
    isVisible?: boolean;
    mixModeStr?: TMixMode;
    index?: number;
    tiles?: (THistoryEntryLayerTile | undefined)[]; // undefined = 该 Tile 未变化
};
```

**② 合成状态 `THistoryEntryDataComposed`（当前完整状态）**

这是把所有历史差异"叠加"到一起的完整快照，由 `composeHistoryStateData()` 计算得出，存在 `KlHistory.composed` 字段中，随时可读。

### 3.2 Tile 切片机制

图层的像素数据不是整块存储的，而是按 **256×256 像素**切成若干个 Tile：

```
一个 800×600 的图层 → 4列 × 3行 = 12 个 Tile
(最右列和最底行可能不足 256px)
```

每个 Tile 是 `THistoryEntryLayerTile`，有两种形态：
- **`TImageDataTile`**：包含 `ImageData`（真实像素，有 UUID）
- **`TLayerFill`**：`{ fill: 'rgba(255,0,0,1)' }`（纯色优化，只记一个字符串）

**纯色优化**：`layerFill()` 和 `eraseLayer()`（整层情况）会生成 `TLayerFill` 类型的 Tile 而非 `ImageData`，大幅节省内存（一整层只存一个字符串）。

**变化区域优化**：笔刷绘画、洪水填充、绘制形状等操作会计算**实际变化的包围盒 `bounds`**，只重新读取包围盒内的 Tile，未变化的 Tile 存为 `undefined`（即沿用上一个有效值）。

```
canvas → canvasToLayerTiles(canvas, bounds) → (THistoryEntryLayerTile | undefined)[]
                                               ↑↑ bounds 外的 Tile 是 undefined
```

### 3.3 push 流程（每次操作后）

```
KlCanvas.someOperation()
  └─ createLayerMap(layers, ...) → 生成稀疏的 THistoryEntryData.layerMap
      └─ canvasToLayerTiles(canvas, bounds?) → 读取变化的 Tile
  └─ klHistory.push(entryData)
      └─ 剪除 index 之后的 redo 条目
      └─ trimOldestEntries() → 内存管理
      └─ updateComposed() → 重新计算合成状态
      └─ broadcast() → 通知监听者（触发渲染）
```

### 3.4 撤销/重做流程

```
用户按 Ctrl+Z
  └─ klHistory.decreaseIndex()
      └─ index--
      └─ updateComposed() → 重新计算合成状态
      └─ broadcast()
          └─ EaselProjectUpdater.update()
              └─ klCanvas.updateViaComposed(before, after)
                  └─ updateLayersViaComposed() → 差分更新 Canvas
                      ← 只有变化了的 Tile 才调用 ctx.putImageData()
```

**源文件**：`src/app/script/klecks/canvas/update-layers-via-composed.ts`

`updateLayersViaComposed` 逐 Tile 比较 before/after 的合成状态，只有真正变化的 Tile（引用不同）才调用 `ctx.putImageData()`，其余 Tile 跳过，最大程度减少 CPU→GPU 的数据传输。

### 3.5 内存管理

**源文件**：`src/app/script/klecks/history/trim-oldest-entries.ts`

每次 `push` 后都会运行 `trimOldestEntries()`，策略如下：

| 条件 | 行为 |
|---|---|
| 总内存 ≤ **200 MB** | 保留全部历史条目 |
| 总内存 > 200 MB | 开始裁剪最旧的普通条目（< 10 MB 的条目） |
| 大条目（> 10 MB）且 age > 50 步 | 强制裁剪 |
| 总内存 > **1 GB** | 硬上限，强制裁剪到上限以下 |

裁剪方式：将最旧的 N 个条目通过 `composeHistoryStateData()` 合并成一个"最老完整状态"，替换它们，**保留完整状态以防止继续撤销到裁剪点之前**。

单个条目的内存估算（`estimate-bytes.ts`）：每像素 4 字节（RGBA），纯色 Tile 按字符串长度估算。

### 3.6 暂停机制

`klHistory.pause(true/false)` 用于批量操作：

```typescript
klHistory.pause(true);
try {
    // 多个子操作，每个都内部调用了 push
    // 但因为 paused，push 实际是 noop
} finally {
    klHistory.pause(false);
}
// 此处再手动 push 一次合并后的状态
klHistory.push(mergedEntry);
```

`pauseStack` 是计数器（非布尔值），支持嵌套调用 pause。

---

## 四、渲染层：`ProjectViewport` 与 `EaselProjectUpdater`

**源文件**：
- `src/app/script/klecks/ui/project-viewport/project-viewport.ts`
- `src/app/script/klecks/ui/project-viewport/kl-canvas-preview.ts`

### 4.1 ProjectViewport 的渲染逻辑

`ProjectViewport` 有一块自己的 `HTMLCanvasElement`（渲染目标），每帧通过 `render()` 方法重新绘制：

```
render()
  1. 绘制棋盘格背景（透明区域指示）
  2. 应用视口变换矩阵（scale + rotate + translate）
     → ctx.setTransform(matrix)
  3. 遍历 project.layers（底层到顶层）：
       跳过 isVisible=false 或 opacity=0 的层
       ctx.globalAlpha = layer.opacity
       ctx.globalCompositeOperation = layer.mixModeStr
       若 layer.image 是函数（TProjectViewportLayerFunc）→ 调用它获取图像
       否则直接 ctx.drawImage(layer.canvas, ...)
  4. 调用 renderAfter callback（用于绘制选区虚线框等覆盖内容）
```

**视口变换**（`TViewportTransform`）包含四个参数：
- `scale`：1 表示一个画布像素 = 一个 CSS 像素
- `angleDeg`：视口旋转角度
- `x` / `y`：视口平移（CSS 像素）

变换顺序（矩阵乘法）：`translate → rotate → scale`

**分辨率**：`useNativeResolution` 为 `true` 时，canvas 的实际像素 = CSS 尺寸 × `devicePixelRatio`，保证 Retina 屏锐利显示。

**`TProjectViewportLayerFunc`**：某些图层不直接提供图像，而是提供一个函数。调用时传入当前视口变换，返回图像或带额外变换矩阵的图像。这用于变换工具预览——图层内容通过矩阵实时变形显示，而不修改底层 Canvas。

### 4.2 EaselProjectUpdater — 数据到渲染的桥梁

`EaselProjectUpdater` 监听 `KlHistory` 的变更事件，每次触发时：

1. 从 `KlCanvas.getLayersFast()` 取出所有图层的轻量描述
2. 调用 `easel.setProject(project)` 更新 `ProjectViewport` 持有的 `project`
3. 调用 `easel.requestFrame()` 安排下一帧重绘（非立即绘制，节流）

`getLayersFast()` 返回的是对原始 `canvas` 对象的引用，没有数据复制，零额外内存开销。

### 4.3 KlCanvasPreview — 工具面板的图层缩略图

**源文件**：`src/app/script/klecks/ui/project-viewport/kl-canvas-preview.ts`

侧边栏 `LayerPreview` 使用 `KlCanvasPreview`，它也是一块独立的 canvas，每次调用 `render()` 时：

```
遍历 layers
  → ctx.globalAlpha = opacity
  → ctx.globalCompositeOperation = mixModeStr
  → ctx.drawImage(layer.image, 0, 0, previewW, previewH)
    ↑ 缩放到预览尺寸（如果 scale > 1 则关闭抗锯齿保持像素风格）
```

---

## 五、笔触绘画管线

笔触绘画是最频繁的画布写入操作，经过多个处理阶段：

```
用户手指/鼠标/笔
    ↓
PointerListener（bb/input/pointer-listener.ts）
  统一 mouse/touch/pen 事件 → TPointerEvent
    ↓
CoalescedExploder（event-chain）
  展开 getCoalescedEvents()，恢复高频采样点
    ↓
EaselBrush（klecks/ui/easel/tools/easel-brush.ts）
  坐标转换：屏幕坐标 → 画布坐标（inverse matrix）
  处理 Shift 直线模式、光标显示
    ↓
onLineStart / onLineGo / onLineEnd 回调
    ↓
LineSmoothing（klecks/events/line-smoothing.ts）
  指数移动平均平滑：pos = mix(新pos, 旧pos, smoothing)
  smoothing 来自 ToolspaceStabilizerRow 的 0~10 档（映射到 0~0.9）
    ↓
LineSanitizer（klecks/events/line-sanitizer.ts）
  去除重复点、过滤无效压感
    ↓
具体 Brush 实例（PenBrush / BlendBrush / SketchyBrush / ...）
  .startLine(x, y, pressure)
  .goLine(x, y, pressure)    ← 绘制笔触到 layer.context
  .endLine()
    ↓
klCanvas.getLayerContext(activeLayerIndex)
  直接调用 ctx.drawImage() / ctx.putImageData() 等
    ↓
（笔触结束后）klHistory.push(diff)
  createLayerMap(layers, { layerId, attributes: ['tiles'], bounds: strokeBounds })
```

**笔触期间不写历史**：`LineStart` 到 `LineEnd` 之间历史是暂停的（或者笔触绘制本身是逐点增量到 canvas 上的），只有 `endLine` 后才 push 一条包含整个笔触变化区域的历史记录。

**compositeObj 的作用**：变换工具（自由变换、FFD）激活时，调用 `klCanvas.setComposite(layerIndex, obj)` 为目标图层设置一个临时的 `draw` 回调，`ProjectViewport` 在渲染该层时会调用这个回调（而非直接 `drawImage`）。变换结束后清空 `compositeObj`，把变换结果真正写入 canvas，再 push 历史。

---

## 六、关键流程图总结

### 正常绘画操作

```
用户绘画
  → Brush.goLine() 修改 layer.canvas
  → （笔触结束）KlCanvas.push diff（变化 Tile）
      → KlHistory.push → updateComposed() → broadcast()
          → EaselProjectUpdater.update()
              → ProjectViewport.render()（下一帧）
```

### 撤销

```
Ctrl+Z
  → KlHistory.decreaseIndex()
      → updateComposed() → broadcast()
          → EaselProjectUpdater.update()
              → KlCanvas.updateViaComposed(before, after)
                  → updateLayersViaComposed()
                      → 只有变化 Tile 才 ctx.putImageData()
              → ProjectViewport.render()
```

### 滤镜操作

```
用户执行滤镜（如高斯模糊）
  → applyFxFilter() 用 WebGL 处理，结果写回 layer.canvas
  → KlCanvas.drawOperation() 包裹
  → KlHistory.push（整层 Tile，因为全图变化）
  → 渲染更新
```

---

## 七、相关源文件速查

| 功能 | 源文件路径 |
|---|---|
| 画布核心类 | `klecks/canvas/kl-canvas.ts` |
| 图层合成输出 | `klecks/canvas/draw-project.ts` |
| 撤销回放 | `klecks/canvas/update-layers-via-composed.ts` |
| 取色器 | `klecks/canvas/eyedropper.ts` |
| 历史记录核心 | `klecks/history/kl-history.ts` |
| 历史类型定义 | `klecks/history/history.types.ts` |
| 合成状态计算 | `klecks/history/compose-history-state-data.ts` |
| Tile 读取 | `klecks/history/push-helpers/canvas-to-layer-tiles.ts` |
| layerMap 构建 | `klecks/history/push-helpers/create-layer-map.ts` |
| Tile 类型 | `klecks/history/image-data-tile.ts` |
| 内存估算 | `klecks/history/estimate-bytes.ts` |
| 内存裁剪 | `klecks/history/trim-oldest-entries.ts` |
| 视口渲染 | `klecks/ui/project-viewport/project-viewport.ts` |
| 侧边缩略图渲染 | `klecks/ui/project-viewport/kl-canvas-preview.ts` |
| 画板笔触交互 | `klecks/ui/easel/tools/easel-brush.ts` |
| 笔触平滑 | `klecks/events/line-smoothing.ts` |
| 洪水填充算法 | `klecks/image-operations/flood-fill.ts` |
| 渐变绘制 | `klecks/image-operations/gradient-tool.ts` |
| 形状绘制 | `klecks/image-operations/shape-tool.ts` |
| 文字渲染 | `klecks/image-operations/render-text.ts` |
