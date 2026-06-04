import { dist, pointsToAngleRad } from '../../math/math';
import { TPointerEvent } from '../event.types';

// 这是输出给画布的标准化“捏合事件”数据结构
export type TPinchZoomerEvent =
    | { type: 'end' }
    | {
          type: 'move';
          // 捏合初始时的中心点 X
          downRelX: number;
          // 捏合初始时的中心点 Y
          downRelY: number;
          // 当前的中心点 X (用于计算画布平移)
          relX: number;
          // 当前的中心点 Y
          relY: number;
          // 旋转角度 (弧度)
          angleRad: number;
          // 缩放比例 (1为原始大小)
          scale: number;
      };

// 记录触摸点的结构
type TTouchPointer = {
    pointerId: number;
    relX: number;
    relY: number;
    // 只有第一个手指落下时会记录，用于判断是否移动过大导致判定失败
    downRelX?: number; // only for first
    downRelY?: number;
};

// 当前手势的整体状态机
type TPinchGesture = {
    // 真正参与缩放的触摸点 (通常是前两个)
    touchPointerArr: TTouchPointer[];
    // 鼠标、笔或第三根以上的手指，被忽略但需要记录以防干扰
    otherPointerIdArr: number[];
    // true表示已经确认是缩放手势，不再往下级传递事件
    isInProgress: boolean;
};

/**
 * A ChainElement. Detects a pinch zooming (2 touch pointers). If one finger lifts, then will use the remaining.
 * Further pointers are ignored, but their events get swallowed during the pinching.
 * pinching ends when ALL pointers are lifted.
 * Events passed through if no pinching.
 *
 * in IPointerEvent
 * out IPointerEvent
 */
export class PinchZoomer {
    // 第一根手指如果移动超过 10 像素，直接判定为画线，不再等待第二根手指
    private readonly firstFingerMaxDistancePx = 10;
    // 等待第二根手指的最长时间 (250毫秒)
    private readonly untilSecondFingerDurationMs = 250;

    private chainOut: ((e: TPointerEvent) => void) | undefined;
    private readonly pointersDownIdArr: number[] = [];
    private gestureObj: null | TPinchGesture = null;

    // 核心缓冲队列：在犹豫是不是缩放手势时，扣留事件，以免误在画布上画出黑点
    private eventQueueArr: TPointerEvent[] = [];
    private nowTime: number = performance.now();
    private readonly timeoutObj: {
        secondFingerTimeout: ReturnType<typeof setTimeout> | null;
    } = {
        secondFingerTimeout: null,
    };

    // 正在进行缩放的“捏合器”基准数据
    private pincherArr: {
        pointerId: number;
        relX: number;
        relY: number;
        downRelX: number;
        downRelY: number;
    }[] = [];
    private readonly onPinch: (e: TPinchZoomerEvent) => void;

    private end(): void {
        this.gestureObj = null;
        this.eventQueueArr = [];
    }

    // 判定失败（例如：超时了没等来第二根手指，或者第一根手指移动太远）
    private fail(doSwallow?: boolean): void {
        if (!this.gestureObj) {
            // no gesture happening -> ignore
            return;
        }

        this.timeoutObj.secondFingerTimeout && clearTimeout(this.timeoutObj.secondFingerTimeout);
        // 【关键】如果没有吞噬指令，就把刚才扣留的事件全部“吐”给下一级（让画布继续画线）
        if (!doSwallow) {
            for (let i = 0; i < this.eventQueueArr.length; i++) {
                this.chainOut && this.chainOut(this.eventQueueArr[i]);
            }
        }
        this.end();
    }

    // 设置等待第二根手指的倒计时
    private setupFailTimeout(timeMS: number): boolean {
        const diff = timeMS - this.nowTime;
        // 时间已经过了（可能系统卡顿）
        if (diff <= 0) {
            // time already up
            return false;
        }
        this.timeoutObj.secondFingerTimeout = setTimeout(() => this.fail(), diff);
        return true;
    }

