import { TVector2D } from '../bb-types';

/**
 * 2D 向量 (Vector 2D) 数学工具集
 * 在图形学中，{x, y} 既可以代表一个“绝对坐标点 (Point)”，也可以代表一个“有方向的线段 (Vector)”。
 */
export const Vec2 = {
    /**
     * 向量加法 (Add)
     * 用途：平移一个点。比如你有一个点 p1，想让它向右下角移动 p2 的距离。
     */
    add: function (p1: TVector2D, p2: TVector2D): TVector2D {
        return { x: p1.x + p2.x, y: p1.y + p2.y };
    },
    /**
     * 向量减法 (Subtract)
     * 用途：求两个点之间的“方向向量”。p1 减去 p2，得到的是一个从 p2 指向 p1 的箭头。
     */
    sub: function (p1: TVector2D, p2: TVector2D): TVector2D {
        return { x: p1.x - p2.x, y: p1.y - p2.y };
    },
    /**
     * 向量归一化 (Normalize)
     * 核心逻辑：保持向量的方向不变，但把它的长度强制缩放为 1（变成单位向量）。
     * 用途：通常用来提取“纯粹的方向”。比如画笔前进的方向，不论画笔移动多快，方向向量长度永远是 1。
     * ⚠️ 隐患：这里没有做防零除处理。如果传入 {x:0, y:0}，会导致返回 {x: NaN, y: NaN}。
     */
    nor: function (p: TVector2D): TVector2D {
        const len = Math.sqrt(Math.pow(p.x, 2) + Math.pow(p.y, 2));
        return { x: p.x / len, y: p.y / len };
    },
    /**
     * 获取向量长度 (Length / Magnitude)
     * 核心逻辑：勾股定理 (a² + b² = c²)
     */
    len: function (p: TVector2D): number {
        return Math.sqrt(Math.pow(p.x, 2) + Math.pow(p.y, 2));
    },
    /**
     * 获取两点之间的距离 (Distance)
     * 核心逻辑：先用减法算出它们之间的向量，再求这个向量的长度。
     * 用途：极其高频！画笔连续作画时，如果两个鼠标点距离太近就跳过，距离大于间距 (Spacing) 才画一个笔刷印记。
     */
    dist: function (p1: TVector2D, p2: TVector2D): number {
        return Vec2.len(Vec2.sub(p1, p2));
    },
    /**
     * 向量乘以标量 (Multiply)
     * 核心逻辑：按比例缩放向量。
     * 用途：比如算出了一个单位方向向量 {x: 1, y: 0}，想让它变长 5 倍，就 mul(p, 5)。
     */
    mul: function (p: TVector2D, s: number): TVector2D {
        return { x: p.x * s, y: p.y * s };
    },
    /**
     * 计算 p1 到 p2 的绝对角度 (Angle)
     * 返回值：弧度 (Radians)，范围通常是 -π 到 π。
     * 核心逻辑：Math.atan2 是图形学中最伟大的函数之一，它不仅能算角度，还能自动处理四个象限的符号问题。
     */
    angle: function (p1: TVector2D, p2: TVector2D): number {
        return Math.atan2(p2.y - p1.y, p2.x - p1.x);
    },
    /**
     * 向量点积 (Dot Product)
     * 用途：判断两个向量的方向关系。
     * - 如果点积 > 0：它们大致同向（夹角 < 90度）
     * - 如果点积 = 0：它们绝对垂直（夹角 = 90度）
     * - 如果点积 < 0：它们大致反向（夹角 > 90度）
     */
    dot: function (a: TVector2D, b: TVector2D): number {
        const aArr = [a.x, a.y];
        const bArr = [b.x, b.y];
        return aArr.map((x, i) => aArr[i] * bArr[i]).reduce((m, n) => m + n);
    },
};
