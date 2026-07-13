import { BB } from '../../../bb/bb';
import { KL } from '../../kl';
import { TKeyString } from '../../../bb/bb-types';
import { StatusOverlay } from '../components/status-overlay';
import { KlCanvas, TKlCanvasLayer } from '../../canvas/kl-canvas';
import { LANG } from '../../../language/language';
import { TFilterApply, TFilterGetDialogParam, TFilterGetDialogResult } from '../../kl-types';
import { KlColorSlider } from '../components/kl-color-slider';
import { LayersUi } from './layers-ui/layers-ui';
import { RGB } from '../../../bb/color/color';
import { getSharedFx } from '../../../fx-canvas/shared-fx';
import { c } from '../../../bb/base/c';
import { KlHistory } from '../../history/kl-history';
import copyImg from 'url:/src/app/img/ui/copy.svg';
import { createImage } from '../../../bb/base/ui';

export type TEditUiParams = {
    klRootEl: HTMLElement;
    klColorSlider: KlColorSlider;
    layersUi: LayersUi;
    getCurrentColor: () => RGB;
    // 当前设备能够承受的最大画布尺寸（防爆显存安全锁
    maxCanvasSize: number;
    klCanvas: KlCanvas;
    getCurrentLayer: () => TKlCanvasLayer;
    isEmbed: boolean;
    statusOverlay: StatusOverlay;
    onCanvasChanged: () => void; // dimensions/orientation changed
    // 核心安全机制：如果当前用户画了一半没敲确定的选区或临时笔触，强行将其合并提交
    applyUncommitted: () => void;
    klHistory: KlHistory;
    // 全局剪贴板 API：复制当前图层/选区
    onCopyToClipboard: () => void;
    onPaste: () => void;
};

export class EditUi {
    // from params
    private readonly klRootEl: HTMLElement;
    private readonly klColorSlider: KlColorSlider;
    private readonly layersUi: LayersUi;
    private readonly getCurrentColor: () => RGB;
    private readonly maxCanvasSize: number;
    private readonly klCanvas: KlCanvas;
    private readonly getCurrentLayer: () => TKlCanvasLayer;
    private readonly isEmbed: boolean;
    private readonly statusOverlay: StatusOverlay;
    private readonly onCanvasChanged: () => void; // dimensions/orientation changed
    private readonly applyUncommitted: () => void;
    private readonly klHistory: KlHistory;
    private readonly onCopyToClipboard: () => void;
    private readonly onPaste: () => void;

    private readonly rootEl: HTMLDivElement;
    // 惰性初始化 (Lazy Initialization) 标记，默认未渲染
    private isInit = false;

    /**
     * 【硬件探测）：检测浏览器是否支持并成功开启了 WebGL
     * @returns boolean true 代表 GPU 硬件加速可用
     */
    private testHasWebGL(): boolean {
        // getSharedFx() 会尝试获取底层 Shared-Canvas-FX (glfx.js 的二次封装) 的 WebGL 渲染上下文
        return !!getSharedFx();
    }

