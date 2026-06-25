import { BB } from '../../bb/bb';
import { ALPHA_IM_ARR } from './brushes-common';
import { TPressureInput, TRgb } from '../kl-types';
import { BezierLine } from '../../bb/math/line';
import { KlHistory } from '../history/kl-history';
import { getPushableLayerChange } from '../history/push-helpers/get-pushable-layer-change';
import { canvasAndChangedTilesToLayerTiles } from '../history/push-helpers/canvas-to-layer-tiles';
import { getChangedTiles, updateChangedTiles } from '../history/push-helpers/changed-tiles';
import { MultiPolygon } from 'polygon-clipping';
import { getSelectionPath2d } from '../../bb/multi-polygon/get-selection-path-2d';
import { intersectBounds } from '../../bb/math/math';
import { getMultiPolyBounds } from '../../bb/multi-polygon/get-multi-polygon-bounds';
import { TIndexBounds } from '../../bb/bb-types';

// 笔刷形状的枚举值（对应圆、粉笔、书法笔、方块）
const ALPHA_CIRCLE = 0;
const ALPHA_CHALK = 1;
const ALPHA_CAL = 2; // calligraphy
const ALPHA_SQUARE = 3;

const TWO_PI = 2 * Math.PI;

// 笔刷实际渲染到画布的作用函数。
// 类结构体被绑定在 BRUSHES
// 通过 Object.entries(KL.BRUSHES_UI).forEach 内部遍历new构造实例之后内部的.Ui方法
export class PenBrush {
    // ------------------------------------------------------------------------
    // 1. 核心状态声明 (State)
    // ------------------------------------------------------------------------
    // 当前正在绘制的图层上下文
    private context: CanvasRenderingContext2D = {} as CanvasRenderingContext2D; 
    // 历史记录对象，用于撤销/重做
    private klHistory: KlHistory = {} as KlHistory;

    // 是否开启“压感控制透明度”
    private settingHasOpacityPressure: boolean = false;
    // 压感控制散布
    private settingHasScatterPressure: boolean = false;
    // 压感控制大小
    private settingHasSizePressure: boolean = true;
    // 笔刷大小
    private settingSize: number = 2;
    // 笔刷印章的间距
    private settingSpacing: number = 0.8489;
    // 基础透明度
    private settingOpacity: number = 1;
    // 基础散布值
    private settingScatter: number = 0;
    // 当前RGB颜色
    private settingColor: TRgb = {} as TRgb;
    // 颜色字符串 (如 'rgba(...)')
    private settingColorStr: string = '';
    // 当前笔尖形状 ID
    private settingAlphaId: number = ALPHA_CIRCLE;
    // 是否锁定透明像素 (画在已有像素上)
    private settingLockLayerAlpha: boolean = false;

    private hasDrawnDot: boolean = false;
    private lineToolLastDot: number = 0;
    // 上一个输入的物理坐标
    private lastInput: TPressureInput = { x: 0, y: 0, pressure: 0 };
    // 上上个输入的物理坐标
    private lastInput2: TPressureInput = { x: 0, y: 0, pressure: 0 };
    // 坐标采样队列
    private inputArr: TPressureInput[] = [];
    // 是否处于绘制状态
    private inputIsDrawing: boolean = false;
    // 贝塞尔曲线对象（用于平滑离散点）
    private bezierLine: BezierLine | null = null;

    // ------------------------------------------------------------------------
    // 2. 图像渲染优化：多级渐远纹理 (Mipmapping)
    // ------------------------------------------------------------------------
    // 原理：如果在画很细的线时，系统每次都要把 512x512 的超高清笔尖图片压缩成 2x2 的尺寸去画，
    // 会造成严重的性能损耗（掉帧）和画面闪烁（锯齿/摩尔纹）。
    // 解决办法：预先准备好 128, 64, 32 三种尺寸的“备胎”画布。画线时，根据笔刷大小挑选最接近的一个来用。
    // mipmapping
    private readonly alphaCanvas128: HTMLCanvasElement = BB.canvas(128, 128);
    private readonly alphaCanvas64: HTMLCanvasElement = BB.canvas(64, 64);
    private readonly alphaCanvas32: HTMLCanvasElement = BB.canvas(32, 32);
    // 针对不同笔刷微调的基础透明度修正
    private readonly alphaOpacityArr: number[] = [1, 0.9, 1, 1];

