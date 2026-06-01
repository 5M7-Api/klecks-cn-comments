import { EVENT_USES_HIGH_RES_TIMESTAMP, HAS_POINTER_EVENTS, IS_FIREFOX } from '../base/browser';
import { TWheelCleanerEvent, WheelCleaner } from './wheel-cleaner';
import {
    TPointerButton,
    TPointerEvent,
    TPointerEventType,
    TPointerType,
    TWheelEvent,
} from './event.types';
import { PressureNormalizer } from './pressure-normalizer';

export type TPointerListenerParams = {
    target: HTMLElement | SVGElement;
    onPointer?: (pointerEvent: TPointerEvent) => void;
    onWheel?: (wheelEvent: TWheelEvent) => void;
    useDirtyWheel?: boolean; // default false - use dirty wheel events - not just increments of 1
    isWheelPassive?: boolean; // default false
    onEnterLeave?: (isOver: boolean) => void; // optional
    maxPointers?: number; // int [1,n] default is 1 - how many concurrent pointers to pay attention to
    fixScribble?: boolean; // fix ipad scribble issue - TODO remove, fixed start of 2022 -> https://bugs.webkit.org/show_bug.cgi?id=217430#c2
};

type TPointer = {
    pointerId: number;
    lastPageX: number | null;
    lastPageY: number | null;
};

type TDragObj = {
    pointerId: number; // long
    pointerType?: TPointerType;
    downPageX: number; //where was pointer when down-event occurred
    downPageY: number;
    buttons: number; // long
    lastPageX: number; //pageX in previous event - only for touch events, because they don't have movementX/Y
    lastPageY: number;
    lastTimeStamp?: number;
};

type TCoalescedPointerEvent = {
    pageX: number;
    pageY: number;
    clientX: number;
    clientY: number;
    movementX: number;
    movementY: number;
    timeStamp: number;
    pressure: number;
};

type TCorrectedPointerEvent = {
    pointerId: number;
    // 'mouse' / 'pen' / 'touch'
    pointerType: string; 
    // pageX/Y 是相对于整个页面的坐标，clientX/Y 是相对于当前视口（viewport）的坐标。两者的差值是 scrollLeft/scrollTop。
    pageX: number; 
    pageY: number;
    clientX: number;
    clientY: number;
    // 手动修正值
    movementX: number;
    movementY: number;
    timeStamp: number;
    // 压感，经过 PressureNormalizer 处理的
    pressure: number; // normalized
    buttons: number;
    button: number;
    // 高精度子事件数组（？）
    coalescedArr: TCoalescedPointerEvent[];
    // 留原始事件的控制方法
    eventPreventDefault: () => void;
    eventStopPropagation: () => void;
};

type TExtendedDOMPointerEvent = PointerEvent & {
    corrected: TCorrectedPointerEvent;
};

// keeping track of pointers for movement fallback
// 全局的指针，用来长期保存当前活跃的指针信息（主要是 pointerId 和上次的位置）。
// 因为浏览器在 pointermove 事件中提供的 movementX/Y 经常不准确，尤其在 Touch、Stylus（手写笔）和某些浏览器上几乎不可用。
const pointerArr: TPointer[] = [];

// 当有新指针（down 事件）时，addPointer 会被调用，创建一个新的 TPointer 对象并添加到 pointerArr 中。
// 限制了长度为15，防止内存泄漏。（通常绘画软件只会用一个指针）
function addPointer(event: TCorrectedPointerEvent): TPointer {
    const pointerObj: TPointer = {
        pointerId: event.pointerId,
        lastPageX: null,
        lastPageY: null,
    };
    pointerArr.push(pointerObj);

    if (pointerArr.length > 15) {
        pointerArr.shift();
    }

    return pointerObj;
}

// 根据当前事件的 pointerId，从 pointerArr 中查找对应的指针跟踪对象。
// 倒序小优化：因为新加入的指针通常被经常访问，它在数组末尾
function getPointer(event: TCorrectedPointerEvent): TPointer | null {
    for (let i = pointerArr.length - 1; i >= 0; i--) {
        if (event.pointerId === pointerArr[i].pointerId) {
            return pointerArr[i];
        }
    }
    return null;
}

