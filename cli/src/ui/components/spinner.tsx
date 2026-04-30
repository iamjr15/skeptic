import React from "react";
import { Text } from "ink";
import InkSpinner from "ink-spinner";
import { colors } from "../theme.js";

export const Spinner = () => (
  <Text color={colors.active}>
    <InkSpinner />
  </Text>
);
