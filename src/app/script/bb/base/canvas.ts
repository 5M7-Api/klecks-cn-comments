import { TIndexBounds, TKeyString, TRect } from '../bb-types';
import { createCanvas } from './create-canvas';
import { asyncLoadImage, base64ToBlob, copyObj } from './base';
import { MultiPolygon } from 'polygon-clipping';
import { getSelectionPath2d } from '../multi-polygon/get-selection-path-2d';
import { boundsToRect } from '../math/math';

export function copyCanvas(canvas: HTMLCanvasElement | HTMLImageElement): HTMLCanvasElement {
    const resultCanvas = createCanvas(canvas.width, canvas.height);
    const ctx = resultCanvas.getContext('2d');
    if (!ctx) {
        throw new Error('2d context not supported or canvas already initialized');
    }
    ctx.drawImage(canvas, 0, 0);
    return resultCanvas;
}

/**
 * 获取 canvas 上 2D 上下文，如果获取失败则抛出错误
 * @param canvas 
 * @param options 
 * @returns 
 */
export function ctx(
    canvas: HTMLCanvasElement,
    options?: CanvasRenderingContext2DSettings,
): CanvasRenderingContext2D {
    const ctx = canvas.getContext('2d', options);
    if (!ctx) {
        throw new Error("couldn't get 2d context");
    }
    return ctx;
}

export async function loadToCanvas(path: string): Promise<HTMLCanvasElement> {
    const im = await asyncLoadImage(path);
    const canvas = createCanvas(im.width, im.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(im, 0, 0);
    return canvas;
}

/**
 * Determine if we should disable imageSmoothing for transformation.
 * ImageSmoothing can make images blurry even when they're in the original scale and aligned with the pixelgrid.
 */
export function testShouldPixelate(
    transform: {
        x: number;
        y: number;
        width: number;
        height: number;
        angleDeg: number;
    },
    scaleX: number,
    scaleY: number,
): boolean {
    if (
        ![1, -1].includes(scaleX) ||
        ![1, -1].includes(scaleY) ||
        transform.width % 1 !== 0 ||
        transform.height % 1 !== 0 ||
        Math.abs(transform.angleDeg) % 90 !== 0
    ) {
        return false;
    }
    const whSwapped = Math.abs(transform.angleDeg - 90) % 180 === 0;
    const width = whSwapped ? transform.height : transform.width;
    const height = whSwapped ? transform.width : transform.height;
    return (
        ((Math.abs(width) % 2 === 0 && transform.x % 1 === 0) ||
            (Math.abs(width) % 2 === 1 && transform.x % 1 === 0.5)) &&
        ((Math.abs(height) % 2 === 0 && transform.y % 1 === 0) ||
            (Math.abs(height) % 2 === 1 && transform.y % 1 === 0.5))
    );
}

/**
 * @param destCtx - the canvas that will be drawn on
 * @param transformImage - image that will be drawn on canvas
 * @param transform - {x, y, width, height, angle} - x and y are center of transformImage
 * @param bounds object - optional {x, y, width, height} - crop of transformImage in transformImage image space
 * @param pixelated
 */
export function drawTransformedImageWithBounds(
    destCtx: CanvasRenderingContext2D,
    transformImage: HTMLImageElement | HTMLCanvasElement,
    transform: {
        x: number;
        y: number;
        width: number;
        height: number;
        angleDeg: number;
    },
    bounds?: { x: number; y: number; width: number; height: number },
    pixelated?: boolean,
): void {
    if (!bounds) {
        bounds = {
            x: 0,
            y: 0,
            width: transformImage.width,
            height: transformImage.height,
        };
    }

    destCtx.save();
    if (pixelated) {
        destCtx.imageSmoothingEnabled = false;
    } else {
        destCtx.imageSmoothingEnabled = true;
        destCtx.imageSmoothingQuality = 'high';
    }

    destCtx.translate(transform.x, transform.y);
    destCtx.rotate((transform.angleDeg / 180) * Math.PI);
    destCtx.scale(transform.width > 0 ? 1 : -1, transform.height > 0 ? 1 : -1);
    destCtx.drawImage(
        transformImage,
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
        -Math.abs(transform.width) / 2,
        -Math.abs(transform.height) / 2,
        Math.abs(transform.width),
        Math.abs(transform.height),
    );

    destCtx.restore();
}

/**
 * all transformations are optional
 * center is the point around which will be scaled and rotated
 *
 * @param baseCanvas canvas - the canvas that will be drawn on
 * @param transformImage image|canvas - image that will be drawn on canvas
 * @param transformObj {center: {x, y}, scale: {x, y}, translate: {x, y}, angleDegree}
 */
export function drawTransformedImageOnCanvas(
    baseCanvas: HTMLCanvasElement,
    transformImage: HTMLImageElement | HTMLCanvasElement,
    transformObj: {
        center: { x: number; y: number };
        scale: { x: number; y: number };
        translate: { x: number; y: number };
        angleDegree: number;
    },
): void {
    transformObj = copyObj(transformObj);
    if (!transformObj.center) {
        transformObj.center = {
            x: transformImage.width / 2,
            y: transformImage.height / 2,
        };
    }
    if (!transformObj.scale) {
        transformObj.scale = {
            x: 1,
            y: 1,
        };
    }
    if (!transformObj.angleDegree) {
        transformObj.angleDegree = 0;
    }
    if (!transformObj.translate) {
        transformObj.translate = {
            x: 0,
            y: 0,
        };
    }

    const ctx = baseCanvas.getContext('2d');
    if (!ctx) {
        throw new Error('2d context not supported or canvas already initialized');
    }
    ctx.save();
    if (
        Math.abs(transformObj.scale.x - 1) > 0.000001 ||
        Math.abs(transformObj.scale.y - 1) > 0.000001 ||
        Math.abs(transformObj.angleDegree % 90) > 0.000001
    ) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
    } else {
        ctx.imageSmoothingEnabled = false;
    }

    ctx.translate(transformObj.translate.x, transformObj.translate.y);
    ctx.translate(transformObj.center.x, transformObj.center.y);
    ctx.rotate((transformObj.angleDegree / 180) * Math.PI);
    ctx.scale(transformObj.scale.x, transformObj.scale.y);
    ctx.translate(-transformObj.center.x, -transformObj.center.y);
    ctx.drawImage(transformImage, 0, 0, transformImage.width, transformImage.height);

    ctx.restore();
}

