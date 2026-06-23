import { BB } from "../../../../bb/bb";
import { TPointerEvent } from "../../../../bb/input/event.types";
import { createMatrixFromTransform } from "../../../../bb/transform/create-matrix-from-transform";
import { applyToPoint, inverse } from "transformation-matrix";
import {
  CoalescedExploder,
  TCoalescedPointerEvent,
} from "../../../../bb/input/event-chain/coalesced-exploder";
import { EventChain } from "../../../../bb/input/event-chain/event-chain";
import { TChainElement } from "../../../../bb/input/event-chain/event-chain.types";
import { TViewportTransform } from "../../project-viewport/project-viewport";
import { TEaselInterface, TEaselTool } from "../easel.types";
import { TVector2D } from "../../../../bb/bb-types";
import { BrushCursorPixelSquare } from "./brush-cursor-pixel-square";
import { BrushCursorRound } from "./brush-cursor-round";

// -------------------------------------------------------------
// 【卷宗定义】：画笔事件的数据结构
// 不仅仅有 x, y，还包含了 pressure (压感) 和 isCoalesced (是否为合并事件)
// -------------------------------------------------------------
export type TEaselBrushEvent = {
  x: number;
  y: number;
  isCoalesced: boolean;
  pressure: number;
};

export type TEaselBrushParams = {
  // 笔刷半径
  radius: number;
  // 外部传入的回调函数，也就是画笔真正“产出颜料”的接口
  onLineStart: (e: TEaselBrushEvent) => void;
  onLineGo: (e: TEaselBrushEvent) => void;
  onLineEnd: () => void;
  // 用于 Shift 键直线连接
  onLine: (p1: TVector2D, p2: TVector2D) => void;
};

// 用于 Shift 键正交锁定（水平或垂直）
type TLineToolDirection = "x" | "y";

// 事实上这个类只是处理了关于事件如何正确的变成笔刷的事件，并没有真正渲染像素
export class EaselBrush implements TEaselTool {
  private readonly svgEl: SVGElement;
  private radius: number;
  private readonly onLineStart: TEaselBrushParams["onLineStart"];
  private readonly onLineGo: TEaselBrushParams["onLineGo"];
  private readonly onLineEnd: TEaselBrushParams["onLineEnd"];
  private readonly onLine: TEaselBrushParams["onLine"];
  private easel: TEaselInterface = {} as TEaselInterface;
  private oldScale: number = 1;
  private isDragging: boolean = false;
  private eventChain: EventChain; // to explode events
  private readonly brushCursorRound: BrushCursorRound;
  private readonly brushCursorPixelSquare: BrushCursorPixelSquare;
  private currentCursor: BrushCursorRound | BrushCursorPixelSquare;
  private lastPos: TVector2D = { x: 0, y: 0 };
  // 记录上一次画笔离开画布时的位置
  private lastLineEnd: TVector2D | undefined; // in canvas coords
  // 直线锁定方向
  private lineToolDirection: TLineToolDirection | undefined;
  // 按下 Shift 键时的初始坐标
  private firstShiftPos: TVector2D | undefined;
  private hideCursorTimeout: ReturnType<typeof setTimeout> | undefined;
  private isOver: boolean = false;