// 将浏览器原始的 buttons 位掩码（bitmask）转换成可读的字符串（'left'、'right'、'middle'）。
// 1=左键，2=右键，4=中键。其他值（比如 0、8、16）返回 undefined。
function getButtonStr(buttons: number): TPointerButton | undefined {
    switch (buttons) {
        case 1:
            return 'left';
        case 2:
            return 'right';
        case 4:
            return 'middle';
        default:
            return undefined;
    }
}

// point的压感事件触发的兼容性处理
const pressureNormalizer = new PressureNormalizer();
// 用于兼容老旧游览器的时间戳数据
const timeStampOffset = EVENT_USES_HIGH_RES_TIMESTAMP() ? 0 : -performance.timing.navigationStart;
// 判断当前浏览器是否支持 Pointer Events
const pointerDownEvt = (HAS_POINTER_EVENTS ? 'pointerdown' : 'mousedown') as 'pointerdown';
const pointerMoveEvt = (HAS_POINTER_EVENTS ? 'pointermove' : 'mousemove') as 'pointermove';
const pointerUpEvt = (HAS_POINTER_EVENTS ? 'pointerup' : 'mouseup') as 'pointerup';
const pointerCancelEvt = (HAS_POINTER_EVENTS ? 'pointercancel' : 'mousecancel') as 'pointercancel';
const pointerLeaveEvt = (HAS_POINTER_EVENTS ? 'pointerleave' : 'mouseleave') as 'pointerleave';
const pointerEnterEvt = (HAS_POINTER_EVENTS ? 'pointerenter' : 'mouseenter') as 'pointerenter';

// 此函数把浏览器原始的 PointerEvent / MouseEvent 转换成 Klecks 内部可信、统一、跨浏览器一致的 TCorrectedPointerEvent 对象。
/**
 * More trustworthy pointer attributes. that behave the same across browsers.
 * returns a new object. Also attaches itself to the orig event. -> event.corrected
 */
