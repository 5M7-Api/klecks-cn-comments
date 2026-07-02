import { BB } from '../../bb/bb';
import { isLayerFill, TKlProject } from '../kl-types';
import { MultiPolygon } from 'polygon-clipping';
import { transformMultiPolygon } from '../../bb/multi-polygon/transform-multi-polygon';
import { scale } from 'transformation-matrix';
import { getSelectionPath2d } from '../../bb/multi-polygon/get-selection-path-2d';

/**
 * 【离线渲染器】：将整个工程对象合并绘制到一张全新的 Canvas 上。
 * 主要用于导出图片、生成缩略图、打印等场景。
 * 
 * @param project 整个画板的工程数据对象 (包含宽高、图层列表等)
 * @param factor 缩放因子。例如 1 是原图大小，0.5 是缩小一半(常用于缩略图)，2 是放大一倍。
 * @param selection 可选的套索选区。如果传入了选区，导出的图像只包含选区内的内容，外部将被裁剪。
 */
export function drawProject(
    project: TKlProject,
    factor: number,
    selection?: MultiPolygon,
): HTMLCanvasElement {
    // 1. 创建一张全新的“离线画布 (Offscreen Canvas)”
    // 保证宽高至少为 1px，防止 factor 过小导致 Canvas 创建失败 (0x0 Canvas 会报错)
    const resultCanvas = BB.canvas(
        Math.max(1, Math.round(project.width * factor)),
        Math.max(1, Math.round(project.height * factor)),
    );

    // 2. 选区等比缩放
    // 如果我们要导出一个缩小 50% 的缩略图，且要求带选区裁剪，
    // 那么选区的多边形顶点坐标也必须用数学矩阵 (scale) 同步缩小 50%。
    const transformedSelection = selection
        ? transformMultiPolygon(
              selection,
              scale(resultCanvas.width / project.width, resultCanvas.height / project.height),
          )
        : undefined;

    const ctx = BB.ctx(resultCanvas);
    ctx.save();

    // 3. 应用选区裁剪 (Clipping Mask)
    // 如果存在转换后的选区，生成原生 Path2D 路径并进行裁剪。
    // 这之后画的任何图层内容，都不会超出这个选区。
    if (transformedSelection) {
        ctx.clip(getSelectionPath2d(transformedSelection));
    }

    // 4. 【细节防御】：放大时的图像采样策略
    // 如果 factor > 1 (我们要导出一张比原图更大的图片)，强行关闭图像平滑。
    // 为什么？因为专业画图软件放大图片时，用户通常希望看到清晰的“像素块(Pixelated)”，
    // 而不是被浏览器默认的双线性插值 (Bilinear Filtering) 糊成一团模糊的马赛克。
    if (factor > 1) {
        ctx.imageSmoothingEnabled = false;
    }

    // 5. 遍历并合成所有图层 (Painter's Algorithm 画家算法)
    for (let i = 0; i < project.layers.length; i++) {
        const layer = project.layers[i];

        // 隐藏或完全透明的图层，直接跳过，节省性能
        if (!layer.isVisible || layer.opacity === 0) {
            continue;
        }

        // 应用该图层的全局不透明度
        ctx.globalAlpha = layer.opacity;

        // 应用该图层的混合模式 (如 正片叠底、滤色等)，如果没有则默认为正常覆盖 (source-over)
        const mixModeStr = layer.mixModeStr;
        ctx.globalCompositeOperation = mixModeStr !== undefined ? mixModeStr : 'source-over';
        // 6. 执行真实的像素渲染
        if (isLayerFill(layer.image)) {
            // 优化点：如果图层被标记为一个“纯色填充层” (例如用户刚才按了清空并填色)，
            // 我们根本不需要巨大的图片对象，直接用 fillRect 瞬间涂满全屏。
            ctx.fillStyle = layer.image.fill;
            ctx.fillRect(0, 0, resultCanvas.width, resultCanvas.height);
        } else if (layer.image instanceof Array) {
            // [未实现的分支]：猜测原本计划支持直接传入历史记录里的“切片数组(Tiles Array)”，
            // 但目前架构中，传入这里的 layer.image 已经被提前光栅化为完整的 Image/Canvas 对象了。
            throw new Error('not implemented');
        } else {
            // 常规图层渲染：把这一层的图像直接画到目标画布上。
            // ctx.drawImage(image, dx, dy, dWidth, dHeight) 会自动帮我们处理缩放(factor)的问题。
            ctx.drawImage(layer.image, 0, 0, resultCanvas.width, resultCanvas.height);
        }
    }
    ctx.restore();
    // 返回最终合成好的一张“单层” Canvas，可以直接用于 .toDataURL() 下载或转为 Blob。
    return resultCanvas;
}
