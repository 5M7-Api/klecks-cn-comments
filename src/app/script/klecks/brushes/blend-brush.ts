import { BB } from '../../bb/bb';
import { isLayerFill, TRgb, TRgba } from '../kl-types';
import { TIndexBounds, TPressureInput } from '../../bb/bb-types';
import { clamp, intersectBounds } from '../../bb/math/math';
import { BezierLine, TBezierLineCallback } from '../../bb/math/line';
import { HISTORY_TILE_SIZE, KlHistory } from '../history/kl-history';
import { getPushableLayerChange } from '../history/push-helpers/get-pushable-layer-change';
import { copyImageData } from '../utils/copy-image-data';
import { createArray } from '../../bb/base/base';
import { createImageDataTile } from '../history/image-data-tile';
import { getBinaryMask } from '../select-tool/get-binary-mask';
import { getMultiPolyBounds } from '../../bb/multi-polygon/get-multi-polygon-bounds';
import { getChangedTiles } from '../history/push-helpers/changed-tiles';

/**
 * 笔刷绘制缓冲区项 (Draw Buffer Item)
 * 记录单次笔印 (Brush Dot / Stamp) 所需的所有计算参数与渲染数据
 */
type TDrawBufferItem = {
    // 笔刷配置和尺寸
    x: number;
    y: number;
    size: number;
    opacity: number;

    // 像素包围盒边界索引 (整数像素坐标)
    // indices
    x1: number;
    y1: number;
    x2: number;
    y2: number;

    // 本次笔印最终算出的 RGB 颜色值 (0 ~ 255)
    r: number;
    g: number;
    b: number;
};

/**
 * 混色笔刷类 (Blend Brush)
 * 结合前景色与画布已有像素颜色的实时采样，实现类似湿画/油画混合效果的笔刷
 */
export class BlendBrush {
    // 测试模式标志：若为 true，绘制过程中不会实时重绘 Canvas，仅在笔划结束时统一刷新 (常用于自动化测试)
    // testing mode - context only gets updated when line is finished
    private isTesting: boolean = false;

    // 当前笔刷作用的目标图层的 Canvas 2D 渲染上下文
    private context: CanvasRenderingContext2D = {} as CanvasRenderingContext2D;
    // 当前笔刷作用的目标图层的唯一标识符 (ID)，默认为 'NOT_SET'
    private layerId: string = 'NOT_SET';
    // 笔刷的基本配置
    private color: TRgb = {} as TRgb;
    private size: number = 29; // radius - 0.5 - 99999
    private opacity: number = 0.6; // 0-1
    // 混色程度/混合比例 (0 ~ 1，默认 0.65)。0=完全前景色(不混色)，1=完全吸取画布颜色
    private blending: number = 0.65; // 0-1

    // 是否锁定图层 Alpha 通道 (透明度锁定)。为 true 时，仅能更改已有颜色的像素，不会绘制到空白透明区域
    private settingLockLayerAlpha: boolean = false;
    // 是否对笔刷尺寸应用压力感应 
    private settingSizePressure: boolean = true;
    // 是否对笔刷透明度应用压力感应 
    private settingOpacityPressure: boolean = false;

    // ------------------- 3. 混色算法内部状态变量 -------------------
    // 笔头积累动态颜色缓存 (RGBA)。沿笔划移动时，不断吸收画布背景的平均采样颜色
    private blendCol: TRgba = { r: 0, g: 0, b: 0, a: 1 }; // todo docs
    // 采样的背景色融合进 blendCol 时的权重系数 (固定为 0.45)
    private blendMix: number = 0.45; // todo docs
    // 经过混合插值后，本次笔印最终要渲染的插值目标色 (RGB)
    private mixCol: TRgb = { r: 0, g: 0, b: 0 }; // todo docs
    // 笔画上一个样点插值计算出的颜色快照，用于在贝塞尔曲线相邻两点间做平滑颜色过渡
    private localColOld: TRgba = {} as TRgba; // todo docs

    // 标识是否正在绘制笔划中 (startLine 到 endLine 之间的落笔状态)
    private isDrawing: boolean = false;
    // 上一次输入的触控/鼠标点信息 (坐标 x, y 以及压感 pressure)
    private lastInput: TPressureInput = { x: 0, y: 0, pressure: 0 }; // todo docs
    // 上上一次输入的触控/鼠标点信息 (用于阶梯贝塞尔平滑插值)
    private lastInput2: TPressureInput = { x: 0, y: 0, pressure: 0 }; // todo docs
    private bezierLine: undefined | BezierLine;

    private klHistory: KlHistory = {} as KlHistory;
    // 本次渲染需要更新/重绘到 Canvas 上的像素边界包围盒 (单次刷新区域)
    private redrawBounds: TIndexBounds | undefined;
    // 本次笔划触及的图层瓦片 (Tile) 的 ImageData 深拷贝快照数组 (防止实时 getImageData 阻塞及自我混色污染)
    private cells: (ImageData | undefined)[] = [];
    // 笔印 (Dot/Stamp) 绘制参数缓冲区队列
    private drawBuffer: TDrawBufferItem[] = [];

    // 当前活动选区 (MultiPolygon) 的像素包围盒 (用于裁剪超出选区的绘制)
    private selectionBounds: TIndexBounds | undefined;
    // 选区二进制掩码数组 (1 = 可绘制区域, 0 = 遮罩掩蔽区域)
    private mask: Uint8Array | undefined;

