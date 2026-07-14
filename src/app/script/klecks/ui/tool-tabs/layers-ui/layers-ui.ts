import { BB } from '../../../../bb/bb';
import { Select } from '../../components/select';
import { PointSlider } from '../../components/point-slider';
import { KlCanvas, MAX_LAYERS } from '../../../canvas/kl-canvas';
import { TMixMode, TUiLayout } from '../../../kl-types';
import { LANG } from '../../../../language/language';
import { translateBlending } from '../../../canvas/translate-blending';
import { PointerListener } from '../../../../bb/input/pointer-listener';
import { TPointerEvent } from '../../../../bb/input/event.types';
import { renameLayerDialog } from './rename-layer-dialog';
import { mergeLayerDialog } from './merge-layer-dialog';
import { css, throwIfNull } from '../../../../bb/base/base';
import { HAS_POINTER_EVENTS } from '../../../../bb/base/browser';
import { c } from '../../../../bb/base/c';
import { DropdownMenu } from '../../components/dropdown-menu';
import addLayerImg from 'url:/src/app/img/ui/add-layer.svg';
import duplicateLayerImg from 'url:/src/app/img/ui/duplicate-layer.svg';
import mergeLayerImg from 'url:/src/app/img/ui/merge-layers.svg';
import removeLayerImg from 'url:/src/app/img/ui/remove-layer.svg';
import renameLayerImg from 'url:/src/app/img/ui/rename-layer.svg';
import caretDownImg from 'url:/src/app/img/ui/caret-down.svg';
import { KlHistory } from '../../../history/kl-history';
import { makeUnfocusable } from '../../../../bb/base/ui';

const paddingLeft = 25;

/**
 * 【黑魔法复合类型：图层 DOM 行对象】
 * 继承原生 HTMLElement，并将数据（图层名、不透明度、序号）直接挂载在 DOM 对象上！
 */
type TLayerEl = HTMLElement & {
    label: HTMLElement;
    opacityLabel: HTMLElement;
    // 行内小缩略图 Canvas 元素
    thumb: HTMLCanvasElement;

    // 【极其关键】当前图层在物理物理顺序中的逻辑槽位索引 (0 代表最底层/背景层)
    spot: number;
    // 当前图层卡片在列表容器里绝对定位的纵向像素 Y 坐标
    posY: number;
    // 图层名字字符串
    layerName: string;
    // 不透明度数值 (0.0 ~ 1.0)
    opacity: number;
    // 自定义手势监听器（处理长按、拖动滑动排序）
    pointerListener: PointerListener;
    opacitySlider: PointSlider;
    // 是否为当前被高亮选中的活跃图层
    isSelected: boolean;
};

export type TLayersUiParams = {
    klCanvas: KlCanvas;
    // 切换当前活动图层时的回调
    onSelect: (layerIndex: number, pushHistory: boolean) => void;
    parentEl: HTMLElement;
    uiState: TUiLayout;
    // 强制归档未提交的临时手势/笔触（如套索、变形工具）
    applyUncommitted: () => void;
    klHistory: KlHistory;
    // 图层结构变更（如顺序变化）时通知整个画布和侧边栏重绘
    onUpdateProject: () => void; // triggers update of easel
    // 一键清空当前图层的内容
    onClearLayer: () => void;
};

export class LayersUi {
    // from params
    private klCanvas: KlCanvas;
    private readonly onSelect: (layerIndex: number, pushHistory: boolean) => void;
    private readonly parentEl: HTMLElement;
    private uiState: TUiLayout;
    private readonly applyUncommitted: () => void;
    private klHistory: KlHistory;
    private readonly onUpdateProject: () => void;
    private readonly onClearLayer: () => void;

    // ----------------------------------- 核心 DOM 容器与状态 -----------------------------------
    private readonly rootEl: HTMLElement;
    private isVisible: boolean = true;
    // 【底层的真实图层数据镜像】：保存 context、名字、透明度和混合模式（如 'multiply'、'normal'）
    private klCanvasLayerArr: {
        context: CanvasRenderingContext2D;
        opacity: number;
        name: string;
        mixModeStr: TMixMode;
    }[];
    private readonly layerListEl: HTMLElement;
    // 内存里的 DOM 行元素数组(包含配置于dom扩展类型中)
    private layerElArr: TLayerEl[];
    // 当前选中的图层槽位索引
    private selectedSpotIndex: number;

    // ----------------------------------- 底部/顶部快捷操作区 UI -----------------------------------
    private readonly removeBtn: HTMLButtonElement;
    private readonly addBtn: HTMLButtonElement;
    private readonly duplicateBtn: HTMLButtonElement;
    private readonly mergeBtn: HTMLButtonElement;
    // [更多菜单]：清空、高级合并、合并所有
    private readonly moreDropdown: DropdownMenu<'clear-layer' | 'advanced-merge' | 'merge-all'>;
    // [图层混合模式] 下拉选择器 (Normal, Multiply, Overlay 等) 
    private readonly modeSelect: Select<TMixMode>;
    private readonly largeThumbDiv: HTMLElement;
    // 脏检查快照：记录上次渲染时的历史记录版本号
    private oldHistoryState: number | undefined;
    // 锁定状态：用户是否正拿着鼠标拖拽/滑动图层
    private isManipulating: boolean = false;

    // ----------------------------------- 缩略图悬停放大镜机制 (Large Thumb) -----------------------------------
    // 悬浮大图 Canvas 像素层
    private readonly largeThumbCanvas: HTMLCanvasElement;
    // 悬浮大图目前是否已挂载到 DOM 中
    private largeThumbInDocument: boolean;
    private largeThumbInTimeout: undefined | ReturnType<typeof setTimeout>;
    private largeThumbTimeout: undefined | ReturnType<typeof setTimeout>;
    private lastpos: number = 0;

    // 排版常量：每一个图层卡片的高度严格设定为 35px，间距为 0px
    private readonly layerHeight: number = 35;
    private readonly layerSpacing: number = 0;

