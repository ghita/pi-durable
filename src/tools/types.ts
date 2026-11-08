import type { Context } from "@earendil-works/chord/context";

export type SearchSource = { title: string; url: string; content: string; query: string };
export type SearchResult = { ok: true; results: SearchSource[] } | { ok: false; error: string };
export type SearchProvider = (query: string, context: Context) => Promise<SearchResult>;
