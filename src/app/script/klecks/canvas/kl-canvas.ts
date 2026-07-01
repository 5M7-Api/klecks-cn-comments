import { BB } from '../../bb/bb';
import { floodFillBits } from '../image-operations/flood-fill';
import { drawShape } from '../image-operations/shape-tool';
import { renderText, TRenderTextParam } from '../image-operations/render-text';
import {
    isLayerFill,
    TFillSampling,
    TGradient,
    TInterpolationAlgorithm,
    TKlProject,
    TLayerFromKlCanvas,
    TMixMode,
    TRgb,
    TShapeToolObject,
} from '../kl-types';
import { drawProject } from './draw-project';
import { LANG } from '../../language/language';
import { drawGradient } from '../image-operations/gradient-tool';
import { MultiPolygon } from 'polygon-clipping';
import { compose, identity, Matrix, rotate, scale, translate } from 'transformation-matrix';
import { getSelectionPath2d } from '../../bb/multi-polygon/get-selection-path-2d';
import { transformMultiPolygon } from '../../bb/multi-polygon/transform-multi-polygon';
import { getMultiPolyBounds } from '../../bb/multi-polygon/get-multi-polygon-bounds';
import { coordinateBoundsToIndexBounds, rectToBounds } from '../../bb/math/math';
import { matrixToTuple } from '../../bb/math/matrix-to-tuple';
import { getEraseColor } from '../brushes/erase-color';
import { HISTORY_TILE_SIZE, KlHistory } from '../history/kl-history';
import { getNextLayerId } from '../history/get-next-layer-id';
import {
    THistoryEntryDataComposed,
    THistoryEntryLayerComposed,
    TLayerId,
} from '../history/history.types';
import { createFillColorTiles } from '../history/create-fill-color-tiles';
import { updateLayersViaComposed } from './update-layers-via-composed';
import { isHistoryEntryOpacityChange } from '../history/push-helpers/is-history-entry-opacity-change';
import { isHistoryEntryVisibilityChange } from '../history/push-helpers/is-history-entry-visibility-change';
import { transformCoordinateBounds } from '../../bb/transform/transform-coordinate-bounds';
import { createLayerMap } from '../history/push-helpers/create-layer-map';
import { Eyedropper } from './eyedropper';
import { copyImageDataTile } from '../history/image-data-tile';
import { randomUuid } from '../../bb/base/base';
import { translateMultiPolygon } from '../../bb/multi-polygon/translate-multi-polygon';
import { getBinaryMask } from '../select-tool/get-binary-mask';
import { TIndexBounds } from '../../bb/bb-types';

// 限制最大图层数，防止浏览器内存溢出
export const MAX_LAYERS = 16;

/**
 * 核心数据结构：单个图层 (Layer) 的定义
 * 在 Klecks 中，每个图层物理上都对应着一个完全独立的 <canvas> 元素。
 */
export type TKlCanvasLayer = {
    // 图层的唯一标识符（字符串，通常随机生成，用于在历史记录中精确追踪）
    id: TLayerId;
    // 当前图层在堆叠顺序中的序号 (0 代表最底层的背景层)
    index: number; // certain brushes need to know
    // 图层的显示名称（如 "Layer 1", "线稿"）
    name: string;
    mixModeStr: TMixMode;
    isVisible: boolean;
    opacity: number;
    // compositeObj 用于处理特殊的图层合成逻辑。
    // 如果存在，在最终把所有图层拍扁 (Composite) 到屏幕上时，会调用它的 draw 方法，而不是简单的 drawImage。
    compositeObj?: TLayerComposite;
    // 该图层专属的、存在于内存中的原生 canvas 元素
    canvas: HTMLCanvasElement;
    // 用于在该层绘图的 2D 上下文 (画笔就是在这个 context 上画画)
    context: CanvasRenderingContext2D;
};

export type TLayerComposite = {
    draw: (ctx: CanvasRenderingContext2D) => void;
};

// 画布调试开关，开启后可以通过浏览器控制台访问 KlCanvas 实例的图层数据（getCanvasLayers()）以进行调试。
// const KL_CANVAS_DEBUGGING = false;
const KL_CANVAS_DEBUGGING = true;

/**
 * 绘画引擎的【中枢调度器】：KlCanvas
 * The image/canvas that the user paints on.
 * 它管理所有的图层 (layers)，以及与历史记录系统 (klHistory) 深度交互。
 */
/**
 * The image/canvas that the user paints on
 * Has layers. layers have names and opacity.
 *
 * Interacts with klHistory
 */
export class KlCanvas {
    // 防止实例被销毁后仍然被调用引发内存泄漏
    private isDestroyed = false;
    // 画布的物理尺寸（宽度和高度）
    private width: number;
    private height: number;
    // 核心状态：存储当前画布上所有的图层对象
    private layers: TKlCanvasLayer[];
    // 取色器/滴管工具实例（因为取色需要跨越所有图层读取最终颜色，必须在总调度器里持有）
    private eyedropper: Eyedropper;
    // 当前画布全局激活的复杂异形选区
    private selection: undefined | MultiPolygon = undefined;
    // 绑定的历史记录栈控制器
    private readonly klHistory: KlHistory;

    /**
     * 内部辅助方法：重新计算所有图层的 index
     * 当图层发生新增、删除、排序(拖拽移动) 时必须调用。
     * 确保 layer.index 始终与其在 this.layers 数组中的位置保持一致。
     */
    private updateIndices(): void {
        this.layers.forEach((item, index) => {
            item.index = index;
        });
    }

    // ----------------------------------- public -----------------------------------
    /**
     * 构造函数：初始化绘画引擎的中枢
     * @param history 历史记录/撤销重做管理器
     * @param layerNrOffset 图层序号偏移量（通常用于UI显示层级名称时的基数计算）
     */
    constructor(
        history: KlHistory,
        private layerNrOffset: number = 0,
    ) {
        this.klHistory = history;
        this.layers = [];
        if (KL_CANVAS_DEBUGGING) {
            (window as any).getCanvasLayers = () => this.layers;
        }
        // 取色器工具
        this.eyedropper = new Eyedropper();
        this.width = 0;
        this.height = 0;
        // 赋予一个初始的“虚无”状态，确保所有内部变量和历史记录系统有一个合法的起点
        this.updateViaComposed(
            {
                projectId: { value: randomUuid() },
                size: { width: 0, height: 0 },
                activeLayerId: '',
                selection: { value: [] },
                layerMap: {},
            },
            this.klHistory.getComposed(),
        );
    }