    /**
     * 【图层拖拽重排序算子】：在鼠标/触控手指拖拽结束时调用，重新计算行卡片的 Y 轴绝对位置，并在底层驱动真正图层换序！
     * 
     * @param oldSpotIndex 拖拽前图层所在的槽位索引
     * @param newSpotIndex 拖拽释放后图层所在的槽位索引
     */
    private move(oldSpotIndex: number, newSpotIndex: number): void {
        if (isNaN(oldSpotIndex) || isNaN(newSpotIndex)) {
            throw 'layers-ui - invalid move';
        }
        // 1. 【内存行与 DOM 视觉坐标重映射】：
        // 这是一个经典的“区间挤压移动算子”：我们在不通过 `DOM.insertBefore/appendChild` 打乱 DOM 树结构的前提下，
        // 单纯靠修改卡片的 CSS `top` 属性，把被越过的所有图层卡片往上一或往下一级挪动！
        for (let i = 0; i < this.layerElArr.length; i++) {
            ((i) => {
                let posy = this.layerElArr[i].spot;
                // 找到当前正在被用户拖跑的那张卡片，强制设为目标逻辑位
                if (this.layerElArr[i].spot === oldSpotIndex) {
                    posy = newSpotIndex;
                } else {
                    // 如果该卡片在旧位置上方：随着拖动发生，它需要往前递减 1 个逻辑位来填补空缺
                    if (this.layerElArr[i].spot > oldSpotIndex) {
                        posy--;
                    }
                    // 如果该卡片落入了新位置及其上方：需要再往后递增 1 个位给新的插入者腾地方
                    if (posy >= newSpotIndex) {
                        posy++;
                    }
                }
                // 写入更新后的逻辑序号
                this.layerElArr[i].spot = posy;

                // 【绝妙的倒序物理定位算法】：
                // 为什么用 (length - posy - 1)？因为对于人类视角而言，【背景层（第0层）】应该排在列表的最底部！
                // 而【最上层（第N层）】应该排在最顶端 (Y=0px 处)！
                this.layerElArr[i].posY =
                    (this.layerHeight + this.layerSpacing) *
                    (this.klCanvasLayerArr.length - posy - 1);

                // 直接修改 CSS 定位（如果配合 CSS transition 会产生极其平滑的卡片滑动动画）
                this.layerElArr[i].style.top = this.layerElArr[i].posY + 'px';
            })(i);
        }

        // 2. 如果你在原位丢弃（没有真正移动），提前返回
        if (oldSpotIndex === newSpotIndex) {
            return;
        }

        // 3. 【执行真核联动】：在动真的之前，把正画了一半的未提交选区/拉伸敲定归档！
        this.applyUncommitted();

        // 4. 调用底层的多图层画布 API，真实移动显存/画布对象的顺序
        // 传入相对偏移步长：(新索引 - 旧索引)
        this.klCanvas.moveLayer(this.selectedSpotIndex, newSpotIndex - oldSpotIndex);

        // 5. 重新获取最新的内部图层数组引用
        this.klCanvasLayerArr = this.klCanvas.getLayers();
        this.selectedSpotIndex = newSpotIndex;

        // 6. 【安全锁联动】：如果你把当前图层拖到了第 0 层（最底下的背景层），
        // 强行把 [向下合并 (Merge Down)] 按钮灰掉！因为最底下的层下面没东西了，绝对不可能“向下合并”。
        this.mergeBtn.disabled = this.selectedSpotIndex === 0;
    }

    private posToSpot(p: number): number {
        let result = parseInt('' + (p / (this.layerHeight + this.layerSpacing) + 0.5));
        result = Math.min(this.klCanvasLayerArr.length - 1, Math.max(0, result));
        result = this.klCanvasLayerArr.length - result - 1;
        return result;
    }

    /**
     * 【高频拖拽实时视觉反馈】：当用户正在拖着某一张图层卡片在上下移动时，
     * 计算并更新“除当前被拖动卡片之外”所有其他卡片的 CSS 绝对定位坐标，实现平滑的“腾位置/动画推挤”效果！
     * 
     * @param elementIndex 当前正在被拖拽的那张卡片原本在物理数组里的起始索引
     * @param newspot 根据鼠标实时手势高度，算出该卡片【如果现在松手】会落入的预估逻辑序号
     */
    /**
     * update css position of all layers that are not being dragged, while dragging
     */
    private updateLayersVerticalPosition(elementIndex: number, newspot: number): void {
        // 1. 【防超界安全钳制 (Clamping)】：
        // 不管鼠标把图层往上拖破顶、还是往下拖钻进底，都强行限幅在 [0, layers.length - 1] 区间里
        newspot = Math.min(this.klCanvasLayerArr.length - 1, Math.max(0, newspot));

        // 2. 【极限渲染性能锁 (Dirty Check)】：
        // 如果虽然鼠标在轻微晃动，但算出来的“预计新槽位”根本没变（还是同一个格子），
        // 绝对不要去碰 DOM 或者重写 CSS！省下巨量 CPU 布局计算开销！
        if (newspot === this.lastpos) {
            return;
        }

        // 3. 遍历除“当前正在被拖着走”的卡片外的所有静止图层
        for (let i = 0; i < this.layerElArr.length; i++) {
            if (this.layerElArr[i].spot === elementIndex) {
                continue;
            }
            let posy = this.layerElArr[i].spot;
            if (this.layerElArr[i].spot > elementIndex) {
                posy--;
            }
            if (posy >= newspot) {
                posy++;
            }
            this.layerElArr[i].posY =
                (this.layerHeight + this.layerSpacing) * (this.klCanvasLayerArr.length - posy - 1);
            this.layerElArr[i].style.top = this.layerElArr[i].posY + 'px';
        }
        this.lastpos = newspot;
    }

    /**
     * 【唤起重命名交互弹窗】：当用户在图层名称文本或者操作栏中选择修改名字时调用
     * 
     * @param layerSpot 目标图层在物理数组里的索引
     */
    private renameLayer(layerSpot: number): void {
        renameLayerDialog(this.parentEl, this.klCanvas.getLayerOld(layerSpot)!.name, (newName) => {
            if (newName === undefined || newName === this.klCanvas.getLayerOld(layerSpot)!.name) {
                return;
            }
            // 让画布内核引擎把对应位置图层对象的 name 属性彻底改写
            this.klCanvas.renameLayer(layerSpot, newName);
            //this.createLayerList();
            this.onSelect(layerSpot, false);
        });
    }

    /**
     * 【动态容器绝对高度同步】：
     * 随着图层添加、合并或被删除，实时算出这个绝对定位的容器到底需要撑起多高的空间。
     */
    private updateHeight(): void {
        this.layerListEl.style.height = this.layerElArr.length * 35 + 'px';
    }

