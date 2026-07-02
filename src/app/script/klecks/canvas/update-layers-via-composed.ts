import { HISTORY_TILE_SIZE } from '../history/kl-history';
import { TKlCanvasLayer } from './kl-canvas';
import { THistoryEntryDataComposed } from '../history/history.types';
import { BB } from '../../bb/bb';
import { sortLayerMap } from '../history/sort-layer-map';
import { isLayerFill } from '../kl-types';

/**
 * ! diff 算法
 * 【状态调和引擎】：将历史记录的 Delta 差异应用到当前工程中，针对性能进行了极致优化。
 * 注意：该方法会直接修改传入的 layers (破坏性更新 physical canvas)。
 * 
 * @param layers 物理画布上的当前图层数组
 * @param before Undo/Redo 前的状态快照 (当前的物理状态)
 * @param after  Undo/Redo 后的状态快照 (我们希望变成的目标状态)
 */
/**
 * Applies history delta to the project, optimized for performance.
 * note: modifies the canvases in project
 */
export function updateLayersViaComposed(
    layers: TKlCanvasLayer[],
    before: THistoryEntryDataComposed,
    after: THistoryEntryDataComposed,
): TKlCanvasLayer[] {
    // 检查画布整体物理尺寸是否发生了变化 (如：用户撤销了画布裁剪操作)
    const sizeDidChange =
        before.size.width !== after.size.width || before.size.height !== after.size.height;

    // 遍历目标状态 (after) 中的每一个图层配置
    return Object.entries(after.layerMap)
        .map(([id, composedAfterLayer]) => {
            let canvas = {} as HTMLCanvasElement;
            let context = {} as CanvasRenderingContext2D;
            // 尝试去当前物理状态 (before) 中寻找相同 ID 的图层
            const composedBeforeLayer = before.layerMap[id];

            // 尝试去当前物理状态 (before) 中寻找相同 ID 的图层
            const tilesPerX = Math.ceil(after.size.width / HISTORY_TILE_SIZE);

            // ==========================================
            // 分支 A：全量渲染 (Full Render)
            // 触发条件：画布尺寸变了，或者这是一个全新添加的图层
            // ==========================================
            if (sizeDidChange || !composedBeforeLayer) {
                // 只能忍痛分配内存，创建全新的 Canvas DOM 节点
                // create new canvas
                canvas = BB.canvas(after.size.width, after.size.height);
                context = BB.ctx(canvas);

                // 暴力遍历所有切片并绘制
                composedAfterLayer.tiles.forEach((item, index) => {
                    const x = index % tilesPerX;
                    const y = Math.floor(index / tilesPerX);
                    if (isLayerFill(item)) {
                        // 如果切片是纯色的(如刚清空的图层，切片全是 transparent)
                        // 使用极速的 fillRect
                        context.save();
                        context.fillStyle = item!.fill;
                        context.fillRect(
                            x * HISTORY_TILE_SIZE,
                            y * HISTORY_TILE_SIZE,
                            HISTORY_TILE_SIZE,
                            HISTORY_TILE_SIZE,
                        );
                        context.restore();
                    } else {
                        // 如果切片包含真实的绘画像素，则将显存数据压入 Canvas
                        context.putImageData(
                            item.data,
                            x * HISTORY_TILE_SIZE,
                            y * HISTORY_TILE_SIZE,
                        );
                    }
                });
            } else {
                // ==========================================
                // 分支 B：增量差异渲染 (Delta Diff Render) - 性能核心！
                // 触发条件：普通画笔操作后的撤销/重做
                // ==========================================

                // 1. 节点复用：借尸还魂，直接拿已存在的物理 Canvas 开刀
                canvas = layers[composedBeforeLayer.index].canvas;
                context = layers[composedBeforeLayer.index].context;
                // 2. 遍历目标切片数组，开始找不同
                composedAfterLayer.tiles.forEach((item, index) => {
                    // 【绝对的性能魔法：O(1) 指针浅比较】
                    // 如果新旧切片在内存中是同一个对象引用，说明这段区域毫无变化！
                    // 直接 return 跳过，连 Canvas API 的边都不用碰！
                    if (item === composedBeforeLayer.tiles[index]) {
                        // todo more advanced check ^
                        return;
                    }
                    // 只有发生了变化的切片 (Dirty Tile)，才会执行到这里
                    const x = index % tilesPerX;
                    const y = Math.floor(index / tilesPerX);

                    if (isLayerFill(item)) {
                        context.save();
                        context.fillStyle = item.fill;
                        // 坑点防御：如果是从有内容的像素变回纯色透明，必须先 clearRect 挖空，
                        // 否则带透明度的 fillRect 盖在原来的像素上会变成叠加，而不是覆盖！
                        context.clearRect(
                            x * HISTORY_TILE_SIZE,
                            y * HISTORY_TILE_SIZE,
                            HISTORY_TILE_SIZE,
                            HISTORY_TILE_SIZE,
                        );
                        context.fillRect(
                            x * HISTORY_TILE_SIZE,
                            y * HISTORY_TILE_SIZE,
                            HISTORY_TILE_SIZE,
                            HISTORY_TILE_SIZE,
                        );
                        context.restore();
                    } else {
                        // 局部重绘修改过的像素块
                        context.putImageData(
                            item.data,
                            x * HISTORY_TILE_SIZE,
                            y * HISTORY_TILE_SIZE,
                        );
                    }
                });
            }

            // 3. 将更新好物理 Canvas 的图层，组装成全新的层对象返回
            return {
                id,
                // 可能由于图层重排导致 index 变化
                index: composedAfterLayer.index,
                name: composedAfterLayer.name,
                mixModeStr: composedAfterLayer.mixModeStr,
                isVisible: composedAfterLayer.isVisible,
                opacity: composedAfterLayer.opacity,
                canvas,
                context,
            };
        })
        // 4. 洗牌：根据目标状态的 index，对物理层数组重新进行 Z 轴排序 (Z-index sorting)
        .sort(sortLayerMap);
}
