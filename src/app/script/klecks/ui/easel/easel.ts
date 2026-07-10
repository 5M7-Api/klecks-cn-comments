import { c } from '../../../bb/base/c';
import { ProjectViewport, TViewportTransform } from '../project-viewport/project-viewport';
import { PointerListener } from '../../../bb/input/pointer-listener';
import { BB } from '../../../bb/bb';
import { toMetaTransform } from '../../../bb/transform/to-meta-transform';
import { createTransform } from '../../../bb/transform/create-transform';
import { createMatrixFromTransform } from '../../../bb/transform/create-matrix-from-transform';
import { applyToPoint, inverse } from 'transformation-matrix';
import { EaselPointerPreprocessor } from './easel-pointer-preprocessor';
import { KeyListener } from '../../../bb/input/key-listener';
import {
    TArrowKey,
    TEaselInterface,
    TEaselProject,
    TEaselTool,
    TEaselToolTrigger,
} from './easel.types';
import { TVector2D } from '../../../bb/bb-types';
import { zoomByStep } from '../project-viewport/utils/zoom-by-step';
import { SelectionRenderer } from './selection-renderer';
import { KL_CONFIG } from '../../kl-config';
import { minimizeAngleDeg, snapAngleDeg } from '../../../bb/math/math';
import {
    DEFAULT_DOUBLE_TAP_POINTER_TYPES,
    EASEL_MAX_SCALE,
    EASEL_MIN_SCALE,
    TEMP_TRIGGERS,
    TEMP_TRIGGERS_KEYS,
} from './easel.config';
import { isTransformEqual } from '../project-viewport/utils/is-transform-equal';
import { blendTransform } from '../project-viewport/utils/blend-transform';
import { getFitRectTransform } from '../project-viewport/utils/get-fit-rect-transform';
import { css } from '../../../bb/base/base';
import { TWheelEvent } from '../../../bb/input/event.types';

function getToolEntries<GToolId extends string>(
    tools: Record<GToolId, TEaselTool>,
): [GToolId, TEaselTool][] {
    return Object.entries(tools) as [GToolId, TEaselTool][];
}

export type TEaselParams<GToolId extends string> = {
    width: number; // size of DOM element
    height: number; // size of DOM element
    project: TEaselProject;
    tools: Record<GToolId, TEaselTool>;
    tool: NoInfer<GToolId>;
    onChangeTool: (toolId: NoInfer<GToolId>) => void;
    onTransformChange: (transform: TViewportTransform, scaleOrAngleChanged: boolean) => void; // whenever Viewport changes
    onUndo?: () => void; // gesture triggers undo
    onRedo?: () => void; // gesture triggers redo
};


/**
 * 这是一个交互式的“项目视图窗口（Project Viewport）”，它同时负责渲染选区（蚂蚁线）。
 * 你通过不同的“模式（也就是各种 Tool）”与它交互。
 * 同一时间只能激活一个 Tool，但允许通过按键触发临时 Tool 覆盖它（比如按住空格键变成拖拽手型）。
 */
/**
 * An interactive project viewport, that also renders the selection. You interact with it through modes (aka tools).
 * One tool is active at a time. temp trigger can overwrite it temporarily.
 */
export class Easel<GToolId extends string> {
    // === 核心 DOM 节点 ===
    // 整个画架的根节点
    private readonly rootEl: HTMLElement;
    // 覆盖在画布上的 SVG 层，用于渲染各工具的自定义光标（如笔刷圈）
    private readonly svgEl: SVGElement; // each tool gets an element in this SVG tag, for an SVG overlay
    // 覆盖在画布上的 HTML 层，用于交互UI（如文字输入框）
    private readonly htmlOverlayEl: HTMLElement; // each tool can get an element in this html node, for an interactive overlay

    // === 核心功能模块 ===
    // 真正的渲染引擎（处理多个 Canvas 图层组合）
    private readonly viewport: ProjectViewport;

    private readonly pointerPreprocessor: EaselPointerPreprocessor;
    private readonly pointerListener: PointerListener;
    private readonly windowPointerListener: (e: PointerEvent) => void;
    // 键盘监听器：处理快捷键（缩放、工具切换等）
    private readonly keyListener: KeyListener;
    // 选区渲染器：专门画那圈闪烁的蚂蚁线
    private readonly selectionRenderer: SelectionRenderer;

    // from params
    private readonly toolsMap: TEaselParams<GToolId>['tools'];
    // temp tool is tool that is active during holding a key or mouse button (e.g. hold space -> hand tool)
    private readonly tempTools: Record<TEaselToolTrigger, GToolId | undefined>;
    private readonly onChangeTool: TEaselParams<GToolId>['onChangeTool'];
    private readonly onTransformChange: (
        transform: TViewportTransform,
        scaleOrAngleChanged: boolean,
    ) => void;
    private readonly onUndo: (() => void) | undefined;
    private readonly onRedo: (() => void) | undefined;

    // state
    private project: TEaselProject;
    private width: number;
    private height: number;
    // 激活的工具（笔刷）和临时工具
    private toolId: GToolId;
    private tempToolId: GToolId | undefined;
    private animationFrameId: ReturnType<typeof requestAnimationFrame> | undefined;
    // 渲染锁：如果为 true，下一帧就会重绘。优化性能，避免无意义的空跑
    private doRender = false; // true -> will render on next renderLoop
    private cursorPos: TVector2D | undefined; // so brush cursor not top left corner after reload
    private isFrozen: boolean = false; // disable interaction with the easel whatsoever

    // === 视图变换矩阵（极其核心！） ===
    // lastRenderedTransform 记录上一帧画在屏幕上的真实状态
    private lastRenderedTransform: TViewportTransform = {} as TViewportTransform; // previously rendered viewport transformation
    private pinchInitialTransform: TViewportTransform | undefined; // when starting a pinch-to-zoom gesture
    // targetTransform 记录用户“期望”到达的状态。比如用户鼠标滚轮滚了一下，期望放大两倍。
    // Easel 会通过 renderLoop 里的缓动动画，让真实状态平滑过渡到 targetTransform。
    private targetTransform: TViewportTransform = {} as TViewportTransform;