    /**
     * 【图层列表核心渲染引擎】：从底层画布同步最新的图层状态，并构建对应的 DOM 树结构
     * @param force 是否强行忽略脏检查，强制重新渲染列表
     */
    private createLayerList(force?: boolean): void {
        // 1. 【极客级脏检查缓存锁 (Dirty-Checking Cache Lock)】：
        // 拿当前历史栈的“变更计数器 (Change Count)”和上一帧渲染完成时的快照做比对。
        // 如果历史记录毫发无损（说明画板没有任何真正的结构或像素修改），且没有要求 force 强制刷屏，
        // 那么直接拦截返回！绝不浪费一微秒的 CPU 时钟去碰 DOM 树！
        if (this.klHistory.getChangeCount() === this.oldHistoryState && !force) {
            return;
        }
        // 2. 重置拖拽操作锁，并把当前最新的“历史快照时钟版本号”备份下来
        this.isManipulating = false;
        this.oldHistoryState = this.klHistory.getChangeCount();
        // 3. 拿到底层渲染内核（KlCanvas）中当前最真实、最鲜活的图层属性数组
        this.klCanvasLayerArr = this.klCanvas.getLayers();

        /**
         * 【内部工厂方法：组装单个图层卡片 (Layer Card Entry)】
         * @param index 物理数组里图层的真实序号 (0 代表最底层的背景)
         */
        const createLayerEntry = (index: number): void => {
            // A. 数据提取：获取物理层旧接口结构中的图层对象（如果为 null 强制抛错中断）
            const klLayer = throwIfNull(this.klCanvas.getLayerOld(index));
            const layerName = klLayer.name;
            const opacity = this.klCanvasLayerArr[index].opacity;
            const isVisible = klLayer.isVisible;
            // 真实的图层 Canvas 画布指针
            const layercanvas = this.klCanvasLayerArr[index].context.canvas;

            // B. 构建卡片根 DOM 节点（强转为我们自己定义的 TLayerEl 复合类型）
            const layer: TLayerEl = BB.el({
                className: 'kl-layer',
            }) as HTMLElement as TLayerEl;
            // 将这个新建的行卡片存入内存数组管理
            this.layerElArr[index] = layer;
            // C. 【绝赞的视觉倒排映射计算】：
            // 公式：(总图层数 - 1) * 35px - 当前序号 * 35px
            // 假设一共有 3 个图层 (length=3)：
            // - index 2 (顶层)：(3-1)*35 - 2*35 = 0px （排在最上方视觉顶端！）
            // - index 1 (中层)：(3-1)*35 - 1*35 = 35px （排在第二行）
            // - index 0 (底层)：(3-1)*35 - 0*35 = 70px （排在列表最底下，作为背景！）
            layer.posY = (this.klCanvasLayerArr.length - 1) * 35 - index * 35;
            css(layer, {
                top: layer.posY + 'px',
            });
            const innerLayer = BB.el();
            css(innerLayer, {
                position: 'relative',
            });

            const container1 = BB.el();
            css(container1, {
                width: '270px',
                height: '34px',
            });
            const container2 = BB.el();
            layer.append(innerLayer);
            innerLayer.append(container1, container2);

            // 绑定物理关联槽位指针
            layer.spot = index;

            //checkbox - visibility
            {
                const checkWrapper = BB.el({
                    tagName: 'label',
                    parent: container1,
                    title: LANG('layers-visibility-toggle'),
                    css: {
                        display: 'flex',
                        width: '25px',
                        height: '100%',
                        justifyContent: 'right',
                        alignItems: 'center',
                        cursor: 'pointer',
                    },
                });
                const check = BB.el({
                    tagName: 'input',
                    parent: checkWrapper,
                    custom: {
                        type: 'checkbox',
                        tabindex: '-1',
                        name: 'layer-visibility',
                    },
                    css: {
                        display: 'block',
                        cursor: 'pointer',
                        margin: '0',
                        marginRight: '5px',
                    },
                });
                check.checked = isVisible;
                check.onchange = () => {
                    this.klCanvas.setLayerIsVisible(layer.spot, check.checked);
                    if (layer.spot === this.selectedSpotIndex) {
                        this.onSelect(this.selectedSpotIndex, false);
                    }
                };
                // prevent layer getting dragged
                const preventFunc = (e: PointerEvent | MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                };
                if (HAS_POINTER_EVENTS) {
                    checkWrapper.onpointerdown = preventFunc;
                } else {
                    checkWrapper.onmousedown = preventFunc;
                }
            }

            //thumb
            // ! 这段代码创建了预览缩略图
            {
                // 1. 【等比缩放计算器 (Fit-Into Mathematical Scaling)】：
                // 无论用户画板是横长条(4000x1000)、竖长条(1000x4000)还是正方形，
                // BB.fitInto 能够自动计算出：在保证原图宽高比永远不发生拉伸畸变的前提下，
                // 如何刚好把它放入一个 30x30 像素的界限框里。
                // 最后一个形参 `1` 通常代表最小限制大小，保证再小的图像算出来都不会变成 0x0 像素崩溃。
                const thumbDimensions = BB.fitInto(
                    layercanvas.width,
                    layercanvas.height,
                    30,
                    30,
                    1,
                );
                // 2. 在内存中创建这张微缩版的小 Canvas
                layer.thumb = BB.canvas(thumbDimensions.width, thumbDimensions.height);
                // 3. 获取小画框的 2D 绘图笔触
                const thc = BB.ctx(layer.thumb);
                thc.save();
                // 4. 【神级像素画质保护 (Pixel-Art Anti-Blur Guard)】：
                // 这种情况何时发生？当你建了一个极小的画布（比如仅有 16x16 像素，画像素画时）！
                // 此时，小画布(16x16) 要放进缩略图(比如会被等比放大为 30x30)。
                // 原生的 Canvas drawImage 在“放大”图像时，默认会强行开启双线性插值平滑(Smoothing)，
                // 把原本像素分明的点阵画放大成一团极其恶心的糊状马赛克。
                // 关闭 imageSmoothingEnabled，就能让像素画在被拉大到缩略图时，依然保持边缘硬朗清晰！
                if (layer.thumb.width > layercanvas.width) {
                    thc.imageSmoothingEnabled = false;
                }
                // 5. 【真正的降采样绘制 (Downsampling Draw)】：
                // 用 drawImage 直接把几万乃至几千万像素的大画布 (layercanvas)，
                // 一瞬间浓缩转印进我们仅仅二三十像素宽高的微型缩略图 Canvas 里！
                thc.drawImage(layercanvas, 0, 0, layer.thumb.width, layer.thumb.height);
                thc.restore(); // 恢复画笔状态
                // 6. 【绝对定位与视觉居中对齐公式】：
                // 卡片的左侧已经给眼睛图标留出了 paddingLeft(25px)，
                // 缩略图的总外框预留槽位是 32x32px。
                // 如果一张竖长的缩略图宽高只有 (15x30)，怎样把它精准放置在 32x32 坑位正中心？
                // 居中公式：(槽位宽度 32 - 实际宽度) / 2 + 偏移边距！
                css(layer.thumb, {
                    position: 'absolute',
                    left: (32 - layer.thumb.width) / 2 + paddingLeft + 'px',
                    top: (32 - layer.thumb.height) / 2 + 1 + 'px',
                    // 【极重要 UX 细节】：棋盘格透明背景！
                    // 因为大多数图层都是带透明度或者全是透明背景的，如果只用纯色底，你就看不清白色笔刷画了什么。
                    // `var(--kl-checkerboard-background)` 会为这个小 Canvas 垫上一层黑白/灰白相间的棋盘格，
                    // 完美凸显图层本身的透明通道特征！
                    background: 'var(--kl-checkerboard-background)',
                });
            }

            // ==========================================
            // 【图层名称文字与排版 (Layer Label & Formatting)】
            // ==========================================
            //layerlabel
            {
                layer.label = BB.el({
                    className: 'kl-layer__label',
                });
                layer.layerName = layerName;
                layer.label.append(layer.layerName);

                css(layer.label, {
                    position: 'absolute',
                    left: 1 + 32 + 5 + paddingLeft + 'px',
                    top: 1 + 'px',
                    fontSize: '13px',
                    width: '165px',
                    height: '20px',
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    textOverflow: 'ellipsis',
                });

                layer.label.ondblclick = () => {
                    this.applyUncommitted();
                    this.renameLayer(layer.spot);
                };
            }

            // ==========================================
            // 【图层不透明度数值显示文字 (Layer Opacity Label)】
            // 负责在卡片右侧以百分比形式（如 "100%", "50%"）精确呈现当前图层的透明度
            // ==========================================
            //layer label opacity
            {
                layer.opacityLabel = BB.el({
                    className: 'kl-layer__opacity-label',
                });
                layer.opacity = opacity;
                layer.opacityLabel.append(parseInt('' + layer.opacity * 100) + '%');

                css(layer.opacityLabel, {
                    position: 'absolute',
                    left: 250 - 1 - 5 - 50 - 5 + paddingLeft + 'px',
                    top: 1 + 'px',
                    fontSize: '13px',
                    textAlign: 'right',
                    width: '50px',
                    transition: 'color 0.2s ease-in-out',
                    textDecoration: isVisible ? undefined : 'line-through',
                });
            }

            // ==========================================
            // 【图层不透明度滑动条控件 (PointSlider Instantiation)】
            // ! 注意此处存在数据防抖锁定性能优化
            // ! 因为改变图层属性会计入历史记录栈，因此不能剧烈变化
            // ==========================================
            let oldOpacity: number;
            const opacitySlider = new PointSlider({
                init: layer.opacity,
                width: 200,
                pointSize: 14,
                // 【核心钩子：高频滑动与状态机流转回调】
                // ! isFirst和isLast通过poniter事件的down/move和up实现
                // @param sliderValue 当前滑块推算出的实时浮点数值
                // @param isFirst 触发瞬间布尔值：用户手指/鼠标刚好按下（拖拽开始第一帧）
                // @param isLast 触发瞬间布尔值：用户手指/鼠标刚好抬起（拖拽彻底结束最后一帧）
                callback: (sliderValue, isFirst, isLast) => {
                    // ----------------------------------------------------
                    // 【状态一：起点触发 (pointerdown / mousedown)】
                    // ----------------------------------------------------
                    if (isFirst) {
                        // 上锁：声明当前画师正在疯狂操控 UI
                        this.isManipulating = true;
                        // 从底层内核抓取当前图层未经修改的【最原始透明度】，存入局部变量
                        oldOpacity = this.klCanvas.getLayerOld(layer.spot)!.opacity;
                        return;
                    }
                    // ----------------------------------------------------
                    // 【状态二：终点释放 (pointerup / mouseup)】
                    // ----------------------------------------------------
                    if (isLast) {
                        // 解锁：恢复日常待机状态
                        this.isManipulating = false;
                        // 如果用户只是把滑块拽着玩了一圈，最后释放时居然跟初值一模一样，直接忽略！
                        if (oldOpacity !== sliderValue) {
                            // 调用底层内核真正写入最终值！
                            // 注意：由于我们在下一句就会直接 return，这步调用【不会】被 history.pause() 包裹，
                            // 意味着这一次的定稿动作，会堂堂正正地被记入 Ctrl+Z 历史记录栈中！
                            this.klCanvas.setOpacity(layer.spot, sliderValue);
                        }
                        return;
                    }
                    // ----------------------------------------------------
                    // 【状态三：空中滑动渲染 (Dragging / pointermove) - 144Hz 高频触发】
                    // ----------------------------------------------------
                    // 1. 纯视觉层同步：用 Math.round 四舍五入把标签里的百分比数字实时更新 (如 "64%")
                    layer.opacityLabel.innerHTML = Math.round(sliderValue * 100) + '%';
                    // 2. 【神级黑魔法：历史记录快照引擎暂停 (History Pause Hack)】
                    // 为什么要在调 setOpacity 前强行把 history.pause 设为 true？
                    // 如果不暂停，由于 mousemove 以每秒几十上百次的频率触发，
                    // 你的历史记录栈瞬间就会被灌入 100 条“调了 0.01% 透明度”的垃圾记录！
                    // 这不仅会让 Ctrl+Z 彻底报废，更会导致每次滑动都在深度拷贝显存/画布瓦片，使得网页掉帧卡死！
                    this.klHistory.pause(true);
                    try {
                        // 带着“屏蔽历史栈”的无敌状态，强行修改底层的渲染透明度，实现画板 60FPS 丝滑变暗/变亮！
                        this.klCanvas.setOpacity(layer.spot, sliderValue);
                    } finally {
                        // 【try...finally 护城河】：不管底层绘图有没有发生异常，
                        // 必须确保历史记录栈在上锁后必定能恢复开启状态，防止画师往后的画笔操作无法被撤销！
                        this.klHistory.pause(false);
                    }
                    // 3. 通知侧边栏、顶部画框甚至整个多文档视口：“我的画面变了，赶紧重新合成显示！”
                    this.onUpdateProject();
                },
                getDoIgnore: () => this.isManipulating,
            });
            css(opacitySlider.getElement(), {
                position: 'absolute',
                left: 39 + paddingLeft + 'px',
                top: '17px',
            });
            layer.opacitySlider = opacitySlider;

            //larger layer preview - hover
            // TODO:sai2不需要缩率图hover预览功能
            // ==========================================
            // 【悬停高阶放大镜机制 (Large Thumb Preview)】
            // 当鼠标悬停在卡片左侧 30x30 的小缩略图上时，
            // 自动在屏幕一侧弹出高达 250x250 像素的高清微缩画框！
            // ==========================================
            layer.thumb.onpointerover = (e) => {
                if (e.buttons !== 0 && (!e.pointerType || e.pointerType !== 'touch')) {
                    //shouldn't show while dragging
                    return;
                }

                const thumbDimensions = BB.fitInto(
                    layercanvas.width,
                    layercanvas.height,
                    250,
                    250,
                    1,
                );

                if (
                    this.largeThumbCanvas.width !== thumbDimensions.width ||
                    this.largeThumbCanvas.height !== thumbDimensions.height
                ) {
                    this.largeThumbCanvas.width = thumbDimensions.width;
                    this.largeThumbCanvas.height = thumbDimensions.height;
                }
                const ctx = BB.ctx(this.largeThumbCanvas);
                ctx.save();
                if (this.largeThumbCanvas.width > layercanvas.width) {
                    ctx.imageSmoothingEnabled = false;
                }
                ctx.imageSmoothingQuality = 'high';
                ctx.clearRect(0, 0, this.largeThumbCanvas.width, this.largeThumbCanvas.height);
                ctx.drawImage(
                    layercanvas,
                    0,
                    0,
                    this.largeThumbCanvas.width,
                    this.largeThumbCanvas.height,
                );
                ctx.restore();
                css(this.largeThumbDiv, {
                    top: e.clientY - this.largeThumbCanvas.height / 2 + 'px',
                    opacity: '0',
                });
                if (!this.largeThumbInDocument) {
                    document.body.append(this.largeThumbDiv);
                    this.largeThumbInDocument = true;
                }
                clearTimeout(this.largeThumbInTimeout);
                this.largeThumbInTimeout = setTimeout(() => {
                    css(this.largeThumbDiv, {
                        opacity: '1',
                    });
                }, 20);
                clearTimeout(this.largeThumbTimeout);
            };
            layer.thumb.onpointerout = () => {
                clearTimeout(this.largeThumbInTimeout);
                css(this.largeThumbDiv, {
                    opacity: '0',
                });
                clearTimeout(this.largeThumbTimeout);
                this.largeThumbTimeout = setTimeout(() => {
                    if (!this.largeThumbInDocument) {
                        return;
                    }
                    this.largeThumbDiv.remove();
                    this.largeThumbInDocument = false;
                }, 300);
            };

            container1.append(
                layer.thumb,
                layer.label,
                layer.opacityLabel,
                opacitySlider.getElement(),
            );
            let dragstart = false;
            let freshSelection = false;

            // ==========================================
            // 【图层卡片上下拖拽排序手势控制器 (Layer Drag-and-Drop Handler)】
            // ==========================================
            //events for moving layers up and down
            let isDragging = false;
            const dragEventHandler = (event: TPointerEvent) => {
                if (
                    event.type === 'pointerdown' &&
                    event.button === 'left' &&
                    !this.isManipulating
                ) {
                    css(layer, {
                        transition: 'box-shadow 0.3s ease-in-out',
                        zIndex: '1',
                    });
                    this.lastpos = layer.spot;
                    freshSelection = false;
                    if (!layer.isSelected) {
                        freshSelection = true;
                        this.activateLayer(layer.spot);
                    }
                    dragstart = true;
                    isDragging = true;
                    this.isManipulating = true;
                } else if (event.type === 'pointermove' && event.button === 'left' && isDragging) {
                    if (dragstart) {
                        dragstart = false;
                        css(layer, {
                            boxShadow: '1px 3px 5px rgba(0,0,0,0.4)',
                        });
                    }
                    layer.posY += event.dY;
                    const corrected = Math.max(
                        0,
                        Math.min((this.klCanvasLayerArr.length - 1) * 35, layer.posY),
                    );
                    layer.style.top = corrected + 'px';
                    this.updateLayersVerticalPosition(layer.spot, this.posToSpot(layer.posY));
                }
                if (event.type === 'pointerup' && isDragging) {
                    this.isManipulating = false;
                    css(layer, {
                        transition: 'all 0.1s linear',
                    });
                    setTimeout(() => {
                        css(layer, {
                            boxShadow: '',
                        });
                    }, 20);
                    layer.posY = Math.max(
                        0,
                        Math.min((this.klCanvasLayerArr.length - 1) * 35, layer.posY),
                    );
                    layer.style.zIndex = '';
                    const newSpot = this.posToSpot(layer.posY);
                    const oldSpot = layer.spot;
                    this.move(layer.spot, newSpot);
                    if (oldSpot != newSpot) {
                        this.onSelect(this.selectedSpotIndex, false);
                    }
                    if (oldSpot === newSpot && freshSelection) {
                        this.applyUncommitted();
                        this.onSelect(this.selectedSpotIndex, true);
                    }
                    freshSelection = false;
                }
            };

            // ! 使用 Klecks/BB 自带的多端统合指针监听器，彻底将鼠标、触控屏、数位板手势抹平绑定到 container1 上
            layer.pointerListener = new BB.PointerListener({
                target: container1,
                onPointer: dragEventHandler,
                maxPointers: 1,
            });

            this.layerListEl.append(layer);
        };
        this.layerElArr = [];
        // 循环清除当前的 layerListEl 下已经渲染的旧 DOM 节点
        while (this.layerListEl.firstChild) {
            const child = this.layerListEl.firstChild as TLayerEl;
            child.pointerListener.destroy();
            child.opacitySlider.destroy();
            child.remove();
        }
        // 按最新的内部物理状态，一次循环全量组装出新的图层 DOM 列表
        for (let i = 0; i < this.klCanvasLayerArr.length; i++) {
            createLayerEntry(i);
        }
        // 再次高亮渲染当前激活的图层，并精确更新右侧容器的总体滚动条高度
        this.activateLayer(this.selectedSpotIndex);
        this.updateHeight();
    }

