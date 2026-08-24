import { BB } from "../../../bb/bb";
import rotateImg from "url:/src/app/img/ui/cursor-rotate.png";
import { KeyListener } from "../../../bb/input/key-listener";
import { TVector2D } from "../../../bb/bb-types";
import { PointerListener } from "../../../bb/input/pointer-listener";
import {
  snapToPixel,
  TFreeTransformCorner,
  TFreeTransformEdge,
  toImageSpace,
  toTransformSpace,
} from "./free-transform-utils";
import { css } from "../../../bb/base/base";
import { TViewportTransform } from "../project-viewport/project-viewport";
import { createMatrixFromTransform } from "../../../bb/transform/create-matrix-from-transform";
import { applyToPoint, inverse } from "transformation-matrix";
import { pointsToAngleDeg } from "../../../bb/math/math";
import { TWheelEvent } from "../../../bb/input/event.types";
import { TFreeTransform } from "../../transform/transform-types";

// 4个角点与顶部旋转控制柄的圆圈尺寸 (16x16px)
const gripSize = 16;
// 4条边拖拽热区的宽度/高度 (10px)
const edgeSize = 10;

// 0 度对应东向 (east)，即右边的水平调整箭头 (e-resize)
// 根据当前的旋转角度，动态计算出鼠标悬浮在控制柄上时应该显示什么方向的缩放箭头（如 n-resize, ne-resize 等）
// 0 - east
function angleDegToCursor(angleDeg: number): string {
  // 八个方向的光标样式数组（每 45 度一个扇区）
  const cursors = ["e", "ne", "n", "nw", "w", "sw", "s", "se"];
  // 确保角度始终为正数 (0 ~ 360)
  while (angleDeg < 0) {
    angleDeg += 360;
  }
  // 每 45 度取一个索引，四舍五入得出最接近的方向光标
  const index = Math.round(angleDeg / 45) % cursors.length;
  // 例如返回 'nw-resize'
  return cursors[index] + "-resize";
}

/**
 * -------------------------------------------------------------
 * 【自由变换 UI 类 (FreeTransform)】
 * 核心功能：旋转 (rotate)、缩放 (scale)、平移 (translate) 的 UI 控制框
 *
 * 设计特点：
 * - 像素画优化：如果旋转角度是 90° 的倍数，会自动将坐标和宽高吸附到整数像素
 * - 奇数尺寸处理：当宽度或高度为奇数时，中心点坐标 (transform.x, transform.y) 允许出现 0.5 像素
 * - 微小区域优化：当变换区域特别小时，角的控制柄会自动向外偏移，防止重叠难点
 * -------------------------------------------------------------
 */
/**
 * Free Transform UI
 * rotate, scale, translate
 *
 * - if rotation is multiple of 90° it will snap to pixels, to be more useful for pixel art
 * - when rotation goes from non-multiple of 90° to a multiple, it will snap position and width height to pixels
 * - transform.x, transform.y can sit between pixels (by 0.5) if width or height is odd number.
 *      - this is what complicates things
 * - if transform region small, corner grips move out of the way
 *
 */
export class FreeTransform {
  /*
  -------------------------------------------------------------
  【核心架构设计：三套坐标系管理】
  -------------------------------------------------------------
  1. canvas coordinates (图像空间, 前缀 i):
     - 真实画布像素坐标，原点在图像左上角 (0, 0)。
     - 变量命名如：iX, iY, iP.x, iP.y
  2. viewport coordinates (视口空间):
     - 屏幕物理显示坐标，包含了画布当前的缩放(Zoom)、平移(Pan)和旋转(Rotate)。
  3. transform coordinates (变换本地空间, 前缀 t):
     - 以变换矩形自身的【几何中心点】为原点的相对坐标系。
     - 当变换框发生旋转时，角点在此坐标系下的相对位置是不变的。
     - 变量命名如：tX, tY, tP.x, tP.y
  -------------------------------------------------------------
  【DOM 元素树层次结构】
  -------------------------------------------------------------
  rootEl (根容器：位于画布原点)
      └─ transEl (变换容器：位于变换矩形中心，负责做 CSS rotate 旋转)
          ├─ boundsEl (中间可拖拽移动的矩形虚线框)
          ├─ edges[] (4 条边的拉伸热区，隐藏式)
          ├─ corners[] (4 个角的缩放控制柄)
          └─ angleGrip (顶部的青色旋转控制柄)
  */
  /*
    Three coordinate systems:
    - canvas coordinates - the image you're working on
    - viewport coordinates - viewport that renders the canvas with zoom, translation, rotation
    - transform coordinates - from the perspective of the transformation. origin in the middle the transformation rect
        - if the free transform is rotated, the corners of the transform do not move. the canvas moves.

    iX iY, iP.x, iP.y - i indicates image/canvas space
    tX tY, tP.x, tP.y - t indicates transform/viewport space - TODO is it transform or viewport?

    --- DOM structure ---
    rootEl
        transEl
            boundsEl
            edges[]
            corners[] - round grips in the corner of transform region
            angleGrip

    */

  // --- private ---
  // 当前变换的核心数据状态：{ x, y, width, height, angleDeg } (图像空间)
  private value: TFreeTransform; // coordinates and dimensions of transformation
  // 是否开启锁定宽高比 (等比缩放，对应 Shift 键或锁定按钮)
  private isConstrained: boolean;
  // 变形框的原始宽高比 (width / height)
  private ratio: number; // aspect ratio of transform
  // 当前视口矩阵参数 (包含视口的缩放倍数 scale、偏移 x/y)
  private viewportTransform: TViewportTransform;
  // 在【视口屏幕空间】中用于渲染 DOM 的物理尺寸与坐标缓存
  private readonly rectInViewport = {
    // x and y in center of rect
    x: 0,
    y: 0,
    width: 0,
    height: 0,

    // 4 个角点相对于中心点的位置 (变换本地空间)
    // relative to center of rect. without rotation.
    corners: [{ x: 0, y: 0 }], // in transform space
  };

  // 辅助吸附参数
  // 触发坐标吸附的最小屏幕物理距离 (7px)
  private readonly minSnapDist = 7; // minimal snapping distance in px viewport space
  // 是否启用吸附
  private snappingEnabled: boolean;
  // X 轴吸附参考线数组 (例如画布中心、图层边缘)
  private snapX: number[];
  // Y 轴吸附参考线数组
  private snapY: number[];
  // 变换数值发生变化时的上报回调函数
  private readonly callback: (transform: TFreeTransform) => void;

  // --- DOM 节点与事件监听器引用 ---
  // 根节点
  private readonly rootEl: HTMLElement; // sits at origin of image
  // 旋转层节点
  private readonly transEl: HTMLElement; // at middle of transform. rotates
  // 中央移动包围盒节点
  private readonly boundsEl: HTMLElement; // draggable bounds rectangle with outline
  // 4 个角点控制柄对象数组
  private readonly corners: TFreeTransformCorner[] = [];

  // 全局按键监听 (如监听 Shift 键)
  private keyListener: KeyListener;
  // 中央包围盒的拖拽监听
  private boundsPointerListener: PointerListener;
  // 旋转柄的拖拽监听
  private anglePointerListener: PointerListener;

  // 4 条边的控制柄对象数组
  private readonly edges: TFreeTransformEdge[] = [];
  // 旋转手柄的 UI 状态与更新函数对象
  private readonly angleGrip: {
    el: HTMLElement;
    // 变换本地空间中的 X
    x: number; // transform space
    // 变换本地空间中的 Y
    y: number;
    snap: boolean;
    updateDOM: () => void;
  };