function correctPointerEvent(
    event: PointerEvent | TExtendedDOMPointerEvent,
    isPointerDown?: boolean,
): TCorrectedPointerEvent {
    // 若事件已被处理过直接返回
    if ('corrected' in event) {
        return event.corrected;
    }

    // 处理buttons属性于不同游览器的兼容性问题 -> https://developer.mozilla.org/zh-CN/docs/Web/API/MouseEvent/buttons
    // 现代浏览器应该都支持 event.buttons，但老旧浏览器（尤其是 Safari）可能只支持 event.button，或者两者都不支持。
    function determineButtons(): number {
        if (event.buttons !== undefined) {
            return event.buttons;
        }
        /*
                button -> buttons
        none:	undefined -> 0
        left:	0 -> 1
        middle:	1 -> 4
        right:	2 -> 2
        fourth:	3 -> 8
        fifth:	4 -> 16
         */
        if (event.button !== undefined) {
            // old safari on mac has no buttons. remove eventually.
            return [1, 4, 2, 8, 16][event.button]; // 只有event.button属性
        }
        return 0;
    }

    // 创造一个统一的、标准化对象
    const correctedObj: TCorrectedPointerEvent = {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        pageX: event.pageX,
        pageY: event.pageY,
        clientX: event.clientX,
        clientY: event.clientY,
        movementX: event.movementX,
        movementY: event.movementY,
        timeStamp: event.timeStamp + timeStampOffset,
        pressure: pressureNormalizer.normalize(event.pressure, event.type, event.pointerType),
        buttons: determineButtons(),
        button: event.button,
        coalescedArr: [],
        eventPreventDefault: () => event.preventDefault(),
        eventStopPropagation: () => event.stopPropagation(),
    };
    (event as TExtendedDOMPointerEvent).corrected = correctedObj;

    // 设置压力值的兼容性处理 
    let customPressure = null;
    if ('pointerId' in event) {
        if ('pressure' in event && event.buttons !== 0) {
            if (event.pointerType === 'touch' && event.pressure === 0) {
                correctedObj.pressure = 1; // 触摸时强制认为是按下
                customPressure = 1;
            }
            // Spec: If there's no pressure support, pressure is 0.5.
            // https://w3c.github.io/pointerevents/#dom-pointerevent-pressure
            // & in older Safari (<=16) it seems to be "mouse" and 0.
            if (event.pointerType === 'mouse' && (event.pressure === 0.5 || event.pressure === 0)) {
                correctedObj.pressure = 1; // 鼠标没有压感，统一设为1
                customPressure = 1;
            }
        }
    } else {
        // ← 旧式 Mouse Events（mousedown / mousemove / mouseup）走这里
        correctedObj.pointerId = 0;
        correctedObj.pointerType = 'mouse';
        correctedObj.pressure = (event as PointerEvent).buttons !== 0 ? 1 : 0;
        customPressure = correctedObj.pressure;
    }

    if (
        IS_FIREFOX &&
        event.pointerType != 'mouse' &&
        event.type === 'pointermove' &&
        event.buttons === 0
    ) {
        // Firefox 在某些情况下即使按着笔移动，也会报告 buttons === 0，这里进行修正。
        // once again firefox
        correctedObj.buttons = 1; // todo wrong if no buttons actually pressed
    }

    // ! 高精度事件接口，这里决定了klecks的线条是否流畅平滑：https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent/getCoalescedEvents
    let coalescedEventArr: PointerEvent[] = [];
    if ('getCoalescedEvents' in event) {
        coalescedEventArr = event.getCoalescedEvents();
    }

    // chrome somehow movementX not same scale as pageX. todo: only chrome?
    // so make my own

    const pointerObj: TPointer = getPointer(correctedObj) || addPointer(correctedObj);
    // 手动计算主事件的 movement
    const totalLastX = pointerObj.lastPageX;
    const totalLastY = pointerObj.lastPageY;

    // 遍历高精度密集点
    // coalescedEventArr 来自 event.getCoalescedEvents()，Chrome 等浏览器会返回比普通 pointermove 更密集的采样点，能显著提升画线平滑度。
    for (let i = 0; i < coalescedEventArr.length; i++) {
        const eventItem = coalescedEventArr[i];

        // 将高精度事件的信息填入 correctedObj.coalescedArr 数组中，供后续使用。
        // 上层画笔系统之后可以遍历这个数组来绘制更平滑的笔迹。
        correctedObj.coalescedArr.push({
            pageX: eventItem.pageX,
            pageY: eventItem.pageY,
            clientX: eventItem.clientX,
            clientY: eventItem.clientY,
            movementX: pointerObj.lastPageX === null ? 0 : eventItem.pageX - pointerObj.lastPageX,
            movementY: pointerObj.lastPageY === null ? 0 : eventItem.pageY - pointerObj.lastPageY,
            timeStamp:
                eventItem.timeStamp === 0
                    ? correctedObj.timeStamp
                    : eventItem.timeStamp + timeStampOffset, // 0 in firefox
            pressure:
                customPressure === null
                    ? pressureNormalizer.normalize(eventItem.pressure)
                    : customPressure,
        });

        pointerObj.lastPageX = eventItem.pageX;
        pointerObj.lastPageY = eventItem.pageY;
    }

    pointerObj.lastPageX = correctedObj.pageX;
    pointerObj.lastPageY = correctedObj.pageY;
    if (isPointerDown) {
        correctedObj.movementX = 0;
        correctedObj.movementY = 0;
    } else {
        // 手动计算每个子事件的移动增量 
        // 使用之前全局 pointerArr 中保存的 lastPageX/Y 进行计算。
        correctedObj.movementX = totalLastX === null ? 0 : pointerObj.lastPageX - totalLastX;
        correctedObj.movementY = totalLastY === null ? 0 : pointerObj.lastPageY - totalLastY;
    }
    return correctedObj;
}

const OPTIONS_PASSIVE = {
    passive: false, //设置为 true 时，表示 listener 永远不会调用 preventDefault()。
};

/**
 * PointerListener - for pointer events, wheel events. uses fallbacks. ideally consistent behavior across browsers.
 * Has some workarounds for browser specific bugs. As browsers evolve this constructor should get smaller.
 */
export class PointerListener {
    private isDestroyed: boolean = false;

    // ts has problems with (HTMLElement|SVGElement) when adding event listeners
    // https://github.com/microsoft/TypeScript/issues/46819
    private readonly targetElement: HTMLElement;
    private readonly onPointerCallback: undefined | ((pointerEvent: TPointerEvent) => void);
    private readonly onWheelCallback: undefined | ((wheelEvent: TWheelEvent) => void);
    private readonly onEnterLeaveCallback: undefined | ((isOver: boolean) => void);
    private readonly maxPointers: number;
    private readonly wheelCleaner: WheelCleaner | undefined;
    private isOverCounter: number = 0;

    // pointers that are pressing a button
    private dragObjArr: TDragObj[] = [];
    private dragPointerIdArr: number[] = [];

    // chrome input glitch workaround
    private lastPointerType: TPointerType | null = null;
    private didSkip: boolean = false;

