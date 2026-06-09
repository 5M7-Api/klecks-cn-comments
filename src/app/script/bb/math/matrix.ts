// https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/Matrix_math_for_the_web
// not optimized
// 扁平化手写的矩阵运算规则

/**
 * 4x4 变换矩阵类型
 * 用一个包含 16 个数字的平铺数组表示。
 * 采用 WebGL 标准的【列优先（Column-Major）】排列。
 */
type TMatrix4x4 = [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
];

/**
 * 4维齐次坐标向量类型
 * [x, y, z, w]
 * 在 2D 绘图引擎中：
 * - [x, y] 是普通的平面坐标
 * - z 轴通常为 0
 * - w 是齐次因子。当 w = 1 时表示一个【绝对坐标点】；当 w = 0 时表示一个【方向向量】。
 */
export type TVec4 = [number, number, number, number];

/**
 * 获取单位矩阵（Identity Matrix）
 * 相当于数字系统中的数字 "1"。任何向量或矩阵乘以它，都保持原样不动。
 * 视觉表现：画面不放大、不旋转、不平移。
 */
function getIdentity(): TMatrix4x4 {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/**
 * 矩阵 乘以 点/向量 (Matrix × Vector)
 * 核心功能：将一个空间中的点，通过矩阵转换为另一个空间的新点。
 * 数学原理：标准线性代数的“行乘列”点积运算。
 * * @param matrix 变换矩阵
 * @param point 原始点坐标 [x, y, z, w]
 */
// point • matrix
function multiplyMatrixAndPoint(matrix: TMatrix4x4, point: TVec4): TVec4 {
    // 利用列优先矩阵的每行元素，与向量进行点积乘法，计算出全新的 [x', y', z', w']
    return [
        point[0] * matrix[0] + point[1] * matrix[4] + point[2] * matrix[8] + point[3] * matrix[12], // x
        point[0] * matrix[1] + point[1] * matrix[5] + point[2] * matrix[9] + point[3] * matrix[13], // y
        point[0] * matrix[2] + point[1] * matrix[6] + point[2] * matrix[10] + point[3] * matrix[14], // z
        point[0] * matrix[3] + point[1] * matrix[7] + point[2] * matrix[11] + point[3] * matrix[15], // w
    ];
}

/**
 * 矩阵 乘以 矩阵 (MatrixA × MatrixB)
 * 核心功能：将两个复杂的变换（例如：先旋转、再平移）复合、压缩成一个单一的复合矩阵。
 * 这样后续成千上万个顶点只需要乘以这一个最终矩阵即可，能极大地提升图形引擎性能。
 * * 数学公式约定：C = A × B。在应用时，右侧的 MatrixB 的变换会先发生，左侧的 MatrixA 后发生。
 */
//matrixB • matrixA
function multiplyMatrices(matrixA: TMatrix4x4, matrixB: TMatrix4x4): TMatrix4x4 {
    // Slice the second matrix up into rows
    const row0: TVec4 = [matrixB[0], matrixB[1], matrixB[2], matrixB[3]];
    const row1: TVec4 = [matrixB[4], matrixB[5], matrixB[6], matrixB[7]];
    const row2: TVec4 = [matrixB[8], matrixB[9], matrixB[10], matrixB[11]];
    const row3: TVec4 = [matrixB[12], matrixB[13], matrixB[14], matrixB[15]];

    // Multiply each row by matrixA
    const result0 = multiplyMatrixAndPoint(matrixA, row0);
    const result1 = multiplyMatrixAndPoint(matrixA, row1);
    const result2 = multiplyMatrixAndPoint(matrixA, row2);
    const result3 = multiplyMatrixAndPoint(matrixA, row3);

    // Turn the result rows back into a single matrix
    return [
        result0[0],
        result0[1],
        result0[2],
        result0[3],
        result1[0],
        result1[1],
        result1[2],
        result1[3],
        result2[0],
        result2[1],
        result2[2],
        result2[3],
        result3[0],
        result3[1],
        result3[2],
        result3[3],
    ];
}

/**
 * 创建一个平移矩阵（Translation Matrix）
 * @param x 横向平移像素量
 * @param y 纵向平移像素量
 */
function createTranslationMatrix(x: number, y: number): TMatrix4x4 {
    // 注意看索引 12 和 13 的位置（也就是第四列的顶部两个元素）被填入了 x 和 y。
    // 当任意点 [X, Y, 0, 1] 乘以这个矩阵时，根据 multiplyMatrixAndPoint 规则：
    // 新X = X*1 + 1*x = X + x；新Y = Y*1 + 1*y = Y + y。从而实现了平移。
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1];
}

/**
 * 创建一个 2D 旋转矩阵（Rotation Matrix）
 *围绕 Z 轴（垂直于屏幕的看不见的轴）进行平面旋转。
 * @param angleRad 弧度值 (Radians)
 */
function createRotationMatrix(angleRad: number): TMatrix4x4 {
    // 为什么要加负号（-angleRad）？
    // 因为在标准数学坐标系中，正角度是逆时针旋转；
    // 但在网页和 Canvas 2D 中，Y 轴向下，正角度代表【顺时针旋转】。
    // 为了让传入的正弧度在 Canvas 里表现为顺时针，作者在内部通过取负号修正了三角函数。

    //let angleRad = angleDeg / 360 * 2 * Math.PI;
    
    // 经典 2D 旋转变换的四个核心系数：
    // [ cosθ, sinθ ]
    // [ -sinθ, cosθ]
    return [
        Math.cos(-angleRad),
        -Math.sin(-angleRad),
        0,
        0,
        Math.sin(-angleRad),
        Math.cos(-angleRad),
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        1,
    ];
}

/**
 * 创建一个等比缩放矩阵（Scale Matrix）
 * @param f 缩放系数 (Factor)。例如：2.0 代表放大两倍，0.5 代表缩小一半。
 */
function createScaleMatrix(f: number): TMatrix4x4 {
    // 将主对角线上的 X 缩放（索引0）和 Y 缩放（索引5）全部设为 f。
    // 点乘以该矩阵后，其 X 和 Y 坐标会直接乘以该系数，实现放大缩小。
    return [f, 0, 0, 0, 0, f, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/**
 * 导出唯一的只读命名空间对象 Matrix
 * 冻结（Object.freeze）确保该数学工具库的函数指针在运行时绝不会被意外篡改。
 */
export const Matrix = Object.freeze({
    getIdentity,
    multiplyMatrixAndPoint,
    multiplyMatrices,
    createTranslationMatrix,
    createRotationMatrix,
    createScaleMatrix,
});