  /**
   * 刷新并计算变换框在【视口屏幕空间】下的物理像素位置与尺寸
   */
  private updateScaled(): void {
    // 1. 根据当前的视口状态（主画布的平移、旋转、缩放），生成一个 2D 变换矩阵 (Matrix)
    const viewportMatrix = createMatrixFromTransform(this.viewportTransform);

    // 2. 利用矩阵运算，将【图像空间】下变换框的中心点 (this.value.x, this.value.y)，
    //    转换计算出它在【屏幕视口】中的真实 CSS 像素 X/Y 坐标
    const centerInViewport = applyToPoint(viewportMatrix, {
      x: this.value.x,
      y: this.value.y,
    });

    // 3. 将算出的物理中心点坐标缓存到 rectInViewport 中，供后续设置 DOM CSS left/top 使用
    this.rectInViewport.x = centerInViewport.x;
    this.rectInViewport.y = centerInViewport.y;

    // 4. 将逻辑宽高乘上主画布当前的缩放比例 (scale)，得到它在屏幕上应该显示的物理像素宽高
    this.rectInViewport.width = this.value.width * this.viewportTransform.scale;
    this.rectInViewport.height =
      this.value.height * this.viewportTransform.scale;

    // 5. 将 4 个角点在本地空间中的相对坐标，同样乘上 scale，更新视口下的角点物理偏移
    this.rectInViewport.corners = this.corners.map((item) => {
      return {
        x: item.x * this.viewportTransform.scale,
        y: item.y * this.viewportTransform.scale,
      };
    });
  }

  /**
   * 如果传入的图像空间坐标 (iX, iY) 在吸附范围内，则返回吸附后的坐标。
   * 如果没有触发吸附，则原样返回。
   * 所有的坐标参数和返回值均处于【图像空间】(image space)
   *
   * @param iX - image space X 坐标
   * @param iY - image space Y 坐标
   * @private
   */
  /**
   * Returns snapped point, if ix, iy snaps. If no snapping, returns point unchanged.
   * both in image space
   *
   * @param iX - image space
   * @param iY - image space
   * @private
   */
  private snapCorner(iX: number, iY: number): TVector2D {
    // 如果未启用吸附功能，直接返回原坐标
    if (!this.snappingEnabled) {
      return { x: iX, y: iY };
    }
    let dist: number;
    // 记录各轴上距离最近的吸附点及其偏移距离
    const snap: {
      x?: number;
      y?: number;
      dist: {
        x?: number;
        y?: number;
      };
    } = {
      x: undefined,
      y: undefined,
      dist: {
        x: undefined,
        y: undefined,
      },
    };
    // 遍历 X 轴吸附参考线（例如画布中轴线或边缘）
    for (let e = 0; e < this.snapX.length; e++) {
      dist = Math.abs(iX - this.snapX[e]);
      // 注意：minSnapDist 是屏幕空间的物理像素距离 (如 7px)，
      // 因此要除以画布当前的缩放倍数 (scale)，转换为图像空间中的逻辑距离阈值
      if (dist < this.minSnapDist / this.viewportTransform.scale) {
        // 寻找距离最近的 X 吸附线
        if (snap.x === undefined || dist < snap.dist.x!) {
          snap.x = this.snapX[e];
          snap.dist.x = dist;
        }
      }
    }
    // 遍历 Y 轴吸附参考线
    for (let e = 0; e < this.snapY.length; e++) {
      dist = Math.abs(iY - this.snapY[e]);
      if (dist < this.minSnapDist / this.viewportTransform.scale) {
        // 寻找距离最近的 Y 吸附线
        if (snap.y === undefined || dist < snap.dist.y!) {
          snap.y = this.snapY[e];
          snap.dist.y = dist;
        }
      }
    }

    // 如果 X 和 Y 都没有触发吸附，原样返回拖拽坐标
    if (snap.x === undefined && snap.y === undefined) {
      return {
        x: iX,
        y: iY,
      };
    }
    // 返回结果：如果有任一轴触发了吸附就应用吸附值，否则沿用原值
    return {
      x: snap.x ?? iX,
      y: snap.y ?? iY,
    };
  }

  /**
   * 如果开启了等比缩放约束 (isConstrained)（比如按住了 Shift 键），
   * 则将拖拽的角点坐标投射并限制到符合原始宽高比的对角线上，返回新的受限坐标。
   *
   * @param cornerIndex - 正在拖拽的角点索引 (0:左上, 1:右上, 2:右下, 3:左下)
   * @param iX - 鼠标实际的 X 坐标 (图像空间)
   * @param iY - 鼠标实际的 Y 坐标 (图像空间)
   * @private
   */
  /**
   * If constrained return nearest corner pos that fits aspect ratio
   *
   * @param cornerIndex
   * @param iX
   * @param iY
   * @private
   */
  private constrainCorner(
    cornerIndex: number,
    iX: number,
    iY: number,
  ): TVector2D {
    // 未启用约束等比缩放时，直接返回实际拖拽的坐标
    if (!this.isConstrained) {
      return {
        x: iX,
        y: iY,
      };
    }
    // 检查区域是否被翻转（负的宽高相乘为负数，代表发生了单轴镜像）
    const flip = this.value.width * this.value.height < 0 ? -1 : 1;

    // 利用点到直线的投影运算，将鼠标实际拖拽位置强制吸附到对应的对角线上
    // BB.projectPointOnLine(起点, 线上另一点, 目标投射点)
    return BB.projectPointOnLine(
      // 投影基准线起点（变换框中心）
      { x: this.value.x, y: this.value.y },
      toImageSpace(
        // 使用图层变形前的原始宽高比
        this.ratio,
        // 0(左上) 和 2(右下) 对应主对角线，1(右上) 和 3(左下) 对应副对角线
        // 结合 flip 处理翻转时的对角线斜率方向
        flip * ([0, 2].includes(cornerIndex) ? 1 : -1),
        this.value,
      ),
      // 鼠标当前的实际目标点
      { x: iX, y: iY },
    );
  }

  /**
   * 根据当前变换框的 width 和 height，更新四个角的逻辑位置。
   * 注意：这里更新的是相对【变换本地空间】的坐标，此时中心点 (0,0) 就是原点。
   * 这个方法仅更新底层逻辑模型数组，并不负责更新 DOM。
   */
  /**
   * Update corners according to width height.
   * Not their DOM.
   */
  private updateCornerPositions(): void {
    // top left (左上)
    this.corners[0].x = -this.value.width / 2; // top left
    this.corners[0].y = -this.value.height / 2;

    // top right (右上)
    this.corners[1].x = this.value.width / 2; // top right
    this.corners[1].y = -this.value.height / 2;

    // bottom right (右下)
    this.corners[2].x = this.value.width / 2; // bottom right
    this.corners[2].y = this.value.height / 2;

    // bottom left (左下)
    this.corners[3].x = -this.value.width / 2; // bottom left
    this.corners[3].y = this.value.height / 2;
  }

