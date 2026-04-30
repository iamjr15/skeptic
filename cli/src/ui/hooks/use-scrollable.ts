import { useState, useMemo, useCallback } from "react";

interface ScrollableResult<T> {
  visible: T[];
  scrollOffset: number;
  scrollUp: () => void;
  scrollDown: () => void;
  canScrollUp: boolean;
  canScrollDown: boolean;
}

export const useScrollable = <T>(items: T[], maxVisible: number): ScrollableResult<T> => {
  const [scrollOffset, setScrollOffset] = useState(0);

  const maxOffset = Math.max(0, items.length - maxVisible);
  const clampedOffset = Math.min(scrollOffset, maxOffset);

  const visible = useMemo(
    () => items.slice(clampedOffset, clampedOffset + maxVisible),
    [items, clampedOffset, maxVisible],
  );

  const scrollUp = useCallback(() => {
    setScrollOffset((prev) => Math.max(0, prev - 1));
  }, []);

  const scrollDown = useCallback(() => {
    setScrollOffset((prev) => Math.min(maxOffset, prev + 1));
  }, [maxOffset]);

  return {
    visible,
    scrollOffset: clampedOffset,
    scrollUp,
    scrollDown,
    canScrollUp: clampedOffset > 0,
    canScrollDown: clampedOffset < maxOffset,
  };
};