    /**
     * 【操作面板状态机：根据当前图层结构实时锁定/激活按钮】
     * 此函数在每一次图层增删、排序、选择变更后被触发，保证 UI 界面与底层数据逻辑严丝合缝。
     */
    private updateButtons(): void {
        const maxReached = this.klCanvasLayerArr.length === MAX_LAYERS;
        const oneLayer = this.klCanvasLayerArr.length === 1;

        this.addBtn.disabled = maxReached;
        this.removeBtn.disabled = oneLayer;
        this.duplicateBtn.disabled = maxReached;
        this.mergeBtn.disabled = this.selectedSpotIndex === 0;
        this.moreDropdown.setEnabled('advanced-merge', !oneLayer);
        this.moreDropdown.setEnabled('merge-all', !oneLayer);
    }

    // ----------------------------------- public -----------------------------------
    constructor(p: TLayersUiParams) {
        // 1. 【依赖注入 (Dependency Injection)】：
        // 将画布引擎、历史记录栈、状态布局等核心依赖注入到实例中，
        // 保证 LayersUi 可以直接操作画布底层，而不需要在全局寻找这些单例实例。
        this.klCanvas = p.klCanvas;
        this.onSelect = p.onSelect;
        this.parentEl = p.parentEl;
        this.uiState = p.uiState;
        this.applyUncommitted = p.applyUncommitted;
        this.klHistory = p.klHistory;
        this.onUpdateProject = p.onUpdateProject;
        this.onClearLayer = p.onClearLayer;

        this.layerElArr = [];
        // 每一行图层卡片的高度，后续所有定位偏移量都基于此值
        this.layerHeight = 35;
        this.layerSpacing = 0;
        // 面板固定宽度，确保 UI 布局的确定性
        const width = 270;

        // 2. 【预构建悬浮放大镜 DOM 节点 (Lazy Global UI Layer)】：
        // 这个放大镜 Div 是在构造函数里就创建好的，且它不隶属于图层列表，
        // 而是直接被塞进 document.body，作为整个应用级的一层悬浮 UI。
        this.largeThumbDiv = BB.el({
            onClick: BB.handleClick,
            css: {
                position: 'absolute',
                top: '500px',
                boxShadow: '1px 1px 3px rgba(0,0,0,0.3)',
                pointerEvents: 'none',
                padding: '0',
                border: '1px solid #aaa',
                transition: 'opacity 0.3s ease-out',
                userSelect: 'none',
                background: 'var(--kl-checkerboard-background)',
            },
        });
        // 应用初始化 UI 布局状态（处理紧凑模式/正常模式的适配）
        this.setUiState(this.uiState);

        this.largeThumbCanvas = BB.canvas(200, 200);
        this.largeThumbCanvas.style.display = 'block';
        this.largeThumbDiv.append(this.largeThumbCanvas);
        this.largeThumbInDocument = false;

        this.klCanvasLayerArr = this.klCanvas.getLayers();
        this.selectedSpotIndex = this.klCanvasLayerArr.length - 1;
        this.rootEl = BB.el({
            css: {
                marginRight: '10px',
                marginBottom: '10px',
                marginLeft: '10px',
                marginTop: '10px',
                cursor: 'default',
                position: 'relative',
                zIndex: '0',
            },
        });

        const listDiv = BB.el({
            css: {
                width: width + 'px',
                position: 'relative',
                margin: '0 -10px',
                zIndex: '0',
            },
        });

        this.layerListEl = BB.el({
            parent: listDiv,
        });

        this.addBtn = BB.el({ tagName: 'button' });
        this.duplicateBtn = BB.el({ tagName: 'button' });
        this.mergeBtn = BB.el({ tagName: 'button' });
        this.removeBtn = BB.el({ tagName: 'button' });
        const renameBtn = BB.el({ tagName: 'button' });
        // 图层操作组件（向下合并/以某种形式向下合并/合并全部）
        this.moreDropdown = new DropdownMenu({
            button: BB.el({
                content: `<img src="${caretDownImg}" width="13"/>`,
                css: {
                    display: 'flex',
                    justifyContent: 'center',
                    opacity: '0.9',
                },
            }),
            buttonTitle: LANG('more'),
            items: [
                ['clear-layer', LANG('layers-clear'), '⌫'],
                ['advanced-merge', LANG('layers-merge-advanced'), 'Ctrl + Shift + E'],
                ['merge-all', LANG('layers-merge-all')],
            ],
            onItemClick: (id) => {
                if (id === 'clear-layer') {
                    this.applyUncommitted();
                    this.onClearLayer();
                }
                if (id === 'advanced-merge') {
                    this.advancedMergeDialog();
                }
                if (id === 'merge-all') {
                    this.applyUncommitted();
                    const newIndex = this.klCanvas.mergeAll();
                    if (newIndex === false) {
                        return;
                    }
                    this.klCanvasLayerArr = this.klCanvas.getLayers();
                    this.selectedSpotIndex = newIndex;

                    this.onSelect(this.selectedSpotIndex, false);

                    this.updateButtons();
                }
            },
        });

        this.updateButtons();

        const createButtons = () => {
            // 工具栏的外层包装容器
            const div = BB.el();
            // 使用 async 函数封装所有繁重的 UI 设置逻辑
            const async = () => {
                // 1. 交互优化：移除按钮焦点环。
                // 绘图应用中，如果不移除焦点，用户画完一笔按下键盘快捷键时，
                // 可能会意外触发按钮的 enter 激活，导致意外的“新建图层”动作。
                makeUnfocusable(this.addBtn);
                makeUnfocusable(this.duplicateBtn);
                makeUnfocusable(this.mergeBtn);
                makeUnfocusable(this.removeBtn);
                makeUnfocusable(renameBtn);

                // 2. 布局标准化：通过 commonStyle 统一浮动、边距，保持工具栏整齐美观
                const commonStyle = {
                    cssFloat: 'left',
                    paddingLeft: '5px',
                    paddingRight: '3px',
                };
                css(this.addBtn, commonStyle);
                css(this.duplicateBtn, commonStyle);
                css(this.mergeBtn, commonStyle);
                css(this.removeBtn, commonStyle);
                css(renameBtn, {
                    cssFloat: 'left',
                    height: '30px',
                    lineHeight: '20px',
                });

                this.addBtn.title = LANG('layers-new');
                this.duplicateBtn.title = LANG('layers-duplicate');
                this.removeBtn.title = LANG('layers-remove');
                this.mergeBtn.title = LANG('layers-merge');
                renameBtn.title = LANG('layers-rename-title');

                this.addBtn.innerHTML = "<img src='" + addLayerImg + "' height='20'/>";
                this.duplicateBtn.innerHTML = "<img src='" + duplicateLayerImg + "' height='20'/>";
                this.mergeBtn.innerHTML = "<img src='" + mergeLayerImg + "' height='20'/>";
                this.removeBtn.innerHTML = "<img src='" + removeLayerImg + "' height='20'/>";
                renameBtn.innerHTML = "<img src='" + renameLayerImg + "' height='20'/>";
                div.append(
                    c(',flex,gap-5,mb-10', [
                        this.addBtn,
                        this.removeBtn,
                        this.duplicateBtn,
                        this.mergeBtn,
                        renameBtn,
                        c(',grow-1'),
                        this.moreDropdown.getElement(),
                    ]),
                );

                // 5. 【核心业务逻辑处理】：
                // 注意每个点击事件中第一行都是 `this.applyUncommitted()`
                // TODO：sai2如果处于调整状态，不能进行图层操作
                // 这体现了工程的一致性：任何对图层结构的修改，必须先终结当前可能的“悬空状态”（如变形、选区）
                // [新建图层]
                this.addBtn.onclick = () => {
                    this.applyUncommitted();
                    // 让内核根据当前被选中的层号 (selectedSpotIndex) 往上插一层。
                    // 如果内核计算后发现已触及显存分配上限 (MAX_LAYERS)，返回 false 并被直接拦截拦截！
                    if (this.klCanvas.addLayer(this.selectedSpotIndex) === false) {
                        return;
                    }
                    // 拿取最新显存快照：因为多了一层，重新拉取底层真实的图层引用数组
                    this.klCanvasLayerArr = this.klCanvas.getLayers();

                    this.selectedSpotIndex = this.selectedSpotIndex + 1;
                    // 为什么第二个形参是 false？
                    // 因为底层的 klCanvas.addLayer 内部【已经把“新建图层”这个动作塞入 Ctrl+Z 历史快照栈了】！
                    // 此处仅仅是为了刷新 UI 高亮，绝不能额外再推一条“选中图层”的重复废记录到历史栈。
                    this.onSelect(this.selectedSpotIndex, false);
                    // 重新计算删除按钮是否能点亮、达到上限后是否要灰掉新建按钮
                    this.updateButtons();
                };

                // [克隆/复制图层按钮]
                this.duplicateBtn.onclick = () => {
                    this.applyUncommitted();
                    // 让内核把当前激活的这个层复制一份，塞到当前层的上一格
                    if (this.klCanvas.duplicateLayer(this.selectedSpotIndex) === false) {
                        return;
                    }
                    this.klCanvasLayerArr = this.klCanvas.getLayers();

                    // 新复制的图层必定排在旧图层的上面 (index + 1)，让高亮焦点自动跟着跳去上方新层
                    this.selectedSpotIndex++;
                    this.onSelect(this.selectedSpotIndex, false);
                    this.updateButtons();
                };

                // [删除图层按钮]
                this.removeBtn.onclick = () => {
                    this.applyUncommitted();
                    // 【终极UI防线】：如果现在只剩最后 1 张图层了，直接短路返回！
                    // (虽然 updateButtons 理论上已经把这个按钮 disabled 灰掉了，
                    // 但再加一层 if 代码级校验，能彻底防止用户通过控制台注入或快捷键强行触发删光图层导致白屏崩溃)
                    if (this.layerElArr.length <= 1) {
                        return;
                    }

                    // 1. 底层斩杀：命令内核销毁当前选中的显存纹理释放内存
                    this.klCanvas.removeLayer(this.selectedSpotIndex);
                    // 假设现在有第 0, 1, 2 层。你原本选中了最顶上的“第 2 层”然后把它删了，
                    // 此时剩下的数组只剩 0 和 1 了！如果索引不变 (依旧是 2)，会立刻引发“数组越界崩溃 (Array Out of Bounds)”！
                    // 只要删的不是最底下那层 (index > 0)，就让焦点往下掉一层 (index--)，稳稳落到原图层下面的那张图层身上！
                    if (this.selectedSpotIndex > 0) {
                        this.selectedSpotIndex--;
                    }
                    this.klCanvasLayerArr = this.klCanvas.getLayers();
                    this.onSelect(this.selectedSpotIndex, false);

                    this.updateButtons();
                };

                // [向下合并图层 (Merge Down) 按钮]
                this.mergeBtn.onclick = () => {
                    // fast merge
                    this.applyUncommitted();
                    // 防御性拦截：如果你当前选中的是背景层 (index === 0)，下面没有图层可以给它合并了，直接退避
                    if (this.selectedSpotIndex <= 0) {
                        return;
                    }
                    // 1. 核心显存合并运算：
                    // 指挥内核把当前层 (selectedSpotIndex) 的所有像素，
                    // 结合当前的混合模式 (Multiply, Screen等) 和不透明度，
                    // 极其精准地渲染到它正下方的那个图层 (selectedSpotIndex - 1) 身上，并把上面这层销毁！
                    this.klCanvas.mergeLayers(this.selectedSpotIndex, this.selectedSpotIndex - 1);
                    this.klCanvasLayerArr = this.klCanvas.getLayers();
                    // 2. 上面那层已经被融进下层了，此时焦点自动下移到被注入了新像素的“接收层”！
                    this.selectedSpotIndex--;
                    this.onSelect(this.selectedSpotIndex, false);
                    this.updateButtons();
                };

                // [重命名图层按钮]
                renameBtn.onclick = () => {
                    this.applyUncommitted();
                    // 调用前文拆解过弹窗改名交互函数
                    this.renameLayer(this.selectedSpotIndex);
                };
            };
            // 将整个工具栏配置流程塞入下一毫秒的微任务队列，保障 UI 首次渲染的极致顺滑
            setTimeout(async, 1);
            return div;
        };
        this.rootEl.append(createButtons());

        // ==========================================
        // ! 【图层混合模式选择器面板 (Blending Mode UI)】
        // ==========================================
        let modeWrapper;
        {
            // 1. 创建包装容器：内含国际化文本 "混合模式 (Blending): " 并预留不间断空格 (&nbsp;)
            modeWrapper = BB.el({
                content: LANG('layers-blending') + '&nbsp;',
                css: {
                    fontSize: '15px',
                },
            });

            // 2. 【核心组件：实例化混合模式下拉选择器】
            this.modeSelect = new Select<TMixMode>({
                // 【神级映射数组配置】：
                // 为什么数组里穿插了这么多 `undefined`？
                // 解释：在传统的 Photoshop 或 GIMP 中，混合模式是“按光影逻辑分组”的！
                // 正常 -> (分割线) -> 减光组 -> (分割线) -> 加光组 -> (分割线) -> 对比组...
                // 此处每一个 `undefined`，在 Select 内部渲染时，都会被转化为一条标准的 HTML `<hr>` 分割线！
                optionArr: [
                    'source-over', // 正常模式 (Normal)
                    undefined,     // --- [分组分割线：基础/覆盖] ---
                    'darken',      // 变暗
                    'multiply',    // 正片叠底 (最常用的阴影绘制模式)
                    'color-burn',  // 颜色加深
                    undefined,     // --- [分组分割线：减光组] ---
                    'lighten',     // 变亮
                    'screen',      // 滤色 / 屏幕 (最常用的发光特效绘制模式)
                    'color-dodge', // 颜色减淡
                    undefined,     // --- [分组分割线：加光组] ---
                    'overlay',     // 叠加
                    'soft-light',  // 柔光
                    'hard-light',  // 强光
                    undefined,     // --- [分组分割线：对比度组] ---
                    'difference',  // 差值
                    'exclusion',   // 排除
                    undefined,     // --- [分组分割线：数学反选组] ---
                    'hue',         // 色相
                    'saturation',  // 饱和度
                    'color',       // 颜色 (后期上色神级模式)
                    'luminosity',  // 明度
                ].map((item: any) => {
                    // 如果不是 undefined，返回 [英文字符串常量, 翻译后的本地化UI名字]
                    // 如果是 undefined，直接原样返回，交由 UI 底层转为分割线
                    return item ? [item, translateBlending(item)] : undefined;
                }),
                // 【状态机回调：当画师在下拉菜单里切了不同的混合模式时触发】
                onChange: (val) => {
                    // A. 指挥底层画布显存将该图层合成模式改写 (例如改为 Canvas API 支持的 'multiply')
                    this.klCanvas.setMixMode(this.selectedSpotIndex, val as TMixMode);
                    // B. 局部更新页面 UI 和右侧面板状态
                    this.update(this.selectedSpotIndex);
                },
                css: {
                    marginBottom: '10px',
                },
                name: 'layer-blend-mode',
            });

            modeWrapper.append(this.modeSelect.getElement());
            this.rootEl.append(modeWrapper);
        }

        this.rootEl.append(listDiv);

        // ==========================================
        // 【终极闭包联结：历史记录中枢监听 (History Hub Listener)】
        // ! 这里是整个列表的更新中枢！历史记录栈监听器变化才更新
        // ==========================================
        this.klHistory.addListener(() => {
            // 【极速渲染节流 (Render Throttling)】：
            // 如果当前的图层面板 (Layers tab) 压根没在屏幕上打开显示（例如用户正看着笔刷或者色盘面板），
            // 绝对不要去重新渲染图层列表！省下极其宝贵的 CPU 处理时间！
            if (this.rootEl.style.display !== 'block') {
                return;
            }
            // 一旦确认面板正在显示，且用户刚按了 Ctrl+Z / Ctrl+Y (或者刚画完一笔)，
            // 唤起全量/增量页面核对引擎，确保图层卡片上的缩略图、层顺序与最新快照 100% 对齐！
            this.createLayerList();
        });
        // 构造函数收尾：进行应用首屏的第一次图层列表初始化构造！
        this.createLayerList();
    }