  /**
   * 当开启等比缩放约束（按住 Shift 键），并且用户正在拖拽【某一条边】（而非角点）时，
   * 拖拽边会导致长宽比失衡，此函数负责强制还原初始的宽高比。
   * 会直接修改内部的角点位置 (corners)。
   *
   * @param widthChanged - 宽度是否发生了改变 (拖拽左右边)
   * @param heightChanged - 高度是否发生了改变 (拖拽上下边)
   * @private
   */
  /**
   * If constrained and dragging an edge, restore aspect ratio
   * Updates corner positions.
   *
   * @param widthChanged
   * @param heightChanged
   * @private
   */
  private restoreRatio(widthChanged: boolean, heightChanged: boolean): void {
    // 如果没有开启等比缩放约束，直接返回，允许自由拉伸
    if (!this.isConstrained) {
      return;
    }
    // 判断当前旋转角度是否为 90 度的整数倍（0, 90, 180, 270...）
    const angle90 = Math.abs(this.value.angleDeg) % 90 === 0;
    // 判断是否为 90 或 270 度。此时图像的物理宽度和高度在视觉/坐标轴上发生了对调
    const whSwapped = Math.abs(this.value.angleDeg - 90) % 180 === 0;

    // 场景1：仅高度改变了（拖拽的是上边或下边）
    if (heightChanged && !widthChanged) {
      // 获取拖拽后的新高度绝对值
      const newHeight = Math.abs(this.corners[3].y - this.corners[0].y);
      // 根据原始比例计算出应当匹配的新宽度
      let newWidth = this.ratio * newHeight;

      // 像素画优化：如果正处于 90 度的整数倍，需要对齐到像素网格
      if (angle90) {
        // 检查中心点是否在整数像素边界上 (取余为 0)。若是宽高对调，则检查另一轴。
        // 如果中心是整数，那么宽度应为偶数 (roundEven)，这样除以 2 才是整数，保证边缘也是整数像素；
        // 否则宽度应为奇数 (roundUneven)，中心落在 0.5 像素位置。
        newWidth =
          (whSwapped ? this.value.y % 1 : this.value.x % 1) === 0
            ? BB.roundEven(newWidth)
            : BB.roundUneven(newWidth);
      }
      // 保持水平翻转状态（如果原本宽度方向是反的，维持其负号）
      if (this.corners[1].x - this.corners[0].x < 0) {
        newWidth *= -1;
      }
      // 强制覆盖 4 个角点的 X 坐标（左右边界），使其匹配计算出的新宽度
      this.corners[0].x = -newWidth / 2; // 左上
      this.corners[3].x = -newWidth / 2; // 左下
      this.corners[1].x = newWidth / 2; // 右上
      this.corners[2].x = newWidth / 2; // 右下
    }

    // 场景2：仅宽度改变了（拖拽的是左边或右边）
    if (!heightChanged && widthChanged) {
      // 获取拖拽后的新宽度绝对值
      const newWidth = Math.abs(this.corners[0].x - this.corners[1].x);
      // 根据原始比例计算出应当匹配的新高度
      let newHeight = newWidth / this.ratio;
      // 像素画优化，原理同上
      if (angle90) {
        newHeight =
          (whSwapped ? this.value.x % 1 : this.value.y % 1) === 0
            ? BB.roundEven(newHeight)
            : BB.roundUneven(newHeight);
      }
      // 保持垂直翻转状态
      if (this.corners[3].y - this.corners[0].y < 0) {
        newHeight *= -1;
      }
      // 强制覆盖 4 个角点的 Y 坐标（上下边界）
      this.corners[0].y = -newHeight / 2;
      this.corners[1].y = -newHeight / 2;
      this.corners[2].y = newHeight / 2;
      this.corners[3].y = newHeight / 2;
    }
  }

  /**
   * 基于当前角点 (corners) 的偏移位置，反向推算并更新变换的核心数值 (value：中心坐标 x/y 和 width/height)。
   * 当用户拖拽边角后，变换框的尺寸和中心都变了，需要同步到全局状态并刷新 DOM。
   * @private
   */
  /**
   * update transform based on corners
   * @private
   */
  private updateTransformViaCorners(): void {
    // 1. 计算出新的中心点在【图像空间】中的真实位移量。
    // (this.corners[0].x + this.corners[1].x) / 2 是角点在本地空间中新的 X 中心偏移。
    // 因为本地空间受到 angleDeg 旋转的影响，所以必须使用 BB.rotateAround 将这个偏移量旋转回真实的图像空间朝向。
    // calc transform center in image space
    const rot = BB.rotateAround(
      // 旋转原点
      { x: 0, y: 0 },
      {
        // 本地新中点的 X Y
        x: (this.corners[0].x + this.corners[1].x) / 2,
        y: (this.corners[0].y + this.corners[3].y) / 2,
      },
      // 当前的旋转角度
      this.value.angleDeg,
    );

    // 2. 将计算出来的真实偏移量加到原来的全局中心坐标上，得到拖拽后的新中心点
    this.value.x = rot.x + this.value.x;
    this.value.y = rot.y + this.value.y;

    // 3. 更新尺寸：根据对角点或相邻角点的距离重算新的 width 和 height
    // update size
    this.value.width = this.corners[1].x - this.corners[0].x; // 右侧减去左侧
    this.value.height = this.corners[3].y - this.corners[0].y; // 底部减去顶部

    // 4. 由于我们已经调整了核心数据 value 的坐标（有了新的中心点），
    // 因此必须重新以新的中心点为原点 (0,0)，初始化四个角在本地空间中的标准相对位置
    // new center means corners changed their position
    this.updateCornerPositions();

    // 5. 调用 DOM 更新，把最终计算好的尺寸位置渲染到屏幕上
    this.updateDOM();
  }

  /**
   * 根据当前的变换数据，将状态同步渲染到 DOM 元素上（物理屏幕空间）。
   * 这个方法负责将底层的逻辑数据（平移、缩放、旋转）视觉化。
   *
   * @param skipCallback - 是否跳过向外抛出事件。通常在纯粹的内部视口刷新时跳过。
   */
  /**
   * updates DOM according to transform
   * @param skipCallback
   */
  private updateDOM(skipCallback?: boolean): void {
    // 1. 根据当前视口缩放比例，重新计算一遍所有元素在屏幕上的物理像素坐标与尺寸
    this.updateScaled();

    // 2. 更新变换主容器 (transEl) 的位置和旋转
    // 注意：transEl 实际上是一个体积为 0x0 的点，它被精确定位在变换框的【中心点】
    css(this.transEl, {
      // 定位到屏幕物理中心 X Y
      left: this.rectInViewport.x + "px",
      top: this.rectInViewport.y + "px",
      // 以自身的 (0,0) 即中心点作为 CSS 旋转轴
      transformOrigin: "0 0",
      // 实际呈现的旋转角度 = 图像自身的变换旋转角 + 当前整个画布视口的旋转角
      transform:
        "rotate(" +
        (this.value.angleDeg + this.viewportTransform.angleDeg) +
        "deg)",
    });

    // 3. 更新中央的包围虚线框 (boundsEl)
    // boundsEl 是 transEl 的子元素，因此它的坐标是相对于中心点 (0,0) 的【变换本地空间】
    css(this.boundsEl, {
      // 无论宽高是否为负数（发生了翻转），UI 虚线框的尺寸始终必须是正数
      width: Math.abs(this.rectInViewport.width) + "px",
      height: Math.abs(this.rectInViewport.height) + "px",
      // 计算外边框的左上角起点：比较左上角和右上角的 X，取最小者作为 left
      left:
        Math.min(
          this.rectInViewport.corners[0].x,
          this.rectInViewport.corners[1].x,
        ) + "px",
      // 比较左上角和左下角的 Y，取最小者作为 top
      top:
        Math.min(
          this.rectInViewport.corners[0].y,
          this.rectInViewport.corners[3].y,
        ) + "px",
    });

    // 4. 触发子组件更新：4 个角的缩放控制柄
    this.corners[0].updateDOM();
    this.corners[1].updateDOM();
    this.corners[2].updateDOM();
    this.corners[3].updateDOM();

    // 5. 触发子组件更新：4 条边的拉伸热区
    this.edges[0].updateDOM();
    this.edges[1].updateDOM();
    this.edges[2].updateDOM();
    this.edges[3].updateDOM();

    // 6. 计算并更新顶部旋转控制柄 (angleGrip) 的位置
    this.angleGrip.x = 0; // 始终居中
    // 放置在变形框的上边缘之外 20px 处 (-height / 2 拿到上边缘位置，再向上偏 20px)
    this.angleGrip.y =
      -Math.abs(this.value.height * this.viewportTransform.scale) / 2 - 20;
    this.angleGrip.updateDOM();

    // 7. 如果没有被标记为跳过回调，且注册了事件监听器
    // 则将最新的变换参数深拷贝 ({ ...this.value }) 传递给上层业务逻辑
    // 原作者注释 "why should updateDOM trigger the callback?" 表明这是一种设计选择：
    // 使得每次 UI 刷新完毕后，上层画板能同步实时预览图层变形的效果。
    if (!skipCallback) {
      if (this.callback) {
        // why should updateDOM trigger the callback?
        this.callback({ ...this.value });
      }
    }
  }

