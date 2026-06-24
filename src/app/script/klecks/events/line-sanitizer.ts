import { TDrawEvent } from '../kl-types';

/**
 * 清洗（净化）绘制事件，提供更值得信赖的事件流。作为事件链 (EventChain) 的一环。
 *
 * 核心逻辑/规则：
 * 强制保证事件流的生命周期只能是： down(按下) -> 任意数量的 move(移动) -> up(抬起)
 * 举例：如果硬件发来了连续的 down, down, down，它会强制插入 up 来闭合上一笔，保证逻辑完美闭环。
 * 屏蔽那些不合逻辑的孤立 down 或 move，防止渲染引擎崩溃。
 */
/**
 * cleans up DrawEvents. More trustworthy events. EventChain element
 *
 * in some draw event?
 * out some draw event?
 *
 * that events can only go line this: down -> n x move -> up
 * so, sanitizes this: down, down, down. becomes only one down. the other downs are ignored/swallowed
 */
export class LineSanitizer {
    // 指向事件链下一环的输出函数（净化后的事件会通过它传给后面的平滑器或直接去渲染）
    private chainOut: ((drawEvent: TDrawEvent) => void) | undefined;
    // 核心状态锁：记录当前是否处于“正在绘制（已经落下画笔）”的状态
    private isDrawing: boolean = false;

    // ----------------------------------- public -----------------------------------

    chainIn(event: TDrawEvent): TDrawEvent | null {
        // --- 场景 1：收到“按下(down)”事件 ---
        if (event.type === 'down') {
            if (this.isDrawing) {

                // 【异常处理】：当前明明已经在画了（状态锁为 true），却又收到了一个 down。
                // 常见原因：上一个笔触没有正常结束（比如系统丢失了 up 事件，或者多指误触屏幕）。
                // 解决办法：人为伪造一个对应的 'up' 事件发射出去，强制闭合上一笔。
                // 注意：由于当前这个 down 并没有被 return null，所以函数最后还是会把这个 down 正常返回，
                // 从而实现“强制结束旧线条，立刻开始新线条”的无缝衔接。

                //console.log('line sanitizer - down, but already drawing');
                this.chainOut &&
                    this.chainOut({
                        type: 'up',
                        scale: event.scale,
                        shiftIsPressed: event.shiftIsPressed,
                        isCoalesced: false,
                    });
            } else {
                // 【正常逻辑】：之前没在画，现在按下了。正常开启状态锁。
                this.isDrawing = true;
            }
        }
        // --- 场景 2：收到“移动(move)”或“抬起(up)”事件，但当前根本没在画 ---
        if (!this.isDrawing && (event.type === 'move' || event.type === 'up')) {

            // 【异常处理】：画笔都没落下，哪来的移动和抬起？（比如鼠标只是悬浮移动）
            // 解决办法：直接将这个幽灵事件吞噬（返回 null），绝不让它流进渲染引擎，节省计算资源。

            //console.log('line sanitizer - ' + event.type + ' but not drawing');
            return null;
        }

        // --- 场景 3：收到“抬起(up)”事件，且当前正在画 ---
        if (event.type === 'up' && this.isDrawing) {
            // 【正常逻辑】：一笔画完了，正常关闭状态锁。
            this.isDrawing = false;
        }

        return event;
    }

    setChainOut(func: (drawEvent: TDrawEvent) => void): void {
        this.chainOut = func;
    }

    getIsDrawing(): boolean {
        return this.isDrawing;
    }
}
