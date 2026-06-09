import { TViewportTransform } from '../project-viewport';
import { TCoordinateBounds, TRect, TSize2D } from '../../../../bb/bb-types';
import { createTransform } from '../../../../bb/transform/create-transform';
import { fitInto } from '../../../../bb/base/base';
import { BB } from '../../../../bb/bb';
import { TVec4 } from '../../../../bb/math/matrix';
import { snapAngleDeg } from '../../../../bb/math/math';

/**
 * 计算一个视口变换对象，将画布空间的指定矩形 rect 完美适配到视口（画架）中。
 * 主要涉及到一些奇怪角度，比如旋转为歪斜的菱形，也能适配视口。
 * @param rect - 画布空间中需要适配的目标矩形区域（例如整张画纸的范围）
 * @param viewportTransform - 当前的视角状态
 * @param easelSize - 屏幕可视窗口（DOM元素）的实际宽高
 * @param snapRotation - 是否将旋转角度对齐到最近的 90 度倍数（让画面回正）
 * @param padding - 四周留白边距（防止画面死死贴着屏幕边缘，默认0）
 */
/**
 * Returns a viewport transform that fits `rect` (in canvas space) into the viewport.
 * @param rect - rectangle in canvas space to fit
 * @param viewportTransform - current viewport transform
 * @param easelSize - size of the viewport DOM element
 * @param snapRotation - if true, snaps the current viewport angle to the nearest 90°
 * @param padding - viewport space padding per side (default 0)
 */
export function getFitRectTransform(
    rect: TRect,
    viewportTransform: TViewportTransform,
    easelSize: TSize2D,
    snapRotation: boolean,
    padding: number = 0,
): TViewportTransform {
    // ========================================================
    // 步骤 1：处理视角旋转角度（角度对齐）
    // ========================================================
    // rotate
    let newAngleDeg = viewportTransform.angleDeg;
    if (snapRotation) {
        // 特殊边界情况：如果是刚好歪了 45 度，强制判定为回正到 0 度（否则默认四舍五入会变成90度）
        if (newAngleDeg === 45) {
            // would otherwise get rounded to 90
            newAngleDeg = 0;
        }
        // 调用数学工具，将角度强行吸附（Snap）到最近的 90 度的倍数（0°, 90°, 180°, 270°）
        newAngleDeg = snapAngleDeg(newAngleDeg, 90, 90);
    }

    // 计算目标矩形的中心点坐标（画布坐标系）
    // calc width and height of bounds after rotation
    const rectCenterX = rect.x + rect.width / 2;
    const rectCenterY = rect.y + rect.height / 2;
    // 提取目标矩形的 4 个顶点坐标（左上、右上、右下、左下）
    const canvasPointsArr = [
        [rect.x, rect.y], // top left
        [rect.x + rect.width, rect.y], // top right
        [rect.x + rect.width, rect.y + rect.height], // bottom right
        [rect.x, rect.y + rect.height], // bottom left
    ];

    // ========================================================
    // 步骤 2：利用数学矩阵，计算矩形在旋转后的“外接矩形（AABB）”
    // 核心原理：矩形一旦歪过来，它在屏幕上占用的横向和纵向空间就会变大。
    // 为了不让画面的角被切掉，必须算出来它旋转后的真实最大边界。
    // ========================================================
    // setup transformation matrix
    let matrix = BB.Matrix.getIdentity();
    matrix = BB.Matrix.multiplyMatrices(
        matrix,
        BB.Matrix.createRotationMatrix((newAngleDeg / 180) * Math.PI),
    );

    // 遍历 4 个顶点，用矩阵乘法计算出它们旋转之后的全新坐标
    // rotate points
    for (let i = 0; i < canvasPointsArr.length; i++) {
        let coords: TVec4 = [canvasPointsArr[i][0], canvasPointsArr[i][1], 0, 1];
        coords = BB.Matrix.multiplyMatrixAndPoint(matrix, coords);
        canvasPointsArr[i][0] = coords[0];
        canvasPointsArr[i][1] = coords[1];
    }

    // 遍历旋转后的 4 个新顶点，找出绝对的最小值和最大值，围成一个平行于屏幕的物理包围盒（Bounds）
    const boundsObj: Partial<TCoordinateBounds> = {};
    for (let i = 0; i < canvasPointsArr.length; i++) {
        if (boundsObj.x1 === undefined || canvasPointsArr[i][0] < boundsObj.x1) {
            boundsObj.x1 = canvasPointsArr[i][0];
        }
        if (boundsObj.y1 === undefined || canvasPointsArr[i][1] < boundsObj.y1) {
            boundsObj.y1 = canvasPointsArr[i][1];
        }
        if (boundsObj.x2 === undefined || canvasPointsArr[i][0] > boundsObj.x2) {
            boundsObj.x2 = canvasPointsArr[i][0];
        }
        if (boundsObj.y2 === undefined || canvasPointsArr[i][1] > boundsObj.y2) {
            boundsObj.y2 = canvasPointsArr[i][1];
        }
    }

    // 得到了目标区域在当前旋转角度下，在屏幕上所需要的实际「总宽度」和「总高度」
    const boundsWidth = boundsObj.x2! - boundsObj.x1!;
    const boundsHeight = boundsObj.y2! - boundsObj.y1!;

    // ========================================================
    // 步骤 3：长宽比适配（Aspect Ratio Fitting）
    // ========================================================
    // 调用 fitInto 比例适配算法。
    // 拿着计算出来的包围盒宽高，去适配“扣除了四周留白边距（padding）”之后的屏幕窗口大小。
    // 这一步能算出在保持长宽比不变的前提下，能把图形塞进去的完美目标尺寸（fitWidth）。
    // fit bounds
    const { width: fitWidth } = fitInto(
        boundsWidth,
        boundsHeight,
        easelSize.width - padding * 2,
        easelSize.height - padding * 2,
        1,
    );

    // 限制最大放大倍数（体验优化）：
    // 当你要看清的东西极其微小时（比如用户聚焦一个 10x10 像素的超小图层），
    // targetScale 算出来的数值可能会惊人地大（比如 5000%），导致屏幕瞬间一片模糊马赛克。
    // 这里的策略是：上限设定为“当前视角缩放”和“100%（1.0）”之间的较大者。确保绝对不会盲目放大。
    // determine scale
    // when bringing something into view avoid zooming in too far
    const maxScale = Math.max(viewportTransform.scale, 1);
    const factor = Math.min(maxScale, fitWidth / boundsWidth);

    // ========================================================
    // 步骤 5：对齐中心，组装并返回全新的视口矩阵对象
    // ========================================================
    return createTransform(
        // 目标映射终点：屏幕窗口的物理中心点位置
        { x: easelSize.width / 2, y: easelSize.height / 2 },
        // 目标映射起点：画布上目标矩形的物理中心点位置
        { x: rectCenterX, y: rectCenterY },
        factor,
        newAngleDeg,
    );
}
