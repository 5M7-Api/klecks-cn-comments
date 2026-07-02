import { THistoryEntryLayerTile } from './history.types';
import { HISTORY_TILE_SIZE } from './kl-history';

/**
 * 【内存核武器】：生成虚拟纯色/透明切片
 * 当整个图层被纯色填满，或者被完全清空（透明）时，调用此函数。
 * 它【不会】去触碰任何 Canvas API 或读取真实的像素数据 (ImageData)。
 * 
 * @param width 画布总宽度
 * @param height 画布总高度
 * @param fill 填充的颜色属性，例如 'transparent' 或 'rgba(255,0,0,1)'
 */
export function createFillColorTiles(
    width: number,
    height: number,
    fill: string,
): THistoryEntryLayerTile[] {
    // 准备一个空数组，用于存放“伪造”的切片数据
    const result: THistoryEntryLayerTile[] = [];

    // 计算整个画布在水平和垂直方向上，分别能被切割成多少个切片
    // 使用 Math.ceil 是因为边缘的切片可能不满一个 HISTORY_TILE_SIZE，但也算一块
    const tilesX = Math.ceil(width / HISTORY_TILE_SIZE);
    const tilesY = Math.ceil(height / HISTORY_TILE_SIZE);

    // 遍历这巨大的虚拟切片网格
    for (let y = 0; y < tilesY; y++) {
        for (let x = 0; x < tilesX; x++) {
            // !【核心精髓】：轻量级对象替换重型 ImageData
            // 正常的切片结构通常是 { data: ImageData }，包含 256*256*4 个像素点的二进制数组。
            // 这里推入的切片仅仅是一个极其轻量的标记对象 { fill: "transparent" }
            // 无论画布多大，它都只占用极小的内存。
            result.push({ fill });
        }
    }
    // 返回这个充满轻量级标记对象的数组，直接喂给历史记录系统
    return result;
}
