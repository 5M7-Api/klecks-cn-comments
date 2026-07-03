import { TViewportTransform } from '../project-viewport/project-viewport';
import { MultiPolygon, Pair } from 'polygon-clipping';
import { BB } from '../../../bb/bb';
import * as classes from './selection-renderer.module.scss';
import { Matrix } from 'transformation-matrix';
import { createMatrixFromTransform } from '../../../bb/transform/create-matrix-from-transform';
import { getSvgPathD } from '../../../bb/multi-polygon/get-selection-path-2d';
import { transformMultiPolygon } from '../../../bb/multi-polygon/transform-multi-polygon';
import { clipMultiPolygon } from '../../../bb/multi-polygon/apply-polygon-clipping';

export type TSelectionRendererParams = {
    transform: TViewportTransform;
    selection?: MultiPolygon;
    width: number; // size of viewport
    height: number; // size of viewport
};

/**
 * 让直角矩形的选区边缘更清晰。
 *
 * 原理：SVG 线条绘制在像素边界上时会产生半像素模糊（抗锯齿）。
 * 把坐标移到 x.5 / y.5（像素中心）可以让 1px 线条落在单个像素内，
 * 视觉上更锐利，类似 CSS 中 translate(0.5px, 0.5px) 的作用。
 *
 * 例：坐标 100 → Math.round(100.5) - 0.5 = 100.5
 *     坐标 100.3 → Math.round(100.8) - 0.5 = 100.5（对齐到最近的 .5）
 */
// makes right angle rects look more crisp
export function roundPoly(multiPolygon: MultiPolygon): MultiPolygon {
    return multiPolygon.map((poly) => {
        return poly.map((ring) => {
            return ring.map((point) => {
                return [Math.round(point[0] + 0.5) - 0.5, Math.round(point[1] + 0.5) - 0.5] as Pair; // on .5
            });
        });
    });
}

/**
 * SelectionRenderer — 选区"蚂蚁线"渲染器
 *
 * 职责：把画布坐标系下的选区数据（MultiPolygon）渲染为 SVG 覆盖层上的
 * 可见边框线，并随视口变换（缩放/平移/旋转）实时更新。
 *
 * 不负责：选区的编辑逻辑、命中检测、历史记录。只是纯粹的渲染器。
 *
 * DOM 结构：
 *   <g>                  ← rootEl，挂到 Easel 的 svgEl 里
 *     <path class="whitePath" />   ← 白色线（底层）
 *     <path class="blackPath" />   ← 黑色虚线（顶层）
 *   </g>
 *
 * 蚂蚁线效果：两条路径共用同一个 d（完全重叠），通过 CSS 动画
 * 分别偏移 stroke-dashoffset，产生黑白交替流动的视觉效果：
 *
 *   whitePath: stroke-dasharray:4, dashoffset 从 0→8（1.5s循环）
 *   blackPath: stroke-dasharray:4, dashoffset 从 4→12（与白色错开半个周期）
 *
 * 结果：任何背景颜色下选区边框都清晰可见。
 */
export class SelectionRenderer {
    // SVG <g> 容器，直接 append 到 Easel 的 svgEl
    private readonly rootEl: SVGElement;
    // 白色路径（在下），配合黑色路径产生对比，深色背景下可见
    private readonly svgPath1: SVGPathElement;
    // 黑色路径（在上），浅色背景下可见
    private readonly svgPath2: SVGPathElement;

     // 当前视口变换（平移/缩放/旋转），用于把画布坐标转成屏幕坐标
    private viewportTransform: TViewportTransform;
    // viewportTransform 对应的矩阵形式，避免每次 update() 重复计算
    private viewportMat: Matrix;

    // 真实的选区数据
    private selection: undefined | MultiPolygon; // selection of project

    /**
     * 临时覆盖用的预览选区。
     * - null：不覆盖，使用 this.selection
     * - undefined：覆盖为"无选区"
     * - MultiPolygon：覆盖为指定选区（用于拖拽时的实时预览）
     *
     * 为什么需要这个：拖拽选区工具时，框还没松手，不能修改真实选区，
     * 但需要实时显示预览。用这个字段临时覆盖，松手后再写回 selection。
     */
    private renderedSelection: null | undefined | MultiPolygon = null; // overwrites this.selection, unless it's null
    private viewportWidth: number;
    private viewportHeight: number;