    // === 内部暴露给各工具的超级 API (easelInterface) ===
    // 所有的笔刷、橡皮、油漆桶等工具，本身是个独立类。
    // Easel 在初始化时把这个 interface 塞给它们，它们就能通过这里获取画布尺寸、修改光标、请求重绘。
    // custom interface passed to tools
    private readonly easelInterface: TEaselInterface = {
        setCursor: (cursor) => (this.rootEl.style.cursor = cursor),
        getTransform: () => this.viewport.getTransform(),
        getTargetTransform: () => this.targetTransform,
        getSize: () => ({ width: this.width, height: this.height }),
        getProjectSize: () => ({ width: this.project.width, height: this.project.height }),
        setTransform: (transform, isImmediate) => this.setTargetTransform(transform, isImmediate),
        requestRender: () => this.requestRender(),
        isKeyPressed: (keyStr) => this.keyListener.isPressed(keyStr),
        minScale: EASEL_MIN_SCALE,
        maxScale: EASEL_MAX_SCALE,
        setAngleDeg: (...args) => this.setAngleDeg(...args),
        keyListener: {} as KeyListener, // this.keyListener
        updateDoubleTapPointerTypes: () => this.updateDoubleTapPointerTypes(),
        setRenderedSelection: (selection) => this.selectionRenderer.setRenderedSelection(selection),
        clearRenderedSelection: (isImmediate) =>
            this.selectionRenderer.clearRenderedSelection(isImmediate),
        onWheel: (e) => this.onWheel(e),
        getElement: () => this.rootEl,
    };

    /**
     * 【极其核心】更新视图变换目标
     * 当发生缩放、平移、旋转时，并不马上重绘画布！
     * 而是更新 targetTransform，并把 doRender 设为 true。真正的绘制由 renderLoop 统一在下一帧调度。
     */
    private setTargetTransform(transform: TViewportTransform, isImmediate?: boolean): void {
        if (isImmediate) {
            // 如果要求立即生效（比如手势捏合时），不走缓动动画，直接强制设置给底层 viewport
            this.viewport.setTransform(transform);
        }
        this.targetTransform = transform;
        this.doRender = true;
    }

    /**
     * 选择是否让预先存在的工具图标要素·渲染出来
     */
    private updateToolSvgs(): void {
        const tool = this.tempToolId ?? this.toolId;
        Object.keys(this.toolsMap).forEach((toolId) => {
            this.toolsMap[toolId as GToolId].getSvgElement().style.display =
                toolId === tool ? '' : 'none';
        });
    }

    // different tools allow different pointer types to trigger the gesture
    private updateDoubleTapPointerTypes(): void {
        const pointerTypes =
            this.toolsMap[this.tempToolId ?? this.toolId].doubleTapPointerTypes ??
            DEFAULT_DOUBLE_TAP_POINTER_TYPES;
        this.pointerPreprocessor.setDoubleTapPointerTypes(pointerTypes);
    }

    private lastFrameTimestamp: number = 0;
    /**
     * 【引擎心脏】基于 requestAnimationFrame 的无限循环
     * 这是整个 Easel 的动力源，每秒执行 60 次（取决于屏幕刷新率）。
     */
    /**
     * Only call once from outside. Will perpetuate itself and render when doRender = true
     */
    private renderLoop(): void {
        const now = performance.now();
        const deltaMs = now - this.lastFrameTimestamp;
        this.lastFrameTimestamp = now;

        // 自己调度自己，形成死循环
        this.animationFrameId = requestAnimationFrame(() => this.renderLoop());
        if (!this.doRender) {
            // 【性能优化】如果没有发生任何需要更新的动作（鼠标没动、没按笔、没缩放），直接跳过！绝不浪费 CPU/GPU。
            return;
        }
        const tool = this.getActiveTool();
        // 当前屏幕上真实的变换状态
        const oldTransform = this.viewport.getTransform();
        let newTransform = oldTransform;


        if (isTransformEqual(oldTransform, this.targetTransform)) {
            // 如果当前的真实状态，已经无限接近用户期望的状态，那就停止渲染。
            this.doRender = false;
        } else {
            // 【丝滑缓动计算】
            // 如果用户滚了一下鼠标滚轮（targetTransform 瞬间变大），画面不能“啪”地一下变大，会很突兀。
            // 这里根据刷新时间差 (deltaMs) 计算出一个插值因子，让 oldTransform 向 targetTransform 平滑地过渡一点点。
            // 这就是你觉得界面缩放特别“有弹性、很高级”的秘密。
            const defaultDeltaMs = 1000 / 60;
            const timeFactor = deltaMs / defaultDeltaMs;
            const easeFactor = 1 - 0.7 ** timeFactor;
             // 用于优化一个直线的过渡路径
            newTransform = blendTransform(
                oldTransform,
                this.targetTransform,
                {
                    width: this.project.width,
                    height: this.project.height,
                },
                // 以屏幕中心为缓动基准
                {
                    x: this.width / 2,
                    y: this.height / 2,
                },
                easeFactor,
            );
            // 把平滑过渡了一点点的新矩阵，喂给底层引擎
            this.viewport.setTransform(newTransform);
        }

        // todo: is last renderedTransform needed?

        const isPositionChanged =
            newTransform.x !== this.lastRenderedTransform.x ||
            newTransform.y !== this.lastRenderedTransform.y;
        const isScaleOrAngleChanged =
            newTransform.scale !== this.lastRenderedTransform.scale ||
            newTransform.angleDeg !== this.lastRenderedTransform.angleDeg;

        // 【触发底层重绘】如果矩阵发生变化，或者画笔留下了一道墨水，这里会真正把像素画到 <canvas> 标签上。
        this.viewport.render(!isTransformEqual(oldTransform, newTransform));
        if (isPositionChanged || isScaleOrAngleChanged) {
            // 如果画布矩阵变了，通知当前使用的工具（比如有特殊需求的网格工具）和选区蚂蚁线跟着一起动。
            tool.onUpdateTransform?.(newTransform);
            this.selectionRenderer.setTransform(newTransform);
            this.onTransformChange(this.targetTransform, isScaleOrAngleChanged);
            this.lastRenderedTransform = newTransform;
        }
    }

