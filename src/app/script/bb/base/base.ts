import { TKeyString, TSize2D, TSvg, TVector2D } from '../bb-types';

export function insertAfter(referenceNode: Element, newNode: Element): void {
    if (referenceNode.parentNode) {
        referenceNode.parentNode.insertBefore(newNode, referenceNode.nextSibling);
    }
}

export function loadImage(im: HTMLImageElement, callback: () => void): void {
    let counter = 0;

    function check(): void {
        if (counter === 1000) {
            alert("couldn't load");
            return;
        }
        if (im.complete) {
            counter++;
            callback();
        } else {
            setTimeout(check, 1);
        }
    }

    check();
}

export function asyncLoadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

// 用来批量设置dom样式的
export function css(el: HTMLElement | SVGElement, styleObj: Partial<CSSStyleDeclaration>): void {
    const elStyle: any = el.style;
    Object.keys(styleObj).forEach((key) => {
        const property = key as keyof CSSStyleDeclaration;
        elStyle[property] = styleObj[property];
        if (property === 'userSelect') {
            elStyle.webkitUserSelect = styleObj[property]; // Safari support
        }
    });
}

export function setAttributes(el: Element, attrObj: TKeyString): void {
    const keyArr = Object.keys(attrObj);
    let keyStr;
    for (let i = 0; i < keyArr.length; i++) {
        keyStr = keyArr[i];
        el.setAttribute(keyStr, attrObj[keyStr]);
    }
}

/**
 * append a list to DOM element
 */
export function append(target: HTMLElement, els: (HTMLElement | string | undefined)[]): void {
    const fragment = document.createDocumentFragment();
    els.forEach((item) => item && fragment.append(item));
    target.append(fragment);
}

/**
 * 【核心几何算子：边界框适应等比缩放 (Fit-to-Box / Contain Scaling)】
 * 将任意尺寸的源图像或画布，按照原始宽高比完美缩放并居中塞入一个既定的限制框内。
 * 
 * @param aw Actual Width - 源图/源画布的绝对真实物理宽度 (如 4000px)
 * @param ah Actual Height - 源图/源画布的绝对真实物理高度 (如 1000px)
 * @param bw Bounding Width - 目标容器/限制框的最大允许宽度 (如缩略图槽位 30px)
 * @param bh Bounding Height - 目标容器/限制框的最大允许高度 (如缩略图槽位 30px)
 * @param min [可选] 最小安全像素阈值 - 防止极端长宽比在缩放后计算出 0px 或无限小数值导致显存崩溃
 * @returns TSize2D 经过化归计算后，完美适应容器且绝不形变的最终 { width, height }
 */
/**
 * a needs to fit into b
 */
export function fitInto(aw: number, ah: number, bw: number, bh: number, min?: number): TSize2D {
    // 1. 【降维放大映射】：
    // 这里并没有先算缩放比例 (scale = bw / aw)，而是故意先把源宽高同时乘上容器宽度 bw。
    // 只要源图宽度 aw >= 1，这里的 width 一定都会远远大于 target bw，
    // 从而保证接下来绝对会无条件触发第一个 if 的“X 轴挤压化归”！
    let width = aw * bw,
        height = ah * bw;
    // 2. 【第一道关卡：X 轴越界挤压 (Width Normalization)】
    // 如果算出的虚拟宽度超出了边界框的限制：
    if (width > bw) {
        // 利用同等比例 (bw / width)，把高度也等比例打折压缩
        // 数学本质：height = (bw / (aw * bw)) * (ah * bw) = (ah / aw) * bw
        height = (bw / width) * height;
        width = bw;
    }
    // 3. 【第二道关卡：Y 轴越界挤压 (Height Normalization)】
    // 经过第一关后，如果这本来是一张“竖条长图”，即使宽度缩到了 bw，其高度可能依然高于限制框 bh！
    if (height > bh) {
        width = (bh / height) * width;
        height = bh;
    }
    // 4. 【硬件渲染安全钳制 (Sub-pixel & 0px Defense)】
    // 极其关键的防御性编程！当试图把一张 10000x1 的极端细长线条缩放到 30x30 框里时：
    // 宽度缩为 30px，高度会被等比压缩为 0.003px！
    // 任何低于 1px 的高宽度如果交给 Canvas 2D 或 WebGL 去分配显存，底层图形驱动都会因为 "0x0 size" 直接崩溃报废。
    if (min) {
        width = Math.max(min, width);
        height = Math.max(min, height);
    }
    // 5. 返回量体裁衣后的物理安全分辨率
    return { width, height };
}

