import { NFingerTapper } from '../../../bb/input/event-chain/n-finger-tapper';
import { DoubleTapper, TDoubleTapperEvent } from '../../../bb/input/event-chain/double-tapper';
import { PinchZoomer, TPinchZoomerEvent } from '../../../bb/input/event-chain/pinch-zoomer';
import { BB } from '../../../bb/bb';
import { EventChain } from '../../../bb/input/event-chain/event-chain';
import { TChainElement } from '../../../bb/input/event-chain/event-chain.types';
import { TPointerEvent, TPointerType } from '../../../bb/input/event.types';

export type TEaselPointerPreprocessor = {
    onChainOut: (e: TPointerEvent) => void;
    onDoubleTap: (e: TDoubleTapperEvent) => void;
    onUndo?: () => void;
    onRedo?: () => void;
    onPinch: (e: TPinchZoomerEvent) => void;
};

/**
 * 核心功能：让指针事件穿过一条“责任链 (Event Chain)”。
 * 这条链会按顺序检查双指敲击、捏合等高级手势，
 * 并将它们消化掉，最后通过 Limiter 过滤出唯一的作画指针。
 */
/**
 * lets pointer events go through an event chain,
 * which checks for double tapping and other gestures,
 * then filters to a single pointer
 */
export class EaselPointerPreprocessor {
    // 责任链管理器，维护所有的手势拦截器
    private readonly pointerEventChain: EventChain;

    // 具体的拦截器实例
    private readonly twoFingerTap: NFingerTapper | undefined;
    private readonly threeFingerTap: NFingerTapper | undefined;
    private readonly mainDoubleTapper: DoubleTapper;
    private readonly middleDoubleTapper: DoubleTapper;
    private readonly pinchZoomer: PinchZoomer;

    // ----------------------------------- public -----------------------------------
    constructor(p: TEaselPointerPreprocessor) {
        const nFingerSubChain: TChainElement[] = [];

        // 1. 组装“两指轻敲 -> 撤销(Undo)”拦截器 (致敬 Procreate)
        if (p.onUndo) {
            this.twoFingerTap = new BB.NFingerTapper({
                fingers: 2,
                onTap: p.onUndo,
            });
            nFingerSubChain.push(this.twoFingerTap as TChainElement);
        }

        // 2. 组装“三指轻敲 -> 重做(Redo)”拦截器
        if (p.onRedo) {
            this.threeFingerTap = new BB.NFingerTapper({
                fingers: 3,
                onTap: p.onRedo,
            });
            nFingerSubChain.push(this.threeFingerTap as TChainElement);
        }

        // 3. 组装“双击”拦截器 (通常用于恢复画布100%缩放或居中)
        this.mainDoubleTapper = new BB.DoubleTapper({ onDoubleTap: p.onDoubleTap });
        // 限定只有触控模式下的双击才生效，防止鼠标瞎点触发
        this.mainDoubleTapper.setAllowedPointerTypeArr(['touch']);

        // 4. 组装“鼠标中键双击”拦截器
        this.middleDoubleTapper = new BB.DoubleTapper({ onDoubleTap: p.onDoubleTap });
        this.middleDoubleTapper.setAllowedButtonArr(['middle']);
        // 5. 组装“双指捏合缩放/平移”拦截器
        this.pinchZoomer = new BB.PinchZoomer({
            onPinch: p.onPinch,
        });

        // ========================================================
        // 【核心架构】：组装事件责任链 (Chain of Responsibility)
        // 事件进来后，会严格按照数组的顺序穿过这些拦截器。
        // ========================================================
        this.pointerEventChain = new EventChain({
            chainArr: [
                // 最先判断多指轻敲，因为它的动作最短促
                ...nFingerSubChain,  
                // 其次判断触控双击
                this.mainDoubleTapper as TChainElement, 
                // 判断中键双击
                this.middleDoubleTapper as TChainElement, 
                // 如果不是轻敲，且有两根手指，进入缩放/平移逻辑
                this.pinchZoomer as TChainElement,
                // 经过上面的层层剥离（识别出了双指捏合、三指敲击等），
                // 如果还有事件能流到这里，说明用户是真的想“画画”。
                // 这个 limiter 会把多余的指头（比如手掌误触）屏蔽，只放行第一根接触屏幕的 ID。
                new BB.OnePointerLimiter() as TChainElement,
            ],
        });
        // 流水线终点：将洗净的、唯一的画笔事件输出给上层的 onChainOut（即画笔绘制引擎）
        this.pointerEventChain.setChainOut(p.onChainOut);
    }

    // 接收从 PointerListener 传来的原生修正事件
    chainIn(e: TPointerEvent): void {
        this.pointerEventChain.chainIn(e);
    }

    setDoubleTapPointerTypes(p: TPointerType[]): void {
        this.mainDoubleTapper.setAllowedPointerTypeArr(p);
    }

    destroy() {
        // todo
    }
}
