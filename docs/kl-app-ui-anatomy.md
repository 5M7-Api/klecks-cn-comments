# `kl-app.ts` 界面构造解析

> 本文档专注于 `KlApp` 类的构造函数中，各实例化类与画面实际区域之间的对应关系。

---

## 一、画面整体布局

Klecks 的界面由两大区域构成，两者通过绝对定位并排占满整个视口：

```
┌──────────────────────────────────────────┬──────────────┐
│                                          │              │
│                                          │  toolspace   │
│              easel                       │  工具面板    │
│            (画板区)                      │  271px 宽    │
│                                          │              │
│                                          │              │
└──────────────────────────────────────────┴──────────────┘
         （剩余宽度，position: absolute）     （右/左侧固定）

另有浮在两者之上的全局元素：
  - mobileUi     （移动端折叠按钮，窄屏时出现）
  - statusOverlay（画面中央的状态提示文字）
  - overlayToolspace（笔刷快捷调节浮层，右键/双指触发）
```

`rootEl` 是根容器（`position: absolute`，撑满整个视口），构造函数末尾将以下元素 append 进去：

```typescript
BB.append(this.rootEl, [
    this.easel.getElement(),   // 画板区
    this.toolspace,            // 工具面板
    this.mobileUi.getElement() // 移动端悬浮按钮
]);
// 稍后追加：
this.rootEl.append(overlayToolspace.getElement()); // 笔刷浮层
```

---

## 二、左侧/右侧：`toolspace` 工具面板

`toolspace` 是一个宽度固定为 **271px** 的 `div`（`position: absolute`，根据 `uiLayout` 靠左或靠右），内部由一个 `toolspaceInner` 子容器按**从上到下**的顺序垂直堆叠所有控件。

以下按 **DOM 顺序**（即视觉上从上到下）列出各区域及其对应的实例：

---

### 2-①  顶部菜单栏 — `ToolspaceTopRow` / `EmbedToolspaceTopRow`

```typescript
this.toolspaceTopRow = new KL.ToolspaceTopRow({ ... });
// Embed 模式下为：
this.toolspaceTopRow = new EmbedToolspaceTopRow({ ... });
```

**画面位置**：工具面板的最顶部一行。

**Standalone 模式**（`ToolspaceTopRow`）显示：
- Klecks Logo（点击跳转主页）
- 新建（New）、导入（Import）、保存（Save）、分享（Share）、帮助（?）按钮

**Embed 模式**（`EmbedToolspaceTopRow`）显示：
- 提交（Submit）按钮、帮助、左右切换按钮

---

### 2-②  工具图标行 — `ToolspaceToolRow`

```typescript
this.toolspaceToolRow = new KL.ToolspaceToolRow({ ... });
```

**画面位置**：Logo 栏正下方，一排工具图标按钮。

显示内容（从左到右）：
- 画笔（Brush）、手型（Hand）、填充（Paint Bucket）、渐变（Gradient）、文字（Text）、形状（Shape）、选区（Select）图标
- 放大（+）、缩小（−）按钮
- 撤销（↩）、重做（↪）按钮

点击任一工具图标后，`easel` 会切换到对应工具，`mainTabRow` 会同步打开对应参数面板。

---

### 2-③  图层缩略图 — `LayerPreview`

```typescript
this.layerPreview = new KL.LayerPreview({ ... });
```

**画面位置**：工具图标行下方，一个小的画布缩略图预览块。

- 实时显示当前图层的内容
- 点击后跳转到「图层」Tab（`mainTabRow?.open('layers')`）
- 窗口高度小于 579px 时自动隐藏（`setIsVisible(false)`）

---

### 2-④  主 Tab 导航行 — `TabRow`（`mainTabRow`）

```typescript
mainTabRow = new KL.TabRow({
    initialId: 'brush',
    tabArr: [ ... ]  // 11个tab
});
```

**画面位置**：LayerPreview 正下方，一行图标/文字 tab 标签。

包含 11 个 Tab（对应下方参数区域的切换）：

