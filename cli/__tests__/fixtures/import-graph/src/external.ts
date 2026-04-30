// Imports a node_modules package — should NOT appear in the graph (filtered out post-resolve).
import { minimatch } from "minimatch";
export const external = (s: string) => minimatch(s, "*");
