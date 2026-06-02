
// ! 用于解决apple pencil 在safari上的bug，起笔会有一个固定压感值，且压感太小，该类放大两倍
/**
 * Apple Pencil on iPad in Safari has two problems:
 * - You need to press the stylus very strong to reach 1.0 pressure, to the point where the screen starts discoloring
 * - Always fires the same pressure value on pointerdown
 *
 * This normalizer tries to fix that with a workaround.
 *
 * pressure range [0, 1]
 */
export class PressureNormalizer {
    private detectionComplete = false; // 是否已经完成了设备类型检测
    private isApplePencil = false; // 鉴定结果：当前笔是不是 Apple Pencil

    // detection
    private initialPointerDownPressure = -1; // 记录第一次落笔时的压力值
    private pointerDownPressureRepeatCount = 0; // 记录落笔压力值“完全相同”的次数
    private pointerMoveHasDifferentPressure = false; // 笔在移动时，压力是否发生了变化（证明它有真压感，不是鼠标伪装的）

    // ----------------------------------- public -----------------------------------
    normalize(pressure: number, eventType?: string, pointerType?: string): number {
        // 如果不是手写笔（比如是鼠标或手指），直接放行，不处理压感
        if (pointerType === 'pen') {
            if (!this.detectionComplete) {
                if (eventType === 'pointerdown') {
                    if (this.initialPointerDownPressure === -1) {
                        // 第一次落笔：记录下这个初始压力值
                        this.initialPointerDownPressure = pressure;
                    } else if (this.initialPointerDownPressure === pressure) {
                        // 如果压力值完全相同，说明可能是鼠标或手指模拟的 Apple Pencil，继续检测
                        this.pointerDownPressureRepeatCount++;
                        // 如果连续几次落笔压力都一样，并且移动时压力会变化
                        if (
                            this.pointerDownPressureRepeatCount > 1 &&
                            this.pointerMoveHasDifferentPressure
                        ) {
                            // 破案了！人类不可能每次落笔的力度精确到小数点后好几位。
                            // 只有触发了 Bug 的 Apple Pencil 才会这样。
                            this.detectionComplete = true;
                            this.isApplePencil = true;
                        }
                    } else {
                        // 如果下一次落笔的压力跟第一次不同，说明这是正常的手写笔（如 Windows/Wacom）
                        // 排除嫌疑，终止检测
                        this.detectionComplete = true;
                        this.isApplePencil = false;
                    }
                } else if (eventType === 'pointermove') {
                    // 在移动过程中，如果发现压力值变化了，记录下来（证明这支笔确实支持压感）
                    if (this.initialPointerDownPressure !== pressure) {
                        this.pointerMoveHasDifferentPressure = true;
                    }
                }
            }

            if (this.detectionComplete && this.isApplePencil) {
                // 修复 Bug 2 (起笔假死)：如果当前压力等于那个固定的初始错误压力，直接当做 0 处理。
                // 这样可以避免起笔时突然画出一个重重的圆点。
                if (this.initialPointerDownPressure === pressure) {
                    return 0;
                }
                // 修复 Bug 1 (碎屏压感)：给压感加一个 2 倍的“软件放大器”。
                // 这样用户只需要用一半的力气，就能画出原本 1.0 压力的粗线，保护 iPad 屏幕。
                pressure = Math.min(2, pressure * 2);
            }
            return pressure;
        } else {
            return pressure; // 不是手写笔，直接放行
        }
    }
}
