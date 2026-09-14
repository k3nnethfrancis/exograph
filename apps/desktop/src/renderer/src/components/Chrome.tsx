import type { MouseEventHandler, ReactNode } from "react";

interface RailButtonProps {
  title: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
  children: ReactNode;
  testId?: string;
  className?: string;
  disabled?: boolean;
}

interface ChromeTabProps {
  active: boolean;
  title?: string;
  testId?: string;
  className?: string;
  dropPaneId?: string;
  dropKind?: "editor" | "terminal" | "browser";
  itemId?: string;
  onClick: MouseEventHandler<HTMLElement>;
  onDoubleClick?: MouseEventHandler<HTMLElement>;
  onMouseDown?: MouseEventHandler<HTMLElement>;
  onContextMenu?: MouseEventHandler<HTMLElement>;
  leading?: ReactNode;
  trailing?: ReactNode;
  closeLabel?: string;
  closeTestId?: string;
  closeIcon?: ReactNode;
  onClose?: MouseEventHandler<HTMLSpanElement>;
  children: ReactNode;
}

export function RailButton(props: RailButtonProps) {
  const { title, onClick, children, testId, className, disabled } = props;
  return (
    <button
      className={`appearance-toggle__button ${className ?? ""}`.trim()}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}

export function ChromeTab(props: ChromeTabProps) {
  const {
    active,
    title,
    testId,
    className,
    dropPaneId,
    dropKind,
    itemId,
    onClick,
    onDoubleClick,
    onMouseDown,
    onContextMenu,
    leading,
    trailing,
    closeLabel,
    closeTestId,
    closeIcon,
    onClose,
    children,
  } = props;

  return (
    <div
      className={`chrome-tab ${active ? "chrome-tab--active" : ""} ${className ?? ""}`.trim()}
      data-testid={testId}
      data-tab-item-id={itemId}
      data-tab-drop-pane-id={dropPaneId}
      data-tab-drop-kind={dropKind}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      title={title}
      role="button"
      tabIndex={0}
    >
      {leading}
      <span className="chrome-tab__label">{children}</span>
      {trailing}
      {onClose ? (
        <span
          aria-label={closeLabel}
          className="chrome-tab__close"
          data-testid={closeTestId}
          onClick={onClose}
          role="button"
        >
          {closeIcon}
        </span>
      ) : null}
    </div>
  );
}
