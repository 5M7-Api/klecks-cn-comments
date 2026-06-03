import { dist } from '../../math/math';
import { TPointerEvent } from '../event.types';

/**
 * A ChainElement. Detects a single tap with N 'touch' pointers
 *
 * in IPointerEvent
 * out IPointerEvent
 */
export class NFingerTapper {
    // 触发前必须有 50ms 的静默期
    private readonly minSilenceBeforeDurationMs = 50;
    // 整个敲击动作必须在 500ms 内完成
    private readonly maxTapMs = 500;
    // 第一根和最后一根手指落下的时间差限额
    private readonly maxFirstLastFingerDownMs = 250;
    // 手指滑动不超过 12 像素才算“敲击”
    private readonly maxPressedDistancePx = 12; //5 + fingers * 5;

    private chainOut: ((e: TPointerEvent) => void) | undefined;
    // 追踪正在屏幕上的手指状态
    private fingerArr: {
        pointerId: number;
        downTimeMs: number;
        downPageX: number;
        downPageY: number;
        isUp?: boolean;
    }[] = [];

    // 当系统还没确定这到底是不是“双指撤销”时，把所有事件先扣留在这里！
    private eventQueueArr: TPointerEvent[] = [];
    private firstDownTime: number = 0;
    private lastEventTime: number = 0;
    private nowTime: number = performance.now();
    private readonly pointersDownIdArr: number[] = [];
    private readonly fingers: number;
    private readonly onTap: () => void;

    // 计时器对象
    private readonly timeoutObj: {
        firstLastDownTimeout: ReturnType<typeof setTimeout> | null;
        tapTimeout: ReturnType<typeof setTimeout> | null;
    } = {
        firstLastDownTimeout: null,
        tapTimeout: null,
    };

    // ⛔ 手势判定失败 (比如指头滑动了，或者超时了)
    private failGesture(): void {
        if (this.eventQueueArr.length === 0) {
            return;
        }

        // 1. 清理定时器
        this.timeoutObj.firstLastDownTimeout && clearTimeout(this.timeoutObj.firstLastDownTimeout);
        this.timeoutObj.tapTimeout && clearTimeout(this.timeoutObj.tapTimeout);

        // 2. 既然不是敲击手势，就把之前扣留的事件，原封不动地全部释放给下一个责任链！
        for (let i = 0; i < this.eventQueueArr.length; i++) {
            this.chainOut && this.chainOut(this.eventQueueArr[i]);
        }

        // 3. 重置状态
        this.eventQueueArr = [];
        this.fingerArr = [];
    }

    // ✅ 手势判定成功 (确实是多指轻敲！)
    private success(): void {
        this.timeoutObj.firstLastDownTimeout && clearTimeout(this.timeoutObj.firstLastDownTimeout);
        this.timeoutObj.tapTimeout && clearTimeout(this.timeoutObj.tapTimeout);

        // 直接清空人质营！底层画笔引擎永远不会知道发生了这几个触摸事件
        this.eventQueueArr = []; // events get swallowed
        this.fingerArr = [];

        // 触发撤销/重做回调！
        this.onTap();
    }

    // 设置定时器的工具函数，返回 false 代表定时器已经过期了
    private setupTimeout(
        timeoutStr: 'firstLastDownTimeout' | 'tapTimeout',
        timeMS: number,
    ): boolean {
        const diff = timeMS - this.nowTime;
        //console.log(fingers + ': ' + timeoutStr + ' diff', diff);
        if (diff <= 0) {
            // time already up
            return false;
        }
        this.timeoutObj[timeoutStr] = setTimeout(() => this.failGesture(), diff);
        return true;
    }

