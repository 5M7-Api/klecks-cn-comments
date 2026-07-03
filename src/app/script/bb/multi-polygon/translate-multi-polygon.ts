import { MultiPolygon } from 'polygon-clipping';

/**
 * 【矢量位移引擎】：平移多边形选区
 * 
 * @param poly 传入的矢量多边形集合 (MultiPolygon)
 * @param x 水平方向平移像素
 * @param y 垂直方向平移像素
 */
export function translateMultiPolygon(poly: MultiPolygon, x: number, y: number): MultiPolygon {
    // !【数据解构细节】：
    // polygon-clipping 库中的 MultiPolygon 是一个四维数组：
    // MultiPolygon = Polygon[]
    //   Polygon = Ring[]     (第一个 Ring 是外轮廓，后续的 Ring 是内凹的“孔洞”)
    //     Ring = Point[]     (顶点数组)
    //       Point = [x, y]   (二维坐标点)

    // 1. 第一层 map：遍历所有的多边形 (Polygons)
    // 应对场景：用户在画布上画了多个互不相交的“散落选区”（比如按住 Shift 圈了多个地方）
    return poly.map((poly) => {
        // 2. 第二层 map：遍历多边形内部的环 (Rings)
        // 应对场景：一个连通选区内有外框和镂空的“内环洞”（比如一个甜甜圈形状的选区，外圈是 Ring[0]，内圈孔洞是 Ring[1]）
        return poly.map((ring) => {
            // 3. 第三层 map：遍历环上的每一个顶点 (Points)
            return ring.map((p) => {
                // 4. 将每一个顶点的 X 和 Y 坐标进行物理偏移，返回全新的坐标对
                // [p[0] + x, p[1] + y]
                // 这样后续进行选区加减、布尔相交时，物理坐标才能在数学层完全对齐
                return [p[0] + x, p[1] + y];
            });
        });
    });
}
