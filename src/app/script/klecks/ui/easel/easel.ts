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
 * An interactive project viewport, that also renders the selection. You interact with it through modes (aka tools).
 * One tool is active at a time. temp trigger can overwrite it temporarily.
 */
export class Easel<GToolId extends string> {
    private readonly rootEl: HTMLElement;
    private readonly svgEl: SVGElement; // each tool gets an element in this SVG tag, for an SVG overlay
    private readonly htmlOverlayEl: HTMLElement; // each tool can get an element in this html node, for an interactive overlay
    private readonly viewport: ProjectViewport;
    private readonly pointerPreprocessor: EaselPointerPreprocessor;
    private readonly pointerListener: PointerListener;
    private readonly windowPointerListener: (e: PointerEvent) => void;
    private readonly keyListener: KeyListener;
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
    private toolId: GToolId;
    private tempToolId: GToolId | undefined;
    private animationFrameId: ReturnType<typeof requestAnimationFrame> | undefined;
    private doRender = false; // true -> will render on next renderLoop
    private cursorPos: TVector2D | undefined; // so brush cursor not top left corner after reload
    private isFrozen: boolean = false; // disable interaction with the easel whatsoever
    private lastRenderedTransform: TViewportTransform = {} as TViewportTransform; // previously rendered viewport transformation
    private pinchInitialTransform: TViewportTransform | undefined; // when starting a pinch-to-zoom gesture
    private targetTransform: TViewportTransform = {} as TViewportTransform;

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

