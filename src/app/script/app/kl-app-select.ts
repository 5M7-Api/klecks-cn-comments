import { SelectUi, TSelectToolMode } from '../klecks/ui/tool-tabs/select-ui';
import { EaselSelect } from '../klecks/ui/easel/tools/easel-select';
import { KlCanvas } from '../klecks/canvas/kl-canvas';
import { throwIfNull } from '../bb/base/base';
import { SelectTool } from '../klecks/select-tool/select-tool';
import { FfdRenderer } from '../klecks/transform/ffd-renderer';
import { KlTempHistory, TTempHistoryEntry } from '../klecks/history/kl-temp-history';
import { StatusOverlay } from '../klecks/ui/components/status-overlay';
import { showModal } from '../klecks/ui/modals/base/showModal';
import { LANG } from '../language/language';
import { KlHistory } from '../klecks/history/kl-history';
import { boundsToRect, rectToBounds } from '../bb/math/math';
import { TInterpolationAlgorithm } from '../klecks/kl-types';
import { klCanvasTransform } from '../klecks/canvas/kl-canvas-transform';
import { testComposedLayerHasTransparency } from '../klecks/filters/filter-transform';
import { klCanvasFfd } from '../klecks/canvas/kl-canvas-ffd';
import {
    centerTransformation,
    flipTransformation,
    freeTransformToMatrix,
    rectToFreeTransform,
    rotateTransformation,
    scaleTransformation,
    TComposedTransformation,
    transformFfd,
    transformSelection,
} from '../klecks/transform/composed-transformation';
import { MultiPolygon } from 'polygon-clipping';
import { createFfdLattice } from '../klecks/transform/ffd';
import { getSelectionBoundsFromSample } from '../klecks/transform/get-selection-sample-bounds';
import { BB } from '../bb/bb';
import { createTransformationComposite } from '../klecks/transform/create-transformation-composite';
import { THistoryExecutionType } from '../klecks/history/kl-history-executor';
import { createSelectionSample, TSelectionSample } from '../klecks/transform/selection-sample';
import { getFfdBounds } from '../klecks/transform/ffd-utils';

export type TSelectTransformTempEntry = {
    type: 'select-transform';
    // 【极客内存优化】：这里存的绝对不是整张图的像素数据，而仅仅是变形过程中的几个核心数学属性。
    // 这样即使用户在一秒内拖拽了 60 次，产生 60 个历史切片，总内存占用也仅有几百 KB。
    data: {
        // 【核心】：纯数学矩阵/四角网格数据
        transform: TComposedTransformation;
        // 用户是按着 Alt 拖拽的吗？(true表示只复制不剪切原图层)
        doClone: boolean;
        targetLayerIndex: number;
        // 背景层是否透明（影响剪切后，原图层挖空部分的补底颜色处理）
        // ? 可能没啥用
        backgroundIsTransparent: boolean;
        // 图像放大缩小重采样时的插值算法 (如 Nearest-neighbor 临近像素, Bilinear 双线性等)
        algorithm: TInterpolationAlgorithm;
    };
};

/**
 * 类型守卫函数 (Type Guard)
 * 作用：在复杂的历史记录栈遍历中，安全、强制地判断当前拿到的条目是否是我们的【选区变形条目】。
 * 保证 TypeScript 在编译期就能拦截掉类型错误。
 */
function isSelectTransformTempEntry(entry: TTempHistoryEntry): entry is TSelectTransformTempEntry {
    return entry.type === 'select-transform' && !!entry.data;
}

/**
 * =========================================================================
 * 变形操作实时状态机 (Transform State)
 * 作用：当选区工具处于“活跃变形状态”时，内存中维护的完整数据结构。
 * 它持有“矢量蚂蚁线”与“抠出的位图小块”，两者在屏幕上同步渲染。
 * =========================================================================
 */
type TTransformState = {
    // 矢量多边形对象 (我们在更早探讨过的那个 3层 map 结构)
    selection?: MultiPolygon;
    // 像素位图样本 (从原画布上抠下来的那块图像)
    selectionSample: TSelectionSample;
    transform: TComposedTransformation;
    algorithm: TInterpolationAlgorithm;
    doClone: boolean;
    // 是否进入了高级的“网格变形/液化(Warp/FFD)”模式 (为后续工具预留的扩展接口)
    isWarping: boolean;
    targetLayerIndex: number;
    // ? 可能没啥用
    backgroundIsTransparent: boolean;
};