/** 生成一个棋盘格 */
export const createCheckerCanvas = function (size: number, isDark?: boolean): HTMLCanvasElement {
    const canvas = createCanvas();
    let ctx;
    if (size < 1) {
        canvas.width = 1;
        canvas.height = 1;
        ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('2d context not supported or canvas already initialized');
        }
        ctx.fillStyle = 'rgb(128, 128, 128)';
        ctx.fillRect(0, 0, 1, 1);
    } else {
        canvas.width = size * 2;
        canvas.height = size * 2;
        ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('2d context not supported or canvas already initialized');
        }
        ctx.fillStyle = isDark ? 'rgb(90, 90, 90)' : 'rgb(255, 255, 255)';
        ctx.fillRect(0, 0, size * 2, size * 2);
        ctx.fillStyle = isDark ? 'rgb(63, 63, 63)' : 'rgb(200, 200, 200)';
        ctx.fillRect(0, 0, size, size);
        ctx.fillRect(size, size, size * 2, size * 2);
    }
    return canvas;
};

export const createCheckerDataUrl = (function () {
    // previously created dataUrls
    const cache: TKeyString = {};

    return function (
        size: number,
        callback?: (s: string) => void,
        isDark?: boolean,
    ): string | void {
        const modeStr = isDark ? 'd' : 'l';

        function create(size: number): string {
            size = parseInt('' + size);
            if (cache['' + size + modeStr]) {
                return cache['' + size + modeStr];
            }
            const canvas = createCheckerCanvas(size, isDark);
            const result = canvas.toDataURL('image/png');
            cache['' + size + modeStr] = result;
            return result;
        }

        if (callback) {
            //async
            setTimeout(function () {
                callback(create(size));
            }, 1);
        } else {
            //sync
            return create(size);
        }
    };
})();

/**
 * 【核心工具函数】：平滑缩放画布
 * @param canvas 目标画布 - 它的尺寸和像素内容将被直接就地修改 (Destructive Modification)
 * @param w 目标宽度
 * @param h 目标高度
 * @param tmp1 可选的离屏过渡画布，用于复用内存，防止频繁 GC (垃圾回收) 导致卡顿
 * @param tmp2 可选的离屏过渡画布，用于复用内存，防止频繁 GC 导致卡顿
 */
/**
 * smooth resize image
 * @param canvas canvas - will be resized (modified)
 * @param w
 * @param h
 * @param tmp1 canvas - optional, provide to save resources
 * @param tmp2 canvas - optional, provide to save resources
 */