  // -------------------------------------------------------------
  // 【核心解密区】：被“解包”后的指针事件处理函数
  // -------------------------------------------------------------
  private onExplodedPointer(e: TCoalescedPointerEvent): void {
    const vTransform = this.easel.getTransform();
    // 【第一重魔法：坐标系逆映射】
    // 获取正向矩阵，然后求逆（inverse）。
    // 作用：把鼠标在屏幕上的物理坐标 (relX, relY)，精准换算成画纸上的逻辑坐标 (x, y)。
    const m = createMatrixFromTransform(vTransform);
    // canvas coordinates
    const p = applyToPoint(inverse(m), { x: e.relX, y: e.relY });
    const x = p.x;
    const y = p.y;

    if (vTransform.scale !== this.oldScale) {
      this.oldScale = vTransform.scale;
    }

    // 【第二重魔法：光标解耦更新】
    // ! 重点性能优化，因为更新UI的笔刷SVG圆圈是极其耗费性能的事情
    // 如果这不是一个后台补充的“合并事件”，就更新一下屏幕上那个跟手的“笔刷圆圈UI”。
    if (!e.isCoalesced) {
      this.lastPos.x = e.relX;
      this.lastPos.y = e.relY;
      this.currentCursor.update(
        this.easel.getTransform(),
        { x: e.relX, y: e.relY },
        this.radius,
      );
      if (!this.isOver && e.type !== "pointerup") {
        this._onPointerEnter();
      }
    }

    // 提取数位板压感
    const pressure = e.pressure ?? 1;
    const isCoalesced = e.isCoalesced;
    // 监听是否按下了 Shift 键
    const shiftIsPressed = this.easel.keyListener.isPressed("shift");

    // --- 以下是极其严谨的 Shift 键状态机 ---
    if (shiftIsPressed && !this.firstShiftPos) {
      // 记录按下 Shift 时那一刻的坐标
      this.firstShiftPos = { x: e.relX, y: e.relY };
    }
    if (!shiftIsPressed) {
      this.firstShiftPos = undefined;
      // 松开 Shift，解除方向锁定
      this.lineToolDirection = undefined;
    }

    // 1. 【鼠标按下】
    if (e.type === "pointerdown" && e.button === "left") {
      if (shiftIsPressed) {
        // 【Photoshop 经典特性】：按住 Shift 点击别处，会自动从上一个落笔点拉一条笔直的线过来。
        if (this.lastLineEnd) {
          this.onLine(this.lastLineEnd, { x, y });
        }
        // 直接返回，不触发常规的拖拽画线
        return;
      }

      this.onLineStart({ x, y, pressure, isCoalesced });
      this.isDragging = true;
    }

    // 2. 【鼠标拖拽（核心绘画逻辑）】
    if (e.type === "pointermove" && e.button === "left") {
      if (shiftIsPressed) {
        // 【直线锁定逻辑】：按住 Shift 拖拽，只能画绝对水平或绝对垂直的线
        if (!this.lineToolDirection) {
          // 判断用户的意图：是往横着走得多，还是竖着走得多？
          const dX = Math.abs(e.relX - this.firstShiftPos!.x);
          const dY = Math.abs(e.relY - this.firstShiftPos!.y);
          if (dX > 5 || dY > 5) {
            // 超过 5 像素才锁定，防止手抖误判
            this.lineToolDirection = dX > dY ? "x" : "y";
          }
        }
        if (this.lineToolDirection) {
          // 强行把当前鼠标的屏幕坐标，钳制（Clamp）在一根直线上
          const viewportP = {
            x: this.lineToolDirection === "x" ? e.relX : this.firstShiftPos!.x,
            y: this.lineToolDirection === "y" ? e.relY : this.firstShiftPos!.y,
          };
          // 把被钳制后的屏幕坐标，再次逆映射回画纸坐标，然后吐给底层引擎去画线
          const canvasP = applyToPoint(inverse(m), viewportP);
          this.onLineGo({ ...canvasP, pressure, isCoalesced });
        }
      } else {
        // 自由画线
        this.onLineGo({ x, y, pressure, isCoalesced });
      }
    }
    // 3. 【鼠标松开】
    if (e.type === "pointerup" && e.button === undefined && this.isDragging) {
      this.onLineEnd();
      this.isDragging = false;
      if (e.pointerType === "touch") {
        // due to delay of double-tap listener, pointerleave fires to early
        this.onPointerLeave();
      }
    }
  }

  // 用户每次把鼠标移回画板时，都能立刻、稳定地看到笔刷的光标轮廓
  private _onPointerEnter(): void {
    clearTimeout(this.hideCursorTimeout);
    this.svgEl.setAttribute("opacity", "1");
    this.isOver = true;
  }

