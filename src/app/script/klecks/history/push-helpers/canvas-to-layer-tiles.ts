import { THistoryEntryLayerTile } from '../history.types';
import { HISTORY_TILE_SIZE } from '../kl-history';
import { getTileFromCanvas } from './get-tile-from-canvas';
import { getChangedTiles } from './changed-tiles';
import { createImageDataTile } from '../image-data-tile';
import { TIndexBounds } from '../../../bb/bb-types';
import { getImageDataSafely } from '../../../bb/base/canvas';

/**
 * 局部收割机：根据脏瓦片布尔地图，去 Canvas 上抠出对应的像素快照
 * @param canvas 当前的图层画布
 * @param changedTiles 一个一维的布尔数组，比如 [false, true, false, ...]，代表哪个坑位脏了
 */
export function canvasAndChangedTilesToLayerTiles(
    canvas: HTMLCanvasElement,
    changedTiles: boolean[],
): (THistoryEntryLayerTile | undefined)[] {
    const result: (THistoryEntryLayerTile | undefined)[] = [];
    // 计算当前画布横向和纵向一共能切出多少个 256x256 的瓦片
    const tilesX = Math.ceil(canvas.width / HISTORY_TILE_SIZE);
    const tilesY = Math.ceil(canvas.height / HISTORY_TILE_SIZE);

    for (let row = 0; row < tilesY; row++) {
        for (let col = 0; col < tilesX; col++) {
            // 计算当前画布横向和纵向一共能切出多少个 256x256 的瓦片
            result.push(
                changedTiles[row * tilesX + col]
                // 如果这个瓦片脏了，就调用底层 API 去 Canvas 上抠图
                    ? createImageDataTile(getTileFromCanvas(canvas, col, row, HISTORY_TILE_SIZE))
                    // 【极度省内存的核心】：如果没脏，直接塞一个 undefined 进去占位！
                    : undefined,
            );
        }
    }
    return result;
}

// 函数重载声明
export function canvasToLayerTiles(canvas: HTMLCanvasElement): THistoryEntryLayerTile[];
export function canvasToLayerTiles(
    canvas: HTMLCanvasElement,
    // 发生变化的包围盒。如果不传，代表“全图发生了变化”
    bounds?: TIndexBounds, // canvas area that changed. if undefined -> everything changed
): (THistoryEntryLayerTile | undefined)[];
/**
 * 全局入口：将 Canvas 转换为历史记录瓦片数组
 */
export function canvasToLayerTiles(
    canvas: HTMLCanvasElement,
    bounds?: TIndexBounds, // canvas area that changed. if undefined -> everything changed
): (THistoryEntryLayerTile | undefined)[] {
    // =========================================================
    // 分支 A：局部变化（比如画了一笔）
    // =========================================================
    if (bounds) {
        // 利用之前分析过的算法，算出布尔类型的脏瓦片地图
        const changedTiles = getChangedTiles(bounds, canvas.width, canvas.height);
        // 交给上面的局部收割机去抠图
        return canvasAndChangedTilesToLayerTiles(canvas, changedTiles);
    } else {
        // =========================================================
        // 分支 B：全局变化（比如刚打开图片、或者做了一个全图高斯模糊滤镜）
        // =========================================================
        // 【核心性能优化点】：只进行一次 GPU/内存的读取回传 (Readback)
        // only do a single read back
        const ctx = canvas.getContext('2d')!;
        // 作者的防坑笔记：在某些极端的跨域 SVG 导入场景下，getImageData 会报错。
        // 所以这里用了一个 Safely 的包装函数来兜底。
        /*
            Uncaught SecurityError: Failed to execute 'getImageData' on 'CanvasRenderingContext2D': The canvas has been tainted by cross-origin data.
            Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36
            -> no idea how this was achieved. Tried importing svg with cross-origin content. Did not result in that exception
         */
        // InvalidStateError: The object is in an invalid state.
        const fullImageData = getImageDataSafely(ctx, 0, 0, canvas.width, canvas.height);
        const tilesX = Math.ceil(canvas.width / HISTORY_TILE_SIZE);
        const tilesY = Math.ceil(canvas.height / HISTORY_TILE_SIZE);
        const result: THistoryEntryLayerTile[] = [];

        // 手动在 JS 内存中进行切图操作
        // manually transfer into tiles
        for (let row = 0; row < tilesY; row++) {
            for (let col = 0; col < tilesX; col++) {
                const x = col * HISTORY_TILE_SIZE;
                const y = row * HISTORY_TILE_SIZE;

                // 处理画布边缘的“残缺瓦片”（比如 1000x1000 的画布，最右边的瓦片只有 232 宽）
                const tileWidth = Math.min(HISTORY_TILE_SIZE, canvas.width - x);
                const tileHeight = Math.min(HISTORY_TILE_SIZE, canvas.height - y);

                // 在内存中创建一个新的空白瓦片
                const tileData = new ImageData(tileWidth, tileHeight);
                // 【内存指针操作】：逐行从 FullImage 中把属于这个瓦片的像素拷贝过来
                for (let line = 0; line < tileHeight; line++) {
                    // 源数据在大图中的起始一维索引 (RGBA 占 4 位)
                    const srcStart = ((y + line) * canvas.width + x) * 4;
                    // 目标数据在小瓦片中的起始一维索引
                    const destStart = line * tileWidth * 4;

                    // 使用 TypedArray 的极致原生方法 .set() 和 .subarray() 拷贝一块连续的内存字节
                    tileData.data.set(
                        fullImageData.data.subarray(srcStart, srcStart + tileWidth * 4),
                        destStart,
                    );
                }
                result.push(createImageDataTile(tileData));
            }
        }
        return result;
    }
}