    /**
     * activate temporary tool. Can only push one.
     */
    private pushTempTool(toolId: GToolId | undefined): void {
        if (this.tempToolId !== undefined || toolId === undefined) {
            return;
        }
        const tool = this.toolsMap[this.toolId];
        if (tool.getIsLocked?.()) {
            return;
        }

        // 激活临时工具，并告诉其他所有工具：“我现在变成手型工具啦！”
        this.tempToolId = toolId;
        const activeToolId = this.getActiveToolId();
        this.toolsMap[activeToolId].activate?.(this.cursorPos);
        Object.values<TEaselTool>(this.toolsMap).forEach((tool) => tool.onTool?.(activeToolId));
        // 切换光标 SVG
        this.updateToolSvgs();
        this.updateDoubleTapPointerTypes();
    }

    /**
     * Turn off temporary tool
     */
    private popTempTool(toolId: GToolId | undefined): void {
        if (this.tempToolId !== toolId || toolId === undefined) {
            return;
        }
        this.tempToolId = undefined;
        this.getActiveTool().activate?.(this.cursorPos, true);
        const activeToolId = this.getActiveToolId();
        Object.values<TEaselTool>(this.toolsMap).forEach((tool) => tool.onTool?.(activeToolId));
        this.updateToolSvgs();
        this.updateDoubleTapPointerTypes();
    }

    private getActiveToolId(): GToolId {
        return this.tempToolId ?? this.toolId;
    }

    private getActiveTool(): TEaselTool {
        return this.toolsMap[this.getActiveToolId()];
    }

    private getResetTransform(): TViewportTransform {
        return createTransform(
            {
                x: this.width / 2,
                y: this.height / 2,
            },
            { x: this.project.width / 2, y: this.project.height / 2 },
            1,
            0,
        );
    }

    private getFitTransform(): TViewportTransform {
        return getFitRectTransform(
            { x: 0, y: 0, width: this.project.width, height: this.project.height },
            this.viewport.getTransform(),
            { width: this.width, height: this.height },
            true,
        );
    }

    private readonly onWheel = (e: TWheelEvent): void => {
        // 阻止浏览器默认行为（比如页面上下滚动、Mac 触控板的双指前进后退等）
        e.event?.preventDefault();

        // isImmediate 决定了这次缩放是“瞬间完成（无动画）”还是“平滑过渡（有动画）”
        let isImmediate = false;
        // 【硬件兼容 1：触控板微小偏移】
        // Math.abs(e.deltaY) < 0.8 通常意味着这是 Mac 触控板发出的极其高频、微小的滚动事件。
        // 因为它触发频率极高，如果加上平滑动画反而会导致画面卡顿和滞后，所以直接设为立即执行。
        if (Math.abs(e.deltaY) < 0.8) {
            isImmediate = true;
        }

        // 【硬件兼容 2：触控板的“伪装 Ctrl”捏合手势】
        // 这是一个极其经典的黑科技！
        // 浏览器为了区分“双指上下滑动（平移）”和“双指捏合（缩放）”，会在触控板发生“双指捏合”时，
        // 强行塞一个 e.ctrlKey = true 进去，哪怕用户根本没有按键盘上的 Ctrl 键！
        // 所以这里通过对比原生事件的 ctrlKey 和我们自己维护的键盘大管家的 ctrl 状态，来精准识别“触控板捏合手势”。
        if (e.event && e.event.ctrlKey && !this.keyListener.isPressed('ctrl')) {
            isImmediate = true;
            let factor = 1;
            // deltaMode === 0 表示滚动值是以“像素（pixels）”为单位的（通常是触控板或平滑鼠标）
            // 放大倍数进行补偿，让缩放手感更正常
            if (e.event.deltaMode === 0) {
                factor = 6;
            }
            e.deltaY *= factor;
        }
        // 【精细控制：按住 Shift 键时微调缩放】
        if (this.keyListener.isPressed('shift')) {
            e.deltaY /= 4;
        }

        // 获取当前的画布变换状态（x, y平移量，缩放比例，旋转角度）
        // zoom
        const transform = this.targetTransform;
        // viewportPoint: 鼠标在“屏幕（浏览器容器）”上的绝对物理坐标（比如屏幕中心 400, 300）
        const viewportPoint = {
            x: e.relX,
            y: e.relY,
        };
        // 把当前的变换状态转换为一个 2D 仿射变换矩阵
        const mat = createMatrixFromTransform(transform);
        // 【最核心的一步：空间逆向映射】
        // 我们知道鼠标点在屏幕的 (400, 300) 处，但由于画布可能已经被放大、平移、旋转过了，
        // 我们必须反向推算出：屏幕上的 (400, 300) 这个点，到底对应着底层画纸上的第几个像素？
        // inverse(mat) 求出逆矩阵，然后将屏幕坐标反算成画纸坐标 (canvasPoint)。
        const canvasPoint = applyToPoint(inverse(mat), viewportPoint);
        // 计算新的缩放比例
        // 这里使用了指数函数 Math.pow，确保无论当前是在放大 10 倍还是缩小 0.1 倍的状态下，
        // 滚轮滚一格带来的“视觉感受”是一致的。并且用 BB.clamp 限制了最大/最小缩放倍数。
        const newScale = BB.clamp(
            transform.scale * Math.pow(1 + 4 / 10, -e.deltaY),
            EASEL_MIN_SCALE,
            EASEL_MAX_SCALE,
        );
        // 生成新的变换矩阵，并提交更新！
        // createTransform 内部会做一个复杂的运算：
        // “请重新计算画布的 x 和 y 平移量，确保在 newScale（新缩放比例）和原角度下，
        // 画纸上的 canvasPoint 依然死死地对准屏幕上的 viewportPoint！”
        this.setTargetTransform(
            createTransform(viewportPoint, canvasPoint, newScale, transform.angleDeg),
            isImmediate,
        );
    };