  // ----------------------------------- public -----------------------------------
  /**
   * FreeTransform 构造函数
   * 初始化变换控制框的数据模型、DOM 结构以及事件监听器（如核心的包围盒拖拽平移）。
   */
  constructor(p: {
    x: number; // center of transform region. image space
    y: number;
    width: number; // size of transform region. image space
    height: number;
    angleDeg: number; // angle of transform region. degrees

    // 是否启用等比缩放约束
    isConstrained: boolean; // proportions constrained
    // X Y 轴方向的吸附参考线位置数组(图像空间)
    snapX: number[]; // where snapping along X axis. image space
    snapY: number[]; // where snapping along Y axis. image space
    // 当前的视口矩阵参数 (包含缩放、平移等)
    viewportTransform: TViewportTransform;
    // 变换状态改变时的回调函数
    callback: (transform: TFreeTransform) => void;
    // 可选：鼠标滚轮事件 (用于画布缩放)
    onWheel?: (e: TWheelEvent) => void;
    // 可选：监听滚轮事件的父容器
    wheelParent?: HTMLElement;
  }) {
    this.viewportTransform = { ...p.viewportTransform };
    // 初始化核心的变换状态数据
    this.value = {
      // coordinates and dimensions of transformation
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
      angleDeg: p.angleDeg,
    };

    this.isConstrained = p.isConstrained;

    this.snapX = p.snapX;
    this.snapY = p.snapY;
    this.callback = p.callback;
    // 默认开启智能吸附
    this.snappingEnabled = true;
    // 记录初始宽高比
    this.ratio = this.value.width / this.value.height;

    // 处理鼠标滚轮事件：计算相对于 wheelParent 的坐标偏移 (relX, relY)
    const onWheel = p.onWheel
      ? (e: TWheelEvent) => {
          if (!p.onWheel || !p.wheelParent) {
            return;
          }
          const parentRect = p.wheelParent.getBoundingClientRect();
          e.relX = e.pageX - parentRect.left;
          e.relY = e.pageY - parentRect.top;
          p.onWheel(e);
        }
      : undefined;

    // --- 1. 创建 DOM 结构 ---
    // rootEl：根容器，禁止文本选中，固定在画布原点
    this.rootEl = BB.el({
      className: "kl-free-transform",
      css: {
        userSelect: "none",
      },
    });
    // transEl：旋转容器，负责执行 CSS 旋转
    this.transEl = BB.el({
      parent: this.rootEl,
      css: {
        position: "absolute",
      },
    });

    // boundsEl：变换框主体的移动热区（带虚线边框）
    this.boundsEl = BB.el({
      css: {
        position: "absolute",
        // 显示拖拽光标
        cursor: "move",
        // 使用内阴影和外阴影组合，实现黑白交替的虚线边框效果，保证在深浅背景下都可见
        boxShadow:
          "rgba(255, 255, 255, 0.5) 0 0 0 1px inset, rgba(0, 0, 0, 0.5) 0 0 0 1px",
      },
    });

    const pointerRemainder = {
      x: 0,
      y: 0,
    };
    function resetRemainder(): void {
      pointerRemainder.x = 0;
      pointerRemainder.y = 0;
    }
    // 全局键盘监听（主要用于检测是否按下了 Shift 键）
    this.keyListener = new BB.KeyListener({});

    // 用于记录拖拽开始时，变换框中心的初始位置
    let boundsStartP = {
      x: 0,
      y: 0,
    };

    // --- 2. 核心交互：中央包围盒 (boundsEl) 的拖拽平移事件 ---
    this.boundsPointerListener = new BB.PointerListener({
      target: this.boundsEl,
      fixScribble: true,
      onPointer: (event) => {
        event.eventPreventDefault();
        // 按下鼠标：记录初始的中心坐标
        if (event.type === "pointerdown") {
          boundsStartP = { x: this.value.x, y: this.value.y };
        }
        // 按住左键拖拽：处理平移
        if (event.type === "pointermove" && event.button === "left") {
          // 获取当前视口正向矩阵
          const viewportMatrix = createMatrixFromTransform(
            this.viewportTransform,
          );
          // 通过求视口矩阵的【逆矩阵 (inverse)】，将屏幕上的鼠标拖拽像素 (pageX/Y)，
          // 转换回真实的【图像空间】逻辑像素位置
          const originInCanvas = applyToPoint(inverse(viewportMatrix), {
            x: event.downPageX!, // 按下时的屏幕坐标
            y: event.downPageY!,
          });
          const deltaInCanvas = applyToPoint(inverse(viewportMatrix), {
            x: event.pageX, // 当前的屏幕坐标
            y: event.pageY,
          });
          // 计算图像空间下的鼠标位移量
          const delta = {
            x: deltaInCanvas.x - originInCanvas.x,
            y: deltaInCanvas.y - originInCanvas.y,
          };
          // 将位移量累加到拖拽起始位置上，得到新的初步中心坐标
          this.value.x = boundsStartP.x + delta.x;
          this.value.y = boundsStartP.y + delta.y;

          // === 智能吸附 (Snapping) 计算逻辑 ===
          let dist: number;
          let snap: {
            x?: number;
            y?: number;
            distX: number;
            distY: number;
          } = {
            distX: -1,
            distY: -1,
          };
          if (this.snappingEnabled) {
            let i;
            // 1. 测试【中心点】是否靠近全局 X/Y 吸附线
            for (i = 0; i < this.snapX.length; i++) {
              dist = Math.abs(this.value.x - this.snapX[i]);
              if (dist < this.minSnapDist / this.viewportTransform.scale) {
                if (snap.x === undefined || dist < snap.distX) {
                  snap.x = this.snapX[i];
                  snap.distX = dist;
                }
              }
            }
            for (i = 0; i < this.snapY.length; i++) {
              dist = Math.abs(this.value.y - this.snapY[i]);
              if (dist < this.minSnapDist / this.viewportTransform.scale) {
                if (snap.y === undefined || dist < snap.distY) {
                  snap.y = this.snapY[i];
                  snap.distY = dist;
                }
              }
            }

            // 2. 测试【四个角点】是否靠近全局 X/Y 吸附线
            let iP;
            for (i = 0; i < 4; i++) {
              // 将角点从本地坐标转换为真实的全局图像坐标
              iP = toImageSpace(
                this.corners[i].x,
                this.corners[i].y,
                this.value,
              );
              let j;
              for (j = 0; j < this.snapX.length; j++) {
                dist = Math.abs(iP.x - this.snapX[j]);
                if (dist < this.minSnapDist / this.viewportTransform.scale) {
                  if (snap.x === undefined || dist < snap.distX) {
                    // 如果角点触发吸附，需要反向计算出当前中心点 value.x 应该处于什么位置
                    // 公式：目标吸附线位置 - (当前角点真实X - 当前中心点真实X) = 中心点需要偏移到的位置
                    snap.x = this.snapX[j] - (iP.x - this.value.x);
                    snap.distX = dist;
                  }
                }
              }
              for (j = 0; j < this.snapY.length; j++) {
                dist = Math.abs(iP.y - this.snapY[j]);
                if (dist < this.minSnapDist / this.viewportTransform.scale) {
                  if (snap.y === undefined || dist < snap.distY) {
                    // 同理，计算 Y 轴因为角点吸附所导致的中心点 Y 的补偿位置
                    snap.y = this.snapY[j] - (iP.y - this.value.y);
                    snap.distY = dist;
                  }
                }
              }
            }
          }
          // === Shift 键限制移动方向逻辑 ===
          // 如果按住 Shift 键拖拽移动，将会把移动限制在 水平(0°)、垂直(90°)、或两个对角线(45°/135°) 方向上
          if (this.keyListener.getComboStr() === "shift") {
            // 分别计算鼠标向这 4 个标准方向投影后的位置点，取距离最短(最接近鼠标当前位置)的方向作为最终吸附结果
            // 1. 投影到水平线 (Y 不变)
            let projected = BB.projectPointOnLine(
              { x: 0, y: boundsStartP.y },
              { x: 10, y: boundsStartP.y },
              { x: this.value.x, y: this.value.y },
            );
            let dist = BB.dist(
              projected.x,
              projected.y,
              this.value.x,
              this.value.y,
            );
            snap = {
              x: projected.x,
              y: projected.y,
              distX: dist,
              distY: dist,
            };
            // 2. 投影到垂直线 (X 不变)
            projected = BB.projectPointOnLine(
              { x: boundsStartP.x, y: 0 },
              { x: boundsStartP.x, y: 10 },
              { x: this.value.x, y: this.value.y },
            );
            dist = BB.dist(
              projected.x,
              projected.y,
              this.value.x,
              this.value.y,
            );
            if (dist < snap.distX) {
              snap = {
                x: projected.x,
                y: projected.y,
                distX: dist,
                distY: dist,
              };
            }

            // 3. 投影到正对角线 (45° / X,Y 等比增减)
            projected = BB.projectPointOnLine(
              { x: boundsStartP.x, y: boundsStartP.y },
              { x: boundsStartP.x + 1, y: boundsStartP.y + 1 },
              { x: this.value.x, y: this.value.y },
            );
            dist = BB.dist(
              projected.x,
              projected.y,
              this.value.x,
              this.value.y,
            );
            if (dist < snap.distX) {
              snap = {
                x: projected.x,
                y: projected.y,
                distX: dist,
                distY: dist,
              };
            }

            // 4. 投影到反对角线 (135° / X,Y 逆向增减)
            projected = BB.projectPointOnLine(
              { x: boundsStartP.x, y: boundsStartP.y },
              { x: boundsStartP.x + 1, y: boundsStartP.y - 1 },
              { x: this.value.x, y: this.value.y },
            );
            dist = BB.dist(
              projected.x,
              projected.y,
              this.value.x,
              this.value.y,
            );
            if (dist < snap.distX) {
              snap = {
                x: projected.x,
                y: projected.y,
                distX: dist,
                distY: dist,
              };
            }
          }
          // 应用吸附约束 (如果触发了吸附)
          if (snap.x != undefined) {
            this.value.x = snap.x;
          }
          if (snap.y != undefined) {
            this.value.y = snap.y;
          }

          // --- 像素画特定优化：正交角度的自动对齐 ---
          // 如果当前的旋转角度是 90 度的倍数（例如0, 90, 180, 270），
          // 那么平移时需要确保图层的中心点和宽高属性对齐到【完美的整数像素网格】上，避免边缘变虚
          // snap to pixels
          if (Math.abs(this.value.angleDeg) % 90 === 0) {
            // 这个辅助函数会抹平 x/y 中不合理的 0.5 碎边
            this.value = snapToPixel(this.value);
            // 强行对齐像素后，角点逻辑坐标可能微调，重新刷新之
            this.updateCornerPositions();
          }

          // 执行更新，将计算结果反应到真实的 DOM 和画板上
          this.updateDOM();
        }
      },
      // Klecks 特有，表示允许处理非标准/高频轮询滚轮事件
      useDirtyWheel: true,
      // 注入前文定义的滚轮回调
      onWheel: onWheel,
    });

    // --- 3. 循环创建 4 个角点的缩放控制柄 (Corners) ---
    for (let i = 0; i < 4; i++) {
      // 使用立即执行函数 (IIFE) 捕获当前的索引 i
      ((i) => {
        // 初始化单个角点对象模型
        const g = (this.corners[i] = {
          // 角点索引: 0左上, 1右上, 2右下, 3左下
          i: i,
          el: BB.el({
            css: {
              width: gripSize + "px",
              height: gripSize + "px",
              background: "#fff",
              /*background: [
                                '#ff0000',
                                '#00ff00',
                                '#0000ff',
                                '#ff00ff',
                            ][i],*/
              borderRadius: gripSize + "px",
              position: "absolute",
              border: "2px solid #000", // 黑色边框，保证在白底上可见
            },
          }) as HTMLElement,
          // 变换本地空间中的 X Y
          x: 0,
          y: 0,
          virtualPos: {
            x: 0,
            y: 0,
          },
        } as TFreeTransformCorner);
        // 定义更新角点 DOM 位置与光标样式的方法
        g.updateDOM = (): void => {
          // === 缩放控制柄的防重叠优化 ===
          // 当变换框非常小时（物理屏幕尺寸小于 20px），4个角会挤在一起难以拖拽。
          // 定义一个偏移方向数组，将它们分别向四个外角方向额外推开一点。
          // grip position
          // if it gets small: slightly offset grips, so easier to handle
          const offsetArr = [
            // 0: 左上角，向左上推
            [-1, -1],
            // 1: 右上角，向右上推
            [1, -1],
            // 2: 右下角
            [1, 1],
            // 3: 左下角
            [-1, 1],
          ].map((item) => {
            // 如果宽高为负数（发生了翻转），则偏移方向也要相应反转
            item[0] *= this.value.width > 0 ? 1 : -1;
            item[1] *= this.value.height > 0 ? 1 : -1;
            return item;
          });
          // 如果物理尺寸太小，启用 10px 的外推偏移，否则偏移为 0
          const tinyOffset =
            Math.abs(this.rectInViewport.width) < 20 ||
            Math.abs(this.rectInViewport.height) < 20
              ? 10
              : 0;

          // 更新控制柄在 DOM 中的物理位置 (减去 gripSize/2 以使其中心对齐角点)
          css(g.el, {
            left:
              this.rectInViewport.corners[g.i].x -
              gripSize / 2 +
              offsetArr[i][0] * tinyOffset +
              "px",
            top:
              this.rectInViewport.corners[g.i].y -
              gripSize / 2 +
              offsetArr[i][1] * tinyOffset +
              "px",
          });

          // === 动态光标计算 ===
          // 因为图像可能被旋转，画布视口也可能被旋转，所以悬浮在角点上的光标方向必须动态计算。
          // cursor
          const xMult = this.value.width < 0 ? -1 : 1;
          const yMult = this.value.height < 0 ? -1 : 1;
          const cornerVectors = [
            { x: -1, y: -1 }, // 0
            { x: 1, y: -1 }, // 1
            { x: 1, y: 1 }, // 2
            { x: -1, y: 1 }, // 3
          ];
          const cornerVector = {
            x: cornerVectors[i].x * xMult,
            // y 乘以 -1 将坐标系调整为符合常规角度系统的朝向（向上为 90 度）
            y: cornerVectors[i].y * yMult * -1, // *-1 so 90° point up
          };
          // 计算在当前双重旋转叠加下，这个角点物理朝向的绝对角度
          const angleDeg =
            pointsToAngleDeg({ x: 0, y: 0 }, cornerVector) -
            this.value.angleDeg - // 减去图层自身的旋转
            this.viewportTransform.angleDeg; // 减去视口的旋转
          css(g.el, {
            // 调用前文方法获取正确的 resize 光标 (如 nw-resize)
            cursor: angleDegToCursor(angleDeg),
          });
        };

        // === 角点的拖拽缩放交互监听 ===
        g.pointerListener = new BB.PointerListener({
          target: this.corners[i].el,
          fixScribble: true,
          onPointer: (event) => {
            event.eventPreventDefault();
            // 按下左键：将该角点当前的【本地坐标】转换成全局【图像坐标】，作为拖拽的初始基准
            if (event.type === "pointerdown" && event.button === "left") {
              this.corners[i].virtualPos = toImageSpace(
                this.corners[i].x,
                this.corners[i].y,
                this.value,
              );
            } else if (
              event.type === "pointermove" &&
              event.button === "left"
            ) {
              // 1. 将鼠标的屏幕位移 (dX, dY) 通过逆矩阵转换为画布空间的真实位移 delta
              const viewportMatrix = createMatrixFromTransform(
                this.viewportTransform,
              );
              const originInCanvas = applyToPoint(inverse(viewportMatrix), {
                x: 0,
                y: 0,
              });
              const deltaInCanvas = applyToPoint(inverse(viewportMatrix), {
                // 距离上一次 move 的增量
                x: event.dX,
                y: event.dY,
              });
              const delta = {
                x: deltaInCanvas.x - originInCanvas.x,
                y: deltaInCanvas.y - originInCanvas.y,
              };
              // 累加得到鼠标当前的虚拟图像坐标
              this.corners[i].virtualPos.x += delta.x;
              this.corners[i].virtualPos.y += delta.y;

              // 2. 处理吸附与约束
              // 如果开启了等比约束(Shift)，将坐标强行拉回对角线上
              let iP = {
                x: this.corners[i].virtualPos.x,
                y: this.corners[i].virtualPos.y,
              };
              iP = this.constrainCorner(i, iP.x, iP.y);
              if (!this.isConstrained) {
                // 如果没有等比约束，则进行参考线吸附处理
                iP = this.snapCorner(iP.x, iP.y);
              }

              // 3. 像素画优化：当角度正交时，将角点吸附到整数像素网格上
              if (Math.abs(this.value.angleDeg) % 90 === 0) {
                iP.x = Math.round(iP.x);
                iP.y = Math.round(iP.y);
              }

              // 4. 将约束计算后的全局图像坐标，转换回【本地坐标系】
              const tP = toTransformSpace(iP.x, iP.y, this.value);

              // 计算本次位移量 (相对于上一次)
              const dX = tP.x - this.corners[i].x;
              const dY = tP.y - this.corners[i].y;
              // 应用新坐标到当前拖拽的角点
              this.corners[i].x = tP.x;
              this.corners[i].y = tP.y;

              // 5. 联动更新相邻角点，维持矩形形状
              let indexes: number[] = [];
              // 根据当前拖拽的是哪个角，找出受影响的其他三个角
              // [受 X 影响相邻角, 受 Y 影响相邻角, 对角线相对的角]
              if (i === 0) {
                // 拖左上角 -> [左下, 右上, 右下]
                // top left
                indexes = [3, 1, 2];
              } else if (i === 1) {
                // 拖右上角 -> [右下, 左上, 左下]
                // top right
                indexes = [2, 0, 3];
              } else if (i === 2) {
                // 拖右下角 -> [右上, 左下, 左上]
                // bottom right
                indexes = [1, 3, 0];
              } else if (i === 3) {
                // 拖左下角 -> [左上, 右下, 右上]
                // bottom left
                indexes = [0, 2, 1];
              }

              // 比如拖拽左上角 (i=0)
              // indexes[0]=3 (左下角)：它的 X 应和左上角一致
              this.corners[indexes[0]].x = this.corners[i].x;
              // indexes[1]=1 (右上角)：它的 Y 应和左上角一致
              this.corners[indexes[1]].y = this.corners[i].y;

              // 6. 中心缩放模式 (Alt 键功能，在 Klecks 里可能是按住 Shift)
              // 如果按下了 shift（在此逻辑中似乎不仅控制等比，还附带了中心缩放效果）
              if (this.keyListener.isPressed("shift")) {
                // 对角线的点向反方向移动相同的位移 (保持中心点不动)
                this.corners[indexes[2]].x -= dX;
                this.corners[indexes[2]].y -= dY;
                // 更新另外两个角点的对应坐标
                this.corners[indexes[1]].x = this.corners[indexes[2]].x;
                this.corners[indexes[0]].y = this.corners[indexes[2]].y;
              }

              // 7. 当所有的角点坐标重新安置好后，推算出新的宽高、中心点，并触发 UI 更新
              this.updateTransformViaCorners();
            }
          },
          useDirtyWheel: true,
          onWheel: onWheel,
        });
      })(i);
    }

    // 在构造函数末尾，根据初始值初始化四个角的具体坐标并首次刷新 DOM
    this.updateCornerPositions();
    this.updateScaled();

    // 用于标记在拖拽边框时，是否越过了对立边，导致尺寸被反转（例如把左边拖到了右边的右侧）
    let isInverted: boolean;
    // --- 4. 循环创建 4 条边的拉伸热区 (Edges) ---
    for (let i = 0; i < 4; i++) {
      ((i): void => {
        // 初始化单条边的对象模型
        this.edges[i] = {
          el: BB.el({
            css: {
              width: edgeSize + "px",
              height: edgeSize + "px",
              // 热区默认是透明的，悬浮时才会通过光标提示可拖拽
              //background: ['red', 'green', 'blue', 'orange'][i],
              position: "absolute",
            },
          }) as HTMLElement,
        } as TFreeTransformEdge;
        const g = this.edges[i];

        // 定义更新边框热区 DOM 位置、尺寸及光标样式的方法
        g.updateDOM = () => {
          // 根据视口中的四个角坐标，计算并覆盖在对应的四条边上
          if (i === 0) {
            // Top edge (上边)
            css(g.el, {
              left:
                Math.min(
                  this.rectInViewport.corners[0].x,
                  this.rectInViewport.corners[1].x,
                ) + "px",
              top:
                Math.min(
                  this.rectInViewport.corners[0].y,
                  this.rectInViewport.corners[3].y,
                ) -
                edgeSize +
                "px",
              width: Math.abs(this.rectInViewport.width) + "px",
              height: edgeSize + "px",
            });
          } else if (i === 1) {
            // Right edge (右边)
            css(g.el, {
              left:
                Math.max(
                  this.rectInViewport.corners[0].x,
                  this.rectInViewport.corners[1].x,
                ) + "px",
              top:
                Math.min(
                  this.rectInViewport.corners[1].y,
                  this.rectInViewport.corners[2].y,
                ) + "px",
              width: edgeSize + "px",
              height: Math.abs(this.rectInViewport.height) + "px",
            });
          } else if (i === 2) {
            // Bottom edge (下边)
            css(g.el, {
              left:
                Math.min(
                  this.rectInViewport.corners[3].x,
                  this.rectInViewport.corners[2].x,
                ) + "px",
              top:
                Math.max(
                  this.rectInViewport.corners[0].y,
                  this.rectInViewport.corners[3].y,
                ) + "px",
              width: Math.abs(this.rectInViewport.width) + "px",
              height: edgeSize + "px",
            });
          } else if (i === 3) {
            // Left edge (左边)
            css(g.el, {
              left:
                Math.min(
                  this.rectInViewport.corners[0].x,
                  this.rectInViewport.corners[1].x,
                ) -
                edgeSize +
                "px",
              top:
                Math.min(
                  this.rectInViewport.corners[0].y,
                  this.rectInViewport.corners[3].y,
                ) + "px",
              width: edgeSize + "px",
              height: Math.abs(this.rectInViewport.height) + "px",
            });
          }
          // === 动态光标计算 (边缘拉伸) ===
          const xFlipped = this.value.width < 0;
          const yFlipped = this.value.height < 0;
          // 每条边对应的基准角度（上边对应90度(垂直拉伸)，右边对应0度(水平拉伸)等）
          const angles = [
            // 上边
            yFlipped ? -90 : 90,
            // 右边
            xFlipped ? 180 : 0,
            // 下边
            yFlipped ? 90 : -90,
            // 左边
            xFlipped ? 0 : 180,
          ];
          // 减去图层自身旋转和视口旋转，得出在屏幕上的绝对物理朝向
          const angleDeg =
            angles[i] - this.value.angleDeg - this.viewportTransform.angleDeg;
          css(g.el, {
            // 例如显示 n-resize 还是 e-resize
            cursor: angleDegToCursor(angleDeg),
          });
        };

        // 判断当前是否是上下边 (垂直方向拉伸)
        const isVertical = [0, 2].includes(i);
        // === 边缘拖拽拉伸交互监听 ===
        g.pointerListener = new BB.PointerListener({
          target: this.edges[i].el,
          fixScribble: true,
          onPointer: (event) => {
            event.eventPreventDefault();
            if (event.type === "pointerdown" && event.button === "left") {
              // 记录拖拽开始时是否处于翻转状态（比如左上角坐标比右上角坐标大）
              if (isVertical) {
                // top bottom
                isInverted = this.corners[0].y >= this.corners[3].y;
              } else {
                // left right
                isInverted = this.corners[0].x >= this.corners[1].x;
              }
              // 重置累积的亚像素偏移余数
              resetRemainder();
            }
            if (event.type === "pointermove" && event.button === "left") {
              // 将视口位移逆向转换为画布位移
              const viewportMatrix = createMatrixFromTransform(
                this.viewportTransform,
              );
              const originInCanvas = applyToPoint(inverse(viewportMatrix), {
                x: 0,
                y: 0,
              });
              const deltaInCanvas = applyToPoint(inverse(viewportMatrix), {
                x: event.dX,
                y: event.dY,
              });
              // 再将画布位移转换为【变换本地空间】下的位移
              // 因为在本地空间中，矩形边永远是水平垂直的，这样能极大地简化边缘拖拽的计算
              const originInTransform = toTransformSpace(
                originInCanvas.x,
                originInCanvas.y,
                this.value,
              );
              const deltaInTransform = toTransformSpace(
                deltaInCanvas.x,
                deltaInCanvas.y,
                this.value,
              );
              const tfD = {
                x: deltaInTransform.x - originInTransform.x,
                y: deltaInTransform.y - originInTransform.y,
              };
              let ti = {
                dX: tfD.x,
                dY: tfD.y,
              };

              // 像素画优化：当处于正交角度时，强制累加位移到整数像素，利用 remainder 暂存小数部分
              if (Math.abs(this.value.angleDeg) % 90 === 0) {
                ti = BB.intDxy(pointerRemainder, tfD.x, tfD.y);
              }

              // 根据当前拖拽的是哪条边，找出相关的两组角点索引
              let indexes: number[] = [];
              if (i === 0) {
                // top (上边) -> 影响 [0左上, 1右上], [3左下, 2右下] 留着备用
                // top
                indexes = [2, 3, 0, 1];
              } else if (i === 1) {
                // right
                indexes = [0, 3, 1, 2];
              } else if (i === 2) {
                // bottom
                indexes = [0, 1, 2, 3];
              } else if (i === 3) {
                // left
                indexes = [1, 2, 0, 3];
              }

              // 取出真正起作用的轴(dimension)和增量(d)
              const dimension = isVertical ? "y" : "x";
              const d = isVertical ? ti.dY : ti.dX;

              // 如果边框发生了交叉翻转，需要应用增量到对立面的角点上
              if (isInverted) {
                this.corners[indexes[0]][dimension] += d;
                this.corners[indexes[1]][dimension] += d;
              } else {
                // 正常状态下，更新与这条边相连的两个角点的坐标
                this.corners[indexes[2]][dimension] += d;
                this.corners[indexes[3]][dimension] += d;
              }

              // 中心缩放模式 (按住 Shift 时，对边向反方向发生等量位移)
              if (this.keyListener.isPressed("shift")) {
                if (isInverted) {
                  this.corners[indexes[2]][dimension] -= d;
                  this.corners[indexes[3]][dimension] -= d;
                } else {
                  this.corners[indexes[0]][dimension] -= d;
                  this.corners[indexes[1]][dimension] -= d;
                }
              }

              // 如果处于等比约束模式 (isConstrained) 下，拉伸单边会导致比例失调，
              // 调用 restoreRatio 强制同步缩放另一条轴线，恢复原始宽高比。
              if (isVertical) {
                // (widthChanged, heightChanged)
                // top bottom
                this.restoreRatio(false, true);
              } else {
                // left right
                this.restoreRatio(true, false);
              }

              this.updateTransformViaCorners();
            }
          },
          useDirtyWheel: true,
          onWheel: onWheel,
        });
      })(i);
    }

    // --- 5. 创建顶部旋转控制柄 (Angle Grip) ---
    this.angleGrip = {
      el: BB.el({
        css: {
          cursor: "url(" + rotateImg + ") 10 10, move", // 悬浮时显示特殊的旋转图标光标
          width: gripSize + "px",
          height: gripSize + "px",
          background: "#0ff", // 青色圆点
          borderRadius: gripSize + "px",
          position: "absolute",
          boxShadow: "inset 0 0 0 2px #000", // 黑色内发光作为边框
        },
      }),
      x: 0,
      y: 0,
      snap: false,
      updateDOM: () => {
        // 将控制柄居中对齐到目标坐标
        css(this.angleGrip.el, {
          left: this.angleGrip.x - gripSize / 2 + "px",
          top: this.angleGrip.y - gripSize / 2 + "px",
        });
      },
    };
    // 给旋转控制柄添加一条向下的指示线，连接到变换框主体
    BB.el({
      parent: this.angleGrip.el,
      css: {
        width: "2px",
        height: "13px",
        left: gripSize / 2 - 1 + "px",
        // 线条的起点在圆点底部
        top: gripSize + "px",
        background: "#0ff",
        position: "absolute",
      },
    });

    // === 旋转控制柄的交互监听 ===
    this.anglePointerListener = new BB.PointerListener({
      target: this.angleGrip.el,
      fixScribble: true,
      onPointer: (event) => {
        event.eventPreventDefault();
        if (event.type === "pointermove" && event.button === "left") {
          // 1. 将鼠标的屏幕坐标转换到真实的画布图像空间中
          const viewportMatrix = createMatrixFromTransform(
            this.viewportTransform,
          );
          const rootBoundingClientRect = this.rootEl.getBoundingClientRect();
          const cursorInViewportPosition = {
            x: event.clientX - rootBoundingClientRect.left,
            y: event.clientY - rootBoundingClientRect.top,
          };
          const cursorInCanvasPosition = applyToPoint(
            inverse(viewportMatrix),
            cursorInViewportPosition,
          );

          // 2. 利用 Math.atan2 (封装在 BB.pointsToAngleDeg 中) 计算【变换框中心】和【鼠标当前位置】之间的夹角
          // 由于数学运算中 0 度在正右方 (East)，而我们的手柄默认在正上方 (North)，所以需要 +90 度进行补偿偏移。
          const a =
            BB.pointsToAngleDeg(
              { x: this.value.x, y: this.value.y },
              cursorInCanvasPosition,
            ) + 90;
          this.value.angleDeg = a;
          // 3. 角度吸附逻辑：计算出最接近的 45 度整数倍角度
          const snapDeg = Math.round((a / 360) * 8) * 45;
          if (this.keyListener.getComboStr() === "shift") {
            // 按住 Shift 键时强制按 45 度步进旋转
            this.value.angleDeg = snapDeg;
          } else if (this.snappingEnabled && Math.abs(snapDeg - a) < 8) {
            // 开启智能吸附且接近特定角度 (误差<8度) 时，自动贴合到 45 度的倍数
            this.value.angleDeg = snapDeg;
          }
          this.updateDOM();
        }
        // 鼠标释放时
        if (event.type === "pointerup") {
          // 如果最终旋转落在了 90 度的正交倍数上，再次执行像素画网格对齐优化
          if (Math.abs(this.value.angleDeg) % 90 === 0) {
            this.value = snapToPixel(this.value);
            this.updateCornerPositions();
            this.updateDOM();
          }
        }
      },
      useDirtyWheel: true,
      onWheel: onWheel,
    });

    // --- 6. DOM 挂载组装 ---
    // 初始对齐像素并进行第一次 DOM 渲染
    this.value = snapToPixel(this.value);
    this.updateDOM(true);
    // 将所有的控制元素，一股脑全部附加到旋转容器 (transEl) 下
    // 这样 transEl 只要一做 CSS rotate，底下所有的边、角、框和手柄就跟着一块旋转了
    BB.append(this.transEl, [
      // 中央虚线拉伸移动框
      this.boundsEl,
      // 4 条不可见的拉伸边热区
      this.edges[0].el,
      this.edges[1].el,
      this.edges[2].el,
      this.edges[3].el,
      // 4 个角的白色圆点控制柄
      this.corners[0].el,
      this.corners[1].el,
      this.corners[2].el,
      this.corners[3].el,
      // 顶部青色旋转控制柄
      this.angleGrip.el,
    ]);
  }