/**
 * =========================================================================
 * 初始化变形状态 (State Initialization)
 * 作用：当用户按下“自由变换”快捷键（Ctrl+T）那一瞬间，工厂函数生成初始的“机甲驾驶舱”数据。
 * =========================================================================
 */
function initialiseTransformState(p: {
    selection?: MultiPolygon;
    selectionSample: TSelectionSample;
    algorithm: TInterpolationAlgorithm;
    targetLayerIndex: number;
    backgroundIsTransparent: boolean;
}): TTransformState {
    const selectionSample = p.selectionSample;
     // 【物理引擎绑定】：根据抠出来的像素样本，计算出物理外包围矩形 (Bounding Box)
    // 这个框就是用户稍后在界面上看到的那个带有 8 个控制把手的变形外框
    const selectionBounds = getSelectionBoundsFromSample(p.selectionSample);
    // 初始化变形矩阵数据
    const transform: TComposedTransformation = {
        // no ffd initially
        // 初始状态为普通的“自由变换 (Free Transform)”，尚未启用网格变形 (no ffd initially)
        type: 'free',
        // 矩阵转换：
        // boundsToRect: 把简单的 {x1, y1, x2, y2} 转换成 {x, y, w, h} 的通用矩形格式
        // rectToFreeTransform: 将矩形提取为用于矩阵运算的四角 8 个点坐标 (用于后续的拉伸扭曲计算)
        freeTransform: rectToFreeTransform(boundsToRect(selectionBounds)),
    };

    // 组装并返回这台“变形状态机”的初始数据对象
    return {
        selection: p.selection,
        selectionSample,
        transform,
        algorithm: p.algorithm,
        // 默认不克隆，即执行普通的剪切移动
        doClone: false,
        // 默认只是四角拉伸旋转，不启用高耗能网格扭曲
        isWarping: false,
        targetLayerIndex: p.targetLayerIndex,
        backgroundIsTransparent: p.backgroundIsTransparent,
    };
}

/**
 * =========================================================================
 * 选区工具环境依赖接口 (Dependency Injection)
 * 作用：定义整个选区工具在被创建时，主程序需要给它递交哪些“特权钥匙”。
 * 这是典型的【控制反转 / 依赖注入】架构设计，工具自身极其纯粹，不持有任何全局实体。
 * =========================================================================
 */
export type TKlAppSelectParams = {
    // 画布渲染底座 (包含所有的真实图层大图数据，供提取选区像素用)
    klCanvas: KlCanvas;
    // 暴露获取当前激活图层 2D 上下文的捷径
    getCurrentLayerCtx: () => CanvasRenderingContext2D;
    // 主历史记录栈 (用于记录最终按下 Enter 确认变形后的、昂贵的位图光栅化结果)
    klHistory: KlHistory;
    // 临时交互历史栈 (你的鼠标每次微小拖拽，都会在这里推入上方的 TempEntry 数学快照)
    tempHistory: KlTempHistory;
    // 提示弹窗
    statusOverlay: StatusOverlay;

    // 视图刷新回调
    onUpdateProject: () => void; // update easelProjectUpdater
    // 快捷键指令：在当前选区内直接填充前景色
    onFill: () => void;
    // 快捷键指令：擦除/清空当前选区内容 (对应 Delete 键)
    onErase: () => void;
};

/**
 * Coordinates everything related to selection.
 */
export class KlAppSelect {
    // from params
    private readonly klCanvas: KlCanvas;
    private readonly getCurrentLayerCtx: () => CanvasRenderingContext2D;
    // 主历史记录栈
    private readonly klHistory: KlHistory;
    // 极高频临时历史记录栈 (存数学矩阵快照)
    private readonly tempHistory: KlTempHistory;
    private readonly statusOverlay: StatusOverlay;

    // 外部回调
    private readonly onUpdateProject: () => void;
    private readonly onFill: () => void;
    private readonly onErase: () => void;

    // UI 操控面板
    private readonly selectUi: SelectUi;
    // 视图层工具：负责在屏幕上渲染那条一直在动的“蚂蚁线”！
    private readonly easelSelect: EaselSelect; // easel tool
    // 逻辑层工具：负责接管鼠标移动，计算多边形路径。
    private readonly selectTool: SelectTool;
    // 高级网格变形 (Free-Form Deformation) 渲染器
    private readonly ffdRenderer: FfdRenderer;
    private readonly onVisibilityChange: () => void;

