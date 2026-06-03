import { TChainElement, TChainOutFunc } from "./event-chain.types";
import { TPointerEvent } from "../event.types";

/**
 * 核心架构类：事件责任链
 * 作用：将多个独立的手势处理器（如双指撤销、双击复位、单指限流）串联成一条流水线。
 * 每个元素都可以对事件进行：暂存(扣押)、吞噬(熔断)、转换或直接放行。
 */
/**
 * for chaining event processing. useful for gestures (double tap, pinch zoom, max pointer filter).
 * each element in the chain might hold back the events, swallow them, transform them, or create new ones
 */
export class EventChain {
  // 内部维护的处理器阵列（即关卡链）
  private readonly chainArr: TChainElement[];
  // 流水线最终的输出出口（通常流向画笔或画布实际响应层）
  private chainOut: TChainOutFunc | undefined;

  /**
   * 核心推进器：从指定的关卡索引 i 开始，让事件继续向后流动
   * @param i 当前从哪一个关卡开始
   * @param event 要处理的指针事件
   */
  private continueChain(i: number, event: TPointerEvent): null {
    // 从索引 i 开始，依次调用后续每一个处理器的 chainIn 方法
    for (; i < this.chainArr.length; i++) {
      // 将事件喂给当前关卡，并获取它的返回值
      event = this.chainArr[i].chainIn(event);
      // 【关键熔断点】：如果某一个关卡返回了 null
      // 说明该事件被当前关卡“吞噬”了（比如成功识别了手势）或者被“暂存”了
      // 流水线立刻中断，不再向后传递
      if (event === null) {
        return null;
      }
    }
    // 如果事件顺利通过了所有人格测试（没有任何一关返回 null）
    // 那么调用终点出口，把干净的事件送给真正的业务逻辑（比如画笔线段渲染）
    this.chainOut && this.chainOut(event);
    return null;
  }

  // ----------------------------------- public -----------------------------------
  constructor(p: { chainArr: TChainElement[] }) {
    this.chainArr = p.chainArr;

    // 【最优雅的设计】：动态织入（Weaving）下一关的推进逻辑
    for (let i = 0; i < this.chainArr.length; i++) {
      // 这里原作者使用了一个 IIFE（立即执行函数表达式）来锁定当前的索引 i
      // 防止异步或延迟回调中闭包引用的 i 发生错乱（虽然现在用 let 已经有块级作用域，但原作者保留了最稳健的写法）
      ((i) => {
        this.chainArr[i].setChainOut((event: TPointerEvent) => {
          // 为第 i 个处理器设置它的“出口”
          // 当第 i 个处理器内部决定“释放被扣押的事件”并调用 chainOut 时
          // 会自发自动地触发 continueChain(i + 1, event)！
          // 这完美解决了“手势失败后，人质事件如何继续安全向后传递”的架构难题！
          this.continueChain(i + 1, event);
        });
      })(i);
    }
  }

  // 外部唯一入口：将原生的 PointerEvent 喂进这条责任链
  /**
   * feed an event into the chain
   */
  chainIn(event: TPointerEvent): null {
    return this.continueChain(0, event);
  }

  // 设置责任链走完之后的终点回调
  /**
   * func will be called when event has passed through the chain
   */
  setChainOut(func: TChainOutFunc): void {
    this.chainOut = func;
  }
}
