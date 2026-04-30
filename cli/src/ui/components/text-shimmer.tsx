import React from "react";
import { Text } from "ink";
import { useAnimation } from "ink";
import { colors, lerpColor } from "../theme.js";

const GRADIENT_WIDTH = 12;

interface TextShimmerProps {
  text: string;
  speed?: number;
}

export const TextShimmer = ({ text, speed = 1 }: TextShimmerProps) => {
  const { frame } = useAnimation({ interval: 50 });
  const position = (frame * speed) % (text.length + GRADIENT_WIDTH * 2) - GRADIENT_WIDTH;

  return (
    <Text>
      {[...text].map((char, i) => {
        const distance = Math.abs(i - position);
        const t = Math.max(0, 1 - distance / GRADIENT_WIDTH);
        const color = lerpColor(colors.shimmerBase, colors.shimmerHigh, t);
        return (
          <Text key={i} color={color}>
            {char}
          </Text>
        );
      })}
    </Text>
  );
};
