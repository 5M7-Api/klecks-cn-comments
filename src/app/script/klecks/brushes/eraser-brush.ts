import { BB } from '../../bb/bb';
import { TPressureInput } from '../kl-types';
import { BezierLine } from '../../bb/math/line';
import { ERASE_COLOR } from './erase-color';
import { TKlCanvasLayer } from '../canvas/kl-canvas';
import { KlHistory } from '../history/kl-history';
import { getPushableLayerChange } from '../history/push-helpers/get-pushable-layer-change';
import { canvasAndChangedTilesToLayerTiles } from '../history/push-helpers/canvas-to-layer-tiles';
import { getChangedTiles, updateChangedTiles } from '../history/push-helpers/changed-tiles';
import { MultiPolygon } from 'polygon-clipping';
import { getSelectionPath2d } from '../../bb/multi-polygon/get-selection-path-2d';
import { intersectBounds } from '../../bb/math/math';
import { getMultiPolyBounds } from '../../bb/multi-polygon/get-multi-polygon-bounds';
import { TIndexBounds } from '../../bb/bb-types';

export class EraserBrush {
    // --- 笔刷基础设置 ---
    private size: number = 30;
    private spacing: number = 0.4;
    private opacity: number = 1;
    // 压力控制大小
    private useSizePressure: boolean = true;
    // 压力控制透明度
    private useOpacityPressure: boolean = false;
    // 画布背景是否透明
    private isTransparentBG: boolean = false;

    // --- 引擎上下文依赖 ---
    private klHistory: KlHistory = {} as KlHistory;
    private isBaseLayer: boolean = false; // 当前是否在最底层（背景层）操作
    private layer: TKlCanvasLayer = {} as TKlCanvasLayer;
    private context: CanvasRenderingContext2D = {} as CanvasRenderingContext2D;

    // --- 绘图状态追踪 ---
    private started: boolean = false;
    private lastDot: number | undefined;
    private lastInput: TPressureInput = { x: 0, y: 0, pressure: 0 };
    // 追踪上一个点，用于压感插值
    private lastInput2: TPressureInput = { x: 0, y: 0, pressure: 0 };
    // 平滑曲线生成器
    private bezierLine: BezierLine | undefined;

    // 记录哪些画布切片被修改了（用于优化撤销记录）
    private changedTiles: boolean[] = [];

    // --- 选区系统 ---
    private selection: MultiPolygon | undefined;
    private selectionPath: Path2D | undefined;
    private selectionBounds: TIndexBounds | undefined;

    /**
     * 记录本次擦除操作修改了哪些画布切片 (Tile)
     */
    private updateChangedTiles(bounds: TIndexBounds) {
        const boundsWithinSelection = intersectBounds(bounds, this.selectionBounds);
        if (!boundsWithinSelection) {
            return;
        }
        this.changedTiles = updateChangedTiles(
            this.changedTiles,
            getChangedTiles(bounds, this.context.canvas.width, this.context.canvas.height),
        );
    }

    /**
     * 在画布上盖一个橡皮擦“印章” (核心渲染方法)
     */
    private drawDot(x: number, y: number, size: number, opacity: number): void {
        this.context.save();

        // --- 核心：设置图像混合模式 ---
        if (this.isBaseLayer) {
            // ? 被透明背景固定，使用底色覆盖会不会更好？
            // 如果是最底层，根据画布是否是透明背景来决定是“挖空”还是“覆盖背景色”
            if (this.isTransparentBG) {
                // 挖空变透明
                this.context.globalCompositeOperation = 'destination-out';
            } else {
                // (特殊处理，通常用于保留底层结构)
                this.context.globalCompositeOperation = 'source-atop';
            }
        } else {
            // 普通图层，永远使用 destination-out (原有图像减去新画的形状)
            this.context.globalCompositeOperation = 'destination-out';
        }

        // --- 生成柔和边缘的橡皮擦笔尖 ---
        // 创建一个从中心到边缘的径向渐变
        const radgrad = this.context.createRadialGradient(size, size, 0, size, size, size);
        // 锐度计算：基于透明度，透明度越低，边缘越柔和。
        let sharpness = Math.pow(opacity, 2);
        // 限制锐度范围，防止笔刷过小或过锐
        sharpness = Math.max(0, Math.min((size - 1) / size, sharpness));

        // 透明度非线性映射，让力度变化在视觉上更自然
        const oFac = Math.max(0, Math.min(1, opacity));
        const localOpacity = 2 * oFac - oFac * oFac;

        // 设置渐变颜色点 (注意 Alpha 通道才是重点，它决定了挖空的强度)
        radgrad.addColorStop(
            sharpness,
            `rgba(${ERASE_COLOR}, ${ERASE_COLOR}, ${ERASE_COLOR}, ` + localOpacity + ')',
        );
        // 边缘渐变为完全透明 (力度为 0)
        radgrad.addColorStop(1, `rgba(${ERASE_COLOR}, ${ERASE_COLOR}, ${ERASE_COLOR}, 0)`);

        // --- 实际绘制圆形印章 ---
        this.context.fillStyle = radgrad;
        // 将画布坐标系移动到笔刷左上角，然后画一个 2*size 的正方形填充渐变
        this.context.translate(x - size, y - size);
        this.context.fillRect(0, 0, size * 2, size * 2);
        this.context.restore();

        // --- 更新被修改的画布切片 (用于历史记录) ---
        // 这里手动算出了这个印章的包围盒，并向下/向上取整保证覆盖完整的整数像素索引
        this.updateChangedTiles({
            type: 'index',
            x1: Math.floor(x - size),
            y1: Math.floor(y - size),
            x2: Math.ceil(x + size - 1),
            y2: Math.ceil(y + size - 1),
        });
    }

