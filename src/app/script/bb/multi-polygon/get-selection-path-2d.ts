import { MultiPolygon } from 'polygon-clipping';

/**
 * 将 MultiPolygon 数据转换为 Canvas 原生的 Path2D 对象。
 * 用途：用于底层的 <canvas> 渲染，比如往选区里填充颜色（油漆桶），或者裁剪图层。
 */
export function getSelectionPath2d(selection: MultiPolygon): Path2D {
    // 实例化一个原生的 Canvas 路径对象
    const path = new Path2D();
    selection.forEach((poly) => {
        // 第一层遍历：遍历每一个独立的多边形 (Polygon)
        // (注：一个多边形可能包含一个外环和多个内环/破洞)
        poly.forEach((ring) => {
            // 第三层遍历：遍历环上的每一个具体的 x,y 坐标点
            ring.forEach((point, index) => {
                if (index === 0) {
                    // 如果是环的第一个点，把“画笔”抬起来，直接移动到这个坐标 (不画线)
                    path.moveTo(...point);
                } else {
                    // 之后的每一个点，用“画笔”从上一个位置画一条直线到这个新坐标
                    path.lineTo(...point);
                }
            });
        });
        // 闭合路径：自动从当前坐标画一条直线连回最近的一个 moveTo 坐标，形成闭合图形
        path.closePath();
    });
    // 返回这个包含了一系列绘制指令的路径对象
    // 之后可以直接调用 ctx.fill(path) 或 ctx.stroke(path) 来画出它
    return path;
}

/**
 * 将 MultiPolygon 数据转换为 SVG 的 `<path d="...">` 路径字符串。
 * 用途：用于 DOM 层面的 SVG 渲染，比如我们之前看到的 SelectionRenderer（蚂蚁线）。
 */
export function getSvgPathD(poly: MultiPolygon): string {
    let result = '';
    poly.forEach((poly) => {
        poly.forEach((ring) => {
            // M 代表 SVG 路径指令里的 MoveTo (移动到某点)
            result += 'M';

            // 遍历坐标点并拼接字符串
            ring.forEach((point) => {
                // 将 [x, y] 转换成 "x,y " 的字符串格式
                result += point.join(',') + ' ';
            });
            // 这里利用了 SVG 规范中的一个“隐式转换”小技巧：
            // 如果 M 指令后面跟着多对坐标（比如 "M10,10 20,20 30,30"），
            // 第一对坐标会被当作 MoveTo，后面的坐标会被浏览器自动当成 L (LineTo) 处理！
            // 这样写不仅代码极简，而且生成的字符串更短，节省内存。
        });
    });
    // 去掉末尾多余的空格并返回
    return result.trim();
}
