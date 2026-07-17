export type TTempHistoryEntry = {
    type: string;
    data: unknown;
};

export type TTempHistoryEventType = 'push' | 'decrease' | 'increase' | 'clear' | 'active';
export type TTempHistoryListener = (type: TTempHistoryEventType) => void;

/**
 * 【临时历史记录栈 (Temporary History Stack)】
 * 专门用于记录那些处于“未敲定/交互中”的暂态操作。
 * 例如：通过选区进行的自由变换 (Free Transform)、多边形套索的点位确立、磁性选取的中间路径等。
 * 这些中间步骤最终只有两种命运：要么被【一次性打包提交 (Commit)】进主历史记录栈 (KlHistory)，
 * 要么被直接【全量销毁丢弃 (Discard)】。
 */
// TODO：这个类似乎没用？sai2的自由变换无法撤回重做交互。但套索可以撤回重做交互。
/**
 * History of temporary actions that will either be committed (to KlHistory) or discarded.
 * E.g. transform via selection
 */
export class KlTempHistory {
    // 存储临时操作快照的私有数组
    private entries: TTempHistoryEntry[] = [];
    // 当前游标指针（-1 表示栈为空，没有任何临时操作）
    private currentIndex: number = -1;
    // 观察者回调列表
    private listeners: TTempHistoryListener[] = [];
    // 当前临时栈是否处于激活状态（告诉顶栏 UI，现在的 Ctrl+Z 应该由我接管！）
    private isActive: boolean = false;

    /**
     * 【事件广播中心】
     * 向所有订阅者（如选区工具、顶栏重做撤销按钮状态机）广播栈的状态变更
     */
    private emit(type: TTempHistoryEventType) {
        this.listeners.forEach((item) => item(type));
    }

    // ----------------------------------- public -----------------------------------

    constructor() {}

    /**
     * 【压入新节点 (Push Entry)】
     * 当你在“自由变换”模式下拖动了一个角点，或者在“多边形套索”下点击了一个新顶点时触发
     */
    push(entry: TTempHistoryEntry): void {
        // 【时间线剪枝 (Timeline Truncation)】：
        // 如果你正在经历“按过几次 Ctrl+Z 退到了中间某一步”的状态，此时你一旦做了一个【新】动作，
        // 那么原有游标前方那些“未被重做的平行宇宙未来 (Redo Timeline)”必须被全部斩断清除！
        while (this.currentIndex < this.entries.length - 1) {
            this.entries.pop();
        }
        this.entries.push(entry);
        this.currentIndex = this.entries.length - 1;
        // 【异步微任务广播 (Asynchronous Emitting Hack)】：
        // 为什么一定要把 emit 塞进 setTimeout(..., 0) 里？
        // 这是为了让 JS 引擎将“事件广播”推迟到下一个事件循环（Event Loop Tick）执行！
        // 确保调用 push() 的业务函数能把当前的同步逻辑完全走完、状态彻底固化后，
        // 外部 UI 监听器再去读取界面，完美防止在复杂的 DOM 操作中产生竞态条件 (Race Condition) 或循环触发！
        setTimeout(() => this.emit('push'));
    }

    /**
     * 【高频覆盖顶层节点 (Replace Top)】
     * 这是高频鼠标拖动（如通过选区手柄连续拖曳缩放图像、滑块连续滑动）时的性能救星！
     * 不在历史记录里疯狂新增节点，而是直接替换掉当前最顶端的那一条记录。
     */
    replaceTop(newEntry: TTempHistoryEntry): void {
        // 剪掉当前游标及之后的元素
        this.entries.splice(this.currentIndex);
        // 压入最新的拖动位置
        this.entries.push(newEntry);
        this.currentIndex = this.entries.length - 1;
        setTimeout(() => this.emit('push'));
    }

    /**
     * 判断当前栈里是否还能往下撤销（只要游标 > 0 说明前面还有中间步骤）
     */
    canDecreaseIndex(): boolean {
        return this.currentIndex > 0;
    }

    /**
     * 判断当前栈里是否还能往前重做（只要游标还没到数组最后一位）
     */
    canIncreaseIndex(): boolean {
        return this.currentIndex < this.entries.length - 1;
    }

    // 临时撤销栈
    /** aka undo */
    decreaseIndex(): void {
        if (!this.canDecreaseIndex()) {
            return;
        }
        this.currentIndex--;
        setTimeout(() => this.emit('decrease'));
    }

    // 临时重做栈
    /** aka redo */
    increaseIndex(): void {
        if (!this.canIncreaseIndex()) {
            return;
        }
        this.currentIndex++;
        setTimeout(() => this.emit('increase'));
    }

    /**
     * 【获取有效操作时间线】
     * 仅仅截取并返回从第 0 步到当前游标 (currentIndex) 的所有步骤。
     * 当工具（如选区渲染器）需要重新计算显示画面时，它只需要遍历执行这部分有效步骤！
     */
    /**
     * all entries up to currentIndex
     */
    getEntries(): TTempHistoryEntry[] {
        return this.entries.slice(0, this.currentIndex + 1);
    }

    /**
     * 【彻底清空记忆】
     * 当用户敲下 Enter 确认了自由变换（提交到全局历史），或者敲下 Esc 放弃了变换（直接丢弃）时调用
     */
    clear(): void {
        this.entries = [];
        this.currentIndex = -1;
        setTimeout(() => this.emit('clear'));
    }

    /**
     * emits on push, decrease, increase, clear, or toggle active
     */
    addListener(listener: TTempHistoryListener): void {
        if (this.listeners.includes(listener)) {
            return;
        }
        this.listeners.push(listener);
    }

    removeListener(listener: TTempHistoryListener): void {
        // （注：作者这里用 .map 代替 .forEach 来做遍历切除是一种小习惯，底层思想是找到指针并 splice 移除）
        this.listeners.map((item, index) => {
            if (item === listener) {
                this.listeners.splice(index, 1);
            }
        });
    }

    /**
     * 【接管控制权 (Toggle Active State)】
     * 这是一个极为关键的开关！一旦调用 setIsActive(true)，
     * 整个应用就知道：现在用户进入了“临时交互模式”，所有的 Ctrl+Z 和顶栏撤销按钮，
     * 必须优先转发给这套 KlTempHistory，而不是那个全局大显存的 KlHistory！
     */
    setIsActive(isActive: boolean): void {
        if (this.isActive === isActive) {
            return;
        }
        this.isActive = isActive;
        this.emit('active');
    }

    getIsActive(): boolean {
        return this.isActive;
    }
}
