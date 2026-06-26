import { MultiPolygon } from 'polygon-clipping';
import { TLayerFill, TMixMode } from '../kl-types';

// 图层的唯一身份标识 (通常是随机字符串)
export type TLayerId = string;
// ------------------------------------------------------------------------
// 1. 物理像素层: 瓦片 (Tile)
// ------------------------------------------------------------------------
// 这是一个真正包含像素数据的“实体瓦片”
export type TImageDataTile = {
    // 瓦片的独立标识，可能用于配合 IndexedDB 做本地化缓存存储
    id: string;
    // 浏览器原生的 ImageData 对象 (包含一个巨大的 Uint8ClampedArray 像素矩阵)
    /*
    // unix timestamp
    timestamp: number;
     */
    data: ImageData;
};
// 历史记录中的瓦片形式：
// 它可以是一个实打实的像素矩阵 (TImageDataTile)
// 也可以仅仅是一句轻飘飘的指令：TLayerFill (比如 {fill: 'transparent'} 代表这块瓦片是空的)
// 【优化亮点】：如果用户清空了图层，系统不需要存满屏的空白像素，只存一句指令即可！极其省内存。
// image data, or a fill color
// can be transparent: {fill: 'transparent'} -> useful if empty layer
export type THistoryEntryLayerTile = TImageDataTile | TLayerFill;
// ------------------------------------------------------------------------
// 2. 逻辑层：单个图层的“增量补丁” (Layer Diff)
// ------------------------------------------------------------------------
// 【核心特征】：这里面所有的属性全是可选的 (?) ！！
    // 因为历史记录中的一步操作，可能只改变了图层的某一项属性。
export type THistoryEntryLayer = {
    // if layer exists but did not change, must be in the layerMap. object can be empty

    // if name changed
    name?: string;

    // if opacity changed
    opacity?: number;

    // if visibility changed
    isVisible?: boolean;

    // if blend mode changed
    mixModeStr?: TMixMode;

    // if index changed (did it move up or down)
    index?: number;

    // 最核心的像素改变：
    // 这是一个数组，代表该图层所有的瓦片坑位。
    // 如果某个坑位的值是 undefined，代表【这块瓦片在这一步操作中根本没被碰到，原封不动】。
    // if contents changed
    tiles?: (THistoryEntryLayerTile | undefined)[]; // undefined if tile did not change
};
// ------------------------------------------------------------------------
// 3. 全局层：单步历史记录的“全项目补丁” (Project Diff)
// ------------------------------------------------------------------------
export type THistoryEntryData = {
    // if project changed
    projectId?: {
        value: string; // uuid
    };

    // if size changed
    size?: {
        width: number;
        height: number;
    };

    // if selection changed
    selection?: {
        value?: MultiPolygon;
    };

    // if active layer changed
    activeLayerId?: string;

    // if layers changed
    // map, so can quickly project through
    layerMap?: Record<TLayerId, THistoryEntryLayer>;
};

// ------------------------------------------------------------------------
// 4. 外壳层：历史记录栈中的单一记录项
// ------------------------------------------------------------------------
export type THistoryEntry = {
    // 发生时间戳
    timestamp: number; // maybe for comparing with indexedDB?
    // 【关键】：这一步操作“弄脏”了多少内存？用于超限时清理老记录。
    memoryEstimateBytes: number;
    // 供人类阅读的操作提示（例如：“画笔涂抹”、“调整透明度”）
    description?: string; // human-readable description of the action. e.g. 'brush stroke'
    // 包裹着我们上面的“全项目补丁”
    data: THistoryEntryData;
};

// ========================================================================
// 以下是神级类型体操：用 Omit 和 Required 定义“完全体 (Snapshot)”
// ========================================================================
// 5. 完全体图层 (Composed Layer)
// Required<THistoryEntryLayer> 强制把上面原本可选的 (?) 属性全部变成必填！
// 也就是说，一个合成好的图层，必须清清楚楚地拥有 name, opacity, isVisible 等所有属性。
// Omit 的作用是把原有的 tiles 定义剔除掉，换成下面更严格的定义。
export type THistoryEntryLayerComposed = Omit<Required<THistoryEntryLayer>, 'tiles'> & {
    // 合成后的图层，其瓦片数组中【绝对不能出现 undefined】。
    // 每一个坑位都必须有实打实的瓦片数据（或透明指令）。
    tiles: THistoryEntryLayerTile[];
};

// 6. 完全体全项目 (Composed Project Data)
// 同理，强制把 projectId, size 等全部变为必填。
// 并且它包含的 layerMap 里，装的必须全部是“完全体图层 (Composed Layer)”。
export type THistoryEntryDataComposed = Omit<Required<THistoryEntryData>, 'layerMap'> & {
    layerMap: Record<TLayerId, THistoryEntryLayerComposed>;
};