    // ------------------------------------------------------------------------
    // 3. 内存优化：脏矩形/脏瓦片 (Dirty Tiles)
    // ------------------------------------------------------------------------
    // 如果用户只在画布左上角画了一笔，撤销系统没有必要把整个 4K 画布都存进内存。
    // 画布被划分为一个个正方形的 Tile（瓦片）。changedTiles 记录了这一笔究竟弄脏了哪些瓦片。
    private changedTiles: boolean[] = [];

    // 选区相关的状态
    private selection: MultiPolygon | undefined;
    private selectionPath: Path2D | undefined;
    private selectionBounds: TIndexBounds | undefined;

    // 当画笔经过某个区域时，调用此方法更新“被弄脏的瓦片”
    private updateChangedTiles(bounds: TIndexBounds) {
        // 先判断绘制区域是否在“选区 (蚂蚁线)”范围内。如果画在选区外面，其实根本没画上，直接 return。
        const boundsWithinSelection = intersectBounds(bounds, this.selectionBounds);
        if (!boundsWithinSelection) {
            return;
        }
        // 将被弄脏的区域记录下来，等这笔画完后，历史记录系统只会打包保存这些特定的瓦片
        this.changedTiles = updateChangedTiles(
            this.changedTiles,
            getChangedTiles(
                boundsWithinSelection,
                this.context.canvas.width,
                this.context.canvas.height,
            ),
        );
    }

    // ------------------------------------------------------------------------
    // 4. 笔尖预处理 (Alpha Pre-tinting)
    // ------------------------------------------------------------------------
    // 这个方法的作用是：给黑白的笔尖纹理（Alpha贴图）“上色”。
    private updateAlphaCanvas() {
        // 圆形和方形是数学绘制的，不需要上色预处理
        if (this.settingAlphaId === ALPHA_CIRCLE || this.settingAlphaId === ALPHA_SQUARE) {
            return;
        }

        const instructionArr: [HTMLCanvasElement, number][] = [
            [this.alphaCanvas128, 128],
            [this.alphaCanvas64, 64],
            [this.alphaCanvas32, 32],
        ];

        let ctx;

        // 遍历三种尺寸的备用画布
        for (let i = 0; i < instructionArr.length; i++) {
            ctx = BB.ctx(instructionArr[i][0] as any);

            ctx.save();
            ctx.clearRect(0, 0, instructionArr[i][1], instructionArr[i][1]);

            // 1. 先用用户选择的颜色（比如红色），涂满整个备用画布
            ctx.fillStyle =
                'rgba(' +
                this.settingColor.r +
                ', ' +
                this.settingColor.g +
                ', ' +
                this.settingColor.b +
                ', ' +
                this.alphaOpacityArr[this.settingAlphaId] +
                ')';
            ctx.fillRect(0, 0, instructionArr[i][1], instructionArr[i][1]);

            // 2. 图像混合魔法：'destination-in'
            // 意思是：接下来画上去的图像，只会保留【与刚才的红色重叠的部分】，其余部分变透明。
            ctx.globalCompositeOperation = 'destination-in';
            ctx.imageSmoothingQuality = 'high';

            // 3. 把原始的、半透明的笔刷纹理贴图（比如粉笔纹理）画上去
            // 结果就是：我们得到了一个纯红色的粉笔纹理！
            // ! 注意此处为了兼容画笔大小进行了最接近的预处理canvas的缩放
            ctx.drawImage(
                ALPHA_IM_ARR[this.settingAlphaId],
                0,
                0,
                instructionArr[i][1],
                instructionArr[i][1],
            );

            ctx.restore();
        }
    }

    // ------------------------------------------------------------------------
    // 5. 压感数学映射 (Pressure Math)
    // ------------------------------------------------------------------------
    // 计算当前印章的透明度
    private calcOpacity(pressure: number): number {
        // 【图形学细节】：如果开启了透明度压感，公式是 pressure * pressure (平方)。
        // 为什么不用线性的 pressure？因为数位板的硬件压感在低压区变化很敏感。
        // 用平方曲线 (0.5 的压感会变成 0.25 的透明度)，能让用户更轻易地画出极其轻柔、淡雅的起笔，笔触过渡更自然。
        return this.settingOpacity * (this.settingHasOpacityPressure ? pressure * pressure : 1);
    }