export function resizeCanvas(
    canvas: HTMLCanvasElement,
    w: number,
    h: number,
    tmp1?: HTMLCanvasElement,
    tmp2?: HTMLCanvasElement,
): void {
    /**
     * 【内部数学助手】：计算新旧尺寸基于 2 的幂次指数 (Exponents)
     * 步进缩放的核心是“每次缩小一半”，所以需要知道图片尺寸在 2 的几次方范围。
     */
    //determine base 2 exponents of old and new size
    function getBase2Obj(oldW: number, oldH: number, newW: number, newH: number) {
        const result = {
            oldWidthEx: Math.round(Math.log2(oldW)),
            oldHeightEx: Math.round(Math.log2(oldH)),
            newWidthEx: Math.ceil(Math.log2(newW)),
            newHeightEx: Math.ceil(Math.log2(newH)),
        };
        // 防御边界：确保起始指数不会小于目标指数
        result.oldWidthEx = Math.max(result.oldWidthEx, result.newWidthEx);
        result.oldHeightEx = Math.max(result.oldHeightEx, result.newHeightEx);
        return result;
    }

    if (!w || !h || (w === canvas.width && h === canvas.height)) {
        return;
    }
    w = Math.max(w, 1);
    h = Math.max(h, 1);

    // =========================================================================
    // 分支一：【下采样 / 缩小图片】 (Downscaling - 核心技术难点)
    // 采用步进式每次减半的策略，防止像素大面积丢失导致的锯齿。
    // =========================================================================
    if (w <= canvas.width && h <= canvas.height) {
        // 资源池优化：如果外部没有传入临时的 Canvas，就地创建它们。
        // 如果外部传入了，就可以直接复用这块显存，免去了动态分配内存的系统开销。
        tmp1 = !tmp1 ? createCanvas() : tmp1;
        tmp2 = !tmp2 ? createCanvas() : tmp2;

        const base2 = getBase2Obj(canvas.width, canvas.height, w, h);

        // 初始化第一步的中间画布大小（向上对齐到最近的 2 的幂次方）
        // 规避特殊情况：例如从 900 缩放到 600，跨度太小则无需对齐 2 的幂次，直接用目标宽高即可
        //initially scale to a base of 2. unless new size is too close to old. e.g. sizing from 900 to 600
        tmp2.width = base2.oldWidthEx > base2.newWidthEx ? Math.pow(2, base2.oldWidthEx) : w;
        tmp2.height = base2.oldHeightEx > base2.newHeightEx ? Math.pow(2, base2.oldHeightEx) : h;
        tmp1.getContext('2d')!.save();
        tmp2.getContext('2d')!.save();

        let ew, eh;
        // 经典的“乒乓缓冲区 (Ping-Pong Buffers)”设计！
        // buffer1 和 buffer2 会在循环中不断交换身份，A 画到 B，下一步 B 再画到 A
        let buffer1 = tmp1,
            buffer2 = tmp2;

        ew = base2.oldWidthEx;
        eh = base2.oldHeightEx;

        // 【步骤 1.1】：将原始大图拉伸填充到第一个 2 的幂次方中间画布 (buffer2) 上
        let bufferCtx = buffer2.getContext('2d')!;
        bufferCtx.imageSmoothingEnabled = true;
        bufferCtx.imageSmoothingQuality = 'high';
        bufferCtx.globalCompositeOperation = 'copy';
        bufferCtx.drawImage(canvas, 0, 0, buffer2.width, buffer2.height);

        let currentWidth = buffer2.width;
        let currentHeight = buffer2.height;

        // 【步骤 1.2】：步进式核心循环 —— 每次将画布尺寸砍掉一半
        // 只要宽或高的指数还没降到目标尺寸的范围内，就持续折半渲染
        //stepwise half the size
        for (; ew > base2.newWidthEx || eh > base2.newHeightEx; ew--, eh--) {
            bufferCtx = buffer1.getContext('2d')!;
            bufferCtx.imageSmoothingEnabled = true;
            bufferCtx.imageSmoothingQuality = 'high';
            bufferCtx.globalCompositeOperation = 'copy';

            // 如果当前宽度还需要减半，则除以 2；如果已经降到目标内了，保持宽度不动
            const newWidth = ew > base2.newWidthEx ? currentWidth / 2 : currentWidth;
            const newHeight = eh > base2.newHeightEx ? currentHeight / 2 : currentHeight;

            // 动态修改离屏画布的物理尺寸，腾出干净的像素空间
            //buffer also needs to be properly sized, unfortunately
            buffer1.width = newWidth;
            buffer1.height = newHeight;

            // 将 buffer2 的图像以高质量平滑缩放 50%，绘制到 buffer1 上
            bufferCtx.drawImage(
                buffer2,
                0,
                0,
                currentWidth,
                currentHeight,
                0,
                0,
                newWidth,
                newHeight,
            );
            // 更新当前尺寸记录
            currentWidth = newWidth;
            currentHeight = newHeight;

            // 【指针指针大调换】：乒乓交替。把刚刚画好的 buffer1 作为下一步的源图片，
            // 空出来的 buffer2 作为下一步的目标画布，循环往复。
            //swap
            const tmp = buffer1;
            buffer1 = buffer2;
            buffer2 = tmp;
        }

        // 【步骤 1.3】：此时图片已经被安全地缩放到非常接近目标尺寸了。
        // 正式改变原画布 (canvas) 的大小为最终的目标尺寸 w 和 h。
        //when no longer can be halved, bring to target size
        canvas.width = w;
        canvas.height = h;
        // 执行最后一笔精细渲染：把经过数次减半平滑后的临时数据 (此时在 buffer2 中) 一步画到位
        const canvasCtx = canvas.getContext('2d')!;
        canvasCtx.save();
        canvasCtx.imageSmoothingEnabled = true;
        canvasCtx.imageSmoothingQuality = 'high';
        canvasCtx.drawImage(buffer2, 0, 0, currentWidth, currentHeight, 0, 0, w, h);
        // 善后恢复状态
        canvasCtx.restore();
        tmp1.getContext('2d')!.restore();
        tmp2.getContext('2d')!.restore();
    } else if (w >= canvas.width && h >= canvas.height) {
        // =========================================================================
    // 分支二：【上采样 / 放大图片】 (Upscaling)
    // 浏览器对于放大图片的插值平滑处理得非常好，不需要使用复杂的步进法，直接单次放大。
    // =========================================================================
        tmp1 = !tmp1 ? createCanvas() : tmp1;
        tmp1.width = w;
        tmp1.height = h;
        const tmp1Ctx = tmp1.getContext('2d')!;
        tmp1Ctx.save();
        tmp1Ctx.imageSmoothingEnabled = true;
        tmp1Ctx.imageSmoothingQuality = 'high';
        // 直接在临时画布上画出放大后的精细图像
        tmp1Ctx.drawImage(canvas, 0, 0, w, h);
        tmp1Ctx.restore();

        // 改变原画布物理尺寸（这一步会瞬间清空原画布的所有像素）
        canvas.width = w;
        canvas.height = h;
        // 把刚才在临时画布上放大好的像素无损贴回来
        canvas.getContext('2d')!.drawImage(tmp1, 0, 0);
    } else {
        // =========================================================================
        // 分支三：【非对称各向异性缩放】 (Anisotropic Mixed Scaling)
        // 奇葩场景：用户的操作导致宽度在“缩小”，但高度却在“放大”（或者反过来）。
        // =========================================================================
        // 解耦降维：既然横纵轴趋势相反，那就拆成两步递归调用！
        // 第一步：只处理宽度的目标缩放，高度保持原样。这会完美触发上面的分支一或分支二。
        resizeCanvas(canvas, w, canvas.height, tmp1, tmp2);
        // 第二步：在宽度已经处理好的基础上，再去单独缩放高度到目标 h。
        resizeCanvas(canvas, w, h, tmp1, tmp2);
    }
}
/**
 * 【通道转换引擎】：将画布像素的亮度（明暗）直接转换为透明度（Alpha 通道）
 * 
 * @param canvas 需要被就地修改的离屏 Canvas 对象
 */
