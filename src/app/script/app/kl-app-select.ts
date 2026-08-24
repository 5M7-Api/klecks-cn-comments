import { SelectUi, TSelectToolMode } from "../klecks/ui/tool-tabs/select-ui";
import { EaselSelect } from "../klecks/ui/easel/tools/easel-select";
import { KlCanvas } from "../klecks/canvas/kl-canvas";
import { throwIfNull } from "../bb/base/base";
import { SelectTool } from "../klecks/select-tool/select-tool";
import { FfdRenderer } from "../klecks/transform/ffd-renderer";
import {
  KlTempHistory,
  TTempHistoryEntry,
} from "../klecks/history/kl-temp-history";
import { StatusOverlay } from "../klecks/ui/components/status-overlay";
import { showModal } from "../klecks/ui/modals/base/showModal";
import { LANG } from "../language/language";
import { KlHistory } from "../klecks/history/kl-history";
import { boundsToRect, rectToBounds } from "../bb/math/math";
import { TInterpolationAlgorithm } from "../klecks/kl-types";
import { klCanvasTransform } from "../klecks/canvas/kl-canvas-transform";
import { testComposedLayerHasTransparency } from "../klecks/filters/filter-transform";
import { klCanvasFfd } from "../klecks/canvas/kl-canvas-ffd";
import {
  centerTransformation,
  flipTransformation,
  freeTransformToMatrix,
  rectToFreeTransform,
  rotateTransformation,
  scaleTransformation,
  TComposedTransformation,
  transformFfd,
  transformSelection,
} from "../klecks/transform/composed-transformation";
import { MultiPolygon } from "polygon-clipping";
import { createFfdLattice } from "../klecks/transform/ffd";
import { getSelectionBoundsFromSample } from "../klecks/transform/get-selection-sample-bounds";
import { BB } from "../bb/bb";
import { createTransformationComposite } from "../klecks/transform/create-transformation-composite";
import { THistoryExecutionType } from "../klecks/history/kl-history-executor";
import {
  createSelectionSample,
  TSelectionSample,
} from "../klecks/transform/selection-sample";
import { getFfdBounds } from "../klecks/transform/ffd-utils";

export type TSelectTransformTempEntry = {
  type: "select-transform";
  // 【极客内存优化】：这里存的绝对不是整张图的像素数据，而仅仅是变形过程中的几个核心数学属性。
  // 这样即使用户在一秒内拖拽了 60 次，产生 60 个历史切片，总内存占用也仅有几百 KB。
  data: {
    // 【核心】：纯数学矩阵/四角网格数据
    transform: TComposedTransformation;
    // 用户是按着 Alt 拖拽的吗？(true表示只复制不剪切原图层)
    doClone: boolean;
    targetLayerIndex: number;
    // 背景层是否透明（影响剪切后，原图层挖空部分的补底颜色处理）
    // ? 可能没啥用
    backgroundIsTransparent: boolean;
    // 图像放大缩小重采样时的插值算法 (如 Nearest-neighbor 临近像素, Bilinear 双线性等)
    algorithm: TInterpolationAlgorithm;
  };
};

/**
 * 类型守卫函数 (Type Guard)
 * 作用：在复杂的历史记录栈遍历中，安全、强制地判断当前拿到的条目是否是我们的【选区变形条目】。
 * 保证 TypeScript 在编译期就能拦截掉类型错误。
 */
function isSelectTransformTempEntry(
  entry: TTempHistoryEntry,
): entry is TSelectTransformTempEntry {
  return entry.type === "select-transform" && !!entry.data;
}

/**
 * =========================================================================
 * 变形操作实时状态机 (Transform State)
 * 作用：当选区工具处于“活跃变形状态”时，内存中维护的完整数据结构。
 * 它持有“矢量蚂蚁线”与“抠出的位图小块”，两者在屏幕上同步渲染。
 * =========================================================================
 */
type TTransformState = {
  // 矢量多边形对象 (我们在更早探讨过的那个 3层 map 结构)
  selection?: MultiPolygon;
  // 像素位图样本 (从原画布上抠下来的那块图像)
  selectionSample: TSelectionSample;
  transform: TComposedTransformation;
  algorithm: TInterpolationAlgorithm;
  doClone: boolean;
  // 是否进入了高级的“网格变形/液化(Warp/FFD)”模式 (为后续工具预留的扩展接口)
  isWarping: boolean;
  targetLayerIndex: number;
  // ? 可能没啥用
  backgroundIsTransparent: boolean;
};

/**
 * =========================================================================
 * 初始化变形状态 (State Initialization)
 * 作用：当用户按下“自由变换”快捷键（Ctrl+T）那一瞬间，工厂函数生成初始的“机甲驾驶舱”数据。
 * =========================================================================
 */
function initialiseTransformState(p: {
  selection?: MultiPolygon;
  selectionSample: TSelectionSample;
  algorithm: TInterpolationAlgorithm;
  targetLayerIndex: number;
  backgroundIsTransparent: boolean;
}): TTransformState {
  const selectionSample = p.selectionSample;
  // 【物理引擎绑定】：根据抠出来的像素样本，计算出物理外包围矩形 (Bounding Box)
  // 这个框就是用户稍后在界面上看到的那个带有 8 个控制把手的变形外框
  const selectionBounds = getSelectionBoundsFromSample(p.selectionSample);
  // 初始化变形矩阵数据
  const transform: TComposedTransformation = {
    // no ffd initially
    // 初始状态为普通的“自由变换 (Free Transform)”，尚未启用网格变形 (no ffd initially)
    type: "free",
    // 矩阵转换：
    // boundsToRect: 把简单的 {x1, y1, x2, y2} 转换成 {x, y, w, h} 的通用矩形格式
    // rectToFreeTransform: 将矩形提取为用于矩阵运算的四角 8 个点坐标 (用于后续的拉伸扭曲计算)
    freeTransform: rectToFreeTransform(boundsToRect(selectionBounds)),
  };

  // 组装并返回这台“变形状态机”的初始数据对象
  return {
    selection: p.selection,
    selectionSample,
    transform,
    algorithm: p.algorithm,
    // 默认不克隆，即执行普通的剪切移动
    doClone: false,
    // 默认只是四角拉伸旋转，不启用高耗能网格扭曲
    isWarping: false,
    targetLayerIndex: p.targetLayerIndex,
    backgroundIsTransparent: p.backgroundIsTransparent,
  };
}

