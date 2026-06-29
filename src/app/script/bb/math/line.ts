import { Vec2 } from './vec2';
import { clamp, dist, mix, pointsToAngleDeg } from './math';
import { TVector2D } from '../bb-types';
import { copyObj } from '../base/base';

/**
 * project p onto line
 * @param lineStart
 * @param lineEnd
 * @param p
 */
export const projectPointOnLine = function (
    lineStart: TVector2D,
    lineEnd: TVector2D,
    p: TVector2D,
): TVector2D {
    let x, y;
    if (lineStart.x === lineEnd.x) {
        x = lineStart.x;
        y = p.y;

        return {
            x: x,
            y: y,
        };
    }
    const m = (lineEnd.y - lineStart.y) / (lineEnd.x - lineStart.x);
    const b = lineStart.y - m * lineStart.x;

    x = (m * p.y + p.x - m * b) / (m * m + 1);
    y = (m * m * p.y + m * p.x + b) / (m * m + 1);

    return {
        x: x,
        y: y,
    };
};

// 对由多个离散点组成的连线/折线进行操作
/**
 * Operations on a line made up of points
 */
export class PointLine {
    // 核心数据结构：存储每个点的坐标，以及该点到“下一个点”的物理长度
    private readonly segmentArr: {
        x: number;
        y: number;
        // 距离下一个点的长度 (最后一个点的 length 恒为 0)
        length: number; // last is 0
    }[];

    // ----------------------------------- public -----------------------------------
    /**
     * 构造函数：接收一个点集（例如被切分成 20 段的贝塞尔曲线点集）
     */
    constructor(p: { points: TVector2D[] }) {
        this.segmentArr = [];

        for (let i = 0; i < p.points.length; i++) {
            // 这里使用立即执行函数 (IIFE) 主要是早期 JS 保留变量作用域的习惯，
            // 确保 i 的值在循环中被正确捕获。
            ((i) => {
                let length = 0;
                // 如果当前点不是最后一个点，计算它到下一个点的直线距离
                if (i < p.points.length - 1) {
                    length = dist(
                        p.points[i].x,
                        p.points[i].y,
                        p.points[i + 1].x,
                        p.points[i + 1].y,
                    );
                }
                // 将坐标和计算出的线段长度存入数组
                this.segmentArr[i] = {
                    x: p.points[i].x,
                    y: p.points[i].y,
                    length: length,
                };
            })(i);
        }
    }

    // ---- interface ----

    /**
     * 核心方法：沿着折线行走指定的物理距离（dist），返回停下位置的精确坐标
     * returns point when traveling *dist* along the line, > 0
     * @param dist 要行走的物理像素距离
     */
    /**
     * returns point when traveling *dist* along the line, > 0
     * @param dist
     */
    getAtDist(dist: number): TVector2D {
        // remainder 表示“还剩下多少距离需要走”。
        // Math.min 确保如果传入的距离超出了总长度，最多只会走到终点。
        let remainder = Math.min(this.getLength(), dist);
        let i = 0;

        // 1. 寻找目标距离落在哪个线段区间内：
        // 如果剩余距离大于当前线段的长度，说明目标还在更后面。
        // 就扣除当前线段的长度，并将索引 i 移到下一段，直到剩余距离不足以跨越当前线段。
        // 条件 i < ...length - 2 确保不会越界到最后一个没有下一段长度的点。
        for (; remainder > this.segmentArr[i].length && i < this.segmentArr.length - 2; i++) {
            remainder -= this.segmentArr[i].length;
        }

        // 2. 计算在目标线段上的百分比进度 (0.0 到 1.0 之间)
        // fac = (剩下要走的距离) / (当前这段线段的总长度)
        const fac = Math.min(1, Math.max(0, remainder / this.segmentArr[i].length));

        // 3. 线性插值 (Linear Interpolation) 算出最终精确坐标：
        // 公式： 起点坐标 * (1 - 进度) + 终点坐标 * 进度
        return {
            x: this.segmentArr[i].x * (1 - fac) + this.segmentArr[i + 1].x * fac,
            y: this.segmentArr[i].y * (1 - fac) + this.segmentArr[i + 1].y * fac,
        };
    }

    // 获取整条折线的物理总长度
    /**
     * total length of line
     */
    getLength(): number {
        let result = 0;
        // 累加所有小线段的长度（跳过最后一个点，因为它的 length 是 0）
        for (let i = 0; i < this.segmentArr.length - 1; i++) {
            result += this.segmentArr[i].length;
        }
        return result;
    }
}

export type TBezierLineCallback = (v: {
    x: number;
    y: number;
    t: number; // [0, 1] - how far along
    angle?: number;
    dAngle: number;
}) => void;
type TBezierLineControlsCallback = (v: {
    p1: TVector2D;
    p2: TVector2D;
    p3: TVector2D;
    p4: TVector2D;
}) => void;

