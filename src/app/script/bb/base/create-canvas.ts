/*window['canvases'] = [];

window['printCanvases'] = () => {
    let total = 0;

    console.log(window['canvases'].map(item => {
        total += item.width * item.height;
        return {w: item.width, h: item.height};
    }));

    console.log('total: ' + (total * 4 / 1000 / 1000) + 'mb');
};*/

/**
 * 创建一个新的 canvas 元素
 * @param w - canvas 的宽度
 * @param h - canvas 的高度
 * @returns 创建的 canvas 元素
 */
export function createCanvas(w?: number, h?: number): HTMLCanvasElement {
    const result = document.createElement('canvas');
    if (w && h) {
        result.width = w;
        result.height = h;
    }
    // window['canvases'].push(result);
    return result;
}
