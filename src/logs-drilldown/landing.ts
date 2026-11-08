import { DataFrame, FieldType } from '@grafana/data';
import { LANDING_TILE } from './sql';

/**
 * The landing page queries the volume and the latest lines of all its tiles together (see
 * landingVolumeSql and landingLinesSql); these split the results per tile.
 */

/** A tile's volume series: the number fields labelled with its value, without the tile label. */
export const tileVolume = (frames: DataFrame[], value: string): DataFrame[] =>
  frames.map((frame) => ({
    ...frame,
    fields: frame.fields
      .filter((field) => field.type !== FieldType.number || field.labels?.[LANDING_TILE] === value)
      .map((field) => {
        if (!field.labels || !(LANDING_TILE in field.labels)) {
          return field;
        }
        const { [LANDING_TILE]: _tile, ...labels } = field.labels;
        return { ...field, labels };
      }),
  }));

/** A tile's log lines: the rows of its value, without the tile column. */
export const tileLines = (frames: DataFrame[], value: string): DataFrame[] =>
  frames.map((frame) => {
    const tileField = frame.fields.find((field) => field.name === LANDING_TILE);
    if (!tileField) {
      return frame;
    }
    const rows: number[] = [];
    for (let i = 0; i < frame.length; i++) {
      if (String(tileField.values[i]) === value) {
        rows.push(i);
      }
    }
    return {
      ...frame,
      length: rows.length,
      fields: frame.fields
        .filter((field) => field !== tileField)
        .map((field) => ({ ...field, values: rows.map((i) => field.values[i]) })),
    };
  });