    /**
     * 重置画布：用于“新建画布”、“打开工程文件”或“导入图片”
     * 除非传入了多图层数据 (p.layers)，否则默认重置为一个100%透明度的单图层。
     */
    /*
     * Resets canvas -> 1 layer, 100% opacity,
     * unless layers provided.
     * @param p
     */
    reset(p: {
        projectId?: string; // uuid
        width: number;
        height: number;
        // 可选 - 用于填满底层的背景色
        color?: TRgb; // optional - fill color
        // 可选 - 直接画在图层上的图像
        image?: HTMLImageElement | HTMLCanvasElement; // image drawn on layer
        // 如果是通过导入图片创建，可以指定图层名称
        layerName?: string; // if via image
        layers?: {
            id: TLayerId;
            name: string;
            isVisible: boolean;
            opacity: number;
            mixModeStr: TMixMode;
            image: HTMLCanvasElement;
        }[];
    }): number {
        // 1. 严格的参数校验：尺寸必须合法，否则会导致底层 Canvas API 崩溃 (InvalidStateError)
        if (
            !p.width ||
            !p.height ||
            p.width < 1 ||
            p.height < 1 ||
            isNaN(p.width) ||
            isNaN(p.height)
        ) {
            throw new Error('invalid canvas size');
        }

        // 2. 更新全局尺寸
        this.width = p.width;
        this.height = p.height;
        this.selection = undefined;// 新建/加载工程时，清空套索选区

        // 3. 剥离旧图层：保留图层栈的第 0 层，删掉上面的所有额外图层，为重置腾出空间
        this.layers.splice(1, Math.max(0, this.layers.length - 1));

         // ! 关键操作：暂停历史记录记录。
        // 在组装新画布期间，不触发任何 Undo/Redo 的切片追踪。
        this.klHistory.pause(true);
        // ? 这段代码catch吗？
        try {
            if (p.layers) {
                // --- 场景 A：加载多图层的工程文件 ---
                for (let i = 0; i < p.layers.length; i++) {
                    const pItem = p.layers[i];
                    // 如果现有的图层数量不够，动态向引擎添加新图层
                    if (!this.layers[i]) {
                        this.addLayer();
                    }
                    const layer = this.layers[i];
                    // 完美复刻保存时的元数据
                    layer.id = pItem.id;
                    layer.name = pItem.name;
                    layer.isVisible = pItem.isVisible;
                    layer.mixModeStr = pItem.mixModeStr ? pItem.mixModeStr : 'source-over';
                    // 调整该图层独立的 canvas DOM 元素的物理宽高
                    layer.canvas.width = this.width;
                    layer.canvas.height = this.height;
                    // 把保存的图层像素图像 (pItem.image) 啪地一下拍到这个图层上
                    layer.context.drawImage(pItem.image, 0, 0);
                    // 恢复透明度 (这里通常还会触发 UI 的更新)
                    this.setOpacity(i, pItem.opacity);
                }
            } else {
                // --- 场景 B：新建空白画板 或 导入单张图片 ---
                const layer = this.layers[0];// 直接使用唯一保留的底图层
                layer.name = p.layerName ? p.layerName : LANG('layers-layer') + ' 1';
                layer.isVisible = true;
                layer.canvas.width = this.width;
                layer.canvas.height = this.height;
                layer.mixModeStr = 'source-over';
                this.setOpacity(0, 1);
                if (p.color) {
                    // 用户新建文件时选了背景色 (如纯白)
                    this.layerFill(0, p.color);
                } else if (p.image) {
                    // 用户拖拽了一张 JPG 图片进来
                    layer.context.drawImage(p.image, 0, 0);
                }
            }
        } finally {
            // 无论加载成功还是报错（比如内存不够导致崩溃），都必须确保恢复历史记录监听
            this.klHistory.pause(false);
        }
        // 重建层级索引体系
        this.updateIndices();

        // 4. 提交“基准快照 (Composed Snapshot)”
        if (!this.klHistory.isPaused()) {
            // 1. 生成历史记录数据对象
            const historyEntryData: THistoryEntryDataComposed = {
                projectId: {
                    // 如果传入了 projectId 则使用，否则生成新的 UUID
                    value: p.projectId ?? randomUuid(),
                },
                size: {
                    width: this.width,
                    height: this.height,
                },
                selection: { value: this.selection },
                 // 默认将焦点激活在最上面的那层图层
                activeLayerId: this.layers[this.layers.length - 1].id,
               // 遍历所有刚组装好的图层，生成一个结构字典 (LayerMap) 存入基准历史栈
                layerMap: createLayerMap(this.layers, {
                    // 保存全部属性 (尺寸、透明度、混合模式)
                    attributes: 'all',
                }) as Record<TLayerId, THistoryEntryLayerComposed>,
            };

            // 将这份完整的全景快照推入历史记录。
            // 当用户一直按 Ctrl+Z 退无可退时，就会回到这个初始快照。
            this.klHistory.push(historyEntryData);
        }

        // 告知外界（UI组件）：重置完成了，当前处于激活状态的图层是哪一层
        return this.layers.length - 1;
    }

    isLayerLimitReached(): boolean {
        return this.layers.length >= MAX_LAYERS;
    }

    getWidth(): number {
        return this.width;
    }

    getHeight(): number {
        return this.height;
    }

    /**
     * 仅修改画布的逻辑尺寸记录，不缩放/不裁剪实际像素
     * 通常用于 UI 视口的同步，或者某些特殊裁剪操作的前置步骤
     */
    /**
     * without resizing
     */
    setSize(width: number, height: number): void {
        this.width = width;
        this.height = height;
    }

    getLayerCount(): number {
        return this.layers.length;
    }

