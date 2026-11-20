import { UNDERSTANDS_HEADER } from "@beaconsgg/protocol-types";
import { codeFor, parseUnderstands } from "@beaconsgg/protocol-types/server";
import { type ArgumentsHost, Catch, HttpException } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import { refusal } from "./capability-http";

/**
 * Every HTTP refusal leaves through here, so this is where a code added after the capability-marker
 * baseline meets the caller's declaration: a client that declared `code:<name>` in the
 * `beacon-understands` header gets the new code, anyone else the one it already handles
 * (`CODE_FALLBACKS`, and at 404 `NOT_FOUND_FALLBACKS`), at the same status. Everything else is
 * Nest's default handling, unchanged.
 *
 * At the response rather than where each code is chosen, for two reasons. The policy engine stays
 * unaware of who is calling, which is what lets it stay one engine for every transport. And it holds
 * for a code that IS stored: the engine records an op's result under its nonce and a retry replays
 * the record, so a code chosen per caller would freeze the first caller's declaration into every
 * replay. Neither of today's codes is stored (`clockSkew` refuses before the replay check,
 * `deviceRevoked` is deliberately never finalized), so that is the next code's protection.
 *
 * The same holds for the 404s that name what is missing (`unknownPlace`, `unknownRun`, ...): a
 * client that has not declared one gets `unknownRoute`, the code every 404 carried before, so an
 * SDK that reads `unknownRoute` as "not there" keeps doing so. Only at 404: `unknownPlace` and
 * `unknownMedia` are also 400 codes a proposal has always answered, and those stay as they are,
 * which is why `codeFor` takes the status.
 *
 * The answers the framework makes on its own get the refusal body here too (`frameworkRefusal`).
 *
 * HTTP only. Nest never consults global filters for a gateway, so the one socket refusal that can
 * carry such a code (`mailbox:subscribe`) downgrades its own ack.
 */
@Catch()
export class UnderstandsFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== "http") return super.catch(exception, host);
    const answer = frameworkRefusal(exception) ?? exception;
    super.catch(answer instanceof HttpException ? shaped(answer, host) : answer, host);
  }
}

/**
 * The code for each status the framework answers on its own: Express's 404 for a path no route
 * serves, Nest's 400 for a body that is not JSON or a path that does not decode, and the body
 * parser's 413 for a body over the limit and 415 for a charset or an encoding it does not take. The
 * server's own routes always throw a refusal body, so a bare answer at these statuses is the
 * framework's.
 */
const FRAMEWORK_CODES: Readonly<Record<number, string>> = {
  400: "invalid",
  404: "unknownRoute",
  413: "tooLarge",
  415: "invalid",
};

/**
 * A refusal body for an answer the framework made without one. A client tells a refusal from a
 * fault by that body (core 0.4's `isRefusal`), and reads a bare 4xx as a fault it may retry, which
 * an oversized upload never stops being. The status stays; `undefined` leaves the exception as it is.
 */
function frameworkRefusal(exception: unknown): HttpException | undefined {
  let status: number;
  let message: unknown;
  if (exception instanceof HttpException) {
    const body = exception.getResponse();
    if (refusalCode(body) !== undefined) return undefined;
    status = exception.getStatus();
    message =
      typeof body === "object" && body !== null ? (body as { message?: unknown }).message : body;
  } else if (isClientHttpError(exception)) {
    status = exception.status;
    message = exception.message;
  } else {
    return undefined;
  }
  const error = FRAMEWORK_CODES[status];
  if (error === undefined) return undefined;
  return refusal(status, error, typeof message === "string" ? message : undefined);
}

/** The code of a refusal body (`{ ok: false, error }`), or `undefined` for any other body. */
function refusalCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { ok, error } = body as { ok?: unknown; error?: unknown };
  return ok === false && typeof error === "string" ? error : undefined;
}

/** A 4xx `http-errors` error meant for the client, which is what the body parser passes to Express. */
function isClientHttpError(exception: unknown): exception is Error & { status: number } {
  return (
    exception instanceof Error &&
    typeof (exception as { status?: unknown }).status === "number" &&
    (exception as { expose?: unknown }).expose === true
  );
}

/** The exception to send this caller: `exception` itself unless its code is newer than they declared. */
function shaped(exception: HttpException, host: ArgumentsHost): HttpException {
  const body = exception.getResponse();
  const error = refusalCode(body);
  if (error === undefined) return exception;
  const request = host.switchToHttp().getRequest<{ headers?: Record<string, unknown> }>();
  const understands = parseUnderstands(request.headers?.[UNDERSTANDS_HEADER]);
  const sent = codeFor(error, understands, { status: exception.getStatus() });
  if (sent === error) return exception;
  return new HttpException({ ...(body as object), error: sent }, exception.getStatus());
}