/**
 * center b in a
 * @param aw
 * @param ah
 * @param bw
 * @param bh
 */
export function centerWithin(aw: number, ah: number, bw: number, bh: number): TVector2D {
    return {
        x: aw / 2 - bw / 2,
        y: ah / 2 - bh / 2,
    };
}

export function getDate(): string {
    const date = new Date();
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const minutes = (date.getHours() * 60 + date.getMinutes()).toString(36).padStart(3, '0');

    return year + '_' + month + '_' + day + '_' + minutes + '_';
}

export function gcd(a: number, b: number): number {
    return b ? gcd(b, a % b) : a;
}

export function reduce(numerator: number, denominator: number): [number, number] {
    const g = gcd(numerator, denominator);
    return [numerator / g, denominator / g];
}

export function decToFraction(decimalNumber: number): [number, number] {
    const len = decimalNumber.toString().length - 2;
    const denominator = Math.pow(10, len);
    const numerator = decimalNumber * denominator;
    return reduce(numerator, denominator);
}

export function isBlob(maybeBlob: unknown): maybeBlob is Blob {
    return (
        maybeBlob instanceof Blob || Object.prototype.toString.call(maybeBlob) === '[object Blob]'
    );
}

/**
 * blobObj isn't always a Blob, but rather an object, because Blob doesn't exist.
 * @param blobObj
 * @returns {string}
 */
export function imageBlobToUrl(blobObj: Blob): string {
    if (!blobObj) {
        throw new Error('blobObj is undefined or null');
    }
    if (window.Blob && blobObj instanceof Blob) {
        return URL.createObjectURL(blobObj); // object url
    } else if (blobObj.constructor.name === 'Object') {
        const fauxBlob = blobObj as unknown as {
            type: string;
            encoding: string;
            data: string;
        };
        return 'data:' + fauxBlob.type + ';' + fauxBlob.encoding + ',' + fauxBlob.data; // data url
    } else {
        throw new Error('unknown blob format');
    }
}

export function dateDayDifference(dateA: string | Date, dateB: string | Date): number {
    dateA = new Date(dateA);
    dateB = new Date(dateB);
    dateA.setHours(0, 0, 0, 0);
    dateB.setHours(0, 0, 0, 0);
    return (dateB.getTime() - dateA.getTime()) / (1000 * 60 * 60 * 24);
}

export function copyObj<T>(obj: T): T {
    // structuredClone became available around 2022. Let's wait a bit longer for it.
    return JSON.parse(JSON.stringify(obj));
}

/**
 * triggers Web Share API - share feature on mobile devices
 * Only works if they support file sharing - e.g. Safari can't do this yet
 * only call if BB.canShareFiles() -> true
 *
 * p = {
 *     canvas: Canvas,
 *     fileName: string,
 *     title: string
 * }
 *
 * @param p
 */
export function shareCanvas(p: {
    canvas: HTMLCanvasElement;
    fileName: string;
    title: string;
    callback: () => void;
}): void {
    const mimetype = 'image/png';
    const err = (): void => alert('sharing not supported');
    p.canvas.toBlob(function (blob) {
        if (!blob) {
            err();
            p.callback();
            return;
        }
        try {
            const filesArray = [new File([blob], p.fileName, { type: mimetype })];
            navigator
                .share({
                    title: p.title,
                    files: filesArray,
                } as any)
                .then(() => {})
                .catch(() => {
                    err();
                });
        } catch (e) {
            err();
        }
        p.callback();
    }, mimetype);
}

