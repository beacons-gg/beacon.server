import { servesPage, type PageRequest } from "../home/negotiate";
import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";
import { type ClientKeyRequest, clientKey } from "./client-key";
import { DidRateLimiter, envLimiter } from "./did-rate-limit";

/**
 * The shared body of the per-IP **read** limiters. Reads are anonymous by design (beacon.core
 * `doc/spec/discovery.md` §4.1), so the client IP is the only key available.
 *
 * **There are several budgets, and they are deliberately not pooled.** Pooling reproduces on the read
 * side the failure the write guard's breach log exists to diagnose, where one caller's traffic makes
 * an unrelated caller's request fail: a map pan would starve a place lookup, and either would close
 * the door a new client has to walk through to add the server at all. Each subclass below says what
 * it covers and why its budget is its own.
 *
 * **What these are for**, since a rate limit is easy to over-trust: they bound how *fast* a
 * stranger who learns the URL reads this server, not whether they may. Who may read at all is a
 * separate question, and this server doesn't restrict it yet. They are a **backstop** rather than
 * the primary defence, which an edge does better; `doc/deploy.md` ("What the edge owns") has the
 * division of labour and why a copy lives here anyway.
 *
 * In-process + per-instance by design (one server process per database), same deferred trigger as
 * every other limiter here. One caveat worth knowing before adding another IP-keyed limiter: the
 * 10k in `DidRateLimiter` is a prune *trigger*, not a cap, so within one window the key set grows
 * with distinct source addresses. For a DID-keyed limiter that population is the player cohort; for
 * these it is attacker-chosen, which is the point of them. Until a cap lands, the edge absorbs
 * volumetric floods until it lands.
 */
abstract class IpReadRateLimitGuard implements CanActivate {
  protected constructor(private readonly limiter: DidRateLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ClientKeyRequest>();
    if (!this.limiter.check(clientKey(req), Date.now())) {
      throw new HttpException(
        { ok: false, error: "rateLimited", message: "too many requests" },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}

/**
 * **Reference data**: `/geocode` and `/places`. No player state. `/geocode` proxies an upstream, so
 * this also bounds how much outbound work one client can queue behind the outbound throttle.
 *
 * `BEACON_PLACES_READ_RATE_LIMIT_MAX` per `BEACON_PLACES_READ_RATE_LIMIT_WINDOW_MS` (120 / 60s).
 */
@Injectable()
export class ReadRateLimitGuard extends IpReadRateLimitGuard {
  constructor() {
    super(envLimiter("BEACON_PLACES_READ_RATE_LIMIT", 120));
  }
}

/**
 * **Player state**: `GET /discovery`, `/rooms/:id`, `/profiles/:id`, `/media/:hash`. What a stranger
 * who learns the URL can read about the people playing here.
 *
 * The budget is generous because discovery is the client's hot path, fanned out per viewport per
 * covering server with a 15s poll whenever a view is too wide to subscribe. Sized so it never fires
 * in honest play behind a correctly configured edge, while still binding when there is no edge or
 * when someone reaches the container port directly.
 *
 * **It is a per-key budget, and one key is often several players.** Carrier NAT and a venue's wifi
 * put many clients on one address, and a location game deliberately gathers people at one
 * real-world place, which is the argument that moved the *write* budgets off IP entirely. Reads
 * have no such option: they are anonymous by design, so IP is the only key there is. So the one
 * deployment where this fires in honest play is a crowd on shared egress, and the answer there is
 * to raise the knob, not to key it differently.
 *
 * `BEACON_PLAYER_READ_RATE_LIMIT_MAX` per `..._WINDOW_MS` (600 / 60s).
 */
@Injectable()
export class PlayerReadRateLimitGuard extends IpReadRateLimitGuard {
  constructor() {
    super(envLimiter("BEACON_PLAYER_READ_RATE_LIMIT", 600));
  }
}

/**
 * **Signed player reads**: `POST /mailbox/fetch` and `POST /places/proposals/fetch`, a player
 * reading their own mail or their own submissions. Keyed by IP like every read guard here, because
 * it runs before the envelope is verified: it is the outer bound on traffic whose signature has not
 * been checked yet, so a flood of junk envelopes cannot buy unlimited Ed25519 verifies.
 *
 * Its own budget, so the discovery hot path cannot starve a player's mail, and the other way
 * round. Sized from the client: the mailbox catch-up poll is one fetch per covering server every
 * 30 seconds, two a minute, so 300 a minute leaves room for more than a hundred players on one
 * address (a venue's wifi, a carrier NAT) with headroom for their reconnect catch-ups.
 *
 * `BEACON_SIGNED_READ_RATE_LIMIT_MAX` per `..._WINDOW_MS` (300 / 60s).
 */
@Injectable()
export class SignedReadRateLimitGuard extends IpReadRateLimitGuard {
  constructor() {
    super(envLimiter("BEACON_SIGNED_READ_RATE_LIMIT", 300));
  }
}

/**
 * **The door**: `GET /server/descriptor` alone. It needs a budget because it signs a fresh
 * descriptor per request (`ServerIdentity.descriptor`), which is an Ed25519 signature an anonymous
 * caller can ask for as fast as it likes.
 *
 * It gets its **own** budget rather than the player-state one because the constraint here is
 * reachability, not secrecy: a client must fetch and verify this before it can add the server at
 * all. The budget is per key rather than per client, and on a shared egress (CGNAT, a campus, or
 * *any* deployment where `BEACON_TRUST_PROXY` is unset behind an edge) every caller collapses onto
 * one key, so sharing the hot path's bucket would let a few dozen panning clients spend the budget
 * and close onboarding for everyone behind that address. Nothing else can drain this one.
 *
 * `BEACON_DESCRIPTOR_RATE_LIMIT_MAX` per `..._WINDOW_MS` (600 / 60s).
 */
@Injectable()
export class DescriptorRateLimitGuard extends IpReadRateLimitGuard {
  constructor() {
    super(envLimiter("BEACON_DESCRIPTOR_RATE_LIMIT", 600));
  }
}

/**
 * **The about text**: `GET /server/about` alone. Its own budget for the same reason as the
 * descriptor's: a directory or a game reads it when it shows the server, and the hot path must not
 * be able to close it. Cheap to answer (a settings lookup), so a modest one.
 *
 * `BEACON_ABOUT_RATE_LIMIT_MAX` per `..._WINDOW_MS` (300 / 60s).
 */
@Injectable()
export class AboutRateLimitGuard extends IpReadRateLimitGuard {
  constructor() {
    super(envLimiter("BEACON_ABOUT_RATE_LIMIT", 300));
  }
}

/**
 * **The home page**: `GET /` for a browser and the fixed files it loads (`/_home/*`). Its own budget,
 * so a crowd opening the page from a QR code on one venue's wifi cannot spend the reference-data
 * bucket a game's place lookups draw on, and a stranger pulling the map library in a loop is bounded
 * here rather than nowhere. Generous, because one page view asks for several files.
 *
 * A `GET /` that is not for the page passes untouched: it is the same cheap 404 it always was, and a
 * load balancer's probe there must not start meeting 429s.
 *
 * `BEACON_HOME_RATE_LIMIT_MAX` per `..._WINDOW_MS` (300 / 60s).
 */
@Injectable()
export class HomeRateLimitGuard extends IpReadRateLimitGuard {
  constructor() {
    super(envLimiter("BEACON_HOME_RATE_LIMIT", 300));
  }

  override canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<PageRequest & { path?: string }>();
    if (req.path === "/" && !servesPage(req)) return true;
    return super.canActivate(context);
  }
}
