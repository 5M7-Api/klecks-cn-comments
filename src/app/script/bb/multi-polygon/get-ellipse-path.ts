import { Polygon, Ring } from "polygon-clipping";

export function getEllipsePath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  steps: number,
): Polygon {
  const result: Ring = [];
  // 1. 计算步长 (角度增量)
  // 2 * Math.PI 在数学上等于 360 度 (一个完整的圆周)。
  // 除以 steps，算出来的 d 就是每次画点时，角度要转动多少弧度。
  const d = (2 * Math.PI) / steps;

  // 2. 绕着圆心转一圈 (从 0 度转到 360 度)
  for (let i = 0; i < 2 * Math.PI; i += d) {
    // 3. 【核心极坐标公式】
    // Math.cos(i) * rx：算出当前角度在横轴上的偏移，加上 cx (中心点X)，得到实际屏幕X坐标
    // Math.sin(i) * ry：算出当前角度在纵轴上的偏移，加上 cy (中心点Y)，得到实际屏幕Y坐标
    result.push([Math.cos(i) * rx + cx, Math.sin(i) * ry + cy]);
  }

  // 4. 返回标准的多边形数据结构
  // 为什么要套一层数组 [result]？
  // 因为在 polygon-clipping 的定义中，一个 Polygon (多边形) 是由多个 Ring (环) 组成的。
  // 第一个环是外轮廓，后面的环是内部的“窟窿”。
  // 我们画的椭圆是一个实心的形状，没有窟窿，所以只需把包含所有顶点的外环 result 套进数组返回即可。
  return [result];
}