    // ---- interface ----
    // ==========================================
    // 【对外公共接口与命令调控中心 (Public Interface)】
    // ==========================================
    /**
     * 【全量外部状态同步驱动】：当工作区从外部（如键盘快捷键、重做撤销等）强行变更了图层状态时调用
     * @param activeLayerSpotIndex 当前需要被设为高亮激活的图层物理槽位
     */
    update(activeLayerSpotIndex?: number): void {
        // 1. 从底层内核重新抓取最新的图层显存引用数组
        this.klCanvasLayerArr = this.klCanvas.getLayers();
        // 2. 【避开 JS 0 值陷阱 (Falsy Zero Trap)】：
        // 绝对不能只写 `if (activeLayerSpotIndex)`！因为第 0 层（背景层）的索引用布尔转换会变成 false！
        // 必须显式加上 `|| activeLayerSpotIndex === 0`，才能让背景层正确接受外部选中指令。
        if (activeLayerSpotIndex || activeLayerSpotIndex === 0) {
            this.selectedSpotIndex = activeLayerSpotIndex;
        }
        // 3. 重新核对顶部按钮（如删至一层时置灰删除键）
        this.updateButtons();
        // 4. 【极客节流屏障 (Visibility Guard)】：
        // 如果当前图层面板被隐藏（例如用户切去了别的工具 Tab），绝不重新创建 DOM 列表！
        // 等到用户下次点开面板时，自然的流程会再去刷屏，省下宝贵的 CPU 布局周期。
        if (this.isVisible) {
            this.createLayerList();
        }
    }