    /**
     * 【面板构建与初始渲染】
     */
    private init(): void {
        // 引入所有已注册的滤镜插件库 (如模糊、锐化、曲线等)
        const filters = KL.FILTER_LIB;
        const buttons = [];

        // 【安全拦截】：滤镜库通常是异步或者分包加载的，如果代码跑过来时库还没就绪，直接崩溃报错提示
        if (!KL.FILTER_LIB_STATUS.isLoaded) {
            throw new Error('filters not loaded');
        }

        // 检查 WebGL 支持。现代图像滤镜（比如 100px 的高斯模糊、液化变形）如果用 CPU (纯 Canvas 2D) 算，
        // 网页会卡死几秒甚至几十秒。这些滤镜必须依赖 GPU 渲染（WebGL）。
        // 检查 WebGL 支持，某些滤镜需要 WebGL，如果不支持则禁用这些滤镜并显示提示信息
        const hasWebGL: boolean = this.testHasWebGL();

        if (!hasWebGL) {
            // 如果用户的显卡被禁用，或者在某些老旧电脑、Chrome OS 出现 WebGL 崩溃，
            // 绝不直接让软件白屏，而是优雅降级：在界面最上方挂一个鲜明的提示横条。
            const note = BB.el({
                parent: this.rootEl,
                className: 'kl-toolspace-note',
                content: 'Features disabled because WebGL is failing.',
                css: {
                    margin: '10px',
                    marginBottom: '0',
                },
            });

            // 在横条右侧放一个 "Learn More" (了解更多) 的按钮
            const noteButton = BB.el({
                parent: note,
                tagName: 'button',
                textContent: 'Learn More',
                css: {
                    marginLeft: '5px',
                },
            });

            // 点击了解更多，弹出详细的诊断和排查帮助弹窗
            noteButton.onclick = () => {
                KL.popup({
                    message: '<b>WebGL is not working</b>',
                    div: BB.el({
                        content: `
See if your browser supports WebGL and has it enabled: <a href="https://get.webgl.org" target="_blank" rel="noopener noreferrer">get.webgl.org</a><br>
<br>
Recently (2023-05) a number of Chrome users on Chrome OS reported that WebGL fails, although it is enabled & supported.
This has been reported to Google.
`,
                    }),
                    buttons: ['Ok'],
                    clickOnEnter: 'Ok',
                });
            };
        }

        /**
         * 【核心工厂函数：创建滤镜按钮】：读取单个滤镜的配置协议，构建具有统一样式和交互管线的按钮
         */
        // 生成操作类按钮
        const createButton = (filterKey: string): HTMLElement => {
            const filter = filters[filterKey];

            const button = BB.el({
                tagName: 'button',
                className: 'grid-button grid-button--filter',
                content: [
                    createImage({
                        alt: 'icon',
                        src: filter.icon,
                        width: 18,
                        height: 20,
                        className: filter.darkNoInvert ? 'dark-no-invert' : '',
                        css: {
                            marginRight: '3px',
                        },
                    }),
                    LANG(filter.lang.button),
                ],
                css: {
                    lineHeight: '20px',
                    fontSize: '12px',
                },
                custom: {
                    tabIndex: '-1',
                },
            });

            const filterName = LANG(filter.lang.name);

            // 2. 硬件加速权限检查
            let isEnabled = true;
            if (filter.webGL && !hasWebGL) {
                // 如果该滤镜必须依赖 GPU 且用户的 WebGL 挂了，标记为禁用
                isEnabled = false;
            }

            if (isEnabled) {
                // ==========================================
                // 【核心交互：按钮点击后的生命周期管线】
                // ==========================================
                button.onclick = () => {
                    // 【安全第一步】：强制把画布上任何还没确定的框或临时选区提交归档！
                    this.applyUncommitted();
                    type TOptions = 'Ok' | 'Cancel';
                    const dialogButtons: TOptions[] = ['Ok', 'Cancel'];

                    // 【终点站函数】：不管用户是在弹窗点“确定”还是“取消”，最终都会汇聚到这里处理
                    const finishedDialog = (
                        result: TOptions,
                        filterDialog: TFilterGetDialogResult<any>,
                    ): void => {
                        if ('error' in filterDialog) {
                            return;
                        }
                        if (result == 'Cancel') {
                            if (filterDialog.destroy) {
                                // 优雅销毁弹窗和其底层可能挂载的 WebGL 临时预览图，立刻退场
                                filterDialog.destroy();
                            }
                            return;
                        }
                        // 分支 B：用户点击了“确定”，获取面板里调好的参数
                        let input;
                        try {
                            // 获取最新的参数（此方法在底层同时负责触发 destroy 销毁弹窗）
                            input = filterDialog.getInput!(); // also destroys
                        } catch (e) {
                            if (
                                (e as Error).message.indexOf('.getInput is not a function') !== -1
                            ) {
                                throw (
                                    'filterDialog.getInput is not a function, filter: ' + filterName
                                );
                            } else {
                                throw e;
                            }
                        }
                        // 把收集到的参数丢给核心图像渲染管线
                        applyFilter(input);
                    };

                    // 【防御性校验】：检查第三方或自带的插件是否写规范了
                    if (!('apply' in filters[filterKey])) {
                        KL.popup({
                            message: 'Application not fully loaded',
                            type: 'error',
                        });
                        return;
                    }

                    // 【真正给图层洗澡/变魔术的地方】：调用滤镜内核进行计算
                    const applyFilter = (input: any) => {
                        const filterResult = filters[filterKey].apply!({
                            layer: this.getCurrentLayer(),
                            klCanvas: this.klCanvas,
                            klHistory: this.klHistory,
                            input: input,
                        } as TFilterApply);
                        if (!filterResult) {
                            KL.popup({
                                message: "Couldn't apply the edit action",
                                type: 'error',
                            });
                        }
                        // 如果滤镜改变了画板的大小或定位（比如裁剪、扭曲旋转工具），广播全局视图调整！
                        filters[filterKey].updatePos && this.onCanvasChanged();
                        // 强制更新图层面板 UI (例如缩略图改变)
                        this.layersUi.update();
                    };

                    // ==========================================
                    // 【双管线分流引擎 (Dual-Pipeline Branching)】
                    // ==========================================
                    if (filters[filterKey].isInstant) {
                        // 分支 1：瞬间生效型滤镜 (Instant Filter)
                        // 像“水平翻转”、“垂直反转”、“反色”，它们根本不需要设置参数！
                        button.blur();
                        applyFilter(null);
                        this.statusOverlay.out(LANG('filter-applied', { x: filterName }), true);
                    } else {
                        // 分支 2：复杂参数对话框型滤镜 (Dialog Filter)
                        // 像“高斯模糊”、“调整色彩”，需要先弹出一个带有滑块、实时预览画面的控制框！
                        const secondaryColorRGB = this.klColorSlider.getSecondaryRGB();
                        let filterDialog: TFilterGetDialogResult<any> | undefined = undefined;

                        try {
                            // 呼叫滤镜插件的 getDialog，把它需要的上下文画框、尺寸、颜色一股脑发给它
                            filterDialog = filters[filterKey].getDialog!({
                                context: this.getCurrentLayer().context,
                                klCanvas: this.klCanvas,
                                maxWidth: this.maxCanvasSize,
                                maxHeight: this.maxCanvasSize,
                                currentColorRgb: {
                                    r: this.getCurrentColor().r,
                                    g: this.getCurrentColor().g,
                                    b: this.getCurrentColor().b,
                                },
                                secondaryColorRgb: {
                                    r: secondaryColorRGB.r,
                                    g: secondaryColorRGB.g,
                                    b: secondaryColorRGB.b,
                                },
                                // 全图合并快照（用作透明参考背景）
                                composed: this.klHistory.getComposed(),
                            } as TFilterGetDialogParam) as TFilterGetDialogResult;
                        } catch (e) {
                            // 保证错误能被顶层捕获，不卡死单线程
                            setTimeout(() => {
                                throw e;
                            });
                        }

                        if (!filterDialog || 'error' in filterDialog) {
                            KL.popup({
                                message: filterDialog
                                    ? filterDialog.error
                                    : 'Error: Could not perform action.',
                                type: 'error',
                            });
                            return;
                        }

                        let closeFunc: () => void;
                        // 挂载异常拦截器：如果在滑动参数弹窗时 GPU 崩溃，自动销毁弹窗并报错
                        // Todo should move into getDialogParams
                        filterDialog.errorCallback = (e) => {
                            KL.popup({
                                message: 'Error: Could not perform action.',
                                type: 'error',
                            });
                            setTimeout(() => {
                                throw e;
                            }, 0);
                            closeFunc();
                        };

                        const style: TKeyString = {};
                        if ('width' in filterDialog) {
                            style.width = filterDialog.width + 'px';
                        }

                        // 拼装标题（如果插件带说明文档，在标题旁边加一个 "?" 小圆点，点击弹出用法说明）
                        let title: HTMLElement;
                        {
                            const els: HTMLElement[] = [c('b', filterName)];
                            if (filter.lang.description !== undefined) {
                                els.push(
                                    c(
                                        {
                                            className: 'kl-info-btn',
                                            onClick: () => {
                                                KL.popup({
                                                    message: LANG(filter.lang.description!),
                                                });
                                            },
                                            title: LANG(filter.lang.description!),
                                            noRef: true,
                                        },
                                        '?',
                                    ),
                                );
                            }
                            title = c(',flex,gap-5', els);
                        }

                        // 真正唤起可交互对话框！
                        KL.popup({
                            message: title,
                            // 滤镜插件自己构建的 DOM 预览视图
                            div: filterDialog.element,
                            style: style,
                            buttons: dialogButtons,
                            clickOnEnter: 'Ok',
                            callback: (result) => {
                                finishedDialog(result as TOptions, filterDialog!);
                            },
                            closeFunc: (func) => {
                                closeFunc = func;
                            },
                        });
                    }
                };
            } else {
                button.disabled = true;
            }

            buttons.push(button);
            return button;
        };

        /**
         * 【分组批量挂载器】：把同一类别的按钮一堆堆放进页面
         */
        const addGroup = (groupArr: string[]): void => {
            Object.entries(filters).forEach(([filterKey, filter]) => {
                if (!groupArr.includes(filterKey)) {
                    return;
                }
                // 如果当前是“第三方博文嵌入版(Embed)”，但这个功能极其高危或者消耗大，它标了 inEmbed=false，强行忽略！
                if (this.isEmbed && !filter.inEmbed) {
                    return;
                }
                this.rootEl.append(createButton(filterKey));
            });
        };

        // ==========================================
        // 【滤镜功能分组白名单】：将十几二十款滤镜按“人脑逻辑”划分为三大核心区块
        // ==========================================
        // A组：【几何与空间变换 (Geometry & Transform)】—— 修改画布大小、形状或方向
        const groupA = ['cropExtend', 'flip', 'perspective', 'resize', 'rotate', 'transform'];
        // B组：【像素与光影调校 (Color, Tone & Blur)】—— 修改图像色彩、明暗与锐利度
        const groupB = [
            'brightnessContrast',
            'curves',
            'distort',
            'hueSaturation',
            'invert',
            'tiltShift',
            'toAlpha',
            'blur',
            'unsharpMask',
        ];
        // C组：【纹理、图案与辅助工具 (Pattern & Helpers)】
        const groupC = ['grid', 'noise', 'pattern', 'vanishPoint'];

        // ==========================================
        // 【独立模块：系统剪贴板互通面板 (Clipboard Section)】
        // ==========================================
        // 如果当前是“嵌入式 (Embed) 模式”（比如第三方网页引用），强行隐藏复制粘贴。
        // 因为嵌入式的 Sandbox 权限通常禁用了外部剪贴板读取，写出来不仅会报错，还会造成界面冗余。
        if (!this.isEmbed) {
            // 1. 创建 [复制] 按钮
            const copyBtn = BB.el({
                tagName: 'button',
                className: 'grid-button grid-button--filter',
                content: [
                    createImage({
                        alt: 'icon',
                        src: copyImg,
                        width: 18,
                        height: 20,
                        css: {
                            marginRight: '3px',
                        },
                    }),
                    LANG('file-copy'),
                ],
                // 触发从顶层由参数传过来的复制函数
                onClick: () => this.onCopyToClipboard(),
                title: LANG('file-copy-title'),
                // 依然是经典的“防按空格键误触发”保护
                custom: {
                    tabIndex: '-1',
                },
                css: {
                    lineHeight: '20px',
                },
            });

            // 2. 创建 [粘贴] 按钮
            const pasteBtn = BB.el({
                tagName: 'button',
                className: 'grid-button grid-button--filter',
                content: [
                    BB.el({
                        css: {
                            height: '20px',
                            cssFloat: 'left',
                        },
                    }),
                    LANG('file-paste'),
                ],
                custom: {
                    tabIndex: '-1',
                },
                css: {
                    lineHeight: '20px',
                },
                onClick: () => this.onPaste(),
            });
            // 3. 将 [复制] [粘贴] 按钮挂载到最上方，并在下方追加一条分割线 (grid-hr)
            this.rootEl.append(copyBtn, pasteBtn, BB.el({ className: 'grid-hr' }));
        }
        addGroup(groupA); // 编辑类按钮第一组
        this.rootEl.append(BB.el({ className: 'grid-hr' }));
        addGroup(groupB); // 编辑类按钮第二组
        this.rootEl.append(BB.el({ className: 'grid-hr' }));
        addGroup(groupC); // 编辑类按钮第三组

        this.isInit = true;
    }

    // ----------------------------------- public -----------------------------------

    constructor(p: TEditUiParams) {
        // 1. 将所有的应用配置、数据源函数、UI 联动接口存为私有属性
        this.klRootEl = p.klRootEl;
        this.klColorSlider = p.klColorSlider;
        this.layersUi = p.layersUi;
        this.getCurrentColor = p.getCurrentColor;
        this.maxCanvasSize = p.maxCanvasSize;
        this.klCanvas = p.klCanvas;
        this.getCurrentLayer = p.getCurrentLayer;
        this.isEmbed = p.isEmbed;
        this.statusOverlay = p.statusOverlay;
        this.onCanvasChanged = p.onCanvasChanged;
        this.applyUncommitted = p.applyUncommitted;
        this.klHistory = p.klHistory;
        this.onCopyToClipboard = p.onCopyToClipboard;
        this.onPaste = p.onPaste;

        this.rootEl = BB.el(); // 根节点挂载（整体ROOT）
    }

    getElement(): HTMLElement {
        return this.rootEl;
    }

    show(): void {
        if (!this.isInit) {
            this.init();
        }
        this.rootEl.style.display = 'block';
    }

    hide(): void {
        this.rootEl.style.display = 'none';
    }
}
