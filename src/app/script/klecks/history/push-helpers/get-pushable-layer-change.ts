import {
    THistoryEntryData,
    THistoryEntryDataComposed,
    THistoryEntryLayerTile,
} from '../history.types';
import { canvasToLayerTiles } from './canvas-to-layer-tiles';

// 创建一个历史记录条目，记录当前活动图层的像素块发生了改变
// create a history entry where the currently active layer changes its tiles
export function getPushableLayerChange(
    // composed: 当前系统的完整状态快照（包含当前选中的是哪个图层，以及所有图层的基本信息）
    composed: THistoryEntryDataComposed,
    // imageOrTiles: 画完这一笔之后，当前图层的新画面。
    // 可以是整张 Canvas，也可以是已经切分好的图像块 (Tiles) 数组。
    imageOrTiles: HTMLCanvasElement | (THistoryEntryLayerTile | undefined)[],
): THistoryEntryData {
    // 1. 获取用户当前正在作画的图层 ID
    const activeLayerId = composed.activeLayerId;
    // 2. 遍历当前所有的图层，构建一个新的 LayerMap 用于存入历史记录
    const layerMap = Object.fromEntries(
        Object.entries(composed.layerMap).map(([layerId, layerItem]) => {
            // 3. 命中目标：如果是用户刚刚修改的当前图层
            if (layerId === activeLayerId) {
                return [
                    layerId,
                    {
                        // 记录它的新画面数据
                        tiles:
                            imageOrTiles instanceof HTMLCanvasElement
                                // 如果传的是整图，将整图切片后存储
                                ? canvasToLayerTiles(imageOrTiles)
                                // 如果传的已经是切片数组，浅拷贝一份即可
                                : [...imageOrTiles],
                    },
                ];
            }

            // 4. 差异化优化：如果不是当前活动的图层（即用户这一笔没有画在它们上面）
            // 直接返回一个空对象 {}。
            // 这样历史记录栈在恢复时，就知道“这一步对这个图层没有影响，用上一步的数据即可”，极大地节省了内存。
            return [layerId, {}];
        }),
    );

    // 5. 返回封装好的历史记录增量包，后续会被 push() 到 Undo 栈中
    return {
        layerMap,
    };
}
