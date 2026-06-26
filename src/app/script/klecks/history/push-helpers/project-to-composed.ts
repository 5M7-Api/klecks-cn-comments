import { isLayerFill, TKlProject } from '../../kl-types';
import { THistoryEntryDataComposed, THistoryEntryLayerTile } from '../history.types';
import { canvasToLayerTiles } from './canvas-to-layer-tiles';
import { getNextLayerId } from '../get-next-layer-id';
import { BB } from '../../../bb/bb';

/**
 * 创世函数：将外部项目数据（如导入的图片/工程）转换为历史记录栈底的“初始绝对快照”
 * @param project 外部传入的项目数据（包含了宽高、图层数组、图像源等）
 */
export function projectToComposed(project: TKlProject): THistoryEntryDataComposed {
    // 记录最后处理的一个图层 ID（通常用来默认激活最顶层的图层）
    let lastId: string = '';
    // =========================================================
    // 【图层映射工厂】：将普通图层转换为底层 History 图层
    // Object.fromEntries 会把 [ [key1, val1], [key2, val2] ] 变成 { key1: val1, key2: val2 }
    // =========================================================
    const layerMap = Object.fromEntries(
        project.layers.map((layer, index) => {
            // 给这个新图层分配一个全局唯一的内部 ID（比如 "layer_0", "layer_1"）
            lastId = getNextLayerId();
            let tiles: THistoryEntryLayerTile[] = [];

            if (layer.image instanceof Array) {
                // 直接浅拷贝数组即可
                tiles = [...layer.image];
            } else {
                // 分支 B：如果传入的是未经切片的原始图像（比如用户刚拖进来一张高清照片）
                // 【IIFE（立即执行函数）】：在内部临时生成一个完整的 Canvas 画面
                const canvas = (() => {
                    // 如果它本来就是一个 Canvas 元素，直接用
                    if (layer.image instanceof HTMLCanvasElement) {
                        return layer.image;
                    }

                    // 否则，创建一个和项目等宽等高的离屏 Canvas
                    const canvas = BB.canvas(project.width, project.height);
                    const ctx = BB.ctx(canvas);

                    // 【梦幻联动 1】：还记得我们分析过的 isLayerFill 吗？
                    // 如果用户新建的是一张纯色背景图（比如全白），这里绝不一张一张画像素！
                    // 而是直接用 ctx.fillRect 极速涂满。
                    if (isLayerFill(layer.image)) {
                        ctx.fillStyle = layer.image.fill;
                        ctx.fillRect(0, 0, project.width, project.height);
                    } else {
                        // 如果是一张普通的 Image 对象（如 img 标签），把它画到 Canvas 上
                        ctx.drawImage(layer.image, 0, 0);
                    }
                    return canvas;
                })();

                // 【梦幻联动 2】：全图切片！
                // 把刚刚画好的完整 Canvas，扔给我们的“收割机”，
                // 强行切成 256x256 的网格数组！注意这里没有传 bounds，走的是极其优化的全图 Readback 分支。
                tiles = canvasToLayerTiles(canvas);
            }

            // 组装成 [ key, value ] 的形式，喂给外层的 Object.fromEntries
            return [
                lastId,
                {
                    name: layer.name,
                    opacity: layer.opacity,
                    isVisible: layer.isVisible,
                    // 容错处理：如果没有指定混合模式，默认就是 'source-over' (正常模式)
                    mixModeStr: layer.mixModeStr ?? 'source-over',
                    index,
                    // 塞入切好的瓦片数组！
                    tiles, 
                },
            ];
        }),
    );
    // =========================================================
    // 拼装出最终的 THistoryEntryDataComposed (绝对快照)
    // =========================================================
    return {
        projectId: {
            value: project.projectId,
        },
        size: {
            width: project.width,
            height: project.height,
        },
        // 刚建立的项目，没有蚂蚁线选区
        selection: {},
        // 默认让用户聚焦在刚刚处理的最后一个图层（通常是顶层）
        activeLayerId: lastId,
        // 挂载全部图层字典
        layerMap,
    };
}
