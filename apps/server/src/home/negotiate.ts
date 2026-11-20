/**
 * Who gets the home page at `GET /`: a browser, which names HTML in its Accept header, and a link
 * preview's fetcher, which often sends only `*\/*` but reads the page's title and description to
 * draw the card when someone pastes the address into a chat. Everything else (an SDK, `curl`, a
 * load balancer's probe) keeps the 404 it always had.
 */

/** Whether an Accept header asks for HTML, a `q=0` on it being a refusal rather than a request. */
export function wantsHtml(accept: string | string[] | undefined): boolean {
  const value = Array.isArray(accept) ? accept.join(",") : (accept ?? "");
  return value.split(",").some((part) => {
    const [type, ...params] = part.split(";").map((s) => s.trim().toLowerCase());
    if (type !== "text/html") return false;
    const q = params.find((p) => p.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/** The link-preview fetchers of the chats a server's address gets pasted into. */
const UNFURLERS =
  /discordbot|slackbot|twitterbot|facebookexternalhit|whatsapp|telegrambot|linkedinbot|redditbot|mastodon|bluesky|skypeuripreview|iframely|embedly/i;

export function isUnfurler(userAgent: string | string[] | undefined): boolean {
  const value = Array.isArray(userAgent) ? userAgent.join(" ") : (userAgent ?? "");
  return UNFURLERS.test(value);
}

/** The request headers the decision reads. */
export interface PageRequest {
  headers: Record<string, string | string[] | undefined>;
}

export function servesPage(req: PageRequest): boolean {
  return wantsHtml(req.headers["accept"]) || isUnfurler(req.headers["user-agent"]);
}