    /**
     * 核心渲染方法，每次选区数据或视口变换改变时调用。
     * 把画布坐标系的选区转换为屏幕坐标，写入两条 SVG 路径的 d 属性。
     */
    private update(): void {
         // renderedSelection 不为 null 时优先使用（临时预览），否则用真实选区
        const selection = this.renderedSelection === null ? this.selection : this.renderedSelection;

        // 无选区时清空路径，不渲染任何内容
        if (!selection) {
            this.svgPath1.setAttribute('d', '');
            this.svgPath2.setAttribute('d', '');
            return;
        }

        // 第一步：坐标变换 — 画布坐标 → 屏幕坐标
        // 把 MultiPolygon 的每个顶点乘以视口矩阵，结果是屏幕坐标系的多边形。
        // 注：本应用 SVG 的 non-scaling-stroke 让线宽不随缩放变化，
        // 但 Firefox 对此有渲染 bug，所以改为手动变换顶点，线宽固定写死。
        // firefox has problems with non-scaling-stroke, so we scale manually.
        // ^ it has visual glitches when the transformation changes.
        const transformedSelection = transformMultiPolygon(selection, this.viewportMat);

        // 第二步：视口裁剪 — 去掉视口外的部分
        // Firefox 在深度缩放时，渲染超出视口的超长路径性能极差（推测是没有内部裁剪）。
        // 用视口矩形（加 10px padding 避免边缘截断）手动裁剪，只保留可见部分。
        // Firefox has bad performance when zoomed in far (guess: it doesn't clip the path)
        // So we clip manually.
        const clipPadding = 10;
        const clippedSelection = clipMultiPolygon(transformedSelection, [
            [-clipPadding, -clipPadding],
            [this.viewportWidth + clipPadding, -clipPadding],
            [this.viewportWidth + clipPadding, this.viewportHeight + clipPadding],
            [-clipPadding, this.viewportHeight + clipPadding],
            [-clipPadding, -clipPadding],
        ]);

        // 第三步：生成 SVG path d 属性字符串，同时对直角边做半像素对齐
        // roundPoly 把顶点对齐到 x.5/y.5，让直角选区边缘更锐利
        const d = getSvgPathD(roundPoly(clippedSelection));
        // 两条路径写入同一个 d，它们完全重叠，依靠 CSS 动画产生蚂蚁线效果
        this.svgPath1.setAttribute('d', d);
        this.svgPath2.setAttribute('d', d);
    }

    // ----------------------------------- public -----------------------------------
    constructor(p: TSelectionRendererParams) {

        this.viewportTransform = p.transform;
        // 提前把 transform 转成矩阵，后续 update() 直接复用
        this.viewportMat = createMatrixFromTransform(this.viewportTransform);
        this.selection = p.selection;
        this.viewportWidth = p.width;
        this.viewportHeight = p.height;

        // 白色路径：stroke: white，作为底层，深色背景下提供对比
        this.svgPath1 = BB.createSvg({
            elementType: 'path',
            // 线宽不随 SVG 缩放变化（Firefox 有 bug，实际靠手动变换）
            'vector-effect': 'non-scaling-stroke',
        }) as SVGPathElement;
        // CSS 动画：dashoffset 0→8
        this.svgPath1.classList.add(classes.whitePath);

         // 黑色路径：stroke: black，叠在白色路径上方，浅色背景下提供对比
        this.svgPath2 = BB.createSvg({
            elementType: 'path',
            'vector-effect': 'non-scaling-stroke',
        }) as SVGPathElement;
        // CSS 动画：dashoffset 4→12（与白色错开半个周期）
        this.svgPath2.classList.add(classes.blackPath);
        // 用 <g> 把两条路径包起来，对外只暴露一个根元素
        this.rootEl = BB.createSvg({
            elementType: 'g',
        });
        this.rootEl.append(this.svgPath1, this.svgPath2);
    }

    /**
     * 视口变换改变时调用（缩放、平移、旋转）。
     * 同步更新矩阵并重新渲染，让选区边框跟随画布移动。
     */
    setTransform(transform: TViewportTransform): void {
        this.viewportTransform = transform;
        this.viewportMat = createMatrixFromTransform(this.viewportTransform);
        this.update();
    }

    /**
     * 更新项目的真实选区。
     * 如果当前有临时预览选区（renderedSelection !== null），
     * 不立即重渲染，等预览结束后自然生效，避免闪烁。
     */
    setSelection(selection?: MultiPolygon): void {
        // debug
        // console.log('SelectionRenderer 真实选区更新: ' );
        // console.dir(selection);

        if (this.selection === selection) {
            // 引用相同，数据没变，跳过
            return;
        }
        this.selection = selection;
        // renderedSelection !== null 时屏幕上显示的是预览选区，
        // 真实选区的变化不需要立即体现，等 clearRenderedSelection() 后自然生效
        // only need to update when this.selection is used
        if (this.renderedSelection === null) {
            this.update();
        }
    }

    /**
     * 设置临时预览选区（覆盖真实选区显示）。
     * 用于选区工具拖拽时的实时预览，不修改真实选区数据。
     *
     * @param renderedSelection undefined 表示预览"无选区"状态
     */
    // overwrite project selection
    setRenderedSelection(renderedSelection?: MultiPolygon, isImmediate?: boolean): void {
        // debug
        // console.log('SelectionRenderer 预览选区更新: ' );
        // console.dir(renderedSelection);

        if (this.renderedSelection === renderedSelection) {
            return;
        }
        this.renderedSelection = renderedSelection;
        this.update();
    }

    /**
     * 清除临时预览选区，恢复显示真实选区。
     *
     * @param isImmediate false（默认）：延迟到下次 setSelection 时更新，避免松手瞬间闪烁
     *                    true：立即重渲染
     */
    // render project selection again
    clearRenderedSelection(isImmediate?: boolean): void {
        this.renderedSelection = null;
        if (!isImmediate) {
            // good enough to update on next setSelection. (to prevent flickering)
            return;
        }
        this.update();
    }

     /** 视口尺寸变化时更新，影响裁剪区域的计算 */
    setSize(width: number, height: number): void {
        this.viewportWidth = width;
        this.viewportHeight = height;
    }

    getElement(): SVGElement {
        return this.rootEl;
    }

    destroy(): void {
        this.rootEl.remove();
        this.selection = undefined;
    }
}
