export const ABOVE_VIEWPORT_PENALTY = 1_000_000;

export function postViewportPriority(
  rect: Pick<DOMRect, 'top' | 'bottom' | 'height'>,
  viewportHeight: number,
): number {
  if (rect.bottom <= 0) {
    return ABOVE_VIEWPORT_PENALTY + (-rect.bottom);
  }
  const postCenter = rect.top + rect.height / 2;
  return Math.abs(postCenter - viewportHeight);
}

export interface TooltipHorizontalPosition {
  alignment: 'right' | 'left' | 'center';
  left?: number;
  right?: number;
  notchX?: number;
}

export function tooltipHorizontalPosition(
  button: Pick<DOMRect, 'left' | 'right' | 'width'>,
  tooltipWidth: number,
  viewportWidth: number,
  edgeMargin = 8,
): TooltipHorizontalPosition {
  const margin = Math.min(edgeMargin, Math.max(0, viewportWidth / 2));
  const availableWidth = Math.max(0, viewportWidth - margin * 2);
  const effectiveTooltipWidth = Math.min(Math.max(0, tooltipWidth), availableWidth);

  if (button.right - effectiveTooltipWidth >= margin) {
    return {
      alignment: 'right',
      right: Math.max(margin, viewportWidth - button.right),
    };
  }
  if (button.left + effectiveTooltipWidth <= viewportWidth - margin) {
    return {
      alignment: 'left',
      left: Math.max(margin, button.left),
    };
  }

  const buttonCenter = button.left + button.width / 2;
  const idealLeft = buttonCenter - effectiveTooltipWidth / 2;
  const maxLeft = Math.max(margin, viewportWidth - margin - effectiveTooltipWidth);
  const left = Math.min(Math.max(margin, idealLeft), maxLeft);
  const notchInset = 12;
  const notchWidth = 10;
  const rawNotchX = buttonCenter - left - notchWidth / 2;
  const maxNotchX = Math.max(notchInset, effectiveTooltipWidth - notchInset - notchWidth);
  return {
    alignment: 'center',
    left,
    notchX: Math.min(Math.max(notchInset, rawNotchX), maxNotchX),
  };
}

export interface TooltipVerticalPosition {
  top: number;
  flipped: boolean;
}

export function tooltipContentMaxHeight(
  viewportHeight: number,
  edgeMargin = 8,
  outerBorder = 2,
): number {
  return Math.max(0, viewportHeight - edgeMargin * 2 - outerBorder);
}

export function tooltipVerticalPosition(
  button: Pick<DOMRect, 'top' | 'bottom'>,
  tooltipHeight: number,
  viewportHeight: number,
  gap = 8,
  edgeMargin = 8,
): TooltipVerticalPosition {
  const margin = Math.min(edgeMargin, Math.max(0, viewportHeight / 2));
  const height = Math.max(0, tooltipHeight);
  const aboveTop = button.top - gap - height;
  const belowTop = button.bottom + gap;

  if (aboveTop >= margin) return { top: aboveTop, flipped: false };
  if (belowTop + height <= viewportHeight - margin) {
    return { top: belowTop, flipped: true };
  }

  const maxTop = Math.max(margin, viewportHeight - margin - height);
  const roomAbove = button.top - gap - margin;
  const roomBelow = viewportHeight - margin - gap - button.bottom;
  const preferredTop = roomBelow > roomAbove ? belowTop : aboveTop;
  return {
    top: Math.min(Math.max(margin, preferredTop), maxTop),
    flipped: roomBelow > roomAbove,
  };
}
