import { THistoryEntry, THistoryEntryData, THistoryEntryDataComposed } from './history.types';
import { composeHistoryStateData } from './compose-history-state-data';
import { estimateBytes } from './estimate-bytes';
import { entryCausesChange } from './entry-causes-change';
import { getTotalMemoryBytes, trimOldestEntries } from './trim-oldest-entries';

// -------------------------------------------------------------------------
// 作者的 Todo 留言很有意思：目前 push 的时候，是把新记录先加进来再去计算是否超内存。
// 理论上最好先清理旧内存再加新记录，防止在添加的那一瞬间内存溢出（OOM）。
// -------------------------------------------------------------------------
/*
todo memory could be better limited.
When pushing, all entries and the new entry are in memory which already exceeds the limit.
You can potentially be 268.44 MB over the memory limit.
The new entry should only be created after freeing up some space in entries.
 */

// tied to indexed db. don't change.
export const HISTORY_TILE_SIZE = 256;

export type TKlHistoryListener = () => void;

export type TKlHistoryParams = {
    // 初始状态（比如一张白纸，或者刚导入的图片）
    oldest: THistoryEntryDataComposed;
};

const HISTORY_DEBUGGING = false;

export class KlHistory {
    // ------------------- 核心状态机 -------------------
    // entries 里存的不是“每一步的完整画面”，而是“Diff（差异）”。0 是最老的初始状态。
    private entries: THistoryEntry[]; // diffs or what changed each step. 0 is oldest
    // index 是一个游标（指针）。指向当前用户处在历史记录的哪一步。
    // 按 Undo，index 就减1；按 Redo，index 就加1。
    private index: number = 0; // current action the user is on.
    // composed 是“合成后的最终状态”。
    // 因为 entries 里存的只是 Diff，所以系统需要把 entries[0] 到 entries[index] 
    // 的所有 Diff 叠加起来，算出当前画面到底长什么样，存在 composed 里供外部图层读取。
    private composed: THistoryEntryDataComposed; // all diffs until current action combined

    // 一共进行过多少次物理记录
    private totalActions: number = 0;
    // 只要发生变化（画线、撤销、重做）就递增，用于触发 UI 刷新
    private changeCount: number = 0; // number keeps incrementing with each change (push, undo, redo)

    // pauseStack (暂停栈)：用于把多个底层操作合并成一个“宏动作”。
    private pauseStack: number = 0; // how often paused without unpause. push does nothing when paused.
    private readonly listeners: TKlHistoryListener[] = []; // broadcasts on undo, redo, push

    // 广播变化，通知外部 UI (比如工具栏上的撤销按钮) 更新状态
    private broadcast(): void {
        this.changeCount++;
        // 巧妙的 setTimeout 宏任务：
        // 让广播在当前事件循环结束之后再执行，防止外部 UI 复杂的重绘逻辑卡住当前的画笔渲染进程
        setTimeout(() => {
            for (let i = 0; i < this.listeners.length; i++) {
                // ! 这里执行外部回调
                this.listeners[i]();
            }
        });
    }

    // 核心计算逻辑：把从开头到当前 index 的所有差异补丁（Diff）叠加在一起
    private updateComposed(): void {
        this.composed = composeHistoryStateData(
            this.entries.slice(0, this.index + 1).map((item) => item.data),
        );
    }

    // ----------------------------------- public -----------------------------------
    constructor(p: TKlHistoryParams) {
        // 初始化时，把最老的“初始白纸状态”作为第一条记录（Index 0）
        this.entries = [
            {
                timestamp: new Date().getTime(),
                memoryEstimateBytes: estimateBytes(p.oldest),
                data: p.oldest,
            },
        ];
        this.composed = p.oldest;
        if (HISTORY_DEBUGGING) {
            (window as any).getHistoryEntries = () => this.entries;
        }
    }

    /**
     * 【极其经典的架构设计：暂停栈宏指令】
     * 为什么需要这个？
     * 假设有个功能叫“合并所有图层”。在底层，它可能是：1.新建图层 2.把图层A画进去 3.把图层B画进去 4.删除AB。
     * 如果不暂停历史记录，这会被记成 4 步！用户按 Undo 要按 4 次才能撤销！
     * 用法：开始前 pause(true)，这四步产生的 push 会被忽略；结束后 pause(false)，自己把最终画面作为一个大 Diff push 进去。
     */
    /**
     * Needed, because sometimes there are actions that would cause other undo steps.
     * For example a filter that does something with two layers and then merges them.
     * That should be a single undo step, and prevent merging from creating its own undo step.
     * Pause prevents creation of unintended undo steps.
     */
    pause(b: boolean): void {
        // 为什么用数字 ++/-- 而不是布尔值 true/false？
        // 因为可能出现嵌套！比如 函数A(调用pause) 内部又调用了 函数B(也调用pause)。
        // 只有当所有的 pause 都被解除（变成0）时，才真正恢复记录。
        if (b) {
            this.pauseStack++;
        } else {
            this.pauseStack = Math.max(0, this.pauseStack - 1);
        }
    }

 
    /**
     * listens to changes - on undo, redo, push
     */
    addListener(l: TKlHistoryListener): void {
        this.listeners.push(l);
    }

