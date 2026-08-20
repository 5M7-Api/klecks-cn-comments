import { TVector2D } from "../../bb/bb-types";
import { MultiPolygon, Polygon } from "polygon-clipping";
import { translateMultiPolygon } from "../../bb/multi-polygon/translate-multi-polygon";
import { getEllipsePath } from "../../bb/multi-polygon/get-ellipse-path";
import { KlCanvas } from "../canvas/kl-canvas";
import { BB } from "../../bb/bb";
import { applyPolygonClipping } from "../../bb/multi-polygon/apply-polygon-clipping";

// 【选区布尔运算模式】
// union: 加选 (并集)
// difference: 减选 (差集)
// new: 新建 (直接替换旧选区)
export type TBooleanOperation = "union" | "difference" | "new";
// 【选区形状枚举】
// rect: 矩形 | ellipse: 椭圆 | lasso: 自由套索 | poly: 多边形套索
export type TSelectShape = "rect" | "ellipse" | "lasso" | "poly";

// -------------------------------------------------------------
// 【防系统崩溃神器：浮点数精度截断】
// -------------------------------------------------------------
export const POLYGON_PRECISION = 2; // 保留 2 位小数
export function limitPrecision(num: number): number {
  return parseFloat(num.toFixed(POLYGON_PRECISION));
}
// 遍历整个多边形的所有环 (ring) 和坐标 (x,y)，将其精度统一切断到 2 位小数
export function limitPolygonPrecision(poly: Polygon): Polygon {
  return poly.map((ring) =>
    ring.map(([x, y]) => [limitPrecision(x), limitPrecision(y)]),
  );
}

export type TSelectToolParams = {
  klCanvas: KlCanvas;
};

/**
 * 纯逻辑类：负责收集鼠标轨迹、管理选区多边形数据、处理布尔运算
 */
export class SelectTool {
  // from params
  private readonly klCanvas: KlCanvas;

  // 当前正在使用的绘制形状 (默认矩形)
  private shape: TSelectShape = "rect";
  // 【核心数据】：当前画面上已经存在、且计算完成的最终多边形集合！
  private selection: MultiPolygon | undefined;
  // 当前用户的按下操作模式 (默认是新建)
  private selectOperation: TBooleanOperation = "new";

  // 【轨迹缓存】：用户当前正按住鼠标拖拽过程中，记录下的所有原始坐标点
  private selectDragInputs: TVector2D[] = [];
  // 以下三个变量专门用于“平移选区虚线框（不影响像素）”的功能
  private moveStartPos: TVector2D | undefined;
  // 移动前的选区快照
  private selectionAtMoveStart: MultiPolygon | undefined;
  // 用户点了一下，到底有没有发生实际拖拽？

  private didMove: boolean = false; // was selection moved

  // ----------------------------------- public -----------------------------------
  constructor(p: TSelectToolParams) {
    // 注入图层依赖
    this.klCanvas = p.klCanvas;
  }

  // 彻底清空当前选区数据
  reset(): void {
    this.selection = undefined;
  }

  /**
   * 【核心合并计算引擎】
   * 作用：把用户刚刚画完的一个新形状（polygon），和画面上已有的老选区（this.selection），
   * 按照用户的要求（加选/减选/新建）合并成一个全新的、可能有很多窟窿的复杂多边形。
   */
  combineSelection(polygon: Polygon): MultiPolygon {
    // 取出旧的选区，如果没有旧选区就当成空数组
    let result: MultiPolygon = this.selection ?? [];
    if (this.selectOperation === "new") {
      // 1. 新建模式：直接丢弃老选区，以新形状为准
      result = [polygon];
    } else {
      // 如果旧选区存在而且不为空
      if (this.selection && this.selection.length > 0) {
        // 判断是加选 (union) 还是减选 (difference)
        const operation =
          this.selectOperation === "difference" ? "difference" : "union";
        // 【调用底层的多边形剪裁算法进行硬计算！】
        // 它会利用 polygon-clipping 库的数学力量把两个形状“切”在一起。
        result = applyPolygonClipping(operation, this.selection, polygon);
      } else {
        // 如果旧选区是空的
        if (this.selectOperation === "union") {
          // 空画布上进行加选，等同于新建
          result = [polygon];
        }
        // 空画布上进行减选，什么都不用做 (noop)
        // noop if difference on empty selection
      }
    }
    return result;
  }

