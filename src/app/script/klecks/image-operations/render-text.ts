import { BB } from '../../bb/bb';
import { TIndexBounds, TRect } from '../../bb/bb-types';
import { TRgba } from '../kl-types';

export type TTextFormat = 'left' | 'center' | 'right';
export type TTextFont = 'serif' | 'monospace' | 'sans-serif' | 'cursive' | 'fantasy' | string;

export type TRenderTextParam = {
    // 要绘制的文本，可能包含 \n 多行换行符
    text: string; // text to be drawn. can contain newlines
    x: number;
    y: number;
    // 文本旋转角度
    angleRad: number;
    // 字号大小 px
    size: number; // px
    align: TTextFormat;
    isBold: boolean;
    isItalic: boolean;
    font: TTextFont;
    letterSpacing?: number;
    // 行高 (em)
    lineHeight?: number; // em
    fill?: {
        color: TRgba;
    };
    stroke?: {
        color: TRgba;
        lineWidth: number;
    };
};

/**
 * [底层核心]：将现代 TextMetrics 转换为精准的矩形包围盒
 * 注释原话：accurately represents the bounds of the text, even it's fancy Zalgo text...
 * (精准计算文本边界，就算它是那种试图破坏排版布局的乱码 Zalgo 文本也能包住)
 */
// accurately represents the bounds of the text, even it's fancy Zalgo text that tries to break layout
function textMetricToRect(metrics: TextMetrics, align: TTextFormat): TRect {
    // Ascent: 基线(baseline) 到文字最高点的距离
    const ascent = metrics.actualBoundingBoxAscent;
    // Descent: 基线 到文字最低点的距离
    const descent = metrics.actualBoundingBoxDescent;
    // Left/Right: 文本左右两端的物理边界 (注意斜体字可能会超出起点/终点)
    const left = metrics.actualBoundingBoxLeft;
    const right = metrics.actualBoundingBoxRight;

    // 考虑到字体的倾斜或外溢，使用物理左右边界相加得到最精准的宽度
    const width = right + left; // More accurate width calculation considering left/right bounds
    const height = ascent + descent;

    // 根据对齐方式调整相对坐标原点 (x, y 相对于绘制的基准点)
    if (align === 'left') {
        return {
            // 左侧溢出的部分
            x: -left,
            // 向上最高的地方
            y: -ascent,
            width: width,
            height,
        };
    }
    if (align === 'right') {
        return {
            // 右对齐时，整个宽度都在基准点的左边
            x: -width,
            y: -ascent,
            width: width,
            height,
        };
    }
    // center
    return {
        // Canvas 的 center 对齐原生支持了中心基准，left 会是宽度的一半
        x: -left,
        y: -ascent,
        width: width,
        height,
    };
}

/**
 * [渲染入口]：在画布上渲染多行文本
 * 返回相对于起点 p.x, p.y 的包围盒
 */
/**
 * Draws text on a canvas.
 * Return bounds, relative to p.x, p.y.
 */
export function renderText(
    canvas: HTMLCanvasElement,
    p: TRenderTextParam,
    // 可选的套索选区
    selectionPath?: Path2D,
): TRect {
    p = BB.copyObj(p);

    // 断言并获取 Canvas 2D 上下文，并开启实验性的 letterSpacing 属性支持
    // setup context
    const ctx = BB.ctx(canvas) as CanvasRenderingContext2D & {
        letterSpacing: string;
    };
    ctx.save();

    // 如果有选区，禁止文字画到选区外
    selectionPath && ctx.clip(selectionPath);
    ctx.textAlign = p.align;
    ctx.letterSpacing = p.letterSpacing ? p.letterSpacing + 'px' : '0';

    // 构建原生 font 字符串 (如: "italic bold 24px sans-serif")
    // font
    const fontArr = [p.size + 'px ' + (p.font ? p.font : 'sans-serif')];
    if (p.isBold) {
        fontArr.unshift('bold');
    }
    if (p.isItalic) {
        fontArr.unshift('italic');
    }
    ctx.font = fontArr.join(' ');

    // 配置填充和描边颜色
    // fill
    ctx.fillStyle = p.fill ? BB.ColorConverter.toRgbaStr(p.fill.color) : 'transparent';

    // stroke
    ctx.strokeStyle = p.stroke ? BB.ColorConverter.toRgbaStr(p.stroke.color) : 'transparent';
    if (p.stroke) {
        ctx.lineWidth = p.stroke.lineWidth;
        // ! [细节优化]：使用圆角拼接，防止字体出现极其夸张的尖刺外溢
        ctx.lineJoin = 'round';
    }

    // 将整个画布的原点移动到指定的 (x,y)，并进行旋转
    // 注意：在这里旋转之后，后续计算的 bounds 都是在这个“倾斜的坐标系”里的局部坐标。
    // 这也是为什么外部的 KlCanvas.text 拿到这个 rect 后，还要用矩阵转换回全局坐标的原因！
    ctx.translate(p.x, p.y);
    ctx.rotate(-p.angleRad);

    // 处理多行文本，将不可见的制表符替换为 4 个空格
    const lines = p.text.split('\n').map((line) => line.replaceAll('\t', '    '));

    // ==========================================
    // 阶段一：测量所有行的包围盒并合并
    // ==========================================
    // bounds
    const bounds: TIndexBounds = {
        type: 'index',
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 0,
    };
    {
        let isFirst = true;
        lines.forEach((line, lineIndex) => {
            const metrics = ctx.measureText(line);
            // 因为已经做了 translate，所以起点全是 0
            const x = 0;
            // 行间距计算：字号 * 倍率 * 行数
            const y = p.size * (p.lineHeight ?? 1) * lineIndex;
            const mRect = textMetricToRect(metrics, p.align);
            if (isFirst) {
                isFirst = false;
                bounds.x1 = x + mRect.x;
                bounds.y1 = y + mRect.y;
                bounds.x2 = x + mRect.x + mRect.width - 1;
                bounds.y2 = y + mRect.y + mRect.height - 1;
            } else {
                // 不断撑大全局 bounds，确保能包裹住所有行
                bounds.x1 = Math.min(bounds.x1, x + mRect.x);
                bounds.y1 = Math.min(bounds.y1, y + mRect.y);
                bounds.x2 = Math.max(bounds.x2, x + mRect.x + mRect.width - 1);
                bounds.y2 = Math.max(bounds.y2, y + mRect.y + mRect.height - 1);
            }
        });
    }

    // ==========================================
    // 阶段二：先画所有的【描边】
    // 防止下行的描边盖住上行的填充
    // ==========================================
    // draw stroke
    lines.forEach((line, lineIndex) => {
        const x = 0;
        const y = p.size * (p.lineHeight ?? 1) * lineIndex;
        ctx.strokeText(line, x, y);
    });

    // ==========================================
    // 阶段三：再画所有的【填充】
    // 确保文字的内部主体颜色始终在最顶层
    // ==========================================
    // draw fill
    lines.forEach((line, lineIndex) => {
        const x = 0;
        const y = p.size * (p.lineHeight ?? 1) * lineIndex;
        ctx.fillText(line, x, y);
    });

    ctx.restore();
    // 返回针对这个旋转体系下的局部包围盒尺寸
    return {
        x: bounds.x1,
        y: bounds.y1,
        width: bounds.x2 - bounds.x1,
        height: bounds.y2 - bounds.y1,
    };
}