    // ----------------------------------- public -----------------------------------
    constructor(p: TEaselParams<GToolId>) {
        this.project = p.project;
        this.width = p.width;
        this.height = p.height;
        this.toolId = p.tool;
        this.toolsMap = { ...p.tools };
        this.onChangeTool = p.onChangeTool;
        this.onTransformChange = p.onTransformChange;
        this.onUndo = p.onUndo;
        this.onRedo = p.onRedo;
        // 传入对应画布临时工具操作的键位（旋转、放大、吸色等快捷键操作）
        this.tempTools = Object.fromEntries(
            TEMP_TRIGGERS.map((trigger) => {
                return [
                    trigger,
                    getToolEntries(this.toolsMap)
                        .filter(([toolName, tool]) => {
                            return tool.tempTriggers && tool.tempTriggers.includes(trigger);
                        })
                        .map((i) => i[0])[0],
                ];
            }),
        ) as Record<TEaselToolTrigger, GToolId | undefined>;
        // 构造好的canvas实例挂载到this.vieport上
        this.viewport = new ProjectViewport({
            width: this.width,
            height: this.height,
            project: {
                width: this.project.width,
                height: this.project.height,
                layers: this.project.layers,
            },
            transform: this.getResetTransform(),
            renderAfter: (ctx, renderedTransform) => {
                const tool = this.getActiveTool();
                tool.renderAfterViewport?.(ctx, renderedTransform);
            },
        });
        // 实例化的tools工具参数
        Object.values<TEaselTool>(this.toolsMap).forEach((tool) => {
            //每个 Tool（画笔、橡皮、手型工具等）构造时都不知道自己在哪个 Easel 里。
            // 这一步把一个受控接口注入给所有 Tool，让它们能反向操作 Easel（比如请求重绘、修改光标样式、读取当前变换），但不能乱访问 Easel 内部状态。
            tool.setEaselInterface?.(this.easelInterface);
            tool.onResize?.(this.width, this.height);
        });

        let mouseMiddleIsDown = false;
        let mouseRightIsDown = false;

        let angleIsExtraSticky = false;
        // 在原始 PointerEvent 到达 Tool 之前，先过一道手势识别。
        // 双指捏合会在这里被拦截，计算出新的 scale/angle 后直接更新 targetTransform，不会传给 Tool。只有普通单指事件才通过 onChainOut 流向 getActiveTool().onPointer(e)。
        this.pointerPreprocessor = new EaselPointerPreprocessor({
            onUndo: this.onUndo,
            onRedo: this.onRedo,
            onPinch: (event) => {
                if (event.type === 'move') {
                    const transform = this.viewport.getTransform();
                    if (!this.pinchInitialTransform) {
                        this.pinchInitialTransform = BB.copyObj(transform);
                        angleIsExtraSticky = this.pinchInitialTransform.angleDeg % 180 === 0;
                    }

                    let newAngleDeg =
                        this.pinchInitialTransform.angleDeg + (event.angleRad / Math.PI) * 180;
                    newAngleDeg = minimizeAngleDeg(
                        snapAngleDeg(newAngleDeg, 90, angleIsExtraSticky ? 12 : 4),
                    );
                    if (newAngleDeg % 90 !== 0) {
                        angleIsExtraSticky = false;
                    }

                    const metaTransform = toMetaTransform(this.pinchInitialTransform, {
                        x: event.downRelX,
                        y: event.downRelY,
                    });
                    metaTransform.scale = BB.clamp(
                        this.pinchInitialTransform.scale * event.scale,
                        EASEL_MIN_SCALE,
                        EASEL_MAX_SCALE,
                    );
                    metaTransform.viewportP.x += event.relX - event.downRelX;
                    metaTransform.viewportP.y += event.relY - event.downRelY;
                    metaTransform.angleDeg = newAngleDeg;

                    // 【直接修改视图】
                    // 双指捏合的结果，直接在此处被转化为画架的平移、缩放指令！
                    // 这些事件在这里就被“消费”了，绝不会通过 `onChainOut` 传给下面的画笔工具，所以画布不会留下黑点。
                    this.setTargetTransform(
                        createTransform(
                            metaTransform.viewportP,
                            metaTransform.canvasP,
                            metaTransform.scale,
                            metaTransform.angleDeg,
                        ),
                        true,
                    );
                    this.requestRender();
                } else if (event.type === 'end') {
                    this.pinchInitialTransform = undefined;
                }
            },
            onDoubleTap: (e) => {
                if (this.fitTransform()) {
                    this.requestRender();
                } else {
                    this.scale(2, e.relX, e.relY);
                }
            },
            onChainOut: (e) => {
                this.cursorPos = {
                    x: e.relX,
                    y: e.relY,
                };
                // 处理鼠标的快捷键事件
                if (e.type === 'pointerdown') {
                    if (e.button === 'middle') {
                        mouseMiddleIsDown = true;
                        this.pushTempTool(this.tempTools['mouse-middle']);
                    }
                    if (e.button === 'right') {
                        mouseRightIsDown = true;
                        this.pushTempTool(this.tempTools['mouse-right']);
                    }
                } else if (e.type === 'pointermove') {
                    // noop?
                } else if (e.type === 'pointerup') {
                    if (mouseMiddleIsDown) {
                        mouseMiddleIsDown = false;
                        this.getActiveTool().onPointer(e);
                        this.popTempTool(this.tempTools['mouse-middle']);
                        return;
                    }
                    if (mouseRightIsDown) {
                        mouseRightIsDown = false;
                        this.getActiveTool().onPointer(e);
                        this.popTempTool(this.tempTools['mouse-right']);
                        return;
                    }
                }
                // ! 这里才是真正绘画的pointer事件被放行出去
                this.getActiveTool().onPointer(e);
            },
        });
        /*
        // My trackpad pinching (via PointerListener) doesn't currently work with Safari on macOS.
        // So I tried GestureListener, which works, but doesn't mesh well with the other event listeners.
        let lastScale = 0;
        this.gestureListener = new GestureListener({
            target: this.viewport.getElement(),
            onStart: (e) => {
                lastScale = e.scale;
            },
            onChange: (e) => {
                const deltaScale = e.scale / lastScale;
                lastScale = e.scale;

                // zoom
                const transform = this.viewport.getTransform();
                const viewportPoint = {
                    x: e.layerX,
                    y: e.layerY,
                };
                const mat = createMatrixFromTransform(transform);
                const canvasPoint = applyToPoint(inverse(mat), viewportPoint);
                const newScale = BB.clamp(
                    transform.scale * deltaScale,
                    EASEL_MIN_SCALE,
                    EASEL_MAX_SCALE,
                );
                this.setTransform(
                    createTransform(viewportPoint, canvasPoint, newScale, transform.angleDeg),
                );
                this.requestRender();
            },
        });*/

        // 把事件监听真正挂到 canvas 元素上。注意 target 是 viewport.getElement()（canvas 本身），不是 rootEl。
        // 这样事件的命中区域就是画布区域，和渲染区域完全一致。
        this.pointerListener = new PointerListener({
            target: this.viewport.getElement(),
            onPointer: (e) => {
                // console.debug('[PointerListener DEBUG] pointer event');
                // console.dir(e);
                // ! 这里已经经过了预处理后，绘画的事件过来了！
                this.pointerPreprocessor.chainIn(e);
            },
            // onWheel: this.onWheel,
            onWheel: (e) => {
                // console.debug('[PointerListener DEBUG] wheel event');
                // console.dir(e)
                return this.onWheel(e);
            },
            onEnterLeave: (isOver) => {
                // console.debug('[PointerListener DEBUG] enter/leave event');
                // console.dir(isOver);
                const tool = this.getActiveTool();
                if (!isOver) {
                    this.cursorPos = undefined;
                    tool.onPointerLeave?.();
                }
            },
            useDirtyWheel: true,
            isWheelPassive: false,
            maxPointers: 3, // 3 fingers needed for redo gesture
        });

        // 专门处理"点击画布外部"的情况。比如文字工具在编辑状态，用户点了工具栏，工具需要知道这件事并退出编辑。
        this.windowPointerListener = (e: PointerEvent) => {
            // console.log('[WindowPointerListener DEBUG] pointer event traggered: ', e)
            if (this.isFrozen) {
                return;
            }
            if (!(e.target instanceof Node && this.rootEl.contains(e.target))) {
                this.getActiveTool().onClickOutside?.();
            }
        };
        window.addEventListener('pointerdown', this.windowPointerListener);

        // 监听键盘，处理三类按键：
        // + / -：缩放画布（this.scale(...)）
        // 方向键：平移画布（this.translate(...)），但如果当前工具自己处理了方向键（onArrowKeys 返回 true），就不平移
        // 特殊触发键（比如 Space）：按下时 pushTempTool 切到临时工具（如手型），松开时 popTempTool 还原。这就是"按住空格变成手型工具，松开回到画笔"的实现
        this.keyListener = new KeyListener({
            onDown: (keyStr, e, comboStr, isRepeat) => {
                // console.debug('[easel] key down', keyStr, comboStr, event);
                if (this.isFrozen) {
                    return;
                }

                if (comboStr === 'plus') {
                    const oldScale = this.getTransform().scale;
                    const newScale = zoomByStep(
                        oldScale,
                        this.keyListener.isPressed('shift') ? 1 / 8 : 1 / 2,
                    );
                    this.scale(newScale / oldScale);
                }
                if (comboStr === 'minus') {
                    const oldScale = this.getTransform().scale;
                    const newScale = zoomByStep(
                        oldScale,
                        this.keyListener.isPressed('shift') ? -1 / 8 : -1 / 2,
                    );
                    this.scale(newScale / oldScale);
                }
                if (
                    comboStr !== 'shift' &&
                    this.keyListener.comboOnlyContains(['shift', 'left', 'right', 'up', 'down'])
                ) {
                    const arrowKey = comboStr
                        .split('+')
                        .find((item) => item !== 'shift')! as TArrowKey;
                    const activeTool = this.getActiveTool();
                    if (!activeTool.onArrowKeys?.(arrowKey)) {
                        const stepSize = 40;
                        if (arrowKey === 'left') {
                            this.translate(stepSize, 0);
                        }
                        if (arrowKey === 'right') {
                            this.translate(-stepSize, 0);
                        }
                        if (arrowKey === 'up') {
                            this.translate(0, stepSize);
                        }
                        if (arrowKey === 'down') {
                            this.translate(0, -stepSize);
                        }
                    }
                }

                // activate temporary tool
                TEMP_TRIGGERS_KEYS.forEach((keyTrigger) => {
                    if (
                        comboStr === keyTrigger &&
                        this.toolsMap[this.toolId].blockTrigger !== keyTrigger
                    ) {
                        this.pushTempTool(this.tempTools[keyTrigger]);
                    }
                });
                const tool = this.toolsMap[this.tempToolId ?? this.toolId];
                tool.onKeyDown?.(keyStr, e, comboStr, isRepeat);
            },
            onUp: (keyStr, e, oldComboStr) => {
                if (this.isFrozen) {
                    return;
                }

                // turn off temporary tool again
                TEMP_TRIGGERS_KEYS.forEach((keyTrigger) => {
                    if (
                        keyStr === keyTrigger &&
                        this.toolsMap[this.toolId].blockTrigger !== keyTrigger
                    ) {
                        this.popTempTool(this.tempTools[keyTrigger]);
                    }
                });
                const tool = this.toolsMap[this.tempToolId ?? this.toolId];
                tool.onKeyUp?.(keyStr, e, oldComboStr);
            },
            onBlur: () => {
                const tool = this.toolsMap[this.tempToolId ?? this.toolId];
                tool.onBlur?.();
            },
        });
        this.easelInterface.keyListener = this.keyListener;

        // 创建选区虚线框的渲染器。选区（MultiPolygon）是一个纯数据结构，这个类负责把它画成你看到的那圈蚂蚁线。
        // 它是独立的渲染逻辑，和画笔/图层渲染分开。
        this.selectionRenderer = new SelectionRenderer({
            transform: this.viewport.getTransform(),
            selection: this.project.selection,
            width: this.width,
            height: this.height,
        });

        //this.svgEl — 创建一个全尺寸 SVG 元素，position: absolute 叠在 canvas 上方，pointerEvents: none 让鼠标事件穿透它不被拦截。里面塞了两类东西：
        // selectionRenderer.getElement()：选区虚线框
        // 每个 Tool 的 getSvgElement()：比如 EaselBrush 返回的是笔刷圆形光标
        this.svgEl = BB.createSvg({
            elementType: 'svg',
            width: '' + this.width,
            height: '' + this.height,
        });
        css(this.svgEl, {
            position: 'absolute',
            left: '0',
            top: '0',
            // 【极其关键】：让这个 SVG 层变成“幽灵”，鼠标点击会直接穿透它，打在下面的 Canvas 上
            pointerEvents: 'none',
        });
        // 把所有的矢量附属物塞进这个 SVG 层：
        this.svgEl.append(
            // 1. 选区渲染器（蚂蚁线）
            this.selectionRenderer.getElement(),
            // 2. 遍历所有注册的工具（画笔、橡皮等），把它们自定义的光标 SVG 都拿过来
            ...Object.values<TEaselTool>(this.toolsMap).map((item) => item.getSvgElement()),
        );

        // this.htmlOverlayEl — 同样是 position: absolute 的覆盖层，但用 HTML 元素而不是 SVG。
        // 某些工具需要 HTML 交互元素（比如文字工具的输入框），放这里。
        // 不是所有工具都有，所以用 filter(item !== undefined) 过滤掉没有的。
        this.htmlOverlayEl = BB.el({
            css: {
                position: 'absolute',
                left: '0',
                top: '0',
            },
        });
        // 遍历所有工具，看看哪个工具需要 HTML 交互层，如果有就加进来
        this.htmlOverlayEl.append(
            ...Object.values<TEaselTool>(this.toolsMap)
                .map((item) => item.getHtmlOverlayElement?.() || undefined)
                .filter((item) => item !== undefined), // 过滤掉那些没有 HTML 层的工具（比如普通画笔就不需要）
        );
        // 把当前激活工具之外的所有工具的 SVG 元素设为 display: none。
        // 因为所有工具的 SVG 都已经加进去了，但同一时间只有一个工具在用，其他的要隐藏。
        this.updateToolSvgs();

        // 组装html结构，根节点是 this.rootEl，
        // 里面有 canvas（this.viewport.getElement()）、svg（this.svgEl）和 htmlOverlay（this.htmlOverlayEl）
        this.rootEl = c(
            {
                css: {
                    // 【关键防御】：禁止浏览器默认的触摸/拖拽行为干扰绘图
                    userSelect: 'none',  // 禁止双击选中文本
                    touchAction: 'none',  // 告诉浏览器：“这块区域的触摸我自己处理，你不要试图滚动页面！”（解决触摸屏画画时页面跟着滚的问题）
                    overscrollBehaviorX: 'none',  // 防止 Mac 触控板左右滑动触发浏览器的“前进/后退”手势
                },
            },
            // 底层/中层/顶层
            [this.viewport.getElement(), this.svgEl, this.htmlOverlayEl],
        );

        // 屏蔽右键菜单
        // 用户用触控笔按侧键，或者用鼠标右键平移画布时，不能弹出浏览器的右键菜单！
        // prevent contextmenu
        this.rootEl.addEventListener(
            'contextmenu',
            (e) => {
                e.preventDefault();
                return false;
            },
            { passive: false },
        );

        // 屏蔽移动端的触摸结束默认行为
        // 作者注释说“继承自老代码，不知道删了会坏什么”。这在前端老项目中很常见。
        // 实际上这通常是为了防止 iOS Safari 在 touchend 时触发各种奇怪的 300ms 延迟点击或滚动回弹。
        // Carried over from old KlCanvasWorkspace. Prevent some default browser behavior. Todo what breaks if removed?
        this.rootEl.addEventListener('touchend', (e) => {
            e.preventDefault();
            return false;
        });

        // 屏蔽拖拽事件
        // 防止用户一不小心把画布里的某些隐藏元素当作图片给“拖拽”出来了（比如出现一个半透明的拖拽残影）。
        // Carried over from old KlCanvasWorkspace. Prevent some default browser behavior. Todo what breaks if removed?
        this.rootEl.addEventListener('dragstart', (e) => {
            e.preventDefault();
            return false;
        });

        // activate方法通知工具类激活
        this.toolsMap[this.toolId].activate?.(this.cursorPos);
        Object.values<TEaselTool>(this.toolsMap).forEach((tool) => tool.onTool?.(this.toolId));
        // renderLoop() 启动 rAF 循环，这个循环会永远自我驱动下去，每帧检查 doRender 标志，为 true 才调 viewport.render()。
        this.renderLoop();
    }