  /**
   * 获取当前变换状态的核心数据。
   * 返回深拷贝对象，防止外部意外篡改内部状态。
   */
  getValue(): TFreeTransform {
    return { ...this.value };
  }

  /**
   * 开启或关闭等比缩放约束（例如按下/松开 Shift 键，或点击 UI 上的锁按钮）。
   * @param b - 是否开启约束
   */
  setIsConstrained(b: boolean): void {
    this.isConstrained = b;
    // 如果开启了约束，且当前尺寸有效，则重新记录当前的原始宽高比
    if (b && this.value.width !== 0 && this.value.height !== 0) {
      this.ratio = Math.abs(this.value.width / this.value.height);
    }
  }

  /**
   * 开启或关闭智能吸附功能
   */
  setSnapping(b: boolean): void {
    this.snappingEnabled = b;
  }

  /**
   * 动态更新吸附参考线数组。
   * （当画板尺寸改变，或者需要对齐到其他图层边缘时，外部会调用此方法刷新参考线）
   */
  setSnappingPoints(snapX: number[], snapY: number[]): void {
    this.snapX = snapX;
    this.snapY = snapY;
  }

  /**
   * 动态更新吸附参考线数组。
   * （当画板尺寸改变，或者需要对齐到其他图层边缘时，外部会调用此方法刷新参考线）
   */
  setPos(p: TVector2D): void {
    this.value.x = p.x;
    this.value.y = p.y;
    this.updateDOM(true);
  }

