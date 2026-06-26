import {
    THistoryEntryData,
    THistoryEntryDataComposed,
    THistoryEntryLayer,
    THistoryEntryLayerComposed,
    THistoryEntryLayerTile,
    TLayerId,
} from './history.types';

/**
 * 核心工具函数 1：获取数组中“最晚出现且不为 undefined 的值”
 * 场景：寻找一个变量的最终状态。
 * 例如：[ "图层1", undefined, "改名图层1", undefined ] 
 * 从后往前找，找到的第一个有效值就是 "改名图层1"。
 */
// finds the largest index that is defined
function getLatestDefined<GType>(array: (GType | undefined)[]): GType {
    for (let i = array.length - 1; i >= 0; i--) {
        const value = array[i];
        if (value !== undefined) {
            return value;
        }
    }
    // 防呆设计，因为 index 0 的初始状态必须是完整的
    throw new Error('no defined entry found');
}

/**
 * 核心工具函数 2：获取对象数组中，某个特定属性 (prop) “最晚出现且不为 undefined 的值”
 * 场景：图层的各个属性是独立被改变的。
 * 例如：寻找透明度 (opacity) 的最终值。
 * 历史记录：[ {opacity: 1, name: "A"}, {name: "B"}, {opacity: 0.5} ]
 * 返回：0.5
 */
// in an array of maps, finds array[i][prop] for the largest index
// where array[i][prop] is defined
function getLatestDefinedProp<
    GProp extends string,
    GValue,
    GArray extends { [K in GProp]?: GValue },
>(array: (GArray | undefined)[], prop: GProp): GValue {
    for (let i = array.length - 1; i >= 0; i--) {
        if (!array[i]) {
            continue;
        }
        const value = array[i]![prop];
        if (value !== undefined) {
            return value;
        }
    }
    throw new Error('no defined entry found');
}

/**
 * 【瓦片级合成】: 把多个历史记录中的“脏瓦片”压扁成一整块画布。
 * @param tilesEntries 每个元素代表某一次历史记录中，这个图层的脏瓦片数组
 */
// For each tile gets the latest which is defined.
// Each tile[] is from a history entry.
function composeLayerTiles(
    tilesEntries: ((THistoryEntryLayerTile | undefined)[] | undefined)[],
): THistoryEntryLayerTile[] {
    // 1. 先用最新鲜的那条记录（通常包含所有瓦片的坑位）作为“底板”打底
    const result = [...getLatestDefined(tilesEntries)];

    // 2. 遍历所有的瓦片坑位 (比如一张图有 12 个瓦片，id 就是 0 到 11)
    Object.entries(result).forEach(([id]) => {
        // 对于每一个瓦片，去所有的历史记录里，从后往前找：
        // “谁最后弄脏了这个瓦片？” 谁最后弄脏的，这个瓦片现在就是什么样。
        // （如果某个瓦片在历史中从未改变过，它就会一路回溯到 index 0 的初始白纸）
        result[+id] = getLatestDefinedProp(tilesEntries as any, id);
    });
    return result as THistoryEntryLayerTile[];
}

/**
 * 【单图层级合成】: 把一个图层的各项属性压扁
 */
// combines layers from multiple history entries into the latest representation
function composeLayer(
    layerEntries: (THistoryEntryLayer | undefined)[],
): THistoryEntryLayerComposed {
    return {
        // 利用 getLatestDefinedProp，分别去寻找该图层各项属性的最终形态
        // 这意味着：如果在步骤5改了名字，步骤8改了透明度，在这里它们会被完美融合在一起！
        name: getLatestDefinedProp(layerEntries, 'name'),
        opacity: getLatestDefinedProp(layerEntries, 'opacity'),
        isVisible: getLatestDefinedProp(layerEntries, 'isVisible'),
        mixModeStr: getLatestDefinedProp(layerEntries, 'mixModeStr'),
        index: getLatestDefinedProp(layerEntries, 'index'),

        // 遇到最麻烦的瓦片数据，就派 composeLayerTiles 去处理
        tiles: composeLayerTiles(layerEntries.map((item) => (item ? item.tiles : undefined))),
    };
}

/**
 * 【多图层映射合成】: 把整个项目里的所有图层压扁
 */
// combines layerMaps from multiple history entries into the latest representation
function composeLayerMap(layerMaps: (Record<TLayerId, THistoryEntryLayer> | undefined)[]) {
    // 获取最新的图层结构作为底板
    const result = { ...getLatestDefined(layerMaps) };
    // 遍历每一个存在的图层 ID
    Object.entries(result).forEach(([id]) => {
        // 对每一个图层，派 composeLayer 去压扁它
        result[id] = composeLayer(layerMaps.map((item) => (item ? item[id] : undefined)));
    });
    return result as Record<TLayerId, THistoryEntryLayerComposed>;
}

/**
 * 【全局入口】将多条历史记录 (Diff) 融合成当前画板的终极完整状态 (Composed State)。
 * 这是外部调用的唯一入口。
 * @param entries [最老, ..., 最新] 的历史记录栈
 * @param targetIndex 想要还原到哪一步？（不传默认还原到最新）
 */
/**
 * Combines multiple history entries into one. Entries after targetIndex are ignored.
 *
 * Each history entry only contains changes (e.g. name of layer 1 changed, or an area of layer 2 got
 * changed by a brush stroke), so it isn't the complete picture. Combining everything gives the complete picture.
 *
 * When combining it always takes the most recent data (<=targetIndex).
 * [oldest, ..., newest]
 */
export function composeHistoryStateData(
    entries: THistoryEntryData[],
    targetIndex?: number,
): THistoryEntryDataComposed {
    // 如果没有指定，就合成到栈顶（当前最新状态）
    if (targetIndex === undefined) {
        targetIndex = entries.length - 1;
    }
    // 砍掉未来的历史（如果我们要回溯到历史中途的话）
    entries = entries.slice(0, targetIndex + 1);
    // 返回最终合成的宇宙级上帝对象
    return {
        projectId: getLatestDefinedProp(entries, 'projectId'),
        size: getLatestDefinedProp(entries, 'size'),
        activeLayerId: getLatestDefinedProp(entries, 'activeLayerId'),
        selection: getLatestDefinedProp(entries, 'selection'),
        // 最复杂的图层数据，交给 composeLayerMap 去递归压扁
        layerMap: composeLayerMap(entries.map((item) => item.layerMap)),
    };
}
