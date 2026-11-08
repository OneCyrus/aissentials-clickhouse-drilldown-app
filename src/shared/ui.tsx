import React from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { InlineField, useStyles2 } from '@grafana/ui';

/**
 * A labelled control of a toolbar: the label on the left in Grafana's inline field style, one line
 * high like the control, and the explanation in a tooltip instead of text under the label. Every
 * toolbar uses it, so controls line up and have the same height.
 */
export function Control({
  label,
  tooltip,
  grow,
  children,
}: {
  label: string;
  tooltip?: string;
  grow?: boolean;
  children: React.ReactElement;
}) {
  const styles = useStyles2(getStyles);
  return (
    <InlineField label={label} tooltip={tooltip} grow={grow} className={styles.control}>
      {children}
    </InlineField>
  );
}

/** A row of controls: wraps on narrow screens, keeps one height and spacing. */
export function Toolbar({ children, className }: { children: React.ReactNode; className?: string }) {
  const styles = useStyles2(getStyles);
  return <div className={cx(styles.toolbar, className)}>{children}</div>;
}

/**
 * Controls that belong together on the right of a toolbar: they move to the next line as one group
 * on narrow screens, instead of one control at a time.
 */
export function ToolbarGroup({ children }: { children: React.ReactNode }) {
  const styles = useStyles2(getStyles);
  return <div className={styles.group}>{children}</div>;
}

/** Pushes the following toolbar items to the right. */
export function Spacer() {
  const styles = useStyles2(getStyles);
  return <div className={styles.spacer} />;
}

/** The style of the apps' data tables: full width, row lines, a sticky header. */
export const tableStyle = (theme: GrafanaTheme2) =>
  css({
    width: '100%',
    borderCollapse: 'collapse',
    'th, td': {
      padding: theme.spacing(0.5, 1),
      borderBottom: `1px solid ${theme.colors.border.weak}`,
      textAlign: 'left',
      verticalAlign: 'top',
    },
    th: {
      position: 'sticky',
      top: 0,
      background: theme.colors.background.primary,
      fontWeight: theme.typography.fontWeightMedium,
    },
  });

const getStyles = (theme: GrafanaTheme2) => ({
  toolbar: css({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.spacing(1, 2),
    minHeight: theme.spacing(4),
  }),
  control: css({ margin: 0 }),
  spacer: css({ flexGrow: 1 }),
  group: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1, 2),
    marginLeft: 'auto',
    flexWrap: 'nowrap',
  }),
});
