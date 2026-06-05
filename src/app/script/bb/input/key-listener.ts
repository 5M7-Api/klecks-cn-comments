import { TKeyString } from '../bb-types';

type TGlobalKey = {
    add: (keyListenerRef: TKeyListenerRef) => void;
    remove: (keyListenerRef: TKeyListenerRef) => void;
    getIsDown: () => TIsDown;
    getCombo: () => string[];
    blur: () => void;
};

type TIsDown = {
    [key: string]: boolean;
};

export type TOnKeyDown = (
    keyStr: string,
    e: KeyboardEvent,
    comboStr: string,
    isRepeat?: boolean,
) => void;
export type TOnKeyUp = (keyStr: string, e: KeyboardEvent, oldComboStr: string) => void;
export type TOnBlur = () => void;
type TKeyListenerRef = [TOnKeyDown | undefined, TOnKeyUp | undefined, TOnBlur | undefined];

// 通过立即执行函数 (IIFE) 创建一个单例，整个页面只存在这一个键盘状态仓库
const globalKey = ((): TGlobalKey => {
    // keyStr - our key naming system
    // key - KeyboardEvent.key
    // code - KeyboardEvent.code

    // todo: webview2里面会有这些冲突问题吗？
    // 【核心字典】解决不同浏览器、大小写的名称差异
    // 不同游览器监听的键位是不同的，兼容性处理
    const keyStrToKeyObj = {
        // keyStr not to contain a '+', because that's used for the comboStr
        space: [' ', 'Spacebar'], // Spacebar in IE
        alt: ['Alt', 'AltGraph'],
        shift: 'Shift',
        ctrl: 'Control',
        // Mac 的 Cmd 键，Win 的 Windows 键
        cmd: ['Meta', 'MetaLeft', 'MetaRight'],
        enter: 'Enter',
        esc: 'Escape',
        backspace: 'Backspace',
        delete: 'Delete',
        sqbr_open: '[',
        sqbr_close: ']',
        // 不管是否按了 Shift 或者 大小写锁定，都统一识别为 'a'
        a: ['a', 'A'],
        b: ['b', 'B'],
        c: ['c', 'C'],
        e: ['e', 'E'],
        f: ['f', 'F'],
        g: ['g', 'G'],
        l: ['l', 'L'],
        r: ['r', 'R'], // when holding shift
        s: ['s', 'S'],
        t: ['t', 'T'],
        u: ['u', 'U'],
        x: ['x', 'X'],
        y: ['y', 'Y'],
        z: ['z', 'Z'],
        plus: '+',
        minus: '-',
        left: 'ArrowLeft',
        right: 'ArrowRight',
        up: 'ArrowUp',
        down: 'ArrowDown',
        home: 'Home',
        end: 'End',
    };

    // ['space', 'alt', ... ]
    // ! 这里转换成二维数组
    const keyStrArr = Object.keys(keyStrToKeyObj);

    // 【状态库 1】记录逻辑按键是否按下 (例如 { ctrl: true, z: false })
    // { space: false, ... }
    const isDownObj: TIsDown = Object.entries(keyStrToKeyObj).reduce((acc, [key]) => {
        acc[key] = false;
        return acc;
    }, {} as TIsDown);

    // 反向映射表：通过原生 event.key 快速查找到我们的内部 keyStr
    // event.key to keyStr
    // { ArrowLeft: 'left', ... }
    const keyToKeyStrObj = Object.entries(keyStrToKeyObj).reduce((acc, [key, code]) => {
        if (typeof code === 'string') {
            acc[code] = key;
        } else {
            code.forEach((item) => {
                acc[item] = key;
            });
        }
        return acc;
    }, {} as TKeyString);

    // 记录当前的组合键，例如 ['ctrl', 'z']
    let comboArr: string[] = []; 

    // 【极其关键的状态库 2：物理按键跟踪】
    // 为什么需要这个？因为 e.key 是会变的！
    // 假设你按下 'a'，再按下 Shift，然后松开 'a'。
    // 按下时 e.key 是 'a'，松开时 e.key 变成了 'A'！如果你只记录 'a'，引擎永远收不到 'a' 的 keyup，'a' 就卡死了。
    // 但是 e.code (物理键位) 永远是 'KeyA'。所以必须用 code 来追踪物理按键！
    // a physical key's "key" can change as other keys get pressed. to keep track, need to also track the code
    // { KeyE: 'e', KeyF: undefined } - undefined - not down, string - the associated keyStr
    let codeIsDownObj: {
        [key: string]: string | undefined;
    } = {};
    const listenerArr: TKeyListenerRef[] = [];

    // 现象：按下 Win 键或 Cmd 键后，操作系统可能弹出开始菜单或执行系统级快捷键，导致浏览器直接丢失焦点，永远发不出 keyup 事件。
    // 解决：设置一个 1 秒的定时器，如果 1 秒后你只按了 meta 键，强行帮它触发 keyup 释放掉。
    /**
     * Windows bug in all browsers: Pressing the Windows key leads to keyboard events not firing.
     * It breaks key state tracking.
     * Workaround: If after a timeout, only the meta key is pressed, fire a keyup for the meta key.
     */
    let metaClearTimeout: ReturnType<typeof setTimeout> | undefined;
    const setupMetaClear = (keyStr: string, code: string) => {
        metaClearTimeout = setTimeout(() => {
            // 如果还按着其他键（比如 Cmd + C），不处理
            if (comboArr.length !== 1 || comboArr[0] === 'cmd') {
                return;
            }
            const oldComboStr = comboArr.join('+');
            isDownObj[keyStr] = false;
            codeIsDownObj[code] = undefined;
            // remove from combo
            for (let i = 0; i < comboArr.length; i++) {
                if (comboArr[i] == keyStr) {
                    comboArr.splice(i, 1);
                    i--;
                }
            }
            // 伪造一个 keyup 事件广播出去，解除卡死状态
            emitUp(
                keyStr,
                {
                    preventDefault: function () {},
                    stopPropagation: function () {},
                } as KeyboardEvent,
                oldComboStr,
            );
            metaClearTimeout = undefined;
        }, 1000);
    };

    const emitDown: TOnKeyDown = function (a, b, c, d?): void {
        listenerArr.forEach((item) => {
            if (!item[0]) {
                return;
            }
            item[0](a, b, c, d);
        });
    };

    const emitUp: TOnKeyUp = function (a, b, c): void {
        listenerArr.forEach((item) => {
            if (!item[1]) {
                return;
            }
            item[1](a, b, c);
        });
    };

    const emitBlur: TOnBlur = function (): void {
        listenerArr.forEach((item) => {
            if (!item[2]) {
                return;
            }
            item[2]();
        });
    };

    // 【全局按键按下拦截】
    function keyDown(e: KeyboardEvent): void {
        const key = e.key;
        const code = e.code;

        if (key in keyToKeyStrObj) {
            // 翻译成内部标准名称 (比如 'A' -> 'a')
            const keyStr = keyToKeyStrObj[key];
            if (isDownObj[keyStr]) {
                // 如果系统触发了长按连续发射 (Repeat)，依然广播，但带上 isRepeat=true 标记
                emitDown(keyStr, e, comboArr.join('+'), true);
                return;
            } else {
                // 触发 meta 键防卡死逻辑
                if (keyStr === 'cmd') {
                    setupMetaClear(keyStr, code);
                } else {
                    clearTimeout(metaClearTimeout);
                }

                // 【系统 Bug 修复 2：Mac 全屏 Esc 卡死问题】
                if (keyStr === 'esc') {
                    // Workaround for a macOS behavior
                    // When in fullscreen, pressing escape exits the fullscreen mode.
                    // When that happens, no keyup for escape is fired.
                    setTimeout(() => blur());
                }
            }

            // 更新逻辑状态
            isDownObj[keyStr] = true;
            // 锁定物理按键与逻辑按键的绑定关系
            codeIsDownObj[code] = keyStr;

            // 加入组合键数组
            //add to combo
            comboArr.push(keyStr);

            // 广播按下事件 (例如 'ctrl+z')
            emitDown(keyStr, e, comboArr.join('+'));
        }
    }

    // 【全局按键抬起拦截】
    function keyUp(e: KeyboardEvent): void {
        const code = e.code;
        const oldComboStr = comboArr.join('+');

        // 【系统 Bug 修复 3：Cmd 组合键卡死问题】
        // Mac 上按住 Cmd 再按别的键，别的键抬起时不会触发 keyup。
        // 这里直接简单粗暴地调用 blur()，把所有按键状态全部清空，宁可误杀不可放过（卡死）。
        // because of a macOS bug: when meta key is down, keyup of other keys does not fire.
        // https://stackoverflow.com/questions/25438608/javascript-keyup-isnt-called-when-command-and-another-is-pressed
        if (
            [
                'Meta',
                'MetaLeft',
                'MetaRight',
                'OSLeft',
                'OSRight', // Firefox
            ].includes(code)
        ) {
            blur();
            return;
        } else if (isDownObj['cmd']) {
            // Workaround for Windows bug. Windows doesn't fire keyup for Meta key when pressing Windows Key + Space,
            // neither does it fire blur
            blur();
            return;
        }

        // 使用 e.code 找回当初按下时绑定的 keyStr，完美避开 Shift 导致的 e.key 变化问题
        const keyStr = codeIsDownObj[code];
        if (keyStr !== undefined) {
            isDownObj[keyStr] = false;
            codeIsDownObj[code] = undefined;

            // remove from combo
            for (let i = 0; i < comboArr.length; i++) {
                if (comboArr[i] == keyStr) {
                    comboArr.splice(i, 1);
                    i--;
                }
            }

            emitUp(keyStr, e, oldComboStr);
        }
    }

    // 【终极防卡死武器：失焦重置】
    // 当浏览器窗口失去焦点（用户 Alt-Tab 切到微信，或者弹出了系统警告框），必须强制释放所有按键！
    // 否则用户切回来时，程序会认为他还在按着那些键。
    function blur(): void {
        const oldComboStr = comboArr.join('+');
        comboArr = [];
        codeIsDownObj = {};

        const eventArr: string[] = [];
        keyStrArr.forEach((keyStr) => {
            if (isDownObj[keyStr]) {
                isDownObj[keyStr] = false;
                eventArr.push(keyStr);
            }
        });
        // 为每一个被强制释放的键，广播一个伪造的 keyup 事件
        for (let i = 0; i < eventArr.length; i++) {
            emitUp(
                eventArr[i],
                {
                    preventDefault: function () {},
                    stopPropagation: function () {},
                } as KeyboardEvent,
                oldComboStr,
            );
        }
        emitBlur();
    }

    // 暴露给外部的操作接口
    return {
        add: (keyListenerRef: TKeyListenerRef): void => {
            if (listenerArr.includes(keyListenerRef)) {
                return;
            }
            // 【极其聪明的设计】
            // 只有当页面里有了第一个订阅者时，才真正向 document 挂载监听器。
            // 节约性能，平时不乱听。
            const first = listenerArr.length === 0;
            listenerArr.push(keyListenerRef);

            if (first) {
                document.addEventListener('keydown', keyDown);
                document.addEventListener('keyup', keyUp);
                window.addEventListener('blur', blur);
            }
        },
        remove: (keyListenerRef: TKeyListenerRef): void => {
            if (!listenerArr.includes(keyListenerRef)) {
                return;
            }
            const last = listenerArr.length === 1;
            for (let i = 0; i < listenerArr.length; i++) {
                if (listenerArr[i] === keyListenerRef) {
                    listenerArr.splice(i, 1);
                    break;
                }
            }
            if (last) {
                document.removeEventListener('keydown', keyDown);
                document.removeEventListener('keyup', keyUp);
                window.removeEventListener('blur', blur);

                // cleanup
                comboArr = [];
                codeIsDownObj = {};
                keyStrArr.forEach((keyStr) => {
                    if (isDownObj[keyStr]) {
                        isDownObj[keyStr] = false;
                    }
                });
            }
        },
        getIsDown: (): TIsDown => isDownObj,
        getCombo: (): string[] => comboArr,
        blur,
    };
})();

