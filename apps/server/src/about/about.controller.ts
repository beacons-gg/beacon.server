import { Controller, Get, UseGuards } from "@nestjs/common";
import { missing } from "../common/capability-http";
import { AboutRateLimitGuard } from "../common/read-rate-limit.guard";
import { PROCESS_STARTED_AT } from "../server-identity";
import { SettingsService } from "../settings/settings.service";

/**
 * `GET /server/about`: the operator's long description of the server, as Markdown, for a directory
 * or a game to show beside the server's name. Public and unsigned. It is presentation, not a claim
 * a client acts on, and keeping it out of the signed descriptor keeps that document small and its
 * schema unchanged. Live: an admin write to `about` changes the answer at once.
 *
 * `updated` is when the text was last set: the admin write's time, or this process's start while
 * the environment still supplies it. A server with no text answers 404 `noAbout`, so a caller that
 * declares the code can tell "none" from a server without the route (`unknownRoute`). Either way it
 * is a 404, which is all an older caller reads.
 */
@Controller()
export class AboutController {
  constructor(private readonly settings: SettingsService) {}

  @Get("server/about")
  @UseGuards(AboutRateLimitGuard)
  about(): { about: string; updated: string } {
    const state = this.settings.state("about");
    if (!state.value) missing("noAbout", "this server has no about text");
    return { about: state.value, updated: state.updatedAt ?? PROCESS_STARTED_AT };
  }
}
