import { BB } from '../../../../bb/bb';
import { TPointerEvent } from '../../../../bb/input/event.types';
import { TVector2D } from '../../../../bb/bb-types';
import { TViewportTransform } from '../../project-viewport/project-viewport';
import { createMatrixFromTransform } from '../../../../bb/transform/create-matrix-from-transform';
import { applyToPoint, inverse } from 'transformation-matrix';
import { createTransform } from '../../../../bb/transform/create-transform';
import { TEaselInterface, TEaselTool, TEaselToolTrigger } from '../easel.types';
import { minimizeAngleDeg } from '../../../../bb/math/math';
import { css } from '../../../../bb/base/base';

export type TEaselRotateParams = object;

export class EaselRotate implements TEaselTool {
    // ----------------------------------- 核心状态 -----------------------------------
    // 工具对应的 SVG 根节点（挂载到顶层 UI 上）
    private readonly svgEl: SVGElement;
    // 底层画架 API 的代理
    private easel: TEaselInterface = {} as TEaselInterface;

    // 拖拽状态记录
    private downPos: TVector2D | undefined = undefined; // 鼠标按下时的初始屏幕坐标
    private downTransform: TViewportTransform | undefined;// 鼠标按下时的画布变换矩阵备份

    // ----------------------------------- UI 组件 (指南针) -----------------------------------
    private readonly compassSize: number;
    private readonly compass: SVGElement;
    private readonly compassInner: SVGElement;
    private readonly compassBaseCircle: SVGElement;
    private readonly compassLineCircle: SVGElement;
    private readonly compassUpperTriangle: SVGElement;
    private readonly compassLowerTriangle: SVGElement;
    private readonly needleWrapper: SVGElement;

    // ----------------------------------- public -----------------------------------
    // 快捷键触发器：按下 'r' 键激活此工具
    tempTriggers: TEaselToolTrigger[] = ['r'];

    constructor(p: TEaselRotateParams) {
        // 核心是用代码画了一个半径 30px 的半透明红白指南针
        this.svgEl = BB.createSvg({
            elementType: 'g',
        });

        //rotation compass
        this.compassSize = 30;
        this.compass = BB.createSvg({
            elementType: 'g',
        });
        css(this.compass, {
            transition: 'opacity 0.25s ease-in-out',
        });
        this.compassInner = BB.createSvg({
            elementType: 'g',
        });
        this.compassBaseCircle = BB.createSvg({
            elementType: 'circle',
            fill: 'rgba(0,0,0,0.9)',
            stroke: 'none',
            cx: '0',
            cy: '0',
            r: '' + this.compassSize,
        });
        this.compassLineCircle = BB.createSvg({
            elementType: 'circle',
            fill: 'none',
            stroke: 'rgba(255,255,255,0.75)',
            'stroke-width': '1',
            cx: '0',
            cy: '0',
            r: '' + this.compassSize * 0.9,
        });
        css(this.compassLineCircle, {
            transition: 'opacity 0.1s ease-in-out',
        });
        this.needleWrapper = BB.createSvg({
            elementType: 'g',
            'transform-origin': '0 0',
        });
        this.compassUpperTriangle = BB.createSvg({
            elementType: 'path',
            fill: '#f00',
            stroke: 'none',
            d:
                'M -' +
                this.compassSize * 0.25 +
                ',0 ' +
                this.compassSize * 0.25 +
                ',0 0,-' +
                this.compassSize * 0.9 +
                ' z',
        });
        this.compassLowerTriangle = BB.createSvg({
            elementType: 'path',
            fill: '#fff',
            stroke: 'none',
            d:
                'M -' +
                this.compassSize * 0.25 +
                ',0 ' +
                this.compassSize * 0.25 +
                ',0 0,' +
                this.compassSize * 0.9 +
                ' z',
        });
        this.needleWrapper.append(this.compassUpperTriangle, this.compassLowerTriangle);

        this.compassInner.append(
            this.compassBaseCircle,
            this.compassLineCircle,
            this.needleWrapper,
        );
        this.compass.append(this.compassInner);
        this.svgEl.append(this.compass);
    }

    getSvgElement(): SVGElement {
        return this.svgEl;
    }

