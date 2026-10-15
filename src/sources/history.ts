export type HistoryParents = Readonly<Record<string, readonly [string, string]>>;

// Bump whenever a history-policy change requires rebuilding persisted timelines.
export const HISTORY_MODEL = 2;

// These pull merges put the published upstream history in parent two. Bind both
// parents so a replaced Git object fails closed. Evidence: docs/HISTORY.md.
export const CORE_HISTORY_PARENTS: HistoryParents = {
  dbf81ea4ab3c5591d382b5380c303e60fb094b99: [
    "e802027e344362ab2f810cb5460e63dd66e743c5",
    "7debfcb39ab0ed0ca86de0e39d4d20773bbc022b",
  ],
  d4cc0feb7b4eda2bf4a95b9a3cf361bccaf224da: [
    "124c51924d754fd2663dbe2161561e2a976c6020",
    "f2e951bdeeec4bc0250641f6cb2e0104ed32f153",
  ],
  "31ffb7afd03a690c42722c66ed622109fc51c103": [
    "098cdbe43d7d58db4819d643f4dac7b1af068c22",
    "9d709ffe260e44d604cd5b815371af736a585a28",
  ],
};

export const CASK_HISTORY_PARENTS: HistoryParents = {
  ee51d5d1888f60480a90a50647507e7930b23f41: [
    "80fc39acff3097591615c077ef78807cefde1272",
    "5097cd0027d008125c79ae68ccc4916915a717a3",
  ],
  "0c6faf865cbf520b73cec60568892cf1d2904944": [
    "e9447b51fc03e9bc3eae8f0b5e8d4ceb73584cb4",
    "fdf001022a67381b2579bc16ab1c895cd8be5c80",
  ],
  e9447b51fc03e9bc3eae8f0b5e8d4ceb73584cb4: [
    "7f0ad61a8bf65e23ebf57a7cc75e15514f5cfda3",
    "08f90e392e9144b2b41dc07f03ad31a510ded737",
  ],
  "6a7ea0432cf5c6f0a222e279d28c4f6fd4c369de": [
    "8e3e0db1241d13a338126dda882dd8c851b7d339",
    "7f57a1dbb6592f95b7474c2b3dc3ae08c3743e1f",
  ],
};
