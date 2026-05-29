# Klecks 开源代码库架构分析

> **项目主页**：https://github.com/bitbof/klecks  
> **技术栈**：TypeScript · SCSS · Parcel · WebGL  
> **定位**：社区资助的在线绘图应用，为 [Kleki.com](https://kleki.com) 提供支持

---

## 一、宏观概述

Klecks 是一款基于 Web 的专业绘图应用，最初用 JavaScript 编写，于 2021 年 12 月迁移至 TypeScript。它以 **Parcel** 作为构建工具，支持两种运行模式：

- **Standalone 模式**：作为独立网页应用运行（如 kleki.com）
- **Embed 模式**：嵌入到第三方网站中（如绘图社区 2draw.net）

整个代码库以 `src/` 为根，核心逻辑全部位于 `src/app/script/` 下，按功能职责划分为若干相对独立的模块层。

---

## 二、顶层目录结构

```
klecks/
├── src/                        # 全部源代码
│   ├── index.html              # Standalone 入口页面
│   ├── embed.ts                # Embed 模式入口
│   ├── help.html               # 帮助页面
│   ├── tsconfig.json           # TypeScript 配置
│   ├── app/                    # 主应用代码
│   │   ├── fonts/              # 字体资源
│   │   ├── img/ui/             # UI 图标与图像资源
│   │   ├── style/              # 全局 SCSS 样式
│   │   └── script/             # 所有 TypeScript 逻辑（核心）
│   └── languages/              # 多语言翻译文件（JSON5）
├── examples/embed/             # Embed 模式使用示例
├── package.json                # 依赖与构建脚本
├── Dockerfile / docker-compose.yml
└── README.md
```

---

## 三、`src/app/script/` 核心模块详解

`script/` 目录是代码库的核心所在，分为以下几个顶层命名空间：

```
script/
├── app/            # 应用顶层入口与控制台 API
├── bb/             # 底层工具库（Browser Base）
├── embed/          # Embed 模式专属逻辑
├── fx-canvas/      # WebGL 滤镜引擎
├── klecks/         # 绘图应用核心业务逻辑
├── language/       # 国际化运行时
├── polyfills/      # 浏览器兼容补丁
└── theme/          # 主题（深色/浅色）管理
```

---

### 3.1 `app/` — 应用顶层入口

| 文件 | 职责 |
|---|---|
| `kl-app.ts` | 应用主类，负责组装所有模块、初始化应用 |
| `kl-app-import-handler.ts` | 处理文件导入逻辑（拖拽、粘贴、URL 导入） |
| `kl-app-select.ts` | 选区工具在应用层的集成逻辑 |
| `console-api.ts` | 暴露给开发者的控制台调试 API |

`kl-app.ts` 是整个应用的"胶水层"，将画布、历史记录、UI 面板、工具栏等模块组合成完整的绘图应用。

---

### 3.2 `bb/` — 底层工具库（Browser Base）

这是 Klecks 自研的基础工具集，与业务逻辑解耦，可视为应用的"标准库"。

```
bb/
├── base/       # 浏览器基础工具
├── color/      # 颜色运算
├── input/      # 输入事件处理
├── math/       # 数学工具
├── multi-polygon/  # 多边形选区运算
└── transform/  # 矩阵变换工具
```

**`bb/base/`** — 基础浏览器能力封装：
- `base.ts`：UUID 生成、通用工具函数
- `browser.ts`：浏览器特性检测（设备类型、是否支持压感等）
- `canvas.ts` / `create-canvas.ts`：Canvas 创建与管理
- `indexed-db.ts` / `local-storage.ts` / `session-storage.ts`：持久化存储封装
- `cross-tab-channel.ts`：跨 Tab 通信
- `save-as.ts`：文件下载触发
- `ui.ts`：通用 DOM 操作工具

**`bb/input/`** — 统一输入事件系统：
- `pointer-listener.ts`：统一处理鼠标、触摸、Pen 事件
- `gesture-listener.ts`：双指缩放/旋转手势识别
- `key-listener.ts`：键盘快捷键监听
- `pressure-normalizer.ts`：笔压归一化处理
- `wheel-cleaner.ts`：滚轮事件标准化
- `event-chain/`：事件处理链（责任链模式），支持聚合事件（Coalesced Events）

**`bb/color/`** — 颜色空间运算（RGB/HSV 互转等）

**`bb/math/`** — 矩阵运算、坐标变换、边界框计算

**`bb/multi-polygon/`** — 多边形布尔运算，用于复杂选区（依赖 `polygon-clipping` 库）

**`bb/transform/`** — 视口变换、坐标系映射

---

### 3.3 `klecks/` — 绘图核心业务

这是代码量最大的模块，涵盖绘图应用的全部核心功能。

```
klecks/
├── brushes/          # 画笔引擎
├── brushes-ui/       # 画笔参数 UI
├── canvas/           # 画布核心（图层管理）
├── events/           # 笔触平滑与折线清理
├── filters/          # 图像滤镜（非 WebGL 调度层）
├── history/          # 撤销/重做历史记录系统
├── image-operations/ # 像素级图像操作
├── select-tool/      # 选区工具逻辑
├── storage/          # 文件存储与项目序列化
├── transform/        # 自由变换（FFD 形变）
├── ui/               # 全部界面组件
└── utils/            # 杂项工具
```

#### 3.3.1 `brushes/` — 画笔引擎

每种画笔独立实现，通过 `brushes.ts` 统一导出：

| 文件 | 画笔类型 |
|---|---|
| `pen-brush.ts` | 钢笔（支持笔压、抖动稳定器） |
| `blend-brush.ts` | 混合/湿笔刷（颜色混合效果） |
| `sketchy-brush.ts` | 素描笔（随机多线条风格） |
| `pixel-brush.ts` | 像素笔（硬边缘像素画风格） |
| `chemy-brush.ts` | Chemy 笔（受 Alchemy 启发的对称/随机笔） |
| `smudge-brush.ts` | 涂抹笔（采样并扩散颜色） |
| `eraser-brush.ts` | 橡皮擦 |
| `alphas/` | 画笔纹理 Alpha 形状数据 |
| `brushes-common.ts` | 共享笔触计算逻辑（压感曲线、间距等） |

#### 3.3.2 `canvas/` — 画布与图层管理

| 文件 | 职责 |
|---|---|
| `kl-canvas.ts` | 核心画布类，管理所有图层、最大 16 层 |
| `draw-project.ts` | 将项目所有图层合成渲染到一张画布 |
| `kl-canvas-transform.ts` | 画布变换操作（旋转、裁剪、缩放） |
| `kl-canvas-ffd.ts` | 自由变形（Free-Form Deformation）的画布集成 |
| `eyedropper.ts` | 取色器逻辑（采样画布颜色） |
| `translate-blending.ts` | CSS 混合模式到 Canvas 混合模式的映射 |
| `update-layers-via-composed.ts` | 通过历史状态合成更新图层 |

#### 3.3.3 `history/` — 撤销/重做系统

采用**差异（diff）+ 合成（composed）状态**双轨架构：

- `kl-history.ts`：核心 `KlHistory` 类，管理操作条目列表和当前索引；支持暂停推送（用于批量操作）
- `kl-history-executor.ts`：执行撤销/重做的实际图层更新
- `kl-temp-history.ts`：临时历史（笔触过程中使用）
- `estimate-bytes.ts`：估算历史条目占用内存，自动裁剪最旧条目以限制内存
- `image-data-tile.ts`：将图层数据切片（256×256 Tile）存储以节省内存
- `compose-history-state-data.ts`：将多个 diff 条目合并为完整状态
- `push-helpers/`：各类操作（透明度变更、可见性切换、图层创建等）推送历史的辅助函数

#### 3.3.4 `filters/` — 图像滤镜调度

这一层是滤镜的**业务封装层**，调用底层 WebGL（`fx-canvas`）或 Canvas2D 实现：

| 文件 | 功能 |
|---|---|
| `filter-blur.ts` | 高斯模糊 |
| `filter-tilt-shift.ts` | 移轴模糊 |
| `filter-curves.ts` | 曲线调整（RGB/明度） |
| `filter-brightness-contrast.ts` | 亮度/对比度 |
| `filter-hue-saturation.ts` | 色相/饱和度 |
| `filter-noise.ts` | 噪点 |
| `filter-distort.ts` | 扭曲变形 |
| `filter-perspective.ts` | 透视变换 |
| `filter-resize.ts` | 缩放画布 |
| `filter-crop-extend.ts` | 裁剪/扩展画布 |
| `filter-rotate.ts` | 旋转画布 |
| `filter-flip.ts` | 水平/垂直翻转 |
| `filter-invert.ts` | 颜色反转 |
| `filter-to-alpha.ts` | 线稿提取（转为透明度通道） |
| `filter-transform.ts` | 自由变换 |
| `filter-unsharp-mask.ts` | 锐化 |
| `filter-grid.ts` | 叠加网格 |
| `filter-pattern.ts` | 图案叠加 |
| `filter-vanish-point.ts` | 消失点辅助线 |
| `apply-fx-filter.ts` | 将 WebGL 滤镜结果写回 Canvas |
| `filters.ts` | 滤镜注册表（菜单项定义） |
| `filters-lazy.ts` | 懒加载滤镜（避免首屏加载 WebGL） |

#### 3.3.5 `image-operations/` — 像素级操作

| 文件 | 功能 |
|---|---|
| `flood-fill.ts` | 油漆桶洪水填充算法 |
| `gradient-tool.ts` | 渐变绘制（线性/径向） |
| `shape-tool.ts` | 形状绘制（矩形、椭圆、直线） |
| `render-text.ts` | 文字栅格化渲染 |
| `gpu-composite-canvas.ts` | GPU 加速图层合成 |
| `draw-grid.ts` | 网格辅助线绘制 |
| `draw-vanish-point.ts` | 消失点辅助线绘制 |

#### 3.3.6 `select-tool/` — 选区工具

- `select-tool.ts`：套索/矩形选区逻辑，依赖 `multi-polygon` 进行选区布尔运算
- `get-binary-mask.ts`：将多边形选区转为像素掩码
- `get-selection-bounds.ts`：计算选区边界框

#### 3.3.7 `storage/` — 文件存储与项目持久化

| 文件 | 功能 |
|---|---|
| `psd.ts` | PSD 格式导入/导出（依赖 `ag-psd` 库） |
| `kl-canvas-to-psd-blob.ts` | 将画布图层序列化为 PSD Blob |
| `load-ag-psd.ts` | 懒加载 ag-psd（代码分割） |
| `save-to-computer.ts` | 触发 PNG/JPEG/PSD 下载 |
| `project-store.ts` | 当前项目状态管理（内存中） |
| `project-converter.ts` | 旧版项目格式升级迁移 |
| `kl-indexed-db.ts` | IndexedDB 封装（本地自动保存） |
| `kl-recovery-manager.ts` | 崩溃恢复管理器（定期保存快照） |
| `kl-recovery-storage.ts` | 恢复数据的 IndexedDB 存储 |
| `file-header-detection.ts` | 通过文件头字节判断图片格式 |
| `request-persistent-storage.ts` | 申请浏览器持久化存储权限 |

#### 3.3.8 `transform/` — 自由变换与 FFD

- `ffd.ts`：自由形变（Free-Form Deformation）核心算法，基于贝塞尔网格
- `ffd-renderer.ts`：FFD 变形网格的实时渲染
- `ffd-utils.ts`：FFD 辅助计算
- `composed-transformation.ts` / `create-transformation-composite.ts`：组合变换矩阵
- `selection-sample.ts`：变换时对选区内像素的采样

---

### 3.4 `klecks/ui/` — 用户界面层

UI 层按职责划分为多个子模块：

```
ui/
├── components/       # 通用 UI 组件库
├── easel/            # 画板交互区（工具事件路由）
│   └── tools/        # 各工具的画板交互实现
├── mobile/           # 移动端专属 UI
├── modals/           # 对话框/弹窗
├── project-viewport/ # 画布视口（缩放/平移预览）
├── tool-tabs/        # 侧边工具面板（各工具参数区）
│   └── layers-ui/    # 图层管理面板
└── utils/            # UI 工具函数
```

**`components/`** — 通用组件（约 40 个）：
- 滑块：`kl-slider.ts`、`kl-slider-manual-input.ts`、`point-slider.ts`
- 颜色：`kl-color-slider.ts`、`kl-color-slider-small.ts`、`color-options.ts`
- 控件：`checkbox.ts`、`dropdown-menu.ts`、`radio-list.ts`、`options.ts`、`select.ts`
- 自由变换画布：`free-transform.ts`、`free-transform-canvas.ts`
- 工具栏组件：`toolspace-tool-row.ts`、`toolspace-top-row.ts`、`toolspace-stabilizer-row.ts`
- 存储提示：`browser-storage-ui.ts`、`save-reminder.ts`
- 其他：`tab-row.ts`、`overlay-toolspace.ts`、`pinch-zoom-watcher.ts`

**`easel/tools/`** — 画板工具实现（每个工具处理自己的鼠标/触摸事件）：

| 文件 | 工具 |
|---|---|
| `easel-brush.ts` | 画笔（含笔触方向锁定辅助） |
| `easel-eyedropper.ts` | 取色器 |
| `easel-gradient.ts` | 渐变工具 |
| `easel-hand.ts` | 手型工具（平移画布） |
| `easel-paint-bucket.ts` | 油漆桶 |
| `easel-rotate.ts` | 旋转画布 |
| `easel-select.ts` | 套索/矩形选区 |
| `easel-shape.ts` | 形状工具 |
| `easel-text.ts` | 文字工具 |
| `easel-zoom.ts` | 缩放工具 |
| `brush-cursor-round.ts` / `brush-cursor-pixel-square.ts` | 画笔光标渲染 |

**`tool-tabs/`** — 侧边栏工具参数面板：

每种工具对应一个 tab，显示对应工具的参数设置：`file-ui.ts`（文件操作）、`edit-ui.ts`（编辑）、`fill-ui.ts`（填充）、`gradient-ui.ts`、`text-ui.ts`、`shape-ui.ts`、`select-ui.ts`、`hand-ui.ts`、`settings-ui.ts`。

`layers-ui/` 包含图层面板、合并图层对话框、重命名对话框。

**`modals/`** — 弹窗对话框：
- `new-image-dialog.ts`：新建画布
- `show-import-image-dialog.ts` / `show-import-as-layer-dialog.ts`：导入图片
- `text-tool-dialog/`：文字工具对话框（含字体、大小、对齐等设置）
- `clipboard-dialog.ts`：剪贴板操作
- `imgur-upload.ts`：上传到 Imgur
- `color-slider-hex-dialog.ts`：十六进制颜色输入
- `recovery-manager-panel/`：崩溃恢复管理界面
- `licenses-dialog/`：开源许可声明

**`project-viewport/`** — 画布视口：
- `project-viewport.ts`：管理画布的缩放、平移、旋转视口变换
- `kl-canvas-preview.ts`：画布内容实时预览渲染
- `fx-preview-renderer.ts`：滤镜应用前的实时预览（WebGL）
- `preview.ts`：视口中的画布合成显示

**`mobile/`** — 移动端适配：
- `mobile-ui.ts`：移动端整体 UI 布局（浮动窗口、折叠面板）
- `mobile-brush-ui.ts`：触屏下的画笔快捷面板
- `mobile-color-ui.ts`：触屏下的颜色选择器
- `toolspace-collapser.ts`：工具栏折叠控制

---

### 3.5 `fx-canvas/` — WebGL 滤镜引擎

基于 [glfx.js](https://github.com/evanw/glfx.js)（MIT License）改造，提供 GPU 加速的图像处理能力。

```
fx-canvas/
├── core/
│   ├── fx-shader.ts    # GLSL Shader 编译与链接封装
│   ├── fx-texture.ts   # WebGL 纹理管理
│   └── gl.ts           # WebGL 上下文单例
├── filters/            # 各 WebGL 滤镜实现（GLSL Shader）
├── shaders/            # 共享 GLSL 代码片段（噪点函数、Warp Shader）
├── math/               # WebGL 相关数学工具
├── fx-canvas.ts        # 主 FxCanvas 类（API 入口）
├── fx-canvas-types.ts  # 类型定义
└── shared-fx.ts        # 共享 WebGL 操作
```

**已实现的 WebGL 滤镜**：亮度/对比度、曲线、色相/饱和度、噪点、高斯模糊（三角核）、移轴模糊、矩阵 Warp、锐化（Unsharp Mask）、线稿提取（To Alpha）、颜色反转、透视变换、扭曲、Alpha 预乘/反预乘、Mask 合成。

---

### 3.6 `embed/` — Embed 嵌入模式

- `embed.ts`（`src/` 根目录）：Embed 模式的打包入口
- `embed/bootstrap/`：Embed 模式初始化流程（建立 postMessage 通信接口、处理图片上传回调）
- `embed-toolspace-top-row.ts`：Embed 模式下定制的工具栏顶部区域（移除不适合嵌入的功能）

---

### 3.7 `language/` 与 `src/languages/` — 国际化

- `language.ts`：运行时翻译 API（`LANG('key')` 调用）
- `src/languages/`：各语言的 JSON5 翻译文件（`_base-en.json5` 为英文基准）
- 构建时由 `generate.js` 生成 `src/app/languages/` 下的 TS 类型文件

支持语言 10+，翻译键与 UI 文案一一对应。

---

### 3.8 `theme/` 与 `polyfills/`

- `theme/theme.ts`：深色/浅色主题切换，通过 CSS 变量统一管理颜色
- `polyfills/`：针对旧版浏览器的 API 兼容补丁（`mdn-polyfills` 库）

---

## 四、关键外部依赖

| 依赖 | 用途 |
|---|---|
| **Parcel 2** | 零配置打包工具，支持 SCSS、GLSL、TypeScript |
| **ag-psd** | PSD 文件的读写（图层保留存档） |
| **polygon-clipping** | 多边形布尔运算（选区的合并/相交/相减） |
| **transformation-matrix** | 2D 仿射变换矩阵运算（视口变换、图层变换） |
| **glfx.js**（内置改写） | WebGL 滤镜引擎基础，已整合为 `fx-canvas/` |
| **json5** | 解析带注释的 JSON5 翻译文件 |

---

## 五、模块依赖关系图

```
┌────────────────────────────────────────────────────────┐
│                    app/kl-app.ts                       │  ← 应用顶层入口
└───────────────┬──────────────────┬─────────────────────┘
                │                  │
    ┌───────────▼────────┐  ┌──────▼──────────────────────┐
    │   klecks/ui/       │  │   klecks/canvas/kl-canvas   │
    │  (界面层)          │  │   (画布与图层管理)           │
    └───────┬────────────┘  └──────┬──────────────────────┘
            │                      │
    ┌───────▼────────────────────  │  ──────────────────┐
    │   klecks/brushes/          │  klecks/filters/     │
    │   klecks/image-operations/ │  klecks/history/     │
    │   klecks/select-tool/      │  klecks/storage/     │
    │   klecks/transform/        │  klecks/events/      │
    └───────────────────────────────────────────────────┘
                      │
            ┌─────────▼─────────┐
            │   fx-canvas/      │  ← WebGL 滤镜引擎
            └─────────┬─────────┘
                      │
            ┌─────────▼─────────┐
            │   bb/             │  ← 底层工具库（输入、颜色、数学、存储）
            └───────────────────┘
```

---

## 六、两种运行模式的差异

| 特性 | Standalone 模式 | Embed 模式 |
|---|---|---|
| 入口文件 | `src/index.html` | `src/embed.ts` |
| 文件菜单 | 完整（新建/打开/保存/上传） | 精简（仅保存/上传，用于回传给宿主页面） |
| 通信方式 | 独立运行 | `postMessage` 与宿主页面交互 |
| 工具栏 | 标准 | `embed-toolspace-top-row.ts` 定制版 |
| 恢复功能 | 支持 | 暂不支持 |

---

## 七、构建产物

| 命令 | 产物 |
|---|---|
| `npm run build` | `dist/` — Standalone 完整应用 |
| `npm run build:embed` | `dist/embed.js` — 可嵌入的 JS Bundle |
| `npm run build:help` | `dist/help.html` — 帮助页面 |
| `npm run lang:build` | `src/app/languages/` — 编译后的翻译 TS 文件 |

---

*分析基于 klecks `main` 分支（2026年5月），共约 362 次提交，代码以 TypeScript（96.3%）和 SCSS（2.2%）为主。*
