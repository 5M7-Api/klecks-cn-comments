import { TKlCanvasLayer } from '../../canvas/kl-canvas';
import { THistoryEntryLayer, THistoryEntryLayerTile, TLayerId } from '../history.types';
import { canvasToLayerTiles } from './canvas-to-layer-tiles';
import { TIndexBounds } from '../../../bb/bb-types';

// 获取图层历史记录对象的所有可选键名 (如 'name', 'opacity', 'tiles' 等)
type TLayerKey = keyof THistoryEntryLayer;
// 【全局兜底配置】：用来告诉系统，那些没有发生特殊变化的图层，需要记录哪些属性。
type TLayerMapGeneric = {
    attributes: 'all' | TLayerKey[];
};

// 【精准定向配置】：用来告诉系统，某个特定图层 (layerId) 发生了什么变化。
type TLayerMapLayer = {
    layerId: string;
    attributes: 'all' | TLayerKey[];
    bounds?: TIndexBounds; // changed bounds
    tiles?: (THistoryEntryLayerTile | undefined)[]; // custom tiles. bounds ignored if tiles set.
};
// 联合类型，输入参数可以是全局配置，也可以是定向配置
export type TLayerMapConfigItem = TLayerMapGeneric | TLayerMapLayer;

/**
 * 【照相机】：为单个图层创建历史记录快照
 */
// create individual THistoryEntryLayer
function createEntryLayer(
    layer: TKlCanvasLayer,
    attributes: 'all' | TLayerKey[],
    bounds?: TIndexBounds,
    tiles?: (THistoryEntryLayerTile | undefined)[],
): THistoryEntryLayer {
    const useAll = attributes === 'all';
    const result: THistoryEntryLayer = {};

    if (useAll || attributes.includes('name')) {
        result.name = layer.name;
    }
    if (useAll || attributes.includes('opacity')) {
        result.opacity = layer.opacity;
    }
    if (useAll || attributes.includes('isVisible')) {
        result.isVisible = layer.isVisible;
    }
    if (useAll || attributes.includes('mixModeStr')) {
        result.mixModeStr = layer.mixModeStr;
    }
    if (useAll || attributes.includes('index')) {
        result.index = layer.index;
    }
    // 【核心像素追踪】：如果像素发生了改变
    if (useAll || attributes.includes('tiles')) {
        // 如果外部没有直接提供算好的 tiles，就调用底层的 canvasToLayerTiles
        // 它会根据 bounds (之前算出来的矩形包围盒)，去画布上把那块区域“抠”下来，切成小片保存。
        result.tiles = tiles ?? canvasToLayerTiles(layer.context.canvas, bounds);
    }
    return result;
}


/**
 * 【快照工厂】：生成要推入撤销栈的 layerMap（字典：LayerID -> Layer快照）
 * * 强大之处在于其极其灵活的参数配置。
 * 示例：用户在图层'0'上画了一笔。
 * 参数：{ layerId: '0', attributes: 'all', bounds: {...} }, { attributes: ['index'] }
 * 结果：图层'0'保存了所有属性和局部像素切片；其余所有图层只保存了一个序号(index)。
 */
/**
 * Creates THistoryEntryData.layerMap from KlCanvas layers that can be pushed into history.
 *
 * items control what attributes will be set for each layer. Examples:
 * { attributes: ['index'] } - each layer only has index attribute. all layers will be in the map.
 * { layerId: '0', attributes: ['name']} - map only contains layer '0'. it only has 'name' attribute.
 * { layerId: '0', attributes: 'all'} - map only contains layer '0', with all attributes.
 * { layerId: '0', attributes: 'all'}, { attributes: ['index'] }
 *      - layer '0' has all attributes.
 *      - all other layers will be in the map, but only contain attribute 'index'.
 *
 *  Can further customize by setting what bounds changed, or provide custom tiles.
 */
export function createLayerMap(
    layers: TKlCanvasLayer[],
    ...items: (TLayerMapConfigItem | undefined)[]
): Record<TLayerId, THistoryEntryLayer> {
    // 1. 从传入的变长参数中，解析出【全局兜底配置】。如果没有，默认为 [] (什么都不记录)
    const generic: TLayerMapGeneric = items.find((item) => item && !('layerId' in item)) ?? {
        attributes: [],
    };
    // 2. 从传入的变长参数中，解析出所有【精准定向配置】
    const targets: TLayerMapLayer[] = items
        .filter((item) => !!item)
        .filter((item) => 'layerId' in item);
    // 3. 遍历当前画布上的真实图层数组，生成历史快照字典
    return Object.fromEntries(
        layers.map((layer, index) => {
            for (const target of targets) {
                // 对于当前遍历到的图层，看看有没有针对它的【定向配置】
                if (target.layerId === layer.id) {
                    // 命中了！使用定向配置的清单、边界和切片来生成快照
                    return [
                        layer.id,
                        createEntryLayer(layer, target.attributes, target.bounds, target.tiles),
                    ];
                }
            }
            // 没命中，说明这个图层没发生核心变化。使用【全局兜底配置】记录它的边缘状态（如维持结构排序）
            return [layer.id, createEntryLayer(layer, generic.attributes)];
        }),
    );
}
