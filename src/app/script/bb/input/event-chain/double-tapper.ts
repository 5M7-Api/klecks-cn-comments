import { TChainOutFunc } from './event-chain.types';
import { dist } from '../../math/math';
import { TPointerButton, TPointerEvent, TPointerType } from '../event.types';

export type TDoubleTapperEvent = {
    pageX: number;
    pageY: number;
    relX: number;
    relY: number;
};

// 状态机的三种计时器类型：失败重置、等待第二次点击、成功后静默
type TDoubleTapperTimeoutType = 'fail' | 'maxUntilSecondDown' | 'success';

/**
 * 解决 touch / mouse / pen 的多次点击的整合事件，消除额外的点击事件干扰，整合成一个双击事件。
 */
/**
 * A ChainElement. Detects double taps.
 *
 * in IPointerEvent
 * out IPointerEvent
 */
export class DoubleTapper {
    private readonly onDoubleTap: (e: TDoubleTapperEvent) => void;
    private chainOut: TChainOutFunc | undefined;

    // 【可自定义项】：默认只允许左键。若想支持中键，需外部调用 setAllowedButtonArr
    private allowedPointerTypeArr: TPointerType[] = ['touch', 'mouse', 'pen'];
    private allowedButtonArr: TPointerButton[] = ['left'];

    // 【容错阈值】：这是手感的核心，可以根据你的 Tauri App 使用场景进行微调
    // 动作前必须静默 400ms
    private readonly minSilenceBeforeDurationMs: number = 400;
    // 点击按下到抬起时长不超过 300ms
    private maxPressedDurationMs: number = 300;
    // 动作内手指滑移不超过 10px
    private maxPressedDistancePx: number = 10;
    // 两次点击之间的最大距离
    private maxInbetweenDistancePx: number = 19;
    // 两次抬起之间的最大间隔
    private maxUpToUpDurationMs: number = 500;
    // 等待第二次按下的最长时间
    private maxUntilSecondDownDurationMs: number = 300;
    // 成功后必须静默 250ms，防止三连击
    private readonly minSilenceAfterMs: number = 250;

    // 【事件队列】：记录点击序列 (isDown/isUp/Position)
    private sequenceArr: (
        | {
              isDown: boolean;
              time: number;
              position: [number, number];
              pointerId: number;
          }
        | {
              isUp: boolean;
              time: number;
              position: [number, number];
          }
        | {
              pageX: number;
              pageY: number;
              relX: number;
              relY: number;
          }
    )[] = [];
    private pointersDownIdArr: number[] = [];
    private lastUpTime: number = 0;
    private nowTime: number = 0;

    // 【人质营】：扣留事件的地方
    private eventQueueArr: TPointerEvent[] = [];
    private timeoutObj: {
        [K in TDoubleTapperTimeoutType]: ReturnType<typeof setTimeout> | null;
    } = {
        fail: null,
        maxUntilSecondDown: null,
        success: null,
    };
    private readonly gestureFailed: () => void;

    // ✅ 手势识别成功：触发业务逻辑并清空队列
    // double tap achieved
    private success(): void {
        // 成功后清空队列数据
        this.timeoutObj.fail = null;
        this.timeoutObj.success = null;
        this.eventQueueArr = []; // events get swallowed
        const lastSequenceItem = this.sequenceArr[this.sequenceArr.length - 1];
        this.sequenceArr = [];

        if ('pageX' in lastSequenceItem) {
            this.onDoubleTap({
                pageX: lastSequenceItem.pageX,
                pageY: lastSequenceItem.pageY,
                relX: lastSequenceItem.relX,
                relY: lastSequenceItem.relY,
            });
        }
    }

    // 计时器辅助：计算剩余时间差，若超时则直接返回 false
    // returns false if time already up. otherwise sets up timeout
    private setupTimeout(
        timeoutStr: TDoubleTapperTimeoutType,
        targetFunc: () => void,
        timeMS: number,
        noComparison?: boolean,
    ): boolean {
        const diff = timeMS - this.nowTime;
        // console.log(fingers + ': ' + timeoutStr + ' diff', diff);
        if (diff <= 0 && !noComparison) {
            // time already up
            return false;
        }
        this.timeoutObj[timeoutStr] = setTimeout(targetFunc, Math.max(0, diff));
        return true;
    }