    // 核心事件处理器
    private processEvent(event: TPointerEvent): void {
        if (event.type === 'pointerdown') {
            this.pointersDownIdArr.push(event.pointerId);
        } else if (event.type === 'pointerup') {
            for (let i = 0; i < this.pointersDownIdArr.length; i++) {
                if (this.pointersDownIdArr[i] === event.pointerId) {
                    this.pointersDownIdArr.splice(i, 1);
                    break;
                }
            }
        }

        //pass through scenarios
        if (
            !this.gestureObj &&
            (event.pointerType !== 'touch' || // wrong pointer type
                (event.type === 'pointermove' && this.pointersDownIdArr.length > 0) || // failed before
                this.pointersDownIdArr.length > 1 || // failed before
                event.type === 'pointerup') // failed before
        ) {
            return;
        }

        this.nowTime = performance.now();

        //pointer down
        if (event.type === 'pointerdown') {
            if (this.gestureObj) {
                if (event.pointerType === 'touch') {
                    // touch finger down - as nth pointer

                    // 第二根（或第 n 根）手指按下了
                    this.gestureObj.touchPointerArr.push({
                        pointerId: event.pointerId,
                        relX: event.relX,
                        relY: event.relY,
                    });

                    if (this.gestureObj.isInProgress) {
                        // 如果已经在缩放中又来一根手指，做一次无缝接力
                        this.continuePinch(this.gestureObj, {
                            type: 'down',
                            index: this.gestureObj.touchPointerArr.length - 1,
                        });
                    } else {
                        // 【判定成功】等到了第二根手指！取消失败倒计时，标记 isInProgress 为 true，正式开始缩放！
                        this.timeoutObj.secondFingerTimeout &&
                            clearTimeout(this.timeoutObj.secondFingerTimeout);
                        this.gestureObj.isInProgress = true;
                        this.beginPinch(this.gestureObj);
                    }
                    return;
                } else {
                    // non-touch finger down - as nth pointer

                    // 非触摸设备（鼠标/笔）在缩放时强行按下，记录或者失败
                    if (this.gestureObj.isInProgress) {
                        this.gestureObj.otherPointerIdArr.push(event.pointerId);
                    } else {
                        // second pointer wrong type -> fail
                        this.fail();
                    }
                    return;
                }
            } else {
                // 第一根手指落下，初始化状态机
                // first finger down - can only be touch if no gestureObj
                this.gestureObj = {
                    touchPointerArr: [
                        {
                            pointerId: event.pointerId,
                            relX: event.relX,
                            relY: event.relY,
                            downRelX: event.relX,
                            downRelY: event.relY,
                        },
                    ],
                    otherPointerIdArr: [],
                    isInProgress: false, // 此时还在犹豫，不算正式开始
                };

                // 开启 250ms 的定时炸弹，等第二根手指
                if (!this.setupFailTimeout(event.time + this.untilSecondFingerDurationMs)) {
                    // time ran out -> fail
                    this.fail();
                    return;
                }
                return;
            }
        }

        // should not happen. something went wrong
        if (!this.gestureObj) {
            // throw? would make it less robust
            this.fail();
            return;
        }

        //pointer move
        if (event.type === 'pointermove' && event.pointerType === 'touch') {
            //gesture object should always exist here

            let touchPointerObj: TTouchPointer | null = null;
            let i = 0;
            for (; i < this.gestureObj.touchPointerArr.length; i++) {
                if (event.pointerId === this.gestureObj.touchPointerArr[i].pointerId) {
                    touchPointerObj = this.gestureObj.touchPointerArr[i];
                    break;
                }
            }

            //null should not be possible. something went wrong
            if (!touchPointerObj) {
                // throw? would make it less robust
                this.fail();
                return;
            }

            touchPointerObj.relX = event.relX;
            touchPointerObj.relY = event.relY;

            if (!this.gestureObj.isInProgress) {
                // only one finger down & pinching hasn't started

                // should not happen. something went wrong
                if (
                    !('downRelX' in touchPointerObj && touchPointerObj.downRelX !== undefined) ||
                    !('downRelY' in touchPointerObj && touchPointerObj.downRelY !== undefined)
                ) {
                    this.fail();
                    return;
                }

                // 还在等待第二根手指时，第一根手指动了
                const distance = dist(
                    touchPointerObj.downRelX,
                    touchPointerObj.downRelY,
                    touchPointerObj.relX,
                    touchPointerObj.relY,
                );
                // 只要移动超过 10 像素，说明用户其实是想单指画画或拖拽，立刻放弃双指判定
                if (distance > this.firstFingerMaxDistancePx) {
                    // moved too much -> fail
                    this.fail();
                    return;
                }
            } else {
                if (i < 2) {
                    // 缩放进行中，只认前两根手指
                    // only first two touches can affect pinching
                    this.continuePinch(this.gestureObj, {
                        type: 'move',
                        index: i,
                    });
                }
            }

            return;
        }

        //pointer up
        if (event.type === 'pointerup') {
            //gesture object should always exist here

            if (event.pointerType === 'touch') {
                let i = 0;
                for (; i < this.gestureObj.touchPointerArr.length; i++) {
                    if (this.gestureObj.touchPointerArr[i].pointerId === event.pointerId) {
                        this.gestureObj.touchPointerArr.splice(i, 1);
                        break;
                    }
                }
                if (this.gestureObj.touchPointerArr.length > 0) {
                    this.continuePinch(this.gestureObj, {
                        type: 'up',
                        index: i,
                    });
                }
            } else {
                // non-touch
                for (let i = 0; i < this.gestureObj.otherPointerIdArr.length; i++) {
                    if (this.gestureObj.otherPointerIdArr[i] === event.pointerId) {
                        this.gestureObj.otherPointerIdArr.splice(i, 1);
                        break;
                    }
                }
            }

            // 如果所有手指都抬起了
            //all fingers lifted?
            if (
                this.gestureObj.touchPointerArr.length === 0 &&
                this.gestureObj.otherPointerIdArr.length === 0
            ) {
                if (this.gestureObj.isInProgress) {
                    // 正常结束缩放
                    // lifted last finger -> end of pinching
                    this.end();
                    this.endPinch();
                } else {
                    // 第二根手指还没来，第一根手指就抬起了，判定为普通的点击/画线
                    // lifted finger again before pinching started -> fail
                    this.fail();
                }
                return;
            }
        }
    }

