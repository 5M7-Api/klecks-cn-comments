import { TGradient, TRgba } from '../kl-types';
import { BB } from '../../bb/bb';

type TOnGradient = (
    // true 表示鼠标松开，渐变确认；false 表示正在拖拽预览
    isDone: boolean,
    // 起始与结束点
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    // 画布的全局旋转角度
    angleRad: number,
) => void;

/**
 * 渐变工具的输入处理器 (状态机)
 * 作用：记录用户拉渐变的起点，并在拖动时不断触发回调，将实时坐标丢给渲染层。
 */
/**
 * Input processor for gradient tool.
 * Coordinates are in canvas space.
 * angleRad is the angle of the canvas.
 */
export class GradientTool {
    private downX: number = 0;
    private downY: number = 0;
    private downAngleRad: number = 0;
    private readonly onGradient: TOnGradient;

    // ----------------------------------- public -----------------------------------
    constructor(p: { onGradient: TOnGradient }) {
        this.onGradient = p.onGradient;
    }

    onDown(x: number, y: number, angleRad: number): void {
        this.downX = x;
        this.downY = y;
        this.downAngleRad = angleRad;
    }

    onMove(x: number, y: number): void {
        // 拖拽过程中持续触发，通常用于在顶层的临时预览 Canvas 上画出实时渐变效果
        this.onGradient(false, this.downX, this.downY, x, y, this.downAngleRad);
    }

    onUp(x: number, y: number): void {
        // 拖拽结束，正式将渐变印在目标图层上，并触发 Undo 历史记录
        this.onGradient(true, this.downX, this.downY, x, y, this.downAngleRad);
    }
}

/**
 * 【核心渲染函数】：在 Canvas 上绘制渐变
 * 注意：由于渐变通常覆盖全图（即使是径向渐变，外部也会延伸到无限远），
 * 所以这个函数不返回 Bounds（包围盒），上层调用者默认认为它弄脏了整张画布。
 */
