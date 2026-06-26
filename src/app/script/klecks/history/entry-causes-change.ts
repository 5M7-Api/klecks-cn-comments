import { THistoryEntryData, THistoryEntryDataComposed } from './history.types';

// 检查传入的新补丁 `entry` 是否真的会改变当前的完整画面 `composed`
// checks if `entry` would change `composed`
export function entryCausesChange(
    entry: THistoryEntryData,
    composed: THistoryEntryDataComposed,
): boolean {
    // 1. 检查画布尺寸变化 (比如裁剪、重设大小)
    if (entry.size !== undefined) {
        if (entry.size.width !== composed.size.width) {
            return true;
        }
        if (entry.size.height !== composed.size.height) {
            return true;
        }
    }
    // 2. 检查选区变化 (蚂蚁线)
    if (entry.selection !== undefined) {
        if (entry.selection.value !== composed.selection.value) {
            return true;
        }
    }
    // 3. 检查当前激活的图层是否切换了
    if (entry.activeLayerId !== undefined) {
        if (entry.activeLayerId !== composed.activeLayerId) {
            return true;
        }
    }
    // 4. 核心：检查图层树的变化
    if (entry.layerMap !== undefined) {
        const entryLayerMapIds = Object.keys(entry.layerMap);
        // 【结构检查 A】：检查是否有图层被删除了？
        // 遍历当前画面 (composed) 里的所有图层 ID，
        // 如果发现有个图层在新的 entry 里找不到了，说明发生了图层删除，绝对改变了画面！
        for (const layerId of Object.keys(composed.layerMap)) {
            if (!entryLayerMapIds.includes(layerId)) {
                return true;
            }
        }
        // 【属性与结构检查 B】：遍历新操作中涉及的所有图层
        for (const layerId of entryLayerMapIds) {
            const composedLayer = composed.layerMap[layerId];
            // 如果这个图层在当前画面里根本不存在，说明这是个“新建图层”操作，画面改变
            if (!composedLayer) {
                return true;
            }
            const entryLayer = entry.layerMap[layerId];
            // 接下来是一连串的属性深度对比...
            if (entryLayer.name !== undefined && entryLayer.name !== composedLayer.name) {
                return true;
            }
            if (entryLayer.opacity !== undefined && entryLayer.opacity !== composedLayer.opacity) {
                return true;
            }
            if (
                entryLayer.isVisible !== undefined &&
                entryLayer.isVisible !== composedLayer.isVisible
            ) {
                return true;
            }
            if (
                entryLayer.mixModeStr !== undefined &&
                entryLayer.mixModeStr !== composedLayer.mixModeStr
            ) {
                return true;
            }
            if (entryLayer.index !== undefined && entryLayer.index !== composedLayer.index) {
                return true;
            }
            // 【神级短路优化】：像素检查
            if (entryLayer.tiles !== undefined) {
                // 只要这步操作包含了像素瓦片的改动，直接判定为“画面变了”！
                // ! 性能优化
                // ! 毕竟用户不可能精准地拿一模一样的颜色盖在同一个像素上毫无偏差，直接对比像素太浪费性能了
                // not needed currently
                return true;
            }
        }
    }
    // 如果上面这一套严刑拷打下来，都没发现任何不同，说明这次操作是个“寂寞”，返回 false
    return false;
}
