import { BB } from '../../bb/bb';
import { TDrawEvent, TDrawMoveEvent } from '../kl-types';

/**
 * 画笔防抖（线条平滑）处理器。作为事件链 (EventChain) 的一环。
 * 平滑算法原理：将最新输入的物理坐标与上一次渲染的坐标按比例进行混合（插值）。
 */
/**
 * Line smoothing. EventChain element. Smoothing via blending new position with old position.
 * for onDraw events from KlCanvasWorkspace.
 *
 * in some draw event
 * out some draw event
 *
 * type: 'line' Events are just passed through.
 */
export class LineSmoothing {
    // 指向事件链的下一个节点。处理完平滑后的坐标，通过调用这个函数传给画布去画
    private chainOut: ((drawEvent: TDrawEvent) => void) | undefined;
    // 平滑度：0 到 1 之间。0 表示完全不平滑（原生鼠标轨迹），1 表示 100% 平滑（笔触将永远停在原地不动）
    private smoothing: number;
    // 记录上一次"混合后"的真实笔触坐标和压感（也就是橡皮筋被拖拽的尾端）
    private lastMixedInput:
        | {
              x: number;
              y: number;
              pressure: number;
          }
        | undefined;
    // 用于实现"停顿追赶"机制的定时器
    private interval: ReturnType<typeof setInterval> | undefined;
    private timeout: ReturnType<typeof setTimeout> | undefined;

    // ----------------------------------- public -----------------------------------
    constructor(p: {
        smoothing: number; // 0-1, 0: no smoothing, 1: 100% smoothing -> would never catch up
    }) {
        // 限制平滑度必须在 0-1 之间
        this.smoothing = BB.clamp(p.smoothing, 0, 1);
    }

    // 接收原始的物理输入事件
    chainIn(event: TDrawEvent): TDrawEvent | null {
        event = BB.copyObj(event);
        // 【关键】只要有真实的物理移动，就立刻打断之前的"自动追赶"动作
        clearTimeout(this.timeout);
        clearInterval(this.interval);

        // 1. 落笔的瞬间 (Pointer Down)
        if (event.type === 'down') {
            // 落笔的第一点不需要平滑，直接记录为初始锚点
            this.lastMixedInput = {
                x: event.x,
                y: event.y,
                pressure: event.pressure,
            };
        }

        // 2. 拖拽移动中 (Pointer Move)
        if (event.type === 'move') {
            // 暂存真实的物理鼠标位置，一会儿追赶时要用到
            const inputX = event.x;
            const inputY = event.y;
            const inputPressure = event.pressure;

            // ! 核心平滑算法：混合 (mix) 用于手抖修正实现线条平滑
            /**
             * ! 代码中 new_X = real_X * (1 - S) + old_X * S（S为平滑度，假设为 0.8）
             * ! 这相当于你的手（real_X）和笔尖（new_X）之间，连上了一根极具弹性的橡皮筋。
             * ! 当你的手因为手抖突然往旁边偏了 10 个像素时，笔尖并不会立刻瞬移 10 个像素，而是只往那个方向移动了 2 个像素（20%），剩下的 8 个像素（80%）依然被上一个位置“拉”着。
             * ! 这种混合算法本质上是让历史轨迹“稀释”了当前瞬间的剧烈位移。它过滤掉了手部的高频抖动（突刺），只保留了整体运动的低频趋势（宏观走向），所以线条在视觉上就被“扯圆润”了。
             */
            // 新坐标 = 真实输入坐标 * (1 - 平滑度) + 历史混合坐标 * 平滑度
            event.x = BB.mix(event.x, this.lastMixedInput!.x, this.smoothing);
            event.y = BB.mix(event.y, this.lastMixedInput!.y, this.smoothing);
            event.pressure = BB.mix(event.pressure, this.lastMixedInput!.pressure, this.smoothing);
            // 更新锚点，供下一次 move 事件计算使用
            this.lastMixedInput = {
                x: event.x,
                y: event.y,
                pressure: event.pressure,
            };

            // 3. 停顿追赶逻辑 (如果开启了平滑)
            // ! 为了填补“算法必然带来的视觉滞后”与“人类预期”之间的巨大鸿沟。
            // ! 笔尖在快速移动时，算法导致的延迟会使得实际笔触必然慢于指针位置，所以需要一个“追赶”机制。
            // ! 如果没用追赶机制，当在快速移动指针急停时，由于没用move事件，滞后的笔触也会停止。
            if (this.smoothing > 0) {
                // 如果用户鼠标停住不动超过 80ms (没有触发新的 real move 打断这个 timeout)
                this.timeout = setTimeout(() => {
                    // 启动一个循环，每 35ms 执行一次
                    this.interval = setInterval(() => {
                        event = JSON.parse(JSON.stringify(event)) as TDrawMoveEvent;

                        // 让笔触继续向着"最后一次真实的物理鼠标位置 (inputX/Y)"进行插值逼近
                        event.x = BB.mix(inputX, this.lastMixedInput!.x, this.smoothing);
                        event.y = BB.mix(inputY, this.lastMixedInput!.y, this.smoothing);
                        event.pressure = BB.mix(
                            inputPressure,
                            this.lastMixedInput!.pressure,
                            this.smoothing,
                        );
                        this.lastMixedInput = {
                            x: event.x,
                            y: event.y,
                            pressure: event.pressure,
                        };

                        // 主动把伪造的追赶事件发射给画布去渲染
                        this.chainOut?.(event);
                    }, 35);
                }, 80);
            }
        }

        return event;
    }

    setChainOut(func: (drawEvent: TDrawEvent) => void): void {
        this.chainOut = func;
    }

    setSmoothing(s: number): void {
        this.smoothing = BB.clamp(s, 0, 1);
    }
}
