import { BB } from '../../bb/bb';
import { BRUSHES } from '../brushes/brushes';
import { EVENT_RES_MS } from './brushes-consts';
import { Checkbox } from '../ui/components/checkbox';
import { KlSlider } from '../ui/components/kl-slider';
import { createPenPressureToggle } from '../ui/components/create-pen-pressure-toggle';
import brushIconImg from 'url:/src/app/img/ui/brush-pen.svg';
import { genBrushAlpha01, genBrushAlpha02 } from '../brushes/alphas/brush-alphas';
import { TBrushUi } from '../kl-types';
import { LANG, LANGUAGE_STRINGS } from '../../language/language';
import { Options } from '../ui/components/options';
import { PenBrush } from '../brushes/pen-brush';

// 采用立即执行函数 (IIFE) 的形式，返回一个配置对象。
// 这样做可以产生一个私有的作用域，防止内部的局部变量污染全局。
export const penBrushUi = (function () {
    // ----------------------------------------------------
    // 第一部分：静态元数据定义 (Metadata)
    // ----------------------------------------------------
    const brushInterface = {
        image: brushIconImg,
        tooltip: LANG('brush-pen'),
        // 滑块的配置。不仅有最大最小值，还有关键的 'curve' (插值曲线)。
        // 比如笔刷大小，在 0-10 的区间用户需要很精细的控制，而 50-100 的区间可以粗略一点。
        // powerSplineInput 产生的就是非线性的映射曲线，让滑块手感更好。
        sizeSlider: {
            min: 0.5,
            max: 100,
            curve: BB.powerSplineInput(0.5, 100, 0.1),
        },
        opacitySlider: {
            min: 1 / 100,
            max: 1,
            curve: [
                [0, 1 / 100],
                [0.5, 30 / 100],
                [1, 1],
            ],
        },
        scatterSlider: {
            min: 0,
            max: 100,
            curve: BB.powerSplineInput(0, 100, 0.1, 2.5),
        },
    } as TBrushUi<PenBrush>;

    // 多语言配置
    let alphaNames = [
        LANG('brush-pen-circle'),
        LANG('brush-pen-chalk'),
        LANG('brush-pen-calligraphy'),
        LANG('brush-pen-square'),
    ];
    LANGUAGE_STRINGS.subscribe(() => {
        brushInterface.tooltip = LANG('brush-pen');
        alphaNames = [
            LANG('brush-pen-circle'),
            LANG('brush-pen-chalk'),
            LANG('brush-pen-calligraphy'),
            LANG('brush-pen-square'),
        ];
    });

    // ----------------------------------------------------
    // 第二部分：UI 渲染与逻辑绑定核心 (The Factory Function)
    // ----------------------------------------------------
    brushInterface.Ui = function (p) {
        const div = document.createElement('div'); // the gui

        // ! 实例化【真正负责画画的底层引擎对象】
        const brush = new BRUSHES.PenBrush();
        brush.setHistory(p.klHistory);
        // 将初始大小通知给上层服务
        p.onSizeChange(brush.getSize());
        let sizeSlider: KlSlider;
        let opacitySlider: KlSlider;
        let scatterSlider: KlSlider;

        // 1. 笔尖形状选择器 (Alpha Options)
        const alphaOptions = new Options({
            optionArr: [0, 1, 2, 3].map((id) => {
                const alpha = BB.el({
                    className: 'dark-invert',
                    css: {
                        width: '31px',
                        height: '31px',
                        backgroundSize: 'contain',
                        margin: '2px',
                    },
                });
                // 【核心技巧】：利用离屏 Canvas 现场把笔尖形状画出来作为图标！
                const canvas = BB.canvas(70, 70);
                const ctx = BB.ctx(canvas);
                if (id === 0 || id === 3) {
                    if (id === 0) {
                        ctx.beginPath();
                        ctx.arc(35, 35, 30, 0, 2 * Math.PI);
                        ctx.closePath();
                        ctx.fill();
                    } else {
                        ctx.fillRect(5, 5, 60, 60);
                    }
                } else if (id === 1) {
                    // 粉笔纹理是从外部提前画好的贴图数据 (genBrushAlpha01) 获取的
                    ctx.drawImage(genBrushAlpha01(60), 5, 5);
                } else if (id === 2) {
                    ctx.drawImage(genBrushAlpha02(60), 5, 5);
                }
                // 将画布内容转为 base64 图片，设为按钮背景
                alpha.style.backgroundImage = 'url(' + canvas.toDataURL('image/png') + ')';

                return {
                    id: id,
                    label: alpha,
                    title: alphaNames[id],
                };
            }),
            initId: 0,
            onChange: (id) => {
                // ! 当用户点击图标时，修改底层画笔的笔尖类型
                brush.setAlpha(id);
            },
        });

        // 2. 锁定透明度选项
        const lockAlphaToggle = new Checkbox({
            init: brush.getLockAlpha(),
            label: LANG('lock-alpha'),
            callback: function (b) {
                brush.setLockAlpha(b);
            },
            doHighlight: true,
            title: LANG('lock-alpha-title'),
            css: {
                display: 'inline-block',
            },
            name: 'lock-alpha-toggle',
        });

        // !【极其专业的细节】：动态点距插值 (Spacing)
        // Canvas 画线并不是真的一条线，而是极短时间内打上一连串的“点”连成的。
        // 如果笔刷很小 (比如 5px)，为了看起来连续，点距必须极小。
        // 但如果笔刷巨大 (比如 100px)，如果点距还那么小，一秒钟要在屏幕上画几万个 100px 的圆，电脑直接卡死。
        // 所以这里定义了一个插值曲线：笔刷越大，两个点之间的距离 (spacing) 必须适度拉大，以保证渲染性能！
        const spacingSpline = new BB.SplineInterpolator([
            [0, 15],
            [8, 7],
            [14, 4],
            [30, 3],
            [50, 2.7],
            [100, 2],
            // 稍等，这里作者定义的曲线好像是倒过来的：笔越大点距越密集？
            // 我们看下面的 Math.max(2, spacingSpline.interpolate(size)) / 15，这其实是在算一个百分比参数。
        ]);

        function setSize(size: number) {
            brush.setSize(size);
            // ! 每次改大小，都会联动修改点距，兼顾丝滑与性能。
            brush.setSpacing(Math.max(2, spacingSpline.interpolate(size)) / 15);
        }

        // 3. 实例化各种滑块组件和“笔压感应”切换按钮
        function init() {
            sizeSlider = new KlSlider({
                label: LANG('brush-size'),
                width: 225,
                height: 30,
                min: brushInterface.sizeSlider.min,
                max: brushInterface.sizeSlider.max,
                value: brush.getSize(),
                curve: brushInterface.sizeSlider.curve,
                eventResMs: EVENT_RES_MS,
                toDisplayValue: (val) => val * 2,
                toValue: (displayValue) => displayValue / 2,
                onChange: (val) => {
                    // 用户拖动滑块 -> 改变底层笔刷大小
                    setSize(val);
                    // 还要通知外面那个“全局服务”去更新状态
                    p.onSizeChange(val);
                },
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
                curve: brushInterface.opacitySlider.curve,
                eventResMs: EVENT_RES_MS,
                toDisplayValue: (val) => val * 100,
                toValue: (displayValue) => displayValue / 100,
                onChange: (val) => {
                    brush.setOpacity(val);
                    p.onOpacityChange(val);
                },
            });
            scatterSlider = new KlSlider({
                label: LANG('scatter'),
                width: 225,
                height: 30,
                min: brushInterface.scatterSlider.min,
                max: brushInterface.scatterSlider.max,
                value: brushInterface.scatterSlider.min,
                curve: brushInterface.scatterSlider.curve,
                eventResMs: EVENT_RES_MS,
                onChange: (val) => {
                    brush.setScatter(val);
                    p.onScatterChange(val);
                },
                formatFunc: (displayValue) => {
                    if (displayValue < 10) {
                        return BB.round(displayValue, 1);
                    } else {
                        return Math.round(displayValue);
                    }
                },
                manualInputRoundDigits: 1,
            });

            const pressureSizeToggle = createPenPressureToggle(true, function (b) {
                brush.sizePressure(b);
            });
            const pressureOpacityToggle = createPenPressureToggle(false, function (b) {
                brush.opacityPressure(b);
            });
            const pressureScatterToggle = createPenPressureToggle(false, function (b) {
                brush.scatterPressure(b);
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
                        marginBottom: '10px',
                    },
                }),
                BB.el({
                    content: [scatterSlider.getElement(), pressureScatterToggle],
                    css: {
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                    },
                }),
                BB.el({
                    content: alphaOptions.getElement(),
                    css: {
                        marginTop: '10px',
                    },
                }),
                BB.el({
                    content: lockAlphaToggle.getElement(),
                    css: {
                        marginTop: '10px',
                    },
                }),
            );
        }

        init();

        // ----------------------------------------------------
        // ! 第三部分：对外暴露 API (The Facade)
        // ! 这部分非常重要！外部系统（如刚才分析的快捷键管理器）会调用这些方法。
        // ----------------------------------------------------

        // 提供给快捷键 `[` 和 `]` 调用的放大缩小方法
        this.increaseSize = function (f) {
            if (!brush.isDrawing()) {
                // 通过滑块 API 改，滑块内部会自动触发 onChange 去改底层画笔
                sizeSlider.changeSliderValue(f);
            }
        };
        this.decreaseSize = function (f) {
            if (!brush.isDrawing()) {
                sizeSlider.changeSliderValue(-f);
            }
        };

        // 同步状态的方法
        this.getSize = function () {
            return brush.getSize();
        };
        this.setSize = function (size) {
            setSize(size);
            sizeSlider.setValue(size); // 同步UI
        };
        this.getOpacity = function () {
            return brush.getOpacity();
        };
        this.setOpacity = function (opacity) {
            brush.setOpacity(opacity);
            opacitySlider.setValue(opacity);
        };
        this.getScatter = function () {
            return brush.getScatter();
        };
        this.setScatter = function (scatter) {
            brush.setScatter(scatter);
            scatterSlider.setValue(scatter);
        };

        // 代理底层画笔核心逻辑的方法 (代理模式 Proxy)
        // 当用户在画布上拖拽鼠标时，Easel 最终会调用这里的 goLine 等方法，这里再转发给真实的 brush 实例
        this.setColor = function (c) {
            brush.setColor(c);
        };
        this.setLayer = function (layer) {
            brush.setContext(layer.context);
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
        this.isDrawing = function () {
            return brush.isDrawing();
        };
        // 获取这个设置面板的物理 DOM 节点，供上层挂载到页面侧边栏
        this.getElement = function () {
            return div;
        };
    } as TBrushUi<PenBrush>['Ui'];
    return brushInterface;
})();
