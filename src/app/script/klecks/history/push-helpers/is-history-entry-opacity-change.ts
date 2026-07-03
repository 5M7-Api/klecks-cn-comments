import { THistoryEntryData } from '../history.types';

/**
 * 鉴定当前的撤销/重做快照 (entry) 是否【有且仅有】修改了目标图层 (layerId) 的透明度。
 * 哪怕它顺带修改了一个像素，或者修改了别的图层的名字，这个函数都会无情地返回 false。
 * ! 因为涉及到滑块移动产生的大量函数计算，所以不得已只能严格判定提高速度
 */
// Is it a history entry where the *only* change is the opacity of layerId
export function isHistoryEntryOpacityChange(entry: THistoryEntryData, layerId: string): boolean {
    // 获取这个历史记录快照最顶层所有的 key
    const keys = Object.keys(entry);

    // 【第一道安检】：全局快照级别
    // 如果顶级修改超过了 1 个（比如不仅有 layerMap 改变，还伴随了 size 画布大小改变，或者 selection 选区改变）
    // 或者根本连 layerMap (图层字典) 都没有，直接否决！
    if (keys.length !== 1 || !entry.layerMap) {
        return false;
    }

    // 获取所有参与此次历史变更的图层 ID 列表
    const ids = Object.keys(entry.layerMap);

    // 【第二道安检】：逐个图层排查
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        // 获取该图层的差异对象 (Delta)
        const layer = entry.layerMap[id];
        if (id === layerId) {
            const layerKeys = Object.keys(layer);
            // 它身上的改变必须有且仅有 1 个，并且这个改变的名字必须叫做 'opacity'
            // 如果它不仅改了透明度，还改了 'tiles'(像素) 或者 'name'(名字)，否决！
            if (layerKeys.length !== 1 || layerKeys[0] !== 'opacity') {
                return false;
            }
        } else {
            // 这是其他的无关图层
            const layerKeys = Object.keys(layer);
            // 其他图层在这个历史记录里，绝对不能发生任何变化！
            // (在 Klecks 的 Delta 设计中，没变化的图层就是一个空对象 {})
            if (layerKeys.length > 0) {
                return false;
            }
        }
    }
    // 经历了最严苛的盘查，证明这就是一个血统纯正的、专门修改单层透明度的历史记录！
    return true;
}
