import {
  TPointerEvent,
  TPointerType,
  TWheelEvent,
} from "../../../bb/input/event.types";
import {
  KeyListener,
  TOnBlur,
  TOnKeyDown,
  TOnKeyUp,
} from "../../../bb/input/key-listener";
import {
  TProjectViewportProject,
  TViewportTransform,
  TViewportTransformXY,
} from "../project-viewport/project-viewport";
import { TSize2D, TVector2D } from "../../../bb/bb-types";
import { MultiPolygon } from "polygon-clipping";
import { TEMP_TRIGGERS } from "./easel.config";

// allows a TEaselTool instance to interact with Easel
export type TEaselInterface = {
  // css cursor of easel
  setCursor: (cursor: string) => void;
  getTransform: () => TViewportTransform;
  getTargetTransform: () => TViewportTransform;
  setTransform: (transform: TViewportTransform, isImmediate?: boolean) => void;
  setAngleDeg: (angleDeg: number, isRelative: undefined | boolean) => void;
  minScale: number;
  maxScale: number;
  // size of DOM element
  getSize: () => TSize2D;
  getProjectSize: () => TSize2D;
  requestRender: () => void;
  keyListener: KeyListener;
  isKeyPressed: (keyStr: string) => boolean;
  // the tool changed doubleTapPointerTypes
  updateDoubleTapPointerTypes: () => void;
  // overwrite selection of project
  setRenderedSelection: (selection?: MultiPolygon) => void;
  // To render project's selection again.
  // isImmediate = false -> update when project updates. true -> immediately
  clearRenderedSelection: (isImmediate?: boolean) => void;

  // todo: get rid after refactor
  onWheel: (e: TWheelEvent) => void;
  // todo: get rid after refactor
  getElement: () => HTMLElement;
};
export type TEaselToolTrigger = (typeof TEMP_TRIGGERS)[number];
export type TArrowKey = "left" | "right" | "up" | "down";

/**
 * !! 交互外界和内部的核心基座接口
 */
