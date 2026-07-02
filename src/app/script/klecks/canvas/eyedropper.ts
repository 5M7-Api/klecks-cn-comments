import { isLayerFill, TRgb } from '../kl-types';
import { BB } from '../../bb/bb';
import { THistoryEntryDataComposed } from '../history/history.types';
import { HISTORY_TILE_SIZE } from '../history/kl-history';
import { sortLayerMap } from '../history/sort-layer-map';

export class Eyedropper {
    // ----------------------------------- public -----------------------------------
    constructor() {}

    // ! Directly reading colors from the Canvas results in poor GPU performance.
    // Reads from history (ImageData) to avoid reading from canvas.
    getColorAt(x: number, y: number, composed: THistoryEntryDataComposed): TRgb {
        // 吸色的坐标必须是整数
        x = Math.floor(x);
        y = Math.floor(y);

        // 边界保护：点出画布范围，默认返回纯黑
        if (x < 0 || x >= composed.size.width || y < 0 || y >= composed.size.height) {
            return new BB.RGB(0, 0, 0);
        }

        // ==========================================
        // 创建一个极其微小的 1x1 像素的临时后台画布
        // 我们会把所有图层在这个点上的颜色一层层堆叠上来
        // ==========================================
        const canvas = BB.canvas(1, 1);
        const ctx = BB.ctx(canvas);
        // 关闭平滑，防止颜色被莫名其妙抗锯齿污染
        ctx.imageSmoothingEnabled = false;

        // ==========================================
        // 定位切片 (Tile Routing)
        // 历史记录是以切片(比如 256x256 的方块)保存的。
        // 根据 x, y 算出现在点的这下，属于整个网格里的第几个切片。
        // ==========================================
        const tilesX = Math.ceil(composed.size.width / HISTORY_TILE_SIZE);
        // 第几行几列
        const tileCol = Math.floor(x / HISTORY_TILE_SIZE);
        const tileRow = Math.floor(y / HISTORY_TILE_SIZE);
        // 拍平后在图层 tiles 数组中的索引
        const tileIndex = tileRow * tilesX + tileCol;

        // 取出历史记录的所有图层快照，按照从下到上的 Z-index 排序
        Object.values(composed.layerMap)
            .sort(sortLayerMap)
            .forEach((layer) => {
                // 如果图层被隐藏，或者完全透明，直接无视，不参与颜色混合
                if (!layer.isVisible || layer.opacity === 0) {
                    return;
                }

                // 拿到该图层对应位置的那一块切片
                const tile = layer.tiles[tileIndex];
                let fillStyle = '';
                if (isLayerFill(tile)) {
                    // 情况 A：这是个纯色填充的空切片（内存优化后的数学切片）
                    fillStyle = tile.fill;
                } else {
                    // 情况 B：这是个真实的像素数据切片 (ImageData)
                    let tileWidth = HISTORY_TILE_SIZE;
                    // 【坑点处理】：边缘不完整切片
                    // 如果画布宽度不是切片大小的整数倍，那么最右边那一列的切片宽度就不是标准的 HISTORY_TILE_SIZE。
                    // 必须要算出现实切片宽度，否则算出的局部 index 会错位！
                    if (composed.size.width % HISTORY_TILE_SIZE !== 0 && tileCol === tilesX - 1) {
                        tileWidth = composed.size.width % HISTORY_TILE_SIZE;
                    }

                    // 计算这个物理点 (x,y)，在这个局部切片的一维 ImageData 数组中的索引位置
                    const pixelIndex =
                        (y % HISTORY_TILE_SIZE) * tileWidth + (x % HISTORY_TILE_SIZE);

                    // 如果这个点的 Alpha 通道(透明度)是 0，说明这个图层在这个点是完全空洞的。
                    // 直接 return，什么都不画，底层露出来。
                    if (tile.data.data[pixelIndex * 4 + 3] === 0) {
                        return;
                    }

                    // 提取出这个点的 RGBA 颜色，并转成 CSS 颜色字符串 (如 rgba(255,0,0,0.5))
                    fillStyle = BB.ColorConverter.toRgbaStr({
                        r: tile.data.data[pixelIndex * 4],
                        g: tile.data.data[pixelIndex * 4 + 1],
                        b: tile.data.data[pixelIndex * 4 + 2],
                        a: tile.data.data[pixelIndex * 4 + 3] / 255,
                    });
                }

                // ==========================================
                // 离线像素合成 (Offscreen Composition)
                // 模拟正常的画板，把这 1 个像素的颜色按照它的图层透明度和混合模式(滤色/正片叠底等)，
                // 盖到我们的 1x1 迷你小画布上！
                // ==========================================
                ctx.fillStyle = fillStyle;
                ctx.globalAlpha = layer.opacity;
                ctx.globalCompositeOperation = layer.mixModeStr;
                ctx.fillRect(0, 0, 1, 1);
            });

        // 所有可见图层都在这个 1x1 的 Canvas 上盖完章了。
        // 现在，在这个纯 CPU 渲染的 1x1 小画布上执行 getImageData，
        // 瞬间拿到结果，完全不会卡顿！
        const imData = ctx.getImageData(0, 0, 1, 1);
        return new BB.RGB(imData.data[0], imData.data[1], imData.data[2]);
    }
}