    // 【核心逻辑】：处理每一个输入的指针事件
    /**
     * @param event object - a pointer event from BB.PointerListener
     */
    private processEvent(event: TPointerEvent): void {
        // 1. 更新指针追踪数组 (pointersDownIdArr)
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

        // 2. 类型过滤：如果类型不在允许列表 (如触摸/鼠标)，直接失败并释放人质
        if (!this.allowedPointerTypeArr.includes(event.pointerType)) {
            //wrong input type -> fail
            //console.log('wrong input type -> fail');
            this.gestureFailed();
            return;
        }

        this.nowTime = performance.now();
        const lastSequenceItem =
            this.sequenceArr.length > 0 ? this.sequenceArr[this.sequenceArr.length - 1] : null;
        if (event.type === 'pointerup') {
            this.lastUpTime = event.time;
        }

        // 3. 处理按下 (PointerDown)
        if (event.type === 'pointerdown') {
            // 防御：如果是多指同时按下，不是双击，直接 Fail
            if (this.pointersDownIdArr.length > 1) {
                // more than one pointer down -> fail
                //console.log('more than one pointer down -> fail');
                this.gestureFailed();
                return;
            }
            if (this.timeoutObj.success !== null) {
                // silence-after not achieved -> fail
                //console.log('silence-after not achieved -> fail');
                this.gestureFailed();
                return;
            }
            // 校验：检查前一次动作结束后的静默期
            if (
                this.sequenceArr.length === 0 &&
                this.nowTime - this.lastUpTime < this.minSilenceBeforeDurationMs
            ) {
                // silence before not achieved -> fail
                //console.log('silence before not achieved -> fail');
                this.gestureFailed();
                return;
            }
            // 校验：按钮类型 (比如过滤掉右键)
            if (event.button && !this.allowedButtonArr.includes(event.button)) {
                // wrong button -> fail
                //console.log('wrong button -> fail', event.button, allowedButtonArr);
                this.gestureFailed();
                return;
            }
            if (
                (lastSequenceItem && 'isDown' in lastSequenceItem && lastSequenceItem.isDown) ||
                this.sequenceArr.length > 2
            ) {
                // jumbled -> fail
                //console.log('jumbled -> fail');
                this.gestureFailed();
                return;
            }
            if (lastSequenceItem && 'position' in lastSequenceItem) {
                const distance = dist(
                    lastSequenceItem.position[0],
                    lastSequenceItem.position[1],
                    event.pageX,
                    event.pageY,
                );
                if (distance > this.maxInbetweenDistancePx) {
                    //moved too much -> reset
                    //console.log('maxInbetweenDistancePx -> reset');
                    this.gestureFailed();

                    if (
                        'time' in lastSequenceItem &&
                        this.nowTime - lastSequenceItem.time < this.minSilenceBeforeDurationMs
                    ) {
                        //silence before not achieved -> fail
                        return;
                    }
                }
            }

            // 记录当前按下动作
            this.sequenceArr.push({
                isDown: true,
                time: this.nowTime,
                position: [event.pageX, event.pageY],
                pointerId: event.pointerId,
            });
            //maxUntilSecondDown

            // 启动定时器：必须在规定时间内完成下一次点击
            if (this.sequenceArr.length > 1) {
                this.timeoutObj.maxUntilSecondDown &&
                    clearTimeout(this.timeoutObj.maxUntilSecondDown);
            } else if (
                !this.setupTimeout(
                    'maxUntilSecondDown',
                    () => this.gestureFailed(),
                    event.time + this.maxUntilSecondDownDurationMs,
                )
            ) {
                //console.log('event.time + maxPressedDurationMs -> fail');
                this.gestureFailed();
                return;
            }

            this.timeoutObj.fail && clearTimeout(this.timeoutObj.fail);
            if (
                !this.setupTimeout(
                    'fail',
                    () => this.gestureFailed(),
                    event.time + this.maxPressedDurationMs,
                )
            ) {
                //console.log('event.time + maxPressedDurationMs -> fail');
                this.gestureFailed();
                return;
            }
        }

        // 4. 处理移动 (PointerMove)
        if (
            lastSequenceItem &&
            event.type === 'pointermove' &&
            'pointerId' in lastSequenceItem &&
            lastSequenceItem.pointerId === event.pointerId
        ) {
            /*if (lastSequenceItem.pointerId !== event.pointerId) { //another pointer mixing in -> fail
                console.log('another pointer mixing in -> fail');
                this.fail();
                return;
            }*/
            const distance = dist(
                lastSequenceItem.position[0],
                lastSequenceItem.position[1],
                event.pageX,
                event.pageY,
            );
            if (distance > this.maxPressedDistancePx) {
                //moved too much -> fail
                //console.log('maxPressedDistancePx -> fail');
                this.gestureFailed();
                return;
            }
        }

        // 5. 处理抬起 (PointerUp)
        if (lastSequenceItem && event.type === 'pointerup') {
            if ('pointerId' in lastSequenceItem && lastSequenceItem.pointerId !== event.pointerId) {
                //another pointer mixing in -> fail
                this.gestureFailed();
                return;
            }
            if (
                'time' in lastSequenceItem &&
                this.nowTime >= lastSequenceItem.time + this.maxPressedDurationMs
            ) {
                //pressed too long -> fail
                this.gestureFailed();
                return;
            }
            this.timeoutObj.fail && clearTimeout(this.timeoutObj.fail);

            if (this.sequenceArr.length < 3) {
                if (
                    !this.setupTimeout(
                        'fail',
                        () => this.gestureFailed(),
                        event.time + this.maxUpToUpDurationMs,
                    )
                ) {
                    this.gestureFailed();
                    return;
                }

                this.sequenceArr = [
                    lastSequenceItem,
                    {
                        isUp: true,
                        time: this.nowTime,
                        position: [event.pageX, event.pageY],
                    },
                ];
                return;
            }

            if (
                'time' in this.sequenceArr[1] &&
                this.nowTime < this.sequenceArr[1].time + this.maxUpToUpDurationMs
            ) {
                // double tap almost success
                // only needs silence
                this.sequenceArr.push({
                    pageX: event.pageX,
                    pageY: event.pageY,
                    relX: event.relX,
                    relY: event.relY,
                });
                if (
                    !this.setupTimeout(
                        'success',
                        () => this.success(),
                        event.time + this.minSilenceAfterMs,
                        true,
                    )
                ) {
                    this.gestureFailed();
                }
            } else {
                // time up -> fail
                this.gestureFailed();
            }
        }
    }

