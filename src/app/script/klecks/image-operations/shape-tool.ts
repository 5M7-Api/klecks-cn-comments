import { BB } from '../../bb/bb';
import { TRgb, TShapeToolObject } from '../kl-types';
import { TCoordinateBounds, TIndexBounds, TRect, TVector2D } from '../../bb/bb-types';
import { transformCoordinateBounds } from '../../bb/transform/transform-coordinate-bounds';
import { compose, rotate } from 'transformation-matrix';
import { matrixToTuple } from '../../bb/math/matrix-to-tuple';
import { coordinateBoundsToIndexBounds } from '../../bb/math/math';

/**
 * 形状工具的输入处理器 (状态机)
 * 作用：记录用户鼠标按下的起点(downX, downY)，并在拖拽和松开时，将起点和终点一并传给外部的回调函数。
 */
/**
 * Input processor for shape tool.
 * Coordinates are in canvas space.
 * angleRad is the angle of the canvas.
 */
export class ShapeTool {
    private readonly onShape: (
        isDone: boolean,
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        angleRad: number,
    ) => void;
    private downX: number = 0;
    private downY: number = 0;
    private downAngleRad: number = 0; // 记录按下时画布的全局旋转角度

    // ----------------------------------- public -----------------------------------
    constructor(p: {
        onShape: (
            isDone: boolean,
            x1: number,
            y1: number,
            x2: number,
            y2: number,
            angleRad: number,
        ) => void;
    }) {
        this.onShape = p.onShape;
    }

    onDown(x: number, y: number, angleRad: number): void {
        this.downX = x;
        this.downY = y;
        this.downAngleRad = angleRad;
    }

    onMove(x: number, y: number): void {
        // 拖拽中，isDone = false，通常用于在临时图层上渲染预览
        this.onShape(false, this.downX, this.downY, x, y, this.downAngleRad);
    }

    onUp(x: number, y: number): void {
        // 绘制完成，isDone = true，将形状固化到真实图层并生成历史记录
        this.onShape(true, this.downX, this.downY, x, y, this.downAngleRad);
    }
}

/**
 * 【核心渲染函数】：在 Canvas 上绘制几何形状
 * 它不仅要画出图形，还要精确计算出该图形影响的包围盒(Bounds)返回给历史记录系统。
 */
/**
 * Draw a shape (rectangle, ellipse, line)
 */