type TBezierLinePoint = {
    x: number;
    y: number;
    spacing: number;
    dir: TVector2D;
};

// 每个实例代表一条由贝塞尔插值段组成的线。你只需不断喂给它坐标点，它会自动计算控制点并生成平滑曲线。
/**
 * Each instance is one line made up of bezier interpolated segments.
 * You feed it points. It calculates control points on its own, and the resulting curve.
 */
export class BezierLine {
    // 存储用户输入的原始轨迹点
    private readonly pointArr: TBezierLinePoint[];
    // 记录上一段曲线末尾“剩余未走完”的距离，用于无缝衔接下一段的笔刷间距
    private lastDot: number = 0;
    // 记录最后一次输入的坐标，用于去重
    private lastPoint: TVector2D | undefined;
    // 记录上一次真实“盖下笔刷印章”的坐标
    private lastCallbackPoint: TVector2D | undefined;
    // 记录笔刷的角度
    private lastAngle: number | undefined;
    // 记录当前的笔刷间距（支持压感动态改变间距）
    private lastSpacing: number | undefined;

    /**
     * 根据4个控制点生成三次贝塞尔曲线的点集
     * @param p1 - 起点
     * @param p2 - 控制点 1
     * @param p3 - 控制点 2
     * @param p4 - 终点
     * @param resolution - 分辨率（插值细分次数）
     * @returns 构成这条曲线的坐标点数组
     */
    /**
     * creates bezier curve from control points
     * @param p1 - control point 1 {x: float, y: float}
     * @param p2 - control point 2 {x: float, y: float}
     * @param p3 - control point 3 {x: float, y: float}
     * @param p4 - control point 4 {x: float, y: float}
     * @param resolution - int
     * @returns bezier curve made up of points {x: float, y: float}
     */
    private getBezierPoints(
        p1: TVector2D,
        p2: TVector2D,
        p3: TVector2D,
        p4: TVector2D,
        resolution: number,
    ): TVector2D[] {
        const curvePoints = [];
        let t;
        for (let i = 0; i <= resolution; i++) {
            t = i / resolution;
            // 标准的三次贝塞尔曲线公式
            curvePoints[curvePoints.length] = {
                x:
                    Math.pow(1 - t, 3) * p1.x +
                    3 * Math.pow(1 - t, 2) * t * p2.x +
                    3 * (1 - t) * Math.pow(t, 2) * p3.x +
                    Math.pow(t, 3) * p4.x,
                y:
                    Math.pow(1 - t, 3) * p1.y +
                    3 * Math.pow(1 - t, 2) * t * p2.y +
                    3 * (1 - t) * Math.pow(t, 2) * p3.y +
                    Math.pow(t, 3) * p4.y,
            };
        }
        return curvePoints;
    }

    // ----------------------------------- public -----------------------------------
    constructor() {
        this.pointArr = [];
    }

    // ---- interface ----

