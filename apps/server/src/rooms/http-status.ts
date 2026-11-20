import type { ErrorCode } from "@beaconsgg/protocol-types";

/**
 * Map an op rejection code (`doc/spec/room-operation.md` §11) to an HTTP status, so `/ops` surfaces
 * logical rejections with a meaningful status while keeping the `{ok:false,error}` body the client
 * keys off.
 */
export function statusForError(error: ErrorCode): number {
  switch (error) {
    case "badsig":
      return 401;
    case "denied":
    case "gameNotAdmitted":
    case "gameNotAccepted":
    case "deviceRevoked":
    case "notMember":
      return 403; // same status, different codes: see ERROR_CODES on why the client needs each
    case "unknownRoom":
    case "expired":
      return 404; // gone / never existed
    case "unknownRoute":
    case "unknownPlace":
    case "unknownMedia":
    case "unknownProposal":
    case "unknownRun":
    case "noAbout":
      return 404; // the routes' own 404s, which no room op answers with
    case "phase":
    case "full":
    case "gone":
    case "empty":
    case "locked":
    case "stale":
      return 409; // conflict with current shared state
    case "rateLimited":
      return 429;
    case "invalid":
    case "clockSkew":
      return 400;
    default:
      error satisfies never; // compile error if a new ErrorCode is added without a status
      return 400;
  }
}
