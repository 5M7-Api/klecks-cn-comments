import { BB } from '../../../../bb/bb';
import { TVector2D } from '../../../../bb/bb-types';
import { TPointerEvent, TPointerType } from '../../../../bb/input/event.types';
import { TEaselInterface, TEaselTool, TEaselToolTrigger } from '../easel.types';
import { InertiaScrolling } from '../inertia-scrolling';

export type TEaselHandParams = object;

/**
 * 抓手工具类（实现了 TEaselTool 标准工具接口）
 * 负责处理画布的平移（拖拽），以及协调物理惯性滑动。
 */
export class EaselHand implements TEaselTool {
    // 每一个工具都需要提供一个 SVG 元素（用于在画布上层显示诸如“画笔圆圈”、“选区虚线”等 UI）。
    // 但抓手工具不需要任何额外的 UI，所以这里只创建了一个空的 `<g>`（Group）标签占位。
    private readonly svgEl: SVGElement;
    // 画架的接口引用（用于控制主画布的缩放、平移和重绘）
    private easel: TEaselInterface = {} as TEaselInterface;
    // 惯性运动计算引擎
    private inertiaScrolling: InertiaScrolling;

    // ----------------------------------- public -----------------------------------
    // 【全局配置覆盖】
    // 抓手工具极其特殊，它允许所有的输入设备（触控、鼠标、数位笔）双击。
    // 在这里双击通常会触发“画布适应屏幕（Fit to screen）”的复位操作。
    doubleTapPointerTypes: TPointerType[] = ['touch', 'mouse', 'pen'];
    // 定义如何临时触发这个工具（按住空格键，或者按下鼠标中键滚轮）
    tempTriggers: TEaselToolTrigger[] = ['space', 'mouse-middle'];

    constructor(p: TEaselHandParams) {
        // 创建一个空的 SVG 占位符
        this.svgEl = BB.createSvg({
            elementType: 'g',
        });
        // 实例化惯性滚动引擎。
        // 将获取和设置画布矩阵的方法（get/setTransform）以回调函数的形式喂给物理引擎。
        this.inertiaScrolling = new InertiaScrolling({
            getTransform: () => this.easel.getTransform(),
            // 注意这里的 true (isImmediate)，意味着抓手拖拽时，要求引擎放弃防抖，立即、实时地将画面渲染出来
            setTransform: (transform) => this.easel.setTransform(transform, true),
        });
    }

    getSvgElement(): SVGElement {
        return this.svgEl;
    }

    onPointer(e: TPointerEvent): void {
        // 只要鼠标还在画布上，只要当前是抓手工具，默认光标就是“张开的手（grab）”
        this.easel.setCursor('grab');

        if (e.type === 'pointerdown' && ['left', 'middle'].includes(e.button!)) {
            this.inertiaScrolling.dragStart();
            this.easel.setCursor('grabbing');
        }
        if (e.type === 'pointermove' && ['left', 'middle'].includes(e.button!)) {
            // 获取当前的高层视图状态
            const vTransform = { ...this.easel.getTransform() };
            vTransform.x += e.dX;
            vTransform.y += e.dY;
            // 提交新坐标并强制请求浏览器重绘画面
            this.easel.setTransform(vTransform, true);
            this.easel.requestRender();
            this.easel.setCursor('grabbing');
            this.inertiaScrolling.dragMove(e.dX, e.dY);
        }
        if (e.type === 'pointerup' && e.button === undefined) {
            this.inertiaScrolling.dragEnd();
        }
    }

    // ! 依赖注入：画架主控器在初始化工具时，会把自己 (EaselInterface) 传进来
    setEaselInterface(easelInterface: TEaselInterface): void {
        this.easel = easelInterface;
    }

    // 当用户从“画笔”切换到“抓手”时触发的生命周期钩子
    activate(cursorPos?: TVector2D): void {
        this.easel.setCursor('grab');
    }

    // 暴露一个开关：允许用户在设置里关闭平滑滚动
    setUseInertiaScrolling(b: boolean): void {
        this.inertiaScrolling.setIsEnabled(b);
    }
}