    private processEvent(event: TPointerEvent): true | void {
        const tempLastEventTime = this.lastEventTime;
        this.lastEventTime = event.time;

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

        // 核心过滤 1：如果不是 touch（比如是鼠标或手写笔），且当前已经在判定敲击了 -> 直接失败
        if (event.pointerType !== 'touch') {
            if (this.fingerArr.length > 0) {
                // already in gesture -> fail
                this.failGesture();
            }
            return;
        }

        this.nowTime = performance.now();

        // ============【按下逻辑】============
        if (event.type === 'pointerdown') {
            //console.log('down');

            // 核心过滤 2：手指数量过多、超时等防御性判断...
            if (this.fingerArr.length + 1 !== this.pointersDownIdArr.length) {
                // failed before, and some fingers are still down -> fail
                this.failGesture();
                return;
            }
            if (this.fingerArr.length === this.fingers) {
                // too many fingers down -> fail
                //console.log(fingers + ': too many fingers down -> fail');
                this.failGesture();
                return;
            }
            if (
                this.fingerArr.length > 0 &&
                event.time - this.maxFirstLastFingerDownMs > this.fingerArr[0].downTimeMs
            ) {
                // took too long to touch with all fingers -> fail
                //console.log(fingers + ': took too long to touch with all fingers -> fail');
                this.failGesture();
                return;
            }
            if (
                this.fingerArr.length === 0 &&
                event.time - this.minSilenceBeforeDurationMs < tempLastEventTime
            ) {
                // not enough silence before -> fail
                //console.log(fingers + ': not enough silence before -> fail');
                this.failGesture();
                return;
            }

              // 如果这是第一根按下的手指，启动倒计时炸弹！
            if (this.fingerArr.length === 0) {
                this.firstDownTime = event.time;
                // 如果在规定时间内没按下第二根手指，或者总时间超时，触发 failGesture
                if (
                    !this.setupTimeout(
                        'firstLastDownTimeout',
                        event.time + this.maxFirstLastFingerDownMs,
                    ) ||
                    !this.setupTimeout('tapTimeout', event.time + this.maxTapMs)
                ) {
                    // timeouts already up -> fail
                    this.failGesture();
                    return;
                }
            }
            // 记录手指初始坐标
            this.fingerArr.push({
                pointerId: event.pointerId,
                downTimeMs: event.time,
                downPageX: event.pageX,
                downPageY: event.pageY,
            });
            return;
        }

        // ============【移动逻辑】============
        if (event.type === 'pointermove') {
            if (this.fingerArr.length === 0) {
                //not in a gesture -> ignore
                return;
            }

            // 寻找当前手指的初始记录...
            let fingerObj = null;
            for (let i = 0; i < this.fingerArr.length; i++) {
                if (this.fingerArr[i].pointerId === event.pointerId) {
                    fingerObj = this.fingerArr[i];
                    break;
                }
            }
            if (fingerObj === null) {
                // finger not part of the tap is on screen -> fail
                this.failGesture();
                return;
            }

            if (event.time - this.maxTapMs > this.firstDownTime) {
                // tap took too long -> fail
                //console.log(fingers + ': tap took too long -> fail');
                this.failGesture();
                return;
            }

            // 核心过滤 3：计算欧氏距离，超过 12px 判定为滑动，立刻失败！
            const distance = dist(
                event.pageX,
                event.pageY,
                fingerObj.downPageX,
                fingerObj.downPageY,
            );
            if (distance > this.maxPressedDistancePx) {
                // finger moved too much -> fail
                //console.log(fingers + ': a finger moved too much -> fail', distance);
                this.failGesture();
                return;
            }
        }

        // ============【抬起逻辑】============
        if (event.type === 'pointerup') {
            if (this.fingerArr.length === 0) {
                //not in a gesture -> ignore
                return;
            }

            //console.log('up', event.pageX, event.pageY);
            // 核心过滤 4：如果在指头还没凑齐（比如要求3指，现在才2指）时就抬起了 -> 失败
            if (this.fingerArr.length !== this.fingers) {
                // not enough fingers -> fail
                //console.log(fingers + ': not enough fingers -> fail');
                this.failGesture();
                return;
            }

            let fingerObj = null;
            let i = 0;
            for (; i < this.fingerArr.length; i++) {
                if (this.fingerArr[i].pointerId === event.pointerId) {
                    fingerObj = this.fingerArr[i];
                    break;
                }
            }
            if (fingerObj === null) {
                //do nothing
                return;
            }

            if (event.time - this.maxTapMs > this.firstDownTime) {
                // tap took too long -> fail
                //console.log(fingers + ': tap took too long -> fail');
                this.failGesture();
                return;
            }

            const distance = dist(
                event.pageX,
                event.pageY,
                fingerObj.downPageX,
                fingerObj.downPageY,
            );
            if (distance > this.maxPressedDistancePx) {
                // finger moved too much -> fail
                //console.log(fingers + ': b finger moved too much -> fail', distance, event.pageX, event.pageY);
                //console.log(fingerArr);
                this.failGesture();
                return;
            }

            // 标记这根手指已抬起
            fingerObj.isUp = true;

            // 检查是不是所有参与的手指都抬起了
            let allAreUp = true;
            for (let i = 0; i < this.fingerArr.length; i++) {
                if (!this.fingerArr[i].isUp) {
                    allAreUp = false;
                    break;
                }
            }
            //console.log('fingerArr', fingerArr);

            // 如果全部抬起，且没有触发任何 fail 条件 -> 判定为一次完美的轻敲！
            if (allAreUp) {
                // success
                this.success();
                return true;
            }
        }
    }

    // ----------------------------------- public -----------------------------------
    constructor(p: { fingers: number; onTap: () => void }) {
        this.fingers = p.fingers;
        this.onTap = p.onTap;
    }

    // 接口实现：接收上游事件
    chainIn(event: TPointerEvent): TPointerEvent | null {
        const result = this.processEvent(event);

        //console.log(fingerArr.length);

        if (result === true) {
            //tap success -> event gets swallowed
            return null; // 成功识别！吞噬事件
        }
        if (this.fingerArr.length === 0) {
            return event; // 不在识别周期内，直接放行给底层
        } else {
            this.eventQueueArr.push(event);// 正在识别中！把事件关进人质营扣留
        }

        return null;
    }

    setChainOut(func: (e: TPointerEvent) => void): void {
        this.chainOut = func;
    }
}