/**
 * puts naive greyscale version of image into alpha channel.
 * only writes a, doesn't write rgb
 * @param canvas
 */
export function convertToAlphaChannelCanvas(canvas: HTMLCanvasElement): void {
    // 1. 获取整个画布的所有原始 RGBA 像素数据（ImageData 一维字节数组）
    const imdat = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
    // 2. 遍历每一个像素。由于每个像素占 4 个位置 [R, G, B, A]，所以步长为 4
    for (let i = 0; i < imdat.data.length; i += 4) {
        // 【优化边界】：如果这个像素原本就已经完全透明（Alpha 是 0），直接跳过
        if (imdat.data[i + 3] === 0) {
            continue;
        }
        // 3. 【核心数学公式】：重写 Alpha 通道 (imdat.data[i + 3])
        // R (红色): imdat.data[i]
        // G (绿色): imdat.data[i + 1]
        // B (蓝色): imdat.data[i + 2]
        // A (透明度): imdat.data[i + 3]
        imdat.data[i + 3] =
        // 步骤 A：(R + G + B) / 3 计算该像素的平均灰度值（即明暗度，0 ~ 255）
            ((imdat.data[i] + imdat.data[i + 1] + imdat.data[i + 2]) / 3) *
            // 步骤 B：乘以原始透明度的百分比 (A / 255)
            // 这一步至关重要！如果原本像素就有半透明度，必须等比叠加，防止透明度边缘失真
            (imdat.data[i + 3] / 255);
    }
    // 4. 将修改后的像素数据重新写回画布，更新物理像素内容
    canvas.getContext('2d')!.putImageData(imdat, 0, 0);
}

