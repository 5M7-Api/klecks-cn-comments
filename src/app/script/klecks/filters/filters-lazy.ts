import { FILTER_LIB, FILTER_LIB_STATUS } from './filters';
import { filterBrightnessContrast } from './filter-brightness-contrast';
import { filterCropExtend } from './filter-crop-extend';
import { filterCurves } from './filter-curves';
import { filterFlip } from './filter-flip';
import { filterHueSaturation } from './filter-hue-saturation';
import { filterInvert } from './filter-invert';
import { filterPerspective } from './filter-perspective';
import { filterResize } from './filter-resize';
import { filterRotate } from './filter-rotate';
import { filterTiltShift } from './filter-tilt-shift';
import { filterTransform } from './filter-transform';
import { filterBlur } from './filter-blur';
import { filterUnsharpMask } from './filter-unsharp-mask';
import { filterToAlpha } from './filter-to-alpha';
import { filterGrid } from './filter-grid';
import { filterNoise } from './filter-noise';
import { filterPattern } from './filter-pattern';
import { filterDistort } from './filter-distort';
import { filterVanishPoint } from './filter-vanish-point';
import { TFilter } from '../kl-types';

// 【类型安全黑魔法】：利用 TypeScript 的 Pick 语法，提取出只包含 getDialog 和 apply 的子类型。
// 因为对于这个装配脚本来说，它根本不需要关心图标(icon)是什么、语言包(lang)叫什么，它只管对接“函数通路”。
type TModuleFilter = Pick<TFilter, 'getDialog' | 'apply'>;

/**
 * 【对口装配工】：把单个实现模块的真实函数，填进对应的清单对象槽位中
 * 
 * @param libObj 骨架字典里的那个空壳槽位对象（含有 icon、lang 等元数据）
 * @param moduleObj 真正实现了算法的内核模块对象
 */
function importFilter(libObj: TFilter, moduleObj: TModuleFilter): void {
    // 1. 挂载弹窗界面生成函数
    // 细节注意：为什么这里加了 if 判断？因为我们前面提到过“双管线分流原则”！
    // 像“水平翻转(flip)”、“反色(invert)”这类瞬间生效滤镜，它们的真实模块里压根就没写 getDialog 属性，
    // 所以只有当模块里真正写了 getDialog 时，才把槽位里的 null 替换掉。
    if (moduleObj.getDialog) {
        libObj.getDialog = moduleObj.getDialog;
    }

    // 2. 强行挂载物理核心渲染算法（不管有没有弹窗，所有滤镜都必须具备 apply 图像渲染算子）
    libObj.apply = moduleObj.apply;
}

/**
 * 【终极主程序】：一键启动滤镜库“注水(Hydration)”流程
 */
export function importFilters(): void {
    // 1. 【幂等性/防重复安全锁】：
    // 如果后台之前已经加载并装配过一次了，直接拦截退出，绝对不要重复执行下面昂贵的内存重新赋值。
    if (FILTER_LIB_STATUS.isLoaded) {
        return;
    }

    // 2. 【按名索骥，精准灌水】：
    // 20 个功能排好队，把它们各自在内存里的真实函数地址，一个个塞进对应骨架的名下。
    // 使用 "as TModuleFilter" 绕过 TypeScript 的严格宽泛类型校验，强制执行安全注入。
    importFilter(FILTER_LIB.brightnessContrast, filterBrightnessContrast as TModuleFilter);
    importFilter(FILTER_LIB.cropExtend, filterCropExtend as TModuleFilter);
    importFilter(FILTER_LIB.curves, filterCurves as TModuleFilter);
    importFilter(FILTER_LIB.flip, filterFlip as TModuleFilter);
    importFilter(FILTER_LIB.hueSaturation, filterHueSaturation as TModuleFilter);
    importFilter(FILTER_LIB.invert, filterInvert as TModuleFilter);
    importFilter(FILTER_LIB.perspective, filterPerspective as TModuleFilter);
    importFilter(FILTER_LIB.resize, filterResize as TModuleFilter);
    importFilter(FILTER_LIB.rotate, filterRotate as TModuleFilter);
    importFilter(FILTER_LIB.tiltShift, filterTiltShift as TModuleFilter);
    importFilter(FILTER_LIB.transform, filterTransform as TModuleFilter);
    importFilter(FILTER_LIB.blur, filterBlur as TModuleFilter);
    importFilter(FILTER_LIB.unsharpMask, filterUnsharpMask as TModuleFilter);
    importFilter(FILTER_LIB.toAlpha, filterToAlpha as TModuleFilter);
    importFilter(FILTER_LIB.grid, filterGrid as TModuleFilter);
    importFilter(FILTER_LIB.noise, filterNoise as TModuleFilter);
    importFilter(FILTER_LIB.pattern, filterPattern as TModuleFilter);
    importFilter(FILTER_LIB.distort, filterDistort as TModuleFilter);
    importFilter(FILTER_LIB.vanishPoint, filterVanishPoint as TModuleFilter);

    // ==========================================
    // 【点亮生命周期绿灯】
    // ==========================================
    // 将状态中心的标记强行扭转为 true！
    // 此时，EditUi 面板里的那二十个按钮的 onclick 逻辑瞬间解除警报，
    // 画师再次点击按钮时，调用 `filters[filterKey].apply` 就能畅通无阻地直接调起 GPU/CPU 算力了！
    FILTER_LIB_STATUS.isLoaded = true;
}
