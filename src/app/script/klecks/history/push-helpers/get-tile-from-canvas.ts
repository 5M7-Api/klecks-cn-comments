import { BB } from '../../../bb/bb';
import { getImageDataSafely } from '../../../bb/base/canvas';

/**
 * 精准瓦片切割器：根据行列号，从画布上切下对应区域的像素
 * @param canvas 目标画布
 * @param col 瓦片的列号 (x轴索引，比如 0, 1, 2...)
 * @param row 瓦片的行号 (y轴索引)
 * @param tileSize 瓦片尺寸 (固定为 256)
 */
export function getTileFromCanvas(
    canvas: HTMLCanvasElement,
    col: number,
    row: number,
    tileSize: number,
): ImageData {
    // 获取 Canvas 2D 上下文 (BB.ctx 可能做了一些兼容性封装)
    const ctx = BB.ctx(canvas);

    // =========================================================
    // 【核心亮点】：处理画布边缘的“残缺瓦片”
    // =========================================================
    // 计算当前瓦片在画布上的实际宽度。
    // 逻辑：瓦片的理论右边界是 (col + 1) * tileSize。
    // 但如果这个右边界超出了画布的总宽度 canvas.width，我们就必须用 Math.min 把它截断。
    // 截断后的真实右边界，减去当前瓦片的左边界 (col * tileSize)，就是瓦片的真实宽度。
    const width = Math.min(canvas.width, (col + 1) * tileSize) - col * tileSize;
    const height = Math.min(canvas.height, (row + 1) * tileSize) - row * tileSize;

    // 防呆设计：如果算出来的宽高小于等于 0，说明调用者传了一个完全在画布外面的坐标
    if (width <= 0 || height <= 0) {
        throw new Error('invalid out-of-bounds tile');
    }

    /*
     * 【原作者的极限抗压测试日记】
     * 报错：NS_ERROR_FAILURE & NS_ERROR_OUT_OF_MEMORY (火狐浏览器特有报错)
     * 环境：Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0)
     * 分析：看火狐底层的 C++ 源码，这极大概率是内存溢出 (OOM)。
     * 测试：我自己写了个脚本，强行在内存里塞了 83GB ！！的 Canvas 元素（我电脑只有 32GB 物理内存），
     * 成功复现了这个 NS_ERROR_FAILURE 报错。
     * 结论：这可能是火狐浏览器的内存泄漏，或者是用户真的把内存画爆了。
     */
    /*
        NS_ERROR_FAILURE & NS_ERROR_OUT_OF_MEMORY
        Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0
        Probably out of memory judging by https://searchfox.org/firefox-main/source/dom/canvas/CanvasRenderingContext2D.cpp
        I am able to force NS_ERROR_FAILURE with 83GB worth of canvas elements (32gb ram).
        Maybe a memory leak?
     */
    /*
        Uncaught SecurityError: Failed to execute 'getImageData' on 'CanvasRenderingContext2D': The canvas has been tainted by cross-origin data.
        Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36
        -> no idea how this was achieved. Tried importing svg with cross-origin content. Did not result in that exception
     */
    // Exception: InvalidStateError: The object is in an invalid state.
    return getImageDataSafely(ctx, col * tileSize, row * tileSize, width, height);
}
