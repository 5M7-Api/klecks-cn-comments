import { MultiPolygon } from 'polygon-clipping';
import { BB } from '../../bb/bb';
import { drawSelectionMask } from '../../bb/base/canvas';

/**
 * ! 性能优化。这个函数使得得矢量选区可以被快速转换为二值化像素数组，供后续的图像处理算法使用。
 * 【二值化遮罩生成器】：将矢量多边形选区转化为高效的扁平二值化像素数组
 * 
 * @param selection 矢量多边形选区数据
 * @param width 画布宽度
 * @param height 画布高度
 * @returns 扁平的一维 Uint8Array 数组，每个字节代表一个像素（0 表示外，1 表示内）
 */
export function getBinaryMask(selection: MultiPolygon, width: number, height: number): Uint8Array {
    // 1. 【内存预分配】：直接在 V8 引擎底层分配一块连续的 ArrayBuffer，创建扁平的一维字节数组。
    // 这比直接 new Array() 性能高出数个数量级，避免了数组动态扩容（Reallocation）带来的开销。
    const result = new Uint8Array(new ArrayBuffer(width * height));

    // 2. 创建一个等大临时离屏画布，并获取其 2D 上下文
    const canvas = BB.canvas(width, height);
    const ctx = BB.ctx(canvas);

    // 3. 将矢量多边形绘制到画布上
    // 这个底层方法通常会将选区内部填充为白色（R:255, G:255, B:255, A:255），选区外部保持透明（黑色 R:0）
    drawSelectionMask(selection, ctx);

    // 4. 读取画布上的原始 RGBA 像素数据（长度为 width * height * 4）
    const imageData = ctx.getImageData(0, 0, width, height);

    // !【内存纪律】：在进入接下来的重度 CPU 计算循环之前，立刻释放临时 Canvas
    // 这可以让垃圾回收器（GC）在 CPU 繁忙时就开始异步清理显存，防止系统瞬时内存峰值过高。
    BB.freeCanvas(canvas);
    const len = width * height;

    // 5. 【极限位运算优化循环】：
    // i 遍历二值遮罩结果数组（1 字节/像素）
    // e 遍历 RGBA 图像数组（4 字节/像素，代表 R, G, B, A）
    for (let i = 0, e = 0; i < len; i++, e += 4) {
        // ==========================================
        // 【核心黑魔法】：`>>> 7` 无符号右移 7 位
        // ==========================================
        // imageData.data[e] 代表红色通道的值（0 ~ 255）
        // 在二进制中：
        //   - 如果红通道值 >= 128（属于选区内，如 255 是二进制 11111111）：
        //     右移 7 位后，高位的 1 被挪到了最右边，结果刚好是整数 1！
        //   - 如果红通道值 < 128（属于选区外，如 0 是二进制 00000000）：
        //     右移 7 位后，结果刚好是整数 0！
        // 
        // 为什么不用 `if (r > 127) result[i] = 1`？
        // 因为 if 分支语句会触发 CPU 的“分支预测（Branch Prediction）”。
        // 在遍历百万像素的循环中，分支预测失败会导致 CPU 流水线被清空，性能暴跌。
        // 使用位移（Bitwise Shift）是完美的“无分支（Branchless）”运算，在浏览器 JIT 编译后速度极快！
        result[i] = imageData.data[e] >>> 7;
    }
    return result;
}
