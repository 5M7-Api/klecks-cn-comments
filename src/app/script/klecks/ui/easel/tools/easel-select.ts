import { BB } from "../../../../bb/bb";
import { TPointerEvent, TPointerType } from "../../../../bb/input/event.types";
import { TVector2D } from "../../../../bb/bb-types";
import { TSelectToolMode } from "../../tool-tabs/select-ui";
import { createMatrixFromTransform } from "../../../../bb/transform/create-matrix-from-transform";
import { applyToPoint, inverse } from "transformation-matrix";
import { TFreeTransform } from "../../../transform/transform-types";
import { checkRectFullyVisible } from "../../project-viewport/utils/check-rect-fully-visible";
import { getFitRectTransform } from "../../project-viewport/utils/get-fit-rect-transform";
import {
  TArrowKey,
  TEaselInterface,
  TEaselTool,
  TEaselToolTrigger,
} from "../easel.types";
import {
  TViewportTransform,
  TViewportTransformXY,
} from "../../project-viewport/project-viewport";
import { MultiPolygon } from "polygon-clipping";
import {
  TBooleanOperation,
  TSelectShape,
} from "../../../select-tool/select-tool";
import { getSelectionPath2d } from "../../../../bb/multi-polygon/get-selection-path-2d";
import { EventChain } from "../../../../bb/input/event-chain/event-chain";
import { DoubleTapper } from "../../../../bb/input/event-chain/double-tapper";
import { TChainElement } from "../../../../bb/input/event-chain/event-chain.types";
import { CornerPanning } from "../corner-panning";
import { FreeTransform } from "../../components/free-transform";
import {
  createFfdMesh,
  evalFFD,
  findParametricCoordinate,
  TFfdLattice,
  TFfdMesh,
  TParametric2D,
  warpLatticeViaPoint,
} from "../../../transform/ffd";
import {
  RENDERED_FFD_MESH_RESOLUTION,
  TComposedTransformation,
} from "../../../transform/composed-transformation";

const FFD_DEBUG = false;

/**
 * 【极客 UI 细节】：布尔运算的 CSS 游标魔法
 * 当你按住 Shift 键（加选）或 Alt 键（减选）时，鼠标指针旁边通常会出现一个小加号 (+) 或小减号 (-)。
 * 很多业余程序会用 JS 跟着鼠标画加号，这非常消耗性能。
 * Klecks 在这里用了一个绝妙的 CSS 原生游标 Hack：
 * - 'default': 普通箭头 (新建选区)
 * - 'copy': 操作系统原生自带的“复制”光标，它旁边天生就带一个完美的小加号 [+] ！（完美替代 union 加选）
 * - 'alias': 操作系统原生自带的“快捷方式”光标，它旁边天生带一个小箭头 (或类似减去的视觉符号)！（替代 difference 减选）
 * 这种纯 CSS 的解决方案是性能最高、最丝滑的做法。
 */
const operationToCursor: Record<TBooleanOperation, string> = {
  new: "default",
  union: "copy",
  difference: "alias",
};

/**
 * =========================================================================
 * 【视图层对外通信协议】：TEaselSelectParams
 * 这个接口完美对应了我们在 KlAppSelect (总控制台) 里看到的那一长串回调函数。
 * 视图层 (Easel) 是一个“瞎子”，它只管抓取鼠标坐标和画线，一旦发生交互，立刻通过这些接口向上汇报。
 * =========================================================================
 */
export type TEaselSelectParams = {
  // 当前工具处于什么模式？是正在画套索（select），还是正在拉伸边框（transform）
  selectMode: TSelectToolMode;

  // ---------------------------------------------------------------------
  // 模块一：选区绘制 (Select) 相关的生命周期钩子
  // ---------------------------------------------------------------------
  // select
  onStartSelect: (p: TVector2D, operation: TBooleanOperation) => void; // 鼠标按下：开始画套索。operation 决定是新建、加选还是减选。
  onGoSelect: (p: TVector2D, isShiftPressed: boolean) => void; // 鼠标拖动：正在画。isShiftPressed 用来判断是否要开启约束（比如画出完美的正圆形/正方形）
  onEndSelect: () => void; // 鼠标松开：画完了。此时应该去触发底层逻辑合并多边形。
  // 如果用户的鼠标不是点在空白处，而是点在了已经存在的“蚂蚁线”里面拖动，
  // 就会触发 MoveSelect 系列回调，也就是“仅平移选区框（不带走像素）”。
  onStartMoveSelect: (p: TVector2D) => void;
  onGoMoveSelect: (p: TVector2D, isShiftPressed: boolean) => void;
  onEndMoveSelect: () => void;
  // 用于魔术棒/油漆桶工具：直接塞进来一个算好的多边形路径，合并进现有选区。
  onSelectAddPoly: (path: TVector2D[], operation: TBooleanOperation) => void;
  // 取消全选 (Ctrl + D)
  onResetSelection: () => void;

  // transform
  // 当用户在 8 个拉伸把手（或中间的平移区）上拖拽时触发。
  // 注意，它回传的是一个经过计算的、复杂的 `TComposedTransformation` 数学矩阵对象，
  // 而不是简单的鼠标 X/Y！这说明复杂的矩阵逆运算在 EaselSelect 内部已经被处理好了。
  onTransform: (transform: TComposedTransformation) => void;
  // gesture completed (create an undo step)
  // 当用户松开拉伸把手时触发（用于压入一次 Ctrl+Z 历史记录）
  onTransformEnd: () => void;
};

/**
 * 【视图层核心控制器】：EaselSelect
 * 作用：这是真正的“前线士兵”。它直接接管 DOM，负责拦截你的鼠标/触控笔，
 * 并且负责在屏幕上以 60FPS 的帧率渲染闪烁的“蚂蚁线”以及 8 个拉伸控制点。
 * 注意：它不做复杂的布尔数学计算，它只负责“抓鼠标”和“画 UI”。
 */
/**
 * for select tool and transform tool
 */