/**
 * Sometimes garbage collection is too slow, and canvases use up too much memory,
 * or in the worst case there is a hard to fix memory leak.
 * This function manually makes the canvas use as little memory as possible.
 */
export function freeCanvas(canvas: HTMLCanvasElement): void {
    canvas.width = 1;
    canvas.height = 1;
    canvas.remove();
}

/**
 * Determines a bounding box that describes all pixels, which are not fully transparent.
 * Returns undefined if empty.
 */
export function getCanvasBounds(
    context: CanvasRenderingContext2D,
    //restricts the search to this area.
    searchArea?: TIndexBounds,
): TRect | undefined {
    const searchRect = searchArea
        ? boundsToRect(searchArea)
        : {
              x: 0,
              y: 0,
              width: context.canvas.width,
              height: context.canvas.height,
          };
    if (searchRect.width <= 0 || searchRect.height <= 0) {
        return undefined;
    }

    const imdat = context.getImageData(
        searchRect.x,
        searchRect.y,
        searchRect.width,
        searchRect.height,
    );

    // top-left and bottom-right are non-transparent.
    if (imdat.data[3] > 0 && imdat.data[imdat.data.length - 1] > 0) {
        return searchRect;
    }

    const tempBounds: Partial<TIndexBounds> = {};

    for (let i = 3; i < imdat.data.length; i += 4) {
        if (imdat.data[i] > 0) {
            const px = ((i - 3) / 4) % searchRect.width;
            const py = Math.floor((i - 3) / 4 / searchRect.width);

            if (tempBounds.x1 === undefined || px < tempBounds.x1) {
                tempBounds.x1 = px;
            }
            if (tempBounds.y1 === undefined || py < tempBounds.y1) {
                tempBounds.y1 = py;
            }
            if (tempBounds.x2 === undefined || px + 1 > tempBounds.x2) {
                tempBounds.x2 = px;
            }
            if (tempBounds.y2 === undefined || py + 1 > tempBounds.y2) {
                tempBounds.y2 = py;
            }
        }
    }
    if (
        tempBounds.x1 === undefined ||
        tempBounds.y1 === undefined ||
        tempBounds.x2 === undefined ||
        tempBounds.y2 === undefined
    ) {
        return undefined;
    }

    return {
        x: tempBounds.x1 + searchRect.x,
        y: tempBounds.y1 + searchRect.y,
        width: tempBounds.x2 - tempBounds.x1 + 1,
        height: tempBounds.y2 - tempBounds.y1 + 1,
    };
}

// 外部引入提示：在浏览器的 Canvas API 中，ImageData 代表底层真实的像素数组
export function getImageDataSafely(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
): ImageData {
    try {
        // 尝试向浏览器索要这块区域的真实物理像素数据
        return ctx.getImageData(x, y, width, height);
    } catch (e) {
        // 【核心防御】：如果浏览器因为安全或状态原因拒绝提供数据，抛出异常
        // 我们不让整个网页白屏崩溃，而是默默吞下这个错误，
        // 并“伪造”一张和要求尺寸一模一样的、全透明的空白图像交还给调用者。
        return new ImageData(width, height);
    }
}

export function htmlCanvasToBlobAsync(canvas: HTMLCanvasElement, mimeType: string): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) {
                resolve(blob);
            } else {
                reject(new Error('Failed to create blob from canvas.'));
            }
        }, mimeType);
    });
}

export async function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string): Promise<Blob> {
    if ('toBlob' in HTMLCanvasElement.prototype) {
        return await htmlCanvasToBlobAsync(canvas, mimeType);
    } else {
        // assume base64
        return base64ToBlob(canvas.toDataURL(mimeType));
    }
}

export function drawSelectionMask(
    selection: MultiPolygon,
    context: CanvasRenderingContext2D,
): void {
    const canvas = context.canvas;
    context.save();
    context.fillRect(0, 0, canvas.width, canvas.height);
    const selectionPath = getSelectionPath2d(selection);
    context.clip(selectionPath);
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();
}