    // 计算当前印章的散布偏移量
    private calcScatter(pressure: number): number {
        // 散布范围 = 基础散布系数 * 笔刷大小 * (开启压感则乘以压感，否则不变)
        // 这意味着笔刷越大，散点飞得越远。
        return (
            this.settingScatter * this.settingSize * (this.settingHasScatterPressure ? pressure : 1)
        );
    }

    /**
     * 在画布上“盖一个印章” (绘制单个点)
     * @param x X坐标
     * @param y Y坐标
     * @param size 这一刻的笔刷大小 (受压感影响)
     * @param opacity 这一刻的透明度 (受压感影响)
     * @param scatter 这一刻的散布值 (受压感影响)
     * @param angle 这一刻的笔触旋转角度 (主要用于方形或书法笔)
     * @param before 性能优化利器：上一个印章的状态记录 [x, y, size, opacity, angle]
     */
    /**
     * @param x
     * @param y
     * @param size
     * @param opacity
     * @param scatter
     * @param angle
     * @param before - [x, y, size, opacity, angle] the drawDot call before
     */
    private drawDot(
        x: number,
        y: number,
        size: number,
        opacity: number,
        scatter: number,
        angle?: number,
        before?: [number, number, number, number, number, number | undefined],
    ): void {
        if (size <= 0) {
            // 尺寸为0，不用画了，直接退出
            return;
        }

        // 如果开启了“锁定透明像素”（比如只能在已经画了脸的区域画腮红）
        // 使用 source-atop 混合模式：新画的像素只在已有像素重叠的地方显现
        if (this.settingLockLayerAlpha) {
            this.context.globalCompositeOperation = 'source-atop';
        }

        // 【极客级性能优化 1：状态机缓存】
        // 在 Canvas 中，修改 globalAlpha 和 fillStyle 是非常耗费 CPU 的操作！
        // 如果当前印章的透明度和上一个印章一模一样，我们就不去调用底层的 API，直接略过。
        if (!before || before[3] !== opacity) {
            this.context.globalAlpha = opacity;
        }

        // 同样，如果颜色没变，就不重复设置 fillStyle
        if (
            !before &&
            (this.settingAlphaId === ALPHA_CIRCLE || this.settingAlphaId === ALPHA_SQUARE)
        ) {
            this.context.fillStyle = this.settingColorStr;
        }

        // 【极客级数学 1：完美圆形散布算法】
        if (scatter > 0) {
            // scatterAngleRad: 生成 0 到 360度 (2π) 的随机极坐标角度
            // scatter equally distributed over area of a circle
            const scatterAngleRad = Math.random() * 2 * Math.PI;
            // distance: 计算飞溅距离。为什么要用 Math.sqrt(Math.random())？
            // 如果直接用 random()，散点会疯狂聚集在圆心！加上平方根后，散点在圆的面积内才是真正均匀分布的！
            const distance = Math.sqrt(Math.random()) * scatter;
            x += Math.cos(scatterAngleRad) * distance;
            y += Math.sin(scatterAngleRad) * distance;
        }

        // 更新脏瓦片 (Dirty Tiles) 逻辑
        // 如果是正方形，旋转45度时对角线最长，是边长的 1.414(sqrt(2)) 倍，需要把脏矩形范围扩大，防止切边。
        const boundsSize =
            this.settingAlphaId === ALPHA_CIRCLE || this.settingAlphaId === ALPHA_CAL
                ? size
                : size * Math.sqrt(2);
        this.updateChangedTiles({
            type: 'index',
            x1: Math.floor(x - boundsSize),
            y1: Math.floor(y - boundsSize),
            x2: Math.ceil(x + boundsSize - 1),
            y2: Math.ceil(y + boundsSize - 1),
        });

        // ================= 开始真实渲染印章 =================
        if (this.settingAlphaId === ALPHA_CIRCLE) {
            // 画圆：纯数学渲染
            this.context.beginPath();
            this.context.arc(x, y, size, 0, TWO_PI);
            this.context.closePath();
            this.context.fill();
            this.hasDrawnDot = true;
        } else if (this.settingAlphaId === ALPHA_SQUARE) {
            // 画方块：带角度旋转的数学渲染
            if (angle !== undefined) {
                this.context.save();
                // 移动画布原点到目标坐标
                this.context.translate(x, y);
                // 旋转画布
                this.context.rotate((angle / 180) * Math.PI);
                // 画正方形
                this.context.fillRect(-size, -size, size * 2, size * 2);
                // 恢复画布状态
                this.context.restore();
                this.hasDrawnDot = true;
            }
        } else {
            // 其他笔刷 (粉笔、书法笔)：调用 Mipmap 贴图渲染
            // other brush alphas
            this.context.save();
            this.context.translate(x, y);

            // 【多级渐远纹理 (Mipmap) 选择逻辑】
            // 默认用最清晰的大图
            let targetMipmap = this.alphaCanvas128;
            if (size <= 32 && size > 16) {
                // 笔刷适中，用 64x64
                targetMipmap = this.alphaCanvas64;
            } else if (size <= 16) {
                // 笔刷很小，用 32x32 的小图防锯齿
                targetMipmap = this.alphaCanvas32;
            }
            // ! 利用 GPU 硬件级缩放，将固定图章缩放成笔刷大小
            this.context.scale(size, size);
            // 【极客级数学 2：粉笔纹理的伪随机旋转】
            if (this.settingAlphaId === ALPHA_CHALK) {
                // 如果是粉笔，每次贴图都要随机转个角度，否则画面看起来会有难看的“重复图章感”。
                // 但为什么不用 Math.random()？
                // 因为要保证“确定性”：同一个坐标点 (x,y)，无论什么时候画，转的角度必须一致。
                // 这就是一个简单的“空间哈希函数”，用坐标计算出一个固定的伪随机角度！
                this.context.rotate(((x + y) * 53123) % TWO_PI); // without mod it sometimes looks different
            }
            // 硬件极速绘制贴图
            this.context.drawImage(targetMipmap, -1, -1, 2, 2);

            this.context.restore();
            this.hasDrawnDot = true;
        }
    }

