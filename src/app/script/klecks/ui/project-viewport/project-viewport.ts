import { TMixMode } from '../../kl-types';
import { BB } from '../../../bb/bb';
import { css, throwIfNull } from '../../../bb/base/base';
import { THEME } from '../../../theme/theme';
import { compose, inverse, Matrix } from 'transformation-matrix';
import { createMatrixFromTransform } from '../../../bb/transform/create-matrix-from-transform';
import { matrixToTuple } from '../../../bb/math/matrix-to-tuple';
import { DEBUG_RENDER, DEBUG_RENDERER_ENABLED } from './debug-render';

/**
 * 修复缩放精度问题。
 * 在极高缩放倍数下，浮点数精度可能导致像素对不齐，这个函数将缩放比例锁定到物理像素的网格上。
 */
function fixScale(scale: number, pixels: number): number {
    return Math.round(pixels * scale) / pixels;
}

// width, height - viewport size
export type TProjectViewportLayerFunc = (
    viewportTransform: TViewportTransformXY,
    viewportWidth: number,
    viewportHeight: number,
) => CanvasImageSource | { image: CanvasImageSource; transform: Matrix }; // image drawn with ctx.setTransform(transform)

export type TProjectViewportProject = {
    width: number;
    height: number;
    layers: {
        image: CanvasImageSource | TProjectViewportLayerFunc;
        isVisible: boolean;
        opacity: number;
        mixModeStr: TMixMode;
        hasClipping: boolean;
    }[];
};

export type TViewportTransform = {
    scale: number;
    angleDeg: number;
    x: number;
    y: number;
};

export type TViewportTransformXY = {
    scaleX: number;
    scaleY: number;
    angleDeg: number;
    x: number;
    y: number;
};

export type TProjectViewportParams = {
    width: number;
    height: number;
    project: TProjectViewportProject;
    transform: TViewportTransform;
    drawBackground?: boolean;
    useNativeResolution?: boolean;
    renderAfter?: (ctx: CanvasRenderingContext2D, transform: TViewportTransformXY) => void;
    fillParent?: boolean;
};

/**
 * ProjectViewport (项目视口渲染器)
 * 核心职责：将画作的多个图层（Project），根据当前视角的缩放/平移/旋转（Transform），
 * 最终合并绘制到一个物理的 <canvas> 元素上。
 */
/**
 *
 * Scale - size of one project-canvas pixel compared to CSS pixel
 *      -> 1 means 1 pixel in the drawing is the size of a CSS pixel
 *      -> independent of device pixel ratio, or what resolution the viewport
 *          canvas may actually have.
 * Translate - translates in CSS pixels
 * Viewport origin is top left (same as canvas)
 *
 * Order of transformations (matrix multiplication is reversed): translate, rotate, scale
 */
export class ProjectViewport {
    // 视口css宽高
    private width: number;
    private height: number;
    // 真正渲染到游览器上的canvas上下文
    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    // 当前的视角状态（平移 x/y，缩放 scale，旋转 angle）
    private transform: TViewportTransform;

    // 画作数据（包含宽、高、以及所有的图层数据）
    private project: TProjectViewportProject;
    // 是否开启高清屏（Retina）适配
    private useNativeResolution: boolean;

    // 透明背景那个熟悉的“灰白相间棋盘格”图案
    private pattern: CanvasPattern;
    // 屏幕分辨率系数（普通屏是 1，苹果视网膜屏通常是 2 或 3）
    private resFactor: number;
    private readonly drawBackground: boolean;
    // 脏标记：如果改变了大小，下一次渲染时需要重建画布
    private doResize: boolean = true;

    // 【布局控制】是否让 Canvas 自动填满它的父容器？
    // 如果为 true，Canvas 的 CSS 会设为 width: 100%, height: 100%
    // 否则，就会设为固定的像素值（比如 width: 800px）
    private readonly doFillParent: boolean;
    // 【渲染钩子 (Hook)】在所有图层画完之后，额外执行的回调函数
    // 这是一个极度聪明的设计，被称为“依赖注入”。
    // ctx: 当前的画布上下文，transform: 当前的视角矩阵
    private readonly renderAfter:
        | undefined
        | ((ctx: CanvasRenderingContext2D, transform: TViewportTransformXY) => void);

    // 【主题响应机制】当用户切换暗黑/明亮模式时触发
    private onIsDark = (): void => {
        // BB.createCheckerCanvas: 生成一个极其微小的 10x10 的离屏 canvas，画上灰白或黑灰的棋盘格
        // createPattern: 把这个微小的 canvas 变成一个可以无限 repeat 的“墙纸”
        this.pattern = throwIfNull(
            this.ctx.createPattern(BB.createCheckerCanvas(10, THEME.isDark()), 'repeat'),
        );
        // 背景变了，立刻触发整个视口的重新渲染
        this.render();
    };