| Tab ID | 图标/标签 | 激活时显示的下方区域 |
|---|---|---|
| `brush` | 🖌️ 画笔 | 颜色滑块 + 笔刷参数区（`brushDiv`） |
| `hand` | ✋ 手型 | `HandUi` 视口控制 |
| `paintBucket` | 🪣 填充 | `FillUi` 填充参数 |
| `gradient` | 🌈 渐变 | `GradientUi` 渐变参数 |
| `text` | T 文字 | `TextUi` 文字参数 |
| `shape` | ⬜ 形状 | `ShapeUi` 形状参数 |
| `select` | ⬚ 选区 | `SelectUi` 选区参数 |
| `layers` | 图层图标 | `LayersUi` 图层管理 |
| `edit` | 编辑图标 | `EditUi` 编辑操作 |
| `file` | "File" 文字 | `FileUi` 文件操作（仅 Standalone 模式） |
| `settings` | ⚙️ 设置 | `SettingsUi` 应用设置 |

> **注意**：`hand`/`paintBucket`/`gradient`/`text`/`shape`/`select` 这 6 个 Tab 默认 `isVisible: false`，只有在对应工具被激活时才显示，避免标签栏过度拥挤。

---

### 2-⑤  Tab 内容区（下方大块区域）

Tab 内容区占据 toolspace 的主体空间，各区域实例对应关系如下。同一时刻只有当前激活 Tab 对应的区域可见：

#### A. 画笔参数区（`brushDiv` + `KlColorSlider` + `brushTabRow`）

当 `mainTabRow` 切到 `brush` Tab 时可见，由多个部分组成：

**`KlColorSlider`** — 颜色选择器

```typescript
this.klColorSlider = new KL.KlColorSlider({ ... });
```

横向渐变色带 + 下方 HSV 色块，点击取色；还有取色器（眼药水）图标按钮。

**`ToolspaceStabilizerRow`** — 稳定器档位选择

```typescript
const toolspaceStabilizerRow = new KL.ToolspaceStabilizerRow({ ... });
```

一行小按钮，选择笔触平滑等级（0~10 档）。

**`TabRow`（`brushTabRow`）** — 笔刷子 Tab

```typescript
const brushTabRow = new KL.TabRow({ initialId: 'penBrush', ... });
```

一排笔刷类型图标（钢笔/混合/素描/像素/Chemy/涂抹/橡皮擦），切换时展示对应笔刷的参数 UI（由 `brushUiMap` 中对应实例的 `getElement()` 提供）。

---

#### B. 手型工具参数 — `HandUi`

```typescript
const handUi = new KL.HandUi({ ... });
```

显示当前缩放比例、旋转角度，提供「重置」「适应窗口」按钮，以及旋转角度输入框。

---

#### C. 填充工具参数 — `FillUi`

```typescript
const fillUi = new KL.FillUi({ colorSlider: this.klColorSlider });
```

容差（Tolerance）、不透明度、采样（Sample）、扩展（Grow）、连续（Contiguous）、橡皮擦模式等参数。

---

#### D. 渐变工具参数 — `GradientUi`

```typescript
const gradientUi = new KL.GradientUi({ colorSlider: this.klColorSlider });
```

渐变类型（线性/径向）、方向反转、不透明度、锁定 Alpha、橡皮擦模式等。

---

#### E. 文字工具参数 — `TextUi`

```typescript
const textUi = new KL.TextUi({ colorSlider: this.klColorSlider });
```

字体选择、字号、对齐方式、加粗/斜体等预设（点击画布后弹出完整文字对话框）。

---

#### F. 形状工具参数 — `ShapeUi`

```typescript
const shapeUi = new KL.ShapeUi({ colorSlider: this.klColorSlider, ... });
```

形状类型（矩形/椭圆/直线）、填充/描边模式、固定比例、线宽、橡皮擦模式、锁定 Alpha 等。

---

#### G. 选区工具参数 — `KlAppSelect`（的 `SelectUi`）

```typescript
const klAppSelect = new KlAppSelect({ klCanvas, ... });
// Tab 中使用：
klAppSelect.getSelectUi().getElement()
```

`KlAppSelect` 是选区逻辑的聚合器，内部持有 `EaselSelect`（画板交互）和 `SelectUi`（侧边栏 UI）。参数面板显示：套索/矩形模式切换、变换（Transform）模式切换、填充/清除选区等操作按钮。

---

#### H. 图层管理面板 — `LayersUi`

```typescript
this.layersUi = new KL.LayersUi({ klCanvas: this.klCanvas, ... });
```

图层列表（可上下拖拽排序）、每个图层的：可见性眼睛、名称、缩略图、混合模式下拉、不透明度滑块；以及添加图层、删除图层、合并图层等按钮。

---

#### I. 编辑操作面板 — `EditUi`

```typescript
const editUi = new KL.EditUi({ klRootEl, klColorSlider, ... });
```