  /**
   * 【实时预览计算器】
   * 获取当前最新的选区状态。不仅包括以前画好的，还包括当前正按住鼠标画到一半的形状。
   */
  /** current state of selection */
  getSelection(): MultiPolygon | undefined {
    // 1. 先把老选区拿出来打底
    // combine selections
    let selection: MultiPolygon = this.selection || [];

    // 2. 如果轨迹数组里的点大于1个，说明用户此时正按着鼠标在拖拽
    if (this.selectDragInputs.length > 1) {
      // currently inputting

      // 提取当前的修饰键操作（比如有没有按住 Alt 想要减选）
      const operation =
        this.selectOperation === "difference" ? "difference" : "union";

      // 3. 分支判断：如果你当前选择的工具是“矩形选框”
      if (this.shape === "rect") {
        // 取出鼠标刚按下时的起点 (first)
        const first = this.selectDragInputs[0];
        // 取出鼠标当前停留的终点 (last)
        const last = this.selectDragInputs[this.selectDragInputs.length - 1];
        // 【边界安全处理】：
        // 用户画矩形不一定是从左上画到右下，完全可能从右下反方向往左上拖拽。
        // 所以必须用 Math.min 和 Math.max 找出真正的“最左、最右、最上、最下”。
        // floor 和 ceil 的作用是向下/向上取整，这样顺便就把上文提到的“精度截断”给做了！
        // floor and ceil already limit precision
        const minX = Math.floor(Math.min(first.x, last.x));
        const minY = Math.floor(Math.min(first.y, last.y));
        const maxX = Math.ceil(Math.max(first.x, last.x));
        const maxY = Math.ceil(Math.max(first.y, last.y));

        // 组装成一个标准的多边形数据结构 (Polygon)，这其实就是一个四边形数组。
        // 顺序是：左上 -> 右上 -> 右下 -> 左下
        // 然后立刻调用刚才分析过的 combineSelection 进行布尔运算合并！
        selection = this.combineSelection([
          [
            [minX, minY],
            [maxX, minY],
            [maxX, maxY],
            [minX, maxY],
          ],
        ]);
      } else if (this.shape === "ellipse") {
        // 4. 分支判断：如果你当前选择的工具是“椭圆选框”
        const first = this.selectDragInputs[0];
        const last = this.selectDragInputs[this.selectDragInputs.length - 1];

        // 椭圆的计算依然只需要起点和终点，它们构成了一个矩形包围盒。
        // 计算椭圆的中心点坐标 (cx, cy)
        const cx = (first.x + last.x) / 2;
        const cy = (first.y + last.y) / 2;
        // 计算椭圆的横向半径 (rx) 和纵向半径 (ry)
        const rx = Math.abs(last.x - first.x) / 2;
        const ry = Math.abs(last.y - first.y) / 2;

        // 【关键转换】：把完美的椭圆“降维”成多边形
        selection = this.combineSelection(
          // getEllipsePath 会利用三角函数(sin, cos)，把这个椭圆切碎成 50 条直的短线段。
          // 然后 limitPolygonPrecision 再把这 50 个点的精度截断。
          limitPolygonPrecision(getEllipsePath(cx, cy, rx, ry, 50)),
        );
      } else if (this.shape === "lasso") {
        // 5. 分支判断：如果你当前选择的工具是“自由套索”（或者多边形套索）
        selection = this.combineSelection([
          // 自由套索最简单粗暴：直接把你按住鼠标时产生的所有轨迹点 (selectDragInputs)，
          // 挨个截断精度后，丢进数组里，它天然就是一个不规则的多边形！
          this.selectDragInputs.map((p) => [
            limitPrecision(p.x),
            limitPrecision(p.y),
          ]),
        ] as Polygon);
      }
    }

    // 如果算了一通发现没有任何选区（比如用减选模式把选区全擦光了），就返回 undefined
    return selection.length === 0 ? undefined : selection;
  }

  // --- selecting ---
  /**
   * 1. 【开始绘制】：鼠标/笔 按下 (pointerdown) 时触发
   */
  startSelect(pos: TVector2D, operation: TBooleanOperation): void {
    // 记录当前的模式（新建、加选、减选）
    this.selectOperation = operation;
    // 如果是新建模式，直接把画面上老选区彻底清空
    if (this.selectOperation === "new") {
      this.reset();
    }
    // 开启一个新的轨迹草稿，并把鼠标按下的起点作为第一个坐标塞进去
    this.selectDragInputs = [pos];
  }

  /**
   * 2. 【拖拽绘制中】：鼠标/笔 移动 (pointermove) 时触发
   */
  goSelect(pos: TVector2D, isShiftPressed: boolean = false): void {
    let p = pos; // p 代表将要记录进草稿的坐标点
    // 【等比约束逻辑 (Constrain Proportions)】：
    // 如果用户当前画的是“矩形”或“椭圆”，并且按住了 Shift 键，则强制画正方形 / 正圆。
    if (
      (this.shape === "ellipse" || this.shape === "rect") &&
      isShiftPressed &&
      this.selectDragInputs.length > 0
    ) {
      const start = this.selectDragInputs[0];
      // 横向拉扯距离
      const dx = pos.x - start.x;
      // 纵向拉扯距离
      const dy = pos.y - start.y;
      // 取长宽里较短的那一边作为正方形/正圆的统一边长/直径
      const size = Math.min(Math.abs(dx), Math.abs(dy));
      // 覆盖原本的鼠标坐标，强制对齐成正方形/正圆的对角坐标
      p = {
        x: start.x + Math.sign(dx) * size, // Math.sign 保证不改变鼠标拉拽的方向(象限)
        y: start.y + Math.sign(dy) * size,
      };
    }
    // 将最终算好的坐标推入轨迹草稿数组中
    this.selectDragInputs.push({
      x: p.x,
      y: p.y,
    });
  }

