import { KlCanvas } from '../../canvas/kl-canvas';
import { Easel } from './easel';
import { BB } from '../../../bb/bb';
import { throwIfNull } from '../../../bb/base/base';

export type TEaselProjectUpdaterParams<T extends string> = {
    klCanvas: KlCanvas;
    easel: Easel<T>;
};

/**
 * 适配器：将 KlCanvas 的内部数据结构转换为 Easel 渲染器能理解的格式。
 * 当 KlCanvas 状态改变时 (增删改图层、撤销重做)，它负责同步更新渲染器。
 */
/**
 * Allows KlCanvas to be rendered by Easel.
 * Call update when KlCanvas changed (added layer, moved layer, removed layer, changed selection, redo/undo)
 */
export class EaselProjectUpdater<T extends string> {
    private readonly klCanvas: KlCanvas;
    private readonly easel: Easel<T>;
    // 缓存一个用于处理“动态滤镜/合成”的临时 Canvas
    private compositeCanvas: HTMLCanvasElement | undefined;

    // ----------------------------------- public -----------------------------------
    constructor(p: TEaselProjectUpdaterParams<T>) {
        this.klCanvas = p.klCanvas;
        this.easel = p.easel;
        this.update();
    }

    // TODO: 这个方法提笔才调用，需要优化layer的循环吗？
    /**
     * 同步更新：将 KlCanvas 数据模型推送到渲染器
     */
    update(): void {
        const width = this.klCanvas.getWidth();
        const height = this.klCanvas.getHeight();
        const layers = this.klCanvas.getLayersFast();

        // 1. 动态资源管理：懒加载 (Lazy Allocation)
        // 检查是否有图层包含“动态合成对象 (compositeObj)” (例如：动态模糊滤镜、调整层)
        // free resources if no compositing being done
        if (layers.some((layer) => layer.compositeObj)) {
            // 如果需要，才分配显存，否则释放掉
            if (!this.compositeCanvas) {
                this.compositeCanvas = BB.canvas(width, height);
            }
        } else {
            // 内存清理：如果不需要合成特效，及时释放这块巨大的临时 Canvas
            if (this.compositeCanvas) {
                BB.freeCanvas(this.compositeCanvas);
                this.compositeCanvas = undefined;
            }
        }
        console.log('EaselProjectUpdater.update layer: ');
        console.dir(layers);
        // 2. 映射层：Easel 并不直接操作 KlCanvas 内部引用，而是读取一份结构化的副本
        const compositeCanvas = this.compositeCanvas;
        this.easel.setProject({
            width,
            height,
            layers: layers.map((layer) => {
      
                return {
                    // 【核心黑魔法】：函数式惰性求值
                    // 并没有在这里直接进行昂贵的滤镜运算，而是返回一个函数。
                    // 渲染器 Easel 在真正执行 draw 循环时，如果需要这个图层，才会调用这个函数。
                    image:
                        layer.compositeObj && compositeCanvas
                            ? () => {
                                // 在绘制的那一瞬间，才进行动态尺寸同步
                                  if (
                                      compositeCanvas.width != width ||
                                      compositeCanvas.height != height
                                  ) {
                                      compositeCanvas.width = width;
                                      compositeCanvas.height = height;
                                  }
                                  const ctx = compositeCanvas.getContext('2d')!;
                                  ctx.clearRect(0, 0, width, height);
                                  ctx.drawImage(layer.canvas, 0, 0);
                                  // 执行该图层的特效逻辑 (例如：应用调整层滤镜)
                                  layer.compositeObj?.draw(
                                      throwIfNull(compositeCanvas.getContext('2d')),
                                  );
                                  return compositeCanvas;
                              }
                              // 如果没有特效，直接返回原始 Canvas，性能最高
                            : layer.canvas,
                    isVisible: layer.isVisible,
                    opacity: layer.opacity,
                    mixModeStr: layer.mixModeStr,
                    hasClipping: false,
                };
            }),
            selection: this.klCanvas.getSelection(),
        });
    }

    // 显式释放资源
    // if you're not rendering easel for a while
    freeCompositeCanvas(): void {
        if (this.compositeCanvas) {
            BB.freeCanvas(this.compositeCanvas);
            this.compositeCanvas = undefined;
        }
    }
}