/**
 * =========================================================================
 * 选区工具环境依赖接口 (Dependency Injection)
 * 作用：定义整个选区工具在被创建时，主程序需要给它递交哪些“特权钥匙”。
 * 这是典型的【控制反转 / 依赖注入】架构设计，工具自身极其纯粹，不持有任何全局实体。
 * =========================================================================
 */
export type TKlAppSelectParams = {
  // 画布渲染底座 (包含所有的真实图层大图数据，供提取选区像素用)
  klCanvas: KlCanvas;
  // 暴露获取当前激活图层 2D 上下文的捷径
  getCurrentLayerCtx: () => CanvasRenderingContext2D;
  // 主历史记录栈 (用于记录最终按下 Enter 确认变形后的、昂贵的位图光栅化结果)
  klHistory: KlHistory;
  // 临时交互历史栈 (你的鼠标每次微小拖拽，都会在这里推入上方的 TempEntry 数学快照)
  tempHistory: KlTempHistory;
  // 提示弹窗
  statusOverlay: StatusOverlay;

  // 视图刷新回调
  onUpdateProject: () => void; // update easelProjectUpdater
  // 快捷键指令：在当前选区内直接填充前景色
  onFill: () => void;
  // 快捷键指令：擦除/清空当前选区内容 (对应 Delete 键)
  onErase: () => void;
};

/**
 * Coordinates everything related to selection.
 */
export class KlAppSelect {
  // from params
  private readonly klCanvas: KlCanvas;
  private readonly getCurrentLayerCtx: () => CanvasRenderingContext2D;
  // 主历史记录栈
  private readonly klHistory: KlHistory;
  // 极高频临时历史记录栈 (存数学矩阵快照)
  private readonly tempHistory: KlTempHistory;
  private readonly statusOverlay: StatusOverlay;

  // 外部回调
  private readonly onUpdateProject: () => void;
  private readonly onFill: () => void;
  private readonly onErase: () => void;

  // UI 操控面板
  private readonly selectUi: SelectUi;
  // 视图层工具：负责在屏幕上渲染那条一直在动的“蚂蚁线”！
  private readonly easelSelect: EaselSelect; // easel tool
  // 逻辑层工具：负责接管鼠标移动，计算多边形路径。
  private readonly selectTool: SelectTool;
  // 高级网格变形 (Free-Form Deformation) 渲染器
  private readonly ffdRenderer: FfdRenderer;
  private readonly onVisibilityChange: () => void;

  // state
  private selectMode: TSelectToolMode = "select"; // 默认是 'select' (用套索画圈)。按下Ctrl+T变成 'transform'
  private transformState: undefined | TTransformState; // 当进入 'transform' 模式时，挂载极其复杂的变形状态数据。

  // ----------------------------------- private methods -----------------------------------

  /**
   * 【脏检查优化】：判断用户是否真的对选区进行了变形操作。
   *
   * 应用场景：用户按了 Ctrl+T 唤出了变形框，但手抖了一下又直接按了 Enter 或 Esc。
   * 此时实际上图像并没有发生任何物理改变。
   * 如果不加这个检查，系统会傻乎乎地去执行极其耗时的“图像重采样(Resampling)”并推入主历史栈，
   * 导致内存白白浪费，甚至卡顿一下。
   *
   * @returns boolean 是否发生了实质性的物理变化
   */
  private isTransformationChanged(): boolean {
    // 如果根本不在变形模式，自然没变
    if (!this.transformState) {
      return false;
    }
    // 拿出临时历史栈里的第 0 个快照
    const initial = this.tempHistory.getEntries()[0];
    // 【防呆断言】：确保拿到的第一条记录真的是针对变形的快照
    if (!isSelectTransformTempEntry(initial)) {
      throw new Error("initial temp history entry has wrong type");
    }
    // 判断 1：用户是不是中途按住了 Alt 键，把“剪切移动”变成了“复制移动”？如果是，说明发生变化了！
    if (this.transformState.doClone !== initial.data.doClone) {
      return true;
    }
    // 判断 2：用户是不是在变形中途，跑到图层面板切换了正在操控的图层？
    if (
      this.transformState.targetLayerIndex !== initial.data.targetLayerIndex
    ) {
      return true;
    }
    // 判断 3：【暴力但高效的矩阵对比】
    // 数学上要完美对比两个自由变换矩阵是否完全相等非常麻烦 (涉及浮点数精度、浮点偏移等)。
    // 这里的架构师选择了一种极其接地气的工业解法：直接 JSON 序列化比较字符串！
    // 如果四个角的顶点坐标发生了一丝一毫的偏离，生成的 JSON 字符串必然不同。
    // not perfect but would be a lot of effort to determine if two transforms are equivalent
    return (
      JSON.stringify(this.transformState.transform) !==
      JSON.stringify(initial.data.transform)
    );
  }

