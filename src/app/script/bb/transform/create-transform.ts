import { TViewportTransform } from '../../klecks/ui/project-viewport/project-viewport';
import { TVector2D } from '../bb-types';
import { applyToPoint, compose, rotate, scale as scaleFunc } from 'transformation-matrix';

/** 根据给定的视口点和画布点，计算变换矩阵 */
export function createTransform(
    viewportPoint: TVector2D,
    canvasPoint: TVector2D,
    scale: number,
    angleDeg: number,
): TViewportTransform {
    const mat = compose(scaleFunc(-scale, -scale), rotate((angleDeg / 180) * Math.PI));
    const topLeftP = applyToPoint(mat, canvasPoint);
    topLeftP.x += viewportPoint.x;
    topLeftP.y += viewportPoint.y;
    return {
        x: topLeftP.x,
        y: topLeftP.y,
        scale,
        angleDeg,
    };
}
