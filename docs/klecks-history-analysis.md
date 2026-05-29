# Klecks History 系统深度解析

> 源码路径：`src/app/script/klecks/history/`
> 涉及文件：`kl-history.ts`、`history.types.ts` 及其所有辅助模块

---

## 一、整体架构概览

Klecks 的历史记录（Undo/Redo）系统采用**增量差分（diff）+ 快照合成（compose）**的设计模式。

```
用户操作
   │
   ▼
push(entryData)          ← 只记录"变化了什么"（diff）
   │
   ▼
entries[]                ← 差分条目数组（最旧在 index 0）
   │
   ▼
composeHistoryStateData  ← 将 0..index 的所有 diff 合并为完整状态
   │
   ▼
composed                 ← 当前完整画布状态（随 undo/redo 实时更新）
```

**核心思路**：不存储每一步的完整图像，而是只存储"改变了什么"，大幅节省内存。需要知道当前完整状态时，再把所有 diff "叠加" 合成。

---

## 二、`history.types.ts` — 类型定义

### 2.1 基础类型

```ts
export type TLayerId = string;
```
图层的唯一标识符（字符串 UUID）。

---

```ts
export type TImageDataTile = {
    id: string;
    data: ImageData;
};
```
一个图像瓦片（Tile）。Klecks 把画布切分为 **256×256 像素**的方块（`HISTORY_TILE_SIZE = 256`），每个方块是一个 Tile，只有被笔刷"触碰过"的 Tile 才会被记录进历史。这是减少内存消耗的关键机制。

---

```ts
export type THistoryEntryLayerTile = TImageDataTile | TLayerFill;
```
一个 Tile 可以是：
- `TImageDataTile`：含有真实像素数据的方块
- `TLayerFill`：纯色填充（如透明或单色图层，用字符串表示，极省内存）

---

### 2.2 差分条目：`THistoryEntryLayer`

```ts
export type THistoryEntryLayer = {
    name?: string;          // 图层名称是否改变
    opacity?: number;       // 不透明度是否改变
    isVisible?: boolean;    // 可见性是否改变
    mixModeStr?: TMixMode;  // 混合模式是否改变
    index?: number;         // 图层顺序是否改变（上移/下移）
    tiles?: (THistoryEntryLayerTile | undefined)[];
    // undefined = 该 Tile 本次没有变化，有值 = 变化了
};
```

**关键设计**：所有字段都是可选的（`?`）。一次操作可能只改变了图层的某几个属性，其余字段保持 `undefined`，表示"此步未变"。这样单条 entry 可以非常小。

---

### 2.3 差分条目数据：`THistoryEntryData`

```ts
export type THistoryEntryData = {
    projectId?: { value: string };         // 项目 ID 是否改变（新建/导入）
    size?: { width: number; height: number }; // 画布尺寸是否改变
    selection?: { value?: MultiPolygon };  // 选区是否改变
    activeLayerId?: string;                // 当前活跃图层是否改变
    layerMap?: Record<TLayerId, THistoryEntryLayer>; // 哪些图层发生了什么变化
};
```

整个 `THistoryEntryData` 同样全部是可选字段。一次普通笔刷操作只会填入 `layerMap`，其余字段都是 `undefined`。

---

### 2.4 历史条目：`THistoryEntry`

```ts
export type THistoryEntry = {
    timestamp: number;           // 创建时的 Unix 时间戳（用于与 IndexedDB 同步对比）
    memoryEstimateBytes: number; // 该条目估算的内存占用（用于内存管理）
    description?: string;        // 可读描述，如 'brush stroke'、'oldest'
    data: THistoryEntryData;     // 实际的差分数据
};
```

---

### 2.5 合成状态：`THistoryEntryDataComposed` 和 `THistoryEntryLayerComposed`

```ts
export type THistoryEntryLayerComposed = Omit<Required<THistoryEntryLayer>, 'tiles'> & {
    tiles: THistoryEntryLayerTile[];
};
```

```ts
export type THistoryEntryDataComposed = Omit<Required<THistoryEntryData>, 'layerMap'> & {
    layerMap: Record<TLayerId, THistoryEntryLayerComposed>;
};
```

**"Composed" 类型 = 所有字段都有值的完整状态**。通过 `Required<...>` 使所有可选字段变为必填，表示这是一个"已完全合成"的快照，没有任何 `undefined`。

`tiles` 字段也从 `(THistoryEntryLayerTile | undefined)[]`（允许空洞）变成 `THistoryEntryLayerTile[]`（全部有值）。

---

## 三、`kl-history.ts` — 核心历史管理类

### 3.1 私有字段

