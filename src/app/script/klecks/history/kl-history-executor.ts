import { KlHistory } from './kl-history';
import { KlTempHistory } from './kl-temp-history';

// 历史操作执行结果类型：涵盖了主栈的 undo/redo 与 临时栈的 tempUndo/tempRedo
export type THistoryExecutionType = 'undo' | 'redo' | 'tempUndo' | 'tempRedo';

export type TKlHistoryExecutionResult = {
    type: THistoryExecutionType;
};

export type TKlHistoryExecutorParams = {
    klHistory: KlHistory;
    tempHistory: KlTempHistory;
    // 顶栏/菜单“撤销/重做”按钮可用状态（置灰/点亮）的广播回调
    onCanUndoRedoChange: (canUndo: boolean, canRedo: boolean) => void;
};

/**
 * 【历史记录执行调度总线 (History Executor Hub)】
 * 统筹全局历史记录 (klHistory) 与临时历史记录 (tempHistory) 的撤销与重做。
 * 外界（如快捷键、点击事件）调用时，彻底屏蔽了“双层栈”的底层逻辑，只需无脑调 `undo()` 和 `redo()`！
 */
/**
 * performs undo/redo in klHistory and tempHistory
 */
export class KlHistoryExecutor {
    // from params
    private readonly klHistory: KlHistory;
    private readonly tempHistory: KlTempHistory;
    private readonly onCanUndoRedoChange: (canUndo: boolean, canRedo: boolean) => void;

    // 【连击防抖锁 (Debounce Lock / Throttle Flag)】
    private doIgnore = false;
    // 缓存上一次广播的状态，用于避免 UI 重复执行无用重绘
    private lastCanUndo = false;
    private lastCanRedo = false;

    /**
     * 【极品 UX 与性能保护：防止由于 UI 顿卡导致的连击爆炸】
     * 场景：用户在一张 8000x8000 的超大高清图上按下 Ctrl+Z，由于显存差量重绘需要消耗几百毫秒，
     * UI 可能会出现短暂的僵死或掉帧。用户以为刚才没按上，于是狂按了鼠标或键盘 5 次！
     * 如果没有这个拦截，系统会瞬间积压 5 个沉重的撤销请求，导致整个浏览器进程彻底崩溃！
     * 
     * @returns true = 当前处于锁定期，必须跳过！ false = 放行
     */
    /**
     * If UI is frozen while pressing undo/redo, the user might click multiple times
     * because they think the click wasn't registered.
     * This test prevents multiple undo/redo at once.
     * true = skip
     */
    private testShouldSkip(): boolean {
        if (this.doIgnore) {
            // 正在处理上一个撤销/重做，直接强行拦截！
            return true; 
        }
        this.doIgnore = true;
        // 把锁定的解除推迟到下一个事件循环（Event Loop Tick）
        // 保证当前调用栈及其引发的 DOM 渲染任务处理完毕后，再允许接收下一次键盘按键
        setTimeout(() => {
            this.doIgnore = false;
        }, 0);
        return false;
    }

    /**
     * 【动态合并判断：当前到底能否撤销？】
     */
    private canUndo(): boolean {
        return (
            // A. 如果临时栈正处于“激活/接管”状态，且临时栈里有得撤，返回 true
            (this.tempHistory.getIsActive() && this.tempHistory.canDecreaseIndex()) ||
            // B. 或者全局大历史栈里还能撤销，返回 true
            this.klHistory.canUndo()
        );
    }

    /**
     * 【动态合并判断：当前到底能否重做？】
     */
    private canRedo(): boolean {
        // 【关键逻辑差异！】重做的判断与撤销有极强的互斥性！
        if (this.tempHistory.getIsActive()) {
            // 一旦进入了临时交互模式（如自由变换），重做按钮【绝对不允许】去重做全局主栈里的东西！
            // 只能在该临时栈内部尝试前进。如果临时栈到头了，就直接返回 false！
            return this.tempHistory.canIncreaseIndex();
        }
        return this.klHistory.canRedo();
    }

    // ----------------------------------- public -----------------------------------
    constructor(p: TKlHistoryExecutorParams) {
        this.klHistory = p.klHistory;
        this.tempHistory = p.tempHistory;
        this.onCanUndoRedoChange = p.onCanUndoRedoChange;

        /**
         * 【状态监听与合并映射器】
         * 无论底层的 `klHistory` 还是 `tempHistory` 发生了变化，都会触发这里
         */
        const emitCanUndoRedo = () => {
            const canUndo = this.canUndo();
            const canRedo = this.canRedo();
            // 【极客脏检查 (Dirty Check / Memoization)】：
            // 如果计算出的“能否撤销/能否重做”跟上一瞬间的旧状态一模一样，
            // 绝对不要向外界 UI 广播！省去顶栏按钮没必要的 DOM 类名变更与重排开销！
            if (this.lastCanUndo === canUndo && this.lastCanRedo === canRedo) {
                return;
            }
            this.lastCanUndo = canUndo;
            this.lastCanRedo = canRedo;
            this.onCanUndoRedoChange(canUndo, canRedo);
        };

        // 把合并计算器同时挂载到主历史和临时历史的广播频道上！
        this.klHistory.addListener(emitCanUndoRedo);
        this.tempHistory.addListener(emitCanUndoRedo);
    }

    /**
     * 【向外统一暴露的撤销命令 (Undo Hub)】
     * @returns undefined 表示现在既不能撤也无法退；否则返回具体执行了哪种类型的撤销
     */
    // returns undefined if it can't undo
    undo(): undefined | TKlHistoryExecutionResult {
        // 1. 连击防抖过滤
        if (this.testShouldSkip()) {
            return undefined;
        }
        // 2. 【第一道分流门 (First Router Priority)】：临时历史栈优先！
        // 如果当前处于“自由变换”等临时状态中，且在自由变换模式下用户有做过拉伸操作，
        // 那么键盘的 Ctrl+Z 必定首先用来向后回退用户的变形操作！
        if (this.tempHistory.getIsActive() && this.tempHistory.canDecreaseIndex()) {
            this.tempHistory.decreaseIndex();
            return {
                // 明确告诉调用方：这次只撤了临时步骤，别去刷新全屏画布！
                type: 'tempUndo',
            };
        }
        // 3. 【第二道分流门】：如果已经退出了临时模式，或者在临时模式下其实没做任何变形，
        // 再去看看全局历史栈是否到头了。
        if (!this.klHistory.canUndo()) {
            return undefined;
        }
        // 4. 执行真正的全局大显存回滚！
        this.klHistory.decreaseIndex();

        return {
            type: 'undo',
        };
    }

    /**
     * 【向外统一暴露的重做命令 (Redo Hub)】
     */
    // returns undefined if it can't redo
    redo(): undefined | TKlHistoryExecutionResult {
        if (this.testShouldSkip()) {
            return undefined;
        }
        // 【第一道分流门】：同样严格由临时历史接管！
        if (this.tempHistory.getIsActive() && this.tempHistory.canIncreaseIndex()) {
            this.tempHistory.increaseIndex();
            return {
                type: 'tempRedo',
            };
        }
        if (!this.klHistory.canRedo()) {
            return undefined;
        }
        this.klHistory.increaseIndex();

        return {
            type: 'redo',
        };
    }
}