    /**
     * 连点成线：鼠标每次 move 时调用。
     * 它的职责是把两次稀疏的鼠标坐标，填补成平滑的贝塞尔曲线，并在曲线上高频调用 drawDot
     */
    // continueLine
    private continueLine(x: number | null, y: number | null, size: number, pressure: number): void {
        // 如果是新的一笔，初始化贝塞尔曲线对象
        if (this.bezierLine === null) {
            this.bezierLine = new BB.BezierLine();
            this.bezierLine.add(this.lastInput.x, this.lastInput.y, 0, () => { });
        }

        // 用来收集这一次鼠标移动需要画的所有“印章指令”
        const drawArr: [number, number, number, number, number, number | undefined][] = []; //draw instructions. will be all drawn at once

        // 贝塞尔引擎在计算插值时，每次计算出一个“应有的印章位置”就会回调这个函数
        const dotCallback = (val: {
            x: number;
            y: number;
            // t 是 0~1 的进度值
            t: number;
            angle?: number;
            dAngle: number;
        }): void => {
            // 平滑插值计算出当前这个印章的：压感、透明度、大小、散布
            const localPressure = BB.mix(this.lastInput2.pressure, pressure, val.t);
            const localOpacity = this.calcOpacity(localPressure);
            const localSize = Math.max(
                0.1,
                this.settingSize * (this.settingHasSizePressure ? localPressure : 1),
            );
            const localScatter = this.calcScatter(localPressure);
            // 把计算好的数据塞入待绘制队列
            drawArr.push([val.x, val.y, localSize, localOpacity, localScatter, val.angle]);
        };

        // 计算物理点距 (间距百分比 * 当前画笔大小)
        const localSpacing = size * this.settingSpacing;
        // 把最新的鼠标坐标喂给贝塞尔引擎。引擎会根据 localSpacing 自动触发 n 次 dotCallback
        if (x === null || y === null) {
            // 画线结束
            this.bezierLine.addFinal(localSpacing, dotCallback);
        } else {
            // 连入新点
            this.bezierLine.add(x, y, localSpacing, dotCallback);
        }

        // execute draw instructions
        this.context.save();
        let before: (typeof drawArr)[number] | undefined = undefined;
        // 遍历所有生成的印章数据，一次性盖在画布上
        for (let i = 0; i < drawArr.length; i++) {
            const item = drawArr[i];
            this.drawDot(item[0], item[1], item[2], item[3], item[4], item[5], before);
            // 把当前印章数据存下来传给下一个，用于我们在 drawDot 开头讲过的【状态机缓存优化】！
            before = item;
        }
        this.context.restore();
    }