    // 记录当前的屏幕像素比（普通屏是 1，Retina 是 2，Windows 缩放可能是 1.25 或 1.5）
    private oldDPR = devicePixelRatio;
    // 【极其细节的浏览器缩放/跨屏监听器】
    private resizeListener = () => {
        // 当屏幕像素比发生变化时（比如：用户把浏览器从外接显示器拖到了 Mac 屏幕上，
        // 或者用户按下了 Ctrl + 放大网页）
        if (devicePixelRatio !== this.oldDPR) {
            // 核心奥秘：决定浏览器在缩放 Canvas 时，要不要“抗锯齿”
            // 如果 DPR 是整数 (1, 2, 3...)，强制设为 'pixelated'（像素化，保持边缘锐利不模糊）
            // 如果 DPR 是小数 (1.25, 1.5...)，设为空（恢复浏览器的平滑插值，避免像素扭曲）
            this.canvas.style.imageRendering =
                Math.round(devicePixelRatio) !== devicePixelRatio ? '' : 'pixelated';
            this.oldDPR = devicePixelRatio;
        }
    };

    // ----------------------------------- public -----------------------------------
    constructor(p: TProjectViewportParams) {
        this.width = p.width;
        this.height = p.height;
        this.project = p.project;
        this.useNativeResolution = !!p.useNativeResolution;
        this.drawBackground = p.drawBackground ?? true;
        this.doFillParent = !!p.fillParent;
        this.renderAfter = p.renderAfter;

        this.transform = {
            ...p.transform,
        };

        // 【核心机制 1：高清屏 (HiDPI) 适配】
        // 如果你的屏幕是 Retina 屏（devicePixelRatio = 2），为了让画质清晰不模糊，
        // Canvas 的物理像素必须是 CSS 逻辑像素的 2 倍！
        this.resFactor = this.useNativeResolution ? devicePixelRatio : 1;
        // 创建原生 canvas。注意这里乘以了 resFactor！
        // 比如视口是 800x600，但在 Retina 屏上，真实的像素矩阵是 1600x1200。
        this.canvas = BB.canvas(this.width * this.resFactor, this.height * this.resFactor);
        // 获取canvas上下文
        this.ctx = BB.ctx(this.canvas);
        // 但 CSS 样式依然保持原始大小，通过浏览器硬件加速把 1600 缩放到 800 显示，实现极度锐利。
        css(this.canvas, {
            width: this.doFillParent ? '100%' : this.width + 'px',
            height: this.doFillParent ? '100%' : this.height + 'px',
            imageRendering:
                Math.round(devicePixelRatio) !== devicePixelRatio ? undefined : 'pixelated',
            display: 'block',
        });
        window.addEventListener('resize', this.resizeListener);

        this.pattern = throwIfNull(
            // Exception: InvalidStateError: The object is in an invalid state.
            this.ctx.createPattern(BB.createCheckerCanvas(10, THEME.isDark()), 'repeat'),
        );
        THEME.addIsDarkListener(this.onIsDark);

        // this.render();
    }

    // ==========================================
    // 【引擎心脏：核心渲染管线】
    // 每次 Easel 的 requestAnimationFrame 循环都会调用这里
    // ==========================================
    render(optimizeForAnimation?: boolean): void {
        const isDark = THEME.isDark();
        const transform = {
            ...this.transform,
            x: this.transform.x,
            y: this.transform.y,
            scale: this.transform.scale,
        };

        // 如果视口大小变了，重置 Canvas 的物理像素大小
        if (this.doResize) {
            this.doResize = false;
            this.resFactor = this.useNativeResolution ? devicePixelRatio : 1;
            this.canvas.width = Math.round(this.width * this.resFactor);
            this.canvas.height = Math.round(this.height * this.resFactor);
        }

        // 【核心优化：动画降级】
        // optimizeForAnimation: 如果用户正在“拖拽”或者“缩放”画布（也就是运动状态中），
        // 就不进行四舍五入的像素对齐（这会让画面丝滑，但边缘可能微糊）。
        // 当用户松开鼠标，传进来 false，此时强制 Math.round() 对齐像素，画面瞬间变锐利！
        const renderedTransform: TViewportTransformXY = optimizeForAnimation
            ? {
                  x: transform.x,
                  y: transform.y,
                  angleDeg: transform.angleDeg,
                  scaleX: transform.scale,
                  scaleY: transform.scale,
              }
            : {
                  x: Math.round(transform.x),
                  y: Math.round(transform.y),
                  scaleX: fixScale(transform.scale, this.project.width),
                  scaleY: fixScale(transform.scale, this.project.height),
                  angleDeg: transform.angleDeg,
              };
        // 对canvas做变换的实际函数
        const renderedMat = createMatrixFromTransform(renderedTransform);

        // ==== 开始画布操作 ====
        // 保存当前纯净的上下文状态（入栈）
        this.ctx.save();

        // 【像素风画板支持】
        // 当画布放大倍数超过 4 倍（也就是 400%）时，关闭平滑抗锯齿（imageSmoothingEnabled = false）。
        // 这样放大后你看到的是一个个清晰的方块马赛克，而不是一片模糊。这是所有专业绘图软件的标配！
        if (
            renderedTransform.scaleX >= 4 ||
            (renderedTransform.scaleX === 1 && renderedTransform.angleDeg === 0)
        ) {
            this.ctx.imageSmoothingEnabled = false;
        } else {
            this.ctx.imageSmoothingEnabled = true;
            this.ctx.imageSmoothingQuality = 'low'; // art.scale >= 1 ? 'low' : 'medium';
        }
        // this.ctx.imageSmoothingEnabled = false;

        // 清空画布并画上底色（或透明棋盘格 pattern）
        if (this.drawBackground) {
            this.ctx.fillStyle = isDark ? 'rgb(33, 33, 33)' : 'rgb(158,158,158)';
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        } else {
            this.ctx.fillStyle = this.pattern;
            this.ctx.fillRect(0, 0, this.width, this.height);
        }

        // 【重头戏：应用视角变换矩阵】
        // 顺序极其严格：先平移(Translate)，再缩放(Scale)，最后旋转(Rotate)。
        // 这一步之后，Canvas 的“笔尖”就已经被移动到用户期望的那个坐标系下了。
        // this.ctx.scale(this.resFactor, this.resFactor);
        this.ctx.translate(renderedTransform.x, renderedTransform.y);
        this.ctx.scale(renderedTransform.scaleX, renderedTransform.scaleY);
        this.ctx.rotate((renderedTransform.angleDeg / 180) * Math.PI);

        if (this.drawBackground) {
            this.ctx.save();

            this.ctx.fillStyle = THEME.isDark() ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)';
            const scaledPixelX = 1 / renderedTransform.scaleX;
            const scaledPixelY = 1 / renderedTransform.scaleY;
            this.ctx.fillRect(
                -scaledPixelX,
                -scaledPixelY,
                this.project.width + scaledPixelX * 2,
                this.project.height + scaledPixelY * 2,
            );

            this.ctx.fillStyle = this.pattern;
            try {
                // setTransform got browser support since 2018-2020. catch if fails.
                this.pattern.setTransform(inverse(renderedMat));
            } catch (e) {
                /* */
            }
            this.ctx.fillRect(0, 0, this.project.width, this.project.height);

            this.ctx.restore();
        }