```ts
private entries: THistoryEntry[];           // diff 数组，index 0 最旧
private index: number = 0;                  // 当前用户所在的历史位置
private composed: THistoryEntryDataComposed;// 当前完整状态的缓存
private totalActions: number = 0;           // 累计 push 次数（单调递增，不随 undo 回退）
private changeCount: number = 0;            // 每次 push/undo/redo 都递增，可用于检测状态是否变化
private pauseStack: number = 0;             // 暂停计数（嵌套 pause 支持）
private readonly listeners: TKlHistoryListener[]; // 状态变更广播订阅者
```

`entries` 的结构示意：

```
entries: [oldest, step1, step2, step3, step4]
                                    ↑
                                  index (当前位置)
         step4 之后还有 step4+1 等可 redo 的条目（如果有的话）
```

---

### 3.2 构造函数

```ts
constructor(p: TKlHistoryParams) {
    this.entries = [{
        timestamp: new Date().getTime(),
        memoryEstimateBytes: estimateBytes(p.oldest),
        data: p.oldest,
    }];
    this.composed = p.oldest;
}
```

传入的 `p.oldest` 是**初始完整状态**（`THistoryEntryDataComposed`），作为 entries 的第 0 项（基准快照）。此时 `composed` 直接等于这个初始状态，无需计算。

---

### 3.3 `push()` — 记录新操作

```ts
push(entryData: THistoryEntryData, replaceTop?: boolean): void
```

**流程图**：

```
push(entryData)
    │
    ├─ pauseStack > 0? ──→ return (暂停中，忽略)
    │
    ├─ entryData 为空对象? ──→ return (noop，没有变化)
    │
    ├─ 创建 THistoryEntry（含时间戳和内存估算）
    │
    ├─ replaceTop=true 且 index > 0?
    │       ├─ 弹出当前 top
    │       └─ 检查新 entry 是否真的造成变化（entryCausesChange）
    │               ├─ 有变化 → 压入新 entry
    │               └─ 无变化 → 不压入（去重，如两次切换可见性）
    │
    ├─ 裁剪 index 之后的 redo 分支（清空"未来"步骤）
    │
    ├─ trimOldestEntries() — 内存压缩
    │
    ├─ index = entries.length - 1
    ├─ updateComposed()
    └─ broadcast()
```

**`replaceTop` 的用途**：某些操作（如移动图层、调整滑块）会产生连续的中间状态，每次微小变化都替换上一条 entry，确保只形成一个 undo 步骤，而不是几十个。

---

### 3.4 `increaseIndex()` / `decreaseIndex()` — Redo / Undo

```ts
increaseIndex(): THistoryEntry  // Redo：index++
decreaseIndex(): THistoryEntry  // Undo：index--
```

这两个方法只移动指针，不删除数据，然后调用 `updateComposed()` 重新合成当前状态，并广播变化。

---

### 3.5 `updateComposed()` — 状态合成

```ts
private updateComposed(): void {
    this.composed = composeHistoryStateData(
        this.entries.slice(0, this.index + 1).map((item) => item.data),
    );
}
```

取 `entries[0..index]` 的所有 diff，合成为完整状态。每次 undo/redo/push 后都会重新计算一次。

---

### 3.6 `pause()` — 暂停机制

```ts
pause(b: boolean): void {
    if (b) this.pauseStack++;
    else this.pauseStack = Math.max(0, this.pauseStack - 1);
}
```

使用**计数器而非布尔值**，支持嵌套暂停。典型场景：滤镜操作需要多步修改画布（先对两个图层操作，再合并），整个过程中 `pause(true)` 防止中间步骤创建多余的 undo 条目，完成后 `pause(false)` 再一次性 push 最终结果。

---

### 3.7 广播机制

```ts
private broadcast(): void {
    this.changeCount++;
    setTimeout(() => {
        for (let i = 0; i < this.listeners.length; i++) {
            this.listeners[i]();
        }
    });
}
```

使用 `setTimeout` 将广播推迟到下一个事件循环 tick，避免监听器在当前调用栈中同步触发（防止重入问题）。

---

## 四、辅助模块解析

### 4.1 `compose-history-state-data.ts` — 差分合成引擎

核心函数：

```ts
export function composeHistoryStateData(
    entries: THistoryEntryData[],
    targetIndex?: number,
): THistoryEntryDataComposed
```

**合成规则**：对于每个属性，找最新（index 最大）的那个有值的 diff 版本。

```
entries:  [oldest]  [step1]  [step2]  [step3]
opacity:   0.8       ---      0.5      ---
                                ↑
                           最终取 0.5（最近一次改变了 opacity 的那步）
```

