import { BB } from '../../bb/bb';
import { BRUSHES } from '../brushes/brushes';
import { EVENT_RES_MS } from './brushes-consts';
import { KlSlider } from '../ui/components/kl-slider';
import { createPenPressureToggle } from '../ui/components/create-pen-pressure-toggle';
import { Checkbox } from '../ui/components/checkbox';
import brushIconImg from 'url:/src/app/img/ui/brush-eraser.svg';
import { TBrushUi } from '../kl-types';
import { LANG, LANGUAGE_STRINGS } from '../../language/language';
import { EraserBrush } from '../brushes/eraser-brush';

export const eraserBrushUi = (function () {
    const brushInterface = {
        // 1. 【静态元数据配置】：定义工具图标、快捷键提示语，以及滑块的极限约束
        image: brushIconImg,
        tooltip: LANG('eraser') + ' [E]',
        sizeSlider: {
            min: 0.5,
            max: 200,
            // 【核心 UX 黑魔法】：非线性样条曲线映射
            // 如果 0.5 ~ 200 是线性的，那 1px ~ 10px 这么常用且精细的区间在滑块上只占可怜的 5%，用户极难选中。
            // 通过 powerSplineInput 幂样条曲线，把前半段滑块的真实数值压缩，让微小尺寸拥有广阔的拖拽操作区！
            curve: BB.powerSplineInput(0.5, 200, 0.1),
        },
        opacitySlider: {
            // 最小 1%，避免 0% 导致画了没反应让人误以为程序卡死
            min: 1 / 100,
            max: 1,
        },
    } as TBrushUi<EraserBrush>;

    LANGUAGE_STRINGS.subscribe(() => {
        brushInterface.tooltip = LANG('eraser') + ' [E]';
    });

    brushInterface.Ui = function (p) {
        const div = document.createElement('div'); // the gui
        const brush = new BRUSHES.EraserBrush();
        brush.setHistory(p.klHistory);
        // 初始化时向全局广播当前笔尖大小
        p.onSizeChange(brush.getSize());

        let sizeSlider: KlSlider;
        let opacitySlider: KlSlider;
        let isTransparentBg = false;

        function setSize(size: number) {
            brush.setSize(size);
        }

        function init() {
            sizeSlider = new KlSlider({
                label: LANG('brush-size'),
                width: 225,
                height: 30,
                min: brushInterface.sizeSlider.min,
                max: brushInterface.sizeSlider.max,
                value: 30,
                curve: brushInterface.sizeSlider.curve,
                eventResMs: EVENT_RES_MS,
                toDisplayValue: (val) => val * 2,
                toValue: (displayValue) => displayValue / 2,
                onChange: (val) => {
                    setSize(val);
                    p.onSizeChange(val);
                },
                // 智能四舍五入：如果尺寸小于 10px，保留一位小数 (如 3.5px)；大于 10px 则四舍五入为整数
                formatFunc: (displayValue) => {
                    if (displayValue < 10) {
                        return BB.round(displayValue, 1);
                    } else {
                        return Math.round(displayValue);
                    }
                },
                manualInputRoundDigits: 1,
            });
            opacitySlider = new KlSlider({
                label: LANG('opacity'),
                width: 225,
                height: 30,
                min: brushInterface.opacitySlider.min,
                max: brushInterface.opacitySlider.max,
                value: brushInterface.opacitySlider.max,
                eventResMs: EVENT_RES_MS,
                toDisplayValue: (val) => val * 100,
                toValue: (displayValue) => displayValue / 100,
                onChange: (val) => {
                    brush.setOpacity(val);
                    p.onOpacityChange(val);
                },
            });

            const pressureSizeToggle = createPenPressureToggle(true, function (b) {
                brush.sizePressure(b);
            });
            const pressureOpacityToggle = createPenPressureToggle(false, function (b) {
                brush.opacityPressure(b);
            });

            div.append(
                BB.el({
                    content: [sizeSlider.getElement(), pressureSizeToggle],
                    css: {
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '10px',
                    },
                }),
                BB.el({
                    content: [opacitySlider.getElement(), pressureOpacityToggle],
                    css: {
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                    },
                }),
            );
            // --- 创建“橡皮擦透明背景”勾选框 ---
            // 如果勾选，直接将底图挖空成透明区域；如果不选，擦除效果为涂抹当前设定的背景色
            const transparencyToggle = new Checkbox({
                init: false,
                label: LANG('brush-eraser-transparent-bg'),
                callback: function (b) {
                    isTransparentBg = b;
                    brush.setTransparentBG(b);
                },
                css: {
                    marginTop: '10px',
                },
                name: 'transparency-toggle',
            });
            div.append(transparencyToggle.getElement());
        }

        init();

        this.increaseSize = function (f) {
            // 【安全拦截】：如果用户正按着手绘笔在画布上涂抹，绝不允许通过快捷键改变笔尖大小！
            if (!brush.isDrawing()) {
                sizeSlider.changeSliderValue(f);
            }
        };
        this.decreaseSize = function (f) {
            if (!brush.isDrawing()) {
                sizeSlider.changeSliderValue(-f);
            }
        };
        this.getSize = function () {
            return brush.getSize();
        };
        this.setSize = function (size) {
            setSize(size);
            sizeSlider.setValue(size);
        };
        this.getOpacity = function () {
            return brush.getOpacity();
        };
        this.setOpacity = function (opacity) {
            brush.setOpacity(opacity);
            opacitySlider.setValue(opacity);
        };
        // 橡皮擦不需要颜色，置为空函数但保持接口签名一致
        this.setColor = function () {};

        // 将底层核心绘图方法进行原样转发
        this.setLayer = function (layer) {
            brush.setLayer(layer);
        };
        this.startLine = function (x, y, p) {
            brush.startLine(x, y, p);
        };
        this.goLine = function (x, y, p) {
            brush.goLine(x, y, p);
        };
        this.endLine = function () {
            brush.endLine();
        };
        this.getBrush = function () {
            return brush;
        };
        this.getIsTransparentBg = function () {
            return isTransparentBg;
        };
        this.isDrawing = function () {
            return brush.isDrawing();
        };
        this.getElement = function () {
            return div;
        };
    } as TBrushUi<EraserBrush>['Ui'];

    return brushInterface;
})();