  /**
   * 相对移动：根据给定的偏移量 (dX, dY) 平移变换框
   * 传入 false（默认），触发回调通知画板更新预览图。
   */
  move(dX: number, dY: number): void {
    this.value.x += dX;
    this.value.y += dY;
    this.updateDOM(false);
  }

  /**
   * 直接设置变换框的物理尺寸 (宽和高)
   */
  setSize(w: number, h: number): void {
    this.value.width = w;
    this.value.height = h;
    // 像素画优化：正交角度下吸附到像素网格
    if (Math.abs(this.value.angleDeg) % 90 === 0) {
      this.value = snapToPixel(this.value);
    }
    // 尺寸改变了，重算四个角在本地坐标系的位置
    this.updateCornerPositions();
    // 触发回调
    this.updateDOM(false);
  }

  /**
   * 批量初始化/重置变换状态。
   * 常用场景：外部点击了“重置”按钮，或者应用了撤销/重做 (Undo/Redo) 时，将状态强行覆盖。
   */
  initialise(transform: TFreeTransform): void {
    this.value.x = transform.x;
    this.value.y = transform.y;
    this.value.width = transform.width;
    this.value.height = transform.height;
    this.value.angleDeg = transform.angleDeg;
    this.ratio = Math.abs(transform.width / transform.height);
    this.updateCornerPositions();
    // 跳过回调，避免死循环
    this.updateDOM(true);
  }

