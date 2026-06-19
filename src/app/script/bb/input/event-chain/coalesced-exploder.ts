import { TPointerEvent } from "../event.types";
import { copyObj } from "../../base/base";

// 扩展标准的指针事件，增加一个极其关键的标记：isCoalesced（是否为被隐藏的历史合并事件）
export type TCoalescedPointerEvent = TPointerEvent & {
  isCoalesced: boolean;
};

/**
 * ! 这个类决定了为什么笔刷能够画高频率的连续点
 * 【事件链条处理单元】：CoalescedExploder (合并事件炸药包/解包器)
 * 作用：拦截浏览器打包好的粗糙事件，将其“炸开（拆分）”成多个高精度的独立 pointermove 事件。
 * 其他无关事件（如 pointerdown, pointerup）则直接放行。
 */
/**
 * A ChainElement. Splits up coalesced events into their own pointermove events. Otherwise regular pass through.
 *
 * in: IPointerEvent
 * out: IPointerEvent with property isCoalesced: boolean
 *
 * todo: eventPreventDefault and eventStopPropagation are broken events w coalesced events. (because of json parse json stringify)
 * but how could that even work?
 */
export class CoalescedExploder {
  // 指向事件链条下一个处理函数的指针（在上一问中，它指向了 EaselBrush 的 onExplodedPointer）
  private chainOut: ((e: TCoalescedPointerEvent) => void) | undefined;

  // ----------------------------------- public -----------------------------------

  setChainOut(func: (e: TCoalescedPointerEvent) => void) {
    this.chainOut = func;
  }

  chainIn(event: TPointerEvent): TPointerEvent | null {
    // 1. 只有鼠标/笔尖“移动”时，才会产生高频合并事件，所以只拦截 pointermove
    if (event.type === "pointermove") {
      // 2. 检查浏览器是否在这一个事件里，偷偷“打包”了多个底层硬件捕捉到的微小移动点
      if (event.coalescedArr && event.coalescedArr.length > 0) {
        // 3. 开始“拆快递”！遍历所有被隐藏的微小历史点
        for (let i = 0; i < event.coalescedArr.length; i++) {
          // 深拷贝原始事件（因为我们要为每一个微小点伪造一个独立的合法事件）
          const eventCopy: TCoalescedPointerEvent = copyObj(
            event,
          ) as TCoalescedPointerEvent;

          // 清空拷贝对象里的合并数组，防止后续处理逻辑陷入死循环或内存泄漏
          if (i === 0) {
            eventCopy.coalescedArr = [];
          }

          const coalescedItem = event.coalescedArr[i];

          // ? 这里深拷贝实际上不合法的，且拷贝了所有内容，可能采用扁平化代码：
          // 【图形学最佳实践】：手动按需组装（极速分配内存）
          // 不要去复制整个庞大的原生事件，只挑出后端画笔真正需要的核心字段！
          //   const eventCopy: TCoalescedPointerEvent = {
          //     ...event,
          //     // 1. 继承基础属性（浅拷贝）
          //     type: event.type,
          //     button: event.button,
          //     pointerType: event.pointerType,
          //     pressure: event.pressure,

          //     // 2. 覆盖为高精度坐标
          //     pageX: coalescedItem.pageX,
          //     pageY: coalescedItem.pageY,
          //     relX: coalescedItem.relX,
          //     relY: coalescedItem.relY,
          //     dX: coalescedItem.dX,
          //     dY: coalescedItem.dY,
          //     time: coalescedItem.time,

          //     // 3. 附加解包特有属性
          //     isCoalesced: i < event.coalescedArr.length - 1,
          //     coalescedArr: [], // 保证干净
          //   } as TCoalescedPointerEvent;

          // 4. 【偷天换日】：用底层硬件的超高精度坐标，替换掉原本粗糙的坐标
          eventCopy.pageX = coalescedItem.pageX;
          eventCopy.pageY = coalescedItem.pageY;
          eventCopy.relX = coalescedItem.relX;
          eventCopy.relY = coalescedItem.relY;
          eventCopy.dX = coalescedItem.dX;
          eventCopy.dY = coalescedItem.dY;
          // 甚至连发生的时间戳都精确替换
          eventCopy.time = coalescedItem.time;
          // 5. 【极其天才的性能标记】
          // 如果这不是数组里的最后一个点，说明它是一个“历史过渡点”，标记 isCoalesced 为 true。
          // 如果是最后一个点，说明它就是当前鼠标真正停留的位置，标记为 false。
          eventCopy.isCoalesced = i < event.coalescedArr.length - 1;

          // 6. 将伪造好的、高精度的独立事件，挨个发射给后方的画笔工具
          this.chainOut && this.chainOut(eventCopy);
        }
      } else {
        // 如果浏览器没有打包合并事件（比如鼠标走得很慢），直接原样放行
        return event;
      }
    } else {
      // 如果是按下、抬起等其他事件，直接原样放行
      return event;
    }

    // 返回 null 代表这个原始的“大事件”已经被我彻底销毁（炸开成 N 个小事件发送出去了），
    // 外部的主循环不需要再管它了。
    return null;
  }
}

// ? 下面是性能重构的代码
// export class CoalescedExploder {
//   // 指向事件链条下一个处理函数的指针（在上一问中，它指向了 EaselBrush 的 onExplodedPointer）
//   private chainOut: ((e: TCoalescedPointerEvent) => void) | undefined;

//   // ----------------------------------- public -----------------------------------

//   setChainOut(func: (e: TCoalescedPointerEvent) => void) {
//     this.chainOut = func;
//   }

//   chainIn(event: TPointerEvent): TPointerEvent | null {
//     if (event.type === "pointermove") {
//       if (event.coalescedArr && event.coalescedArr.length > 0) {
//         for (let i = 0; i < event.coalescedArr.length; i++) {
//           const coalescedItem = event.coalescedArr[i];

//           // 【终极重构版】：利用对象展开 (Spread) + 局部覆盖
//           // 1. ...event 进行极速浅拷贝，继承所有基础属性（解决 TS 报错）
//           // 2. 直接在下面覆盖高精度坐标
//           const eventCopy: TCoalescedPointerEvent = {
//             ...event,

//             // 覆盖高精度坐标与时间
//             pageX: coalescedItem.pageX,
//             pageY: coalescedItem.pageY,
//             relX: coalescedItem.relX,
//             relY: coalescedItem.relY,
//             dX: coalescedItem.dX,
//             dY: coalescedItem.dY,
//             time: coalescedItem.time,

//             // 如果压感不存在，退回使用主事件的压感
//             pressure: event.pressure,

//             // 附加特有属性
//             isCoalesced: i < event.coalescedArr.length - 1,
//             coalescedArr: [], // 清空数组，断开引用，保持干净
//           };

//           // 发射高精度伪造事件
//           this.chainOut && this.chainOut(eventCopy);
//         }
//       } else {
//         return event;
//       }
//     } else {
//       return event;
//     }

//     return null;
//   }
// }