  /**
   * 【图形学清理】：重置底层 Canvas 的图层合成属性 (Composites)
   *
   * 背景知识：在变形选区的时候（特别是拖拽移动一小块图像时），
   * 为了让用户实时预览这块图像悬浮在别的图层上方的效果，引擎通常会在内部使用
   * globalCompositeOperation = 'destination-out' 挖空原图，然后在上方用另一层临时画出悬浮块。
   *
   * 作用：当变形被确认或取消时，必须把这些底层的“挖空/悬浮”特效撤掉，恢复图层原貌。
   */
  /** reset KlCanvas layer composites **/
  private resetKlCanvasLayerComposites(): void {
    const srcLayerCtx = this.getCurrentLayerCtx();
    // 获取当前工作图层在整个大画板里的绝对索引
    // throwIfNull 是一个严格断言防御：如果找不到图层，立刻报错崩溃，绝不带着脏数据往下走。
    const srcLayerIndex = throwIfNull(
      this.klCanvas.getLayerIndex(srcLayerCtx.canvas),
    );
    // 抹除当前图层身上挂载的特殊混合模式特效
    this.klCanvas.setComposite(srcLayerIndex, undefined);
    // 如果在变形过程中，用户跨图层操作了（比如把 A 图层的像素扣出来移到了 B 图层）
    // 还要顺便把 B 图层身上的特效也给扒掉。
    if (
      this.transformState &&
      this.transformState.targetLayerIndex !== srcLayerIndex
    ) {
      this.klCanvas.setComposite(
        this.transformState.targetLayerIndex,
        undefined,
      );
    }
  }

  /**
   * !【核心：实时渲染欺骗引擎】
   * 作用：在用户拖拽选区变形框时，向底层画布注入“实时渲染外挂”。
   * 它是视觉上实现“抠图拖拽预览”的真正幕后黑手。
   * !因为在拖拽过程中，原图层的真实像素并没有被修改。引擎只是在图层上方叠加了一层“幻影 (Composite)”。
   * 只有当用户最终点击“确认/回车”时，幻影才会被“烘焙 (Bake)”进真实的像素数据中。
   */
  private updateComposites(): void {
    // 如果当前没有在变形状态，直接退出
    if (!this.transformState) {
      return;
    }

    const srcLayerCanvas = this.getCurrentLayerCtx().canvas;
    const srcLayerIndex = throwIfNull(
      this.klCanvas.getLayerIndex(srcLayerCanvas),
    );

    // 【数据封包】：把所有数学变形指令和抠出来的像素，打包成一个 Config
    const config: Parameters<typeof createTransformationComposite>[0] = {
      klCanvasWidth: this.klCanvas.getWidth(),
      klCanvasHeight: this.klCanvas.getHeight(),
      // 数学变形矩阵 (位移、缩放、旋转)
      transform: this.transformState.transform,
      // 矢量选区边界 (蚂蚁线路径)
      selection: this.transformState.selection,
      // 悬浮像素大图 (抠出来的图块)
      selectionSample: this.transformState.selectionSample,
      algorithm: this.transformState.algorithm,
      doClone: this.transformState.doClone,
      backgroundIsTransparent:
        srcLayerIndex !== 0 || this.transformState.backgroundIsTransparent,
      ffdRenderer: this.ffdRenderer,
    };
    // 【兵分两路：单图层 vs 跨图层渲染】
    if (srcLayerIndex === this.transformState.targetLayerIndex) {
      // 模式 A：在同一个图层里移动选区
      // 底层渲染器需要同时干两件事：在原位置挖个洞 + 在新位置画出图块
      this.klCanvas.setComposite(
        srcLayerIndex,
        createTransformationComposite(config, "same"),
      );
    } else {
      // 模式 B：跨图层移动 (比如从 图层1 抠出一个苹果，准备放在 图层2 上)
      // 这是一个极其极其复杂的渲染分离逻辑！
      // 1. 对于原图层 (src)，只执行“挖洞”操作 (除非 doClone 为 true)
      this.klCanvas.setComposite(
        srcLayerIndex,
        createTransformationComposite(config, "src"),
      );
      // 2. 对于目标图层 (dest)，只执行“悬浮绘制”操作
      this.klCanvas.setComposite(
        this.transformState.targetLayerIndex,
        createTransformationComposite(config, "dest"),
      );
    }
  }

  /**
   * 【视图同步】：更新 UI 面板上的图层下拉列表
   * 当选区变形涉及跨图层操作时，通知 UI 刷新，让用户知道当前像素将要落入哪个图层。
   */
  private updateUiLayerList(): void {
    this.selectUi.setLayers(
      this.klCanvas.getLayers().map((layer) => {
        return layer.name;
      }),
    );
  }

  /**
   * 【状态清道夫】：彻底重置（取消）当前的选区
   * 作用：清空逻辑层、视图层和 UI 层的多边形状态，取消对画笔操作的区域限制。
   */
  private resetSelection(): void {
    this.selectTool.reset();
    const selection = this.selectTool.getSelection();
    this.klCanvas.setSelection(selection);
    this.selectUi.setHasSelection(!!selection);
  }

