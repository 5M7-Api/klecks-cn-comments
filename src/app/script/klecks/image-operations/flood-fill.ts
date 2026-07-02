import { TIndexBounds } from '../../bb/bb-types';

/**
 * [辅助函数]：在指定的矩形区域内填充 254 (注意不是 255)
 * 为什么是 254？这是用于边缘扩展 (Grow) 算法的“临时过渡状态”标记。
 */
/**
 * Set values in data within rect to 254, unless they're 255
 *
 * @param data Uint8Array
 * @param width int
 * @param x0 int
 * @param y0 int
 * @param x1 int >x0
 * @param y1 int >y0
 */
function fillRect(
    data: Uint8Array,
    width: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
): void {
    for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
            if (data[y * width + x] === 255) {
                continue;
            }
            // 标记为“即将扩展区” (254)
            data[y * width + x] = 254;
        }
    }
}

/**
 * [性能极致优化]：容差计算 (Tolerance Test)
 * 检查当前像素与点击的初始像素在 RGBA 颜色空间上的距离是否小于容差。
 */
// test, should fill, if there is a tolerance < 255
function toleranceTest(
    srcArr: Uint8ClampedArray,
    initR: number,
    initG: number,
    initB: number,
    initA: number,
    // 【优化点1】：外部提前算好容差的平方，内部避免使用极其昂贵的 Math.sqrt()
    toleranceSquared: number, // already squared for performance
    i: number,
): boolean {
    return (
        // 计算欧几里得距离的平方
        (srcArr[i * 4] - initR) ** 2 <= toleranceSquared &&
        (srcArr[i * 4 + 1] - initG) ** 2 <= toleranceSquared &&
        (srcArr[i * 4 + 2] - initB) ** 2 <= toleranceSquared &&
        (srcArr[i * 4 + 3] - initA) ** 2 <= toleranceSquared
    );
}

// 检查该像素是否在套索工具的选区内
// check is within selection
function selectionMaskTest(selectionMaskArr: Uint8Array | undefined, i: number): boolean {
    // 如果没有选区限制 (!selectionMaskArr)，直接放行
    // 如果有选区限制，只有当该像素在选区内 (值为 1/true 时)，才放行
    return !selectionMaskArr || !!selectionMaskArr[i];
}


/**
 * 【核心算法】：洪水填充 (Flood Fill)
 * 注意：这个函数不直接修改原图颜色！它只负责输出一张“黑白蒙版 (Mask)”（0 为不填充，255 为要填充）
 */
/**
 *
 * @param srcArr Uint8ClampedArray rgba
 * @param selectionMaskArr Uint8Array width x height, 0 or 1 values
 * @param targetArr Uint8Array
 * @param width int
 * @param height int
 * @param px int
 * @param py int
 * @param tolerance int 0 - 255
 * @param grow int >= 0
 * @param isContiguous boolean
 */
