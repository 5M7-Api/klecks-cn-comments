import { TChainOutFunc } from './event-chain.types';
import { TPointerEvent } from '../event.types';

// ! 这个类是用来防止误触的，只允许同一时间有一个指针传递事件，防止误触（比如手掌边缘）
/**
 * only lets through events from one pointer at a time.
 *
 * in IPointerEvent
 * out IPointerEvent
 */
export class OnePointerLimiter {
    private chainOut: TChainOutFunc | undefined;

    // 【核心状态 1】当前正独占画布的“主指针”ID。如果为 null，说明当前没有指针按下
    private downPointerId: number | null = null;

    // 【核心状态 2】黑名单。用来记录那些在“主指针”工作期间，不小心按到屏幕上的“入侵指针”ID
    private readonly ignorePointerIdArr: number[] = [];

    // ----------------------------------- public -----------------------------------
    chainIn(event: TPointerEvent): TPointerEvent | null {
        // 如果当前事件的指针 ID 已经在黑名单里了，直接无视它
        if (this.ignorePointerIdArr.includes(event.pointerId)) {
            // 特殊情况：如果这个被拉黑的指针抬起了（pointerup），说明它离开了屏幕，我们需要把它从黑名单里释放
            if (event.type === 'pointerup') {
                for (let i = 0; i < this.ignorePointerIdArr.length; i++) {
                    if (this.ignorePointerIdArr[i] === event.pointerId) {
                        this.ignorePointerIdArr.splice(i, 1);
                        break;
                    }
                }
            }
            // 只要在黑名单里，它的任何 move、up 事件都休想传给下游画布，直接返回 null 拦截
            return null;
        }

        if (this.downPointerId === null) {
            // --- 未锁定状态
            // 如果此时来了一个按下事件（pointerdown），说明新一轮的绘画/点击开始了
            if (event.type === 'pointerdown') {
                this.downPointerId = event.pointerId;
            }
            // 注意：如果不是 pointerdown（比如鼠标只是在画布上悬浮晃动 pointermove），这里也会直接放行。
            // 这确保了原生的“悬停悬浮”逻辑不会被破坏。
            return event;
        } else {
            // --- 上锁状态
            // 情况 A：来的事件【不属于】当前的主指针（属于外来入侵者）
            if (event.pointerId !== this.downPointerId) {
                // 如果此时来了一个按下事件（pointerdown），说明新一轮的绘画/点击开始了
                if (event.type === 'pointerdown') {
                    this.ignorePointerIdArr.push(event.pointerId);
                }
                // 无条件拦截入侵者的任何事件
                return null;
            }
            // 情况 B：来的事件【就是】当前正在画画的主指针
            // 如果主指针抬起了（pointerup），说明这一笔画完了，释放独占锁
            if (event.type === 'pointerup') {
                this.downPointerId = null;
            }
            // 允许主指针的事件（move, up）通过，传给下游去画线
            return event;
        }
    }

    setChainOut(func: TChainOutFunc): void {
        this.chainOut = func;
    }
}