    /**
     * 核心操作：物理缩放整个绘画工程 (包含所有图层和选区)
     * @param w 目标宽度
     * @param h 目标高度
     * @param algorithm 算法：'smooth'平滑(双线性/双三次) 或 'pixelated'像素化(最近邻)
     */
    resize(w: number, h: number, algorithm: TInterpolationAlgorithm = 'smooth'): boolean {
        // 1. 严格的参数校验：不能缩放到 0，不能尺寸不变，不能是非数字
        if (
            !w ||
            !h ||
            (w === this.width && h === this.height) ||
            isNaN(w) ||
            isNaN(h) ||
            w < 1 ||
            h < 1
        ) {
            return false;
        }
        w = Math.max(w, 1);
        h = Math.max(h, 1);

        let tmp1, tmp2;// 用于缓冲计算的离屏画布 (Offscreen Canvas)

        if (algorithm === 'pixelated') {
            // --- 像素化缩放算法 ---
            tmp1 = BB.canvas(w, h);
            const tmp1Ctx = BB.ctx(tmp1);
            // 核心：关闭图像平滑，强制使用最近邻插值，保持边缘锐利
            tmp1Ctx.imageSmoothingEnabled = false;

            // 遍历所有图层进行缩放
            for (let i = 0; i < this.layers.length; i++) {
                if (i > 0) {
                    tmp1Ctx.clearRect(0, 0, w, h);// 复用 tmp1，画下一层前先清空
                }
                const layer = this.layers[i];
                // 第一步：把原图层画到目标尺寸的 tmp1 上 (触发像素化缩放)
                tmp1Ctx.drawImage(layer.canvas, 0, 0, w, h);

                // 第二步：修改原图层 canvas DOM 的尺寸 
                // 注意：修改 canvas.width/height 会导致浏览器自动清空该 canvas 的像素内容！
                layer.canvas.width = w;
                layer.canvas.height = h;
                // 第三步：把缩放好的 tmp1 画回原图层
                layer.context.drawImage(tmp1, 0, 0);
            }
        } else if (algorithm === 'smooth') {
            // --- 平滑缩放算法 ---
            tmp1 = BB.canvas();
            tmp2 = BB.canvas();
            for (let i = 0; i < this.layers.length; i++) {
                // 委托给底层图形库进行高品质的多步平滑缩放
                BB.resizeCanvas(this.layers[i].canvas, w, h, tmp1, tmp2);
            }
        } else {
            throw new Error('unknown resize algorithm');
        }

        // 2. 联动处理：数学几何级别的选区缩放
        if (this.selection) {
            // 如果存在复杂的异形选区，利用仿射变换矩阵，将选区顶点等比例缩放
            this.selection = transformMultiPolygon(
                this.selection,
                // 计算 X/Y 轴的缩放因子
                scale(w / this.width, h / this.height),
            );
        }
        // 更新内部宽高状态
        this.width = w;
        this.height = h;

        // 3. 压入撤销历史栈
        this.klHistory.push({
            size: {
                width: this.width,
                height: this.height,
            },
            // 使用上一节分析过的 createLayerMap。
            // 因为缩放修改了全图，所以 attributes 传入 ['tiles']，要求强制提取所有图层的新像素切片
            layerMap: createLayerMap(this.layers, { attributes: ['tiles'] }),
            // 如果选区存在，一并存入历史记录
            ...(this.selection ? { selection: { value: this.selection } } : {}),
        });

        return true;
    }

    /**
     * 修改画布物理尺寸 (裁剪 Crop 或 扩展 Extend)
     * 注意：这不会缩放原图的像素，只会改变外框大小。
     * @param p 包含上下左右的扩展量 (正数为扩展，负数为裁剪)
     */
    /**
     * crop / extend
     */
    resizeCanvas(p: {
        left: number;
        top: number;
        right: number;
        bottom: number;
        // 扩展出来的边缘要填充什么颜色 (通常只对最底层的背景图层生效)
        fillColor?: TRgb;
    }): void {
        // 计算新的画布总宽高
        const newW = Math.round(p.left) + this.width + Math.round(p.right);
        const newH = Math.round(p.top) + this.height + Math.round(p.bottom);
        // 原图在新画布中的起始绘制坐标 (偏移量)
        const offX = Math.round(p.left);
        const offY = Math.round(p.top);

        if (isNaN(newW) || isNaN(newH) || newW < 1 || newH < 1) {
            throw new Error('KlCanvas.resizeCanvas - invalid canvas size');
        }

        // 遍历所有图层，逐个调整外框
        for (let i = 0; i < this.layers.length; i++) {
            // 1. 创建临时画布，将当前图层的宝贵像素“备份”下来
            const ctemp = BB.canvas(this.width, this.height);
            const layer = this.layers[i];
            BB.ctx(ctemp).drawImage(layer.canvas, 0, 0);

            // 2. 强行改变原图层尺寸 (这会触发浏览器清空该 canvas 的内存)
            layer.canvas.width = newW;
            layer.canvas.height = newH;

            layer.context.save();
            // 3. 处理底层的边缘填充色
            if (i === 0 && p.fillColor) {
                layer.context.fillStyle = BB.ColorConverter.toRgbStr(p.fillColor);
                layer.context.fillRect(0, 0, newW, newH);
                layer.context.clearRect(offX, offY, this.width, this.height);
            }
            // 4. 把刚才备份的像素，按照计算好的偏移坐标贴回到新画布里
            layer.context.drawImage(ctemp, offX, offY);
            layer.context.restore();
        }
        // 更新系统的宽高状态
        this.width = newW;
        this.height = newH;

        // 如果存在选区，同样需要对选区的多边形进行相对位移 (Translate)
        if (this.selection) {
            this.selection = translateMultiPolygon(this.selection, offX, offY);
        }
        // 压入撤销历史栈，因为所有图层的像素都发生了位移，必须提取全部 tiles
        this.klHistory.push({
            size: {
                width: this.width,
                height: this.height,
            },
            layerMap: createLayerMap(this.layers, { attributes: ['tiles'] }),
            ...(this.selection ? { selection: { value: this.selection } } : {}),
        });
    }

    /**
     * 新建图层
     * @param selectedIndex 在哪个索引之上插入图层 (如果不传，默认加在最顶层)
     * @param data 可选的初始化数据 (图层名、可见性、甚至带入一张初始图片)
     */
    /**
     * will be inserted above of selected
     */
    addLayer(
        selectedIndex?: number,
        data?: {
            name?: string;
            mixModeStr?: TMixMode;
            isVisible: boolean;
            opacity: number;
            image: HTMLCanvasElement | HTMLImageElement | ((ctx: CanvasRenderingContext2D) => void);
        },
    ): false | number {
        if (this.isLayerLimitReached()) {
            return false;
        }
        // 计算最终要插入的数组索引
        const index = selectedIndex === undefined ? this.layers.length : selectedIndex + 1;

        // 1. 在内存中创建一个新的原生 Canvas DOM 元素
        const canvas = BB.canvas(this.width, this.height);
        const context = BB.ctx(canvas);
        // 2. 如果创建图层时带有初始图像，提前画上去
        if (data) {
            if (typeof data.image === 'function') {
                data.image(context);
            } else {
                context.drawImage(data.image, 0, 0);
            }
        }

        const layerId = getNextLayerId();

        // 3. 构建规范的系统图层对象
        const layer: TKlCanvasLayer = {
            id: layerId,
            index,
            name:
                data && data.name !== undefined
                    ? data.name
                    : LANG('layers-layer') + ' ' + (this.layers.length + this.layerNrOffset),  // 自动命名，如 "图层 3"
            mixModeStr: data ? (data.mixModeStr ?? 'source-over') : 'source-over', // 默认正常混合
            isVisible: data ? data.isVisible : true,// 默认可见
            opacity: data ? data.opacity : 1,// 默认不透明
            canvas,// 新创建的 <canvas> 元素
            context,// 对应的 2D 上下文
        };

        // 4. 将新图层对象插入到系统数组的指定位置
        this.layers.splice(index, 0, layer);

        // 暂停历史记录，防止 setOpacity 产生多余的撤销步骤
        this.klHistory.pause(true);
        try {
            this.setOpacity(index, 1); // 确保新图层透明度为 1（完全可见）
        } finally {
            this.klHistory.pause(false);  // 恢复历史记录
        }
        // 重排行号
        this.updateIndices(); 

        // 5. 将“新建图层”这一动作压入历史撤销栈
        if (!this.klHistory.isPaused()) {
            this.klHistory.push({
                // 焦点自动跳转到新图层
                activeLayerId: layerId,
                layerMap: createLayerMap(
                    this.layers,
                    // 旧图层仅仅改变了排序索引，不保存像素
                    { attributes: ['index'] }, 
                    {
                        layerId,
                        // 新图层保存所有属性
                        attributes: 'all',
                       // [极限优化]：如果新建的是白板图层，不要去切片，直接告诉历史系统“全是透明的”
                        tiles: data
                            ? undefined 
                            : createFillColorTiles(this.width, this.height, 'transparent'), 
                    },
                ),
            });
        }

        return index;
    }