    // ==========================================
    // 核心交互：鼠标/触控笔事件处理器
    // ==========================================
    onPointer(e: TPointerEvent): void {
        // 1. 设置鼠标样式：没按住是张开的手(grab)，按住了是抓紧的手(grabbing)
        this.easel.setCursor(e.button === 'left' ? 'grabbing' : 'grab');

        if (e.type === 'pointerdown' && e.button === 'left') {
            // 【拖拽起点】：记录按下时的鼠标位置和当前的画布矩阵
            this.downPos = {
                x: e.relX,
                y: e.relY,
            };
            this.downTransform = BB.copyObj(this.easel.getTargetTransform());
        } else if (e.button === 'left' && this.downPos && this.downTransform) {
            // 【拖拽中】：计算“方向盘”旋转角度
            const { width, height } = this.easel.getSize();

            // 屏幕正中心
            const centerObj = {
                x: width / 2,
                y: height / 2,
            };

            // 核心数学运算：
            // A: 算出“屏幕中心”到“鼠标初始点”的向量角度
            const startAngleRad = BB.Vec2.angle(centerObj, this.downPos);
            // B: 算出“屏幕中心”到“当前鼠标点”的向量角度
            const newAngleRad = BB.Vec2.angle(centerObj, {
                x: e.relX,
                y: e.relY,
            });
            // 增量 = B - A，转为角度制
            const dAngleDeg = ((newAngleRad - startAngleRad) / Math.PI) * 180;
            let newAngleDeg = this.downTransform.angleDeg + dAngleDeg;

            // 【按住 Shift 键：开启 45 度磁吸】
            if (this.easel.isKeyPressed('shift')) {
                // 原理：除以 45 后四舍五入再乘回 45。例如 40度 会吸附到 45度，20度 会吸附到 0度。
                newAngleDeg = Math.round(newAngleDeg / 45) * 45;
            }
            // 角度标准化 (-180 到 180)
            newAngleDeg = minimizeAngleDeg(newAngleDeg); 

            // 【矩阵反解与重构】：确保旋转是以“屏幕正中心”为轴心
            //rotate transform
            const mat = createMatrixFromTransform(this.downTransform);
            const canvasPoint = applyToPoint(inverse(mat), centerObj);

            // 【应用更新】
            this.easel.setTransform(
                createTransform(centerObj, canvasPoint, this.downTransform.scale, newAngleDeg),
                // 神级 UX 细节：如果没按 Shift，代表自由拖拽，采用 immediate(瞬间同步) 无延迟。
                // 如果按了 Shift，返回 false，意味着系统会用一瞬间的缓动动画(Tween)平滑地“吸”到 45 度位置上！
                !this.easel.isKeyPressed('shift'),
            );
            this.easel.requestRender();
        } else if (e.type === 'pointerup' && this.downPos) {
            // 【拖拽结束】：清空状态
            this.downPos = undefined;
            this.downTransform = undefined;
        }
    }

    // ==========================================
    // UI 反馈层：响应画板真实的旋转变化
    // =========================================
    onUpdateTransform(transform: TViewportTransform): void {
        const targetTransform = this.easel.getTargetTransform();
        // 1. 让屏幕中央的“红白指针”跟着画布真实角度同步旋转
        this.needleWrapper.setAttribute('transform', 'rotate(' + transform.angleDeg + ')');
        // 2. 【正交提醒】：当角度是 90 的整数倍 (0, 90, 180, -90) 时，点亮指南针外圈 (opacity: 1)
        this.compassLineCircle.style.opacity = targetTransform.angleDeg % 90 === 0 ? '1' : '0';
    }

    setEaselInterface(easelInterface: TEaselInterface): void {
        this.easel = easelInterface;
    }

    // 当用户按下 R 键激活工具时
    activate(cursorPos?: TVector2D): void {
        this.easel.setCursor('grab');
        const { width, height } = this.easel.getSize();
        // 把指南针 SVG 移动到屏幕绝对正中心
        this.compass.setAttribute('transform', 'translate(' + width / 2 + ', ' + height / 2 + ')');
        this.onUpdateTransform(this.easel.getTransform());
    }

    // ==========================================
    // 键盘操作支持
    // ==========================================
    onKeyDown(keyStr: string, event: KeyboardEvent, comboStr: string) {
        if (['r+left', 'r+right'].includes(comboStr)) {
            // 按住 R 加左右方向键：精确微调 15 度 (带平滑过渡 true)
            if (keyStr === 'left') {
                this.easel.setAngleDeg(-15, true);
            }
            if (keyStr === 'right') {
                this.easel.setAngleDeg(15, true);
            }
        }
        if (['r+up'].includes(comboStr)) {
            // 按住 R 加上方向键：一键重置归零 (不叠加，直接设为绝对值 0)
            this.easel.setAngleDeg(0, false);
        }
    }

    onResize(width: number, height: number): void {
        // 窗口拉伸时，保持指南针永远在屏幕正中心
        this.compass.setAttribute('transform', 'translate(' + width / 2 + ', ' + height / 2 + ')');
    }
}
