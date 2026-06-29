import { MultiPolygon } from 'polygon-clipping';
import { TCoordinateBounds, TIndexBounds } from '../bb-types';
import { coordinateBoundsToIndexBounds } from '../math/math';

/**
 * 获取多重多边形的最小包围盒 (Axis-Aligned Bounding Box)
 * @param poly - 复杂的多边形数据结构
 * @param type - 请求返回的包围盒类型 ('coordinate' 浮点坐标 或 'index' 整数索引)
 */
export function getMultiPolyBounds<T extends TCoordinateBounds['type'] | TIndexBounds['type']>(
    poly: MultiPolygon,
    type: T,
): T extends 'index' ? TIndexBounds : TCoordinateBounds {
    // 初始化边界变量为 undefined
    // x1, y1 代表左上角 (Min)； x2, y2 代表右下角 (Max)
    let x1: number | undefined;
    let y1: number | undefined;
    let x2: number | undefined;
    let y2: number | undefined;

    // 1. 遍历所有的多边形 (一个选区可能由多个不相连的块组成)
    poly.forEach((poly) => {
        // 2. 遍历该多边形的所有环 (包含外轮廓，以及内部被减去的洞)
        poly.forEach((ring) => {
            // 3. 遍历环上的每一个顶点 p (p[0] 是 x, p[1] 是 y)
            ring.forEach((p) => {
                // 不断打擂台，更新最小的 X/Y 和最大的 X/Y
                // 如果是第一个点 (undefined)，则直接赋值；否则使用 Math.min/max 比较
                x1 = x1 === undefined ? p[0] : Math.min(x1, p[0]);
                y1 = y1 === undefined ? p[1] : Math.min(y1, p[1]);
                x2 = x2 === undefined ? p[0] : Math.max(x2, p[0]);
                y2 = y2 === undefined ? p[1] : Math.max(y2, p[1]);
            });
        });
    });

    // 防御性编程：如果传进来的是一个空的 MultiPolygon，抛出错误
    if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
        throw new Error('empty MultiPolygon');
    }

    // 构建基础的坐标包围盒对象
    const bounds: TCoordinateBounds = {
        type: 'coordinate',
        x1,
        y1,
        x2,
        y2,
    };

    // 如果调用方请求的是 'index' (像素数组索引，通常要求是整数)，则进行转换后返回
    // 否则直接返回算好的坐标包围盒
    return (type === 'index' ? coordinateBoundsToIndexBounds(bounds) : bounds) as T extends 'index'
        ? TIndexBounds
        : TCoordinateBounds;
}