    /**
     * 复制图层
     * @param srcIndex 要复制的源图层索引
     * @returns 成功返回新图层的索引，失败返回 false
     */
    duplicateLayer(srcIndex: number): false | number {
        // 1. 拦截非法操作：源图层不存在，或图层数已达上限
        if (!this.layers[srcIndex] || this.isLayerLimitReached()) {
            return false;
        }
        const srcLayer = this.layers[srcIndex];
        // 默认插入到源图层的正上方
        const newIndex = srcIndex + 1;

        // 2. 从历史系统的“全局状态快照”中，提取出源图层的数据
        const composed = this.klHistory.getComposed();
        const srcComposed = composed.layerMap[srcLayer.id];

        // 3. 创建新图层的原生 DOM 及上下文
        const canvas = BB.canvas(this.width, this.height);
        const ctx = BB.ctx(canvas);
        const layerId = getNextLayerId();
        // 构建新的图层对象
        const newLayer: TKlCanvasLayer = {
            id: layerId,
            index: newIndex,
            // 自动添加“ 副本”后缀
            name: srcLayer.name + ' ' + LANG('layers-copy'),
            mixModeStr: srcLayer.mixModeStr,
            isVisible: srcLayer.isVisible,
            opacity: srcLayer.opacity,
            canvas,
            context: ctx,
        };

        // 插入系统图层栈
        this.layers.splice(newIndex, 0, newLayer);

        {
            // --- 4. 核心渲染逻辑：通过瓦片(Tiles)拼图复原像素 ---
            // 计算一行有多少个瓦片
            // draw into new layer from old
            const tilesPerX = Math.ceil(this.width / HISTORY_TILE_SIZE);
            // ! 注意：这里存在潜在的空指针异常风险，因为 srcComposed.tiles 可能为 undefined
            // Uncaught TypeError: Cannot read properties of undefined (reading 'tiles')
            srcComposed.tiles.forEach((tile, index) => {
                // 经典的 1D 数组转 2D 网格坐标算法
                const x = index % tilesPerX; // 求余得到列号 (X轴)
                const y = Math.floor(index / tilesPerX); // 取整得到行号 (Y轴)
                ctx.save();
                if (isLayerFill(tile)) {
                    // 如果这个瓦片是一个纯色填充 (比如纯白或全透明)
                    ctx.fillStyle = tile.fill;
                    ctx.fillRect(
                        x * HISTORY_TILE_SIZE,
                        y * HISTORY_TILE_SIZE,
                        HISTORY_TILE_SIZE,
                        HISTORY_TILE_SIZE,
                    );
                } else {
                    // 如果这个瓦片包含真实的图像像素，则直接将像素数据写入画布对应坐标
                    ctx.putImageData(tile.data, x * HISTORY_TILE_SIZE, y * HISTORY_TILE_SIZE);
                }
                ctx.restore();
            });
        }

        this.updateIndices();

        // 5. 压入撤销历史栈
        if (!this.klHistory.isPaused()) {
            this.klHistory.push({
                // 焦点转移到新图层
                activeLayerId: layerId,
                layerMap: createLayerMap(
                    this.layers,
                    { attributes: ['index'] },
                    {
                        layerId,
                        attributes: 'all',
                        // --- 性能极致优化 ---
                        // 不去读取新画布的像素，而是直接复用刚才遍历过的旧瓦片数据！
                        tiles: srcComposed.tiles.map((tile) => {
                            if (isLayerFill(tile)) {
                                // 纯色配置直接浅拷贝
                                return { ...tile };
                            }
                            // 像素数据执行底层深拷贝
                            return copyImageDataTile(tile);
                        }),
                    },
                ),
            });
        }
        return srcIndex + 1;
    }

    /**
     * 获取指定图层的 2D 绘图上下文
     * @param index 图层层级
     * @param doReturnNull 当找不到该图层时，是否静默返回 null。(如果为 false 则抛出致命错误)
     */
    getLayerContext(index: number, doReturnNull?: boolean): CanvasRenderingContext2D | null {
        if (this.layers[index]) {
            return this.layers[index].context;
        }
        // 防御性编程：允许上层业务在不知道图层是否存在时安全试探
        if (doReturnNull) {
            return null;
        }
        // 严格模式：找不到图层直接让程序崩溃报错，防止带病运行
        throw new Error(
            'layer of index ' + index + ' not found (in ' + this.layers.length + ' layers)',
        );
    }

    /**
     * 删除图层
     */
    removeLayer(index: number): false | number {
        const toDeleteLayer = this.layers[index];
        if (!toDeleteLayer) {
            return false;
        }

        // 【内存清理】：必须显式释放 canvas DOM 资源，否则会导致严重的内存泄漏
        BB.freeCanvas(toDeleteLayer.canvas);
        this.layers.splice(index, 1);
        this.updateIndices();

        // 自动激活上一层，防止用户处于“虚无”状态
        const activeLayerIndex = Math.max(0, index - 1);
        const activeLayerId = this.layers[activeLayerIndex].id;

        if (!this.klHistory.isPaused()) {
            this.klHistory.push({
                activeLayerId,
                // 图层删除了，其余所有图层的 index 都变了，必须全局更新 index 快照
                layerMap: createLayerMap(this.layers, { attributes: ['index'] }),
            });
        }
        return activeLayerIndex;
    }

    /**
     * 重命名图层
     */
    renameLayer(index: number, name: string): boolean {
        const targetLayer = this.layers[index];
        if (targetLayer) {
            targetLayer.name = name;
        } else {
            return false;
        }

        if (!this.klHistory.isPaused()) {
            // 只记录 name 这一项的变更
            this.klHistory.push({
                layerMap: createLayerMap(this.layers, {
                    layerId: targetLayer.id,
                    attributes: ['name'],
                }),
            });
        }

        return true;
    }

    /**
     * 设置透明度（带历史记录合并逻辑）
     */
    setOpacity(layerIndex: number, opacity: number): void {
        if (!this.layers[layerIndex]) {
            return;
        }
        opacity = Math.max(0, Math.min(1, opacity));
        this.layers[layerIndex].opacity = opacity;

        if (!this.klHistory.isPaused()) {
            const layerId = this.layers[layerIndex].id;
            // 检查历史栈顶端，如果是同类型的修改，则触发覆盖合并
            const topEntry = this.klHistory.getEntries().at(-1)!.data;
            const replaceTop = isHistoryEntryOpacityChange(topEntry, layerId);
            this.klHistory.push(
                {
                    layerMap: createLayerMap(this.layers, {
                        layerId,
                        attributes: ['opacity'],
                    }),
                },
                replaceTop, // 如果为 true，则撤销栈不会变长，而是原地更新
            );
        }
    }