    private setTargetTransform(transform: TViewportTransform, isImmediate?: boolean): void {
        if (isImmediate) {
            this.viewport.setTransform(transform);
        }
        this.targetTransform = transform;
        this.doRender = true;
    }

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
     * Only call once from outside. Will perpetuate itself and render when doRender = true
     */
    private renderLoop(): void {
        const now = performance.now();
        const deltaMs = now - this.lastFrameTimestamp;
        this.lastFrameTimestamp = now;
        this.animationFrameId = requestAnimationFrame(() => this.renderLoop());
        if (!this.doRender) {
            return;
        }
        const tool = this.getActiveTool();
        const oldTransform = this.viewport.getTransform();
        let newTransform = oldTransform;
        if (isTransformEqual(oldTransform, this.targetTransform)) {
            this.doRender = false;
        } else {
            const defaultDeltaMs = 1000 / 60;
            const timeFactor = deltaMs / defaultDeltaMs;
            const easeFactor = 1 - 0.7 ** timeFactor;

            newTransform = blendTransform(
                oldTransform,
                this.targetTransform,
                {
                    width: this.project.width,
                    height: this.project.height,
                },
                {
                    x: this.width / 2,
                    y: this.height / 2,
                },
                easeFactor,
            );
            this.viewport.setTransform(newTransform);
        }

        // todo: is last renderedTransform needed?

        const isPositionChanged =
            newTransform.x !== this.lastRenderedTransform.x ||
            newTransform.y !== this.lastRenderedTransform.y;
        const isScaleOrAngleChanged =
            newTransform.scale !== this.lastRenderedTransform.scale ||
            newTransform.angleDeg !== this.lastRenderedTransform.angleDeg;

        this.viewport.render(!isTransformEqual(oldTransform, newTransform));
        if (isPositionChanged || isScaleOrAngleChanged) {
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

        this.tempToolId = toolId;
        const activeToolId = this.getActiveToolId();
        this.toolsMap[activeToolId].activate?.(this.cursorPos);
        Object.values<TEaselTool>(this.toolsMap).forEach((tool) => tool.onTool?.(activeToolId));
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
        e.event?.preventDefault();
        let isImmediate = false;
        if (Math.abs(e.deltaY) < 0.8) {
            isImmediate = true;
        }
        if (e.event && e.event.ctrlKey && !this.keyListener.isPressed('ctrl')) {
            isImmediate = true;
            let factor = 1;
            if (e.event.deltaMode === 0) {
                factor = 6;
            }
            e.deltaY *= factor;
        }
        if (this.keyListener.isPressed('shift')) {
            e.deltaY /= 4;
        }

        // zoom
        const transform = this.targetTransform;
        const viewportPoint = {
            x: e.relX,
            y: e.relY,
        };
        const mat = createMatrixFromTransform(transform);
        const canvasPoint = applyToPoint(inverse(mat), viewportPoint);
        const newScale = BB.clamp(
            transform.scale * Math.pow(1 + 4 / 10, -e.deltaY),
            EASEL_MIN_SCALE,
            EASEL_MAX_SCALE,
        );
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
        // 传入对应画布操作的键位（旋转、放大、吸色等快捷键操作）
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
                this.pointerPreprocessor.chainIn(e);
            },
            // onWheel: this.onWheel,
            onWheel: (e) => {
                console.debug('[PointerListener DEBUG] wheel event');
                console.dir(e)
                return this.onWheel(e);
            },
            onEnterLeave: (isOver) => {
                console.debug('[PointerListener DEBUG] enter/leave event');
                console.dir(isOver);
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
            if (this.isFrozen) {
                return;
            }
            if (!(e.target instanceof Node && this.rootEl.contains(e.target))) {
                this.getActiveTool().onClickOutside?.();
            }
        };
        window.addEventListener('pointerdown', this.windowPointerListener);

        // new KeyListener — 监听键盘，处理三类按键：
        // + / -：缩放画布（this.scale(...)）
        // 方向键：平移画布（this.translate(...)），但如果当前工具自己处理了方向键（onArrowKeys 返回 true），就不平移
        // 特殊触发键（比如 Space）：按下时 pushTempTool 切到临时工具（如手型），松开时 popTempTool 还原。这就是"按住空格变成手型工具，松开回到画笔"的实现
        this.keyListener = new KeyListener({
            onDown: (keyStr, e, comboStr, isRepeat) => {
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
            pointerEvents: 'none',
        });
        this.svgEl.append(
            this.selectionRenderer.getElement(),
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
        this.htmlOverlayEl.append(
            ...Object.values<TEaselTool>(this.toolsMap)
                .map((item) => item.getHtmlOverlayElement?.() || undefined)
                .filter((item) => item !== undefined),
        );
        // 把当前激活工具之外的所有工具的 SVG 元素设为 display: none。
        // 因为所有工具的 SVG 都已经加进去了，但同一时间只有一个工具在用，其他的要隐藏。
        this.updateToolSvgs();

        // 组装html结构，根节点是 this.rootEl，
        // 里面有 canvas（this.viewport.getElement()）、svg（this.svgEl）和 htmlOverlay（this.htmlOverlayEl）
        this.rootEl = c(
            {
                css: {
                    userSelect: 'none',
                    touchAction: 'none',
                    overscrollBehaviorX: 'none',
                },
            },
            [this.viewport.getElement(), this.svgEl, this.htmlOverlayEl],
        );

        // prevent contextmenu
        this.rootEl.addEventListener(
            'contextmenu',
            (e) => {
                e.preventDefault();
                return false;
            },
            { passive: false },
        );

        // Carried over from old KlCanvasWorkspace. Prevent some default browser behavior. Todo what breaks if removed?
        this.rootEl.addEventListener('touchend', (e) => {
            e.preventDefault();
            return false;
        });
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

    /** update and render */
    setProject(project: TEaselProject): void {
        this.project = project;
        this.viewport.setProject({
            width: this.project.width,
            height: this.project.height,
            layers: this.project.layers,
        });
        this.selectionRenderer.setSelection(this.project.selection);
        this.getActiveTool().onUpdateSelection?.(this.project.selection);
        this.requestRender();
    }

    /** update and render */
    setSize(width: number, height: number): void {
        const m = createMatrixFromTransform(this.viewport.getTransform());
        const canvasCenterPoint = applyToPoint(inverse(m), {
            x: this.width / 2,
            y: this.height / 2,
        });

        this.width = width;
        this.height = height;
        BB.setAttributes(this.svgEl, {
            width: '' + this.width,
            height: '' + this.height,
        });
        this.selectionRenderer.setSize(width, height);
        this.getActiveTool().onResize?.(width, height);
        this.viewport.setSize(width, height);
        const transform = this.viewport.getTransform();
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
            true,
        );

        this.requestRender();
    }

    requestRender(): void {
        this.doRender = true;
    }

    getTransform(): TViewportTransform {
        return this.viewport.getTransform();
    }

    setTransform(transform: TViewportTransform): void {
        this.setTargetTransform(transform, true);
    }

    setTool(toolId: GToolId): void {
        if (toolId === this.toolId) {
            return;
        }
        this.toolId = toolId;
        this.toolsMap[this.toolId].activate?.(this.cursorPos);
        Object.values<TEaselTool>(this.toolsMap).forEach((tool) => tool.onTool?.(this.toolId));
        this.onChangeTool(toolId);
        this.updateToolSvgs();
        this.updateDoubleTapPointerTypes();
        this.requestRender();
    }

    getTool(): GToolId {
        return this.toolId;
    }

    translate(dX: number, dY: number): void {
        const transform = this.targetTransform;
        this.setTargetTransform({
            ...transform,
            x: transform.x + dX,
            y: transform.y + dY,
        });
    }

    scale(factor: number, viewportX?: number, viewportY?: number): void {
        const before = this.targetTransform;
        const viewportRect = { width: this.width, height: this.height };
        viewportX = viewportX ?? viewportRect.width / 2;
        viewportY = viewportY ?? viewportRect.height / 2;

        const metaTransform = toMetaTransform(before, { x: viewportX, y: viewportY });
        metaTransform.scale = BB.clamp(
            metaTransform.scale * factor,
            EASEL_MIN_SCALE,
            EASEL_MAX_SCALE,
        );

        this.setTargetTransform(
            createTransform(
                metaTransform.viewportP,
                metaTransform.canvasP,
                metaTransform.scale,
                metaTransform.angleDeg,
            ),
        );
    }

    resetTransform(isImmediate?: boolean): void {
        const transform = this.getResetTransform();
        this.setTargetTransform(transform, isImmediate);
        this.requestRender();
    }

    fitTransform(isImmediate?: boolean): boolean {
        const oldTransform = this.viewport.getTransform();
        const transform = this.getFitTransform();

        const isPositionChanged = transform.x !== oldTransform.x || transform.y !== oldTransform.y;
        const isScaleOrAngleChanged =
            transform.scale !== oldTransform.scale || transform.angleDeg !== oldTransform.angleDeg;

        if (!isPositionChanged && !isScaleOrAngleChanged) {
            return false;
        }

        this.setTargetTransform(transform, isImmediate);
        return true;
    }

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

    setAngleDeg(angleDeg: number, isRelative: undefined | boolean) {
        const viewportTransform = this.targetTransform;
        const viewportMat = createMatrixFromTransform(viewportTransform);
        const viewportRect = { width: this.width, height: this.height };
        const viewportCenterP = {
            x: viewportRect.width / 2,
            y: viewportRect.height / 2,
        };
        const newAngleDeg = minimizeAngleDeg(
            isRelative ? viewportTransform.angleDeg + angleDeg : angleDeg,
        );

        const newViewportTransform = createTransform(
            viewportCenterP,
            applyToPoint(inverse(viewportMat), viewportCenterP),
            viewportTransform.scale,
            newAngleDeg,
        );
        this.setTargetTransform(newViewportTransform);
    }

    getIsLocked(): boolean {
        return this.getActiveTool().getIsLocked?.() ?? false;
    }

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
        this.animationFrameId !== undefined && cancelAnimationFrame(this.animationFrameId);
        this.selectionRenderer.destroy();
        window.removeEventListener('pointerdown', this.windowPointerListener);
    }
}