    /**
     * 获取当前被选中/激活图层的物理槽位索引
     */
    getSelected(): number {
        return this.selectedSpotIndex;
    }

    /**
     * 【精准图层聚焦激活 (In-Place Layer Activation)】
     * 负责将指定的图层卡片设为 UI 上的“活跃图层”（高亮蓝框、挂载不透明度滑块），并同步顶部混合模式选择器。
     */
    activateLayer(spotIndex: number): void {
        // 1. 数组越界防御：防止快捷键疯狂狂按导致索引溢出
        if (spotIndex < 0 || spotIndex > this.layerElArr.length - 1) {
            throw (
                'invalid spotIndex ' + spotIndex + ', layerElArr.length ' + this.layerElArr.length
            );
        }
        this.selectedSpotIndex = spotIndex;

        // 2. 【核心状态联动】：让顶部的下拉框自动变成当前图层的混合模式（如从 normal 自动变成 multiply）
        this.modeSelect.setValue(this.klCanvasLayerArr[this.selectedSpotIndex].mixModeStr);

        // 3. 【极速原地 DOM 样式切换 (In-Place DOM Mutation)】：
        // 遍历内存里的所有行卡片，只做 CSS class 和激活态的开关！
        // 绝不调用 createLayerList 去销毁重建整个 DOM 树，保证 144Hz 的丝滑切层手感！
        for (let i = 0; i < this.layerElArr.length; i++) {
            const layer = this.layerElArr[i];
            const isSelected = this.selectedSpotIndex === layer.spot;

            css(layer, {
                boxShadow: '',
            });
            // 切换高亮样式样式 class
            layer.classList.toggle('kl-layer--selected', isSelected);
            // 告诉对应的 PointSlider 滑动条：“你被选中了/你失去了焦点”
            layer.opacitySlider.setActive(isSelected);
            layer.isSelected = isSelected;
        }
        // 4. 安全锁联动：选到最底层（背景层）时，强行禁用“向下合并”按钮
        this.mergeBtn.disabled = this.selectedSpotIndex === 0;
    }