    /** 
     * 【项目挂载与重绘】：将底层的数据项目（图层、选区、尺寸）挂载到显示画架上 
     * 
     * @param project 包含画布尺寸、图层树和矢量选区的项目数据对象
     */
    /** update and render */
    setProject(project: TEaselProject): void {
        // 1. 保存项目数据引用
        this.project = project;
        // 2. 将数据下发给底层的 Viewport（视口渲染器）
        // Viewport 是实际负责用 WebGL/Canvas API 把图层画到屏幕上的核心组件
        this.viewport.setProject({
            width: this.project.width,
            height: this.project.height,
            layers: this.project.layers,
        });
        // 3. 将选区数据下发给选区渲染器（负责画那种跑马灯虚线或遮罩）
        this.selectionRenderer.setSelection(this.project.selection);
        // 4. 通知当前正在使用的工具：“选区数据变了，请更新你的内部状态！”
        // 比如魔棒工具可能需要根据新选区重新计算填充边界
        this.getActiveTool().onUpdateSelection?.(this.project.selection);
        this.requestRender();
    }

    /** 
     * 【画架物理尺寸响应】：当外部容器（如浏览器窗口、UI 面板折叠展开）改变大小时触发
     * 注意：这里的 width 和 height 是屏幕 UI 的像素，不是画板文档的物理像素！
     * 
     * @param width 新的屏幕视口宽度
     * @param height 新的屏幕视口高度
     */
    /** update and render */
    setSize(width: number, height: number): void {
        // ==========================================
        // 【核心黑魔法：计算当前屏幕正中心到底“盯”着画布的哪个像素】
        // ==========================================
        // 1. 获取当前的变换矩阵（包含了平移、缩放、旋转）
        const m = createMatrixFromTransform(this.viewport.getTransform());
        // 2. 将矩阵【求逆 (inverse)】！
        // 3. 把屏幕正中心的坐标 (this.width / 2, this.height / 2) 丢进逆矩阵计算
        // 结果 canvasCenterPoint 就是此刻屏幕正中心对应的【画板原始物理坐标】
        const canvasCenterPoint = applyToPoint(inverse(m), {
            x: this.width / 2,
            y: this.height / 2,
        });

        // ==========================================
        // 【应用新的物理尺寸】
        // ==========================================
        this.width = width;
        this.height = height;
        // 重新设置顶层 SVG 交互层的大小（用于绘制光标、选区蚂蚁线）
        BB.setAttributes(this.svgEl, {
            width: '' + this.width,
            height: '' + this.height,
        });
        // 通知子组件容器大小发生变化
        this.selectionRenderer.setSize(width, height);
        this.getActiveTool().onResize?.(width, height);
        this.viewport.setSize(width, height);

        // ==========================================
        // 【视觉焦点还原】
        // ==========================================
        const transform = this.viewport.getTransform();
        // 创建一个新的变换矩阵状态
        // 要求：保持原有的缩放比例 (transform.scale) 和旋转角度 (transform.angleDeg)
        // 但是要保证：【新的屏幕正中心 (this.width / 2, this.height / 2)】 依然严格对齐刚才算出来的【画板物理坐标 (canvasCenterPoint)】
        this.setTargetTransform(
            createTransform(
                {
                    x: this.width / 2,
                    y: this.height / 2,
                },
                canvasCenterPoint,
                transform.scale,
                transform.angleDeg,
            ),
            // isInstant = true，不要带平滑过渡动画，瞬间完成
            true,
        );

        this.requestRender();
    }