    // ----------------------------------- public -----------------------------------
    constructor(p: {
        onDoubleTap: (e: TDoubleTapperEvent) => void; // fires when double tap occurs
        isInstant?: boolean;
    }) {
        // 1. 注入回调函数：将外部的逻辑（重置视图等）绑定进来
        this.onDoubleTap = p.onDoubleTap;

        // 2. 瞬时模式开关 (isInstant)：
        // 在绘图场景中，通常不需要开启。如果你开启了，它会将静默阈值设为 0。
        // 这意味着系统不会去检查“上一次动作是否刚结束”，这对交互的灵敏度有极大影响。
        if (p.isInstant) {
            this.minSilenceBeforeDurationMs = 0;
            this.minSilenceAfterMs = 0;
        }

        // 3. 定义 gestureFailed (闭包陷阱的优雅处理)：
        // 这是该类最核心的“垃圾回收与释放”逻辑。
        this.gestureFailed = () => {
            // 如果序列为空，说明没发生过点击，直接忽略，避免空操作
            if (this.sequenceArr.length === 0) {
                // no gesture started -> can be ignored
                return;
            }

            // 清空所有悬挂计时器防止内存泄漏
            this.timeoutObj.fail && clearTimeout(this.timeoutObj.fail);
            this.timeoutObj.maxUntilSecondDown && clearTimeout(this.timeoutObj.maxUntilSecondDown);
            this.timeoutObj.success && clearTimeout(this.timeoutObj.success);
            this.timeoutObj.fail = null;
            this.timeoutObj.maxUntilSecondDown = null;
            this.timeoutObj.success = null;

            // 【事件释放机制】(释放人质)：
            // 如果双击判定失败，必须将 eventQueueArr 里的所有原始事件“返还”给 chainOut。
            // 否则，你刚才的那一次点击就相当于“凭空消失”了，用户会觉得“点了一下没反应”。
            if (this.chainOut) {
                for (let i = 0; i < this.eventQueueArr.length; i++) {
                    this.chainOut(this.eventQueueArr[i]);
                }
            }

            // 清空人质营，状态归零
            this.eventQueueArr = [];
            this.sequenceArr = [];
        };
    }

    chainIn(event: TPointerEvent): TPointerEvent | null {
        this.processEvent(event);

        if (this.sequenceArr.length === 0) {
            //existing events can not become a double tap
            this.gestureFailed();
            return event;
        }
        // events might become a double tap -> queue
        this.eventQueueArr.push(event);
        return null;
    }

    setChainOut(func: TChainOutFunc): void {
        this.chainOut = func;
    }

    setAllowedPointerTypeArr(arr: TPointerType[]): void {
        this.allowedPointerTypeArr = [...arr];
    }

    setAllowedButtonArr(arr: TPointerButton[]): void {
        this.allowedButtonArr = [...arr];
    }
}