    // listeners
    private readonly onPointerEnter: ((e: PointerEvent) => void) | undefined;
    private readonly onPointerLeave: (() => void) | undefined;
    private readonly onPointerMove: ((event: PointerEvent) => void) | undefined;
    private readonly onPointerDown:
        | ((event: PointerEvent, skipGlobal?: boolean) => void)
        | undefined;
    private readonly onWheel: ((e: WheelEvent) => void) | undefined;
    private readonly onTouchMoveScribbleFix: ((e: TouchEvent) => void) | undefined;
    private readonly windowOnPointerMove: ((event: PointerEvent) => void) | undefined;
    private readonly windowOnPointerUp: ((event: PointerEvent) => void) | undefined;
    private readonly windowOnPointerLeave: ((event: PointerEvent) => void) | undefined;
    // fallback pre pointer events (iOS < 13, as of 2023-02, still 4.4% of iOS users)
    private readonly onTouchStart: ((e: TouchEvent) => void) | undefined;
    private readonly onTouchMove: ((e: TouchEvent) => void) | undefined;
    private readonly onTouchEnd: ((e: TouchEvent) => void) | undefined;
    private readonly onTouchCancel: ((e: TouchEvent) => void) | undefined;

    private getDragObj(pointerId: number): TDragObj | null {
        for (let i = 0; i < this.dragObjArr.length; i++) {
            if (pointerId === this.dragObjArr[i].pointerId) {
                return this.dragObjArr[i];
            }
        }
        return null;
    }

    private removeDragObj(pointerId: number): TDragObj | null {
        let removedDragObj: TDragObj | null = null;
        for (let i = 0; i < this.dragPointerIdArr.length; i++) {
            if (this.dragPointerIdArr[i] === pointerId) {
                removedDragObj = this.dragObjArr[i];
                this.dragObjArr.splice(i, 1);
                this.dragPointerIdArr.splice(i, 1);
                i--;
            }
        }
        return removedDragObj;
    }

    /**
     * Creates a value for onPointer, from a pointer event handler.
     */
    private createPointerOutEvent(
        typeStr: TPointerEventType,
        correctedEvent: TCorrectedPointerEvent,
        custom?: Partial<TPointerEvent>,
    ): TPointerEvent {
        const bounds: DOMRect = this.targetElement.getBoundingClientRect();
        const result: TPointerEvent = {
            type: typeStr,
            pointerId: correctedEvent.pointerId,
            pointerType: correctedEvent.pointerType as TPointerType,
            pageX: correctedEvent.pageX,
            pageY: correctedEvent.pageY,
            clientX: correctedEvent.clientX,
            clientY: correctedEvent.clientY,
            relX: correctedEvent.clientX - bounds.left + this.targetElement.scrollLeft,
            relY: correctedEvent.clientY - bounds.top + this.targetElement.scrollTop,
            dX: correctedEvent.movementX,
            dY: correctedEvent.movementY,
            time: correctedEvent.timeStamp,
            eventPreventDefault: correctedEvent.eventPreventDefault,
            eventStopPropagation: correctedEvent.eventStopPropagation,
            ...custom,
        };

        if (typeStr === 'pointermove') {
            result.coalescedArr = [];
            if (correctedEvent.coalescedArr.length > 1) {
                let coalescedItem;
                for (let i = 0; i < correctedEvent.coalescedArr.length; i++) {
                    coalescedItem = correctedEvent.coalescedArr[i];
                    result.coalescedArr.push({
                        pageX: coalescedItem.pageX,
                        pageY: coalescedItem.pageY,
                        clientX: coalescedItem.clientX,
                        clientY: coalescedItem.clientY,
                        relX: coalescedItem.clientX - bounds.left + this.targetElement.scrollLeft,
                        relY: coalescedItem.clientY - bounds.top + this.targetElement.scrollTop,
                        dX: coalescedItem.movementX,
                        dY: coalescedItem.movementY,
                        time: coalescedItem.timeStamp,
                    });
                }
            }
        }

        return result;
    }

    private setupDocumentListeners() {
        this.windowOnPointerMove &&
            document.addEventListener(pointerMoveEvt, this.windowOnPointerMove, OPTIONS_PASSIVE);
        this.windowOnPointerUp &&
            document.addEventListener(pointerUpEvt, this.windowOnPointerUp, OPTIONS_PASSIVE);
        this.windowOnPointerLeave &&
            document.addEventListener(pointerCancelEvt, this.windowOnPointerLeave, OPTIONS_PASSIVE);
        this.windowOnPointerLeave &&
            document.addEventListener(pointerLeaveEvt, this.windowOnPointerLeave, OPTIONS_PASSIVE);
    }