  /**
   * 【临时时间胶囊】：将当前的数学变换状态推入轻量级交互历史栈
   * 作用：实现拖拽变形框时的“细粒度撤销 (Ctrl+Z)”。
   */
  private tempHistoryPush(): void {
    if (!this.transformState) {
      return;
    }
    // 1. 生成极轻量级的数学快照 (纯数据载体，无重型位图)
    const newEntry: TSelectTransformTempEntry = {
      type: "select-transform",
      data: {
        // 【关键防御】：必须深拷贝！否则后续的修改会污染历史记录里指向同一个内存地址的对象。
        transform: BB.copyObj(this.transformState.transform),
        doClone: this.transformState.doClone,
        targetLayerIndex: this.transformState.targetLayerIndex,
        backgroundIsTransparent: this.transformState.backgroundIsTransparent,
        algorithm: this.transformState.algorithm,
      },
    };
    // 2. 获取栈顶的最后一条记录
    const topEntry = this.tempHistory.getEntries().at(-1);
    // 3. 【防呆/节流过滤】：
    // 如果这次存的快照和上一次一模一样（比如用户点了一下手柄但没移动就松手了），
    // 坚决不压入历史栈，防止制造无效的撤销步骤恶心用户。
    // skip if no change
    if (JSON.stringify(newEntry) === JSON.stringify(topEntry)) {
      return;
    }
    // 4. 正式压入临时时间线
    this.tempHistory.push(newEntry);
  }

  /**
   * 【中央广播神经】：将形变的改变强制同步给整个绘图引擎系统
   * 作用：当用户拉动控制手柄时，牵一发而动全身。
   * @param skipPushUndo 是否跳过推入撤销栈（比如仅仅是在拖拽过程中的实时预览，不需要记录到历史）
   */
  private propagateTransformationChange(skipPushUndo = false): void {
    if (!this.transformState) {
      return;
    }
    // 1. 【同步矢量边界】：让屏幕上的虚线“蚂蚁线”跟着跑
    if (this.transformState.selection) {
      // 利用纯数学矩阵运算，实时计算出缩放/旋转/平移后的新多边形顶点坐标
      const selection = transformSelection(
        this.transformState.transform,
        this.transformState.selection,
      );
      // 提交给前端 View 视图层(Easel)进行实时路径绘制
      this.easelSelect.setRenderedSelection(selection);
    }
    // 2. 【同步位图视觉】：更新底层渲染欺骗引擎，让图片块跟着鼠标跑
    this.updateComposites();
    // 3. 【同步外部系统】：通知外部的 React/Vue 框架去更新图层缩略图和导航器
    this.onUpdateProject();
    // 4. 【同步侧边栏】：更新右侧 UI 面板（比如可能要刷新 x, y 坐标的数值显示框）
    this.updateSelectUi();
    // 5. 【记录历史】：看情况是否把这一帧当成一个“里程碑”存入临时栈
    !skipPushUndo && this.tempHistoryPush();
  }

  /**
   * 【UI 数值双向绑定同步】：更新右侧属性面板的数值输入框
   * 作用：当用户在画布上直接拖拽“自由变换把手”时，将最新的数学状态反向推给 UI。
   */
  private updateSelectUi(): void {
    if (!this.transformState) {
      return;
    }

    // 【防御性逻辑】：高级的 FFD(网格液化变形) 无法用简单的长宽比和旋转角度来描述！
    // 只有当类型是基础的 'free' (自由变换) 时，才去更新界面上的 x/y/scale 数值框。
    if (this.transformState.transform.type !== "ffd") {
      this.selectUi.setFreeTransformTransformation(
        this.transformState.transform.freeTransform,
      );
    }
  }

  /**
   * 【显存终极清道夫】：彻底销毁当前的变形状态，并释放一切离屏资源。
   * 作用：这是防止 Web 端图形软件发生致命 OOM（Out Of Memory 显存溢出）崩溃的护城河。
   */
  private clearTransformState(): void {
    if (this.transformState) {
      // BB.freeCanvas 内部会通过强制将 canvas.width = 0 来迫使浏览器立刻、当场释放其持有的 VRAM(显存)。
      BB.freeCanvas(this.transformState.selectionSample.image);
      // 安全切断所有引用，允许 JavaScript 引擎在下一轮 GC 销毁状态机对象。
      this.transformState = undefined;
    }
  }