图像操作入口，包括：裁剪/扩展（Crop/Extend）、缩放（Resize）、翻转（Flip）、旋转（Rotate）、透视变换、自由变形（FFD）、曲线、滤镜菜单等。每个操作点击后弹出对应的滤镜对话框（`filter-*.ts`）。

---

#### J. 文件操作面板 — `FileUi`

```typescript
const fileUi = new KL.FileUi({ ... }); // 仅 Standalone 模式
```

显示：导出格式切换（PNG/JPEG/PSD）、保存到本地、新建画布、上传到 Imgur；以及浏览器本地存储（Browser Storage）的存取入口、崩溃恢复管理。

---

#### K. 设置面板 — `SettingsUi`

```typescript
const settingsUi = new KL.SettingsUi({ ... });
```

工具栏左右位置切换（Left/Right）、保存提醒设置、关于 Klecks 信息（或自定义 `aboutEl`）。

---

### 2-⑥  底部附加栏 — `bottomBarWrapper`

```typescript
this.bottomBarWrapper = BB.el({ ... });
// 若传入 p.bottomBar 才显示
```

**画面位置**：工具面板最底部（`position: absolute, bottom: 0`）。

仅当宿主页面通过构造参数传入 `bottomBar: HTMLElement` 时才显示（用于 Embed 模式下的自定义底部按钮区）。当工具面板内容撑满整个窗口高度时，此栏自动隐藏以避免遮挡。

---

### 2-⑦  侧边栏滚动条控制 — `ToolspaceScroller`

```typescript
this.toolspaceScroller = new KL.ToolspaceScroller({
    toolspace: this.toolspace,
    uiState: this.uiLayout,
});
```

不直接渲染可见内容，而是监控 `toolspace` 的滚动状态，在内容超出时在边缘显示阴影/渐变提示（告知用户可以滚动）。

---

## 三、右侧主体（全屏）：`Easel` 画板区

```typescript
this.easel = new Easel({
    width: ..., height: ...,
    tools: { brush, hand, select, eyedropper, paintBucket, gradient, text, shape, rotate, zoom },
    tool: 'brush',
    ...
});
```

**画面位置**：`position: absolute; left: 271px; top: 0`（toolspace 在左时），占满除工具面板以外的全部空间。

`Easel` 是整个画板交互区的容器，内部管理：

- **`ProjectViewport`**：画布的缩放/平移/旋转视口，负责将 `KlCanvas` 的内容渲染到屏幕上（含图层合成显示）
- **工具路由**：根据当前激活工具，将指针/触摸事件分发给对应的 `EaselXxx` 工具实例处理
- **选区蒙版叠加**：在画布上方用 SVG 或 Canvas 渲染选区虚线框

`Easel` 内部实例化的各工具对象（在 `kl-app.ts` 中创建后传入）：

| 实例 | 类 | 职责 |
|---|---|---|
| `this.easelBrush` | `EaselBrush` | 接收笔触事件，经 `LineSmoothing`/`LineSanitizer` 链后驱动画笔绘制 |
| `easelHand` | `EaselHand` | 拖拽平移视口（含惯性滚动） |
| `klAppSelect.getEaselSelect()` | `EaselSelect` | 套索/矩形选区绘制 + 选区内容变换 |
| `EaselEyedropper` | `EaselEyedropper` | 点击画布取色，写回 `KlColorSlider` |
| `EaselPaintBucket` | `EaselPaintBucket` | 点击后触发 `klCanvas.floodFill()` |
| `EaselGradient` | `EaselGradient` | 拖拽绘制渐变起终点 |
| `EaselText` | `EaselText` | 点击后弹出文字输入对话框 |
| `easelShape` | `EaselShape` | 拖拽绘制形状，支持平移模式（panning） |
| `EaselRotate` | `EaselRotate` | 拖拽旋转视口角度 |
| `EaselZoom` | `EaselZoom` | 点击/拖拽缩放视口 |

---

## 四、全局浮层元素

以下元素浮在画板和工具面板之上，不属于任一固定区域：

### `StatusOverlay` — 状态提示

```typescript
this.statusOverlay = new KL.StatusOverlay();
```

画面中央（或右侧）短暂出现的文字提示，如「已撤销」「已保存」「缩放 150%」「已填充选区」等。不可交互，几秒后自动消失。

---

### `OverlayToolspace` — 笔刷快捷浮层