    private destroyDocumentListeners() {
        this.windowOnPointerMove &&
            document.removeEventListener(pointerMoveEvt, this.windowOnPointerMove);
        this.windowOnPointerUp &&
            document.removeEventListener(pointerUpEvt, this.windowOnPointerUp);
        this.windowOnPointerLeave &&
            document.removeEventListener(pointerCancelEvt, this.windowOnPointerLeave);
        this.windowOnPointerLeave &&
            document.removeEventListener(pointerLeaveEvt, this.windowOnPointerLeave);
    }

    // ----------------------------------- public -----------------------------------

    constructor(p: TPointerListenerParams) {
        this.targetElement = p.target as HTMLElement;
        this.onPointerCallback = p.onPointer;
        this.onWheelCallback = p.onWheel; 
        this.onEnterLeaveCallback = p.onEnterLeave; 
        this.maxPointers = Math.max(1, p.maxPointers ?? 1);

        // 这个函数负责统一滚轮数据的格式，计算相对于目标元素的精确坐标 (relX, relY)
        const finalizeWheelEvent = (e: WheelEvent | TWheelCleanerEvent): void => {
            if (this.isDestroyed || !this.onWheelCallback) {
                return;
            }
            // 获取画布在屏幕上的位置
            const bounds = this.targetElement.getBoundingClientRect();
            const whlEvent: TWheelEvent = {
                // 如果是原生滚轮事件，将 deltaY 归一化 (除以 120 是传统的鼠标滚轮步长)
                ...(e instanceof WheelEvent
                    ? { deltaY: e.deltaY / 120, pageX: e.pageX, pageY: e.pageY }
                    : e),
                // 计算出相对于画布左上角的内部坐标（考虑了滚动条偏移）
                relX: e.clientX - bounds.left + this.targetElement.scrollLeft,
                relY: e.clientY - bounds.top + this.targetElement.scrollTop,
                ...(e instanceof WheelEvent ? { event: e } : {}),
            };
            this.onWheelCallback(whlEvent);
        };
        // WheelCleaner 用于平滑触控板（如 Mac 触控板）的惯性滚动，除非显式禁用
        this.wheelCleaner = p.useDirtyWheel ? undefined : new WheelCleaner(finalizeWheelEvent);

        if (this.onPointerCallback) {

            // 画布内的指针移动（Hover 或 移动状态）事件
            this.onPointerMove = (event: PointerEvent) => {
                const correctedEvent = correctPointerEvent(event); //转换一个封装的事件

                const tempLastPointerType = this.lastPointerType;
                this.lastPointerType = correctedEvent.pointerType as TPointerType;

                // 如果这个指针正在被拖拽（按下状态），或者触点已满，或者它是纯触摸事件（因为触摸事件经常会有误报的 pointermove），就不处理这个事件。
                if (
                    this.dragPointerIdArr.includes(correctedEvent.pointerId) ||
                    this.dragPointerIdArr.length === this.maxPointers ||
                    correctedEvent.pointerType === 'touch'
                ) {
                    this.didSkip = false;
                    return;
                }

                // chrome的bug：当使用数位板（Stylus）时，Chrome 偶尔会随机混入一个坐标错误的 mouse 事件，必须丢弃它
                // chrome input glitch workaround - throws in a random mouse event with the wrong position when using a stylus
                if (
                    !this.didSkip &&
                    correctedEvent.pointerType === 'mouse' &&
                    tempLastPointerType === 'pen'
                ) {
                    this.didSkip = true;
                    return;
                }
                this.didSkip = false;

                // 触发 'pointermove' 回调（通常用于在画布上显示笔刷光标悬停的位置）
                const outEvent = this.createPointerOutEvent('pointermove', correctedEvent);
                this.onPointerCallback?.(outEvent);
            };

            // 画布内的指针按下事件
            this.onPointerDown = (event: PointerEvent, onSkipGlobal?: boolean) => {
                //BB.throwOut('pointerdown ' + event.pointerId + ' | ' + dragPointerIdArr.length);
                const correctedEvent = correctPointerEvent(event, true);
                ////console.log('debug: ' + event.pointerId + ' pointerdown');

                // 防御机制：如果已经在拖拽中、触点超限、或者按下的不是常规按键（左键1, 右键2, 中键4），直接忽略
                if (
                    this.dragPointerIdArr.includes(correctedEvent.pointerId) ||
                    this.dragPointerIdArr.length === this.maxPointers ||
                    ![1, 2, 4].includes(correctedEvent.buttons)
                ) {
                    //BB.throwOut('pointerdown ignored');
                    return;
                }

                // 【核心机制】：一旦按下，就在全局(window/document)挂载移动监听。
                // 这样即使用户画着画着鼠标超出了画布范围，依然能继续追踪线条！
                //set up global listeners
                if (this.dragObjArr.length === 0 && !onSkipGlobal) {
                    this.setupDocumentListeners();
                }

                // dragObj 就是 当前按下的指针对象
                // 保存了它的 pointerId、pointerType、按下时的位置（downPageX/Y）、按下时的 buttons 状态，以及上次的位置（lastPageX/Y）和时间戳（lastTimeStamp）。
                const dragObj: TDragObj = {
                    pointerId: correctedEvent.pointerId,
                    pointerType: correctedEvent.pointerType as TPointerType,
                    downPageX: correctedEvent.pageX,
                    downPageY: correctedEvent.pageY,
                    buttons: correctedEvent.buttons,
                    lastPageX: correctedEvent.pageX,
                    lastPageY: correctedEvent.pageY,
                    lastTimeStamp: correctedEvent.timeStamp,
                };
                this.dragObjArr.push(dragObj);
                this.dragPointerIdArr.push(correctedEvent.pointerId);

                // 派发按下事件，告诉画板引擎“开始绘制”
                const outEvent: TPointerEvent = this.createPointerOutEvent(
                    'pointerdown',
                    correctedEvent,
                    {
                        downPageX: correctedEvent.pageX,
                        downPageY: correctedEvent.pageY,
                        button: getButtonStr(correctedEvent.buttons),
                        pressure: correctedEvent.pressure,
                    },
                );

                this.onPointerCallback?.(outEvent);
            };

            // 全局的指针移动
            this.windowOnPointerMove = (event: PointerEvent) => {
                //BB.throwOut('pointermove ' + event.pointerId);
                const correctedEvent = correctPointerEvent(event);
                ////console.log('debug: ' + event.pointerId + ' GLOBALpointermove');

                // 只处理记录在 dragPointerIdArr 中的指针（即当前正在拖拽的指针），其他的都不处理。
                if (!this.dragPointerIdArr.includes(correctedEvent.pointerId)) {
                    return;
                }

                const dragObj = this.getDragObj(correctedEvent.pointerId);

                if (!dragObj) {
                    // todo need to handle this!
                    return;
                }

                // 如果用户在拖拽过程中松开了按键（buttons发生变化），强行转化为抬起事件
                //if pointer changes button its pressing -> turn into pointerup
                if (correctedEvent.buttons !== dragObj.buttons) {
                    //pointer up

                    // 当最后一个拖拽事件时，移除全局监听器，否则移除当前的
                    //remove listener
                    if (this.dragObjArr.length === 1) {
                        this.destroyDocumentListeners();
                    }
                    this.removeDragObj(correctedEvent.pointerId);

                    const outEvent = this.createPointerOutEvent('pointerup', correctedEvent, {
                        downPageX: dragObj.downPageX,
                        downPageY: dragObj.downPageY,
                    });
                    this.onPointerCallback?.(outEvent);
                    return;
                }

                // 【Bug修复】：iPad/Apple Pencil 特有 Bug
                // iPad 经常派发一堆坐标和时间戳完全没有变化的重复事件，浪费性能，直接拦截
                // ipad likes to do this
                if (
                    correctedEvent.pointerType === 'pen' &&
                    correctedEvent.pageX === dragObj.lastPageX &&
                    correctedEvent.pageY === dragObj.lastPageY &&
                    correctedEvent.timeStamp === dragObj.lastTimeStamp
                ) {
                    //ignore
                    return;
                }

                // 派发正常的绘制移动事件
                const outEvent = this.createPointerOutEvent('pointermove', correctedEvent, {
                    downPageX: dragObj.downPageX,
                    downPageY: dragObj.downPageY,
                    button: getButtonStr(correctedEvent.buttons),
                    pressure: correctedEvent.pressure,
                });

                // 更新状态机，供下一次计算使用
                dragObj.lastPageX = correctedEvent.pageX;
                dragObj.lastPageY = correctedEvent.pageY;
                dragObj.lastTimeStamp = correctedEvent.timeStamp;

                this.onPointerCallback?.(outEvent);
            };

            // 全局指针抬起（绘制结束）
            this.windowOnPointerUp = (event: PointerEvent) => {
                //BB.throwOut('pointerup ' + event.pointerId);
                const correctedEvent = correctPointerEvent(event);
                ////console.log('debug: ' + event.pointerId + ' GLOBALpointerup');
                if (!this.dragPointerIdArr.includes(correctedEvent.pointerId)) {
                    return;
                }

                //remove listener
                if (this.dragObjArr.length === 1) {
                    this.destroyDocumentListeners(); // 清除全局监听
                }
                // 从记录中销毁这个拖拽对象，表示这个指针已经不再活跃了。
                const dragObj = this.removeDragObj(correctedEvent.pointerId);
                if (!dragObj) {
                    // todo need to handle this!
                    return;
                }

                // 通知画板引擎结束绘制这条线
                const outEvent = this.createPointerOutEvent('pointerup', correctedEvent, {
                    downPageX: dragObj.downPageX,
                    downPageY: dragObj.downPageY,
                });
                this.onPointerCallback?.(outEvent);
            };

            // 全局指针离开屏幕/窗口被打断（比如系统弹窗），按抬起(up)逻辑处理
            // 逻辑与抬起事件相同
            this.windowOnPointerLeave = (event: PointerEvent) => {
                //BB.throwOut('pointerleave ' + event.pointerId);
                const correctedEvent = correctPointerEvent(event);
                ////console.log('debug: ' + event.pointerId + ' onGlobalPointerLeave', event);
                if (!this.dragPointerIdArr.includes(correctedEvent.pointerId)) {
                    //} || event.target !== document) {
                    return;
                }

                //remove listener
                if (this.dragObjArr.length === 1) {
                    this.destroyDocumentListeners();
                }
                const dragObj = this.removeDragObj(correctedEvent.pointerId);
                if (!dragObj) {
                    // todo need to handle this!
                    return;
                }

                const outEvent = this.createPointerOutEvent('pointerup', correctedEvent, {
                    downPageX: dragObj.downPageX,
                    downPageY: dragObj.downPageY,
                });
                this.onPointerCallback?.(outEvent);
            };

            // 将基本事件绑定到目标画布
            this.targetElement.addEventListener(
                pointerMoveEvt,
                this.onPointerMove,
                OPTIONS_PASSIVE,
            );
            this.targetElement.addEventListener(
                pointerDownEvt,
                this.onPointerDown,
                OPTIONS_PASSIVE,
            );

            if (!HAS_POINTER_EVENTS) {
                const touchToFakePointer = (
                    touch: Touch,
                    touchEvent: TouchEvent,
                    isDown: boolean,
                ) => {
                    return {
                        pointerId: touch.identifier,
                        pointerType: 'touch',
                        pageX: touch.pageX,
                        pageY: touch.pageY,
                        clientX: touch.clientX,
                        clientY: touch.clientY,
                        button: isDown ? 0 : undefined,
                        buttons: isDown ? 1 : 0,
                        timeStamp: touchEvent.timeStamp,
                        target: touchEvent.target,
                        pressure: isDown ? 1 : 0,
                        preventDefault: () => touchEvent.preventDefault(),
                        stopPropagation: () => touchEvent.stopPropagation(),
                    };
                };

                const handleTouch = (
                    e: TouchEvent,
                    type: 'start' | 'move' | 'end' | 'cancel',
                ): void => {
                    for (let i = 0; i < e.changedTouches.length; i++) {
                        const touch = e.changedTouches[i];
                        const fakePointer = touchToFakePointer(
                            touch,
                            e,
                            ['start', 'move'].includes(type),
                        );
                        if (type === 'start') {
                            this.onPointerDown!(fakePointer as PointerEvent, false);
                        } else if (type === 'move') {
                            this.windowOnPointerMove!(fakePointer as PointerEvent);
                        } else if (type === 'end') {
                            this.windowOnPointerUp!(fakePointer as PointerEvent);
                        } else {
                            this.windowOnPointerLeave!(fakePointer as PointerEvent);
                        }
                    }
                };

                this.onTouchStart = (e: TouchEvent): void => {
                    e.preventDefault();
                    handleTouch(e, 'start');
                };
                this.onTouchMove = (e: TouchEvent): void => {
                    handleTouch(e, 'move');
                };
                this.onTouchEnd = (e: TouchEvent): void => {
                    handleTouch(e, 'end');
                };
                this.onTouchCancel = (e: TouchEvent): void => {
                    handleTouch(e, 'cancel');
                };

                this.targetElement.addEventListener(
                    'touchstart',
                    this.onTouchStart,
                    OPTIONS_PASSIVE,
                );
                this.targetElement.addEventListener('touchmove', this.onTouchMove, OPTIONS_PASSIVE);
                this.targetElement.addEventListener('touchend', this.onTouchEnd, OPTIONS_PASSIVE);
                this.targetElement.addEventListener(
                    'touchcancel',
                    this.onTouchCancel,
                    OPTIONS_PASSIVE,
                );
            }
        }
        if (this.onWheelCallback) {
            this.onWheel = (e: WheelEvent) => {
                if (this.wheelCleaner) {
                    this.wheelCleaner.process(e);
                } else {
                    finalizeWheelEvent(e);
                }
            };
            this.targetElement.addEventListener('wheel', this.onWheel, {
                passive: !!p.isWheelPassive,
            });
        }
        if (this.onEnterLeaveCallback) {
            this.onPointerEnter = (e: PointerEvent) => {
                // workaround for Safari which can falsely fire pointerenter. For more details see below.
                if (!pointerTypeMouseOccurred && e.pointerType === 'mouse') {
                    return;
                }
                this.isOverCounter++;
                this.onEnterLeaveCallback?.(true);
            };

            this.onPointerLeave = () => {
                this.isOverCounter--;
                this.onEnterLeaveCallback?.(false);
            };

            this.targetElement.addEventListener(
                pointerEnterEvt,
                this.onPointerEnter,
                OPTIONS_PASSIVE,
            );
            this.targetElement.addEventListener(
                pointerLeaveEvt,
                this.onPointerLeave,
                OPTIONS_PASSIVE,
            );
        }

        if (p.fixScribble) {
            //ipad scribble workaround https://developer.apple.com/forums/thread/662874
            this.onTouchMoveScribbleFix = (e: TouchEvent) => e.preventDefault();
            this.targetElement.addEventListener(
                'touchmove',
                this.onTouchMoveScribbleFix,
                OPTIONS_PASSIVE,
            );
        }
    }