    /**
     * 更新并扩张累计需要重绘的边界包围盒 (Redraw Bounds)
     * @param bounds 本次印记/操作影响的像素包围盒
     */
    private updateRedrawBounds(bounds: TIndexBounds): void {
        // 1. 将本次影响区域与当前活动选区的包围盒求交集 (如果超出选区，超出部分不重绘)
        const boundsWithinSelection = intersectBounds(bounds, this.selectionBounds);
        if (!boundsWithinSelection) {
            // 不在选区范围内，无需更新重绘包围盒
            return;
        }
        // 2. 合并并扩张当前的 redrawBounds，确保其能够覆盖本次新变动的矩形区域
        this.redrawBounds = BB.updateBounds(this.redrawBounds, boundsWithinSelection);
    }

    /**
 * 获取当前 Canvas 宽度方向上的瓦片 (Tile) 列数
 * 例如 1024px 宽度的画布，HISTORY_TILE_SIZE(256px) 对应水平方向有 4 个瓦片
 */
    private getCellsWidth(): number {
        return Math.ceil(this.context.canvas.width / HISTORY_TILE_SIZE);
    }

    /**
 * 将指定瓦片数组中的 ImageData 重新绘制/刷回真实的 Canvas 2D 上下文中
 * @param cells 需要绘制的瓦片 ImageData 数组
 */
    /**
     * draw cells onto context
     * @param cells
     */
    private drawCells(cells: (ImageData | undefined)[]): void {
        const cellsW = this.getCellsWidth();
        // 未获得瓦片内容的跳过（历史记录里不存在）
        cells.forEach((imageData, index) => {
            if (!imageData) {
                return;
            }
            // 根据瓦片的一维索引 index 换算出二维网格的行列号，进而得到在 Canvas 上的绝对像素偏移量
            const cellOffsetX = (index % cellsW) * HISTORY_TILE_SIZE;
            const cellOffsetY = Math.floor(index / cellsW) * HISTORY_TILE_SIZE;
            // 将 ImageData 快速写入 DOM Canvas 的 2D 上下文
            this.context.putImageData(imageData, cellOffsetX, cellOffsetY);
        });
    }

    /**
  * 仅将本次笔划中被改动/触及到的瓦片重绘到 Canvas 上 (局部重绘优化)
  * @private
  */
    /**
     * draw changed cells (changed by brushstroke) onto context
     * @private
     */
    private drawChangedCells(): void {
        if (!this.redrawBounds) {
            return;
        }

        // 1. 创建一个等长的空瓦片临时数组
        const cells: typeof this.cells = this.cells.map(() => undefined);
        // 2. 算出行受本次 redrawBounds 影响的所有瓦片索引集合
        const touchedCells = this.getTouchedCells(this.redrawBounds);
        // 3. 筛选出受影响的瓦片，填充到临时数组中
        touchedCells.forEach((isTouched, index) => {
            if (isTouched) {
                cells[index] = this.cells[index];
            }
        });
        // 4. 将受影响的瓦片批量刷回 Canvas
        this.drawCells(cells);
        // 5. 重置重绘包围盒，为下一帧/下一次更新做准备
        this.redrawBounds = undefined;
    }

    /**
     * 根据传入的绝对像素包围盒 (bounds)，计算该包围盒触及/覆盖了哪些瓦片 (Tile)
     * @param bounds 绝对像素坐标形式的包围盒 {x1, y1, x2, y2} (以画布左上角 0,0 为基准)
     * @returns 布尔数组，长度等于总瓦片数，true 表示索引位置对应的瓦片被包围盒触及
     */
    private getTouchedCells(bounds: TIndexBounds): boolean[] {
        // 1. 初始化标记数组，长度与 this.cells 瓦片快照数组一致，默认全为 false
        const touchedCells = this.cells.map(() => false);
        const cellsW = this.getCellsWidth();

        // 2. 将【绝对像素坐标】转换为【瓦片网格坐标】(即瓦片的行列号)
        // 例如：0~255px 除以 256(HISTORY_TILE_SIZE) 向下取整得到第 0 列/行瓦片；256~511px 得到第 1 列/行瓦片
        bounds = {
            type: 'index',
            x1: Math.floor(bounds.x1 / HISTORY_TILE_SIZE),
            y1: Math.floor(bounds.y1 / HISTORY_TILE_SIZE),
            x2: Math.floor(bounds.x2 / HISTORY_TILE_SIZE),
            y2: Math.floor(bounds.y2 / HISTORY_TILE_SIZE),
        };
        // 3. 双重循环遍历矩形覆盖的所有瓦片网格坐标 [x1..x2] × [y1..y2]
        for (let i = bounds.x1; i <= bounds.x2; i++) {
            for (let e = bounds.y1; e <= bounds.y2; e++) {
                // 将二维网格坐标 (i列, e行) 展平换算为一维数组索引：index = e * cellsW + i
                touchedCells[e * cellsW + i] = true;
            }
        }
        return touchedCells;
    }