    /**
     * 接收连续的鼠标/压感笔输入，绘制平滑的擦除线
     */
    private continueLine(x: number | undefined, y: number | undefined, p: number): void {
        p = Math.max(0, Math.min(1, p));
        let localPressure;
        let localOpacity;
        // 如果开启了压感控制大小，根据压力 p 计算当前印章大小；否则使用固定大小
        let localSize = this.useSizePressure
            ? Math.max(0.1, p * this.size)
            : Math.max(0.1, this.size);

        // 计算当前笔刷应该使用的物理间距 (像素)
        const bdist = Math.max(1, Math.max(0.5, 1 - this.opacity) * localSize * this.spacing);

        // --- 贝塞尔曲线等距盖章回调 ---
        const bezierCallback = (val: {
            x: number;
            y: number;
            t: number;
            angle?: number;
            dAngle: number;
        }): void => {
            // t 是在两个输入点之间插值的进度 (0.0 ~ 1.0)
            const factor = val.t;
            // 线性插值计算出这个“章”应该具有的精确压力
            localPressure = this.lastInput2.pressure * (1 - factor) + p * factor;
            // 根据插值压力，算出此时的透明度
            localOpacity = this.useOpacityPressure
                ? this.opacity * localPressure * localPressure
                : this.opacity;
            // 根据插值压力，算出此时的笔尖大小
            localSize = this.useSizePressure
                ? Math.max(0.1, localPressure * this.size)
                : Math.max(0.1, this.size);

            // 在精确的插值坐标点上盖章
            this.drawDot(val.x, val.y, localSize, localOpacity);
        };

        this.context.save();
        // --- 选区遮罩 ---
        // 如果存在选区路径，使用 clip() 确保擦除效果绝对不会超出选区范围
        this.selectionPath && this.context.clip(this.selectionPath);
        if (x === undefined || y === undefined) {
            this.bezierLine!.addFinal(bdist, bezierCallback);
        } else {
            this.bezierLine!.add(x, y, bdist, bezierCallback);
        }
        this.context.restore();
    }

    // ----------------------------------- public -----------------------------------
    constructor() {}

    // ---- interface ----
    /**
     * 第一阶段：落笔 (Pointer Down)
     * @param x X坐标
     * @param y Y坐标
     * @param p 压感 (0.0 到 1.0)
     */
    startLine(x: number, y: number, p: number): void {
        // 1. 获取选区状态
        this.selection = this.klHistory.getComposed().selection.value;
        // 将异形选区转为 Canvas Path，以便后续使用 ctx.clip() 裁切
        this.selectionPath = this.selection ? getSelectionPath2d(this.selection) : undefined;
        // 使用我们分析过的 AABB 算法，计算选区的整数包围盒，用于后续加速碰撞检测
        this.selectionBounds = this.selection
            ? getMultiPolyBounds(this.selection, 'index')
            : undefined;

        // 2. 初始化脏矩形追踪
        this.changedTiles = [];
        this.isBaseLayer = 0 === this.layer.index;

        p = Math.max(0, Math.min(1, p));
        const localOpacity = this.useOpacityPressure ? this.opacity * p * p : this.opacity;
        const localSize = this.useSizePressure
            ? Math.max(0.1, p * this.size)
            : Math.max(0.1, this.size);

        this.started = true;
        // 4. 立刻在落笔处盖第一个章，给用户即时反馈
        if (localSize > 1) {
            this.context.save();
            this.selectionPath && this.context.clip(this.selectionPath);
            this.drawDot(x, y, localSize, localOpacity);
            this.context.restore();
        }

        // 5. 记录输入状态，用于后续的压感插值
        this.lastDot = localSize * this.spacing;
        this.lastInput.x = x;
        this.lastInput.y = y;
        this.lastInput.pressure = p;
        this.lastInput2 = BB.copyObj(this.lastInput);

        // 6. 初始化贝塞尔平滑引擎
        this.bezierLine = new BB.BezierLine();
        this.bezierLine.add(x, y, 0, () => undefined);
    }