export class EaselSelect implements TEaselTool {
  // from params
  private readonly onStartSelect: (
    p: TVector2D,
    operation: TBooleanOperation,
  ) => void;
  private readonly onGoSelect: (p: TVector2D, isShiftPressed: boolean) => void;
  private readonly onEndSelect: () => void;
  private readonly onStartMoveSelect: (p: TVector2D) => void;
  private readonly onGoMoveSelect: (
    p: TVector2D,
    isShiftPressed: boolean,
  ) => void;
  private readonly onEndMoveSelect: () => void;
  private readonly onSelectAddPoly: (
    path: TVector2D[],
    operation: TBooleanOperation,
  ) => void;
  private readonly onResetSelection: () => void;
  private readonly onTransform: TEaselSelectParams["onTransform"];
  private readonly onTransformEnd: TEaselSelectParams["onTransformEnd"];

  // -------------------------------------------------------------------------
  // 2. DOM 与 渲染底座
  // -------------------------------------------------------------------------
  private readonly svgEl: SVGElement;
  // 视图层的主挂载节点
  private readonly htmlEl: HTMLElement;
  private easel: TEaselInterface = {} as TEaselInterface;
  // 当前画布的 缩放/旋转/平移 矩阵
  private viewportTransform: TViewportTransform = {} as TViewportTransform;
  // !【极客级碰撞检测优化】：1x1 像素的离屏 Canvas
  // 为什么需要这个？因为选区往往是极其复杂的几何多边形（有无数的顶点和孔洞）。
  // 用纯数学算法去判断“鼠标是否点在了选区内部”性能极差且极易出 Bug。
  // 这里利用底层 C++ 引擎提供的终极捷径：`tempCtx.isPointInPath(path, x, y)`。
  // 我们只需要一个 1x1 的极小 Canvas 上下文就能白嫖这个高性能原生硬件 API！
  private tempCtx: CanvasRenderingContext2D = BB.ctx(BB.canvas(1, 1)); // used for isPointInPath()
  // 统管 Mouse/Touch/Pen 的复杂手势合成器
  private pointerChain: EventChain;
  // 边缘滚动（当鼠标拖到屏幕边缘时，画布自动向对应方向滚动）
  private cornerPanning: CornerPanning;

  // -------------------------------------------------------------------------
  // 3. 核心选区状态 (Select Mode State)
  // -------------------------------------------------------------------------
  // state
  private canvasSelection: MultiPolygon = []; // 最新的、经过确认的物理多边形顶点数据
  //? 正在拖拽中、实时变换的多边形数据
  private selection: MultiPolygon | undefined;
  // 【GPU 加速级渲染利器】：Path2D 缓存
  // 当“蚂蚁线”在跑动时，其实是重新调用 ctx.stroke()。如果每次渲染都去遍历几百个点，会掉帧。
  // Path2D 会将矢量点集一次性编译存入底层 GPU/显存 路径对象中。
  // 之后每次画蚂蚁线，只需调用 ctx.stroke(this.selectionPath) 即可，速度快百倍！
  private selectionPath: Path2D = getSelectionPath2d([]);
  // 工具大模式 (是套索选区，还是 Ctrl+T 变形)
  private mode: TSelectToolMode = "select";
  // 鼠标是否正在按住
  private isDragging: boolean = false;

  // 选区子模式
  // select-mode state
  private selectSelectMode: "select" | "move" = "select"; // 是画新选区，还是拖动旧选区的虚线框
  private didSelectionMove: boolean = false;

  private defaultBooleanOperation: TBooleanOperation = "new"; // set by the UI
  // 【状态锁定】：当用户按下 Shift 键 (union) 并开始画选区时，把 operation 锁死。
  // 防止用户在画了一半时松开 Shift 键，导致选区中途突然从“相加”变成“新建”。
  private appliedBooleanOperation: TBooleanOperation | undefined; // once dragging, the locked in boolean operation

  // 矩形/椭圆/套索
  private selectShape: TSelectShape = "rect";
  // 套索工具走过的实时轨迹点集
  private polyShape: (TVector2D & { temp?: true })[] = [];

  // -------------------------------------------------------------------------
  // 4. 变形控制状态 (Transform Mode State)
  // -------------------------------------------------------------------------
  // transform-mode state
  private freeTransform: FreeTransform | undefined; // 4个角的自由变换控制对象 (负责画那8个方块手柄)
  private freeTransformTimeout: ReturnType<typeof setTimeout> | undefined;
  private transformation: TComposedTransformation | undefined;
  // 按住 Shift 保持等比缩放
  private freeTransformIsConstrained: boolean = true;
  // 自动吸附对齐
  private freeTransformIsSnapping: boolean = true;

  // 5x5 液化网格
  private ffdMesh: TFfdMesh | undefined;
  // 液化网格拖拽初始快照
  private warpStart:
    | {
        parametricCoordinate: TParametric2D;
        lattice: TFfdLattice;
      }
    | undefined;
  // 编译好的网格曲线 Path2D，用于极速渲染液化线框
  private latticePath: Path2D | undefined;

  /**
   * 【逆矩阵空间降维】：将 屏幕像素系 转换回 画布物理像素系
   * 无论用户怎么放大、缩小、旋转画板，鼠标传来的永远是显示器的物理坐标 (比如 x:500, y:300)。
   * 为了知道这个鼠标点对应真实图层上的哪一个像素，必须：
   * 1. 抓取当前画板的渲染矩阵。
   * 2. 求这个矩阵的【逆矩阵】 (inverse)。
   * 3. 把鼠标屏幕点乘以逆矩阵，投射回底层大图的原生坐标空间。
   */
  private viewportToCanvas(p: TVector2D): TVector2D {
    const matrix = inverse(
      createMatrixFromTransform(this.easel.getTransform()),
    );
    return applyToPoint(matrix, p);
  }

  /**
   * 当多边形顶点被数学层更新后，同步刷新 GPU 的 Path2D 缓存，供下一帧蚂蚁线渲染使用。
   */
  private updateSelectionPath(): void {
    this.selectionPath = getSelectionPath2d(this.canvasSelection);
  }