    /**
     * 将全局画布下的绝对像素包围盒 (bounds) 按照各个瓦片 (Cell / Tile) 进行裁剪拆分
     * 把一个跨越多个瓦片的大矩形，裁剪切割成多个小矩形，并将其坐标转换为瓦片内部的相对坐标 (0 ~ 255)
     * 
     * @param bounds 全局画布坐标系下的像素包围盒
     * @returns 拆切后的结果数组，每个元素包含：瓦片一维索引 (index) 及该瓦片内部的相对坐标包围盒 (bounds)
     * @private
     */
    /**
     * Slice up bounds according to cells
     * @param bounds
     * @private
     */
    private sliceBounds(bounds: TIndexBounds): { index: number; bounds: TIndexBounds }[] {
        // 1. 将传入的全局包围盒与活动选区 (Selection) 求交集 (过滤掉选区外的区域)
        const boundsWithinSelection = intersectBounds(bounds, this.selectionBounds);
        if (!boundsWithinSelection) {
            return [];
        }
        // 画布水平方向瓦片列数
        const cellsW = this.getCellsWidth();
        const result: { index: number; bounds: TIndexBounds }[] = [];
        // 2. 获取该包围盒触及到的所有瓦片索引列表
        const touchedCells = this.getTouchedCells(boundsWithinSelection);
        // 3. 遍历每一个被触及到的瓦片
        touchedCells.forEach((cell, i) => {
            if (!cell) {
                return;
            }

            // 计算当前瓦片 (第 i 个) 在全局画布上的绝对像素起始点 (X, Y)
            const cellOffsetX = (i % cellsW) * HISTORY_TILE_SIZE;
            const cellOffsetY = Math.floor(i / cellsW) * HISTORY_TILE_SIZE;
            // 获取当前瓦片的尺寸 (通常是HISTORY_TILE_SIZE × HISTORY_TILE_SIZE，边缘瓦片可能例外)
            const cellWidth = this.cells[i]!.width;
            const cellHeight = this.cells[i]!.height;
            // 4. 坐标转换关键步骤：
            // 将【全局绝对包围盒坐标】减去【瓦片起点偏移量】，转换为该瓦片【以 (0,0) 为左上角的内部相对坐标包围盒】
            // 并使用 Math.max/min 限制在 [0, cellWidth-1] / [0, cellHeight-1] 范围内
            const inCellBounds: TIndexBounds = {
                type: 'index',
                x1: Math.max(0, boundsWithinSelection.x1 - cellOffsetX),
                y1: Math.max(0, boundsWithinSelection.y1 - cellOffsetY),
                x2: Math.min(cellWidth - 1, boundsWithinSelection.x2 - cellOffsetX),
                y2: Math.min(cellHeight - 1, boundsWithinSelection.y2 - cellOffsetY),
            };
            // 5. 校验转换后的相对坐标有效性
            if (inCellBounds.x1 > inCellBounds.x2 || inCellBounds.y1 > inCellBounds.y2) {
                return;
            }
            // 6. 将拆切计算结果推入数组
            result.push({
                index: i,
                bounds: inCellBounds,
            });
        });

        return result;
    }

    /**
     * 按需从历史记录/画板合成器中，将笔画新触及区域的瓦片 ImageData 拷贝保存到 this.cells 快照数组中
     * @param bounds 本次笔印/笔画触及的绝对像素包围盒
     */
    /**
     * update copyImageData. copy over new regions if needed
     */
    private copyFromCanvas(bounds: TIndexBounds | undefined): void {
        if (!bounds) {
            return;
        }
        // 1. 获取包围盒涉及到的瓦片标记数组
        const touchedCells = this.getTouchedCells(bounds);
        // 2. 获取当前图层在【完整合成图层】(ComposedLayer) 中的状态数据
        const composedLayer = this.klHistory.getComposed().layerMap[this.layerId];

        touchedCells.forEach((item, i) => {
            // 如果该瓦片未被触及，或者之前已经被拷贝过了，直接跳过 (单次笔划内瓦片仅在首次触及时深拷贝一次)
            if (!item || this.cells[i]) {
                // not touched, or already copied
                return;
            }
            // Uncaught TypeError: Cannot read properties of undefined (reading 'tiles')
            const composedTile = composedLayer.tiles[i];
            // 情况 A: 如果该瓦片是未被修改过的纯色填充瓦片 (LayerFill)
            if (isLayerFill(composedTile)) {
                // 动态创建一个离屏 Canvas，填充纯色，然后提取其 ImageData
                const canvas = BB.canvas(HISTORY_TILE_SIZE, HISTORY_TILE_SIZE);
                const ctx = BB.ctx(canvas);
                ctx.fillStyle = composedTile.fill;
                ctx.fillRect(0, 0, HISTORY_TILE_SIZE, HISTORY_TILE_SIZE);
                // InvalidStateError: The object is in an invalid state.
                this.cells[i] = ctx.getImageData(0, 0, HISTORY_TILE_SIZE, HISTORY_TILE_SIZE);
            } else {
                // 情况 B: 瓦片已经有独立的像素数据，进行 Uint8ClampedArray 的物理深拷贝
                this.cells[i] = copyImageData(composedTile.data);
            }
        });
    }