    /**
     * 【响应式布局适配器 (Responsive Spatial Awareness)】：
     * 针对用户将工具栏停靠在工作区左侧 (`'left'`) 还是右侧 (`'right'`) 做视觉补偿
     */
    setUiState(stateStr: TUiLayout): void {
        this.uiState = stateStr;

        // 【大图放大镜的防遮挡物理换位】：
        // 如果图层列表本身靠着屏幕最左边 (`'left'`)，那么放大镜弹窗就必须出现在面板的【右边】(left: 280px)！
        // 如果面板靠屏幕右边，放大镜就得从面板的【左侧】弹出来 (right: 280px)！
        // 否则 250x250 的巨大预览框直接会覆盖掉图层列表本身，甚至飞出屏幕可视区域！
        if (this.uiState === 'left') {
            css(this.largeThumbDiv, {
                left: '280px',
                right: '',
            });
        } else {
            css(this.largeThumbDiv, {
                left: '',
                right: '280px',
            });
        }
    }

    getElement(): HTMLElement {
        return this.rootEl;
    }

    /**
     * 【高级合并对话框调起接口 (Advanced Merge Modal)】：
     * 当常规的“直接向下合并”无法满足画师需求时（如想要保留特定混合模态、提取 Alpha 蒙版），触发此高级弹窗
     * TODO:sai2不存在特殊合并模式
     */
    advancedMergeDialog(): void {
        this.applyUncommitted();
        if (this.selectedSpotIndex <= 0) {
            return;
        }
        mergeLayerDialog(this.parentEl, {
            topCanvas: this.klCanvasLayerArr[this.selectedSpotIndex].context.canvas,
            bottomCanvas: this.klCanvasLayerArr[this.selectedSpotIndex - 1].context.canvas,
            topOpacity: this.klCanvas.getLayerOld(this.selectedSpotIndex)!.opacity,
            mixModeStr: this.klCanvasLayerArr[this.selectedSpotIndex].mixModeStr,
            callback: (mode) => {
                this.klCanvas.mergeLayers(
                    this.selectedSpotIndex,
                    this.selectedSpotIndex - 1,
                    mode as TMixMode | 'as-alpha',
                );
                this.klCanvasLayerArr = this.klCanvas.getLayers();
                this.selectedSpotIndex--;

                //this.createLayerList();
                this.onSelect(this.selectedSpotIndex, false);

                this.updateButtons();
            },
        });
    }

    /**
     * 控制整个图层面板 DOM 容器的显隐
     */
    setIsVisible(b: boolean): void {
        if (b === this.isVisible) {
            return;
        }
        this.isVisible = b;
        this.rootEl.style.display = b ? 'block' : 'none';
    }
}