    // ----------------------------------- public -----------------------------------
    constructor() { }

    // ---- interface ----
    /**
     * 1. 笔触开始 (对应 mousedown / touchstart)
     */
    startLine(x: number, y: number, p: number): void {
        // --- 1. 选区(蚂蚁线)处理 ---
        // 从历史记录或图层管理器中获取当前是否存在选区
        this.selection = this.klHistory.getComposed().selection.value;
        // 如果有选区，将其转换为 Canvas 的 Path2D 路径对象
        this.selectionPath = this.selection ? getSelectionPath2d(this.selection) : undefined;
        // 获取选区的最小包围盒（用于刚才学的脏瓦片优化，选区外绝对不会弄脏）
        this.selectionBounds = this.selection
            ? getMultiPolyBounds(this.selection, 'index')
            : undefined;

        // --- 2. 状态初始化 ---
        // 新的一笔，清空上一笔的脏瓦片记录
        this.changedTiles = [];
        // 防呆：确保压感在 0-1 之间
        p = BB.clamp(p, 0, 1);

        // 计算起笔这一下的透明度、大小和散布
        const localOpacity = this.calcOpacity(p);
        const localSize = this.settingHasSizePressure
            ? Math.max(0.1, p * this.settingSize)
            : Math.max(0.1, this.settingSize);
        const localScatter = this.calcScatter(p);

        this.hasDrawnDot = false;
        // 开启状态锁
        this.inputIsDrawing = true;

        // --- 3. 渲染第一滴墨水 ---
        this.context.save();
        // 【关键】如果有选区，调用 clip()。这保证了接下来画的印章，绝对不会超出选区范围！
        this.selectionPath && this.context.clip(this.selectionPath);
        // 盖下第一个印章
        this.drawDot(x, y, localSize, localOpacity, localScatter);
        this.context.restore();

        // --- 4. 记录物理状态，供接下来 move 使用 ---
        this.lineToolLastDot = localSize * this.settingSpacing;
        this.lastInput.x = x;
        this.lastInput.y = y;
        this.lastInput.pressure = p;
        this.lastInput2.pressure = p;

        // 收集采样点数组（最后在 endLine 时可能会用到）
        this.inputArr = [
            {
                x,
                y,
                pressure: p,
            },
        ];
    }

    /**
     * 2. 笔触移动 (对应 mousemove / touchmove)
     */
    goLine(x: number, y: number, p: number): void {
        // 如果根本没落下画笔，直接抛弃幽灵事件（和 LineSanitizer 里的逻辑呼应）
        if (!this.inputIsDrawing) {
            return;
        }

        const pressure = BB.clamp(p, 0, 1);
        // 注意这里：计算大小用的是【上一次】的压感 (lastInput.pressure)。
        // 这是一种轻微的平滑延迟，防止压感突变导致线条像糖葫芦一样忽大忽小。
        const localSize = this.settingHasSizePressure
            ? Math.max(0.1, this.lastInput.pressure * this.settingSize)
            : Math.max(0.1, this.settingSize);

        // --- 渲染中间平滑连线 ---
        this.context.save();
        this.selectionPath && this.context.clip(this.selectionPath);
        // 调用贝塞尔引擎，填补上一个点到这个点之间的所有印章
        this.continueLine(x, y, localSize, this.lastInput.pressure);

        /*context.fillStyle = 'red';
        context.fillRect(Math.floor(x), Math.floor(y - 10), 1, 20);
        context.fillRect(Math.floor(x - 10), Math.floor(y), 20, 1);*/

        this.context.restore();

        // --- 滚动更新状态机 ---
        this.lastInput.x = x;
        this.lastInput.y = y;
        // 现在的变为“上一次的”
        this.lastInput2.pressure = this.lastInput.pressure;
        // 新的变为“现在的”
        this.lastInput.pressure = pressure;

        this.inputArr.push({
            x,
            y,
            pressure: p,
        });
    }