    /**
  * 采样以 (x, y) 为中心、指定半径区域内的图像背景颜色，并计算透明度加权平均色彩 (RGBA)
  * @param x 采样中心点 X 坐标
  * @param y 采样中心点 Y 坐标
  * @param size 采样半径
  * @returns 采样区域内的加权平均颜色对象 { r, g, b, a }
  */
    private getAverage(x: number, y: number, size: number): TRgba {
        // 1. 缩小实际采样半径为 size * 0.75 (更聚焦于笔尖核心区域)，且最小不低于 0.5px
        size = Math.max(0.5, size * 0.75);
        // 2. 计算采样的包围盒，并限制在 Canvas 宽高范围内
        const x1 = Math.max(0, Math.floor(x - size));
        const y1 = Math.max(0, Math.floor(y - size));
        const x2 = Math.min(this.context.canvas.width - 1, Math.ceil(x + size));
        const y2 = Math.min(this.context.canvas.height - 1, Math.ceil(y + size));
        if (x1 > x2 || y1 > y2) {
            return { r: 0, g: 0, b: 0, a: 0 };
        }

        // RGB 及 Alpha 的累加器
        let ar = 0,
            ag = 0,
            ab = 0,
            aa = 0;

        // 3. 将采样大包围盒切割为各个瓦片内部的相对局部坐标分片 (slice
        const slicedBounds = this.sliceBounds({ type: 'index', x1, y1, x2, y2 });
        const cellsW = this.getCellsWidth();

        // 4. 遍历每一个相交的瓦片切片进行像素采样
        slicedBounds.forEach((slice) => {
            const cellOffsetX = (slice.index % cellsW) * HISTORY_TILE_SIZE;
            const cellOffsetY = Math.floor(slice.index / cellsW) * HISTORY_TILE_SIZE;
            const width = this.cells[slice.index]!.width;
            const data = this.cells[slice.index]!.data;
            const bounds = slice.bounds;
            // 双重循环遍历切片内部的相对坐标 (i: 相对Y, e: 相对X)
            for (let i = bounds.y1, globalY = i + cellOffsetY; i <= bounds.y2; i++, globalY++) {
                for (
                    let e = bounds.x1, globalX = e + cellOffsetX, e2 = (i * width + bounds.x1) * 4;
                    e <= bounds.x2;
                    e++, globalX++, e2 += 4
                ) {
                    // 如果存在选区遮罩，且当前全局坐标点位于选区外 (mask === 0)，跳过采样
                    if (
                        this.mask &&
                        this.mask[globalY * this.context.canvas.width + globalX] === 0
                    ) {
                        // don't same where the mask is 0
                        continue;
                    }

                    // 获取当前像素的 Alpha 透明度 (归一化为 0 ~ 1)
                    const alpha = data[e2 + 3] / 255;
                    if (alpha === 0) {
                        // 完全透明的像素不参与 RGB 颜色的加权计
                        continue;
                    }

                    // 以 Alpha 为权重归一累加 RGB 颜色及 Alpha 值
                    ar += data[e2] * alpha;
                    ag += data[e2 + 1] * alpha;
                    ab += data[e2 + 2] * alpha;
                    aa += alpha;
                }
            }
        });


        // 5. 计算透明度加权平均色彩
        if (aa !== 0) {
            ar /= aa;// 除以总 Alpha 权重，得到纯正的平均 RGB 颜色
            ag /= aa;
            ab /= aa;
            aa = Math.min(1, aa);
        }
        return { r: ar, g: ag, b: ab, a: aa };
    }

    /**
     * 计算以 (x, y) 为圆心、size 为半径的单个笔印 (Brush Dot / Stamp) 在 Canvas 上的像素包围盒
     * @param x 笔印圆心 X 坐标
     * @param y 笔印圆心 Y 坐标
     * @param size 笔印半径 (像素)
     * @returns 限制在 Canvas 有效区域内的像素包围盒对象；如果笔印完全绘制在画布外，返回 undefined
     */
    private getDotBounds(x: number, y: number, size: number): TIndexBounds | undefined {
        // 保证笔刷最小半径不低于 0.5 像素
        size = Math.max(0.5, size);
        // 1. 计算以 (x, y) 为圆心的外切正方形包围盒，并限制在 Canvas 物理边界 [0, width-1] × [0, height-1] 范围内
        const x1 = Math.max(0, Math.floor(x - size));
        const y1 = Math.max(0, Math.floor(y - size));
        const x2 = Math.min(this.context.canvas.width - 1, Math.ceil(x + size));
        const y2 = Math.min(this.context.canvas.height - 1, Math.ceil(y + size));
        // 2. 校验边界：若起点超过终点 (说明笔印整体画在了 Canvas 视口之外)，返回 undefined
        if (x1 > x2 || y1 > y2) {
            return undefined;
        }
        return { type: 'index', x1, y1, x2, y2 };
    }