/**
 * Prevent ipad from zooming in when double tapping. iPadOS 13 bug.
 * Give it your click event
 *
 * Can have GLOBAL EFFECT!
 *
 * @param clickEvent
 * @returns {boolean}
 */
export function handleClick(clickEvent: Event): boolean {
    const target: HTMLElement | null = clickEvent.target as HTMLElement;
    if (!target) {
        return false;
    }
    let el: HTMLElement | null = target;
    while (el) {
        if (['A', 'LABEL', 'INPUT', 'SUMMARY'].includes(el.tagName)) {
            return true;
        }
        el = el.parentElement;
    }
    clickEvent.preventDefault();
    return false;
}

export function createSvg(p: TSvg): SVGElement {
    const result = document.createElementNS('http://www.w3.org/2000/svg', p.elementType);
    Object.entries(p).forEach(([keyStr, item]) => {
        if (keyStr === 'childrenArr') {
            (item as TSvg[]).forEach((child) => {
                result.append(createSvg(child));
            });
        } else if (keyStr === 'css') {
            css(result, item as Partial<CSSStyleDeclaration>);
        } else if (keyStr !== 'elementType') {
            result.setAttribute(keyStr, item as string);
        }
    });
    return result;
}

export function throwIfNull<T>(v: T | null): T {
    // (disabled) eslint-disable-next-line no-null/no-null
    if (v === null) {
        throw new Error('value is null');
    }
    return v;
}

export function throwIfUndefined<T>(v: T | undefined, message = 'value is undefined'): T {
    if (v === undefined) {
        throw new Error(message);
    }
    return v;
}

export function nullToUndefined<T>(v: T | null): T | undefined {
    return v === null ? undefined : v;
}

const matchMediaDark =
    'matchMedia' in window ? window.matchMedia('(prefers-color-scheme: dark)') : false;

export function isDark(): boolean {
    return matchMediaDark && matchMediaDark.matches;
}

export function addIsDarkListener(func: () => void): void {
    matchMediaDark &&
        'addEventListener' in matchMediaDark &&
        matchMediaDark.addEventListener('change', func);
}

export function removeIsDarkListener(func: () => void): void {
    matchMediaDark &&
        'removeEventListener' in matchMediaDark &&
        matchMediaDark.removeEventListener('change', func);
}

export function base64ToBlob(base64Str: string): Blob {
    const parts = base64Str.match(/data:([^;]*)(;base64)?,([0-9A-Za-z+/]+)/) as [
        string,
        string,
        string,
        string,
    ];
    const binStr = atob(parts[3]);
    const buf = new ArrayBuffer(binStr.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < view.length; i++) {
        view[i] = binStr.charCodeAt(i);
    }
    return new Blob([view], { type: parts[1] });
}

export function createArray<T>(length: number, fillValue: T): T[] {
    return new Array(length).fill(fillValue);
}

export function randomUuid(): string {
    if ('randumUUID' in crypto) {
        return crypto.randomUUID();
    }
    // fallback just for dev
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = (Math.random() * 16) | 0,
            v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

export function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// if a promise takes too long
export async function timeoutWrapper<G>(
    promise: Promise<G>,
    name: string,
    timeoutMs: number = 5000,
): Promise<G> {
    return Promise.race<G>([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Promise "${name}" timed out.`)), timeoutMs);
        }),
    ]);
}

export async function loadSvg(url: string): Promise<SVGSVGElement> {
    const response = await fetch(url);
    const svgText = await response.text();

    const parser = new DOMParser();
    const doc = parser.parseFromString(svgText, 'image/svg+xml');
    const svg = doc.querySelector('svg');

    if (!svg) {
        throw new Error('No <svg> found in the file');
    }

    // Optional: Clone to prevent reusing the same node
    return svg.cloneNode(true) as SVGSVGElement;
}