    /**
     * 3. 笔触结束 (对应 mouseup / touchend)
     */
    endLine(): void {
        const localSize = this.settingHasSizePressure
            ? Math.max(0.1, this.lastInput.pressure * this.settingSize)
            : Math.max(0.1, this.settingSize);
        this.context.save();
        this.selectionPath && this.context.clip(this.selectionPath);
        // 传入 null, null！这是告诉贝塞尔引擎：“线画完了，把你肚子里没画完的最后半截尾巴全都吐出来画上！”
        this.continueLine(null, null, localSize, this.lastInput.pressure);
        this.context.restore();

        // 关闭状态锁
        this.inputIsDrawing = false;

        // --- 【神级 UX 修复：原地点击问题】 ---
        // 现象：方块笔刷如果在屏幕上只是“轻轻点一下”（不拖拽），可能由于没达到点距阈值，啥也没画出来。
        // ! 如果你只是“吧嗒”点了一下，贝塞尔引擎可能收集不到足够的坐标点来触发 dotCallback。
        // 修复：如果你用的是方块，且整个生命周期没有画出任何印章 (!this.hasDrawnDot)
        if (this.settingAlphaId === ALPHA_SQUARE && !this.hasDrawnDot) {
            // 找出刚才那“点击一下”的过程中，压感最大的一瞬间
            // find max pressure input, use that one
            let maxInput = this.inputArr[0];
            this.inputArr.forEach((item) => {
                if (item.pressure > maxInput.pressure) {
                    maxInput = item;
                }
            });

            // 强行在原地“重重地”盖一个方块印章
            this.context.save();
            this.selectionPath && this.context.clip(this.selectionPath);
            // 传入 null, null！这是告诉贝塞尔引擎：“线画完了，把你肚子里没画完的最后半截尾巴全都吐出来画上！”
            const p = BB.clamp(maxInput.pressure, 0, 1);
            const localOpacity = this.calcOpacity(p);
            const localScatter = this.calcScatter(p);
            this.drawDot(maxInput.x, maxInput.y, localSize, localOpacity, localScatter, 0);
            this.context.restore();
        }

        // 销毁曲线引擎，释放内存
        this.bezierLine = null;

        // --- 终极闭环：提交脏瓦片到历史记录！ ---
        // 如果这一笔确实弄脏了画布 (有些瓦片变成了 true)
        if (this.changedTiles.some((item) => item)) {
            // 把被弄脏的瓦片图像数据提取出来，打包成一条 Undo 记录，推进历史记录堆栈！
            this.klHistory.push(
                getPushableLayerChange(
                    this.klHistory.getComposed(),
                    canvasAndChangedTilesToLayerTiles(this.context.canvas, this.changedTiles),
                ),
            );
        }

        this.hasDrawnDot = false;
        // 清理采样数组，打完收工
        this.inputArr = [];
    }