    /**
     * 渲染单个笔印 (Dot / Stamp) 到 ImageData 快照的底层核心算法 (前半部分: 预计算与多重采样准备)
     * @param params 单个笔印的绘图参数 (坐标、尺寸、透明度、RGB 及包围盒)
     */
    private drawDot(params: TDrawBufferItem): void {
        // ---------------- 1. 伪随机数查找表初始化 (优化性能与消除色彩断层) ----------------
        // array with random numbers. faster than Math.random()
        let randI = 0;
        // 笔刷半径大于 30px 时使用 1024 长度的随机数组，小笔刷使用 512，避免产生可辨识的重复噪点图案
        const randLen = params.size > 30 ? 1024 : 512; // lower lengths lead to noticeable patterns
        const randArr: number[] = [];
        // 预先生成 [-0.5, 0.5] 范围附近的伪随机浮点数，避免在接下来的成千上万次像素循环中调用昂贵的 Math.random()
        for (let i = 0; i < randLen; i++) {
            randArr[i] = (Math.random() - 0.5) / 1.001 + 0.5;
        }

        // ---------------- 2. 细线条子像素多重采样 (Sub-pixel Supersampling) ----------------
        // 针对半径极小的笔划 (如直径 < 5px)，如果只采样像素中心点会导致严重锯齿或画线断裂
        // sampleArr 根据笔印直径 (params.size * 2) 查表确定单像素内的子采样点阵列密度
        // thin lines take more than just 1 sample
        const sampleArr = [8, 4, 4, 4, 2, 2, 2, 2, 2, 2]; // <0.5, 0.5, 1, 1.5, etc.
        const samples = sampleArr[Math.floor(params.size * 2)];
        const samplesSquared: number = samples ? samples * samples : 0;
        const sampleOffsets: number[] = [];
        if (samples) {
            let i = 0;
            for (let n = 0; n < samples; n++) {
                for (let m = 0; m < samples; m++, i += 2) {
                    sampleOffsets[i] = (n + 1) / samples; // x offset
                    sampleOffsets[i + 1] = (m + 1) / samples; // y offset
                }
            }
        }

        // ---------------- 3. 笔印边缘硬度与距离衰减公式预推导 ----------------
        // sharpness: 笔刷边缘硬度系数 (不透明度越低，硬度指数越小，边缘越羽化)
        const sharpness = Math.pow(params.opacity, 2) * 0.8;
        // to optimize calculations
        const invSharpness = 1 - sharpness;
        const sharpnessSubtrahend = sharpness / invSharpness;
        // 半径平方 (避免在百万次像素循环中调用开根号 Math.sqrt)
        const sizeSquared = params.size * params.size;
        // 提前预算出距离衰减分母与 Alpha 衰减被减数，避免在像素循环内重复做乘除法
        const distDivisor = (sizeSquared * invSharpness) / params.opacity;
        const alphaMinuend = (1 + sharpnessSubtrahend) * params.opacity;
        // 4. 将笔印大包围盒切割映射为各个瓦片 (Tile) 内部的局部相对坐标矩形切片
        const slicedBounds = this.sliceBounds({
            type: 'index',
            x1: params.x1,
            y1: params.y1,
            x2: params.x2,
            y2: params.y2,
        });

        const cellsW = this.getCellsWidth();
        // 5. 遍历受笔印影响的每一个瓦片
        slicedBounds.forEach((slice) => {
            const cellOffsetX = (slice.index % cellsW) * HISTORY_TILE_SIZE;
            const cellOffsetY = Math.floor(slice.index / cellsW) * HISTORY_TILE_SIZE;
            const cellWidth = this.cells[slice.index]!.width;
            const data = this.cells[slice.index]!.data;
            // i: 瓦片内部相对 Y 坐标 [bounds.y1 .. bounds.y2]
            // e: 瓦片内部相对 X 坐标 [bounds.x1 .. bounds.x2]
            // ri: 当前像素相对于笔印圆心的绝对 Y 轴距离 (px)
            // re: 当前像素相对于笔印圆心的绝对 X 轴距离 (px)
            // e2: 当前像素在 ImageData.data 字节数组中的基准索引 (Index = (y * width + x) * 4)
            // mi: 当前像素在活动选区遮罩 mask 中的索引

            // i - y index within cell
            // e - x index within cell

            // e2 - index in image data (a tile)
            // mi - index in mask (one mask for the entire image)

            // ri - y index within image relative to dot-center
            // re - x index within image relative to dot-center

            for (
                let i = slice.bounds.y1, ri = i + cellOffsetY - params.y;
                i <= slice.bounds.y2;
                i++, ri++
            ) {
                for (
                    let e = slice.bounds.x1,
                    mi =
                        (i + cellOffsetY) * this.context.canvas.width +
                        (slice.bounds.x1 + cellOffsetX),
                    e2 = (i * cellWidth + slice.bounds.x1) * 4,
                    re = e + cellOffsetX - params.x;
                    e <= slice.bounds.x2;
                    e++, mi++, e2 += 4, re++
                ) {
                    // 如果存在活动选区，且当前像素落在选区遮罩之外 (mask === 0)，直接跳过不绘制
                    if (this.mask && this.mask[mi] === 0) {
                        continue;
                    }

                    // O = over -> brush-dot
                    // U = under -> image

                    // ---------------- 6. 计算笔刷印记在当前像素处的 Alpha (alphaO) ----------------
                    // 约定: O = Over (上层笔刷印记), U = Under (底图原有像素)
                    let alphaO = 0;
                    if (samplesSquared) {
                        // 【分支 A: 细线条多重采样】遍历当前像素内部的网格子采样点
                        for (let f = 0; f < sampleOffsets.length; f += 2) {
                            const dist = BB.lenSquared(
                                re + sampleOffsets[f],
                                ri + sampleOffsets[f + 1],
                            );
                            if (dist >= sizeSquared) {
                                // 超出笔刷圆周半项范围，跳过该子点
                                continue;
                            }
                            // 按照硬度衰减公式累加子像素 Alpha
                            alphaO += clamp(alphaMinuend - dist / distDivisor, 0, params.opacity);
                        }
                        if (!alphaO) {
                            continue;
                        }
                        alphaO /= samplesSquared;
                    } else {
                        // 【分支 B: 普通笔刷中心点采样】直接计算中心点距平方
                        // technically needs + 0.5 offset, but not noticeable with large brush
                        const dist = Math.pow(re, 2) + Math.pow(ri, 2);
                        if (dist >= sizeSquared) {
                            continue; // 所在子采样点均未落在笔刷圆内，跳过
                        }
                        // 边缘二次方硬度衰减计算
                        alphaO = clamp(alphaMinuend - dist / distDivisor, 0, params.opacity);
                    }

                    // 笔刷透过的透明度反比例 (1 - alphaO)
                    const invAlphaO = 1 - alphaO;
                    // 底图当前像素原有的 Alpha (归一化为 0 ~ 1)
                    const alphaU = data[e2 + 3] / 255;

                    // ---------------- 7. 标准 Porter-Duff Alpha-Over 图像合成 ----------------
                    if (this.settingLockLayerAlpha) {
                        // 【合成模式一：锁定 Alpha (透明度锁定)】
                        // 图层原有 Alpha 不变，仅按笔刷 Alpha 比例融合 RGB 通道
                        const underR = params.r * alphaO + data[e2] * invAlphaO;
                        const underG = params.g * alphaO + data[e2 + 1] * invAlphaO;
                        const underB = params.b * alphaO + data[e2 + 2] * invAlphaO;
                        if (alphaU) {
                            // 仅当底层存在色彩内容时写回
                            data[e2] = Math.floor(underR + randArr[randI]);
                            data[e2 + 1] = Math.floor(underG + randArr[randI]);
                            data[e2 + 2] = Math.floor(underB + randArr[randI]);
                        }
                    } else {
                        // 【合成模式二：标准 Alpha-Over 图像混合】
                        // 步骤1: 算上层笔画与底层颜色结合后的未解算 RGB 混合项 (Premultiplied RGB)
                        const underR = params.r * alphaO + data[e2] * alphaU * invAlphaO;
                        const underG = params.g * alphaO + data[e2 + 1] * alphaU * invAlphaO;
                        const underB = params.b * alphaO + data[e2 + 2] * alphaU * invAlphaO;
                        // 步骤2: 标准 Alpha 混合合成公式: A_new = 1 - (1 - A_over) * (1 - A_under)
                        const newAlpha = 1 - invAlphaO * (1 - alphaU);
                        data[e2 + 3] = Math.floor(Math.min(255, newAlpha * 255) + 0.5);
                        // 步骤3: 解算无预乘 (Un-premultiplied) 的真实 RGB，并加上伪随机数做 Dithering 抖动
                        if (newAlpha) {
                            data[e2] = Math.floor(underR / newAlpha + randArr[randI]);
                            data[e2 + 1] = Math.floor(underG / newAlpha + randArr[randI]);
                            data[e2 + 2] = Math.floor(underB / newAlpha + randArr[randI]);
                        }
                    }
                    // 循环推进伪随机数索引，提供平滑抖动
                    randI = (randI + 1) % randLen;
                }
            }
        });
    }