    /**
     * 接收鼠标/画笔的新坐标点。
     * 注意：由于需要计算切线，实际“画出”的曲线会比你输入的点滞后一个线段。
     * @param x - 新点的 x 坐标
     * @param y - 新点的 y 坐标
     * @param spacing - 笔刷印章之间的间隔距离
     * @param callback - 每当到了需要盖一个印章的距离时，触发此回调（传递坐标、角度等让外部绘图）
     * @param controlsCallback - 仅在不需要连续盖章（不传callback）时，将算好的贝塞尔4个点直接抛出
     */
    /**
     * Add new point to line. "Drawn" line will go until the previous point.
     *
     * @param x - coord of new point
     * @param y
     * @param spacing - space between each step
     * @param callback - calls for each step
     * @param controlsCallback - calls that callback with the bezier control points
     */
    add(
        x: number,
        y: number,
        spacing: number,
        callback?: TBezierLineCallback,
        controlsCallback?: TBezierLineControlsCallback,
    ): void {
        // 1. 去重：如果鼠标没动，直接忽略
        if (this.lastPoint && x === this.lastPoint.x && y === this.lastPoint.y) {
            return;
        }
        this.lastPoint = { x, y };
        this.pointArr[this.pointArr.length] = {
            x,
            y,
            spacing,
        } as TBezierLinePoint;

        // 2. 计算方向（切线）。这是 Catmull-Rom 样条的核心：
        // 一个点的切线方向，平行于它前一个点到后一个点的连线。
        //calculate directions
        if (this.pointArr.length === 1) {
            this.lastSpacing = spacing;
            // 只有一个点，无法画线，直接返回等待
            return;
        } else if (this.pointArr.length === 2) {
            // 只有两个点，切线方向就是两点的连线方向
            this.pointArr[0].dir = Vec2.nor(Vec2.sub(this.pointArr[1], this.pointArr[0]));
            this.lastDot = spacing;
            this.lastSpacing = spacing;
            // 依然等待下一个点，以便确定终点的切线
            return;
        } else {
            // 当有3个或以上点时，计算【倒数第二个点】的切线方向
            const pointM1 = this.pointArr[this.pointArr.length - 1];
            const pointM2 = this.pointArr[this.pointArr.length - 2];
            const pointM3 = this.pointArr[this.pointArr.length - 3];
            // B 点的切线方向 = A 指向 C 的单位向量
            pointM2.dir = Vec2.nor(Vec2.sub(pointM1, pointM3));
            if (isNaN(pointM2.dir.x) || isNaN(pointM2.dir.y)) {
                // B 点的切线方向 = A 指向 C 的单位向量
                //when xy -3 == -1
                pointM2.dir = copyObj(pointM3.dir);
            }
        }

        // 3. 将前面计算的端点和切线，转化为三次贝塞尔曲线的 4 个控制点
        //get bezier curve
        const a = this.pointArr[this.pointArr.length - 3];// 绘制起点
        const b = this.pointArr[this.pointArr.length - 2];// 绘制终点
        const p1 = a;
        // p2: 从起点顺着切线延伸一定长度 (距离的 1/4 作为控制柄强度)
        const p2 = Vec2.add(a, Vec2.mul(a.dir, Vec2.dist(a, b) / 4));
        // p3: 从终点逆着切线反向延伸一定长度
        const p3 = Vec2.sub(b, Vec2.mul(b.dir, Vec2.dist(a, b) / 4));
        const p4 = b;

        // 4. 将贝塞尔曲线转换为方便测量物理长度的 PointLine
        let pointLine: PointLine;
        if (callback) {
            // 如果需要进行笔刷盖章，生成20段细分多边形来逼近曲线
            const curvePoints = this.getBezierPoints(p1, p2, p3, p4, 20);
            pointLine = new PointLine({ points: curvePoints });
        } else {
            // 如果外部只是要控制点，退化为两点直线（省性能）
            pointLine = new PointLine({ points: [p1, p4] });
        }

        // 5. 核心循环：沿着曲线物理长度（弧长）进行绝对等距遍历（盖章）
        //iterate over curve with spacing and callback
        const len = pointLine.getLength(); // 这段曲线的实际物理像素长度
        // 动态混合前后的笔刷间距 (支持压感控制笔刷间距的情况)
        let tempSpacing = mix(this.lastSpacing!, spacing, clamp(this.lastDot / len, 0, 1));
        // d 代表当前要盖章的位置，初始值为上一段曲线结尾“多出来”的残余距离
        let d = this.lastDot;
        // 当距离 d 没有超过曲线总长时，不断盖章
        for (; d <= len; d += tempSpacing) {
            tempSpacing = mix(this.lastSpacing!, spacing, clamp(d / len, 0, 1));
            // 获取距离起点 d 像素的精确坐标
            const point = pointLine.getAtDist(d);
            // 计算当前画笔应有的旋转角度
            const angle = this.lastCallbackPoint
                ? pointsToAngleDeg(this.lastCallbackPoint, point)
                : undefined;
            if (callback) {
                // 触发外部的回调函数（外部会在这个 x,y 坐标处使用 canvas api 画上笔尖的印章）
                callback({
                    x: point.x,
                    y: point.y,
                    t: d / len,
                    angle: angle,
                    dAngle: this.lastCallbackPoint ? angle! - this.lastAngle! : 0,
                });
            }
            this.lastCallbackPoint = point;
            this.lastAngle = angle;
        }

        // 6. 状态保留
        if (callback) {
            // 记录下本次走到最后，距离终点还差多少距离（结转给下一个线段）
            this.lastDot = d - len;
        } else {
            this.lastDot = 0;
            controlsCallback?.({ p1: p1, p2: p2, p3: p3, p4: p4 });
        }

        this.lastSpacing = spacing;
    }

    /**
     * 当用户抬起手写笔（结束绘制）时调用。
     * 因为平滑算法总是“慢一拍”，此时还有最后一段线段没有画出。
     * 这里的逻辑是顺着最后一个点的方向，凭空“伪造”延伸出一个新点，
     * 以便把遗留的最后一段线强行 flush 画出来。
     */
    addFinal(
        spacing: number,
        callback?: TBezierLineCallback,
        controlsCallback?: TBezierLineControlsCallback,
    ): void {
        if (this.pointArr.length < 2) {
            return;
        }

        const p1 = this.pointArr[this.pointArr.length - 2];
        const p2 = this.pointArr[this.pointArr.length - 1];

        // 按照最后两点的惯性方向，外推一个新点 newP
        const newP = Vec2.add(p2, Vec2.sub(p2, p1));

        // 传入这个虚拟点，触发最后一段积压曲线的绘制
        this.add(newP.x, newP.y, spacing, callback, controlsCallback);
    }
}