  /**
   * 绝对设置旋转角度。
   */
  setAngleDeg(a: number): void {
    this.value.angleDeg = a;
    if (Math.abs(this.value.angleDeg) % 90 === 0) {
      this.value = snapToPixel(this.value);
      this.updateCornerPositions();
    }
    this.updateDOM(true);
  }

  /**
   * 更新视口变换矩阵。
   * 极其重要：当用户在变形期间，使用触摸板或鼠标滚轮【缩放或平移了整个大画布】时，
   * 图像本身的变形数据 (value) 并没有变，但 UI 框必须跟着画布一起缩放平移。
   */
  setViewportTransform(transform: TViewportTransform): void {
    this.viewportTransform = { ...transform };
    this.updateScaled();
    // skip callback because viewport change does not affect the value
    this.updateDOM(true);
  }

  /**
   * 获取 UI 根节点。
   * 上层业务通过此方法获取 DOM 元素，并挂载 (appendChild) 到画板的覆盖层中。
   */
  getElement(): HTMLElement {
    return this.rootEl;
  }

  /**
   * 获取记录的初始宽高比
   */
  getRatio(): number {
    return this.ratio;
  }

  /**
   * 销毁组件：负责执行清理工作，释放内存。
   * 注销所有绑定在 DOM 上的指针事件 (Pointer) 和键盘事件 (Key) 的监听器，
   * 避免发生内存泄漏 (Memory Leak) 以及事件的重复触发。
   */
  destroy(): void {
    this.keyListener.destroy();
    this.boundsPointerListener.destroy();
    this.corners.forEach((item) => item.pointerListener.destroy());
    this.edges.forEach((item) => item.pointerListener.destroy());
    this.anglePointerListener.destroy();
  }
}