    /**
     * 动态计算笔刷沿绘制路径的步长间距 (Spacing)
     * 笔刷越小，间距比例越大；笔刷越大，间距比例越密，确保笔划连续流畅无圆圈锯齿感
     * @param size 当前笔刷半径
     * @returns 笔印放置的像素间隔距离 (px)
     */
    private calcSpacing(size: number): number {
        return BB.mix(
            // 细笔刷 (半径 < 2.7px) 时：间距为直径的 1/2 (50%)
            (size * 2) / 2, // until size 5.3
            // 大笔刷 (半径 > 12px) 时：间距收紧为直径的 1/9 (约 11%)
            (size * 2) / 9, // at size 24
            // 在 2.7px 到 12px 尺寸区间平滑插值
            clamp((size - 2.7) / (12 - 2.7), 0, 1),
        );
    }

    /**
     * 笔划持续绘制的主调度函数 (沿笔尖移动轨迹进行贝塞尔插值、采样混色与像素批处理)
     * @param x 当前输入点的 X 坐标 (若为 undefined 则表示抬笔前的收尾绘制)
     * @param y 当前输入点的 Y 坐标
     * @param p 压感数值 (0 ~ 1)
     * @param isCoalesced 是否为浏览器合并的高频指针事件 (如果是，则跳过重复背景采样)
     */
    private continueLine(
        x: number | undefined,
        y: number | undefined,
        p: number,
        isCoalesced: boolean,
    ): void {
        // 清空上一次的笔印绘制缓冲区
        this.drawBuffer = [];

        let localPressure;
        let localOpacity;
        // 计算结合压感后的实际笔刷半径尺寸
        let localSize = this.settingSizePressure
            ? Math.max(1, p * this.size)
            : Math.max(1, this.size);

        // 动态计算本次插值的像素距离间隔
        const bDist = this.calcSpacing(localSize);

        const avgX = x === undefined ? this.lastInput.x : x;
        const avgY = y === undefined ? this.lastInput.y : y;

        let localColNew: TRgba;

        // ---------------- 1. 动态背景采样与笔头调色 ----------------
        if (this.blending === 0) {
            // 不开启混色 (blending=0)：直接使用设定的前景色
            this.mixCol.r = this.color.r;
            this.mixCol.g = this.color.g;
            this.mixCol.b = this.color.b;
        } else {
            let average;
            if (isCoalesced) {
                // 如果是合并的高频点，直接复用上个点的采样快照，降低 CPU 性能开销
                average = {
                    r: this.localColOld.r,
                    g: this.localColOld.g,
                    b: this.localColOld.b,
                    a: 0,
                };
            } else {
                // 计算采样包围盒，确保对应的瓦片已经从历史记录拷贝出来
                const avgParams = [
                    avgX,
                    avgY,
                    this.settingSizePressure
                        ? Math.max(0.5, p * this.size)
                        : Math.max(0.5, this.size),
                ];
                const bounds = this.getDotBounds(avgParams[0], avgParams[1], avgParams[2]);
                if (bounds) {
                    this.copyFromCanvas(bounds);
                }
                // 调用 getAverage 采样落笔点的加权平均背景色
                average = this.getAverage(avgParams[0], avgParams[1], avgParams[2]);
            }
            localColNew = { r: 0, g: 0, b: 0, a: 0 };

            if (average.a > 0 && this.blendCol.a === 0) {
                // 笔头原本没有颜料，落笔首次接触画布：笔头沾上背景色
                this.blendCol.r = average.r;
                this.blendCol.g = average.g;
                this.blendCol.b = average.b;
                this.blendCol.a = average.a;
                localColNew.r = this.blendCol.r;
                localColNew.g = this.blendCol.g;
                localColNew.b = this.blendCol.b;
                localColNew.a = this.blendCol.a;
            } else {
                if (average.a === 0) {
                    // 画布背景透明：以设定的前景色作为假想背景，并补全透明度比例
                    average.r = this.color.r;
                    average.g = this.color.g;
                    average.b = this.color.b;
                    average.a = 1 - this.blending;
                }

                // 核心调色算法：将采样的背景色 average 以 blendMix(0.45) 权重融合进笔头的动态颜料 blendCol
                this.blendCol.r = BB.mix(
                    this.blendCol.r,
                    BB.mix(this.blendCol.r, average.r, this.blendMix),
                    average.a,
                );
                this.blendCol.g = BB.mix(
                    this.blendCol.g,
                    BB.mix(this.blendCol.g, average.g, this.blendMix),
                    average.a,
                );
                this.blendCol.b = BB.mix(
                    this.blendCol.b,
                    BB.mix(this.blendCol.b, average.b, this.blendMix),
                    average.a,
                );
                this.blendCol.a = Math.min(1, this.blendCol.a + average.a);
                localColNew.r = this.blendCol.r;
                localColNew.g = this.blendCol.g;
                localColNew.b = this.blendCol.b;
                localColNew.a = this.blendCol.a;
            }
        }

        // ---------------- 2. 贝塞尔插值点回调 (按步长生成平滑印记数据) ----------------
        const bezierCallback: TBezierLineCallback = (val) => {
            if (this.blending >= 1 && this.blendCol.a <= 0) {
                // 完全混色模式且笔头无颜料时，静默不绘制
                return;
            }
            const factor = val.t;
            localPressure = this.lastInput2.pressure * (1 - factor) + p * factor;
            localOpacity = this.settingOpacityPressure
                ? this.opacity * localPressure * localPressure
                : this.opacity;
            localSize = this.settingSizePressure
                ? Math.max(0.1, localPressure * this.size)
                : Math.max(0.1, this.size);
            if (this.blending != 0) {
                // 平滑过渡相邻两点间的混合颜色
                this.mixCol.r = BB.mix(this.localColOld.r, localColNew.r, factor);
                this.mixCol.g = BB.mix(this.localColOld.g, localColNew.g, factor);
                this.mixCol.b = BB.mix(this.localColOld.b, localColNew.b, factor);
            }
            if (this.blending === 1 && this.localColOld.a === 0) {
                this.mixCol.r = localColNew.r;
                this.mixCol.g = localColNew.g;
                this.mixCol.b = localColNew.b;
            }
            // 计算该插值点的像素包围盒，并生成绘制项推入 drawBuffer
            const bounds = this.getDotBounds(val.x, val.y, localSize);
            if (bounds) {
                this.updateRedrawBounds(bounds); // 扩大 Canvas 刷新区域
                this.drawBuffer.push({
                    x: val.x,
                    y: val.y,
                    size: localSize,
                    opacity: localOpacity,
                    x1: bounds.x1,
                    y1: bounds.y1,
                    x2: bounds.x2,
                    y2: bounds.y2,
                    // 将设定的前景色 (this.color) 与插值混合色 (mixCol) 按照 blending 比例混合
                    r: BB.mix(this.color.r, this.mixCol.r, this.blending),
                    g: BB.mix(this.color.g, this.mixCol.g, this.blending),
                    b: BB.mix(this.color.b, this.mixCol.b, this.blending),
                });
            }
        };

        // ---------------- 3. 驱动贝塞尔平滑线，并执行批量渲染 ----------------
        if (x === undefined || y === undefined) {
            this.bezierLine!.addFinal(bDist, bezierCallback);
        } else {
            this.bezierLine!.add(x, y, bDist, bezierCallback);
        }

        // 确保本次重绘用到的所有瓦片已完成快照深拷贝
        this.copyFromCanvas(this.redrawBounds);
        // 批处理遍历绘制缓冲区中的每个笔印点
        this.drawBuffer.forEach((item) => {
            this.drawDot(item);
        });
        this.drawBuffer = []; // 清空缓冲区

        if (this.blending !== 0) {
            // 保存本次点的混合色供下一个点平滑插值使用
            this.localColOld = localColNew!;
        }
    }

