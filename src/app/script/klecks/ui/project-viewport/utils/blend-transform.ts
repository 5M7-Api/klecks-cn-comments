import { TViewportTransform } from '../project-viewport';
import { TSize2D, TVector2D } from '../../../../bb/bb-types';
import { isTransformEqual } from './is-transform-equal';
import { BB } from '../../../../bb/bb';
import { TMetaTransform, toMetaTransform } from '../../../../bb/transform/to-meta-transform';
import { createTransform } from '../../../../bb/transform/create-transform';
import { createMatrixFromTransform } from '../../../../bb/transform/create-matrix-from-transform';
import { applyToPoint } from 'transformation-matrix';

/**
 * 混合（插值）两个视口变换状态，用于实现平滑的运镜动画。
 * @param currentTransform 当前视角状态（起点）
 * @param targetTransform 目标视角状态（终点）
 * @param projectSize 画布的真实物理尺寸
 * @param viewportCenter 当前屏幕视口的中心点坐标
 * @param easeFactor 缓动因子（0 代表完全在起点，1 代表完全到达终点，0.5 代表在正中间）
 */
export function blendTransform(
    currentTransform: TViewportTransform,
    targetTransform: TViewportTransform,
    projectSize: TSize2D,
    viewportCenter: TVector2D,
    easeFactor: number,
): TViewportTransform {
    // console.log('blendTransform: currentTransform', currentTransform);
    // console.log('blendTransform: targetTransform', targetTransform);
    // ==========================================
    // 策略 1：完全相等（性能优化）
    // ==========================================
    // equal
    if (isTransformEqual(currentTransform, targetTransform)) {
        return { ...targetTransform };
    }

    // ==========================================
    // 策略 2：极其接近时直接“吸附（Snap）”
    // 解决“芝诺的乌龟”问题：如果总是取差值的 50%，永远也无法真正到达终点。
    // 当 X/Y 误差小于 2 像素，且缩放误差小于 8% 时，直接结束动画，强制等于目标值。
    // ==========================================
    // approximately equal
    if (
        (currentTransform.x === targetTransform.x ||
            Math.abs(currentTransform.x - targetTransform.x) < 2) &&
        (currentTransform.y === targetTransform.y ||
            Math.abs(currentTransform.y - targetTransform.y) < 2) &&
        (currentTransform.scale === targetTransform.scale ||
            Math.abs(currentTransform.scale - targetTransform.scale) < 0.08 * targetTransform.scale)
    ) {
        return {
            ...targetTransform,
        };
    }

    // ==========================================
    // 策略 3：纯平移和缩放（角度没变）
    // 这是最简单、最常见的情况，直接对 X, Y, Scale 进行线性插值 (mix) 即可。
    // ==========================================
    // same angle, just translate and scale
    if (currentTransform.angleDeg === targetTransform.angleDeg) {
        return {
            x: BB.mix(currentTransform.x, targetTransform.x, easeFactor),
            y: BB.mix(currentTransform.y, targetTransform.y, easeFactor),
            angleDeg: targetTransform.angleDeg,
            scale: BB.mix(currentTransform.scale, targetTransform.scale, easeFactor),
        };
    }

    // ==========================================
    // 策略 4：围绕屏幕中心点旋转/缩放（例如双指捏合缩放）
    // ==========================================
    // 将状态转换为“MetaTransform”（它描述的是：屏幕上的点映射到了画布上的哪个点）
    // rotating around a point
    const currentMeta = toMetaTransform(currentTransform, viewportCenter);
    const targetMeta = toMetaTransform(targetTransform, viewportCenter);
    // 如果起点和终点，在画布上的锚点几乎没有移动（距离小于1），
    // 意味着用户是在“定点缩放/旋转”（就像用图钉钉住画纸中间，然后旋转画纸）。
    if (BB.Vec2.dist(currentMeta.canvasP, targetMeta.canvasP) < 1) {
        // move angles closer to each other. assumes [-180, 180] angle range.
        let closerCurrentAngleDeg = currentMeta.angleDeg;
        // 【关键体验细节：最短旋转路径】
        // 假设当前角度是 170度，目标角度是 -170度。
        // 如果直接插值，画面会“倒退”狂转 340度 穿过 0度 回到 -170度。
        // 这个修正逻辑发现差值 > 180度后，会把当前角度当成 -190度，这样只需要正向转 20度 就能到达终点。
        // -180 180 -> 180 + 180 = 360
        // 180 -180 -> -180 - 180 = -360
        const angleDelta = targetMeta.angleDeg - currentMeta.angleDeg;
        if (angleDelta > 180) {
            closerCurrentAngleDeg += 360;
        }
        if (angleDelta < -180) {
            closerCurrentAngleDeg -= 360;
        }

        // 对定点旋转和缩放进行线性插值
        const mixedMeta: TMetaTransform = {
            viewportP: viewportCenter,
            canvasP: targetMeta.canvasP,
            scale: BB.mix(currentTransform.scale, targetTransform.scale, easeFactor),
            angleDeg: BB.mix(closerCurrentAngleDeg, targetTransform.angleDeg, easeFactor),
        };

        // 组装回标准状态对象返回
        return createTransform(
            mixedMeta.viewportP,
            mixedMeta.canvasP,
            mixedMeta.scale,
            mixedMeta.angleDeg,
        );
    }

    // ==========================================
    // 策略 5：最复杂的复合运动（平移 + 缩放 + 旋转 同时发生）
    // 不能简单插值 X 和 Y！因为原点 (x,y) 在左上角，旋转时左上角的轨迹是弧线！
    // 如果对 x,y 直接线性插值，画面在运镜中途会像甩麻花一样“荡”出屏幕再回来。
    // ==========================================

    // 解决思路：以“画纸的正中心”作为稳定参考点来计算轨迹。
    // rotate around center of canvas
    const canvasCenter = {
        x: projectSize.width / 2,
        y: projectSize.height / 2,
    };
    // 把状态转成底层的矩阵，算出“当前画纸中心在屏幕哪” 和 “最终画纸中心在屏幕哪”
    const currentMatrix = createMatrixFromTransform(currentTransform);
    const targetMatrix = createMatrixFromTransform(targetTransform);
    const currentCenter = applyToPoint(currentMatrix, canvasCenter);
    const targetCenter = applyToPoint(targetMatrix, canvasCenter);

    // 对画纸的中心点位置、缩放、角度 进行插值。（中心点的移动轨迹是一条直线，画面非常稳定）
    const mixedCenter = {
        x: BB.mix(currentCenter.x, targetCenter.x, easeFactor),
        y: BB.mix(currentCenter.y, targetCenter.y, easeFactor),
    };
    const mixedScale = BB.mix(currentTransform.scale, targetTransform.scale, easeFactor);
    const mixedAngleDeg = BB.mix(currentTransform.angleDeg, targetTransform.angleDeg, easeFactor);

    const mixedAngleRad = mixedAngleDeg * (Math.PI / 180);

    // 核心三角函数：算出了中间帧“中心点”在哪后，必须倒推算出对应的“左上角原点(x,y)”该填什么。
    // 这几行代码计算的是：在当前缩放和旋转下，从中心点走回左上角原点的向量偏移。
    // calculate the offset from the center to the top-left corner (origin)
    const offsetX = -canvasCenter.x * mixedScale;
    const offsetY = -canvasCenter.y * mixedScale;

    const rotatedOffsetX = offsetX * Math.cos(mixedAngleRad) - offsetY * Math.sin(mixedAngleRad);
    const rotatedOffsetY = offsetX * Math.sin(mixedAngleRad) + offsetY * Math.cos(mixedAngleRad);

    const origin = {
        x: mixedCenter.x + rotatedOffsetX,
        y: mixedCenter.y + rotatedOffsetY,
    };

    // 返回这一帧完美计算出的运镜状态
    return {
        x: origin.x,
        y: origin.y,
        scale: mixedScale,
        angleDeg: mixedAngleDeg,
    };
}
