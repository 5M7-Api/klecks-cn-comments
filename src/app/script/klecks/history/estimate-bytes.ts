import { THistoryEntryData } from './history.types';
import { isLayerFill } from '../kl-types';

// 估算一条历史记录（增量补丁）究竟占用了多少内存 (单位：字节 Bytes)
// estimates how much memory a history entry uses
export function estimateBytes(entry: THistoryEntryData): number {
    let result = 0;

    // -------------------------------------------------------------
    // 1. 估算“复杂选区 (Selection Paths)”的内存
    // 选区（比如用套索工具画的蚂蚁线）在底层是由极其复杂的坐标点集合 (MultiPolygon) 构成的。
    // -------------------------------------------------------------
    // for complex selection paths
    entry.selection?.value?.forEach((poly) => {
        poly.forEach((ring) => {
            // ring.length 代表这个多边形环有多少个顶点。
            // 为什么要 * 2 * 8？
            // 1. 每个顶点是 (x, y) 两个坐标轴，所以 * 2。
            // 2. 在 JavaScript/V8 引擎底层，所有的数字(Number)默认都是双精度浮点数 (Double Float)，
            //    一个双精度浮点数在内存中严格占用 8 个字节 (Bytes)。
            result += ring.length * 2 * 8; // each number 8 bytes
        });
    });

    // -------------------------------------------------------------
    // 2. 估算“脏瓦片 (Tiles)”的内存 (这是绝对的耗存大户)
    // -------------------------------------------------------------
    entry.layerMap &&
        Object.entries(entry.layerMap).forEach(([, layer]) => {
            // 遍历这步操作中涉及的所有瓦片坑位
            layer.tiles?.forEach((tile) => {
                // 如果瓦片是 undefined，说明这块区域没变化。
                // 稀疏数组里的 undefined 在内存里只占个引用位置，体积忽略不计。
                if (tile === undefined) {
                    return;
                }

                // 场景 A：如果这个瓦片仅仅是一条填充指令 (比如 { fill: 'transparent' })
                if (isLayerFill(tile)) {
                    // JavaScript 中的字符串使用的是 UTF-16 编码，
                    // 每个字符在内存中固定占用 2 个字节 (Bytes)。
                    result += tile.fill.length * 2; // 2 byte per character
                } else {
                    // 场景 B：如果这个瓦片是实打实的像素数据 (ImageData)
                    // ImageData 底层是一个 Uint8ClampedArray。
                    // 包含 R, G, B, A 四个通道，每个通道占用 1 个字节 (8-bit)。
                    // 所以一张瓦片的体积 = 宽 * 高 * 4 字节。
                    // 如果瓦片是 256x256，这里算出来就是 256 * 256 * 4 = 262,144 Bytes (256 KB)
                    result += tile.data.width * tile.data.height * 4; // 4 channels, each 1 byte
                }
            });
        });

    return result;
}