    // state
    private selectMode: TSelectToolMode = 'select';// 默认是 'select' (用套索画圈)。按下Ctrl+T变成 'transform'
    private transformState: undefined | TTransformState;// 当进入 'transform' 模式时，挂载极其复杂的变形状态数据。

    // ----------------------------------- private methods -----------------------------------

    /**
     * 【脏检查优化】：判断用户是否真的对选区进行了变形操作。
     * 
     * 应用场景：用户按了 Ctrl+T 唤出了变形框，但手抖了一下又直接按了 Enter 或 Esc。
     * 此时实际上图像并没有发生任何物理改变。
     * 如果不加这个检查，系统会傻乎乎地去执行极其耗时的“图像重采样(Resampling)”并推入主历史栈，
     * 导致内存白白浪费，甚至卡顿一下。
     * 
     * @returns boolean 是否发生了实质性的物理变化
     */
    private isTransformationChanged(): boolean {
        // 如果根本不在变形模式，自然没变
        if (!this.transformState) {
            return false;
        }
        // 拿出临时历史栈里的第 0 个快照 
        const initial = this.tempHistory.getEntries()[0];
        // 【防呆断言】：确保拿到的第一条记录真的是针对变形的快照
        if (!isSelectTransformTempEntry(initial)) {
            throw new Error('initial temp history entry has wrong type');
        }
        // 判断 1：用户是不是中途按住了 Alt 键，把“剪切移动”变成了“复制移动”？如果是，说明发生变化了！
        if (this.transformState.doClone !== initial.data.doClone) {
            return true;
        }
        // 判断 2：用户是不是在变形中途，跑到图层面板切换了正在操控的图层？
        if (this.transformState.targetLayerIndex !== initial.data.targetLayerIndex) {
            return true;
        }
        // 判断 3：【暴力但高效的矩阵对比】
        // 数学上要完美对比两个自由变换矩阵是否完全相等非常麻烦 (涉及浮点数精度、浮点偏移等)。
        // 这里的架构师选择了一种极其接地气的工业解法：直接 JSON 序列化比较字符串！
        // 如果四个角的顶点坐标发生了一丝一毫的偏离，生成的 JSON 字符串必然不同。
        // not perfect but would be a lot of effort to determine if two transforms are equivalent
        return (
            JSON.stringify(this.transformState.transform) !== JSON.stringify(initial.data.transform)
        );
    }

    /**
     * 【图形学清理】：重置底层 Canvas 的图层合成属性 (Composites)
     * 
     * 背景知识：在变形选区的时候（特别是拖拽移动一小块图像时），
     * 为了让用户实时预览这块图像悬浮在别的图层上方的效果，引擎通常会在内部使用 
     * globalCompositeOperation = 'destination-out' 挖空原图，然后在上方用另一层临时画出悬浮块。
     * 
     * 作用：当变形被确认或取消时，必须把这些底层的“挖空/悬浮”特效撤掉，恢复图层原貌。
     */
    /** reset KlCanvas layer composites **/
    private resetKlCanvasLayerComposites(): void {
        const srcLayerCtx = this.getCurrentLayerCtx();
        // 获取当前工作图层在整个大画板里的绝对索引
        // throwIfNull 是一个严格断言防御：如果找不到图层，立刻报错崩溃，绝不带着脏数据往下走。
        const srcLayerIndex = throwIfNull(this.klCanvas.getLayerIndex(srcLayerCtx.canvas));
        // 抹除当前图层身上挂载的特殊混合模式特效
        this.klCanvas.setComposite(srcLayerIndex, undefined);
         // 如果在变形过程中，用户跨图层操作了（比如把 A 图层的像素扣出来移到了 B 图层）
        // 还要顺便把 B 图层身上的特效也给扒掉。
        if (this.transformState && this.transformState.targetLayerIndex !== srcLayerIndex) {
            this.klCanvas.setComposite(this.transformState.targetLayerIndex, undefined);
        }
    }