    destroy(): void {
        if (this.isDestroyed) {
            return;
        }
        this.isDestroyed = true;
        this.onPointerEnter &&
            this.targetElement.removeEventListener(pointerEnterEvt, this.onPointerEnter);
        this.onPointerLeave &&
            this.targetElement.removeEventListener(pointerLeaveEvt, this.onPointerLeave);
        this.onPointerMove &&
            this.targetElement.removeEventListener(pointerMoveEvt, this.onPointerMove);
        this.onPointerDown &&
            this.targetElement.removeEventListener(pointerDownEvt, this.onPointerDown);
        this.onWheel && this.targetElement.removeEventListener('wheel', this.onWheel);
        this.destroyDocumentListeners();
        this.onTouchMoveScribbleFix &&
            document.removeEventListener('touchmove', this.onTouchMoveScribbleFix);

        this.onTouchStart &&
            this.targetElement.removeEventListener('touchstart', this.onTouchStart);
        this.onTouchMove && this.targetElement.removeEventListener('touchmove', this.onTouchMove);
        this.onTouchEnd && this.targetElement.removeEventListener('touchend', this.onTouchEnd);
        this.onTouchCancel &&
            this.targetElement.removeEventListener('touchcancel', this.onTouchCancel);
    }
}

// Workaround for Safari (iOS/IPadOS 26.2) https://bugs.webkit.org/show_bug.cgi?id=305856
// The incorrect pointerenter event will be of type "mouse" although the click happened with "touch".
// This workaround won't work if the user uses both touch and mouse. The probability of that should be low enough.
let pointerTypeMouseOccurred = false;
setTimeout(() => {
    const listener = (e: PointerEvent) => {
        if (e.pointerType === 'mouse' && !pointerTypeMouseOccurred) {
            pointerTypeMouseOccurred = true;
            document.removeEventListener(pointerMoveEvt, listener);
        }
    };
    document.addEventListener(pointerMoveEvt, listener);
});
