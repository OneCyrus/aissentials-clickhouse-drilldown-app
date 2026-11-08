import { DataFrame, FieldType } from '@grafana/data';
import { PanelBuilders, SceneDataProvider, SceneDataTransformer } from '@grafana/scenes';
import { LegendDisplayMode, StackingMode, TooltipDisplayMode } from '@grafana/schema';
import { map } from 'rxjs';
import { levelColors } from '../shared';

/**
 * Names each series by its label values and colors log levels like Logs Drilldown. The backend
 * returns long rows (time, value, count) as one frame with a field per value.
 */
export const namedSeries = (runner: SceneDataProvider, colorLevels = false) =>
  new SceneDataTransformer({
    $data: runner,
    transformations: [
      () => (source) =>
        source.pipe(
          map((frames: DataFrame[]) =>
            frames.map((frame) => ({
              ...frame,
              fields: frame.fields.map((field) => {
                if (field.type !== FieldType.number || !field.labels) {
                  return field;
                }
                const name = Object.values(field.labels).join(', ') || field.name;
                const color = colorLevels ? levelColors[name] : undefined;
                return {
                  ...field,
                  config: {
                    ...field.config,
                    displayNameFromDS: name,
                    ...(color ? { color: { mode: 'fixed', fixedColor: color } } : {}),
                  },
                };
              }),
            }))
          )
        ),
    ],
  });

/** Stacked bars of counts, the style of every volume chart in Logs Drilldown. */
export const stackedBars = (data: SceneDataProvider, legend: 'right' | 'bottom' | 'hidden' = 'bottom') =>
  PanelBuilders.timeseries()
    .setData(data)
    .setUnit('short')
    .setCustomFieldConfig('drawStyle', 'bars' as never)
    .setCustomFieldConfig('fillOpacity', 100)
    .setCustomFieldConfig('lineWidth', 0)
    .setCustomFieldConfig('pointSize', 0)
    .setCustomFieldConfig('stacking', { mode: StackingMode.Normal, group: 'A' })
    .setCustomFieldConfig('axisSoftMin', 0)
    .setOption('tooltip', { mode: TooltipDisplayMode.Multi, sort: 'desc' as never })
    .setOption('legend', {
      showLegend: legend !== 'hidden',
      displayMode: legend === 'right' ? LegendDisplayMode.Table : LegendDisplayMode.List,
      placement: legend === 'right' ? 'right' : 'bottom',
      calcs: ['sum'],
    });