    private updateComposites(): void {
        if (!this.transformState) {
            return;
        }

        const srcLayerCanvas = this.getCurrentLayerCtx().canvas;
        const srcLayerIndex = throwIfNull(this.klCanvas.getLayerIndex(srcLayerCanvas));

        const config: Parameters<typeof createTransformationComposite>[0] = {
            klCanvasWidth: this.klCanvas.getWidth(),
            klCanvasHeight: this.klCanvas.getHeight(),
            transform: this.transformState.transform,
            selection: this.transformState.selection,
            selectionSample: this.transformState.selectionSample,
            algorithm: this.transformState.algorithm,
            doClone: this.transformState.doClone,
            backgroundIsTransparent:
                srcLayerIndex !== 0 || this.transformState.backgroundIsTransparent,
            ffdRenderer: this.ffdRenderer,
        };
        if (srcLayerIndex === this.transformState.targetLayerIndex) {
            this.klCanvas.setComposite(
                srcLayerIndex,
                createTransformationComposite(config, 'same'),
            );
        } else {
            this.klCanvas.setComposite(srcLayerIndex, createTransformationComposite(config, 'src'));
            this.klCanvas.setComposite(
                this.transformState.targetLayerIndex,
                createTransformationComposite(config, 'dest'),
            );
        }
    }

    private updateUiLayerList(): void {
        this.selectUi.setLayers(
            this.klCanvas.getLayers().map((layer) => {
                return layer.name;
            }),
        );
    }

    private resetSelection(): void {
        this.selectTool.reset();
        const selection = this.selectTool.getSelection();
        this.klCanvas.setSelection(selection);
        this.selectUi.setHasSelection(!!selection);
    }

    private tempHistoryPush(): void {
        if (!this.transformState) {
            return;
        }
        const newEntry: TSelectTransformTempEntry = {
            type: 'select-transform',
            data: {
                transform: BB.copyObj(this.transformState.transform),
                doClone: this.transformState.doClone,
                targetLayerIndex: this.transformState.targetLayerIndex,
                backgroundIsTransparent: this.transformState.backgroundIsTransparent,
                algorithm: this.transformState.algorithm,
            },
        };
        const topEntry = this.tempHistory.getEntries().at(-1);
        // skip if no change
        if (JSON.stringify(newEntry) === JSON.stringify(topEntry)) {
            return;
        }
        this.tempHistory.push(newEntry);
    }

    private propagateTransformationChange(skipPushUndo = false): void {
        if (!this.transformState) {
            return;
        }
        if (this.transformState.selection) {
            const selection = transformSelection(
                this.transformState.transform,
                this.transformState.selection,
            );
            this.easelSelect.setRenderedSelection(selection);
        }
        this.updateComposites();
        this.onUpdateProject();
        this.updateSelectUi();

        !skipPushUndo && this.tempHistoryPush();
    }

    private updateSelectUi(): void {
        if (!this.transformState) {
            return;
        }
        if (this.transformState.transform.type !== 'ffd') {
            this.selectUi.setFreeTransformTransformation(
                this.transformState.transform.freeTransform,
            );
        }
    }

    private clearTransformState(): void {
        if (this.transformState) {
            BB.freeCanvas(this.transformState.selectionSample.image);
            this.transformState = undefined;
        }
    }