  /**
   * 【套索多边形的中断/重置】：取消当前的离散点连线
   * 作用：当用户用多边形套索画到一半（比如点了三个点），突然按了 Esc 键或者切换了工具，
   * 必须调用此函数彻底清空未闭合的临时轨迹（polyShape），并恢复触控板状态。
   * @returns boolean - 返回是否真的发生了清理操作（如果本来就是空的，返回 false）
   */
  private resetPolyShape(): boolean {
    // 如果当前没有正在画多边形，直接返回 false，避免无效的重绘
    if (this.polyShape.length === 0) {
      return false;
    }
    // 清空临时队列
    this.polyShape = [];
    // 恢复触控板双击行为的默认判定 ('touch' 模式)
    this.doubleTapPointerTypes = ["touch"];
    this.easel.updateDoubleTapPointerTypes();
    // 【关键】：强制请求 Easel 视图层立刻重绘一帧！
    // 因为屏幕上可能还残留着一条没闭合的“橡皮筋”实线，清空数据后必须刷掉它。
    this.easel.requestRender(); // because polyShape might have changed
    return true;
  }

  /**
   * 【按键意图劫持】：获取当前真实的布尔运算模式 (加选、减选、新建)
   * ! 作用：实时侦测用户的键盘修饰键。
   * - 按住 Alt 键：强行进入减选模式 (difference)
   * - 按住 Shift 键：强行进入加选模式 (union)
   */
  /** boolean operation if you also consider keys */
  private getEffectiveBooleanOperation(): TBooleanOperation {
    const isSubtract =
      this.defaultBooleanOperation === "new"
        ? this.easel.keyListener.isPressed("alt")
        : this.defaultBooleanOperation === "difference";
    const isAdd =
      this.defaultBooleanOperation === "new"
        ? this.easel.keyListener.isPressed("shift")
        : this.defaultBooleanOperation === "union";

    if (isSubtract) {
      return "difference";
    }
    if (isAdd) {
      return "union";
    }
    return "new";
  }

  /**
   * TODO：sai中选区是不可拖动的，拖动操作会导致选区内像素位移
   * 【鼠标悬停探测】：用户是否想拖动/平移当前的选区边界？
   * 作用：利用 1x1 离屏 Canvas 的极速硬件接口，判断鼠标坐标是否落在蚂蚁线内部。
   */
  private getDoMoveSelection(
    effectiveOperation: TBooleanOperation,
    cursorCanvasPos: TVector2D,
  ): boolean {
    // 条件 1: 没有正在画多边形 (polyShape.length < 2)
    // 条件 2: 存在蚂蚁线缓存 (selectionPath)
    // 条件 3: 【神级碰撞检测】鼠标的 X/Y 落在了底层的 Path 内部！
    const isOverSelection =
      this.polyShape.length < 2 &&
      this.selectionPath &&
      this.tempCtx.isPointInPath(
        this.selectionPath,
        cursorCanvasPos.x,
        cursorCanvasPos.y,
      );
    // 只有当用户没有按 Shift/Alt (即 new 模式)，且悬停在选区上方时，才允许平移
    return effectiveOperation === "new" && isOverSelection;
  }

  /**
   * 【交互状态机之心】：统管所有指针事件 (Mouse / Pen / Touch)
   * 作用：这是一个极度复杂的路由，判断用户究竟在画多边形、平移选区、还是套索圈选。
   */
  // can be repeatedly called with the same event
  private selectOnPointer(event: TPointerEvent): void {
    const effectiveOperation = this.getEffectiveBooleanOperation();
    const wasDragging = this.isDragging;
    // 降维打击：将显示器屏幕坐标 (relX, relY) 逆向投射为底层画布物理坐标
    const cursorCanvasPos = this.viewportToCanvas({
      x: event.relX,
      y: event.relY,
    });
    // 意图预测：用户是不是想移动现有选区？
    const doMove = this.getDoMoveSelection(effectiveOperation, cursorCanvasPos);
    // ==========================================
    // 1. 基础拖拽状态维护
    // ==========================================
    if (event.type === "pointerdown") {
      this.isDragging = true;
      if (doMove) {
        this.selectSelectMode = "move";
      } else {
        this.selectSelectMode = "select";
      }
    }
    if (event.type === "pointerup") {
      this.isDragging = false;
    }

    // ==========================================
    // 2. 分支 A：仅仅是平移现有选区的虚线框 (不含图像像素)
    // ==========================================
    if (this.selectSelectMode === "move") {
      if (event.type === "pointerdown" && event.button === "left") {
        this.didSelectionMove = false;
        this.onStartMoveSelect(cursorCanvasPos);
      }
      if (event.type === "pointermove" && event.button === "left") {
        this.didSelectionMove = true;
        this.onGoMoveSelect(
          cursorCanvasPos,
          this.easel.keyListener.isPressed("shift"),
        );
      }
      if (event.type === "pointerup") {
        this.onEndMoveSelect();
        // 如果点了一下但完全没移动，视为用户想取消选区
        if (!this.didSelectionMove) {
          this.onResetSelection();
        }
      }
    } else {
      // ==========================================
      // 3. 分支 B：绘制全新的选区形状
      // ==========================================

      // 3.1 离散型：多边形套索 (点按式连线)
      // select
      if (this.selectShape === "poly") {
        if (event.type === "pointermove") {
          // 【橡皮筋视觉特效】：移除上一个临时点，压入最新鼠标点
          if (this.polyShape[this.polyShape.length - 1]?.temp) {
            this.polyShape.pop();
          }
          this.polyShape.push({
            ...cursorCanvasPos,
            temp: true,
          });
          this.easel.requestRender();
        }
        if (event.type === "pointerup" && wasDragging) {
          // 【状态锁死】：画第一个点时，锁死当前的运算模式 (防止中途松开 Shift)
          if (this.polyShape.length < 2) {
            this.appliedBooleanOperation = effectiveOperation;
          }

          // 兼容触控板双击逻辑
          this.doubleTapPointerTypes = [];
          this.easel.updateDoubleTapPointerTypes();

          // 固化点坐标：弹出临时点，转为真实节点
          if (this.polyShape[this.polyShape.length - 1]?.temp) {
            this.polyShape.pop();
          }
          // 防呆：防止同一个地方重复点入无数个死点
          const lastPolyShapePoint = this.polyShape[this.polyShape.length - 1];
          if (
            !lastPolyShapePoint ||
            cursorCanvasPos.x !== lastPolyShapePoint.x ||
            cursorCanvasPos.y !== lastPolyShapePoint.y
          ) {
            this.polyShape.push(cursorCanvasPos);
            this.easel.requestRender();
          }

          const first = this.polyShape[0];
          const last = this.polyShape[this.polyShape.length - 1];
          // 【缝合判定机制】：如果最后一个点距离起点在视觉上小于 4 个屏幕像素
          if (
            this.polyShape.length > 2 &&
            BB.dist(first.x, first.y, last.x, last.y) *
              this.viewportTransform.scale <
              4
          ) {
            // 强制闭合多边形：把终点坐标设为和起点一模一样
            this.polyShape.pop();
            this.polyShape.push({ ...this.polyShape[0] });
            const shape = this.polyShape;
            this.polyShape = []; // 清空临时队列
            // 抛出事件：多边形绘制完成，拿去算数学交并补！
            this.onSelectAddPoly(shape, this.appliedBooleanOperation!);
            this.appliedBooleanOperation = undefined;
          }
        }
      } else {
        // 3.2 连续型：普通套索 (按住鼠标连续画圈) / 矩形 / 椭圆
        if (event.type === "pointerdown" && event.button === "left") {
          this.appliedBooleanOperation = effectiveOperation;
          this.onStartSelect(cursorCanvasPos, this.appliedBooleanOperation!);
        }
        if (
          event.type === "pointermove" &&
          event.button === "left" &&
          this.isDragging
        ) {
          this.onGoSelect(
            cursorCanvasPos,
            this.easel.keyListener.isPressed("shift"),
          );
        }
        if (event.type === "pointerup" && wasDragging) {
          this.onEndSelect();
          this.appliedBooleanOperation = undefined;
        }
      }
    }

    // ==========================================
    // 4. 游标 (Cursor) 视觉反馈更新
    // ==========================================
    if (!event.button) {
      if (doMove) {
        this.selectSelectMode = "move";
      } else {
        this.selectSelectMode = "select";
      }
    }

    // 如果在选区内悬停，变成“移动十字架”
    if (this.selectSelectMode === "move") {
      this.easel.setCursor("move");
    } else {
      // 否则，根据操作类型显示对应的光标 (+, -, 或者默认)
      this.easel.setCursor(
        operationToCursor[this.appliedBooleanOperation ?? effectiveOperation],
      );
    }
  }

