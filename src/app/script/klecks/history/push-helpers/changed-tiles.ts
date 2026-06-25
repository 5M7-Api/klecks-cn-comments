import { HISTORY_TILE_SIZE } from '../kl-history';
import { clamp, indexBoundsInArea } from '../../../bb/math/math';
import { createArray } from '../../../bb/base/base';
import { TIndexBounds } from '../../../bb/bb-types';

// ! 关乎内存泄露的重要函数。将整个画布只有变化的小部分捕获存储，而非整个画布
/**
 * 获取“被弄脏（改变）的瓦片”数组。
 * 将整个画布在逻辑上切分成网格（瓦片），判断传入的绘制边界（bounds）究竟覆盖了哪些瓦片。
 * @returns 返回一个一维布尔数组，true 代表该瓦片被弄脏了，false 代表完好无损。
 */
// returns array, each entry represents a tile, as a boolean
// true - intersected with bounds
export function getChangedTiles(
    // 本次绘制操作的像素边界矩形 (x1, y1 到 x2, y2)
    bounds: TIndexBounds, // canvas space
    // 画布宽高
    width: number,
    height: number,
    // 瓦片的标准边长（通常是 256 或 512 像素）
    tileSize: number = HISTORY_TILE_SIZE,
): boolean[] {
    // 1. 坐标归一化 (防呆设计)
    // 确保 x1, y1 永远是左上角（最小值），x2, y2 永远是右下角（最大值）
    // ensure: 1 top left, 2 bottom right
    bounds = {
        type: 'index',
        x1: Math.min(bounds.x1, bounds.x2),
        y1: Math.min(bounds.y1, bounds.y2),
        x2: Math.max(bounds.x1, bounds.x2),
        y2: Math.max(bounds.y1, bounds.y2),
    };
    // 2. 边界裁剪：检查这个绘制矩形是否在画布有效区域内
    const boundsInCanvas = indexBoundsInArea(bounds, width, height);
    // 3. 计算整个画布被切成了多少列 (tilesX) 和 多少行 (tilesY)
    // Math.ceil 确保即使边缘不满一个瓦片，也会分配一个完整的瓦片空间
    const tilesX = Math.ceil(width / tileSize);
    const tilesY = Math.ceil(height / tileSize);
    // 如果完全画在了画布外面，直接返回一个全为 false 的数组
    if (!boundsInCanvas) {
        // no change if bounds don't overlap canvas
        return createArray(tilesX * tilesY, false);
    }

    // 初始化一个一维数组，长度为瓦片总数，默认全为 false
    // 【优化技巧】：在图形学中，用一维数组替代二维数组可以提高 CPU 缓存命中率，提升性能。
    const result: boolean[] = createArray(tilesX * tilesY, false);

    // 4. 将像素坐标换算成“瓦片网格坐标”
    // 比如 x1 是第 300 像素，tileSize 是 256，那么 Math.floor(300/256) = 1，说明在第 1 列的瓦片上
    const tileBounds = {
        x1: clamp(Math.floor(bounds.x1 / tileSize), 0, tilesX - 1),
        y1: clamp(Math.floor(bounds.y1 / tileSize), 0, tilesY - 1),
        x2: clamp(Math.floor(bounds.x2 / tileSize), 0, tilesX - 1),
        y2: clamp(Math.floor(bounds.y2 / tileSize), 0, tilesY - 1),
    };

    // 5. 遍历被包围的所有瓦片，将其标记为“脏”(true)
    for (let i = tileBounds.x1; i <= tileBounds.x2; i++) {
        for (let e = tileBounds.y1; e <= tileBounds.y2; e++) {
            // 将二维坐标 (i, e) 转换为一维数组索引： 行号 * 总列数 + 列号
            result[e * tilesX + i] = true;
        }
    }
    return result;
}

/**
 * 累加合并被弄脏的瓦片。
 * 因为用户画一笔（down -> move -> move -> up），会产生多次坐标变动。
 * 需要把之前脏了的瓦片和本次新脏的瓦片合并起来。
 */
// Combines old and new changes.
// A tile is changed if it's changed in new or old.
export function updateChangedTiles(
    // 之前记录的脏瓦片状态（刚按下画笔时可能是空数组）
    oldChangedOrEmpty: boolean[], // important: can be empty array, while new has entries.
    // 本次 move 产生的脏瓦片状态
    newChanged: boolean[],
): boolean[] {
    // 遍历新数组，将新旧状态进行逻辑或 (OR) 操作
    return newChanged.map((newItem, index) => {
        // 只要新的弄脏了 (newItem) 或者 以前弄脏了 (oldChangedOrEmpty[index])，就标记为脏 (true)
        // !! 是强制转换为布尔值的写法，应对 oldChangedOrEmpty 越界 undefined 的情况
        return newItem || !!(oldChangedOrEmpty[index] as boolean | undefined);
    });
}