export type TKeyListenerParams = {
    onDown?: TOnKeyDown;
    onUp?: TOnKeyUp;
    onBlur?: TOnBlur; // on window blur
};

/**
 * Listens to key events in window. Makes combos easier - e.g. ctrl + z
 *
 * keyStr - see in implementation - my representation of a key. e.g. 'r' can be 'r' and 'R'
 * comboStr - string joins currently pressed keyStr with a +
 *              e.g. 'ctrl+z'
 *
 */
export class KeyListener {
    private readonly onDown: TOnKeyDown | undefined;
    private readonly onUp: TOnKeyUp | undefined;
    private readonly onBlur: TOnBlur | undefined;
    private readonly ref: TKeyListenerRef;

    // ----------------------------------- public -----------------------------------
    constructor(p: TKeyListenerParams) {
        this.onDown = p.onDown;
        this.onUp = p.onUp;
        this.onBlur = p.onBlur;
        this.ref = [this.onDown, this.onUp, this.onBlur];
        globalKey.add(this.ref);
    }

    // 查询某个键现在到底有没有被按着？（无需在组件里自己维护 true/false 变量）
    isPressed(keyStr: string): boolean {
        if (!(keyStr in globalKey.getIsDown())) {
            throw 'key "' + keyStr + '" not found';
        }
        return globalKey.getIsDown()[keyStr];
    }

    // 获取当前组合键字符串，比如 "ctrl+shift+z"
    getComboStr(): string {
        return globalKey.getCombo().join('+');
    }

    // 判断当前的组合键里，是不是【只有】这几个指定的键。
    // 这对于处理复杂的快捷键防冲突非常有用。
    comboOnlyContains(keyStrArr: string[]): boolean {
        for (let i = 0; i < globalKey.getCombo().length; i++) {
            if (!keyStrArr.includes(globalKey.getCombo()[i])) {
                return false;
            }
        }
        return true;
    }

    // 组件销毁时，把自己从全局监听列表里拔掉
    destroy(): void {
        globalKey.remove(this.ref);
    }
}

/**
 * Test, are the same keys pressed. Order does not matter.
 */
export function sameKeys(comboAStr: string, comboBStr: string): boolean {
    return comboAStr.split('+').sort().join('+') === comboBStr.split('+').sort().join('+');
}
