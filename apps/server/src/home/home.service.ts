import type { Store } from "@beaconsgg/policy-engine";
import type { GlobalId } from "@beaconsgg/protocol-types";
import QRCode from "qrcode";
import type { ServerConfig } from "../config";
import type { DescriptorFacts } from "../server-identity";
import { buildHomeView, placesShown, statsShown, type HomeView } from "./home.view";

/** The room counts the home page shows; the Postgres store answers both. */
export interface RoomActivity {
  countRooms(): Promise<number>;
  countRoomsTouchedSince(sinceSec: number): Promise<number>;
}

/** The active-place count the home page shows: the same number as the console's overview. */
export type PlaceCount = () => Promise<number>;

/** How long a count is reused: a busy page should not count a table on every view. */
export const COUNTS_TTL_MS = 60_000;

/** How far back "changed" reaches: a month, so a quiet week still shows a server in use. */
export const CHANGED_WINDOW_SECONDS = 30 * 24 * 60 * 60;

/** The same reserved id the readiness probe asks for: never a room, always a real query. */
const READINESS_PROBE_ID = "health@readiness-probe" as GlobalId;

/** Whether a store can count room activity (the Postgres one can; the suites' in-memory one cannot). */
export function roomActivityOf(store: unknown): RoomActivity | undefined {
  const s = store as Partial<RoomActivity> | undefined;
  return typeof s?.countRooms === "function" && typeof s.countRoomsTouchedSince === "function"
    ? (s as RoomActivity)
    : undefined;
}

/**
 * One count reused for {@link COUNTS_TTL_MS}, and shared by the views that ask while it runs. A
 * failed count is not kept, so the next view retries, and reads as none: the page still renders.
 */
class CachedCount<T> {
  private held: { at: number; value: T } | undefined;
  private running: Promise<T | undefined> | undefined;

  constructor(
    private readonly count: () => Promise<T>,
    private readonly now: () => number,
  ) {}

  get(): Promise<T | undefined> {
    const now = this.now();
    if (this.held && now - this.held.at < COUNTS_TTL_MS) return Promise.resolve(this.held.value);
    this.running ??= this.count()
      .then(
        (value) => {
          this.held = { at: now, value };
          return value;
        },
        () => undefined,
      )
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
}

/** The counts the home page shows, where the store can give them; `now` is for tests. */
export interface HomeCounts {
  rooms?: RoomActivity | undefined;
  placeCount?: PlaceCount | undefined;
  now?: () => number;
}

/**
 * Assembles the home page's {@link HomeView} per request from the live config (an operator's
 * rename shows at once) and the descriptor's facts. The QR code is drawn once per address and the
 * counts are reused for a minute, so a page view costs one readiness query at most.
 */
export class HomeService {
  private qr: { origin: string; svg: string } | undefined;
  private readonly roomCounts: CachedCount<{ total: number; changedThisMonth: number }> | undefined;
  private readonly placeTotal: CachedCount<number> | undefined;

  constructor(
    private readonly config: ServerConfig,
    private readonly facts: () => DescriptorFacts,
    private readonly store: Pick<Store, "getRoom">,
    { rooms, placeCount, now = Date.now }: HomeCounts = {},
  ) {
    this.roomCounts = rooms
      ? new CachedCount(async () => {
          const [total, changedThisMonth] = await Promise.all([
            rooms.countRooms(),
            rooms.countRoomsTouchedSince(Math.floor(now() / 1000) - CHANGED_WINDOW_SECONDS),
          ]);
          return { total, changedThisMonth };
        }, now)
      : undefined;
    this.placeTotal = placeCount ? new CachedCount(placeCount, now) : undefined;
  }

  async view(): Promise<HomeView> {
    const origin = this.config.publicUrl.replace(/\/+$/, "");
    const facts = this.facts();
    // Counted only where the page shows the number.
    const [ready, rooms, places, qrSvg] = await Promise.all([
      this.ready(),
      statsShown(this.config.homeStats, this.config.accessLevel)
        ? this.roomCounts?.get()
        : undefined,
      placesShown(this.config, facts) ? this.placeTotal?.get() : undefined,
      this.qrFor(origin),
    ]);
    return buildHomeView({ facts, config: this.config, ready, rooms, places, qrSvg });
  }

  private async ready(): Promise<boolean> {
    try {
      await this.store.getRoom(READINESS_PROBE_ID);
      return true;
    } catch {
      return false;
    }
  }

  private async qrFor(origin: string): Promise<string> {
    if (this.qr?.origin !== origin) {
      const svg = await QRCode.toString(origin, {
        type: "svg",
        errorCorrectionLevel: "M",
        margin: 0,
        color: { dark: "#0b0b0dff", light: "#ececefff" },
      });
      this.qr = { origin, svg };
    }
    return this.qr.svg;
  }
}
