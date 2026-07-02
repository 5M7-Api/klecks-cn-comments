import { applyToPoint, Matrix } from 'transformation-matrix';
import { TCoordinateBounds } from '../bb-types';

export function transformCoordinateBounds(
    // 原始的正交包围盒
    bounds: TCoordinateBounds, 
    // 仿射变换矩阵 (包含平移、旋转、缩放、斜切等任意组合)
    transform: Matrix,
): TCoordinateBounds {
    // 1. 暴力穷举：根据原包围盒的 x1, y1, x2, y2，老老实实拼凑出完整的四个物理顶点
    const p1 = applyToPoint(transform, { x: bounds.x1, y: bounds.y1 });
    const p2 = applyToPoint(transform, { x: bounds.x2, y: bounds.y1 });
    const p3 = applyToPoint(transform, { x: bounds.x2, y: bounds.y2 });
    const p4 = applyToPoint(transform, { x: bounds.x1, y: bounds.y2 });
    // 2. 重新洗牌：不管这四个点在空间中被旋转扭曲成了什么鬼样子 (菱形、平行四边形)，
    // 我只需要在横轴 (X) 和纵轴 (Y) 上分别找出它们的“最极端的边界”。
    return {
        type: 'coordinate',
        x1: Math.min(p1.x, p2.x, p3.x, p4.x),
        y1: Math.min(p1.y, p2.y, p3.y, p4.y),
        x2: Math.max(p1.x, p2.x, p3.x, p4.x),
        y2: Math.max(p1.y, p2.y, p3.y, p4.y),
    };
}