  // ----------------------------------- public -----------------------------------
  constructor(p: TKlAppSelectParams) {
    this.klCanvas = p.klCanvas;
    this.onUpdateProject = p.onUpdateProject;
    this.getCurrentLayerCtx = p.getCurrentLayerCtx;
    this.klHistory = p.klHistory;
    this.tempHistory = p.tempHistory;
    this.statusOverlay = p.statusOverlay;
    this.onFill = p.onFill;
    this.onErase = p.onErase;

    // 2. 【状态同步】：监听主历史栈的变动
    // 应用场景：当用户按 Ctrl+Z 撤销了一次选区操作，我们需要立刻通知右侧 UI 面板更新状态
    // keep layer list up-to-date
    this.klHistory.addListener(() => {
      this.selectUi.setHasSelection(!!this.klCanvas.getSelection());
      if (this.selectMode === "transform") {
        this.updateUiLayerList();
      }
    });

    // 3. 实例化纯逻辑层的选区计算工具（只负责数学多边形的并/交/差集运算）
    this.selectTool = new SelectTool({
      klCanvas: this.klCanvas,
    });
    // 4. 实例化高级网格液化渲染器
    this.ffdRenderer = new FfdRenderer();
    // 5. 【极限显存优化】：后台标签页自动释放
    // 当用户切换到别的浏览器标签页时，强行释放网格变形占用的 GPU 显存，防止浏览器后台崩溃
    this.onVisibilityChange = () => {
      if (document.hidden && this.selectMode === "transform") {
        this.ffdRenderer.freeResources();
      }
    };
    document.addEventListener("visibilitychange", this.onVisibilityChange);

    // 6. 【视图层通信枢纽】：初始化 EaselSelect（屏幕上负责绘制/拖拽虚线框的模块）
    this.easelSelect = new EaselSelect({
      selectMode: this.selectMode,
      // 以下回调将 Easel 的“鼠标滑动”映射为 SelectTool 的“数学计算”，再反哺回 Easel 进行“渲染”
      onStartSelect: (p, operation) =>
        this.selectTool.startSelect(p, operation),
      onGoSelect: (p, isShiftPressed) => {
        this.selectTool.goSelect(p, isShiftPressed); // 计算多边形
        this.easelSelect.setRenderedSelection(this.selectTool.getSelection()); // 实时渲染虚线
      },
      onEndSelect: () => {
        this.selectTool.endSelect();
        const selection = this.selectTool.getSelection();
        this.easelSelect.clearRenderedSelection();
        // ! 真正将选区写入底层 Canvas，产生蒙版限制画笔
        this.klCanvas.setSelection(selection);
        this.selectUi.setHasSelection(!!selection);
      },
      // 针对“仅仅是平移选区虚线框（不包含图像像素）”的操作
      onStartMoveSelect: (p) => {
        this.selectTool.startMoveSelect(p);
      },
      onGoMoveSelect: (p, isShiftPressed) => {
        this.selectTool.goMoveSelect(p, isShiftPressed);
        this.easelSelect.setRenderedSelection(this.selectTool.getSelection());
      },
      onEndMoveSelect: () => {
        this.selectTool.endMoveSelect();
        if (!this.selectTool.getDidMove()) {
          return;
        }
        const selection = this.selectTool.getSelection();
        this.easelSelect.clearRenderedSelection();
        this.klCanvas.setSelection(selection);
        this.selectUi.setHasSelection(!!selection);
      },
      // 魔术棒/油漆桶 等点击后增加多边形区块的操作
      onSelectAddPoly: (p, operation) => {
        this.selectTool.addPoly(p, operation);
        const selection = this.selectTool.getSelection();
        this.klCanvas.setSelection(selection);
        this.selectUi.setHasSelection(!!selection);
      },
      onResetSelection: () => this.resetSelection(),
      // 自由变换框（8个把手）被拖动时的实时回调
      onTransform: (transform) => {
        if (!this.transformState) {
          return;
        }
        // 更新矩阵数据，并通知全图（画布、蚂蚁线、导航器缩略图）进行实时渲染刷新
        this.transformState.transform = transform;
        this.propagateTransformationChange(true);
      },
      // 拖动把手后松开鼠标的瞬间，压入轻量级临时撤销栈
      onTransformEnd: () => {
        this.tempHistoryPush();
      },
    });

    // 7. 【UI 层通信枢纽】：初始化右侧的控制面板
    this.selectUi = new SelectUi({
      // 核心状态机切换：在“选区(套索)”和“变形(Ctrl+T)”之间切换
      onChangeMode: (mode) => {
        if (mode === "select") {
          // ==========================================
          // 退出变形模式 (提交变更 Commit)
          // ==========================================
          const layerIndex = throwIfNull(
            this.klCanvas.getLayerIndex(this.getCurrentLayerCtx().canvas),
          );
          // 防呆：如果真的发生了像素移动/变形/跨图层，才执行昂贵的应用操作
          if (
            this.transformState &&
            (this.isTransformationChanged() ||
              this.transformState.doClone ||
              layerIndex !== this.transformState.targetLayerIndex ||
              this.selectUi.getIsWarping())
          ) {
            // something changed -> apply
            const transform = this.transformState.transform;
            // 基础 2D 仿射变换
            if (transform.type === "free") {
              klCanvasTransform({
                klCanvas: this.klCanvas,
                selectionSample: this.transformState.selectionSample,
                ...(this.transformState.doClone
                  ? {}
                  : { eraseLayerIndex: layerIndex }),
                targetLayerIndex: this.transformState.targetLayerIndex,
                freeTransform: transform.freeTransform,
                backgroundIsTransparent:
                  this.transformState.backgroundIsTransparent,
                algorithm: this.transformState.algorithm,
                selection: this.transformState.selection,
              });
            } else {
              // 高级 FFD 网格液化变形 (支持单纯网格，或带着网格一起外部框选拉伸)
              const ffd =
                transform.type === "ffd+free"
                  ? transformFfd(
                      transform.ffd,
                      freeTransformToMatrix(
                        transform.freeTransform,
                        rectToBounds(transform.ffdBounds, "index"),
                      ),
                    )
                  : transform.ffd;
              if (this.transformState.doClone) {
                klCanvasFfd({
                  klCanvas: this.klCanvas,
                  selectionSample: this.transformState.selectionSample,
                  targetLayerIndex: this.transformState.targetLayerIndex,
                  ffd,
                  algorithm: this.transformState.algorithm,
                  selection: this.transformState.selection,
                  ffdRenderer: this.ffdRenderer,
                });
              } else {
                klCanvasFfd({
                  klCanvas: this.klCanvas,
                  selectionSample: this.transformState.selectionSample,
                  eraseLayerIndex: layerIndex,
                  targetLayerIndex: this.transformState.targetLayerIndex,
                  ffd,
                  backgroundIsTransparent:
                    this.transformState.backgroundIsTransparent,
                  algorithm: this.transformState.algorithm,
                  selection: this.transformState.selection,
                  ffdRenderer: this.ffdRenderer,
                });
              }
            }
            // 提交完毕，释放所有的缓存和小 Canvas 显存
            this.clearTransformState();
            p.statusOverlay.out(LANG("select-transform-applied"), true);
          }

          // 彻底清理临时栈和渲染劫持特效，恢复正常绘图环境
          this.tempHistory.clear();
          this.tempHistory.setIsActive(false);
          this.selectUi.setIsWarping(false);
          this.resetKlCanvasLayerComposites();
          this.ffdRenderer.freeResources();
          this.easelSelect.clearRenderedSelection(true);
          const selection = this.klCanvas.getSelection();
          this.selectTool.setSelection(selection);
          this.selectUi.setHasSelection(!!selection);
          this.onUpdateProject();
          this.easelSelect.setMode(mode);
        } else {
          // ==========================================
          // 进入变形模式 (初始化机甲数据 Init Transform)
          // ==========================================
          // -> transform

          // avoid changing state while mode-change can be rejected
          const currentLayerCanvas = this.getCurrentLayerCtx().canvas;
          const layerIndex = throwIfNull(
            this.klCanvas.getLayerIndex(currentLayerCanvas),
          );
          // 把要变形的像素瞬间抠出来存入内存 (离屏 Canvas)
          const selectionSample = createSelectionSample(
            layerIndex,
            this.klCanvas,
          );
          // 防呆拦截：如果框了一片全透明的地方，直接拒绝进入变形模式
          if (!selectionSample) {
            setTimeout(() => {
              showModal({
                message: LANG("select-transform-empty"),
                type: "error",
              });
            });
            return false;
          }
          this.tempHistory.setIsActive(true);
          const isBgLayer = layerIndex === 0;
          let isTransparent = false;
          // 背景层透明度特判 (如果背景是透明的，剪切移动后原处不会变成白色，而是透明孔洞)
          if (isBgLayer) {
            const layer = Object.entries(
              this.klHistory.getComposed().layerMap,
            ).find(([_, layer]) => layer.index === layerIndex)![1];
            isTransparent = testComposedLayerHasTransparency(layer);
            this.selectUi.setBackgroundIsTransparent(isTransparent);
          }
          // 创建并挂载变形状态机
          this.transformState = initialiseTransformState({
            selection: this.klCanvas.getSelection(),
            selectionSample: selectionSample,
            algorithm: this.selectUi.getAlgorithm(),
            targetLayerIndex: layerIndex,
            backgroundIsTransparent: isTransparent,
          });
          // 压入最开始没做任何操作的第 0 帧快照
          // push initial state
          this.tempHistoryPush();

          // 配置 UI 视图并激活底层渲染劫持引擎
          this.selectUi.setShowTransparentBackgroundToggle(isBgLayer);
          this.updateComposites();
          this.updateUiLayerList();
          this.selectUi.setMoveToLayer(undefined);
          this.onUpdateProject();
          this.easelSelect.setMode(mode);
          // 同步矢量蚂蚁线
          if (this.transformState.selection) {
            const transformedSelection = transformSelection(
              this.transformState.transform,
              this.transformState.selection,
            );
            this.easelSelect.setRenderedSelection(transformedSelection);
          }
          this.easelSelect.initialiseTransform(this.transformState.transform);
          this.updateSelectUi();
        }
        this.selectMode = mode;
        return true;
      },
      // 布尔运算切换：新选区是 替换/相加/相减/相交
      onChangeBooleanOperation: (operation) => {
        this.easelSelect.setBooleanOperation(operation);
      },
      // 选区基础操作面板
      select: {
        shape: this.selectTool.getShape(),
        onChangeShape: (shape) => {
          this.selectTool.setShape(shape); // 修改逻辑层形状 (套索/矩形/椭圆)
          this.easelSelect.setSelectShape(shape); // 修改视图层交互行为
        },
        onReset: () => this.resetSelection(), // 全选取消 (Ctrl+D)
        onAll: () => {
          this.selectTool.selectAll(); // 全选 (Ctrl+A)
          const selection = this.selectTool.getSelection();
          this.klCanvas.setSelection(selection);
          this.selectUi.setHasSelection(!!selection);
        },
        onInvert: () => {
          this.selectTool.invertSelection(); // 反选 (Ctrl+Shift+I)
          const selection = this.selectTool.getSelection();
          this.klCanvas.setSelection(selection);
          this.selectUi.setHasSelection(!!selection);
        },
      },
      // 变形高级操作面板 (翻转/旋转/克隆/图层穿梭/液化)
      transform: {
        // 垂直翻转
        onFlipY: () => {
          if (!this.transformState) {
            return;
          }
          this.transformState.transform = flipTransformation(
            this.transformState.transform,
            "y",
          );
          this.propagateTransformationChange();
          this.easelSelect.setTransform(this.transformState.transform);
        },
        // 水平翻转
        onFlipX: () => {
          if (!this.transformState) {
            return;
          }
          this.transformState.transform = flipTransformation(
            this.transformState.transform,
            "x",
          );
          this.propagateTransformationChange();
          this.easelSelect.setTransform(this.transformState.transform);
        },
        // 精确角度旋转
        onRotateDeg: (deg) => {
          if (!this.transformState) {
            return;
          }
          this.transformState.transform = rotateTransformation(
            this.transformState.transform,
            deg,
          );
          this.propagateTransformationChange();
          this.easelSelect.setTransform(this.transformState.transform);
        },
        // “盖章”克隆功能：中途不退出变形，直接在画布上永久印下一个拷贝
        onClone: () => {
          if (!this.transformState) {
            return;
          }
          // commit
          const layerIndex = throwIfNull(
            this.klCanvas.getLayerIndex(this.getCurrentLayerCtx().canvas),
          );
          const transform = this.transformState.transform;
          // apply
          // should always apply. user might want to make something more opaque.
          if (transform.type === "free") {
            if (this.transformState.doClone) {
              klCanvasTransform({
                klCanvas: this.klCanvas,
                selectionSample: this.transformState.selectionSample,
                targetLayerIndex: this.transformState.targetLayerIndex,
                freeTransform: transform.freeTransform,
                algorithm: this.transformState.algorithm,
                selection: this.transformState.selection,
              });
            } else if (this.isTransformationChanged()) {
              klCanvasTransform({
                klCanvas: this.klCanvas,
                selectionSample: this.transformState.selectionSample,
                eraseLayerIndex: layerIndex,
                targetLayerIndex: this.transformState.targetLayerIndex,
                freeTransform: transform.freeTransform,
                backgroundIsTransparent:
                  this.transformState.backgroundIsTransparent,
                algorithm: this.transformState.algorithm,
                selection: this.transformState.selection,
              });
            }
          } else {
            // FFD 液化相关克隆处理
            const ffd =
              transform.type === "ffd+free"
                ? transformFfd(
                    transform.ffd,
                    freeTransformToMatrix(
                      transform.freeTransform,
                      rectToBounds(transform.ffdBounds, "index"),
                    ),
                  )
                : transform.ffd;
            if (this.transformState.doClone) {
              klCanvasFfd({
                klCanvas: this.klCanvas,
                selectionSample: this.transformState.selectionSample,
                targetLayerIndex: this.transformState.targetLayerIndex,
                ffd,
                algorithm: this.transformState.algorithm,
                selection: this.transformState.selection,
                ffdRenderer: this.ffdRenderer,
              });
            } else if (this.isTransformationChanged()) {
              klCanvasFfd({
                klCanvas: this.klCanvas,
                selectionSample: this.transformState.selectionSample,
                eraseLayerIndex: layerIndex,
                targetLayerIndex: this.transformState.targetLayerIndex,
                ffd,
                backgroundIsTransparent:
                  this.transformState.backgroundIsTransparent,
                algorithm: this.transformState.algorithm,
                selection: this.transformState.selection,
                ffdRenderer: this.ffdRenderer,
              });
            }
          }

          // 克隆后，将状态从“剪切模式”强行转入“克隆模式”
          this.tempHistory.clear();
          // push initial state
          this.tempHistoryPush();

          this.transformState.doClone = true;
          this.updateComposites();
          this.onUpdateProject();

          this.statusOverlay.out(LANG("select-transform-clone-applied"), true);
        },
        // 百分比缩放
        onScale: (factor) => {
          if (!this.transformState) {
            return;
          }
          this.transformState.transform = scaleTransformation(
            this.transformState.transform,
            factor,
          );
          this.propagateTransformationChange();
          this.easelSelect.setTransform(this.transformState.transform);
        },
        // 一键居中
        onCenter: () => {
          if (!this.transformState) {
            return;
          }
          this.transformState.transform = centerTransformation(
            this.transformState.transform,
            {
              x: this.klCanvas.getWidth() / 2,
              y: this.klCanvas.getHeight() / 2,
            },
          );
          this.propagateTransformationChange();
          this.easelSelect.setTransform(this.transformState.transform);
        },
        // 跨图层降维转移：选中一块像素，直接丢到其他图层
        onMoveToLayer: (index) => {
          if (!this.transformState) {
            return;
          }
          this.resetKlCanvasLayerComposites();
          this.transformState.targetLayerIndex = index;
          this.updateComposites();
          this.onUpdateProject();
          this.tempHistoryPush();
        },
        // 切换重采样算法（如临近像素、双线性）
        onChangeTransparentBackground: (isTransparent) => {
          if (!this.transformState) {
            return;
          }
          this.transformState.backgroundIsTransparent = isTransparent;
          this.updateComposites();
          this.onUpdateProject();
          this.tempHistoryPush();
        },
        onChangeAlgorithm: (algorithm) => {
          if (!this.transformState) {
            return;
          }
          this.transformState.algorithm = algorithm;
          this.updateComposites();
          this.onUpdateProject();
          this.tempHistoryPush();
        },
        onChangeConstrain: (isConstrained) => {
          // 开启约束（Shift 等比缩放）
          this.easelSelect.setIsConstrained(isConstrained);
        },
        onChangeSnapping: (isSnapping) => {
          // 开启吸附（磁吸对齐）
          this.easelSelect.setIsSnapping(isSnapping);
        },
        onChangeWarp: (isWarping) => {
          // 【神级降维与升维机制】：在 普通 4 角形变换与 5x5 网格 FFD 液化之间切换！
          if (!this.transformState) {
            return;
          }
          const transform = this.transformState.transform;
          if (isWarping) {
            if (transform.type === "free") {
              // 升维：将 4角矩阵转化并施加到一个新生成的 5x5 网格上
              const selectionBounds = getSelectionBoundsFromSample(
                this.transformState.selectionSample,
              );
              const matrix = freeTransformToMatrix(
                transform.freeTransform,
                selectionBounds,
              );
              this.transformState.transform = {
                type: "ffd",
                ffd: transformFfd(
                  createFfdLattice(5, 5, boundsToRect(selectionBounds)),
                  matrix,
                ),
              };
            } else if (transform.type === "ffd+free") {
              // 从叠加复合状态恢复回纯网格状态
              const matrix = freeTransformToMatrix(
                transform.freeTransform,
                rectToBounds(transform.ffdBounds, "index"),
              );
              this.transformState.transform = {
                type: "ffd",
                ffd: transformFfd(transform.ffd, matrix),
              };
            }
          } else {
            if (transform.type === "ffd") {
              // 降维：网格已经被扭曲，无法转回普通四角框。
              // 方案：将原网格冻结，并在外面套一个新的四角自由变换框 (ffd+free 状态嵌套)！
              const ffdBounds = boundsToRect(getFfdBounds(transform.ffd));
              const freeTransform = rectToFreeTransform(ffdBounds);
              this.transformState.transform = {
                type: "ffd+free",
                ffd: BB.copyObj(transform.ffd),
                ffdBounds,
                freeTransform,
              };
            }
          }
          this.transformState.isWarping = isWarping;
          this.easelSelect.setTransform(this.transformState.transform);
          this.updateComposites();
          this.onUpdateProject();
          this.tempHistoryPush();
        },
      },
      // 捷径指令绑定
      onErase: () => {
        this.onErase(); // Delete键清空选区
      },
      onFill: () => {
        this.onFill(); // 快捷填充前景色
      },
    });

    // 8. 最后的底线保护：每当历史记录改变时，确保逻辑层里的选区路径和底层真实画板同步
    this.klHistory.addListener(() => {
      const selection = this.klCanvas.getSelection();
      if (this.selectMode === "select") {
        this.selectTool.setSelection(selection);
      }
    });
  }