  // ----------------------------------- public -----------------------------------
  constructor(p: TEaselBrushParams) {
    this.radius = p.radius;
    this.onLineStart = p.onLineStart;
    this.onLineGo = p.onLineGo;
    this.onLineEnd = p.onLineEnd;
    this.onLine = p.onLine;
    this.svgEl = BB.createSvg({
      elementType: "g",
    });
    this.brushCursorRound = new BrushCursorRound();
    this.brushCursorPixelSquare = new BrushCursorPixelSquare();
    this.currentCursor = this.brushCursorRound;
    this.svgEl.append(this.currentCursor.getElement());

    // 【最惊艳的底层设计：事件解包器】
    // 整个工具不仅直接监听原生事件，而是用一个 EventChain 把事件包裹起来，
    // 并装入了一个名叫 CoalescedExploder (高频合并事件炸弹解包器) 的滤镜。
    this.eventChain = new EventChain({
      chainArr: [new CoalescedExploder() as TChainElement],
    });

    // 解包后的事件，源源不断地流进我们上面的 onExplodedPointer 中。
    this.eventChain.setChainOut((e) => {
      this.onExplodedPointer(e as TCoalescedPointerEvent);
    });
  }

  getSvgElement(): SVGElement {
    return this.svgEl;
  }

  onPointer(e: TPointerEvent): void {
    this.eventChain.chainIn(e);
  }

  onPointerLeave(): void {
    clearTimeout(this.hideCursorTimeout);
    this.svgEl.setAttribute("opacity", "0");
    this.isOver = false;
  }

  setEaselInterface(easelInterface: TEaselInterface): void {
    this.easel = easelInterface;
  }

  onUpdateTransform(transform: TViewportTransform): void {
    this.currentCursor.update(
      transform,
      { x: this.lastPos.x, y: this.lastPos.y },
      this.radius,
    );
  }

  getIsLocked(): boolean {
    return this.isDragging;
  }

  setBrush(p: { radius?: number; type?: "round" | "pixel-square" }): void {
    if (p.radius !== undefined) {
      this.radius = p.radius;
      // 【高光细节】：当鼠标不在画布上时的预览机制
      // 即使不在画布范围内，也可以让用户在画布中心预览画笔笔刷轮廓大小
      if (!this.isOver) {
        this.svgEl.setAttribute("opacity", "1");
        clearTimeout(this.hideCursorTimeout);
        this.hideCursorTimeout = setTimeout(() => {
          this.svgEl.setAttribute("opacity", "0");
        }, 500);
      }
      const { width, height } = this.easel.getSize();
      this.currentCursor.update(
        this.easel.getTransform(),
        this.isOver ? this.lastPos : { x: width / 2, y: height / 2 }, // 画布中心
        this.radius,
      );
    }
    // 判断是否是新的形状，并进行节点替换
    if (p.type !== undefined) {
      const newBrushCursor =
        p.type === "round"
          ? this.brushCursorRound
          : this.brushCursorPixelSquare;
      if (newBrushCursor !== this.currentCursor) {
        this.currentCursor.getElement().remove();
        this.currentCursor = newBrushCursor;
        this.getSvgElement().append(this.currentCursor.getElement());
      }
    }
  }

  setLastDrawEvent(p?: TVector2D): void {
    this.lastLineEnd = p ? { ...p } : undefined;
  }

  activate(cursorPos?: TVector2D): void {
    // 防御机制，万一SVG渲染不出来则有个保底的十字准星
    this.easel.setCursor("crosshair");
    // 状态清零，防止乱飞一条线出来
    this.isDragging = false; 
    if (cursorPos) {
      // 场景 A：使用快捷键切换工具时，鼠标光标会自动定位到画布中心
      this.lastPos.x = cursorPos.x;
      this.lastPos.y = cursorPos.y;
      this.currentCursor.update(
        this.easel.getTransform(),
        { x: cursorPos.x, y: cursorPos.y },
        this.radius,
      );
    } else {
      // 场景 B：点击工具栏切换工具，鼠标必然不在画布内，则衔接移出事件隐藏幽灵光标
      this.onPointerLeave();
    }
  }
}
