import { TFxCanvas, TWrappedTexture } from '../../fx-canvas/fx-canvas-types';
import { BB } from '../../bb/bb';
import { drawSelectionMask } from '../../bb/base/canvas';
import { getPushableLayerChange } from '../history/push-helpers/get-pushable-layer-change';
import { canvasToLayerTiles } from '../history/push-helpers/canvas-to-layer-tiles';
import { getMultiPolyBounds } from '../../bb/multi-polygon/get-multi-polygon-bounds';
import { MultiPolygon } from 'polygon-clipping';
import { KlHistory } from '../history/kl-history';
import { getSharedFx } from '../../fx-canvas/shared-fx';

/**
 * 【终极 GPU 滤镜渲染引擎管线】
 * 无论你是在全屏模糊，还是只选中了“人物的眼睛”进行提亮，都由这个函数统一调配显卡执行。
 * 
 * @param context 当前目标图层的 2D Canvas 画笔 (CPU 端)
 * @param selection 用户的套索/魔棒选区多边形数据 (如果为 undefined 代表全图处理)
 * @param applyFn 真正的滤镜核心算子函数 (比如你把 fxCanvas.triangleBlur(10) 以回调函数的形式传进来)
 * @param klHistory 全局历史记录快照栈
 * @returns boolean 滤镜是否成功应用
 */
export function applyFxFilter(
    context: CanvasRenderingContext2D,
    selection: MultiPolygon | undefined,
    applyFn: (fxCanvas: TFxCanvas) => void,
    klHistory: KlHistory,
): boolean {
    // 1. 【唤醒全局唯一的 GPU 引擎】：从对象池拿到 WebGL 上下文 (glfx 二次封装)
    const fxCanvas = getSharedFx();
    if (!fxCanvas) {
        // 如果用户的显卡黑屏或者不支持 WebGL，直接安全退场 (TODO: 应该给个更具体的报错)
        return false; // todo more specific error?
    }

    // ==========================================
    // 【步骤 A：选区遮罩显存化 (Mask Uploading)】
    // ==========================================
    let maskTexture: TWrappedTexture | undefined;
    if (selection) {
        // 如果用户画了虚线选区（比如只选了人物的眼睛）：
        // 1. 在内存里快速申请一张同样分辨率的临时透明 Canvas
        const maskCanvas = BB.canvas(context.canvas.width, context.canvas.height);
        const maskContext = BB.ctx(maskCanvas);

        // 2. 用纯白色/纯黑色把这个“多边形选区”以硬边缘或羽化的形式涂进临时 Canvas
        drawSelectionMask(selection, maskContext);

        // 3. 【上载显存】：把这张只有黑白的选区图片，转为显卡能看懂的 WebGL 纹理 (Texture)！
        maskTexture = fxCanvas.texture(maskCanvas);

        // 4. 【立即释放 CPU 内存】：纹理已经安全装进显卡的显存里了，立刻把内存里的临时 Canvas 销毁！
        BB.freeCanvas(maskCanvas);
    }
    // ==========================================
    // 【步骤 B：图层画面上载与核爆炸计算】
    // ==========================================
    // 1. 【上载图层】：把当前我们要修改的画板图层也打包塞进显卡的显存中
    const originalTexture = fxCanvas.texture(context.canvas);

    // 2. 将原图纹理投射到 WebGL 的底板上
    fxCanvas.draw(originalTexture);

    // 3. 【启动显卡核心运算 (GLSL Execution)】：
    // 调用外层传进来的算子！比如在这里，显卡的成百上千个流处理器开始疯狂做高斯模糊或调色。
    // 注意：这里的渲染结果全部在显卡的后台帧缓冲 (Framebuffer) 里，屏幕上还看不到。
    applyFn(fxCanvas);

    // ==========================================
    // 【步骤 C：神级显卡局部遮罩混合 (Mask Compositing)】
    // ==========================================
    if (maskTexture) {
        // 如果刚才用户有选区，怎么保证滤镜“只作用于选区内部，选区外面纹丝不动”？
        // 经典图形学原理解析：
        // 1. multiplyAlpha()：先进行 Alpha 预乘，防止半透明边缘的颜色在混合时发生“黑边溢出”污染。
        // 2. mask(maskTexture, originalTexture, true)：调用专门的遮罩着色器。
        //    它的 GLSL 逻辑是：在当前模糊后的画面、原始画面、以及黑白 Mask 纹理之间做“三元贴图插值”：
        //    【最终像素 = 模糊后的像素 × Mask白色 + 原始图层的旧像素 × Mask黑色】！
        // 3. unmultiplyAlpha()：解开预乘，还原正常的 RGBA 色彩结构。
        fxCanvas.multiplyAlpha().mask(maskTexture, originalTexture, true).unmultiplyAlpha();
        // 遮罩计算用完了，立刻把黑白 Mask 从显存(VRAM)里开除，回收显存！
        maskTexture.destroy();
    }
    // 原图纹理用完了，也立刻销毁！
    originalTexture.destroy();
    // ==========================================
    // 【步骤 D：显存下放与 CPU 图层回写 (Readback & Render)】
    // ==========================================
    // 强制 WebGL 渲染管线完成最后的数据同步
    fxCanvas.update();
    // 1. 把 CPU 端的原始图层擦得一干二净
    context.clearRect(0, 0, context.canvas.width, context.canvas.height);
    // 2. 【从 GPU 抽回画面】：用 drawImage 瞬间把显卡后台画布里洗完澡的绝美像素，印回用户真正看到的 HTML5 画板上！
    context.drawImage(fxCanvas, 0, 0);

    // ==========================================
    // 【步骤 E：切片化历史快照入栈 (Sliced History Push)】
    // ==========================================
    // 很多人以为保存历史记录就是把整张 4000x4000 的图存下来，其实不是！
    klHistory.push(
        getPushableLayerChange(
            klHistory.getComposed(),
            // canvasToLayerTiles：极速内存压缩技巧！
            // 如果用户有选区，利用 getMultiPolyBounds(selection) 算出选区的矩形包围盒 (Bounding Box)。
            // 系统只会把“选区范围内那几块发生过变动的切片 (Tiles)” 抠下来存进历史记录栈中！
            // 没有被选区覆盖的周围几千万个像素，根本不占内存！
            canvasToLayerTiles(
                context.canvas,
                selection ? getMultiPolyBounds(selection, 'index') : undefined,
            ),
        ),
    );
    return true;
}