    /**
     * 设置显隐性（同透明度，也具备历史合并功能）
     */
    setLayerIsVisible(layerIndex: number, isVisible: boolean): void {
        if (this.layers[layerIndex]) {
            this.layers[layerIndex].isVisible = isVisible;
        } else {
            throw new Error(`layer ${layerIndex} undefined`);
        }

        if (!this.klHistory.isPaused()) {
            const layerId = this.layers[layerIndex].id;
            const topEntry = this.klHistory.getEntries().at(-1)!.data;
            const replaceTop = isHistoryEntryVisibilityChange(topEntry, layerId);
            this.klHistory.push(
                {
                    layerMap: createLayerMap(this.layers, {
                        layerId,
                        attributes: ['isVisible'],
                    }),
                },
                replaceTop,
            );
        }
    }

    /**
     * 移动图层顺序 (上下拖拽)
     */
    moveLayer(index: number, delta: number): void | number {
        if (delta === 0) {
            return;
        }
        if (!this.layers[index]) {
            return;
        }

        // 经典的数组移动元素写法
        const temp = this.layers[index];
        this.layers.splice(index, 1);
        const targetIndex = Math.max(0, Math.min(index + delta, this.layers.length));
        this.layers.splice(targetIndex, 0, temp);

        // 必须重新排索引，否则图层混合顺序会乱
        this.updateIndices();

        if (!this.klHistory.isPaused()) {
            this.klHistory.push({
                activeLayerId: this.layers[targetIndex].id,
                // 图层顺序变了，所有图层的 index 都得记录
                layerMap: createLayerMap(this.layers, { attributes: ['index'] }),
            });
        }

        return targetIndex;
    }

    /**
     * 将上层图层合并到下层图层中
     */
    mergeLayers(
        layerBottomIndex: number,
        layerTopIndex: number,
        mixModeStr?: TMixMode | 'as-alpha',
    ): void | number {
        // 校验：图层必须存在，且不能是同一个图层
        if (
            !this.layers[layerBottomIndex] ||
            !this.layers[layerTopIndex] ||
            layerBottomIndex === layerTopIndex
        ) {
            return;
        }

        // 确保 Bottom 在下，Top 在上
        //order messed up
        if (layerBottomIndex > layerTopIndex) {
            const temp = layerBottomIndex;
            layerBottomIndex = layerTopIndex;
            layerTopIndex = temp;
        }

        const topLayer = this.layers[layerTopIndex];
        const bottomLayer = this.layers[layerBottomIndex];
        if (mixModeStr === undefined) {
            mixModeStr = topLayer.mixModeStr;
        }

        const topOpacity = this.layers[layerTopIndex].opacity;
        const mergedPixelData = topLayer.opacity > 0;

        // 只有当有东西需要合并时，才触发 Canvas 渲染
        if (mergedPixelData) {
            const bottomCtx = bottomLayer.context;
            bottomCtx.save();

            // 特殊逻辑：将上层当作 Alpha 蒙版处理
            if (mixModeStr === 'as-alpha') {
                // todo remove this?

                BB.convertToAlphaChannelCanvas(topLayer.canvas);
                bottomCtx.globalCompositeOperation = 'destination-in';
                bottomCtx.globalAlpha = topOpacity;
                bottomCtx.drawImage(topLayer.canvas, 0, 0);
            } else {
                // 常规合并，支持乘法、叠加等所有混合模式
                if (mixModeStr) {
                    bottomCtx.globalCompositeOperation = mixModeStr;
                }
                bottomCtx.globalAlpha = topOpacity;
                bottomCtx.drawImage(topLayer.canvas, 0, 0);
            }

            bottomCtx.restore();
        }

        // 合并后删除上层，这里利用 removeLayer 的历史逻辑
        this.klHistory.pause(true);
        try {
            this.removeLayer(layerTopIndex);
        } finally {
            this.klHistory.pause(false);
        }
        if (!this.klHistory.isPaused()) {
            this.klHistory.push({
                activeLayerId: bottomLayer.id,
                // 像素变更了，必须记录全部切片 (tiles)
                layerMap: createLayerMap(
                    this.layers,
                    { attributes: ['index'] },
                    mergedPixelData ? { layerId: bottomLayer.id, attributes: 'all' } : undefined,
                ),
            });
        }

        return layerBottomIndex;
    }

    /**
     * 合并所有可见图层到最底层 (Flatten Image)
     */
    mergeAll(): number | false {
        // 1. 安全检查：如果本来就只有一层，无需合并
        if (this.layers.length === 1) {
            return false;
        }

        // 2. 将第 0 层作为“基准画布”
        // draw all on bottom layer
        const bottomLayer = this.layers[0];
        bottomLayer.name = LANG('layers-layer') + ' 1';
        const bottomCtx = bottomLayer.context;

        // 3. 遍历所有上层图层，逐个渲染到第 0 层
        for (let i = 1; i < this.layers.length; i++) {
            const layer = this.layers[i];
             // TODO: sai2如果存在被隐藏的图层，则无法合并！透明度则合并该透明度的图层
            // 【性能优化】：被隐藏的图层直接忽略，不参与最终的像素合成
            if (!layer.isVisible || layer.opacity === 0) {
                continue;
            }
            bottomCtx.save();
            // 应用目标图层的混合模式与透明度
            bottomCtx.globalCompositeOperation = layer.mixModeStr;
            bottomCtx.globalAlpha = layer.opacity;
            // 拍平操作：将图层内容绘入底部画布
            bottomCtx.drawImage(layer.canvas, 0, 0);
            bottomCtx.restore();
        }

        // 4. 清理现场：暂停历史记录，将上方所有图层移除
        this.klHistory.pause(true);
        try {
            // 从上往下删，防止索引错乱
            // remove upper layers
            for (let i = this.layers.length - 1; i > 0; i--) {
                this.removeLayer(i);
            }
        } finally {
            this.klHistory.pause(false);
        }

        // 5. 记录历史：合并所有图层是一个巨大的改动，记录全部 tiles 快照
        if (!this.klHistory.isPaused()) {
            const activeLayerId = bottomLayer.id;
            this.klHistory.push({
                activeLayerId,
                layerMap: createLayerMap(this.layers, { attributes: ['tiles'] }),
            });
        }

        // 合并后，只剩下第 0 层
        return 0;
    }