    requestRender(): void {
        this.doRender = true;
    }

    /** 获取当前真实的视口变换状态（包含坐标 x/y, 缩放比例 scale, 旋转角度 angleDeg） */
    getTransform(): TViewportTransform {
        // 第二个参数 true 代表 isInstant（瞬间完成）。
        // 这意味着忽略所有平滑动画（如缓动），直接把镜头切到指定的矩阵坐标。
        return this.viewport.getTransform();
    }

    /** 
     * 瞬间设置视口变换状态（常用于重置视图、撤销恢复时的视图对齐）
     */
    setTransform(transform: TViewportTransform): void {
        this.setTargetTransform(transform, true);
    }

    /** 
     * 【核心管线】：切换当前绘图工具 
     */
    setTool(toolId: GToolId): void {
        // 1. 【防抖/幂等防御】：如果选中的就是当前正在用的工具，直接丢弃，防止重复触发昂贵的卸载/装载逻辑。
        if (toolId === this.toolId) {
            return;
        }
        this.toolId = toolId;
        // 调用新工具的 activate 生命周期钩子，并把当前鼠标/画笔的坐标告诉它。
        this.toolsMap[this.toolId].activate?.(this.cursorPos);
        // 这是一个非常经典的发布-订阅 (Pub-Sub) 模式应用，见下方深度解析。
        Object.values<TEaselTool>(this.toolsMap).forEach((tool) => tool.onTool?.(this.toolId));
        this.onChangeTool(toolId);// 触发顶层回调，通知外部 UI 界面（比如让工具栏上对应的图标高亮变蓝）
        this.updateToolSvgs();// 更新工具在视图层注入的 SVG UI（比如选区工具专属的十字光标或控制点）
        this.updateDoubleTapPointerTypes(); // 更新双击逻辑（某些工具在触控笔双击时有特殊行为）
        this.requestRender();
    }