    // ----------------------------------- public -----------------------------------
    constructor() { }

    setHistory(klHistory: KlHistory): void {
        this.klHistory = klHistory;
    }

    getSize(): number {
        return this.size;
    }

    setSize(s: number): void {
        this.size = s;
    }

    getOpacity(): number {
        return this.opacity;
    }

    setOpacity(o: number): void {
        this.opacity = o;
    }

    getBlending(): number {
        return this.blending;
    }

    setBlending(b: number): void {
        this.blending = b;
    }

    setColor(c: TRgb): void {
        this.color = BB.copyObj(c);
    }

    setContext(c: CanvasRenderingContext2D, id: string): void {
        this.context = c;
        this.layerId = id;
    }

    setSizePressure(b: boolean): void {
        this.settingSizePressure = b;
    }

    setOpacityPressure(b: boolean): void {
        this.settingOpacityPressure = b;
    }

    getLockAlpha(): boolean {
        return this.settingLockLayerAlpha;
    }

    setLockAlpha(b: boolean): void {
        this.settingLockLayerAlpha = b;
    }

    getIsDrawing(): boolean {
        return this.isDrawing;
    }

    setIsTesting(b: boolean): void {
        this.isTesting = b;
    }

    /**
     * 当用户落笔 (pointerdown / mousedown) 时调用的首帧初始化函数
     * 负责初始化选区遮罩、重置瓦片快照数组、提取落笔点背景色、绘制首个笔印并启动贝塞尔平滑线
     * 
     * @param x 落笔点 X 坐标
     * @param y 落笔点 Y 坐标
     * @param p 落笔点初始压感 (0 ~ 1)
     */
    startLine(x: number, y: number, p: number): void {
        // ---------------- 1. 初始化选区遮罩与瓦片快照数组 ----------------
        const selection = this.klHistory.getComposed().selection.value;
        // 获取多边形选区的像素包围盒
        this.selectionBounds = selection ? getMultiPolyBounds(selection, 'index') : undefined;
        // 生成 0/1 选区二进制像素遮罩 (用于后续像素级选区裁剪)
        this.mask = selection
            ? getBinaryMask(selection, this.context.canvas.width, this.context.canvas.height)
            : undefined;
        // 计算画布总瓦片数，创建一个全为 undefined 的空瓦片快照数组 this.cells
        const totalCells =
            Math.ceil(this.context.canvas.width / HISTORY_TILE_SIZE) *
            Math.ceil(this.context.canvas.height / HISTORY_TILE_SIZE);
        this.cells = createArray(totalCells, undefined);

        this.isDrawing = true;

        // ---------------- 2. 计算首帧压感、尺寸与初始混色 ----------------
        p = Math.max(0, Math.min(1, p)); // 限制压感在 0~1 范围内
        const localOpacity = this.settingOpacityPressure ? this.opacity * p * p : this.opacity;
        const localSize = this.settingSizePressure
            ? Math.max(0.1, p * this.size)
            : Math.max(0.1, this.size);
        if (this.blending === 0) {
            // 不开启混色：混合色直接等于设定的前景色
            this.mixCol.r = this.color.r;
            this.mixCol.g = this.color.g;
            this.mixCol.b = this.color.b;
        } else {
            // 开启混色：先按需拷贝落笔点覆盖的瓦片 ImageData
            this.copyFromCanvas(this.getDotBounds(x, y, localSize));

            // 采样落笔点位置的背景平均颜色
            const average = this.getAverage(
                x,
                y,
                this.settingSizePressure ? Math.max(0.1, p * this.size) : Math.max(0.1, this.size),
            );
            if (average.a === 0) {
                // 如果落笔点背景完全透明：以设定的前景色初始化笔头，并根据混色比例设置初始透明度
                this.blendCol = {
                    r: this.color.r,
                    g: this.color.g,
                    b: this.color.b,
                    a: 1 - this.blending,
                };
            } else {
                // 如果落笔点有颜色：笔头直接“沾”上落笔点的背景色
                this.blendCol = {
                    r: average.r,
                    g: average.g,
                    b: average.b,
                    a: average.a,
                };
            }

            this.mixCol.r = this.blendCol.r;
            this.mixCol.g = this.blendCol.g;
            this.mixCol.b = this.blendCol.b;
        }

        // 初始化上一个样点的颜色快照，供后续移动中的贝塞尔插值使用
        this.localColOld = {
            r: this.mixCol.r,
            g: this.mixCol.g,
            b: this.mixCol.b,
            a: this.blendCol.a,
        };

        this.redrawBounds = undefined;
        this.drawBuffer = [];

        // 初始化上一个样点的颜色快照，供后续移动中的贝塞尔插值使用
        if (this.blending < 1 || this.blendCol.a > 0) {
            const bounds = this.getDotBounds(x, y, localSize);
            if (bounds) {
                this.updateRedrawBounds(bounds);
                // 生成首帧笔印数据，推入绘制缓冲区
                this.drawBuffer.push({
                    x: x,
                    y: y,
                    size: localSize,
                    opacity: localOpacity,
                    x1: bounds.x1,
                    y1: bounds.y1,
                    x2: bounds.x2,
                    y2: bounds.y2,
                    r: BB.mix(this.color.r, this.mixCol.r, this.blending),
                    g: BB.mix(this.color.g, this.mixCol.g, this.blending),
                    b: BB.mix(this.color.b, this.mixCol.b, this.blending),
                });
            }
        }

        // 刷新首帧瓦片并渲染首印到 ImageData 快照中
        this.copyFromCanvas(this.redrawBounds);
        this.drawBuffer.forEach((item) => {
            this.drawDot(item);
        });
        this.drawBuffer = [];

        // ---------------- 4. 创建贝塞尔平滑采样器并记录首点输入 ----------------
        this.bezierLine = new BB.BezierLine();
        this.bezierLine.add(x, y, 0, function () { });

        this.lastInput.x = x;
        this.lastInput.y = y;
        this.lastInput.pressure = p;
        this.lastInput2 = BB.copyObj(this.lastInput);

        // 如果不是测试模式，立即将首帧改动的瓦片刷到 DOM Canvas 上呈现给用户
        if (!this.isTesting) {
            this.drawChangedCells();
        }
    }