    /**
     * 旋转画布 (90, 180, 270 度)
     */
    // rotates the canvas with all layers. either by 90, 180, or 270 degrees
    rotate(deg: number): void {
        // 规范化角度
        while (deg < 0) {
            deg += 360;
        }
        deg %= 360;
        if (deg !== 90 && deg !== 180 && deg !== 270) {
            return;
        }
        const temp = BB.canvas();
        // 计算旋转后的新画布尺寸
        if (deg === 180) {
            temp.width = this.width;
            temp.height = this.height;
        } else if (deg === 90 || deg === 270) {
            temp.width = this.height;
            temp.height = this.width;
        }
        // 构建变换矩阵：平移 -> 旋转 -> 再次平移到正确坐标
        let matrix: Matrix = identity();
        if (deg === 90) {
            matrix = compose(translate(this.height, 0), rotate(Math.PI / 2));
        } else if (deg === 180) {
            matrix = compose(translate(this.width, this.height), rotate(Math.PI));
        } else if (deg === 270) {
            matrix = compose(translate(0, this.width), rotate((3 * Math.PI) / 2));
        }
        const ctx = BB.ctx(temp);
        for (let i = 0; i < this.layers.length; i++) {
            ctx.clearRect(0, 0, temp.width, temp.height);
            ctx.save();
            // 应用矩阵
            ctx.setTransform(...matrixToTuple(matrix));
            ctx.drawImage(this.layers[i].canvas, 0, 0);
            ctx.restore();
            // 将变换后的临时画布拷回原图层
            this.layers[i].canvas.width = temp.width;
            this.layers[i].canvas.height = temp.height;
            this.layers[i].context.drawImage(temp, 0, 0);
        }
        this.width = temp.width;
        this.height = temp.height;

        // [关键] 同步缩放/旋转选区
        if (this.selection) {
            this.selection = transformMultiPolygon(this.selection, matrix);
        }

        this.klHistory.push({
            size: {
                width: this.width,
                height: this.height,
            },
            layerMap: createLayerMap(this.layers, { attributes: ['tiles'] }),
            ...(this.selection ? { selection: { value: this.selection } } : {}),
        });
    }

    flip(isHorizontal: boolean, isVertical: boolean, layerIndex?: number): void {
        if (!isHorizontal && !isVertical) {
            return;
        }

        const temp = BB.canvas(this.width, this.height);
        temp.width = this.width;
        temp.height = this.height;
        const tempCtx = BB.ctx(temp);

        const matrix = compose(
            translate(temp.width / 2, temp.height / 2),
            scale(isHorizontal ? -1 : 1, isVertical ? -1 : 1),
            translate(-temp.width / 2, -temp.height / 2),
        );

        for (let i = 0; i < this.layers.length; i++) {
            if ((layerIndex || layerIndex === 0) && i !== layerIndex) {
                continue;
            }

            tempCtx.save();
            tempCtx.clearRect(0, 0, temp.width, temp.height);
            tempCtx.setTransform(...matrixToTuple(matrix));
            tempCtx.drawImage(this.layers[i].canvas, 0, 0);
            tempCtx.restore();

            this.layers[i].context.clearRect(
                0,
                0,
                this.layers[i].canvas.width,
                this.layers[i].canvas.height,
            );
            this.layers[i].context.drawImage(temp, 0, 0);
        }

        if (this.selection) {
            this.selection = transformMultiPolygon(this.selection, matrix);
        }

        const targetLayer = layerIndex === undefined ? undefined : this.layers[layerIndex];
        this.klHistory.push({
            layerMap: createLayerMap(
                this.layers,
                targetLayer
                    ? { layerId: targetLayer.id, attributes: ['tiles'] }
                    : { attributes: ['tiles'] },
            ),
            ...(this.selection ? { selection: { value: this.selection } } : {}),
        });
    }

    // arbitrary drawing operation & focus layer
    drawOperation(layerIndex: number, operation: (ctx: CanvasRenderingContext2D) => void): void {
        const targetLayer = this.layers[layerIndex];
        const ctx = targetLayer.context;
        operation(ctx);

        if (!this.klHistory.isPaused()) {
            this.klHistory.push({
                activeLayerId: targetLayer.id,
                layerMap: createLayerMap(this.layers, {
                    layerId: targetLayer.id,
                    attributes: ['tiles'],
                }),
            });
        }
    }

    layerFill(
        layerIndex: number,
        colorObj: TRgb,
        compositeOperation?: string,
        doClipSelection?: boolean,
    ): void {
        const ctx = this.layers[layerIndex].context;
        ctx.save();
        const isUniformFill =
            !(doClipSelection && this.selection) && compositeOperation === undefined;
        if (compositeOperation) {
            ctx.globalCompositeOperation = compositeOperation as GlobalCompositeOperation;
        }

        let bounds: TIndexBounds | undefined;
        if (doClipSelection && this.selection) {
            const selectionPath = getSelectionPath2d(this.selection);
            ctx.clip(selectionPath);
            bounds = getMultiPolyBounds(this.selection, 'index');
        }

        const fill = 'rgba(' + colorObj.r + ',' + colorObj.g + ',' + colorObj.b + ',1)';
        ctx.fillStyle = fill;
        ctx.fillRect(
            0,
            0,
            this.layers[layerIndex].canvas.width,
            this.layers[layerIndex].canvas.height,
        );
        ctx.restore();

        // workaround for chrome bug https://bugs.chromium.org/p/chromium/issues/detail?id=1281185
        // TODO remove if chrome updated
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.01)';
        ctx.fillRect(-0.9999999, -0.9999999, 1, 1);
        ctx.restore();

        /*if (!document.getElementById('testocanvas')) {
            layerCanvasArr[layerIndex].id = 'testocanvas';
            document.body.append(layerCanvasArr[layerIndex]);
            BB.css(layerCanvasArr[layerIndex], {
                position: 'fixed',
                left: '0',
                top: '0',
                zIndex: '1111111',
                transform: 'scale(0.2)',
                border: '10px solid red',
            });
        }
        if (!document.getElementById('testocanvas')) {
            let c = document.createElement('canvas');
            c.width = 1000;
            c.height = 1000;
            let ctx2 = c.getContext('2d');
            ctx2.drawImage(layerCanvasArr[layerIndex], 0, 0);
            c.id = 'testocanvas';
            document.body.append(c);
            BB.css(c, {
                position: 'fixed',
                left: '0',
                top: '0',
                zIndex: '1111111',
                transform: 'scale(0.2)',
                border: '10px solid red',
            });
        }*/