```typescript
overlayToolspace = new KL.OverlayToolspace({
    enabledTest: ...,
    brushSettingService,
});
```

右键画板（或双指在触屏上操作）时弹出的环形/浮动快捷面板，可快速调节笔刷大小、不透明度。在有对话框打开或画板锁定时禁用。

---

## 五、移动端专属：`MobileUi` + `MobileBrushUi` + `MobileColorUi`

```typescript
this.mobileUi     = new MobileUi({ ... });
this.mobileBrushUi = new MobileBrushUi({ ... });
this.mobileColorUi = new MobileColorUi({ ... });
```

当窗口宽度 < **820px**（`collapseThreshold`）时激活：

- **`MobileUi`**：在画板右下角（或左下角）显示一个汉堡/展开按钮，点击后将 toolspace 滑入/滑出（toolspace 此时 `display: none`，整个画板撑满屏幕）
- **`MobileBrushUi`**：浮动在画板上的笔刷/橡皮擦快速切换小面板（仅画笔工具激活时显示）
- **`MobileColorUi`**：浮动在画板上的颜色选择器（折叠态只显示当前颜色色块，点击后展开完整选色界面；包含取色器入口）

---

## 六、数据与渲染的连接线

`KlApp` 中有两个关键的"桥接"对象，不直接对应画面区域，但驱动着画面的实时刷新：

**`KlHistory`** — 历史记录  
每次操作后 push 一条记录；`addListener` 回调触发 `EaselProjectUpdater.update()`，更新画板渲染。

**`EaselProjectUpdater`** — 画板内容更新器

```typescript
this.easelProjectUpdater = new EaselProjectUpdater({
    klCanvas: this.klCanvas,
    easel: this.easel,
});
```

每当图层数据发生变化（绘画、滤镜、撤销/重做等），调用 `update()` 将 `KlCanvas` 的最新图层数据同步到 `Easel` 的渲染管线中，触发一帧重绘。

---

## 七、一图总结：实例 → 画面区域映射

```
KlApp.rootEl（视口根容器）
│
├── Easel.getElement()                     ← 画板主区域（左/全部空间）
│   ├── ProjectViewport                       画布视口（缩放/平移/旋转）
│   ├── EaselBrush                            当前笔触交互层
│   ├── EaselHand / EaselRotate / EaselZoom   视口操作工具
│   ├── EaselEyedropper / EaselPaintBucket    点击操作工具
│   ├── EaselGradient / EaselShape / EaselText 拖拽/点击绘制工具
│   └── EaselSelect（来自 KlAppSelect）        选区绘制与变换
│
├── toolspace div                          ← 工具面板（271px，左或右）
│   └── toolspaceInner
│       ├── ToolspaceTopRow                   ① 顶部菜单栏（Logo/文件操作）
│       ├── ToolspaceToolRow                  ② 工具图标行（工具切换/缩放/撤销）
│       ├── LayerPreview                      ③ 图层缩略图
│       ├── TabRow（mainTabRow）               ④ 主 Tab 导航
│       │
│       ├── [brush Tab content]               ⑤-A 画笔参数区
│       │   ├── KlColorSlider                     颜色选择器
│       │   ├── ToolspaceStabilizerRow            稳定器选择
│       │   ├── TabRow（brushTabRow）              笔刷类型子Tab
│       │   └── brushUiMap[*].getElement()         各笔刷参数UI
│       │
│       ├── HandUi                            ⑤-B 手型工具参数
│       ├── FillUi                            ⑤-C 填充参数
│       ├── GradientUi                        ⑤-D 渐变参数
│       ├── TextUi                            ⑤-E 文字参数
│       ├── ShapeUi                           ⑤-F 形状参数
│       ├── KlAppSelect.getSelectUi()         ⑤-G 选区参数
│       ├── LayersUi                          ⑤-H 图层管理
│       ├── EditUi                            ⑤-I 编辑/滤镜操作
│       ├── FileUi（Standalone 模式）          ⑤-J 文件操作
│       ├── SettingsUi                        ⑤-K 应用设置
│       └── bottomBarWrapper                  ⑥  底部附加栏（可选）
│
├── MobileUi.getElement()                  ← 移动端折叠按钮（窄屏时浮现）
│   ├── MobileBrushUi                         笔刷/橡皮快速切换
│   └── MobileColorUi                         颜色快速选择
│
├── StatusOverlay                          ← 画面中央状态提示文字（浮层）
└── OverlayToolspace                       ← 右键快捷笔刷浮层
```