    private beginPinch(gestureObj: TPinchGesture): void {
        // 遍历当前真正参与缩放的手指（touchPointerArr），把它们的信息同步到专门用于缩放计算的 pincherArr 中。
        for (let i = 0; i < gestureObj.touchPointerArr.length; i++) {
            const pointerObj = gestureObj.touchPointerArr[i];
            this.pincherArr.push({
                pointerId: pointerObj.pointerId,
                // 当前位置的X/Y
                relX: pointerObj.relX,
                relY: pointerObj.relY,
                // 【关键】将当前位置作为“初始按下位置 (downRelX/Y)”锁死！
                downRelX: pointerObj.relX,
                // 这是后续计算相对平移、缩放和旋转的绝对锚点。
                downRelY: pointerObj.relY,
            });
        }

        // 注意：这里的 type 是 'move' 而不是 'begin'。
        // 因为对于下层的画布相机来说，所谓的“开始缩放”，其实就是一个缩放比例为 1、旋转角度为 0 的移动事件。
        const event: TPinchZoomerEvent = {
            type: 'move',

            // temp
            downRelX: 0,
            downRelY: 0,
            relX: 0,
            relY: 0,

            // 【关键基准】初始状态下，没有任何旋转，也没有任何缩放
            angleRad: 0,
            scale: 1,
        };

        // 根据当前屏幕上的手指数量，计算它们组合在一起的“中心点”
        if (this.pincherArr.length === 1) {
            // 场景 A：只有一根手指（比如双指操作时抬起了一根，触发了重新 beginPinch）
            // 此时没有缩放，中心点就是这唯一一根手指的坐标
            event.relX = this.pincherArr[0].downRelX;
            event.relY = this.pincherArr[0].downRelY;
        } else {
            // 场景 B：有两根（或多根）手指
            // 取前两根手指的 X 坐标和 Y 坐标的【平均值】（中点公式：(x1+x2)/2 ）
            // 这个中点，就是我们捏合/展开时的“视觉中心”，画布的平移将跟随这个中心点移动
            event.relX = 0.5 * (this.pincherArr[0].downRelX + this.pincherArr[1].downRelX);
            event.relY = 0.5 * (this.pincherArr[0].downRelY + this.pincherArr[1].downRelY);
        }

        // 在初始这一帧，当前的中心点 (relX/Y) 就是初始的中心点 (downRelX/Y)
        event.downRelX = event.relX;
        event.downRelY = event.relY;

        // 把这个基础的“零状态”事件发送给下级。
        // 下级拿到 scale: 1, angle: 0，并且发现 relX == downRelX，就知道：“哦！这是一个新捏合手势的起点！”
        this.onPinch(event);
    }