export type TEaselTool = {
  // -------------------------------------------------------------------------
  // 1. 临时工具切换与手势拦截配置 (Temp Tools & Gestures)
  // -------------------------------------------------------------------------

  // 【临时工具触发器】：定义哪些按键可以“临时切入”其他工具。
  // 典型场景：用画笔刷图时，按住空格键临时切为“手掌平移”，松开空格键自动弹回画笔。
  tempTriggers?: TEaselToolTrigger[];

  // 【阻止临时切换】：当当前工具处于某些状态时，阻止切换为临时工具。
  // 典型场景：正在画多边形套索点第 3 个点时，禁止响应空格切手掌，防止画线中断。
  // tool won't switch to temp tool when trigger blocked
  blockTrigger?: TEaselToolTrigger;

  // 【方向键回调】：响应键盘方向键 (Up/Down/Left/Right)。
  // 返回 true 表示该工具消费了方向键，取消浏览器的默认滚动行为。
  // true -> cancel default
  onArrowKeys?: (key: TArrowKey) => boolean;

  // 【双击手势指针类型】：指定哪些设备（mouse/touch/pen）可以触发双击手势（如双击重置缩放）。
  // which pointer types can trigger double-tap gesture
  doubleTapPointerTypes?: TPointerType[];

  // -------------------------------------------------------------------------
  // 2. 核心输入事件监听 (Event Handlers)
  // -------------------------------------------------------------------------
  // ★★★【最核心的输入回调】：处理所有的指针事件（鼠标按下/移动/抬起、触控拖拽、数位板笔压感）。
  // 工具的大部分绘图、画选区逻辑全在这个函数内部响应。
  onPointer: (e: TPointerEvent) => void;

  // 【指针离开画板】：当鼠标或数位板笔离开 Easel 屏幕区域时触发，用于清除悬浮光标。
  onPointerLeave?: () => void;

  // 【键盘按下】：响应热键（如按住 Shift 键进入正交画线模式，或按 Alt 键进行减选）。
  onKeyDown?: TOnKeyDown;

  // 【键盘抬起】：响应热键释放（如松开 Shift 键恢复自由模式）。
  onKeyUp?: TOnKeyUp;

  // 【窗口失去焦点】：当用户按 Alt+Tab 切换窗口或点击了浏览器地址栏时触发。
  // 作用：防呆保护，防止因为没有捕获到 pointerup 而导致“鼠标松开了但画笔还在狂刷”的 Bug。
  // window.blur
  onBlur?: TOnBlur;

  // -------------------------------------------------------------------------
  // 3. UI 视图挂载与渲染 (UI Overlay & Rendering)
  // -------------------------------------------------------------------------
  // 【SVG 光标层】：获取该工具专属的 SVG 矢量图形节点。
  // 典型场景：画笔工具的圆形光标、吸管工具的十字瞄准线，都是通过它挂载到 SVG 层的。
  getSvgElement: () => SVGElement;

  // 【DOM 交互覆盖层】：获取挂载到 HTML 覆盖层的交互元素。
  // 典型场景：我们之前看的 FreeTransform（自由变换框的 4 个角点和旋转柄），就是通过它挂载的。
  // can be interactive
  getHtmlOverlayElement?: () => HTMLElement;

  // -------------------------------------------------------------------------
  // 4. 依赖注入与环境感知 (Host Communication & Environment)
  // -------------------------------------------------------------------------
  // 【依赖注入入口】：Easel 宿主初始化工具时，会调用此方法将 Easel 的操控接口 (TEaselInterface) 传给工具。
  // 使得工具可以反向操控 Easel（例如：请求刷新屏幕 requestRender()、获取画布尺寸等）。
  // provides access to easel
  setEaselInterface?: (easelInterface: TEaselInterface) => void;

  // 【视口矩阵变换通知】：当主画布发生平移、旋转或缩放 (Zoom/Pan/Rotate) 时触发。
  // 作用：通知工具刷新其光标尺寸或变形框物理位置（例如保证画笔光标随画布缩放）。
  // whenever transform updates
  onUpdateTransform?: (transform: TViewportTransform) => void;

  // 【选区更新通知】：当项目的矢量选区 (MultiPolygon) 发生改变时触发。
  onUpdateSelection?: (selection?: MultiPolygon) => void;

  // 【工具锁定状态】：询问工具当前是否正处于不可打断的操作中（如拖拽画线中）。
  // 如果返回 true，Easel 会拒绝用户切换到其他工具或关闭页面，防止数据丢失。
  // if returns true, can't change mode -> e.g. while drawing
  getIsLocked?: () => boolean;

  // 【工具切换通知】：当用户在工具栏切换了工具（如从“画笔”切到“橡皮擦”）时通知当前工具。
  // called when easel tool switched
  onTool?: (toolId: string) => void;

  // 【工具激活生命周期】：当该工具被选中/激活时调用。
  // last 传入指针最后的位置，poppedTemp 标记是否是从临时工具弹回。
  // tells tool when it is active; last undefined if cursor left easel.
  activate?: (last?: TVector2D, poppedTemp?: boolean) => void;

  // 【窗口 resize 通知】：当浏览器窗口大小改变时通知工具重新计算物理边界。
  onResize?: (width: number, height: number) => void;

  // 【视口后处理渲染】：在画布主体内容渲染完成后调用的 Canvas 2D 绘图钩子。
  // 典型场景：我们之前看到的“多边形套索橡皮筋预览线条”就是在这里用 `ctx` 画在最顶层的。
  renderAfterViewport?: (
    ctx: CanvasRenderingContext2D,
    transform: TViewportTransformXY,
  ) => void;
  // 【点击画板外部】：当用户点击了 Easel 画板以外的区域（如侧边栏、弹窗）时触发，用于取消半完成的操作。
  // clicked outside of easel
  onClickOutside?: () => void;
};

export type TEaselProject = TProjectViewportProject & {
  selection?: MultiPolygon;
};
