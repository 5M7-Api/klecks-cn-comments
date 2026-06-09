import { MultiPolygon, Pair } from 'polygon-clipping';
import { applyToPoint, Matrix } from 'transformation-matrix';

// 将多边形集合中的每个环中的每个顶点应用到变换矩阵上，返回一个新的多边形集合。
export function transformMultiPolygon(multiPolygon: MultiPolygon, transform: Matrix): MultiPolygon {
    // 多边形集合
    return multiPolygon.map((poly) => {
        // 环集合：图形学中，一个多边形由“一个外环”和“零个或多个内环（破洞）”组成。比如你画了一个甜甜圈形状的选区，外圈是一个环，内圈的洞也是一个环。
        return poly.map((ring) => {
            // 每个环是由无数个相连的顶点构成的
            return ring.map((point) => {
                return Object.values(applyToPoint(transform, { x: point[0], y: point[1] })) as Pair;
            });
        });
    });
}
