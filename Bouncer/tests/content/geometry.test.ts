import { describe, expect, it } from 'vitest';
import {
  ABOVE_VIEWPORT_PENALTY,
  postViewportPriority,
  tooltipContentMaxHeight,
  tooltipHorizontalPosition,
  tooltipVerticalPosition,
} from '../../src/content/geometry.js';

describe('postViewportPriority', () => {
  it('prioritizes posts just below the fold over posts at the top', () => {
    const top = postViewportPriority({ top: 0, bottom: 200, height: 200 }, 800);
    const belowFold = postViewportPriority({ top: 780, bottom: 980, height: 200 }, 800);
    expect(belowFold).toBeLessThan(top);
  });

  it('heavily penalizes posts already scrolled above the viewport', () => {
    expect(postViewportPriority({ top: -300, bottom: -100, height: 200 }, 800))
      .toBe(ABOVE_VIEWPORT_PENALTY + 100);
  });
});

describe('tooltipHorizontalPosition', () => {
  it('right-aligns when the tooltip fits to the button left', () => {
    expect(tooltipHorizontalPosition({ left: 700, right: 730, width: 30 }, 260, 800))
      .toEqual({ alignment: 'right', right: 70 });
  });

  it('left-aligns when only the button right side has room', () => {
    expect(tooltipHorizontalPosition({ left: 20, right: 50, width: 30 }, 260, 800))
      .toEqual({ alignment: 'left', left: 20 });
  });

  it('centers and clamps the notch when neither side fits', () => {
    const position = tooltipHorizontalPosition({ left: 145, right: 175, width: 30 }, 300, 320);
    expect(position.alignment).toBe('center');
    expect(position.left).toBe(10);
    expect(position.notchX).toBeGreaterThanOrEqual(12);
    expect(position.notchX).toBeLessThanOrEqual(278);
  });

  it('uses the available width on a viewport narrower than the CSS minimum', () => {
    const position = tooltipHorizontalPosition({ left: 70, right: 100, width: 30 }, 220, 180);
    expect(position.alignment).toBe('center');
    expect(position.left).toBe(8);
    expect(position.notchX).toBeGreaterThanOrEqual(12);
    expect(position.notchX).toBeLessThanOrEqual(142);
  });
});

describe('tooltipVerticalPosition', () => {
  it('places the tooltip above when it fits', () => {
    expect(tooltipVerticalPosition({ top: 400, bottom: 430 }, 200, 800))
      .toEqual({ top: 192, flipped: false });
  });

  it('places the tooltip below when the top edge would clip', () => {
    expect(tooltipVerticalPosition({ top: 20, bottom: 50 }, 200, 800))
      .toEqual({ top: 58, flipped: true });
  });

  it('clamps an oversized tooltip inside a short viewport', () => {
    const position = tooltipVerticalPosition({ top: 140, bottom: 170 }, 500, 300);
    expect(position.top).toBe(8);
    expect(position.flipped).toBe(false);
  });

  it('bounds scrollable tooltip content inside both viewport margins', () => {
    expect(tooltipContentMaxHeight(300)).toBe(282);
    expect(tooltipContentMaxHeight(10)).toBe(0);
  });
});