    /**
     * 第二阶段：运笔 (Pointer Move)
     */
    goLine(x: number, y: number, p: number): void {
        if (!this.started) {
            return;
        }

        // 把上一个点的压力喂进去。因为贝塞尔平滑算法存在视觉延迟，
        // 这里的压力必须和正在绘制的“历史线段”对齐。
        this.continueLine(x, y, this.lastInput.pressure);

        // 状态流动：把当前状态变成过去式
        this.lastInput2 = BB.copyObj(this.lastInput);
        this.lastInput.x = x;
        this.lastInput.y = y;
        this.lastInput.pressure = p;
    }

    endLine(): void {
        if (this.bezierLine) {
            // 传入 undefined，触发 bezierLine.addFinal()，把积压的最后一段曲线画完
            this.continueLine(undefined, undefined, this.lastInput.pressure);
        }

        // 释放引擎
        this.started = false;
        this.bezierLine = undefined;

        // 检查：如果这一笔真的修改了画布内容
        if (this.changedTiles.some((item) => item)) {
            // 写入历史记录栈！
            this.klHistory.push(
                getPushableLayerChange(
                    this.klHistory.getComposed(),
                    // 将画布按照 changedTiles 的标记切成一片片的瓦片 (Tiles)
                    canvasAndChangedTilesToLayerTiles(this.context.canvas, this.changedTiles),
                ),
            );
        }
    }

    /**
     * 绘制两点之间的绝对直线 (通常用于 Shift + Click 操作)
     * @param x1 起点 X
     * @param y1 起点 Y
     * @param x2 终点 X
     * @param y2 终点 Y
     */
    drawLineSegment(x1: number, y1: number, x2: number, y2: number): void {
        // --- 1. 环境与选区快照 ---
        this.selection = this.klHistory.getComposed().selection.value;
        this.selectionPath = this.selection ? getSelectionPath2d(this.selection) : undefined;
        this.selectionBounds = this.selection
            ? getMultiPolyBounds(this.selection, 'index')
            : undefined;
        this.changedTiles = [];
        this.isBaseLayer = 0 === this.layer.index;

        // 更新最后输入位置，这样如果用户连续 Shift+Click，可以折线相连
        this.lastInput.x = x2;
        this.lastInput.y = y2;

        // 安全校验：如果当前正在进行自由曲线绘制(started)，或者起点无效，直接退出
        if (this.started || x1 === undefined) {
            return;
        }

        // --- 2. 向量数学计算 ---
        // 使用勾股定理计算两点之间的总像素距离
        const mouseDist = Math.sqrt(Math.pow(x2 - x1, 2.0) + Math.pow(y2 - y1, 2.0));
        // 计算 X 和 Y 方向上的单位步长 (即单位向量 Direction Vector)
        const eX = (x2 - x1) / mouseDist;
        const eY = (y2 - y1) / mouseDist;
        let loopDist;
        const bdist = Math.max(1, Math.max(0.5, 1 - this.opacity) * this.size * this.spacing);
        this.lastDot = 0;
        this.context.save();
        // 应用选区蒙版
        this.selectionPath && this.context.clip(this.selectionPath);

        // --- 3. 等距盖章循环 ---
        // 从 0 走到 mouseDist，每次迈出 bdist 的步子
        for (loopDist = this.lastDot; loopDist <= mouseDist; loopDist += bdist) {
            // 当前精确坐标 = 起点 + 步数 * 对应方向的单位向量
            // 注意：因为没有压感输入，这里的直线默认使用固定的 size 和 opacity
            this.drawDot(x1 + eX * loopDist, y1 + eY * loopDist, this.size, this.opacity);
        }
        this.context.restore();

        // --- 4. 提交到撤销栈 ---
        if (this.changedTiles.some((item) => item)) {
            this.klHistory.push(
                getPushableLayerChange(
                    this.klHistory.getComposed(),
                    canvasAndChangedTilesToLayerTiles(this.context.canvas, this.changedTiles),
                ),
            );
        }
    }

    //IS
    isDrawing(): boolean {
        return this.started;
    }

    //SET
    setLayer(layer: TKlCanvasLayer): void {
        this.layer = layer;
        this.context = layer.context;
    }

    setHistory(klHistory: KlHistory): void {
        this.klHistory = klHistory;
    }

    setSize(s: number): void {
        this.size = s;
    }

    setOpacity(o: number): void {
        this.opacity = o;
    }

    sizePressure(b: boolean): void {
        this.useSizePressure = b;
    }

    opacityPressure(b: boolean): void {
        this.useOpacityPressure = b;
    }

    setTransparentBG(b: boolean): void {
        this.isTransparentBG = b;
    }

    //GET
    getSize(): number {
        return this.size;
    }

    getOpacity(): number {
        return this.opacity;
    }
}