  /**
   * 【变形交互接管】：处理网格液化 (FFD) 下的指针事件
   * 作用：当用户进入了液化扭曲模式，鼠标操作不再由普通套索接管，
   * 而是直接计算鼠标是否点在了 5x5 的控制网格节点上，并实现类似揉面团的拖拽扭曲。
   */
  // can be repeatedly called with the same event
  private transformOnPointer(event: TPointerEvent): void {
    // 如果当前不是 FFD 网格变形模式，退回默认光标，并交由 FreeTransform (四角拉伸框) 自行处理
    if (
      !this.transformation ||
      this.transformation.type !== "ffd" ||
      !this.ffdMesh
    ) {
      this.easel.setCursor("default");
      // handled via this.freeTransform
      return;
    }

    // 降维：将屏幕上的鼠标物理坐标，逆推回底层画布坐标系
    // warping
    const cursorCanvasPos = this.viewportToCanvas({
      x: event.relX,
      y: event.relY,
    });
    // 【数学引擎核心】：射线法/逆参数化
    // 给定一个屏幕坐标，去算它到底有没有碰到复杂的曲线网格？
    // 如果碰到了，返回它在网格中的 [u, v] 相对参数坐标
    const parametricCoordinate = findParametricCoordinate(
      cursorCanvasPos.x,
      cursorCanvasPos.y,
      this.ffdMesh,
    );
    if (event.type === "pointerdown" && event.button === "left") {
      if (parametricCoordinate) {
        // 如果鼠标按下时刚好抓住了网格的某条线/控制点，开始液化拖拽！
        this.warpStart = {
          parametricCoordinate,
          lattice: this.transformation.ffd, // 存下拖拽前的原始网格状态
        };
        this.easel.setCursor("move");
      }
    }
    if (event.type === "pointermove" && this.warpStart) {
      // Apply warp (应用液化变形)
      // 根据鼠标的新坐标，用算法把控制网格“拉扯”出新的形状
      // Apply warp
      this.transformation.ffd = warpLatticeViaPoint(
        this.warpStart.parametricCoordinate,
        cursorCanvasPos,
        this.warpStart.lattice,
      );
      const { width, height } = this.easel.getProjectSize();
      // 网格发生扭曲后，重新生成更高精度的贝塞尔曲面网格 (用于视图渲染)
      this.ffdMesh = createFfdMesh(
        RENDERED_FFD_MESH_RESOLUTION,
        RENDERED_FFD_MESH_RESOLUTION,
        this.transformation.ffd,
        width,
        height,
        true,
      );
      // 刷新底层的 Path2D 路径，用于稍后的 GPU 硬件极速绘制
      this.updateLatticePath();
      this.easel.requestRender();
      // 把最新的矩阵大礼包抛给 KlAppSelect 总控台，它会去通知底层像素也跟着扭曲
      this.onTransform(this.transformation);
    }
    if (event.type === "pointerup") {
      if (this.warpStart) {
        // 拖拽结束，产生一个历史记录里程碑
        this.onTransformEnd();
      }
      this.warpStart = undefined;
    }
    // 悬停反馈：如果鼠标没按下，但在网格线附近游走，提示用户“可以拖动”
    if (!this.warpStart) {
      // Update cursor if not already dragging
      this.easel.setCursor(parametricCoordinate ? "move" : "default");
    }
  }