  /**
   * 3. 【结束绘制】：鼠标/笔 松开 (pointerup) 时触发
   */
  endSelect(): void {
    // 只有当数组里大于1个点（发生过真正的位移拖拽）时，才算是一次有效操作
    if (this.selectDragInputs.length > 1) {
      // commit
      // commit: 一锤定音！
      // 调用刚才分析过的 getSelection 引擎，算出最终的多边形，
      // 并永久固化覆盖掉 this.selection。
      this.selection = this.getSelection();
    } else {
      // 如果用户仅仅只是在原地“点”了一下，什么都没画出来，
      // 那么默认用户的意图是“取消选择”（Deselect）。
      this.reset();
    }
    // 清空本次画图的草稿，为下一次画选区做准备
    this.selectDragInputs = [];
  }

  /**
   * 4. 【追加多边形】：专门给“多边形套索”工具用的闭合回调
   * 解释：因为多边形套索是点按式连线，它有自己的双击闭合逻辑（我们在 EaselSelect 里看过）。
   * 一旦闭合，就会把算好的多边形通过这个接口塞进来。
   */
  addPoly(polygon: TVector2D[], operation: TBooleanOperation): void {
    this.selectOperation = operation;
    // 强制截断精度后，调用合并引擎
    this.selection = this.combineSelection([
      polygon.map((p) => [limitPrecision(p.x), limitPrecision(p.y)]),
    ]);
  }

  // ==========================================
  // TODO：【平移选区】（只移动虚线框，不移动像素）这个功能不需要，移动直接移动像素
  // ==========================================
  // --- moving selection ---
  startMoveSelect(pos: TVector2D): void {
    this.moveStartPos = pos;
    // 移动前，必须深拷贝一份当前选区的快照，后续所有的计算都基于这个快照偏移，防止误差累积
    this.selectionAtMoveStart = this.selection
      ? BB.copyObj(this.selection)
      : undefined;
    this.didMove = false;
  }

  goMoveSelect(pos: TVector2D, isShiftPressed: boolean = false): void {
    if (!this.moveStartPos) {
      return;
    }
    this.didMove = true;
    let dx = pos.x - this.moveStartPos.x;
    let dy = pos.y - this.moveStartPos.y;
    // 【磁吸对齐逻辑】：如果按住了 Shift 键，则强制吸附到 0°、45°、90°、135° 等 8 个特定方向
    if (isShiftPressed) {
      // snap to 0°, 45°, 90°, 135° axes from start position
      const angle = Math.atan2(dy, dx); // 算出当前拖拽的真实极坐标角度
      // 将角度强制四舍五入到最近的 45 度 (Math.PI / 4) 的倍数
      const snapAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
      // 算出直线距离
      const dist = Math.sqrt(dx * dx + dy * dy);
      // 用直角边公式还原回强行吸附后的 dx, dy
      dx = Math.cos(snapAngle) * dist;
      dy = Math.sin(snapAngle) * dist;
    }
    // 像素级对齐，防止半个像素导致的模糊
    dx = Math.round(dx);
    dy = Math.round(dy);
    // 调用底层的平移函数，把快照里的所有多边形顶点全部加上 dx, dy
    if (this.selectionAtMoveStart) {
      this.selection = translateMultiPolygon(this.selectionAtMoveStart, dx, dy);
    }
  }

  endMoveSelect(): void {
    // 移动结束，清空临时状态
    this.moveStartPos = undefined;
    this.selectionAtMoveStart = undefined;
  }

  getDidMove(): boolean {
    return this.didMove;
  }

  // ==========================================
  // 【全选与反选】
  // ==========================================
  /**
   * 全选 (Ctrl + A)
   * 极简暴力的算法：不碰图层像素，直接手捏一个跟画板宽、高一模一样的巨型矩形多边形，设为选区。
   */
  selectAll(): void {
    this.reset();
    const width = this.klCanvas.getWidth();
    const height = this.klCanvas.getHeight();
    this.selection = [
      [
        [
          [0, 0],
          [width, 0],
          [width, height],
          [0, height],
          [0, 0],
        ],
      ],
    ];
  }

  /**
   * 反选 (Ctrl + Shift + I)
   * 非常聪明的算法：
   * 1. 也是先造一个跟画布一样大的巨型矩形。
   * 2. 然后用这个巨型矩形，去和当前的 selection 做差集（difference）运算！
   * 3. 抠掉的地方自然就成了新选区。
   */
  invertSelection(): void {
    const selection = this.selection ?? [];
    const width = this.klCanvas.getWidth();
    const height = this.klCanvas.getHeight();
    this.selection = applyPolygonClipping(
      "difference",
      [
        [
          [0, 0],
          [width, 0],
          [width, height],
          [0, height],
        ],
      ],
      selection,
    );
  }

  setShape(shape: TSelectShape): void {
    this.shape = shape;
  }

  getShape(): TSelectShape {
    return this.shape;
  }

  setSelection(selection: MultiPolygon | undefined): void {
    this.selection = selection
      ? BB.copyObj(selection).map(limitPolygonPrecision)
      : undefined;
  }
}
