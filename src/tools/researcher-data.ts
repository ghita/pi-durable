import { defineDoc } from "@earendil-works/pi-durable";
import type { SearchSource } from "./types.ts";

export type ResearcherData = {
  maxSearches: number;
  searches: number;
  sources: SearchSource[];
  searchFailures: string[];
  findings: string;
  activatedSkills: string[];
};

export const ResearcherDataDoc = defineDoc<ResearcherData>({
  kind: "app.deep-research.researcher",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ maxSearches: 0, searches: 0, sources: [], searchFailures: [], findings: "", activatedSkills: [] }),
});
