import { THistoryEntry } from './history.types';
import { composeHistoryStateData } from './compose-history-state-data';
import { estimateBytes } from './estimate-bytes';

// ! 这段代码说明了klecks的历史记录栈不是按照步数限制的，而是按照内存大小限制的。
// ! 如果一步很小，那么可以存很多步。如果很大，那么就只能存很少步。所以，klecks的历史记录栈是按照内存大小限制的。
/*
    【原作者的硬核性能推演记录】
    目标：允许非常多次的撤销步骤，同时保证浏览器标签页不会无底洞般地吞噬内存。
    正常情况下，内存应该控制在几百 MB 以内（因为用户可能开了多个画板标签页）。
    但是！有些操作极其昂贵（比如：旋转整个画布、翻转、缩放、导入大项目），
    为了让这些大操作也能撤销，我们允许内存峰值达到 1 GB。

    【最坏情况的内存灾难计算】：
    最大画布尺寸:      2048 x 2048
    最大图层数:        16
    1 个 2K 图层 = 16.78 MB
    16 个 2K 图层一起动（比如全图旋转） = 268.44 MB。
    这意味着：仅仅按一次撤销/操作，就会产生 0.27 GB 的历史记录！
 */
/*
    Goal: allow many undo steps, while not having a tab *always* use up a lot of memory.
    It would be good if on average it's in the lower hundreds of MB, because users might have
    multiple tabs open. Some actions can be very expensive though (e.g. rotating, flipping,
    resizing, importing project). Then you still want to allow some undo steps. So the idea is
    with expensive actions you are allowed to reach up to 1GB.

    The worst-case (memory wise) happens when the project at max size with max layers is
    rotated repeatedly, or the user continually imports a large project:
    max image size:      2048 x 2048
    max layers:          16
    1 layer @ 2048 x 2048 = 16,777,216 Bytes    = 16.78 MB    = 0.02 GB
    16 layer @ 2048 x 2048 = 268,435,456 Bytes  = 268.44 MB   = 0.27 GB for one undo step
 */

    // ------------------- 阈值常量定义 -------------------
// 软上限：只要总内存不超过 200 MB，任何记录都不删，保留全部。
// up to this threshold, all entries will be kept
export const ALWAYS_KEEP_TOTAL_THRESHOLD_BYTES = 200e6; // 200 MB
// “大体积操作”的判定标准：超过 10 MB 的 Diff 就算大操作（比如全图滤镜、导入图片）
export const LARGE_ENTRY_BYTES = 10e6; // 10 MB
// 大体积操作的“保质期”：它最多只能在历史记录里存活 50 步。
export const LARGE_ENTRY_MAX_AGE = 50;
// 硬上限（死线）：绝对不允许所有记录总和超过 1 GB。
// 作者特意考虑了低端设备：“2024年9月，低端的 Chromebook 笔记本可能只有 2GB 内存。
// 如果我们不加限制，5.6 GB 直接就卡死了。1 GB 是最安全的红线。”
/*
    Hard cap: all entries together can't exceed this.
    (2024-09) Low-end Chromebooks may only have 2GB of RAM. 5.64 GB would be too much.
    Going with 1 GB, which is 3.7 worst-case undo steps.
 */
export const TOTAL_THRESHOLD_BYTES = 1e9; // 1 GB

// 辅助函数：计算当前整个历史栈占用了多少内存
export function getTotalMemoryBytes(entries: THistoryEntry[]): number {
    return entries.reduce((sum, e) => sum + e.memoryEstimateBytes, 0);
}