对于 `tiles`，每个 Tile 格子也独立取最新版本：

```
tile[0]:   A         B        ---      ---  → 最终 B
tile[1]:   X        ---        Y       ---  → 最终 Y
tile[2]:   P        ---       ---       Q   → 最终 Q
```

这是整个历史系统的核心算法，允许 undo/redo 只需移动 `index` 指针，然后用此函数重新合成，而不必存储每个历史步骤的完整画布副本。

---

### 4.2 `estimate-bytes.ts` — 内存估算

```ts
export function estimateBytes(entry: THistoryEntryData): number
```

- **选区（MultiPolygon）**：每个坐标点 8 字节（`number` = 64-bit float）
- **Fill 图层**：字符串长度 × 2 字节（UTF-16 编码）
- **ImageData Tile**：`width × height × 4` 字节（RGBA 各 1 字节）

这是估算值（非精确），用于内存管理决策。

---

### 4.3 `entry-causes-change.ts` — 变更检测

```ts
export function entryCausesChange(
    entry: THistoryEntryData,
    composed: THistoryEntryDataComposed,
): boolean
```

用于 `replaceTop` 时的去重判断：如果新条目相对于当前合成状态没有实质变化（例如关闭图层后又打开），则跳过，避免创建无效历史条目。

---

### 4.4 `trim-oldest-entries.ts` — 内存压缩

**内存阈值常量**：

| 常量 | 值 | 含义 |
|------|-----|------|
| `ALWAYS_KEEP_TOTAL_THRESHOLD_BYTES` | 200 MB | 总内存 ≤200MB 时，保留所有步骤 |
| `LARGE_ENTRY_BYTES` | 10 MB | 超过此大小的条目被认为是"大条目" |
| `LARGE_ENTRY_MAX_AGE` | 50 步 | 大条目最多保留 50 步历史 |
| `TOTAL_THRESHOLD_BYTES` | 1 GB | 绝对上限，总内存不得超过此值 |

**裁剪策略**：

1. 总内存 ≤200MB → 直接返回，不裁剪
2. 大条目（>10MB）超过 50 步 → 标记为可回收
3. 普通条目累积超过 200MB → 标记最旧的为边界
4. 总内存超过 1GB → 强制裁剪
5. 将 `entries[0..oldestIndex]` 合并为一个 "oldest" 快照条目（合成后替换掉多个旧 diff）

**设计动机**：最坏情况下（2048×2048×16 图层），一个完整快照 = 268MB，1GB 上限 = 约 3-4 步完整历史。对于普通笔刷操作（每步只记录被修改的 Tiles），可以保留非常多步历史。

---

## 五、完整数据流示意图

```
用户绘图（笔刷）
      │
      ▼
  push({ layerMap: { 'layer1': { tiles: [undefined, tileB, ...] } } })
      │
      ├─ 暂停？→ 忽略
      ├─ 裁剪 redo 分支（如果当前不在末尾）
      ├─ trimOldestEntries（如果超内存）
      ├─ entries.push(newEntry)
      ├─ index = entries.length - 1
      └─ updateComposed() → composed 更新为最新完整状态

用户 Ctrl+Z（undo）
      │
      ▼
  decreaseIndex()
      ├─ index--
      └─ updateComposed() → 重新合成 entries[0..index-1] 的完整状态

用户 Ctrl+Y（redo）
      │
      ▼
  increaseIndex()
      ├─ index++
      └─ updateComposed() → 重新合成 entries[0..index] 的完整状态
```

---

## 六、关键设计模式总结

| 设计点 | 具体实现 | 目的 |
|--------|----------|------|
| **增量 diff** | 每条 entry 只记录变化的字段/Tile | 节省内存 |
| **Tile 分块** | 256×256 像素为单位，只存有变化的块 | 笔刷操作只影响局部 |
| **指针移动式 undo** | 移动 `index`，不删除数据 | redo 得以保留 |
| **合成缓存** | `composed` 随 push/undo/redo 实时更新 | 避免每次读取时重新合成 |
| **暂停计数器** | `pauseStack` 支持嵌套 | 复杂操作只产生一个 undo 步骤 |
| **内存分级管理** | 200MB / 10MB / 1GB 三档阈值 | 平衡低端设备与正常使用 |
| **合并旧条目** | 超限时将旧 diff 合成为一个快照 | 压缩内存同时保留近期历史 |
| **replaceTop** | 替换顶部条目 + 变更检测去重 | 连续操作只产生一个 undo |
| **异步广播** | `setTimeout` 延迟通知监听器 | 防止同步重入，解耦 UI 响应 |
