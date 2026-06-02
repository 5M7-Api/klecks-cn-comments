export type TPointerEventType = 'pointerdown' | 'pointermove' | 'pointerup';
export type TPointerType = 'touch' | 'mouse' | 'pen';
export type TPointerButton = 'left' | 'middle' | 'right';

export type TPointerEvent = {
    type: TPointerEventType;
    pointerId: number; // long
    pointerType: TPointerType;
    // 页面坐标。相对于整个 HTML 网页顶部左上角的位置。（如果网页有滚动条，这个值会包含滚动距离）。
    pageX: number; // todo docs
    pageY: number;
    // 视口坐标。相对于浏览器窗口左上角的物理位置。（如果你滚动了网页，这个值不变）。
    clientX: number; // todo docs
    clientY: number; // todo docs
    // 最关键的坐标（画布相对坐标）。这是通过 getBoundingClientRect() 计算出来的，相对于你的 Canvas 画板左上角的内部位置。画笔引擎倒墨水，只看这个坐标。
    relX: number; // position relative to top left of target - todo what scale tho
    relY: number;
    // 这一帧和上一帧相比，笔尖移动了多少像素（Delta X / Delta Y）。作者特意注释了：“Safari on iOS 不支持原生的 movementX，所以我得自己算。”
    dX: number; // movementX not supported by safari on iOS, so need my own
    dY: number;

    coalescedArr?: {
        pageX: number;
        pageY: number;
        clientX: number;
        clientY: number;
        relX: number; // position relative to top left of target
        relY: number;
        dX: number;
        dY: number;
        time: number; // same timescale as performance.now() - might be exact same number as in parent
    }[];
    time: number; // same timescale as performance.now()

    button?: TPointerButton;
    pressure?: number; // float [0,1] always 1 for touch and mouse
    downPageX?: number; // where was pointer when down-event occurred - set for down|move|up
    downPageY?: number;

    eventPreventDefault: () => void;
    eventStopPropagation: () => void;
};

export type TWheelEvent = {
    deltaY: number; // increments of 1
    pageX: number; // todo docs
    pageY: number;
    relX: number; // todo docs
    relY: number;
    event?: WheelEvent;
};