        // ==========================================
        // 【图层合成引擎 (Layer Compositing)】
        // 遍历这幅画里的每一个图层，并按照顺序叠画在一起
        // ==========================================
        this.project.layers.forEach((layer) => {
            if (!layer.isVisible || !layer.opacity) {
                // 隐藏的图层直接跳过，节省性能
                return;
            }
            this.ctx.save();
            // 设置该图层的混合模式（比如：正片叠底 'multiply'，滤色 'screen'）
            this.ctx.globalCompositeOperation = layer.mixModeStr;
            // 设置图层透明度
            this.ctx.globalAlpha = layer.opacity;

            let image: CanvasImageSource;
            if (typeof layer.image === 'function') {
                // 有些高级图层可能是个函数（动态生成的），执行它获取图像
                const res = layer.image(renderedTransform, this.canvas.width, this.canvas.height);
                if ('image' in res && 'transform' in res) {
                    image = res.image;
                    this.ctx.setTransform(...matrixToTuple(compose(renderedMat, res.transform)));
                } else {
                    image = res;
                }
            } else {
                // 普通图层就是一个隐藏的离屏 Canvas
                image = layer.image;
            }
            // 把这一层画到主画布上！
            // 因为前面已经执行了 translate/scale/rotate，所以这里只需要从 (0, 0) 开始画，
            // 浏览器硬件加速会自动把图层缩放旋转到正确的位置
            this.ctx.drawImage(image, 0, 0); // , this.project.width, this.project.height);
            // 画完一层，恢复透明度和混合模式，准备画下一层
            this.ctx.restore();
        });

        // 调用通过参数传进来的额外渲染函数（通常是 Easel 传进来的当前工具的临时画面，比如画笔正在画的线条）
        this.renderAfter?.(this.ctx, renderedTransform);

        DEBUG_RENDERER_ENABLED &&
            DEBUG_RENDER.render(
                this.ctx,
                this.project.width,
                this.project.height,
                renderedTransform.scaleX,
            );

        // 全部画完，将 Canvas 恢复到最原始的、未被 translate 和 scale 过的干净状态（出栈）。
        this.ctx.restore();
    }

    setSize(width: number, height: number): void {
        this.doResize = true;
        this.width = width;
        this.height = height;

        css(this.canvas, {
            width: this.doFillParent ? '100%' : this.width + 'px',
            height: this.doFillParent ? '100%' : this.height + 'px',
        });
    }

    setTransform(transform: TViewportTransform): void {
        this.transform = { ...transform };
    }

    setProject(project: TProjectViewportProject): void {
        this.project = project;
    }

    getTransform(): TViewportTransform {
        return { ...this.transform };
    }

    setUseNativeResolution(b: boolean): void {
        this.useNativeResolution = b;
        this.doResize = true;
    }

    getUseNativeResolution(): boolean {
        return this.useNativeResolution;
    }

    getElement(): HTMLElement {
        return this.canvas;
    }

    destroy(): void {
        BB.freeCanvas(this.canvas);
        THEME.removeIsDarkListener(this.onIsDark);
        window.removeEventListener('resize', this.resizeListener);
    }
}