export function drawShape(
    ctx: CanvasRenderingContext2D,
    shapeObj: TShapeToolObject,
    selectionPath?: Path2D,
): TIndexBounds {
    // 1. 补全默认属性
    shapeObj = {
        // defaults
        angleRad: 0,
        isOutwards: false,
        opacity: 1,
        isEraser: false,
        doLockAlpha: false,

        ...BB.copyObj(shapeObj),
    };
    let bounds: TCoordinateBounds = { type: 'coordinate', x1: 0, y1: 0, x2: 0, y2: 0 };

    if (['rect', 'ellipse', 'line'].includes(shapeObj.type)) {
        if (shapeObj.angleRad === undefined) {
            throw new Error('angleRad undefined');
        }

        const lineWidth = shapeObj.lineWidth === undefined ? -1 : Math.round(shapeObj.lineWidth);
        const angleDeg = (shapeObj.angleRad * 180) / Math.PI;

        // --- prep color ---
        if (
            !shapeObj.isEraser &&
            shapeObj.fillRgb === undefined &&
            shapeObj.strokeRgb === undefined
        ) {
            throw new Error('fillRgb and strokeRgb undefined');
        }
        // 2. 颜色预处理 (如果是橡皮擦模式，强行设为白色，因为实际生效的是混合模式 destination-out)
        const colorRgb: TRgb = shapeObj.isEraser
            ? { r: 255, g: 255, b: 255 }
            : shapeObj.fillRgb
              ? shapeObj.fillRgb
              : shapeObj.strokeRgb!;

        // 3. Canvas 渲染环境准备
        // --- prep canvas ---
        ctx.save();
        // 选区蒙版
        selectionPath && ctx.clip(selectionPath);
        if (shapeObj.opacity) {
            ctx.globalAlpha = shapeObj.opacity;
        }
        if (shapeObj.isEraser) {
            ctx.globalCompositeOperation = 'destination-out';
        }
        if (shapeObj.doLockAlpha) {
            ctx.globalCompositeOperation = 'source-atop';
        }

        // 抵消整个画板的全局旋转，确保用户在旋转画板后，画出的水平线依然是“视觉水平”的
        const transformation = compose(rotate(-shapeObj.angleRad));
        ctx.setTransform(...matrixToTuple(transformation));

        if (shapeObj.fillRgb) {
            ctx.fillStyle = BB.ColorConverter.toRgbStr(colorRgb);
        } else if (shapeObj.strokeRgb) {
            ctx.strokeStyle = BB.ColorConverter.toRgbStr(colorRgb);
            ctx.lineWidth = lineWidth;
        }

        let x1 = shapeObj.x1;
        let y1 = shapeObj.y1;
        let x2 = shapeObj.x2;
        let y2 = shapeObj.y2;

        // ==========================================
        // 修饰符 1：角度吸附 (按住 Shift 画直线)
        // 将自由角度强行吸附到 45度、90度 等整数倍角度上
        // ==========================================
        // --- angle snapping ---
        if (shapeObj.isAngleSnap) {
            const r1 = BB.rotate(x1, y1, (shapeObj.angleRad / Math.PI) * 180);
            const r2 = BB.rotate(x2, y2, (shapeObj.angleRad / Math.PI) * 180);

            const pAngleDeg = BB.pointsToAngleDeg(r1, r2) + 90;
            const pAngleDegSnapped = Math.round(pAngleDeg / 45) * 45;
            // 绕起点旋转终点坐标
            const rotated = BB.rotateAround(
                { x: x1, y: y1 },
                { x: x2, y: y2 },
                pAngleDegSnapped - pAngleDeg,
            );
            x2 = rotated.x;
            y2 = rotated.y;

            // 微调：消除浮点数计算带来的极微小误差，强制正交
            // needs to be perfect if p1->p2 aligns with canvas x- or y-axis
            if ((angleDeg + pAngleDegSnapped) % 90 === 0) {
                if (Math.round((angleDeg - pAngleDegSnapped) / 90) % 2 === 0) {
                    // up or down
                    x2 = x1;
                } else {
                    // left or right
                    y2 = y1;
                }
            }
        }

        let x = x1;
        let y = y1;
        let dX = x2 - x1;
        let dY = y2 - y1;

        // ==========================================
        // 修饰符 2：等比缩放 (按住 Shift 画正方形/正圆)
        // 比较宽和高，取绝对值较小的一方，强制作为另一方的长度
        // ==========================================
        // --- 1:1 ratio ---
        if (shapeObj.type !== 'line' && shapeObj.isFixedRatio) {
            let r1 = BB.rotate(shapeObj.x1, shapeObj.y1, (shapeObj.angleRad / Math.PI) * 180);
            let r2 = BB.rotate(shapeObj.x2, shapeObj.y2, (shapeObj.angleRad / Math.PI) * 180);

            const rx = r1.x;
            const ry = r1.y;
            let rdX = r2.x - r1.x;
            let rdY = r2.y - r1.y;

            if (Math.abs(rdX) < Math.abs(rdY)) {
                rdY = Math.abs(rdX) * (rdY < 0 ? -1 : 1);
            } else {
                rdX = Math.abs(rdY) * (rdX < 0 ? -1 : 1);
            }
            r2.x = rx + rdX;
            r2.y = ry + rdY;

            r1 = BB.rotate(r1.x, r1.y, (-shapeObj.angleRad / Math.PI) * 180);
            r2 = BB.rotate(r2.x, r2.y, (-shapeObj.angleRad / Math.PI) * 180);

            x1 = r1.x;
            y1 = r1.y;
            x2 = r2.x;
            y2 = r2.y;

            x = x1;
            y = y1;
            dX = x2 - x1;
            dY = y2 - y1;
        }

        // ==========================================
        // 修饰符 3：从中心绘制 (按住 Alt)
        // 起点 x1 不再是左上角，而是中心点。原先的宽高 dX, dY 直接翻倍。
        // ==========================================
        // outwards modifier
        if (shapeObj.isOutwards) {
            x -= dX;
            y -= dY;
            dX *= 2;
            dY *= 2;

            x1 = x;
            y1 = y;
            x2 = x + dX;
            y2 = y + dY;
        }

        let p1;
        let p2;
        if (shapeObj.type === 'line') {
            // ==========================================
            // 【黑魔法：0.5像素偏移消除模糊】
            // 浏览器 Canvas 画线是“居中绘制”的。如果画一根 1px 的线在 x=10。
            // 它会占据 9.5 到 10.5 的空间。由于屏幕没有半个像素，浏览器会把它模糊成 2 像素宽的灰色线。
            // 解决方案：如果线宽是奇数，必须强行给坐标加上 0.5 (让线落在 9.5，从而渲染在 9.0~10.0，完美占据 1 个物理像素)。
            // ==========================================
            // --- line ---
            // rounded
            const x1r = Math.round(x1);
            const y1r = Math.round(y1);
            const x2r = Math.round(x2);
            const y2r = Math.round(y2);

            // floored
            const x1f = Math.floor(x1);
            const y1f = Math.floor(y1);
            const x2f = Math.floor(x2);
            const y2f = Math.floor(y2);
            
            // 线宽是偶数 (如 2px)：直接用整数坐标，(x-1 到 x+1) 刚好完美对齐像素网格
            // 作者在这里写了极其冗长的 if-else，全是为了判断当前画的是水平线还是垂直线，并给予最严谨的取整补偿。
            if (lineWidth % 2 === 0) {
                if (y1r === y2r) {
                    p1 = {
                        x: x1f,
                        y: y1r,
                    };
                    p2 = {
                        x: x2f,
                        y: y2r,
                    };

                    if (x1f < x2f) {
                        p2.x += 1;
                    } else {
                        p1.x += 1;
                    }
                } else if (x1r === x2r) {
                    p1 = {
                        x: x1r,
                        y: y1f,
                    };
                    p2 = {
                        x: x2r,
                        y: y2f,
                    };

                    if (y1f < y2f) {
                        p2.y += 1;
                    } else {
                        p1.y += 1;
                    }
                } else {
                    p1 = {
                        x: x1,
                        y: y1,
                    };
                    p2 = {
                        x: x2,
                        y: y2,
                    };
                }
            } else {
                // 线宽是奇数 (如 1px, 3px)
                p1 = {
                    x: x1f,
                    y: y1f,
                };
                p2 = {
                    x: x2f,
                    y: y2f,
                };
                if (y1f === y2f) {
                    // Y 坐标强制加上 0.5 解决模糊
                    if (x1f < x2f) {
                        p2.x += 1;
                    } else {
                        p1.x += 1;
                    }
                    p1.y += 0.5;
                    p2.y += 0.5;
                } else if (x1f === x2f) {
                    // X 坐标强制加上 0.5 解决模糊
                    if (y1f < y2f) {
                        p2.y += 1;
                    } else {
                        p1.y += 1;
                    }
                    p1.x += 0.5;
                    p2.x += 0.5;
                } else {
                    p1.x = x1;
                    p1.y = y1;
                    p2.x = x2;
                    p2.y = y2;
                }
            }

            // 计算包围盒 (考虑线宽)
            bounds = {
                type: 'coordinate',
                x1: Math.min(p1.x, p2.x) - lineWidth / 2,
                y1: Math.min(p1.y, p2.y) - lineWidth / 2,
                x2: Math.max(p1.x, p2.x) + lineWidth / 2,
                y2: Math.max(p1.y, p2.y) + lineWidth / 2,
            };

            p1 = BB.rotate(p1.x, p1.y, (shapeObj.angleRad / Math.PI) * 180);
            p2 = BB.rotate(p2.x, p2.y, (shapeObj.angleRad / Math.PI) * 180);

            // 执行绘制
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
        } else if (shapeObj.type === 'rect') {
            // ... (同理，矩形绘制为了保证边缘锐利，也做了详尽的 0.5 像素和偶数线宽补偿) ...
            // --- rect ---

            // floored
            const x1f = Math.floor(x1);
            const y1f = Math.floor(y1);
            const x2f = Math.floor(x2);
            const y2f = Math.floor(y2);

            if (angleDeg % 90 === 0) {
                if (shapeObj.fillRgb) {
                    if (x1 % 1 === 0) {
                        x1 += 1;
                    }
                    if (y1 % 1 === 0) {
                        y1 += 1;
                    }
                    if (x2 % 1 === 0) {
                        x2 += 1;
                    }
                    if (y2 % 1 === 0) {
                        y2 += 1;
                    }

                    p1 = {
                        x: x1 < x2 ? x1f : x2f,
                        y: y1 < y2 ? y1f : y2f,
                    };
                    p2 = {
                        x: Math.ceil((x1 < x2 ? x2 : x1) - p1.x),
                        y: Math.ceil((y1 < y2 ? y2 : y1) - p1.y),
                    };
                    p2.x = p1.x + p2.x;
                    p2.y = p1.y + p2.y;
                } else {
                    if (lineWidth % 2 === 0) {
                        p1 = {
                            x: x1f,
                            y: y1f,
                        };
                        p2 = {
                            x: x2f,
                            y: y2f,
                        };
                    } else {
                        p1 = {
                            x: x1f + 0.5,
                            y: y1f + 0.5,
                        };
                        p2 = {
                            x: x2f + 0.5,
                            y: y2f + 0.5,
                        };
                    }
                }
            } else {
                p1 = {
                    x: x1,
                    y: y1,
                };
                p2 = {
                    x: x2,
                    y: y2,
                };
            }

            p1 = BB.rotate(p1.x, p1.y, (shapeObj.angleRad / Math.PI) * 180);
            p2 = BB.rotate(p2.x, p2.y, (shapeObj.angleRad / Math.PI) * 180);
            const rect: TRect = {
                x: p1.x,
                y: p1.y,
                width: p2.x - p1.x,
                height: p2.y - p1.y,
            };

            const padding = shapeObj.fillRgb ? 0 : lineWidth / 2;
            bounds = transformCoordinateBounds(
                {
                    type: 'coordinate',
                    x1: Math.min(p1.x, p2.x) - padding,
                    y1: Math.min(p1.y, p2.y) - padding,
                    x2: Math.max(p1.x, p2.x) + padding,
                    y2: Math.max(p1.y, p2.y) + padding,
                },
                transformation,
            );

            if (shapeObj.fillRgb) {
                ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
            } else {
                ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
            }
        } else {
            // --- 椭圆 (ellipse) ---
            // 直接通过中心点 (x+dx/2, y+dy/2) 和 半径 rX, rY 绘制
            // --- circle ---
            p1 = BB.rotate(x1, y1, (shapeObj.angleRad / Math.PI) * 180);
            p2 = BB.rotate(x2, y2, (shapeObj.angleRad / Math.PI) * 180);
            x = p1.x;
            y = p1.y;
            dX = p2.x - p1.x;
            dY = p2.y - p1.y;
            const center: TVector2D = {
                x: x + dX / 2,
                y: y + dY / 2,
            };
            const rX = Math.abs(dX / 2);
            const rY = Math.abs(dY / 2);

            ctx.beginPath();
            ctx.ellipse(center.x, center.y, rX, rY, 0, 0, Math.PI * 2);
            if (shapeObj.fillRgb) {
                ctx.fill();
            } else {
                ctx.stroke();
            }

            // 椭圆的包围盒计算比较简单，直接用中心点加减半径即可
            const padding = shapeObj.fillRgb ? 0 : lineWidth / 2;
            // bounds are bigger than they need to be when it's rotated and rX ~ rY. should be good enough though.
            bounds = transformCoordinateBounds(
                {
                    type: 'coordinate',
                    x1: center.x - rX - padding,
                    y1: center.y - rY - padding,
                    x2: center.x + rX + padding,
                    y2: center.y + rY + padding,
                },
                // 如果画布旋转了，包围盒也要跟着旋转变形
                transformation,
            );
        }

        ctx.restore();
    } else {
        throw new Error('unknown shape');
    }

    // 坐标空间转换：把物理坐标系包围盒转化为索引包围盒，供后续历史记录使用
    return coordinateBoundsToIndexBounds(bounds);
}
