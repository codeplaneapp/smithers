export type GroundedWebSearchProviderKind = "semantic" | "fresh";

export type GroundedWebSearchProviderName = "exa" | "tavily" | "brave" | "serper";

export type GroundedWebSearchResult = {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: string;
  score?: number;
};

export type GroundedWebSearchProvider = {
  name: GroundedWebSearchProviderName;
  kind: GroundedWebSearchProviderKind;
  search(input: {
    query: string;
    maxResults: number;
    freshness?: "day" | "week" | "month" | "year";
  }): Promise<GroundedWebSearchResult[]>;
};