    // 核心几何计算：当手指移动时
    //actionObj = {type: 'down'|'move'|'up', index: number}
    private continuePinch(
        gestureObj: TPinchGesture,
        actionObj: {
            type: 'down' | 'move' | 'up';
            index: number;
        },
    ): void {
        // 只关心前两个控制点
        if (actionObj.index > 1) {
            // only first two pointers matter
            return;
        }

        if (actionObj.type === 'move') {
            let event: TPinchZoomerEvent;
            // 更新坐标
            this.pincherArr[actionObj.index].relX =
                gestureObj.touchPointerArr[actionObj.index].relX;
            this.pincherArr[actionObj.index].relY =
                gestureObj.touchPointerArr[actionObj.index].relY;

            if (this.pincherArr.length === 1) {
                // 只有一根手指时，只有平移，没有缩放和旋转
                event = {
                    type: 'move',
                    downRelX: this.pincherArr[0].downRelX,
                    downRelY: this.pincherArr[0].downRelY,
                    relX: this.pincherArr[0].relX,
                    relY: this.pincherArr[0].relY,
                    angleRad: 0,
                    scale: 1,
                };
            } else {

                // 1. 计算初始距离 和 当前距离
                const startDist = dist(
                    this.pincherArr[0].downRelX,
                    this.pincherArr[0].downRelY,
                    this.pincherArr[1].downRelX,
                    this.pincherArr[1].downRelY,
                );
                const distance = dist(
                    this.pincherArr[0].relX,
                    this.pincherArr[0].relY,
                    this.pincherArr[1].relX,
                    this.pincherArr[1].relY,
                );

                // 2. 计算初始角度 和 当前角度
                const startAngle = pointsToAngleRad(
                    {
                        x: this.pincherArr[0].downRelX,
                        y: this.pincherArr[0].downRelY,
                    },
                    {
                        x: this.pincherArr[1].downRelX,
                        y: this.pincherArr[1].downRelY,
                    },
                );
                const angle = pointsToAngleRad(
                    {
                        x: this.pincherArr[0].relX,
                        y: this.pincherArr[0].relY,
                    },
                    { x: this.pincherArr[1].relX, y: this.pincherArr[1].relY },
                );

                event = {
                    type: 'move',
                    // 取两指连线的中点作为“平移中心基准”
                    downRelX: 0.5 * (this.pincherArr[0].downRelX + this.pincherArr[1].downRelX),
                    downRelY: 0.5 * (this.pincherArr[0].downRelY + this.pincherArr[1].downRelY),
                    // 取两指当前中点作为“当前中心点”
                    relX: 0.5 * (this.pincherArr[0].relX + this.pincherArr[1].relX),
                    relY: 0.5 * (this.pincherArr[0].relY + this.pincherArr[1].relY),
                    // 角度差 = 旋转了多少度
                    angleRad: angle - startAngle,
                    // 距离比 = 缩放了多少倍 (如当前距离是初始距离2倍，则scale为2)
                    scale: distance / startDist,
                };
            }

            // 发送计算好的缩放事件
            this.onPinch(event);
        } else if (actionObj.type === 'down' || actionObj.type === 'up') {
            // 如果手指数量变化（比如松开了一根），立刻重置基准点（downRelX/Y），防止画面剧烈跳动
            this.endPinch();
            this.beginPinch(gestureObj);
        }
    }

    private endPinch(): void {
        this.pincherArr = [];
        this.onPinch({
            type: 'end',
        });
    }

    // ----------------------------------- public -----------------------------------
    constructor(p: { onPinch: (e: TPinchZoomerEvent) => void }) {
        this.onPinch = p.onPinch;
    }

    // 事件流入口
    chainIn(event: TPointerEvent): TPointerEvent | null {
        this.processEvent(event);
        if (this.gestureObj) {
            if (!this.gestureObj.isInProgress) {
                // might still fail -> into queue
                this.eventQueueArr.push(event);
            }
        } else {
            return event;
        }
        return null;
    }

    setChainOut(func: (e: TPointerEvent) => void): void {
        this.chainOut = func;
    }
}