    goLine(x: number, y: number, p: number, isCoalesced: boolean): void {
        if (!this.isDrawing) {
            return;
        }
        this.continueLine(x, y, this.lastInput.pressure, isCoalesced);

        this.lastInput2 = BB.copyObj(this.lastInput);
        this.lastInput.x = x;
        this.lastInput.y = y;
        this.lastInput.pressure = p;

        if (!this.isTesting) {
            this.drawChangedCells();
        }
    }

    endLine(): void {
        if (this.bezierLine) {
            this.continueLine(undefined, undefined, this.lastInput.pressure, false);
        }

        this.isDrawing = false;
        this.bezierLine = undefined;

        this.drawChangedCells();

        if (this.cells.some((item) => item)) {
            let cells = this.cells;
            if (this.selectionBounds) {
                const tilesInSelection = getChangedTiles(
                    this.selectionBounds,
                    this.context.canvas.width,
                    this.context.canvas.height,
                );
                cells = cells.map((cell, index) => {
                    return tilesInSelection[index] ? cell : undefined;
                });
            }

            this.klHistory.push(
                getPushableLayerChange(
                    this.klHistory.getComposed(),
                    cells.map((cell) => {
                        return cell ? createImageDataTile(cell) : undefined;
                    }),
                ),
            );
        }
        this.cells = [];
    }

    drawLineSegment(x1: number, y1: number, x2: number, y2: number): void {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const steps = Math.ceil(distance / 10);

        this.startLine(x1, y1, 1);

        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const xi = x1 + dx * t;
            const yi = y1 + dy * t;
            this.goLine(xi, yi, 1, false);
        }

        this.endLine();
    }
}