  getSelectUi(): SelectUi {
    return this.selectUi;
  }

  getEaselSelect(): EaselSelect {
    return this.easelSelect;
  }

  getSelectMode(): TSelectToolMode {
    return this.selectMode;
  }

  /**
   * 【大局观架构：统一指令出口】
   * 作用：提交（确认）当前的变形操作。
   * 精髓：它本身没有任何渲染逻辑，而是巧妙地通过切换 UI 模式，
   * 来触发构造函数中注册的那个极其复杂的 onChangeMode 回调。
   * 保证了无论是按钮点击、回车键还是代码调用，出口绝对统一。
   *
   * @returns boolean 是否真的触发了提交
   */
  /**
   * If transform changed something, changes are applied. -> return true
   * If no changes applied -> return false
   */
  commitTransform(): boolean {
    let result = false;
    if (this.selectMode === "transform") {
      // 切换回套索模式，这会同步触发 SelectUi 内部的 onChangeMode，执行真正的像素应用逻辑
      this.selectUi.setMode("select"); // this triggers selectUi.onMode
      result = true;
    }
    return result;
  }

  /**
   * 【杀人灭口：取消变形】
   * 作用：放弃当前的变形操作（通常由 Esc 键或取消按钮触发）。
   * 精髓：在触发统一出口前，提前将内存里的 transformState 清空。
   * 当执行大审判（onChangeMode）时，由于找不到状态机，直接放弃一切绘制。
   */
  /** if transforming, changes are discarded */
  discardTransform(): boolean {
    if (this.selectMode === "transform") {
      // 提前销毁证据：把变形矩阵和位图样本都设为 undefined
      // so there's no transformation to apply.
      this.clearTransformState();
      // this triggers selectUi.onMode synchronously, which does the cleanup
      this.selectUi.setMode("select");
      return true;
    }
    return false;
  }