    // ----------------------------------- public -----------------------------------
    constructor(p: TKlAppSelectParams) {
        this.klCanvas = p.klCanvas;
        this.onUpdateProject = p.onUpdateProject;
        this.getCurrentLayerCtx = p.getCurrentLayerCtx;
        this.klHistory = p.klHistory;
        this.tempHistory = p.tempHistory;
        this.statusOverlay = p.statusOverlay;
        this.onFill = p.onFill;
        this.onErase = p.onErase;

        // keep layer list up-to-date
        this.klHistory.addListener(() => {
            this.selectUi.setHasSelection(!!this.klCanvas.getSelection());
            if (this.selectMode === 'transform') {
                this.updateUiLayerList();
            }
        });

        this.selectTool = new SelectTool({
            klCanvas: this.klCanvas,
        });
        this.ffdRenderer = new FfdRenderer();
        this.onVisibilityChange = () => {
            if (document.hidden && this.selectMode === 'transform') {
                this.ffdRenderer.freeResources();
            }
        };
        document.addEventListener('visibilitychange', this.onVisibilityChange);

        this.easelSelect = new EaselSelect({
            selectMode: this.selectMode,
            onStartSelect: (p, operation) => this.selectTool.startSelect(p, operation),
            onGoSelect: (p, isShiftPressed) => {
                this.selectTool.goSelect(p, isShiftPressed);
                this.easelSelect.setRenderedSelection(this.selectTool.getSelection());
            },
            onEndSelect: () => {
                this.selectTool.endSelect();
                const selection = this.selectTool.getSelection();
                this.easelSelect.clearRenderedSelection();
                this.klCanvas.setSelection(selection);
                this.selectUi.setHasSelection(!!selection);
            },
            onStartMoveSelect: (p) => {
                this.selectTool.startMoveSelect(p);
            },
            onGoMoveSelect: (p, isShiftPressed) => {
                this.selectTool.goMoveSelect(p, isShiftPressed);
                this.easelSelect.setRenderedSelection(this.selectTool.getSelection());
            },
            onEndMoveSelect: () => {
                this.selectTool.endMoveSelect();
                if (!this.selectTool.getDidMove()) {
                    return;
                }
                const selection = this.selectTool.getSelection();
                this.easelSelect.clearRenderedSelection();
                this.klCanvas.setSelection(selection);
                this.selectUi.setHasSelection(!!selection);
            },
            onSelectAddPoly: (p, operation) => {
                this.selectTool.addPoly(p, operation);
                const selection = this.selectTool.getSelection();
                this.klCanvas.setSelection(selection);
                this.selectUi.setHasSelection(!!selection);
            },
            onResetSelection: () => this.resetSelection(),
            onTransform: (transform) => {
                if (!this.transformState) {
                    return;
                }
                this.transformState.transform = transform;
                this.propagateTransformationChange(true);
            },
            onTransformEnd: () => {
                this.tempHistoryPush();
            },
        });

        this.selectUi = new SelectUi({
            onChangeMode: (mode) => {
                if (mode === 'select') {
                    const layerIndex = throwIfNull(
                        this.klCanvas.getLayerIndex(this.getCurrentLayerCtx().canvas),
                    );
                    if (
                        this.transformState &&
                        (this.isTransformationChanged() ||
                            this.transformState.doClone ||
                            layerIndex !== this.transformState.targetLayerIndex ||
                            this.selectUi.getIsWarping())
                    ) {
                        // something changed -> apply

                        const transform = this.transformState.transform;
                        if (transform.type === 'free') {
                            klCanvasTransform({
                                klCanvas: this.klCanvas,
                                selectionSample: this.transformState.selectionSample,
                                ...(this.transformState.doClone
                                    ? {}
                                    : { eraseLayerIndex: layerIndex }),
                                targetLayerIndex: this.transformState.targetLayerIndex,
                                freeTransform: transform.freeTransform,
                                backgroundIsTransparent:
                                    this.transformState.backgroundIsTransparent,
                                algorithm: this.transformState.algorithm,
                                selection: this.transformState.selection,
                            });
                        } else {
                            const ffd =
                                transform.type === 'ffd+free'
                                    ? transformFfd(
                                          transform.ffd,
                                          freeTransformToMatrix(
                                              transform.freeTransform,
                                              rectToBounds(transform.ffdBounds, 'index'),
                                          ),
                                      )
                                    : transform.ffd;
                            if (this.transformState.doClone) {
                                klCanvasFfd({
                                    klCanvas: this.klCanvas,
                                    selectionSample: this.transformState.selectionSample,
                                    targetLayerIndex: this.transformState.targetLayerIndex,
                                    ffd,
                                    algorithm: this.transformState.algorithm,
                                    selection: this.transformState.selection,
                                    ffdRenderer: this.ffdRenderer,
                                });
                            } else {
                                klCanvasFfd({
                                    klCanvas: this.klCanvas,
                                    selectionSample: this.transformState.selectionSample,
                                    eraseLayerIndex: layerIndex,
                                    targetLayerIndex: this.transformState.targetLayerIndex,
                                    ffd,
                                    backgroundIsTransparent:
                                        this.transformState.backgroundIsTransparent,
                                    algorithm: this.transformState.algorithm,
                                    selection: this.transformState.selection,
                                    ffdRenderer: this.ffdRenderer,
                                });
                            }
                        }
                        this.clearTransformState();
                        p.statusOverlay.out(LANG('select-transform-applied'), true);
                    }

                    this.tempHistory.clear();
                    this.tempHistory.setIsActive(false);
                    this.selectUi.setIsWarping(false);
                    this.resetKlCanvasLayerComposites();
                    this.ffdRenderer.freeResources();
                    this.easelSelect.clearRenderedSelection(true);
                    const selection = this.klCanvas.getSelection();
                    this.selectTool.setSelection(selection);
                    this.selectUi.setHasSelection(!!selection);
                    this.onUpdateProject();
                    this.easelSelect.setMode(mode);
                } else {
                    // -> transform

                    // avoid changing state while mode-change can be rejected
                    const currentLayerCanvas = this.getCurrentLayerCtx().canvas;
                    const layerIndex = throwIfNull(this.klCanvas.getLayerIndex(currentLayerCanvas));
                    const selectionSample = createSelectionSample(layerIndex, this.klCanvas);
                    if (!selectionSample) {
                        setTimeout(() => {
                            showModal({
                                message: LANG('select-transform-empty'),
                                type: 'error',
                            });
                        });
                        return false;
                    }

                    this.tempHistory.setIsActive(true);
                    const isBgLayer = layerIndex === 0;
                    let isTransparent = false;
                    if (isBgLayer) {
                        const layer = Object.entries(this.klHistory.getComposed().layerMap).find(
                            ([_, layer]) => layer.index === layerIndex,
                        )![1];
                        isTransparent = testComposedLayerHasTransparency(layer);
                        this.selectUi.setBackgroundIsTransparent(isTransparent);
                    }
                    this.transformState = initialiseTransformState({
                        selection: this.klCanvas.getSelection(),
                        selectionSample: selectionSample,
                        algorithm: this.selectUi.getAlgorithm(),
                        targetLayerIndex: layerIndex,
                        backgroundIsTransparent: isTransparent,
                    });

                    // push initial state
                    this.tempHistoryPush();

                    this.selectUi.setShowTransparentBackgroundToggle(isBgLayer);
                    this.updateComposites();
                    this.updateUiLayerList();
                    this.selectUi.setMoveToLayer(undefined);
                    this.onUpdateProject();
                    this.easelSelect.setMode(mode);
                    if (this.transformState.selection) {
                        const transformedSelection = transformSelection(
                            this.transformState.transform,
                            this.transformState.selection,
                        );
                        this.easelSelect.setRenderedSelection(transformedSelection);
                    }
                    this.easelSelect.initialiseTransform(this.transformState.transform);
                    this.updateSelectUi();
                }
                this.selectMode = mode;
                return true;
            },
            onChangeBooleanOperation: (operation) => {
                this.easelSelect.setBooleanOperation(operation);
            },
            select: {
                shape: this.selectTool.getShape(),
                onChangeShape: (shape) => {
                    this.selectTool.setShape(shape);
                    this.easelSelect.setSelectShape(shape);
                },
                onReset: () => this.resetSelection(),
                onAll: () => {
                    this.selectTool.selectAll();
                    const selection = this.selectTool.getSelection();
                    this.klCanvas.setSelection(selection);
                    this.selectUi.setHasSelection(!!selection);
                },
                onInvert: () => {
                    this.selectTool.invertSelection();
                    const selection = this.selectTool.getSelection();
                    this.klCanvas.setSelection(selection);
                    this.selectUi.setHasSelection(!!selection);
                },
            },
            transform: {
                onFlipY: () => {
                    if (!this.transformState) {
                        return;
                    }
                    this.transformState.transform = flipTransformation(
                        this.transformState.transform,
                        'y',
                    );
                    this.propagateTransformationChange();
                    this.easelSelect.setTransform(this.transformState.transform);
                },
                onFlipX: () => {
                    if (!this.transformState) {
                        return;
                    }
                    this.transformState.transform = flipTransformation(
                        this.transformState.transform,
                        'x',
                    );
                    this.propagateTransformationChange();
                    this.easelSelect.setTransform(this.transformState.transform);
                },
                onRotateDeg: (deg) => {
                    if (!this.transformState) {
                        return;
                    }
                    this.transformState.transform = rotateTransformation(
                        this.transformState.transform,
                        deg,
                    );
                    this.propagateTransformationChange();
                    this.easelSelect.setTransform(this.transformState.transform);
                },
                onClone: () => {
                    if (!this.transformState) {
                        return;
                    }
                    // commit
                    const layerIndex = throwIfNull(
                        this.klCanvas.getLayerIndex(this.getCurrentLayerCtx().canvas),
                    );
                    const transform = this.transformState.transform;
                    // apply
                    // should always apply. user might want to make something more opaque.
                    if (transform.type === 'free') {
                        if (this.transformState.doClone) {
                            klCanvasTransform({
                                klCanvas: this.klCanvas,
                                selectionSample: this.transformState.selectionSample,
                                targetLayerIndex: this.transformState.targetLayerIndex,
                                freeTransform: transform.freeTransform,
                                algorithm: this.transformState.algorithm,
                                selection: this.transformState.selection,
                            });
                        } else if (this.isTransformationChanged()) {
                            klCanvasTransform({
                                klCanvas: this.klCanvas,
                                selectionSample: this.transformState.selectionSample,
                                eraseLayerIndex: layerIndex,
                                targetLayerIndex: this.transformState.targetLayerIndex,
                                freeTransform: transform.freeTransform,
                                backgroundIsTransparent:
                                    this.transformState.backgroundIsTransparent,
                                algorithm: this.transformState.algorithm,
                                selection: this.transformState.selection,
                            });
                        }
                    } else {
                        const ffd =
                            transform.type === 'ffd+free'
                                ? transformFfd(
                                      transform.ffd,
                                      freeTransformToMatrix(
                                          transform.freeTransform,
                                          rectToBounds(transform.ffdBounds, 'index'),
                                      ),
                                  )
                                : transform.ffd;
                        if (this.transformState.doClone) {
                            klCanvasFfd({
                                klCanvas: this.klCanvas,
                                selectionSample: this.transformState.selectionSample,
                                targetLayerIndex: this.transformState.targetLayerIndex,
                                ffd,
                                algorithm: this.transformState.algorithm,
                                selection: this.transformState.selection,
                                ffdRenderer: this.ffdRenderer,
                            });
                        } else if (this.isTransformationChanged()) {
                            klCanvasFfd({
                                klCanvas: this.klCanvas,
                                selectionSample: this.transformState.selectionSample,
                                eraseLayerIndex: layerIndex,
                                targetLayerIndex: this.transformState.targetLayerIndex,
                                ffd,
                                backgroundIsTransparent:
                                    this.transformState.backgroundIsTransparent,
                                algorithm: this.transformState.algorithm,
                                selection: this.transformState.selection,
                                ffdRenderer: this.ffdRenderer,
                            });
                        }
                    }

                    this.tempHistory.clear();
                    // push initial state
                    this.tempHistoryPush();

                    this.transformState.doClone = true;
                    this.updateComposites();
                    this.onUpdateProject();

                    this.statusOverlay.out(LANG('select-transform-clone-applied'), true);
                },
                onScale: (factor) => {
                    if (!this.transformState) {
                        return;
                    }
                    this.transformState.transform = scaleTransformation(
                        this.transformState.transform,
                        factor,
                    );
                    this.propagateTransformationChange();
                    this.easelSelect.setTransform(this.transformState.transform);
                },
                onCenter: () => {
                    if (!this.transformState) {
                        return;
                    }
                    this.transformState.transform = centerTransformation(
                        this.transformState.transform,
                        {
                            x: this.klCanvas.getWidth() / 2,
                            y: this.klCanvas.getHeight() / 2,
                        },
                    );
                    this.propagateTransformationChange();
                    this.easelSelect.setTransform(this.transformState.transform);
                },
                onMoveToLayer: (index) => {
                    if (!this.transformState) {
                        return;
                    }
                    this.resetKlCanvasLayerComposites();
                    this.transformState.targetLayerIndex = index;
                    this.updateComposites();
                    this.onUpdateProject();
                    this.tempHistoryPush();
                },
                onChangeTransparentBackground: (isTransparent) => {
                    if (!this.transformState) {
                        return;
                    }
                    this.transformState.backgroundIsTransparent = isTransparent;
                    this.updateComposites();
                    this.onUpdateProject();
                    this.tempHistoryPush();
                },
                onChangeAlgorithm: (algorithm) => {
                    if (!this.transformState) {
                        return;
                    }
                    this.transformState.algorithm = algorithm;
                    this.updateComposites();
                    this.onUpdateProject();
                    this.tempHistoryPush();
                },
                onChangeConstrain: (isConstrained) => {
                    this.easelSelect.setIsConstrained(isConstrained);
                },
                onChangeSnapping: (isSnapping) => {
                    this.easelSelect.setIsSnapping(isSnapping);
                },
                onChangeWarp: (isWarping) => {
                    if (!this.transformState) {
                        return;
                    }
                    const transform = this.transformState.transform;
                    if (isWarping) {
                        if (transform.type === 'free') {
                            const selectionBounds = getSelectionBoundsFromSample(
                                this.transformState.selectionSample,
                            );
                            const matrix = freeTransformToMatrix(
                                transform.freeTransform,
                                selectionBounds,
                            );
                            this.transformState.transform = {
                                type: 'ffd',
                                ffd: transformFfd(
                                    createFfdLattice(5, 5, boundsToRect(selectionBounds)),
                                    matrix,
                                ),
                            };
                        } else if (transform.type === 'ffd+free') {
                            const matrix = freeTransformToMatrix(
                                transform.freeTransform,
                                rectToBounds(transform.ffdBounds, 'index'),
                            );
                            this.transformState.transform = {
                                type: 'ffd',
                                ffd: transformFfd(transform.ffd, matrix),
                            };
                        }
                    } else {
                        if (transform.type === 'ffd') {
                            const ffdBounds = boundsToRect(getFfdBounds(transform.ffd));
                            const freeTransform = rectToFreeTransform(ffdBounds);
                            this.transformState.transform = {
                                type: 'ffd+free',
                                ffd: BB.copyObj(transform.ffd),
                                ffdBounds,
                                freeTransform,
                            };
                        }
                    }
                    this.transformState.isWarping = isWarping;
                    this.easelSelect.setTransform(this.transformState.transform);
                    this.updateComposites();
                    this.onUpdateProject();
                    this.tempHistoryPush();
                },
            },
            onErase: () => {
                this.onErase();
            },
            onFill: () => {
                this.onFill();
            },
        });

        this.klHistory.addListener(() => {
            const selection = this.klCanvas.getSelection();
            if (this.selectMode === 'select') {
                this.selectTool.setSelection(selection);
            }
        });
    }