export type TSplineInputPoints = [number, number][]; // [x, y]

/**
 * from SplineInterpolator.cs in the Paint.NET source code
 */
export class SplineInterpolator {
    private readonly xa: number[];
    private readonly ya: number[];
    private readonly u: number[];
    private readonly y2: number[];
    private readonly first: number;
    private readonly last: number;

    // ----------------------------------- public -----------------------------------
    constructor(points: TSplineInputPoints) {
        const n = points.length;
        this.xa = [];
        this.ya = [];
        this.u = [];
        this.y2 = [];
        let i;

        this.first = points[0][0];
        this.last = points[points.length - 1][0];

        points.sort(function (a, b) {
            return a[0] - b[0];
        });
        for (i = 0; i < n; i++) {
            this.xa.push(points[i][0]);
            this.ya.push(points[i][1]);
        }

        this.u[0] = 0;
        this.y2[0] = 0;

        for (i = 1; i < n - 1; ++i) {
            // This is the decomposition loop of the tridiagonal algorithm.
            // y2 and u are used for temporary storage of the decomposed factors.
            const wx = this.xa[i + 1] - this.xa[i - 1];
            const sig = (this.xa[i] - this.xa[i - 1]) / wx;
            const p = sig * this.y2[i - 1] + 2.0;

            this.y2[i] = (sig - 1.0) / p;

            const ddydx =
                (this.ya[i + 1] - this.ya[i]) / (this.xa[i + 1] - this.xa[i]) -
                (this.ya[i] - this.ya[i - 1]) / (this.xa[i] - this.xa[i - 1]);

            this.u[i] = ((6.0 * ddydx) / wx - sig * this.u[i - 1]) / p;
        }

        this.y2[n - 1] = 0;

        // This is the backsubstitution loop of the tridiagonal algorithm
        for (i = n - 2; i >= 0; --i) {
            this.y2[i] = this.y2[i] * this.y2[i + 1] + this.u[i];
        }
    }

    // ---- interface ----

    getFirstX(): number {
        return this.first;
    }

    getLastX(): number {
        return this.last;
    }

    interpolate(x: number): number {
        const n = this.ya.length;
        let klo = 0;
        let khi = n - 1;

        // We will find the right place in the table by means of
        // bisection. This is optimal if sequential calls to this
        // routine are at random values of x. If sequential calls
        // are in order, and closely spaced, one would do better
        // to store previous values of klo and khi.
        while (khi - klo > 1) {
            const k = (khi + klo) >> 1;

            if (this.xa[k] > x) {
                khi = k;
            } else {
                klo = k;
            }
        }

        const h = this.xa[khi] - this.xa[klo];
        const a = (this.xa[khi] - x) / h;
        const b = (x - this.xa[klo]) / h;

        // Cubic spline polynomial is now evaluated.
        return (
            a * this.ya[klo] +
            b * this.ya[khi] +
            (((a * a * a - a) * this.y2[klo] + (b * b * b - b) * this.y2[khi]) * (h * h)) / 6.0
        );
    }

    /**
     * find x to y. simply by stepping through. suboptimal, so don't call often.
     * searches in x 0-1 range
     */
    findX(y: number, resolution: number): number | undefined {
        let x;
        let dist: number;
        for (let i = 0; i <= resolution; i++) {
            const tempX = i / resolution;
            const tempY = this.interpolate(tempX);
            if (x === undefined) {
                x = tempX;
                dist = Math.abs(tempY - y);
                continue;
            }

            const tempDist = Math.abs(tempY - y);

            if (tempDist < dist!) {
                x = tempX;
                dist = tempDist;
            } else {
                //distance increasing
                break;
            }
        }
        return x;
    }
}

/**
 * input for a spline, following curve of a power function x^n [0 - 1]
 * returns [[0, startVal], ..., [1, endVal]]
 */
export function powerSplineInput(
    startVal: number,
    endVal: number,
    stepSize: number,
    exponent: number = 2,
): TSplineInputPoints {
    function round(v: number, dec: number): number {
        return Math.round(v * Math.pow(10, dec)) / Math.pow(10, dec);
    }

    const resultArr: TSplineInputPoints = [];
    for (let i = 0; i <= 1; i += stepSize) {
        resultArr.push([
            round(i, 4),
            round(startVal + Math.pow(i, exponent) * (endVal - startVal), 4),
        ]);
    }
    return resultArr;
}