export function drawGradient(
    ctx: CanvasRenderingContext2D,
    // 包含起点、终点、颜色、透明度、渐变类型等所有参数
    gradientObj: TGradient,
    // 套索选区路径
    selectionPath?: Path2D,
): void {
    ctx.save();
    // 1. 如果存在选区，将其设定为剪裁蒙版 (Clipping Mask)。渐变不会画到选区外面。
    selectionPath && ctx.clip(selectionPath);

    const x1 = gradientObj.x1;
    const y1 = gradientObj.y1;
    let x2 = gradientObj.x2;
    let y2 = gradientObj.y2;

    // ==========================================
    // 修饰符 1：角度吸附 (按住 Shift 拉渐变)
    // 强行将渐变的方向吸附到 0度、45度、90度 等规范角度上。
    // 这段逻辑与 drawShape 里的直线吸附逻辑完全一致。
    // ==========================================
    if (gradientObj.doSnap) {
        const angleDeg = (gradientObj.angleRad * 180) / Math.PI;

        const r1 = BB.rotate(x1, y1, (gradientObj.angleRad / Math.PI) * 180);
        const r2 = BB.rotate(x2, y2, (gradientObj.angleRad / Math.PI) * 180);

        // 计算当前拉扯的线条与水平线的夹角，并加上 90 度偏移
        const pAngleDeg = BB.pointsToAngleDeg(r1, r2) + 90;
        // 四舍五入到最近的 45 度倍数 (例如：32度会被吸附到 45度，10度会被吸附到 0度)
        const pAngleDegSnapped = Math.round(pAngleDeg / 45) * 45;

        // 将终点坐标 (x2, y2) 绕起点 (x1, y1) 旋转到吸附后的正确位置
        const rotated = BB.rotateAround(
            { x: x1, y: y1 },
            { x: x2, y: y2 },
            pAngleDegSnapped - pAngleDeg,
        );
        x2 = rotated.x;
        y2 = rotated.y;

        // [极度严谨的浮点数补偿]：如果吸附后的线条应该是绝对的水平或垂直，
        // 强行让对应的坐标相等，消除正余弦计算带来的 0.00000001 级别的误差。
        // needs to be perfect if p1->p2 aligns with canvas x- or y-axis
        if ((angleDeg + pAngleDegSnapped) % 90 === 0) {
            // 绝对垂直
            if (Math.round((angleDeg - pAngleDegSnapped) / 90) % 2 === 0) {
                // up or down
                x2 = x1;
            } else {
                // 绝对水平
                // left or right
                y2 = y1;
            }
        }
    }

    // ==========================================
    // 颜色构建 (Color Stops Preparation)
    // 目前 Klecks 的渐变是“前景色到透明 (Foreground to Transparent)”模式
    // ==========================================
    let baseColor = gradientObj.color1;

    // 【橡皮擦模式特殊处理】：
    // 如果是橡皮擦，并且开启了“透明度锁定 (Alpha Lock)”，
    // 必须用纯白色 (255,255,255) 作为基底色，因为稍后会使用 'source-atop' 混合模式。
    if (gradientObj.isEraser && gradientObj.doLockAlpha) {
        baseColor = { r: 255, g: 255, b: 255 };
    }

    // 渐变起点颜色 (带上全局透明度)
    let color1: TRgba = {
        ...baseColor,
        a: gradientObj.opacity,
    };

    // 渐变终点颜色 (完全透明)
    let color2: TRgba = {
        ...baseColor,
        a: 0,
    };

    // 修饰符 2：反向渐变 (透明到前景色)
    if (gradientObj.isReversed) {
        const temp = color1;
        color1 = color2;
        color2 = temp;
    }

    // ==========================================
    // 构建原生 Canvas 渐变对象
    // ==========================================
    let gradient: CanvasGradient;
    if (gradientObj.type === 'linear') {
        // 1. 标准线性渐变
        gradient = ctx.createLinearGradient(x1, y1, x2, y2);
        // 0% 处：颜色1
        gradient.addColorStop(0, BB.ColorConverter.toRgbaStr(color1));
        // 100%处：颜色2
        gradient.addColorStop(1, BB.ColorConverter.toRgbaStr(color2));
    } else if (gradientObj.type === 'linear-mirror') {
        // 2. 镜像线性渐变 (从中心向两边散开，也就是“对称渐变”)
        // 计算从起点到终点的向量偏移 (dx, dy)
        const d = {
            x: x2 - x1,
            y: y2 - y1,
        };
        // 巧妙的几何推导：把 Canvas 渐变的起始点反向延长同样的距离 (x1 - dx, y1 - dy)
        gradient = ctx.createLinearGradient(x1 - d.x, y1 - d.y, x2, y2);

        // -100%处(反方向端点)：颜色2
        gradient.addColorStop(0, BB.ColorConverter.toRgbaStr(color2));
        // 0% 处(起点也就是中心)：颜色1
        gradient.addColorStop(0.5, BB.ColorConverter.toRgbaStr(color1));
        // 100% 处(正方向端点)：颜色2
        gradient.addColorStop(1, BB.ColorConverter.toRgbaStr(color2));
    } else if (gradientObj.type === 'radial') {
        // 3. 径向渐变 (圆形渐变)
        // 半径 r = 起点到终点的物理直线距离
        const r = BB.Vec2.dist({ x: x1, y: y1 }, { x: x2, y: y2 });
        // 语法：createRadialGradient(内圆心X, 内圆心Y, 内圆半径, 外圆心X, 外圆心Y, 外圆半径)
        gradient = ctx.createRadialGradient(x1, y1, 0, x1, y1, r);
        // 圆心：颜色1
        gradient.addColorStop(0, BB.ColorConverter.toRgbaStr(color1));
        // 边缘：颜色2
        gradient.addColorStop(1, BB.ColorConverter.toRgbaStr(color2));
    }

    // ==========================================
    // 执行渲染
    // ==========================================
    ctx.fillStyle = gradient!;
    // 【橡皮擦渐变逻辑】
    // 使用 'destination-out'，画笔颜色本身不再重要。
    // Canvas 会利用绘制内容(即刚才构建的渐变色)的 Alpha 通道，去“抠掉”底层已经存在的像素。
    // 这就能实现“渐变橡皮擦”的效果：擦过去的地方，慢慢变淡直到完全透明。
    if (gradientObj.isEraser) {
        ctx.globalCompositeOperation = 'destination-out';
    }
    // 【透明度锁定渐变逻辑】
    if (gradientObj.doLockAlpha) {
        ctx.globalCompositeOperation = 'source-atop';
    }
    // 渐变对象准备好后，直接用一个全屏的矩形，把这个渐变“印”满整个画布！
    // (不用担心画到不该画的地方，因为最前面 ctx.clip 已经限制了范围，且渐变的终点色(color2)是完全透明的)
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    ctx.restore();
}