// 核心 GC 方法：修剪最老的历史记录
export function trimOldestEntries(entries: THistoryEntry[]): THistoryEntry[] {
    // 浅拷贝，避免直接修改原数组
    entries = [...entries];
    const totalBytes = getTotalMemoryBytes(entries);

    // 【早期退出】：如果当前总内存还没到 200MB，非常安全，直接放行，什么都不删。
    if (totalBytes <= ALWAYS_KEEP_TOTAL_THRESHOLD_BYTES) {
        // we always keep all below this threshold
        return entries;
    }

    // 当前最新一步的索引
    const newestEntryIndex = entries.length - 1; // index of the newest entry

    // 我们最终要“砍”到哪个索引位置
    // limit age of large entries
    // Otherwise they may stick around very long and drive up the average memory usage.
    let oldestIndex = 0;
    // -----------------------------------------------------------
    // 裁剪规则 1：限制“大操作”的寿命 (Rule of Large Entries)
    // -----------------------------------------------------------
    // 如果一个超过 10MB 的操作在历史记录里躺了很久，它会拉高平均内存。
    // 我们遍历历史，如果发现一个大于 10MB 且距离现在超过 50 步的记录，
    // 就把 `oldestIndex` 标记到这里（意味着它和它之前的记录都要被清理掉）。
    for (let i = 0; i <= newestEntryIndex; i++) {
        const age = newestEntryIndex - i;
        if (entries[i].memoryEstimateBytes > LARGE_ENTRY_BYTES && age > LARGE_ENTRY_MAX_AGE) {
            oldestIndex = i;
        }
    }

    // -----------------------------------------------------------
    // 裁剪规则 2：常规操作的温水煮青蛙 (Rule of Regular Entries)
    // -----------------------------------------------------------
    // 常规的小笔触（几十KB）堆积起来也不能超过 200MB 的软上限。
    // 注意：计算这个 200MB 软上限时，【刻意排除了大体积操作】！
    // Regular entries together can't exceed ALWAYS_KEEP_THRESHOLD_BYTES.
    // Large entries not included in this.
    {
        let accumulatedBytes = 0;
        for (let i = newestEntryIndex; i >= 0; i--) {
            if (entries[i].memoryEstimateBytes > LARGE_ENTRY_BYTES) {
                continue;
            }
            accumulatedBytes += entries[i].memoryEstimateBytes;
            if (accumulatedBytes > ALWAYS_KEEP_TOTAL_THRESHOLD_BYTES) {
                oldestIndex = Math.max(oldestIndex, i);
                break;
            }
        }
    }

    // -----------------------------------------------------------
    // 裁剪规则 3：不可逾越的 1GB 叹息之墙 (The 1GB Hard Cap)
    // -----------------------------------------------------------
    // 不管是大操作还是小操作，从新往老累加，一旦总体积超过 1GB，
    // 后面的全不要了，防止浏览器当场去世。
    // can't exceed TOTAL_THRESHOLD_BYTES
    {
        let accumulatedBytes = 0;
        for (let i = newestEntryIndex; i >= 0; i--) {
            accumulatedBytes += entries[i].memoryEstimateBytes;
            if (accumulatedBytes > TOTAL_THRESHOLD_BYTES) {
                oldestIndex = Math.max(oldestIndex, i);
                break;
            }
        }
    }

    // -----------------------------------------------------------
    // 终极执行：历史折叠 (History Squashing)
    // -----------------------------------------------------------
    // 注意！我们不能简单地用 entries.splice(0, oldestIndex) 把老记录直接删掉！
    // 因为历史记录存的是 Diff（增量补丁），如果把第0步（初始白纸）删了，后面的补丁就贴不到东西上了。
    // compose entries 0..oldestIndex into a single "oldest" entry
    while (oldestIndex > 0) {
        // 【核心魔法】：把从 0 到 oldestIndex 的所有碎片，用之前学过的
        // composeHistoryStateData 强行“压扁(Squash)”成一个完整的全新“初始帧(Baseline)”！
        const composedData = composeHistoryStateData(
            entries.slice(0, oldestIndex + 1).map((item) => item.data),
            oldestIndex,
        );
        // 重新估算这个全新的“压扁帧”有多大
        const memoryEstimateBytes = estimateBytes(composedData);
        // 重建历史栈：
        // 新的第 0 帧 = 压扁后的完整状态，名为 'oldest'
        // 后面的帧 = 没被砍掉的剩下的 Diff
        entries = [
            {
                timestamp: entries[oldestIndex].timestamp,
                memoryEstimateBytes,
                description: 'oldest',
                data: composedData,
            },
            ...entries.slice(oldestIndex + 1),
        ];
        // 砍完之后把游标归零
        oldestIndex = 0;

        // 【防穿透兜底】：即使压扁成了 1 帧，这 1 帧的体积可能依然超过了 1GB！
        // 比如全屏画满了复杂的矢量数据。
        // 如果还超标，让 oldestIndex = 1，强行让下一轮循环再往后“吞噬”一帧，直到降到 1GB 以下为止。
        // Despite the earlier check the composed entry may still push the total over 1 GB.
        if (getTotalMemoryBytes(entries) > TOTAL_THRESHOLD_BYTES) {
            oldestIndex = 1;
        }
    }

    return entries;
}