    /**
     * 绘制两点之间的绝对直线段 (通常由按住 Shift 键触发)
     * @param x1 起点 X 坐标
     * @param y1 起点 Y 坐标
     * @param x2 终点 X 坐标
     * @param y2 终点 Y 坐标
     */
    drawLineSegment(x1: number, y1: number, x2: number, y2: number): void {
        // --- 1. 选区(蚂蚁线)与状态初始化 ---
        // 和 startLine 一模一样，先获取当前是否有选区，有的话生成剪裁路径 (Path2D)
        this.selection = this.klHistory.getComposed().selection.value;
        this.selectionPath = this.selection ? getSelectionPath2d(this.selection) : undefined;
        this.selectionBounds = this.selection
            ? getMultiPolyBounds(this.selection, 'index')
            : undefined;
        // 清空脏瓦片数组，准备记录这根直线
        this.changedTiles = [];

        // 强行把终点记录为“最后一次输入”，并将压感强行设为 1 (满压感)
        // 因为画直线是用鼠标点击的两点，没有真实的拖拽物理压感，所以默认是最粗最实的线
        this.lastInput.x = x2;
        this.lastInput.y = y2;
        this.lastInput.pressure = 1;

        // 防呆设计：如果当前正在用普通模式画线 (inputIsDrawing === true)，
        // 或者起点坐标丢失，则直接放弃画直线，防止两条线打架。
        if (this.inputIsDrawing || x1 === undefined) {
            return;
        }

        // --- 2. 核心数学计算 (向量与三角函数) ---
        // 计算起点到终点的角度 (Degree)，这主要用于方块笔刷，让方块能顺着线条的方向倾斜
        const angle = BB.pointsToAngleDeg({ x: x1, y: y1 }, { x: x2, y: y2 });
        // 勾股定理：计算两点之间的总直线距离 (mouseDist)
        const mouseDist = Math.sqrt(Math.pow(x2 - x1, 2.0) + Math.pow(y2 - y1, 2.0));
        // 计算单位向量 (Unit Vector): eX 和 eY
        // 这代表着在这条直线上，每移动 1 个像素，X 和 Y 方向分别应该移动多少。
        const eX = (x2 - x1) / mouseDist;
        const eY = (y2 - y1) / mouseDist;
        // 当前已经画了多远
        let loopDist;
        // bdist (Brush Distance): 印章的物理间距 = 画笔大小 * 间距系数
        const bdist = this.settingSize * this.settingSpacing;
        this.lineToolLastDot = this.settingSize * this.settingSpacing;
        // --- 3. 暴力循环：沿直线盖印章 ---
        this.context.save();
        // 选区剪裁保护
        this.selectionPath && this.context.clip(this.selectionPath);
        // 以满压感计算散布值
        const localScatter = this.calcScatter(1);
        // 【极其经典的步进循环算法】
        // 从起点开始，每次沿着直线往前走一个印章间距 (bdist)，直到走完总距离 (mouseDist)
        for (loopDist = this.lineToolLastDot; loopDist <= mouseDist; loopDist += bdist) {
            // 计算当前这个印章的绝对坐标： 起点 + 单位向量 * 当前走了多远
            this.drawDot(
                x1 + eX * loopDist,
                y1 + eY * loopDist,
                // 因为是纯直线，大小和透明度全是死值（满值），没有渐变压感
                this.settingSize,
                this.settingOpacity,
                localScatter,
                // 传入计算好的角度，方块笔刷会顺着这条直线旋转
                angle,
            );
        }
        this.context.restore();

        // --- 4. 提交到历史记录 ---
        // 将被这根直线弄脏的瓦片 (changedTiles) 提取出来，打包存入历史记录
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
        return this.inputIsDrawing;
    }

    //SET
    setAlpha(a: number): void {
        if (this.settingAlphaId === a) {
            return;
        }
        this.settingAlphaId = a;
        this.updateAlphaCanvas();
    }

    setColor(c: TRgb): void {
        if (this.settingColor === c) {
            return;
        }
        this.settingColor = { r: c.r, g: c.g, b: c.b };
        this.settingColorStr =
            'rgb(' +
            this.settingColor.r +
            ',' +
            this.settingColor.g +
            ',' +
            this.settingColor.b +
            ')';
        this.updateAlphaCanvas();
    }

    setContext(c: CanvasRenderingContext2D): void {
        this.context = c;
    }

    setHistory(klHistory: KlHistory): void {
        this.klHistory = klHistory;
    }

    setSize(s: number): void {
        this.settingSize = s;
    }

    setOpacity(o: number): void {
        this.settingOpacity = o;
    }

    setScatter(o: number): void {
        this.settingScatter = o;
    }

    setSpacing(s: number): void {
        this.settingSpacing = s;
    }

    sizePressure(b: boolean): void {
        this.settingHasSizePressure = b;
    }

    opacityPressure(b: boolean): void {
        this.settingHasOpacityPressure = b;
    }

    scatterPressure(b: boolean): void {
        this.settingHasScatterPressure = b;
    }

    setLockAlpha(b: boolean): void {
        this.settingLockLayerAlpha = b;
    }

    //GET
    getSpacing(): number {
        return this.settingSpacing;
    }

    getSize(): number {
        return this.settingSize;
    }

    getOpacity(): number {
        return this.settingOpacity;
    }

    getScatter(): number {
        return this.settingScatter;
    }

    getLockAlpha(): boolean {
        return this.settingLockLayerAlpha;
    }
}
