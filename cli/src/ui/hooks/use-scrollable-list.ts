import { useCallback, useMemo, useRef, useState } from "react";
import type { Key } from "ink";

interface ScrollableListOptions {
  itemCount: number;
  visibleCount: number;
}

export const useScrollableList = ({ itemCount, visibleCount }: ScrollableListOptions) => {
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const previousItemCountRef = useRef(itemCount);

  if (previousItemCountRef.current !== itemCount) {
    previousItemCountRef.current = itemCount;
    setHighlightedIndex((previous) => Math.min(previous, Math.max(0, itemCount - 1)));
  }

  const scrollOffset = useMemo(() => {
    if (itemCount <= visibleCount) return 0;
    const half = Math.floor(visibleCount / 2);
    const maxOffset = itemCount - visibleCount;
    return Math.min(maxOffset, Math.max(0, highlightedIndex - half));
  }, [highlightedIndex, itemCount, visibleCount]);

  const handleNavigation = useCallback(
    (input: string, key: Key): boolean => {
      if (key.downArrow || input === "j") {
        setHighlightedIndex((previous) => Math.min(itemCount - 1, previous + 1));
        return true;
      }
      if (key.upArrow || input === "k") {
        setHighlightedIndex((previous) => Math.max(0, previous - 1));
        return true;
      }
      return false;
    },
    [itemCount],
  );

  return { highlightedIndex, setHighlightedIndex, scrollOffset, handleNavigation };
};