        if (!this.klHistory.isPaused()) {
            const targetLayer = this.layers[layerIndex];
            this.klHistory.push({
                layerMap: createLayerMap(this.layers, {
                    layerId: targetLayer.id,
                    attributes: ['tiles'],
                    tiles: isUniformFill
                        ? createFillColorTiles(this.width, this.height, fill)
                        : undefined,
                    bounds,
                }),
            });
        }
    }

    floodFill(
        layerIndex: number, // index of layer to be filled
        x: number, // starting point
        y: number,
        rgb: TRgb | null, // fill color, if null -> erase
        opacity: number,
        tolerance: number,
        sampleStr: TFillSampling,
        grow: number, // int >= 0 - radius around filled area that is to be filled too
        isContiguous: boolean,
    ): void {
        if (x < 0 || y < 0 || x >= this.width || y >= this.height || opacity === 0) {
            return;
        }
        tolerance = Math.round(tolerance);
        x = Math.round(x);
        y = Math.round(y);

        if (!['above', 'current', 'all'].includes(sampleStr)) {
            throw new Error('invalid sampleStr');
        }
        const selectionMask = this.selection
            ? getBinaryMask(this.selection, this.width, this.height)
            : undefined;
        if (selectionMask && selectionMask[y * this.width + x] === 0) {
            // don't fill if outside of selection
            return;
        }

        const targetLayer = this.layers[layerIndex];
        let result: ReturnType<typeof floodFillBits>;
        let targetCtx;
        let targetImageData;

        if (sampleStr === 'all') {
            const srcCanvas =
                this.layers.length === 1 ? this.layers[0].canvas : this.getCompleteCanvas(1);
            const srcCtx = BB.ctx(srcCanvas);
            const srcImageData = srcCtx.getImageData(0, 0, this.width, this.height);
            const srcData = srcImageData.data;
            result = floodFillBits(
                srcData,
                selectionMask,
                this.width,
                this.height,
                x,
                y,
                tolerance,
                Math.round(grow),
                isContiguous,
            );

            targetCtx = targetLayer.context;
            targetImageData = targetCtx.getImageData(0, 0, this.width, this.height);
        } else {
            const srcIndex = sampleStr === 'above' ? layerIndex + 1 : layerIndex;

            if (srcIndex >= this.layers.length) {
                return;
            }

            const srcCtx = this.layers[srcIndex].context;
            const srcImageData = srcCtx.getImageData(0, 0, this.width, this.height);
            const srcData = srcImageData.data;
            result = floodFillBits(
                srcData,
                selectionMask,
                this.width,
                this.height,
                x,
                y,
                tolerance,
                Math.round(grow),
                isContiguous,
            );

            targetCtx = layerIndex === srcIndex ? srcCtx : targetLayer.context;
            targetImageData =
                layerIndex === srcIndex
                    ? srcImageData
                    : targetCtx.getImageData(0, 0, this.width, this.height);
        }

        const targetData = targetImageData.data;
        if (rgb) {
            if (opacity === 1) {
                for (let i = 0; i < this.width * this.height; i++) {
                    if (result.data[i] === 255) {
                        targetData[i * 4] = rgb.r;
                        targetData[i * 4 + 1] = rgb.g;
                        targetData[i * 4 + 2] = rgb.b;
                        targetData[i * 4 + 3] = 255;
                    }
                }
            } else {
                for (let i = 0; i < this.width * this.height; i++) {
                    if (result.data[i] === 255) {
                        targetData[i * 4] = BB.mix(targetData[i * 4], rgb.r, opacity);
                        targetData[i * 4 + 1] = BB.mix(targetData[i * 4 + 1], rgb.g, opacity);
                        targetData[i * 4 + 2] = BB.mix(targetData[i * 4 + 2], rgb.b, opacity);
                        targetData[i * 4 + 3] = BB.mix(targetData[i * 4 + 3], 255, opacity);
                    }
                }
            }
        } else {
            // erase
            if (opacity === 1) {
                for (let i = 0; i < this.width * this.height; i++) {
                    if (result.data[i] === 255) {
                        targetData[i * 4 + 3] = 0;
                    }
                }
            } else {
                for (let i = 0; i < this.width * this.height; i++) {
                    if (result.data[i] === 255) {
                        targetData[i * 4 + 3] = BB.mix(targetData[i * 4 + 3], 0, opacity);
                    }
                }
            }
        }
        targetCtx.putImageData(targetImageData, 0, 0);

        // const ctx = this.layers[layerIndex].context;
        // ctx.save();
        // ctx.fillStyle = 'rgba(255,0,0,0.2)';
        // ctx.fillRect(
        //     result.bounds.x1,
        //     result.bounds.y1,
        //     result.bounds.x2 - result.bounds.x1,
        //     result.bounds.y2 - result.bounds.y1,
        // );
        // ctx.restore();

        if (!this.klHistory.isPaused()) {
            this.klHistory.push({
                layerMap: createLayerMap(this.layers, {
                    layerId: targetLayer.id,
                    attributes: ['tiles'],
                    bounds: result.bounds,
                }),
            });
        }
    }

    /**
     * draw geometric shape (circle, line, rect)
     * @param layerIndex
     * @param shapeObj
     */
    drawShape(layerIndex: number, shapeObj: TShapeToolObject): void {
        if (shapeObj.x1 === shapeObj.x2 && shapeObj.y1 === shapeObj.y2) {
            return;
        }
        const targetLayer = this.layers[layerIndex];
        const selectionPath = this.selection
            ? new Path2D(getSelectionPath2d(this.selection))
            : undefined;
        const bounds = drawShape(targetLayer.context, shapeObj, selectionPath);

        // debug
        /*const ctx = this.layers[layerIndex].context;
        ctx.save();
        ctx.fillStyle = 'rgba(255,0,0,0.2)';
        ctx.fillRect(bounds.x1, bounds.y1, bounds.x2 - bounds.x1, bounds.y2 - bounds.y1);
        ctx.restore();*/

        if (!this.klHistory.isPaused()) {
            this.klHistory.push({
                layerMap: createLayerMap(this.layers, {
                    layerId: targetLayer.id,
                    attributes: ['tiles'],
                    bounds,
                }),
            });
        }
    }

    drawGradient(layerIndex: number, gradientObj: TGradient): void {
        const targetLayer = this.layers[layerIndex];
        const selectionPath = this.selection
            ? new Path2D(getSelectionPath2d(this.selection))
            : undefined;
        drawGradient(targetLayer.context, gradientObj, selectionPath);
        if (!this.klHistory.isPaused()) {
            this.klHistory.push({
                layerMap: createLayerMap(this.layers, {
                    layerId: targetLayer.id,
                    attributes: ['tiles'],
                }),
            });
        }
    }

    text(layerIndex: number, p: TRenderTextParam): void {
        const targetLayer = this.layers[layerIndex];
        const rect = renderText(
            targetLayer.canvas,
            BB.copyObj(p),
            this.selection ? new Path2D(getSelectionPath2d(this.selection)) : undefined,
        );

        // add 2, because rect not entirely accurate
        const padding = 2 + (p.stroke ? p.stroke.lineWidth / 2 : 0);
        const changedBounds = transformCoordinateBounds(
            rectToBounds(rect, 'coordinate'),
            compose(translate(p.x, p.y), rotate(-p.angleRad)),
        );
        changedBounds.x1 -= padding;
        changedBounds.y1 -= padding;
        changedBounds.x2 += padding;
        changedBounds.y2 += padding;

        // const ctx = this.layers[layerIndex].context;
        // ctx.save();
        // ctx.fillStyle = 'rgba(255,0,0,0.2)';
        // ctx.fillRect(bounds.x1, bounds.y1, bounds.x2 - bounds.x1, bounds.y2 - bounds.y1);
        // ctx.restore();

        if (!this.klHistory.isPaused()) {
            this.klHistory.push({
                layerMap: createLayerMap(this.layers, {
                    layerId: targetLayer.id,
                    attributes: ['tiles'],
                    bounds: coordinateBoundsToIndexBounds(changedBounds),
                }),
            });
        }
    }

    eraseLayer(p: {
        layerIndex: number;
        useAlphaLock?: boolean; // default false
        useSelection?: boolean; // default false
    }): void {
        const targetLayer = this.layers[p.layerIndex];
        const ctx = targetLayer.context;
        ctx.save();
        let bounds: TIndexBounds | undefined;
        if (p.useSelection && this.selection) {
            const selectionPath = getSelectionPath2d(this.selection);
            ctx.clip(selectionPath);
            bounds = getMultiPolyBounds(this.selection, 'index');
        }
        if (p.useAlphaLock) {
            ctx.globalCompositeOperation = 'source-atop';
        } else {
            ctx.globalCompositeOperation = 'destination-out';
        }
        ctx.fillStyle = BB.ColorConverter.toRgbStr(getEraseColor());
        ctx.fillRect(0, 0, this.width, this.height);
        ctx.restore();

        const isUniformFill = !p.useAlphaLock && !(p.useSelection && this.selection);
        if (!this.klHistory.isPaused()) {
            this.klHistory.push({
                layerMap: createLayerMap(this.layers, {
                    layerId: targetLayer.id,
                    attributes: ['tiles'],
                    tiles: isUniformFill
                        ? createFillColorTiles(this.width, this.height, 'transparent')
                        : undefined,
                    bounds,
                }),
            });
        }
    }

    getKlHistory(): KlHistory {
        return this.klHistory;
    }

    getLayersRaw(): TKlCanvasLayer[] {
        return this.layers;
    }

    getLayers(): {
        id: string;
        canvas: HTMLCanvasElement;
        context: CanvasRenderingContext2D;
        isVisible: boolean;
        opacity: number;
        name: string;
        mixModeStr: TMixMode;
    }[] {
        return this.layers.map((layer) => {
            return {
                id: layer.id,
                canvas: layer.canvas,
                context: layer.context,
                isVisible: layer.isVisible,
                opacity: layer.opacity,
                name: layer.name,
                mixModeStr: layer.mixModeStr,
            };
        });
    }

    getLayersFast(): {
        canvas: HTMLCanvasElement;
        isVisible: boolean;
        opacity: number;
        name: string;
        mixModeStr: TMixMode;
        compositeObj?: TLayerComposite;
    }[] {
        return this.layers.map((item) => {
            return {
                canvas: item.canvas,
                isVisible: item.isVisible,
                opacity: item.opacity,
                name: item.name,
                mixModeStr: item.mixModeStr,
                ...(item.compositeObj ? { compositeObj: item.compositeObj } : {}),
            };
        });
    }

    getLayerIndex(canvasObj: HTMLCanvasElement, doReturnNull?: boolean): null | number {
        for (let i = 0; i < this.layers.length; i++) {
            if (this.layers[i].canvas === canvasObj) {
                return i;
            }
        }
        if (!doReturnNull) {
            throw new Error('layer not found (in ' + this.layers.length + ' layers)');
        }
        return null;
    }

    getLayerOld(index: number, doReturnNull?: boolean): null | TLayerFromKlCanvas {
        if (this.layers[index]) {
            return {
                context: this.layers[index].context,
                isVisible: this.layers[index].isVisible,
                opacity: this.layers[index].opacity,
                name: this.layers[index].name,
                id: index,
            };
        }
        if (!doReturnNull) {
            throw new Error(
                'layer of index ' + index + ' not found (in ' + this.layers.length + ' layers)',
            );
        }
        return null;
    }

    getLayer(index: number): TKlCanvasLayer {
        return this.layers[index];
    }

    getColorAt(x: number, y: number): TRgb | undefined {
        let result: TRgb | undefined;
        try {
            result = this.eyedropper.getColorAt(x, y, this.klHistory.getComposed());
        } catch (_) {
            // history probably messed up. but the app should stay operational
        }
        return result;
    }

    getCompleteCanvas(factor: number, maskSelection?: boolean): HTMLCanvasElement {
        return drawProject(this.getProject(), factor, maskSelection ? this.selection : undefined);
    }

    getProject(): TKlProject {
        return {
            projectId: this.klHistory.getComposed().projectId.value,
            width: this.width,
            height: this.height,
            layers: this.layers.map((layer) => {
                return {
                    name: layer.name,
                    isVisible: layer.isVisible,
                    opacity: layer.opacity,
                    mixModeStr: layer.mixModeStr,
                    image: layer.canvas,
                };
            }),
        };
    }

    setMixMode(layerIndex: number, mixModeStr: TMixMode): void {
        const targetLayer = this.layers[layerIndex];
        targetLayer.mixModeStr = mixModeStr;

        if (!this.klHistory.isPaused()) {
            this.klHistory.push({
                layerMap: createLayerMap(this.layers, {
                    layerId: targetLayer.id,
                    attributes: ['mixModeStr'],
                }),
            });
        }
    }

    /**
     * Set composite drawing step for KlCanvasWorkspace.
     * To apply temporary manipulations to a layer.
     *
     * @param layerIndex
     * @param compositeObj
     */
    setComposite(layerIndex: number, compositeObj: undefined | TLayerComposite): void {
        if (!this.layers[layerIndex]) {
            throw new Error('invalid layer');
        }
        this.layers[layerIndex].compositeObj = compositeObj;
    }

    setSelection(selection?: MultiPolygon): void {
        if (!this.selection && !selection) {
            return;
        }

        this.selection = selection;

        this.klHistory.push({
            selection: {
                value: selection,
            },
        });
    }

    getSelection(): KlCanvas['selection'] {
        return this.selection;
    }

    /**
     * called after undo/redo, to apply the changes to the klCanvas.
     * before - before undo/redo was called - equivalent to current state of klCanvas.
     * after - after undo/redo was called.
     */
    updateViaComposed(before: THistoryEntryDataComposed, after: THistoryEntryDataComposed): void {
        this.width = after.size.width;
        this.height = after.size.height;
        this.selection = after.selection.value;
        this.layers = updateLayersViaComposed(this.layers, before, after);
    }

    destroy(): void {
        if (this.isDestroyed) {
            return;
        }
        this.layers.forEach((layer) => {
            BB.freeCanvas(layer.canvas);
            layer.canvas = {} as HTMLCanvasElement;
            layer.context = {} as CanvasRenderingContext2D;
        });
        this.layers = [];
        this.isDestroyed = true;
    }
}