  /**
   * 【时光倒流机器】：响应临时历史记录的微步撤销/重做
   * 作用：当用户在拉伸变形框中途按 Ctrl+Z/Ctrl+Y 时，回退/前进一个数学变换状态。
   */
  onHistory(type: THistoryExecutionType): void {
    // 只有当存在活跃的变形状态机，且触发的确实是“微历史（tempUndo/Redo）”时才执行
    if (this.transformState && (type === "tempUndo" || type === "tempRedo")) {
      // 1. 打扫案发现场：清除旧的图层悬浮挖空效果
      this.resetKlCanvasLayerComposites();
      // 2. 拿出刚被推到栈顶的那张旧照片 (历史切片)
      // recreate
      const entries = this.tempHistory.getEntries();
      const top = entries.at(-1)!;
      // 类型断言防呆保护
      if (!isSelectTransformTempEntry(top)) {
        return;
      }
      const state = top.data;
      // 3. 【暴力覆盖】：用历史切片里的数据，强制覆盖当前状态机里的所有物理属性
      this.transformState.transform = BB.copyObj(state.transform); // 必须深拷贝！
      this.transformState.doClone = state.doClone;
      this.transformState.targetLayerIndex = state.targetLayerIndex;
      this.transformState.backgroundIsTransparent =
        state.backgroundIsTransparent;
      this.transformState.algorithm = state.algorithm;
      this.transformState.isWarping = state.transform.type === "ffd";
      // 4. 同步右侧 UI 控制面板的状态开关 (透明保护、重采样算法等)
      this.selectUi.setBackgroundIsTransparent(state.backgroundIsTransparent);
      this.selectUi.setAlgorithm(state.algorithm);
      this.selectUi.setIsWarping(state.transform.type === "ffd");
      // 5. 【矢量同步】：如果在拖拽时有蚂蚁线选区，重新用旧矩阵把多边形投射回旧位置
      if (this.transformState.selection) {
        const selection = transformSelection(
          this.transformState.transform,
          this.transformState.selection,
        );
        this.easelSelect.setRenderedSelection(selection);
      }
      // 6. 【UI同步】：把手柄框移动回旧位置，并刷新图层选择下拉框
      this.easelSelect.setTransform(this.transformState.transform);
      this.selectUi.setMoveToLayer(
        this.klCanvas.getLayerIndex(this.getCurrentLayerCtx().canvas) ===
          state.targetLayerIndex
          ? undefined
          : state.targetLayerIndex,
      );
      // 7. 【渲染欺骗重置】：把底层的位图小块也悬浮回旧位置，并高喊全世界更新缩略图
      this.updateComposites();
      this.onUpdateProject();
      this.updateSelectUi();
    }
  }

  destroy(): void {
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    // not a proper cleanup yet
  }
}