    getTool(): GToolId {
        return this.toolId;
    }

    /** 
     * 相对平移画面（常用于按住空格键拖拽画布，或触控板双指滑动）
     * @param dX 水平移动增量 (Delta X)
     * @param dY 垂直移动增量 (Delta Y)
     */
    translate(dX: number, dY: number): void {
        // 注意：这里读取的是 targetTransform（目标状态）而不是当前真实状态。
        // 这是为了支持“高频平滑滚动”。如果用户疯狂滚动鼠标滚轮，系统会累加一个“目标终点”，
        // 渲染引擎会在之后的几帧里平滑地靠拢过去。
        const transform = this.targetTransform;
        this.setTargetTransform({
            ...transform,
            x: transform.x + dX,
            y: transform.y + dY,
        });
    }

    /**
     * 【焦点缩放】：以屏幕上的某个点为圆心，对画布进行放大或缩小
     * 
     * @param factor 缩放乘数（比如 1.1 代表放大 10%，0.9 代表缩小 10%）
     * @param viewportX 缩放中心的屏幕 X 坐标（鼠标悬停点）
     * @param viewportY 缩放中心的屏幕 Y 坐标（鼠标悬停点）
     */
    scale(factor: number, viewportX?: number, viewportY?: number): void {
        const before = this.targetTransform;
        const viewportRect = { width: this.width, height: this.height };

        // 1. 【确定缩放锚点】：
        // 如果传入了坐标（比如滚轮缩放、双指捏合），就以手势中心为锚点。
        // 如果没传（比如点了 UI 上的“放大”按钮），默认以屏幕正中心为锚点。
        viewportX = viewportX ?? viewportRect.width / 2;
        viewportY = viewportY ?? viewportRect.height / 2;

        // 2. 【状态降维：转换为元属性 (Meta Transform)】
        // 这是一个极度巧妙的封装。它算出：当前屏幕上的这个点 (viewportX, Y)，
        // 对应着画板文档里的哪个物理像素点 (canvasP)。
        const metaTransform = toMetaTransform(before, { x: viewportX, y: viewportY });

        // 3. 【执行缩放并限幅】
        // 乘上缩放系数，并死死卡在系统允许的最大/最小缩放比之内（防止被无限放大到内存溢出，或缩小到看不见）
        metaTransform.scale = BB.clamp(
            metaTransform.scale * factor,
            EASEL_MIN_SCALE,
            EASEL_MAX_SCALE,
        );

        // 4. 【重建并应用矩阵】
        // 要求：保持刚才算出来的屏幕锚点 (viewportP) 和 画板像素点 (canvasP) 的对应关系绝对不变！
        // 只改变缩放倍率 (scale)。底层会自动推算出所需的各种 x/y 偏移量。
        this.setTargetTransform(
            createTransform(
                metaTransform.viewportP,
                metaTransform.canvasP,
                metaTransform.scale,
                metaTransform.angleDeg,
            ),
        );
    }

