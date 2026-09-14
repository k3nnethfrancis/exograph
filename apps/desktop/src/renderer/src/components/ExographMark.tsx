import type { CSSProperties } from "react";

import {
  EXOGRAPH_MARK_ARMS,
  EXOGRAPH_MARK_NODES,
  EXOGRAPH_MARK_VIEW_BOX,
} from "../../../shared/exograph-mark";

interface ExographMarkProps {
  animated?: boolean;
  className?: string;
  size?: number;
}

export function ExographMark({ animated = false, className, size }: ExographMarkProps) {
  const classes = ["exograph-mark", animated ? "exograph-mark--animated" : null, className]
    .filter(Boolean)
    .join(" ");
  return (
    <svg
      aria-hidden="true"
      className={classes}
      style={size ? { width: size, height: size } : undefined}
      viewBox={EXOGRAPH_MARK_VIEW_BOX}
    >
      <g className="exograph-mark__arms">
        {EXOGRAPH_MARK_ARMS.map((d, index) => (
          <path
            className="exograph-mark__arm"
            d={d}
            key={d}
            style={{ "--exograph-mark-index": index } as CSSProperties}
          />
        ))}
      </g>
      <g className="exograph-mark__nodes">
        {EXOGRAPH_MARK_NODES.map(({ cx, cy, r }, index) => (
          <circle
            className="exograph-mark__node"
            cx={cx}
            cy={cy}
            key={`${cx}:${cy}`}
            r={r}
            style={{ "--exograph-mark-index": index } as CSSProperties}
          />
        ))}
      </g>
    </svg>
  );
}
