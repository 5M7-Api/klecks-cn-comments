import { TSize2D, TVector2D } from "../../../bb/bb-types";
import { TPointerEvent } from "../../../bb/input/event.types";
import { TViewportTransform } from "../project-viewport/project-viewport";

export type TCornerPanningParams = {
  // 获取当前视口（你能看到的屏幕区域）的大小
  getEaselSize: () => TSize2D;
  // 获取当前画布的平移/缩放矩阵
  getTransform: () => TViewportTransform;
  // 设置（移动）画布的矩阵
  setTransform: (transform: TViewportTransform) => void;
  // 判断当前工具状态是否允许边缘平移（比如没按鼠标时就不该平移）
  testCanPan: (buttonIsPressed: boolean) => boolean;
  // 【核心回调】：当你把鼠标抵住边缘、画布自动滚动时，虽然你的物理鼠标没动，
  // 但鼠标“相对于画布”的坐标已经变了。此时必须通过这个回调通知外层工具：“赶紧根据新坐标重新画一下线！”
  onRepeatEvent: (e: TPointerEvent) => void;
};

export class CornerPanning {
  // from params
  private getEaselSize: () => TSize2D;
  private readonly getTransform: () => TViewportTransform;
  private readonly setTransform: (transform: TViewportTransform) => void;
  private readonly testCanPan: (buttonIsPressed: boolean) => boolean;
  private readonly onRepeatEvent: (e: TPointerEvent) => void;

  // 【触发阈值】：距离屏幕边缘 25 像素以内时，开始触发自动平移
  private readonly thresholdPx = 25;

  // 状态管理
  // state
  // 动画帧句柄，用于随时打断滚动
  private animationFrameHandle:
    | ReturnType<typeof requestAnimationFrame>
    | undefined;
  // 上一帧的时间戳（用于计算增量，实现平滑滚动）
  private lastFrameTimestamp = 0;
  // 当前滚动的方向向量 (比如向右下角滚就是 {x: -1, y: -1})
  private cornerDirection: TVector2D | undefined;
  // 缓存最后一次的鼠标事件数据
  private repeatEvent: TPointerEvent = {} as TPointerEvent;

  /**
   * 【核心动画引擎：滚动死循环】
   * 只要鼠标没离开屏幕边缘，这个函数就会以 60FPS 的帧率疯狂执行，不断移动画布。
   */
  // only call through requestAnimationFrame when animationFrameHandle undefined
  private movementLoop(): void {
    // 如果方向向量被清空了，说明鼠标离开了边缘，立刻刹车停止动画循环
    if (!this.cornerDirection) {
      if (this.animationFrameHandle) {
        cancelAnimationFrame(this.animationFrameHandle);
      }
      this.animationFrameHandle = undefined;
      this.lastFrameTimestamp = 0;
      return;
    }
    // 预约下一帧继续执行自己（死循环）
    this.animationFrameHandle = requestAnimationFrame(() =>
      this.movementLoop(),
    );

    // 计算两帧之间的时间差 (Delta Time)
    const now = performance.now();
    const deltaMs = now - this.lastFrameTimestamp;
    // 理想的 60 帧每帧耗时 (16.6ms)
    const defaultDeltaMs = 1000 / 60;
    // 计算时间补偿系数 (如果遇到设备卡顿掉帧，可以补偿移动距离，最多补偿 10 倍)
    const timeFactor = Math.min(deltaMs / defaultDeltaMs, 10);
    this.lastFrameTimestamp = now;

    // 【开始挪动画布】
    const transform = this.getTransform();
    transform.x += this.cornerDirection.x * timeFactor;
    transform.y += this.cornerDirection.y * timeFactor;
    this.setTransform(transform);
    // 画布动了，赶紧通知外层工具：“你的鼠标假装动了一下，快重绘草稿线！”
    this.onRepeatEvent(this.repeatEvent);
  }

  /**
   * 计算滚动速度：越贴近屏幕边缘（或超出边缘），滚动得越快
   */
  getSpeed(thresholdDelta: number): number {
    return Math.min(thresholdDelta, this.thresholdPx) * (2 / 5);
  }

  // ----------------------------------- public -----------------------------------

  constructor(p: TCornerPanningParams) {
    this.getEaselSize = p.getEaselSize;
    this.getTransform = p.getTransform;
    this.setTransform = p.setTransform;
    this.testCanPan = p.testCanPan;
    this.onRepeatEvent = p.onRepeatEvent;
  }

  /**
   * 【主入口】：由外层的 mousemove/pointermove 事件疯狂触发
   */
  onPointer(event: TPointerEvent): void {
    let isMoving = false;
    this.cornerDirection = { x: 0, y: 0 };

    // 只有当符合“允许平移”的条件（通常是按住了鼠标左键），且当前是移动事件时
    if (
      this.testCanPan(event.button !== undefined) &&
      event.type === "pointermove"
    ) {
      // 1. 碰到【右】边缘
      if (event.relX > this.getEaselSize().width - this.thresholdPx) {
        this.cornerDirection.x -= this.getSpeed(
          event.relX - (this.getEaselSize().width - this.thresholdPx),
        );
        isMoving = true;
      }
      // 2. 碰到【左】边缘
      if (event.relX < this.thresholdPx) {
        this.cornerDirection.x += this.getSpeed(this.thresholdPx - event.relX);
        isMoving = true;
      }
      // 3. 碰到【下】边缘
      if (event.relY > this.getEaselSize().height - this.thresholdPx) {
        this.cornerDirection.y -= this.getSpeed(
          event.relY - (this.getEaselSize().height - this.thresholdPx),
        );
        isMoving = true;
      }
      // 4. 碰到【上】边缘
      if (event.relY < this.thresholdPx) {
        this.cornerDirection.y += this.getSpeed(this.thresholdPx - event.relY);
        isMoving = true;
      }
    }

    if (isMoving) {
      // 如果成功触发了边缘平移，且当前动画循环还没跑起来，就点火启动！
      if (this.lastFrameTimestamp === 0) {
        this.lastFrameTimestamp = performance.now();
      }
      this.repeatEvent = event;
      // 这里的判断虽然没写在 if 里，但在 movementLoop 内部用 animationFrameHandle 控制了不会重复启动
      this.animationFrameHandle = requestAnimationFrame(() =>
        this.movementLoop(),
      );
    } else {
      // 如果鼠标离开了 25px 的危险区，清空方向向量。
      // 下一帧 movementLoop 读到 undefined，就会自动刹车停机。
      this.cornerDirection = undefined;
    }
  }
}