    /**
     * 【一键重置】：将画布恢复到 100% 原始大小，并居中
     */
    resetTransform(isImmediate?: boolean): void {
        // 获取预设的默认矩阵
        const transform = this.getResetTransform();
        // 推送状态
        this.setTargetTransform(transform, isImmediate);
        this.requestRender();
    }

    /**
     * 【自适应屏幕 (Fit to Screen)】：智能缩放画布，使其刚好铺满或塞入当前浏览器视口
     * 
     * @returns boolean 是否真的发生了视图改变
     */
    fitTransform(isImmediate?: boolean): boolean {
        // 拿到现在的真实矩阵
        const oldTransform = this.viewport.getTransform();
        // 计算出如果“自适应”应该变成什么矩阵
        const transform = this.getFitTransform();

        // 1. 【脏检查 (Dirty Check)：差分比对】
        const isPositionChanged = transform.x !== oldTransform.x || transform.y !== oldTransform.y;
        const isScaleOrAngleChanged =
            transform.scale !== oldTransform.scale || transform.angleDeg !== oldTransform.angleDeg;

         // 2. 【性能防御：无操作拦截】
        // 如果计算出来的矩阵和现在的矩阵一模一样（比如用户连点了两次“适应屏幕”），
        // 直接 return false，终止后续所有的动画计算和重绘流水线。
        if (!isPositionChanged && !isScaleOrAngleChanged) {
            return false;
        }

        // 3. 只有真正变化了，才推送新状态
        this.setTargetTransform(transform, isImmediate);
        return true;
    }

    /**
     * 智能判断什么是最佳的复位方式。
     * 例如：如果这是一幅超小尺寸的像素画（Pixel Art），放大适配屏幕（Fit）会比 100% 原始大小更好。
     */
    /**
     * Automatically decide what is best. E.g. if it's pixel art, Fit might be better.
     */
    resetOrFitTransform(isImmediate?: boolean): void {
        const threshold = 4; // >= 400% zoom. pixelated, not blurry
        if (
            !KL_CONFIG.disableAutoFit &&
            this.project.width <= this.width / threshold &&
            this.project.height <= this.height / threshold
        ) {
            this.fitTransform(isImmediate);
        } else {
            this.resetTransform(isImmediate);
        }
    }

    /**
     * 【画布旋转】：以屏幕正中心为轴，旋转整个画布
     * 
     * @param angleDeg 角度（度数）
     * @param isRelative 是否为相对旋转（true: 在当前基础上累加；false: 直接设置绝对角度）
     */
    setAngleDeg(angleDeg: number, isRelative: undefined | boolean) {
        // 1. 获取目标状态与矩阵
        const viewportTransform = this.targetTransform;
        const viewportMat = createMatrixFromTransform(viewportTransform);

        // 2. 锁定屏幕正中心点 (viewportCenterP)
        const viewportRect = { width: this.width, height: this.height };
        const viewportCenterP = {
            x: viewportRect.width / 2,
            y: viewportRect.height / 2,
        };

        // 3. 【角度标准化】：防止数值爆炸
        // 如果用户疯狂旋转 10 圈，角度可能会变成 3600度。
        // minimizeAngleDeg 会将其精简为 0~360 或 -180~180 之间的等效角度。
        const newAngleDeg = minimizeAngleDeg(
            isRelative ? viewportTransform.angleDeg + angleDeg : angleDeg,
        );

        // 4. 【锚点重建矩阵】
        // 要求：不管怎么转，【屏幕的正中心】 必须始终对准 【旋转前屏幕中心对应的画板物理像素】！
        // applyToPoint(inverse(viewportMat), viewportCenterP) 就是在用逆矩阵找那个画板像素点。
        const newViewportTransform = createTransform(
            viewportCenterP,
            applyToPoint(inverse(viewportMat), viewportCenterP),
            viewportTransform.scale,// 保持缩放不变
            newAngleDeg,// 应用新角度
        );
        this.setTargetTransform(newViewportTransform);
    }

    // ? 这是额外添加的一个方法，用于测试
    setScale(scale: number){
        const viewportTransform = this.targetTransform;
        const viewportMat = createMatrixFromTransform(viewportTransform);

        const viewportRect = { width: this.width, height: this.height };
        const viewportCenterP = {
            x: viewportRect.width / 2,
            y: viewportRect.height / 2,
        };

        const newScale = BB.clamp(
            scale,
            EASEL_MIN_SCALE,
            EASEL_MAX_SCALE,
        );

         const newViewportTransform = createTransform(
            viewportCenterP,
            applyToPoint(inverse(viewportMat), viewportCenterP),
            newScale,
            viewportTransform.angleDeg,
        );
        this.setTargetTransform(newViewportTransform);
    }

    /**
     * 【工具锁状态探测】：判断当前是否允许切换工具或执行高危操作
     * 比如：如果画笔正按在屏幕上画线，此时 getIsLocked() 返回 true，外部就不应该允许切换图层或工具。
     */
    getIsLocked(): boolean {
        return this.getActiveTool().getIsLocked?.() ?? false;
    }

    /**
     * 【视图冻结】：让画布暂停响应（常用于系统正在处理繁重任务、弹出模态框或保存文件时）
     */
    setIsFrozen(b: boolean): void {
        this.isFrozen = b;
    }

    getElement(): HTMLElement {
        return this.rootEl;
    }

    destroy(): void {
        this.viewport.destroy();
        this.pointerListener.destroy();
        this.keyListener.destroy();
        // 掐断正在排队的 GPU 动画渲染帧
        this.animationFrameId !== undefined && cancelAnimationFrame(this.animationFrameId);
        // 销毁选区渲染器（停止蚂蚁线动画计算）
        this.selectionRenderer.destroy();
        window.removeEventListener('pointerdown', this.windowPointerListener);
    }
}