  /**
   * 【事件分发路由总阀】：
   * 这是暴露给最外层（Easel画布监听器）的唯一入口。
   * 它负责判断当前究竟是什么模式，把事件引流给对应的模块。
   */
  private onPointerChainOut(event: TPointerEvent): void {
    if (this.mode === "select") {
      // 选区模式：包含边缘平移 (CornerPanning) 和套索/多边形逻辑
      this.cornerPanning.onPointer(event);
      this.selectOnPointer(event);
    } else {
      // 变形模式：交给上面写的 FFD 或 自由变换 逻辑处理
      this.transformOnPointer(event);
    }
  }

  /**
   * 【机甲舱初始化】：创建用于 4 角自由拉伸的控制框
   * 这个对象在屏幕上画出 8 个小方块（控制手柄），并接管了这 8 个小方块的鼠标拖拽事件。
   */
  private createFreeTransform(): void {
    this.freeTransform = new FreeTransform({
      x: 1,
      y: 1,
      width: 1,
      height: 1,
      angleDeg: 0,
      isConstrained: this.freeTransformIsConstrained,
      snapX: [],
      snapY: [],
      viewportTransform: { scale: 1, x: 0, y: 0, angleDeg: 0 },
      // 【回调函数】：每当用户拉动那 8 个小方块时，此函数被疯狂触发
      callback: (transform) => {
        if (
          this.mode === "select" ||
          !this.transformation ||
          !(
            this.transformation.type === "free" ||
            this.transformation.type === "ffd+free"
          )
        ) {
          return;
        }
        // !【防死机/防黑屏保护】
        // 当用户把图片疯狂缩小到接近 0x0 像素时，底层的矩阵求逆运算会发生除以 0 的灾难！
        // 这会导致计算出 NaN (Not a Number)。一旦 NaN 混入渲染管道，整个画布就会崩溃。
        // 这是一种工业级软件必备的防御性编程。
        if (
          isNaN(transform.x) ||
          isNaN(transform.y) ||
          isNaN(transform.width) ||
          isNaN(transform.height)
        ) {
          //can be provoked by repeatedly x0.5, then dragging a corner
          return;
        }
        // 将拉伸后的新矩阵通过回调抛给总控台
        this.onTransform({
          ...this.transformation,
          freeTransform: transform,
        });
        // !【精妙的防抖 (Debounce) 机制】：避免撑爆历史栈
        // 因为拖拽是在连续不断发生的，如果没有 `onUp` 事件，我们怎么知道用户什么时候拖完了？
        // 答案是：只要用户停手超过 250 毫秒，我们就认为他操作完了，此时塞入一条历史记录。
        // 如果他一直在拖，定时器就会不断被重置 (clearTimeout)。
        // avoid spamming undo steps
        if (this.freeTransformTimeout) {
          clearTimeout(this.freeTransformTimeout);
        }
        this.freeTransformTimeout = setTimeout(
          () => this.onTransformEnd(),
          250,
        );
      },
      onWheel: this.easel.onWheel,
      wheelParent: this.easel.getElement(),
    });
    // 装配磁吸对齐和 DOM 挂载
    this.freeTransform.setSnapping(this.freeTransformIsSnapping);
    this.htmlEl.append(this.freeTransform.getElement());
    this.freeTransform.setViewportTransform(this.viewportTransform);
  }

  /**
   * 清理并销毁自由变换控件。
   * 在切换工具、切换到网格变形模式，或者取消选区时，
   * 必须彻底销毁原有的 DOM 元素和事件绑定，防止内存泄漏。
   */
  private destroyFreeTransform(): void {
    // 从 DOM 树中拔除外框
    this.freeTransform?.getElement().remove();
    // 触发控件内部的解绑销毁逻辑
    this.freeTransform?.destroy();
    this.freeTransform = undefined;
  }

  /**
   * 动态控制基础自由变换框（八个控制点）的可见性。
   * 当用户点击 UI 切换到“网格变形 (FFD)”模式时，普通的八点变形框和 FFD 控制网点不能同时存在，
   * 因此此时需要隐藏基础变换框，反之亦然。
   */
  private updateFreeTransformVisibility(): void {
    this.freeTransform
      ?.getElement()
      .style.setProperty(
        "display",
        this.transformation?.type === "ffd" ? "none" : "",
      );
  }

  /**
   * 计算并更新网格变形 (FFD) 的几何线框路径 (Path2D)。
   * 在网格变形中，为了让用户直观地看到变形后的“液化”效果，
   * 系统会在画布上绘制一张曲面网格。
   * 此函数负责运用数学差值计算出网格交叉点，并生成用来描边的 Path2D 对象。
   */
  private updateLatticePath(): void {
    // 如果当前并非处于 FFD (液化/网格变形) 模式，则清空之前可能遗留的网格路径
    if (!this.transformation || this.transformation.type !== "ffd") {
      this.latticePath = undefined;
      return;
    }

    const lattice = this.transformation.ffd;
    // 网格的渲染分辨率（插值采样点数），控制曲面的平滑程度
    const sampleCount = RENDERED_FFD_MESH_RESOLUTION;
    // 使用原生 Path2D 进行高性能的几何图形绘制
    const path = new Path2D();

    // 辅助函数：将计算出的一系列点连成线（折线）
    function addPolyline(path: Path2D, points: TVector2D[]): void {
      path.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        path.lineTo(points[i].x, points[i].y);
      }
    }

    // horizontal lines
    for (let i = 0; i < lattice.rows; i++) {
      // 归一化的行进度，范围在 [0, 1] 之间
      const t = i / (lattice.rows - 1);
      const pts: TVector2D[] = [];
      // 在每一行上，按照采样率均匀取点，调用 evalFFD 进行非线性插值
      for (let e = 0; e <= sampleCount; e++) {
        // e / sampleCount 就是横坐标的进度。通过 evalFFD 算出扭曲后的真实物理坐标
        pts.push(evalFFD(e / sampleCount, t, lattice));
      }
      // 连成多边形线段
      addPolyline(path, pts);
    }

