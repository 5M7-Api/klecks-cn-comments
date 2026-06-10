import { TPointerType } from '../../../bb/input/event.types';

/** 规定只有手指触控才能触发double tap事件 */
export const DEFAULT_DOUBLE_TAP_POINTER_TYPES: TPointerType[] = ['touch'];

/** 定义了哪些按键或鼠标按键可以触发“临时工具（Temp Tool）”的无缝切换 */
// triggers for switching into temp tool
export const TEMP_TRIGGERS_KEYS = ['space', 'alt', 'r', 'z'] as const;
export const TEMP_TRIGGERS = ['mouse-middle', 'mouse-right', ...TEMP_TRIGGERS_KEYS] as const;

//缩放比例的上下限
export const EASEL_MIN_SCALE = 1 / 16;
export const EASEL_MAX_SCALE = Math.pow(2, 7);