    /**
     * 把新的“脏瓦片 / Diff”推入历史栈 (比如画完一笔之后触发)
     * @param replaceTop 是否替换栈顶（用于滑块拖拽的实时预览，不希望产生几百个撤销步骤）
     */
    // doesn't push if: paused or if entry is empty
    push(entryData: THistoryEntryData, replaceTop?: boolean): void {
        // 如果处于暂停状态，直接拦截，什么都不记录
        if (this.pauseStack > 0) {
            return;
        }
        // 如果数据是空的（比如鼠标点下去又原地松开，什么瓦片都没弄脏），不记录
        if (Object.keys(entryData).length === 0) {
            // no change -> noop
            return;
        }

        const entry: THistoryEntry = {
            timestamp: new Date().getTime(),
            memoryEstimateBytes: estimateBytes(entryData),
            data: entryData,
        };

        if (replaceTop && this.index > 0) {
            // 【覆盖模式】：撤销一步，把新的覆盖上去
            this.index--;
            // remove current top
            while (this.index < this.entries.length - 1) {
                this.entries.pop();
            }
            // 检查覆盖后的新状态是不是和老状态一模一样（比如图层眼睛关了又立刻打开）
            // it's possible that new entry replacing top is same to composed history
            // e.g. toggle layer visibility twice
            const isDifferent = entryCausesChange(
                entryData,
                composeHistoryStateData(
                    this.entries.slice(0, this.index + 1).map((item) => item.data),
                ),
            );
            // only need to push if it's different
            isDifferent && this.entries.push(entry);
        } else {
            // 【标准增加模式】: 
            // 这是一个经典的“平行宇宙毁灭”逻辑：
            // 假设你画了A,B,C。然后你撤销到了A (index 指向 A)。
            // 如果你此时画了一个新的D，那么之前被撤销的 B,C 所谓的“未来(Redo历史)”就会被全部摧毁（pop 掉）。
            // 历史将变成 A -> D。
            while (this.index < this.entries.length - 1) {
                this.entries.pop();
            }
            this.entries.push(entry);
        }

        // 【内存守护神】：检查内存是否超标（比如超过了 200MB 的历史限制）
        // 如果超标，就从数组最前面（entries[0]）切掉最老的记录。用户将无法一直撤销到最开头。
        this.entries = trimOldestEntries(this.entries);
        if (HISTORY_DEBUGGING) {
            const totalBytes = getTotalMemoryBytes(this.entries);
            console.log(
                `[KlHistory] pushed ${(entry.memoryEstimateBytes / 1e6).toFixed(1)} MB — total: ${(totalBytes / 1e6).toFixed(1)} MB (${this.entries.length} entries)`,
            );
        }
        this.totalActions++;
        // 游标移到最后
        this.index = this.entries.length - 1;
        // 重新合成当前画面
        this.updateComposed();
        this.broadcast();
    }

    // 重做 (Redo) 比如快捷键 Ctrl + Y
    increaseIndex(): THistoryEntry {
        if (this.canRedo()) {
            this.index++;
        }
        this.updateComposed();
        this.broadcast();
        return this.entries[this.index];
    }

    // 撤销 (Undo) 比如快捷键 Ctrl + Z
    decreaseIndex(): THistoryEntry {
        if (this.canUndo()) {
            this.index--;
        }
        this.updateComposed();
        this.broadcast();
        return this.entries[this.index];
    }

    // 是否可以撤销（如果 index === 0 说明到头了，不能撤销）
    canUndo(): boolean {
        return this.index > 0;
    }

    canRedo(): boolean {
        return this.index < this.entries.length - 1;
    }

    getEntries(): THistoryEntry[] {
        return this.entries.slice(0, this.index + 1);
    }

    // 获取当前画面的最终状态
    getComposed(): THistoryEntryDataComposed {
        console.log('getComposed', this.composed); // debug
        return this.composed;
    }

    getChangeCount(): number {
        return this.changeCount;
    }

    getTotalIndex(): number {
        return this.totalActions;
    }

    isPaused(): boolean {
        return this.pauseStack > 0;
    }
}