    // 绘制垂直方向上的网格曲面线 (经线)
    // vertical lines
    for (let i = 0; i < lattice.cols; i++) {
      // 归一化的列进度 [0, 1]
      const s = i / (lattice.cols - 1);
      const pts: TVector2D[] = [];
      for (let e = 0; e <= sampleCount; e++) {
        pts.push(evalFFD(s, e / sampleCount, lattice));
      }
      addPolyline(path, pts);
    }

    // 将组装好的整体路径保存起来，稍后交由 canvas 一次性描边
    this.latticePath = path;
  }

  /**
   * 【最终渲染】：把 FFD 变形网格绘制到屏幕的 Canvas 上
   *
   * @param ctx 当前画板的 Canvas 2D 绘图上下文
   * @param scale 摄像机当前的缩放倍率
   */
  private renderLattice(ctx: CanvasRenderingContext2D, scale: number): void {
    if (!this.latticePath) {
      return; // 如果还没生成路径，直接跳过
    }

    ctx.save();
    // 【专业绘图软件的细节】：无视缩放的像素级细线
    // 为什么是 1 / scale？因为画布如果被放大了 10 倍，1px 的线在屏幕上会变成 10px 的粗棍子。
    // 把线宽设为 1 / 10，抵消画板放大效果，让网格线永远保持在显示器上 1 像素的精致感。
    ctx.lineWidth = 1 / scale;
    // Firefox 下使用 'difference' 混合模式性能太差，而且在有些浏览器上看着很怪，
    // 所以作者注释掉了差值混合，退而求其次用固定的中性灰画线。
    // globalCompositeOperation = 'difference' is slow in firefox,
    // and it doesn't look all that nice in any browser.
    ctx.strokeStyle = "rgb(128, 128, 128)";
    // 一次性高性能绘制之前构建的所有经纬线网格！
    ctx.stroke(this.latticePath);
    // ==========================================
    // 开发者调试模式：显示隐藏的贝塞尔/样条控制点
    // ==========================================
    if (FFD_DEBUG && this.transformation?.type === "ffd") {
      const lattice = this.transformation.ffd;
      for (let i = 0; i < lattice.rows; i++) {
        for (let j = 0; j < lattice.cols; j++) {
          // 获取隐藏的控制点
          const cp = lattice.controlPoints[i][j];
          ctx.beginPath();
          // 画红色的半透明圆圈代表控制点，圆的半径 4 / scale 同样保持视觉大小恒定
          ctx.arc(cp.x, cp.y, 4 / scale, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(255, 100, 100, 0.8)";
          ctx.fill();
          // 给红点加个白色的描边，防止在红色背景的图片上看不清
          ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
          ctx.lineWidth = 1.5 / scale;
          ctx.stroke();
        }
      }
    }
    ctx.restore(); // 恢复 canvas 的绘图状态（颜色、线宽等），防止污染其他元素的绘制
  }

  // ----------------------------------- public -----------------------------------

  // 指定哪些输入设备支持“双击”事件。这里只开启了触控 (touch)，避免鼠标/笔的误触
  doubleTapPointerTypes: TPointerType[] = ["touch"];
  // 定义会阻断当前工具操作的键盘修饰键（比如按下 Alt 往往会切换到吸色管，所以要阻断当前）
  blockTrigger: TEaselToolTrigger = "alt";

  constructor(p: TEaselSelectParams) {
    // 1. 初始化由外部传入的各种生命周期回调函数
    this.mode = p.selectMode;
    this.onStartSelect = p.onStartSelect;
    this.onGoSelect = p.onGoSelect;
    this.onEndSelect = p.onEndSelect;
    this.onStartMoveSelect = p.onStartMoveSelect;
    this.onGoMoveSelect = p.onGoMoveSelect;
    this.onEndMoveSelect = p.onEndMoveSelect;
    this.onSelectAddPoly = p.onSelectAddPoly;
    this.onResetSelection = p.onResetSelection;
    this.onTransform = p.onTransform;
    this.onTransformEnd = p.onTransformEnd;

    // 2. 【边缘滚动检测器 (CornerPanning)】
    // 原理：当用户使用套索圈选到了屏幕边缘，或者拖拽变形框到了屏幕边缘时，
    // 画布会自动向外滚动，防止用户的手“卡”在屏幕边界画不下去。
    this.cornerPanning = new CornerPanning({
      getEaselSize: () => this.easel.getSize(),
      getTransform: () => this.easel.getTargetTransform(),
      setTransform: (transform) => this.easel.setTransform(transform, true),
      // 测试当前状态是否允许边缘滚动：
      // (按住鼠标 || 正在画多边形套索) && 不是 (普通套索而且处于新建模式)
      testCanPan: (buttonIsPressed) => {
        return (
          (buttonIsPressed || this.polyShape.length > 1) &&
          !(this.selectShape === "lasso" && this.selectSelectMode === "select")
        );
      },
      // 当发生边缘滚动时，持续不断地向手势状态机发送模拟鼠标移动事件
      onRepeatEvent: (e) => {
        if (this.mode === "select") {
          this.selectOnPointer(e);
        } else {
          this.transformOnPointer(e);
        }
      },
    });

    // 3. 【双击终结器 (DoubleTapper)】
    // 原理：专门为“多边形套索”工具设计。多边形套索是一点一点连线的，
    // 当用户完成闭合时，一种方式是点回原点，另一种方式就是“双击”。
    this.pointerChain = new EventChain({
      chainArr: [
        new DoubleTapper({
          onDoubleTap: (e) => {
            // 如果连的线少于3条（无法构成面），直接无视
            if (this.polyShape.length < 3) {
              return;
            }
            const shape = this.polyShape.map((item) => ({
              x: item.x,
              y: item.y,
            }));
            this.resetPolyShape(); // 清理当前轨迹
            if (shape.length > 1) {
              // 首尾相接，强行闭合多边形
              shape.push({ ...shape[0] });
              // 提交计算！
              p.onSelectAddPoly(shape, this.appliedBooleanOperation!);
            }
          },
          isInstant: true,
        }) as TChainElement,
      ],
    });
    // 创建虚拟挂载 DOM，SVG 用于画线，HTML 挂载方框
    this.svgEl = BB.createSvg({
      elementType: "g",
    });
    this.htmlEl = BB.el();
  }

  getSvgElement(): SVGElement {
    return this.svgEl;
  }

  getHtmlOverlayElement(): HTMLElement {
    return this.htmlEl;
  }

  // 接管外部的所有鼠标/数位笔指针事件，并将其喂给内部的 EventChain 处理
  onPointer(event: TPointerEvent): void {
    this.onPointerChainOut(event);
    this.pointerChain.chainIn(event);
  }

  // 依赖注入：将底层的画板 (Easel) 实例注入进来，方便本工具操控摄像机
  setEaselInterface(easelInterface: TEaselInterface): void {
    this.easel = easelInterface;
    this.viewportTransform = this.easel.getTransform();
  }

  /**
   * 【核心大模式切换】
   * 作用：在“套索选区”和“Ctrl+T 自由变形”之间来回切换。
   */
  setMode(mode: TSelectToolMode): void {
    this.mode = mode;
    // 切换模式时立刻打断未完成的套索
    this.resetPolyShape();
    if (this.mode === "transform") {
      // 进入变形模式：召唤八点拉伸框！
      this.createFreeTransform();
    } else {
      this.ffdMesh = undefined;
      // 回到选区模式：销毁拉伸框！
      this.destroyFreeTransform();
    }
  }

  /**
   * 【全局工具切换监听】
   * 作用：当用户在主界面的工具栏点击了别的工具（比如切换到画笔、橡皮擦）时触发。
   */
  onTool(toolId: string): void {
    if (toolId === "select") {
      // 如果切回了本工具（选区工具），就把叠加在画板上的 UI 层显示出来
      this.htmlEl.style.display = "block";
    } else {
      // 如果切去了别的工具，必须隐藏选区/变形的 UI 层，
      // 防止用户用画笔画画时，不小心点到了隐藏在透明处的变形框。
      this.htmlEl.style.display = "none";
    }
  }

  /**
   * 【生命周期：工具被激活】
   * 当用户从其他工具切回本工具，或者通过历史记录 (Undo/Redo) 恢复本工具状态时触发。
   *
   * @param cursorPos 激活瞬间的鼠标位置 (可选)
   * @param poppedTemp 是否是从临时历史记录中弹出的状态（比如撤销变形）
   */
  activate(cursorPos?: TVector2D, poppedTemp?: boolean): void {
    // 1. 光标自动感应：如果带有鼠标位置，且当前正处于 FFD 变形模式
    if (cursorPos && this.transformation && this.ffdMesh) {
      // 将鼠标的屏幕物理坐标转回画布坐标
      const cursorCanvasPos = this.viewportToCanvas(cursorPos);
      // 探测鼠标是不是刚好悬停在网格的某个控制点上
      const param = findParametricCoordinate(
        cursorCanvasPos.x,
        cursorCanvasPos.y,
        this.ffdMesh,
      );
      // 如果指着控制点，立刻把鼠标游标变成“可拖动(move)”以提示用户
      this.easel.setCursor(param ? "move" : "default");
    } else {
      // 如果不是 FFD 模式，恢复默认游标
      this.easel.setCursor("default");
    }
    // 2. 状态重置
    this.isDragging = false;
    // 3. 强制同步一次当前视图（画板）的缩放与平移矩阵，
    // 防止在别的工具里缩放了画布，切回来时变形框还在老地方。
    this.onUpdateTransform(this.easel.getTransform());
    // 4. 如果不是从撤销历史中恢复的，就彻底清空之前可能遗留的套索临时轨迹
    if (!poppedTemp) {
      this.resetPolyShape();
    }
  }

  /**
   * 【视图同步】：当外层画板（摄像机）发生平移或缩放时触发
   * 作用：选区虚线框（蚂蚁线）和八点变形控制框必须“钉”在画布上，
   * 不能随着用户的缩放操作而在屏幕上乱飘。
   */
  onUpdateTransform(transform: TViewportTransform): void {
    this.viewportTransform = transform;
    // 更新蚂蚁线的渲染路径缩放，以贴合新的画布大小
    this.updateSelectionPath();
    // 将最新的摄像机矩阵传递给自由变换控制框，让它的 8 个角也跟着缩放/平移
    this.freeTransform?.setViewportTransform(transform);
  }

  /**
   * 【数据层同步】：当底层物理多边形选区发生本质改变时触发
   * 例如：用户刚刚画完了一个新的套索圈，底层已经计算出了它的真实多边形顶点。
   */
  onUpdateSelection(selection: MultiPolygon | undefined): void {
    // 更新本地选区顶点缓存
    this.canvasSelection = selection || [];
    // 重新生成用于 GPU 渲染的 Path2D 路径对象
    this.updateSelectionPath();
  }

  /**
   * 【预览层同步】：渲染临时形变中的选区
   * 原理：当用户拖拉变形选区时，为了流畅度，真实的图层像素尚未改变，
   * 改变的只是漂浮在半空中的“临时渲染层(Rendered Selection)”。
   */
  setRenderedSelection(selection: MultiPolygon | undefined): void {
    this.selection = selection;
    // 委托底层的 easel (画板视图) 去绘制这个临时的变形阴影
    this.easel.setRenderedSelection(selection);
  }

  /**
   * 【贴心视口跟踪】：当用户开始自由变换时，如果变形框不在当前视野内，自动将摄像机移过去
   */
  private bringTransformRectIntoView(freeTransform: TFreeTransform): void {
    const viewportTransform = this.easel.getTransform();
    const easelSize = this.easel.getSize();
    // 留出 40px 的安全边距，不要贴死在屏幕边缘
    const padding = 40;
    // 算出自由变换外围边框的物理尺寸
    const rect = {
      x: freeTransform.x - freeTransform.width / 2,
      y: freeTransform.y - freeTransform.height / 2,
      width: freeTransform.width,
      height: freeTransform.height,
    };
    // 检查这个边框是不是完全在屏幕视野内？
    if (checkRectFullyVisible(rect, viewportTransform, easelSize, 0)) {
      return;
    }
    // 如果不在，命令摄像机（easel）平移并缩放，直到看清整个变形框
    this.easel.setTransform(
      getFitRectTransform(rect, viewportTransform, easelSize, false, padding),
    );
  }

  /**
   * 刚进入自由变换模式时的初始化注入
   */
  initialiseTransform(transform: TComposedTransformation): void {
    // 深拷贝，防止污染原有的历史数据
    transform = BB.copyObj(transform);
    if (transform.type !== "free") {
      throw new Error(
        'must call initialiseTransform with transform.type = "free"',
      );
    }
    this.transformation = transform;
    this.freeTransform?.initialise(transform.freeTransform);
    // 设置自动吸附（Snapping）的点。通常是吸附到画布的四个角和边缘
    const { width, height } = this.easel.getProjectSize();
    this.freeTransform?.setSnappingPoints([0, width], [0, height]);
    // 初始化后，如果变形框不在当前视野，自动将摄像机移动过去
    this.bringTransformRectIntoView(transform.freeTransform);
  }

  /**
   * 【重置矩阵】：当发生撤销/重做 (Undo/Redo) 时，从历史栈中恢复变形框的状态
   */
  setTransform(transform: TComposedTransformation): void {
    transform = BB.copyObj(transform);
    this.transformation = transform;
    // 如果恢复的是一个网格液化 (FFD) 操作
    if (transform.type === "ffd") {
      const { width, height } = this.easel.getProjectSize();
      // 必须使用恢复的历史数据，重新构建用于检测点击的高精度 2D Mesh 网格！
      this.ffdMesh = createFfdMesh(
        RENDERED_FFD_MESH_RESOLUTION,
        RENDERED_FFD_MESH_RESOLUTION,
        transform.ffd,
        width,
        height,
        true,
      );
      this.easel.requestRender();
    } else {
      // 如果恢复的是普通的八点变形，直接传给控件即可
      this.freeTransform?.initialise(transform.freeTransform);
      this.ffdMesh = undefined;
    }
    // 刷新液化网格线和外围边框的显示状态
    this.updateLatticePath();
    this.updateFreeTransformVisibility();
  }

  clearRenderedSelection(isImmediate?: boolean): void {
    this.easel.clearRenderedSelection(isImmediate);
  }

  setBooleanOperation(operation: TBooleanOperation): void {
    this.defaultBooleanOperation = operation;
  }

  setSelectShape(shape: TSelectShape): void {
    // 切换了形状（比如从矩形切到了多边形套索），立马打断当前画到一半的线
    this.resetPolyShape();
    this.selectShape = shape;
  }

  getIsLocked(): boolean {
    // 正在拖拽时，界面是被锁定的
    return this.isDragging;
  }

  /**
   * 【最终渲染叠加层】：由底层的 Easel 在画完了所有图层像素后，主动回调此函数
   * 作用：把属于 UI 层的“变形网格”和“多边形临时橡皮筋”画在画面的最顶层。
   */
  renderAfterViewport(
    ctx: CanvasRenderingContext2D,
    transform: TViewportTransformXY,
  ): void {
    // 1. 如果处于液化模式，渲染 FFD 变形网格
    if (this.mode === "transform" && this.transformation?.type === "ffd") {
      ctx.save();
      this.renderLattice(ctx, transform.scaleX);
      ctx.restore();
    }

    // 2. 渲染还没闭合的多边形套索那条“橡皮筋”线条
    if (this.polyShape.length < 2) {
      return;
    }

    ctx.save();
    // 使用 'difference' 差值模式，保证这根线不管在全白还是全黑的背景上，都能看得清
    ctx.globalCompositeOperation = "difference";
    ctx.beginPath();
    const shape = this.polyShape;
    ctx.moveTo(shape[0].x, shape[0].y);
    for (let i = 1; i < shape.length; i++) {
      // 把鼠标走过的轨迹连起来
      ctx.lineTo(shape[i].x, shape[i].y);
    }
    // 同样是无视缩放的“1像素”极细线
    ctx.lineWidth = 1 / transform.scaleX;
    ctx.strokeStyle = "white";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.restore();
  }

  // 按下 Esc 键，直接取消当前画到一半的多边形
  onKeyDown(keyStr: string, e: KeyboardEvent): void {
    if (keyStr === "esc") {
      if (this.resetPolyShape()) {
        e.preventDefault();
      }
    }
  }

  onClickOutside(): void {
    this.resetPolyShape();
  }

  onBlur(): void {
    this.resetPolyShape();
  }

  /**
   * 键盘微调支持：用方向键精确挪动变形框
   */
  onArrowKeys(direction: TArrowKey): boolean {
    if (!this.freeTransform) {
      // 如果变形框不存在，无视方向键
      return false;
    }
    const movementMap: Record<TArrowKey, TVector2D> = {
      left: { x: -1, y: 0 },
      right: { x: 1, y: 0 },
      up: { x: 0, y: -1 },
      down: { x: 0, y: 1 },
    };
    // 如果按住了 Shift，每次移动 5 像素；否则 1 像素
    const multiplier = this.easel.isKeyPressed("shift") ? 5 : 1;
    const movement = movementMap[direction];
    this.freeTransform.move(movement.x * multiplier, movement.y * multiplier);
    return true;
  }

  // 是否开启“等比缩放”约束（通常由按住 Shift 键触发）
  setIsConstrained(isConstrained: boolean): void {
    this.freeTransformIsConstrained = isConstrained;
    this.freeTransform?.setIsConstrained(isConstrained);
  }

  // 是否开启边缘吸附对齐功能
  setIsSnapping(isSnapping: boolean): void {
    this.freeTransformIsSnapping = isSnapping;
    this.freeTransform?.setSnapping(isSnapping);
  }
}
