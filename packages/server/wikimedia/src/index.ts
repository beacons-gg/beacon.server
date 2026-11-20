// @beaconsgg/wikimedia — [S] server-only
// One paced, `maxlag`-honouring, three-valued client for the Wikimedia read APIs. Server-only
// because it is an *ingestion* concern: a beacon server never calls Wikimedia (that is the whole
// point of Atlas), and a game never calls it at all. Its consumer is operator-side: the three network
// stages of `apps/atlas/cartographer` — the Wikidata concordance, the article pass, and the media crawl —
// which must agree about the etiquette, the retry budget, and the answered/unanswered distinction. It began
// as a package because two separate jobs read Wikimedia and had already drifted; one of them was absorbed,
// and the reason to keep it is unchanged, because the axis it protects is the expensive one: whether
// Wikimedia declining to answer gets recorded as "there is nothing there".

export * from "./client";
