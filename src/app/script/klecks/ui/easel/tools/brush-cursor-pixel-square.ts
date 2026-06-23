import { BB } from '../../../../bb/bb';
import { TViewportTransform } from '../../project-viewport/project-viewport';
import { TVector2D } from '../../../../bb/bb-types';
import { setAttributes } from '../../../../bb/base/base';
import { applyToPoint, inverse } from 'transformation-matrix';
import { createMatrixFromTransform } from '../../../../bb/transform/create-matrix-from-transform';

// 渲染画笔的像素方块笔刷
export class BrushCursorPixelSquare {
    private readonly rootEl: SVGElement;

    // ----------------------------------- public -----------------------------------
    constructor() {
        // 创建一个包含两个路径的 SVG 组 (g)
        this.rootEl = BB.createSvg({
            elementType: 'g',
            childrenArr: [
                {
                    // 内层框：半透明白色
                    elementType: 'path',
                    fill: 'none',
                    stroke: 'rgba(255,255,255,0.7)',
                    'stroke-width': '1',
                },
                {
                    // 外层框：半透明黑色
                    elementType: 'path',
                    fill: 'none',
                    stroke: 'rgba(0,0,0,0.7)',
                    'stroke-width': '1',
                },
            ],
        });
    }

    /**
     * 当鼠标移动、画布缩放或笔刷大小改变时调用，用于更新光标位置和形状
     * @param transform 当前视图的变换信息（缩放比例、平移偏移量）
     * @param position 鼠标在屏幕/视口上的实时坐标
     * @param size 笔刷的半径（size * 2 = 笔刷宽度）
     */
    update(transform: TViewportTransform, position: TVector2D, size: number): void {
        // 1. 根据当前视图的缩放和平移，生成转换矩阵
        const mat = createMatrixFromTransform(transform);

        // 确保 size 能够以 0.5 为单位（即宽度必须是整数）
        size = Math.round(size * 2) / 2;
        const width = Math.round(size * 2);

        // 3. 核心：像素网格吸附逻辑
        // 如果宽度是偶数，中心点吸附到整数网格线上 (Math.round)
        // 如果宽度是奇数，中心点吸附到像素方块的正中心 (Math.floor + 0.5)
        // ! 这确保了操作时永远对准一个像素方块的中心，从而得到绝对锐利的边缘
        const canvasCenter = applyToPoint(inverse(mat), position);
        canvasCenter.x =
            width % 2 === 0 ? Math.round(canvasCenter.x) : Math.floor(canvasCenter.x) + 0.5;
        canvasCenter.y =
            width % 2 === 0 ? Math.round(canvasCenter.y) : Math.floor(canvasCenter.y) + 0.5;

        // --- 绘制第一个框（外层黑框） ---
        {
            // 在画布坐标系下，计算出正方形四个顶点的坐标，最后回到起点闭合
            const canvasPoints: [number, number][] = [
                [canvasCenter.x - size, canvasCenter.y - size],
                [canvasCenter.x + size, canvasCenter.y - size],
                [canvasCenter.x + size, canvasCenter.y + size],
                [canvasCenter.x - size, canvasCenter.y + size],
                [canvasCenter.x - size, canvasCenter.y - size],
            ];
            // 将画布坐标正向转换回屏幕（视口）坐标，以便在 SVG 中正确显示
            const viewportPoints = canvasPoints.map((point) => {
                return applyToPoint(mat, point);
            });

            // 拼接 SVG 的 Path 数据 (例如 "M 10,10 20,10 20,20 ...")
            let path = 'M ';
            viewportPoints.forEach((point) => {
                path += point.join(',') + ' ';
            });
            // 更新第二个子元素（黑框）的路径
            setAttributes(this.rootEl.children[1] as Element, {
                d: path,
            });
        }
        // --- 绘制第二个框（内层白框） ---
        {
            // 计算屏幕上的 1 像素，相当于真实画布上的多少单位距离
            // 这个变量非常巧妙，它保证了无论画布放大多少倍，内外框之间的间距在屏幕上永远看起来只有 1px
            const viewport1px = 1 / transform.scale;
            // 顶点坐标逻辑与上面一致，但每个点都向内收缩了 viewport1px 的距离
            const canvasPoints: [number, number][] = [
                [canvasCenter.x - size + viewport1px, canvasCenter.y - size + viewport1px],
                [canvasCenter.x + size - viewport1px, canvasCenter.y - size + viewport1px],
                [canvasCenter.x + size - viewport1px, canvasCenter.y + size - viewport1px],
                [canvasCenter.x - size + viewport1px, canvasCenter.y + size - viewport1px],
                [canvasCenter.x - size + viewport1px, canvasCenter.y - size + viewport1px],
            ];
            const viewportPoints = canvasPoints.map((point) => {
                return applyToPoint(mat, point);
            });

            let path = 'M ';
            viewportPoints.forEach((point) => {
                path += point.join(',') + ' ';
            });
            // 更新第一个子元素（白框）的路径
            setAttributes(this.rootEl.firstChild as Element, {
                d: path,
            });
        }
    }

    // 暴露根 DOM 节点供外部挂载到文档中
    getElement(): SVGElement {
        return this.rootEl;
    }
}
