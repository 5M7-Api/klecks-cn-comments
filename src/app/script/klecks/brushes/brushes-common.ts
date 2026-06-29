import { genBrushAlpha01, genBrushAlpha02 } from './alphas/brush-alphas';

// 定义一个全局数组，用来存放各种形状的“笔刷纹理贴图（Alpha Maps）”
// 这些贴图本质上就是一个个带有不同形状透明度梯度的微型 Canvas 元素。
export const ALPHA_IM_ARR: HTMLCanvasElement[] = []; // used by default brush

// 【预渲染魔法】：在系统初始化时，立刻生成两套不同形状的笔刷纹理，存入全局数组
// 传入的参数 128，代表生成的这块纹理画布的尺寸是 128x128 像素。
ALPHA_IM_ARR[1] = genBrushAlpha01(128);
ALPHA_IM_ARR[2] = genBrushAlpha02(128);

// 提示：为什么从索引 1 开始存，不存索引 0？
// 在很多图形引擎中，索引 0 通常保留给“纯硬边无抗锯齿的绝对圆/方块”，
// 或者代表“不使用任何纹理”。