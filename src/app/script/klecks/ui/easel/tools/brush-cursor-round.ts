import { BB } from '../../../../bb/bb';
import { TViewportTransform } from '../../project-viewport/project-viewport';
import { TVector2D } from '../../../../bb/bb-types';

export class BrushCursorRound {
    private readonly rootEl: SVGElement;

    // ----------------------------------- public -----------------------------------
    constructor() {
        // 创建一个 SVG 分组 <g>，里面包含一白一黑两个同心圆
        this.rootEl = BB.createSvg({
            elementType: 'g',
            childrenArr: [
                {
                    // 内层：半透明白色圆
                    elementType: 'circle',
                    cx: '0',
                    cy: '0',
                    fill: 'none',
                    stroke: 'rgba(255,255,255,0.7)',
                    'stroke-width': '1',
                },
                {
                    // 外层：半透明黑色圆
                    elementType: 'circle',
                    cx: '0',
                    cy: '0',
                    fill: 'none',
                    stroke: 'rgba(0,0,0,0.7)',
                    'stroke-width': '1',
                },
            ],
        });
    }

    /**
     * 更新圆形光标的位置和大小
     * @param transform 当前视图的变换状态（包含缩放 scale）
     * @param position  鼠标当前的物理屏幕坐标 (视口坐标)
     * @param size      笔刷的半径（画布坐标系下的实际半径）
     */
    update(transform: TViewportTransform, position: TVector2D, size: number): void {
        // 1. 更新内层白圆的半径
        // size * transform.scale : 将画布上的半径，按缩放比例放大/缩小到屏幕上的实际像素大小
        // - 1 : 让白圆比黑圆小 1 个屏幕像素，形成紧贴的内外双边框
        // Math.max(0, ...) : 防止画布缩得太小或笔刷太小时，半径变成负数导致 SVG 渲染报错
        BB.setAttributes(this.rootEl.children[0], {
            r: '' + Math.max(0, size * transform.scale - 1),
        });
        // 2. 更新外层黑圆的半径
        // 外层黑圆就是真实的笔刷边缘大小
        BB.setAttributes(this.rootEl.children[1], {
            r: '' + size * transform.scale,
        });
        // 3. 更新整个光标的位置
        // 因为圆笔不需要吸附像素网格，所以直接用 SVG 原生的 translate
        // 把两个圆的中心 (0,0) 直接平移到鼠标当前的物理屏幕坐标位置即可
        BB.setAttributes(this.rootEl, {
            transform: `translate(${position.x} ${position.y})`,
        });
    }

    getElement(): SVGElement {
        return this.rootEl;
    }
}