function floodFill(
    // 原图所有像素的一维数组 [r,g,b,a, r,g,b,a...]
    srcArr: Uint8ClampedArray,
    selectionMaskArr: Uint8Array | undefined,
    // 目标结果数组 (全 0 初始化)
    targetArr: Uint8Array,
    width: number,
    height: number,
    // 鼠标点击的起始点坐标
    px: number,
    py: number,
    tolerance: number,
    grow: number,
    // 是否连续（PS 里油漆桶的“连续”勾选项）
    isContiguous: boolean,
): TIndexBounds {
    // 1. 提取鼠标点击位置的初始 RGBA 颜色
    const initR = srcArr[(py * width + px) * 4];
    const initG = srcArr[(py * width + px) * 4 + 1];
    const initB = srcArr[(py * width + px) * 4 + 2];
    const initA = srcArr[(py * width + px) * 4 + 3];

    // ! 【优化点2：C语言级别的指针魔法】
    // ! 正常判断两个像素颜色是否一样，需要写 R1==R2 && G1==G2 && B1==B2 && A1==A2（比对四次）
    // ! 但是，如果使用 32 位整数视图 (DataView)，可以一次性对比一个像素的完整颜色，而不需要比 4 次！
    // ! 这样，就可以在 32 位整数视图中直接进行位运算，而不需要额外的内存分配和数据复制。
    // 将一维字节数组转为 32 位整数视图。
    // 一个像素正好是 R(8bit)+G(8bit)+B(8bit)+A(8bit) = 32bit。
    // 这意味着在容差为 0 时，可以一次性对比一个像素的完整颜色，而不需要比 4 次！
    const view = new DataView(srcArr.buffer);
    const init = view.getUint32((py * width + px) * 4, true);
    const toleranceSquared = tolerance ** 2;
    // 追踪本次填充影响的最小矩形包围盒，用于极大地减小历史记录的内存占用
    const bounds: TIndexBounds = { type: 'index', x1: px, y1: py, x2: px, y2: py };

    if (isContiguous) {
        // ==========================================
        // 模式 A：连续填充 (Standard Flood Fill)
        // ! 是否在一个色环内，区域填充
        // 使用基于栈 (Stack) 的深度优先搜索 (DFS) 算法，向四周蔓延
        // ==========================================
        // 待处理的像素索引栈
        const q: number[] = []; // queue of pixel indices. they are already filled.
        q.push(py * width + px); // starting pixel, where the user clicked to fill
        // 标记起点已填充
        targetArr[py * width + px] = 255;

        let i: number, e: number;
        let x: number, y: number;
        while (q.length) {
            // checks neighbors of queued pixels, fills, and queues them.
            // Adds to queue after filling it. Skip if was already filled.

            // 取出一个像素点
            i = q.pop()!;

            y = Math.floor(i / width);
            x = i % width;

            // 分别向 左、右、上、下 四个方向检查并蔓延
            if (x > 0) {
                // can go left
                e = i - 1;
                if (
                    // 还没被填充过
                    targetArr[e] !== 255 &&
                    // 在选区内
                    selectionMaskTest(selectionMaskArr, e) &&
                    // 颜色完全一致 (极速32位对比)
                    (view.getUint32(e * 4, true) === init ||
                        (tolerance > 0 &&
                            toleranceTest(srcArr, initR, initG, initB, initA, toleranceSquared, e)))
                ) {
                    // 撑大包围盒
                    bounds.x1 = Math.min(bounds.x1, x - 1);
                    // 标记为已填充
                    targetArr[e] = 255;
                    // 压入栈中，留待下一轮向外蔓延
                    q.push(e);
                }
            }
            // ... (向右、向上、向下蔓延逻辑完全同理，此处省略以保持精简) ...
            if (x < width - 1) {
                // can go right
                e = i + 1;
                if (
                    targetArr[e] !== 255 &&
                    selectionMaskTest(selectionMaskArr, e) &&
                    (view.getUint32(e * 4, true) === init ||
                        (tolerance > 0 &&
                            toleranceTest(srcArr, initR, initG, initB, initA, toleranceSquared, e)))
                ) {
                    bounds.x2 = Math.max(bounds.x2, x + 1);
                    targetArr[e] = 255;
                    q.push(e);
                }
            }
            if (y > 0) {
                // can go up
                e = i - width;
                if (
                    targetArr[e] !== 255 &&
                    selectionMaskTest(selectionMaskArr, e) &&
                    (view.getUint32(e * 4, true) === init ||
                        (tolerance > 0 &&
                            toleranceTest(srcArr, initR, initG, initB, initA, toleranceSquared, e)))
                ) {
                    bounds.y1 = Math.min(bounds.y1, y - 1);
                    targetArr[e] = 255;
                    q.push(e);
                }
            }
            if (y < height - 1) {
                // can go down
                e = i + width;
                if (
                    targetArr[e] !== 255 &&
                    selectionMaskTest(selectionMaskArr, e) &&
                    (view.getUint32(e * 4, true) === init ||
                        (tolerance > 0 &&
                            toleranceTest(srcArr, initR, initG, initB, initA, toleranceSquared, e)))
                ) {
                    bounds.y2 = Math.max(bounds.y2, y + 1);
                    targetArr[e] = 255;
                    q.push(e);
                }
            }
        }
    } else {
        // ==========================================
        // 模式 B：非连续填充 (替换全图相似色)
        // ! 画布上的像素和点击像素是否一致，区域替换填充
        // 暴力遍历法：抛弃扩散路径，直接从头到尾扫一遍全图
        // ==========================================
        // not contiguous
        for (let y = 0, i = 0; y < height; y++) {
            for (let x = 0; x < width; x++, i++) {
                if (
                    selectionMaskTest(selectionMaskArr, i) &&
                    (view.getUint32(i * 4, true) === init ||
                        (tolerance > 0 &&
                            toleranceTest(srcArr, initR, initG, initB, initA, toleranceSquared, i)))
                ) {
                    targetArr[i] = 255;
                    // 更新最大边界包围盒
                    if (x < bounds.x1) {
                        bounds.x1 = x;
                    }
                    if (y < bounds.y1) {
                        bounds.y1 = y;
                    }
                    if (x > bounds.x2) {
                        bounds.x2 = x;
                    }
                    if (y > bounds.y2) {
                        bounds.y2 = y;
                    }
                }
            }
        }
    }

    // 如果不需要边缘扩张，直接返回
    if (grow === 0) {
        return bounds;
    }

    // ==========================================
    // 【扩展魔法 (Grow)】：消除填充边缘的白边锯齿
    // 很多时候用油漆桶填色，边缘会有一圈没填满的白色半透明像素。Grow 的作用就是把填充区域向外强制“胖”几圈。
    // ==========================================
    // --- grow ---
    // how does it grow? it finds all pixel at the edge.
    // then depending on what kind of edge it is, it draws a rectangle into target
    // In the rectangle each pixel has the value 254, or else it will mess it all up.
    // after it's all done, replaces it with 255
    let x0, x1, y0, y1;
    let l, tl, t, tr, r, br, b, bl; // left, top left, top, top right, etc.
    // 只在已计算出的边界框内扫描，极大节省性能
    for (let x = bounds.x1; x <= bounds.x2; x++) {
        for (let y = bounds.y1; y <= bounds.y2; y++) {
            if (targetArr[y * width + x] !== 255) {
                continue;
            }

            // bounds of rectangle
            x0 = x;
            x1 = x;
            y0 = y;
            y1 = y;

            // 检查这个填充像素的周围 8 个方向，是不是有“尚未填充”的区域
            l = targetArr[y * width + x - 1] !== 255;
            tl = targetArr[(y - 1) * width + x - 1] !== 255;
            t = targetArr[(y - 1) * width + x] !== 255;
            tr = targetArr[(y - 1) * width + x + 1] !== 255;
            r = targetArr[y * width + x + 1] !== 255;
            br = targetArr[(y + 1) * width + x + 1] !== 255;
            b = targetArr[(y + 1) * width + x] !== 255;
            bl = targetArr[(y + 1) * width + x - 1] !== 255;

            // 根据周边的情况，计算出要往哪个方向扩张 (向外延伸 grow 个像素)
            if (l) {
                // left
                x0 = x - grow;
            }
            if (l && tl && t) {
                // top left
                x0 = x - grow;
                y0 = y - grow;
            }
            if (t) {
                // top
                y0 = Math.min(y0, y - grow);
            }
            if (t && tr && r) {
                // top right
                y0 = Math.min(y0, y - grow);
                x1 = x + grow;
            }
            if (r) {
                // right
                x1 = Math.max(x1, x + grow);
            }
            if (r && br && b) {
                // bottom right
                x1 = Math.max(x1, x + grow);
                y1 = Math.max(y1, y + grow);
            }
            if (b) {
                // bottom
                y1 = Math.max(y1, y + grow);
            }
            if (b && bl && l) {
                // bottom left
                x0 = Math.min(x0, x - grow);
                y1 = Math.max(y1, y + grow);
            }

            // 如果四周全是已填充像素 (说明它是被包在内部的像素点)，不需要向外扩张，直接跳过
            if (!l && !tl && !t && !tr && !r && !br && !b && !bl) {
                continue;
            }

            // ! 【黑魔法 3：填入 254 过渡状态】
            // 向外扩展时，绝对不能直接填入 255！
            // 如果直接填 255，下一个循环遍历到这个刚生成的像素时，会以为它是“原本的边界”，
            // 导致算法以它为中心再次向外扩张，瞬间发生核爆般的无限增殖，填满全图
            fillRect(
                targetArr,
                width,
                Math.max(0, x0),
                Math.max(0, y0),
                Math.min(width - 1, x1),
                Math.min(height - 1, y1),
            );
        }
    }
    // 扩张结束后，安全了，把所有的 254 (临时过渡区) 统一转正为 255 (最终填充区)
    for (let i = 0; i < width * height; i++) {
        if (targetArr[i] === 254) {
            targetArr[i] = 255;
        }
    }
    // 最后，把包围盒向外扩大 grow 的尺寸，并返回
    // expand bounds by grow
    bounds.x1 -= grow;
    bounds.y1 -= grow;
    bounds.x2 += grow;
    bounds.y2 += grow;

    return bounds;
}

/**
 * 暴露给外部调用的包裹器函数
 */
/**
 * Does flood fill, and returns that. an array - 0 not filled, 255 filled.
 */
export function floodFillBits(
    rgbaArr: Uint8ClampedArray,
    // width x height, 0 or 1 values
    selectionMaskArr: Uint8Array | undefined,
    width: number, // int
    height: number, // int
    x: number, // int
    y: number, // int
    tolerance: number, // 0 - 255
    grow: number, // int >= 0
    isContiguous: boolean,
): {
    data: Uint8Array;
    bounds: TIndexBounds; // what area changed
} {
    x = Math.round(x); // just in case
    y = Math.round(y);

    // 初始化一张和原画布一样大的“全黑”蒙版图 (全是 0)
    const resultArr = new Uint8Array(new ArrayBuffer(width * height));

    const bounds = floodFill(
        rgbaArr,
        selectionMaskArr,
        resultArr,
        width,
        height,
        x,
        y,
        tolerance,
        grow,
        isContiguous,
    );

    return {
        data: resultArr,
        bounds,
    };
}