    getSelectUi(): SelectUi {
        return this.selectUi;
    }

    getEaselSelect(): EaselSelect {
        return this.easelSelect;
    }

    getSelectMode(): TSelectToolMode {
        return this.selectMode;
    }

    /**
     * If transform changed something, changes are applied. -> return true
     * If no changes applied -> return false
     */
    commitTransform(): boolean {
        let result = false;
        if (this.selectMode === 'transform') {
            this.selectUi.setMode('select'); // this triggers selectUi.onMode
            result = true;
        }
        return result;
    }

    /** if transforming, changes are discarded */
    discardTransform(): boolean {
        if (this.selectMode === 'transform') {
            // so there's no transformation to apply.
            this.clearTransformState();
            // this triggers selectUi.onMode synchronously, which does the cleanup
            this.selectUi.setMode('select');
            return true;
        }
        return false;
    }

    onHistory(type: THistoryExecutionType): void {
        if (this.transformState && (type === 'tempUndo' || type === 'tempRedo')) {
            this.resetKlCanvasLayerComposites();
            // recreate
            const entries = this.tempHistory.getEntries();
            const top = entries.at(-1)!;
            if (!isSelectTransformTempEntry(top)) {
                return;
            }
            const state = top.data;
            this.transformState.transform = BB.copyObj(state.transform);
            this.transformState.doClone = state.doClone;
            this.transformState.targetLayerIndex = state.targetLayerIndex;
            this.transformState.backgroundIsTransparent = state.backgroundIsTransparent;
            this.transformState.algorithm = state.algorithm;
            this.transformState.isWarping = state.transform.type === 'ffd';
            this.selectUi.setBackgroundIsTransparent(state.backgroundIsTransparent);
            this.selectUi.setAlgorithm(state.algorithm);
            this.selectUi.setIsWarping(state.transform.type === 'ffd');

            if (this.transformState.selection) {
                const selection = transformSelection(
                    this.transformState.transform,
                    this.transformState.selection,
                );
                this.easelSelect.setRenderedSelection(selection);
            }
            this.easelSelect.setTransform(this.transformState.transform);
            this.selectUi.setMoveToLayer(
                this.klCanvas.getLayerIndex(this.getCurrentLayerCtx().canvas) ===
                    state.targetLayerIndex
                    ? undefined
                    : state.targetLayerIndex,
            );
            this.updateComposites();
            this.onUpdateProject();
            this.updateSelectUi();
        }
    }

    destroy(): void {
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
        // not a proper cleanup yet
    }
}
