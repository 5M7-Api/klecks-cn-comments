export function sortLayerMap(a: { index: number }, b: { index: number }): 1 | -1 | 0 {
    // a 排在 b 后面
    if (a.index > b.index) {
        return 1;
    }
    // a 排在 b 前面
    if (a.index < b.index) {
        return -1;
    }
    return 0;
}
