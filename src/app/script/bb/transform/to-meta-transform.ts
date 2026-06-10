import { createMatrixFromTransform } from './create-matrix-from-transform';
import { TViewportTransform } from '../../klecks/ui/project-viewport/project-viewport';
import { TVector2D } from '../bb-types';
import { applyToPoint, inverse } from 'transformation-matrix';

/**
 * “元变换（MetaTransform）”数据结构
 * 它不关心画纸左上角在哪，它只关心“锚点（Anchor）”。
 */
export type TMetaTransform = {
    // 屏幕/视口上的物理坐标（比如鼠标当前的屏幕位置 x:500, y:500）
    viewportP: TVector2D;
    // 物理画纸上的逻辑坐标（比如鼠标正下方对应的画纸像素 x:150, y:200）
    canvasP: TVector2D;
    // 当前缩放比
    scale: number;
    // 当前旋转角度
    angleDeg: number;
};

/**
 * 将标准的视口变换，转换为基于特定锚点的“元变换”
 * @param transform 基础视口状态（只包含左上角偏移 x,y，以及缩放和角度）
 * @param viewportP 你指定的屏幕锚点（通常是鼠标光标的位置，或者是双指捏合的中心点）
 */
export function toMetaTransform(
    transform: TViewportTransform,
    viewportP: TVector2D,
): TMetaTransform {
    // 1. 【生成正向矩阵】将高层状态对象转为 2D 数学矩阵
    // 正向矩阵的作用是：输入画纸坐标 -> 输出屏幕坐标
    const m = createMatrixFromTransform(transform);
    // 2. 【核心数学魔法：矩阵求逆 (Inverse)】
    // inverse(m) 会生成一个反向矩阵，它的作用是：输入屏幕坐标 -> 输出画纸坐标。
    // applyToPoint 拿着这个反向矩阵，结合你传进来的屏幕鼠标位置 (viewportP)，
    // 瞬间计算出了鼠标现在正指着画作上的哪一个绝对像素点 (canvasP)。
    const canvasP = applyToPoint(inverse(m), viewportP);
    // 3. 将这两个被“死死绑定”的坐标点，连同缩放和角度一起打包返回
    return {
        viewportP,
        canvasP,
        scale: transform.scale,
        angleDeg: transform.angleDeg,
    };
}
