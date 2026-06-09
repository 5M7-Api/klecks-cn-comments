import * as polygonClipping from 'polygon-clipping';
import { Geom, MultiPolygon, Ring } from 'polygon-clipping';

// 单纯防止程序崩溃
// wrapper to catch errors, and offer fallback
export function applyPolygonClipping(
    operation: 'intersection' | 'xor' | 'union' | 'difference',
    geom: Geom,
    ...geoms: Geom[]
): MultiPolygon {
    let result: MultiPolygon = []; // initialized with fallback
    try {
        result = polygonClipping[operation](geom, ...geoms);
    } catch (e) {
        /* */
    }
    return result;
}

// 防御性调用，防止程序崩溃
// intersects each ring individually to avoid failing edge cases from clipping the whole multipolygon at once
export function clipMultiPolygon(multiPolygon: MultiPolygon, clip: Ring): MultiPolygon {
    const result: MultiPolygon = [];
    for (const polygon of multiPolygon) {
        // 拆解多边形，以及多边形中的环
        for (const ring of polygon) {
            const clipped = applyPolygonClipping('intersection', [[ring]], [[clip]]);
            for (const poly of clipped) {
                result.push(poly);
            }
        }
    }
    return result;
}
