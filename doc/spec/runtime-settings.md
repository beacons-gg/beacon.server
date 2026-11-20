# Runtime settings

This spec covers the server settings an operator can change on a running server. The spec also
covers how a stored value and the environment decide together and how a change reaches the code
without a restart.

Checked against Beacon 0.3.

Where the database lives is a deploy decision, and changing it means a restart. How long a mailbox
message lives is an operator's policy for a running server. The server keeps the policy settings in
its database, leaves the deploy settings in the environment and treats the environment as the source
of defaults.

## 1. Scope

- **A durable settings store and a live configuration.** An admin's change takes effect on the next
  request and on the next signed descriptor.
- **No new auth surface.** A signed `admin.settings.*` op writes the settings through the shared
  admin gate ([admin API](admin-api.md) §1). An operator who can moderate can configure.
- **The same parsing.** `loadConfig` still parses, validates and defaults every variable. The result
  of `loadConfig` stops being the last word for the runtime settings.
- **One instance per database.** The in-process cache is correct only because no second process
  serves the same rows. Running several instances against one database would need a change notice
  between them, which the server doesn't have (§7).

## 3. The classification

Every field of `ServerConfig` falls into exactly one of three kinds. `settings/registry.ts` declares
the split, and the compiler refuses a new field that nobody has classified.

| Kind        | Count | Where the value lives                                            |
| ----------- | ----- | ---------------------------------------------------------------- |
| Runtime     | 42    | the `settings` table, with the environment as the default        |
| Deploy-time | 36    | the environment only                                             |
| Derived     | 1     | nowhere: `capabilities` is computed from the toggles and `games` |

A stored copy of a derived field would be a second truth that goes stale when a toggle moves, so the
server computes `capabilities` on each read.

### 3.1 Deploy-time

| Group                | Fields                                                                      | Why the field stays in the environment                                                       |
| -------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Bootstrap            | `databaseUrl`, `pgPoolSize`, `maxNonces` and `writerLockWaitMs`             | the server needs the database before it can read settings from it                            |
| Listen               | `port` and `host`                                                           | `port` binds at boot, and `host` is part of every room id clients already hold               |
| Identity and secrets | `mnemonic`, `keyProvider`, `keyFile` and `keyPassphrase`                    | changing them changes the server's DID, and no admin op may read them back                   |
| Media storage        | `mediaBackend`, `mediaDir` and the seven `mediaS3*` fields                  | the backend is picked at boot, and the S3 credentials are secrets                            |
| Hosting limits       | `mediaLimitBytes`, `restoreDatabaseLimitBytes` and `backupPrivateEndpoints` | whoever hosts the server sets these, and an admin op that could raise them would defeat them |
| Paths                | `atlasStagingDir` and `atlasVolumesDir`                                     | deploy paths; `atlasVolumesDir` also bounds which files an admin op may read                 |
| Access control       | `admins`, `corsOrigins` and `trustProxy`                                    | see §3.3                                                                                     |
| Data shape           | `placesCellPrecision`                                                       | see §3.4                                                                                     |
| Boot-mounted         | `version`, `docsEnabled`, `docsPath` and the five `home*` fields            | the build's version, and routes mounted once at boot                                         |

### 3.2 Runtime

Every operator policy setting is runtime:

- **Descriptor:** `name`, `description`, `contact`, `about`, `coverage`, `accessLevel` and
  `publicUrl`.
- **Admission:** `games`.
- **The read-only lock:** `writeLocked`.
- **Capability toggles:** `mailboxEnabled`, `mediaEnabled`, `geocodeEnabled`, `placesEnabled`,
  `placesContributionsEnabled` and `placesContribExportEnabled`.
- **Mailbox:** `mailboxTtlSeconds`, `mailboxMaxBody`, `mailboxSendMax` and `mailboxSendWindowMs`.
- **Media:** `mediaMaxBytes`, `mediaTypes`, `mediaQuotaBytes`, `mediaRateMax`, `mediaRateWindowMs`
  and `mediaCdnUrl`.
- **Geocode:** `geoUserAgent`, `geocodeProvider`, `geocodeEndpoint`, `geocodePrecision`,
  `geocodeTtlSeconds`, `geocodeNegativeTtlSeconds`, `geocodeMinIntervalMs` and `geocodeTimeoutMs`.
- **Places:** `placesQueryPageSize`, `placesQueryMaxCells`, `placesTimeoutMs`,
  `placesImageMaxBytes`, `placesImageTimeoutMs`, `placesImageMinIntervalMs`,
  `placesProposalRateMax`, `placesProposalRateWindowMs` and `placesProposalMaxPending`.

Each runtime setting has a zod schema, so an admin write is refused the way a bad variable is
refused at boot. A bad variable fails while a person watches the boot log. A bad admin write fails
at runtime, when nobody may be watching. The schemas therefore reuse the wire's own where one
exists, such as `gameSlugSchema` and `serverAccessLevelSchema`. Some schemas are stricter than
`loadConfig`, because the consumer is the real limit:

- `geocodeProvider` must name a provider the server can build. Otherwise the server would fail at
  boot with an override that only a running server could reset.
- `placesQueryMaxCells` is the only limit on an unsigned `GET /places`. The setting can't exceed its
  own default of 256.
- `mailboxMaxBody` can't exceed the wire's own cap of 4096 bytes (`MAX_MAILBOX_BODY`). The wire
  refuses a longer body whatever the setting says, so a larger value would be a limit no message
  reaches. `loadConfig` refuses a larger `BEACON_MAILBOX_MAX_BODY` at boot too.
- `coverage` can't be empty, since an empty list would advertise no coverage in a signed descriptor.

### 3.3 Access control stays in the environment

`admins`, `corsOrigins` and `trustProxy` could be stored. Each stays in the environment because each
is the control that protects the others:

- **`admins`** is the bootstrap. An admin who could edit the allowlist could empty it and lock the
  operator out with no recovery short of editing the database. The blocklist never blocks an admin
  for the same reason.
- **`corsOrigins`** decides which browser origins may call the server. An admin who could widen it
  to `*` would open the server to every browser.
- **`trustProxy`** decides whether the client IP can be trusted. Set to `true`, it makes the IP the
  client-controlled `X-Forwarded-For` header and defeats the IP rate limits.

The rule: **a setting that can disable a control is not admin-editable.** Changing one takes a
deploy.

### 3.4 Settings that look like policy and aren't

**`placesCellPrecision` shapes the index.** Every place commit writes `place_cells` rows at this
precision, and reads coarsen query cells to it. On a running server a change would index new places
at one precision and leave old rows at another. Queries would then return fewer places without an
error. The setting is deploy-time, and changing it means rebuilding the index.

**`mediaMaxBytes` also sizes the JSON body limit at boot.** The server sizes its JSON body parser
from `mediaMaxBytes` once, and the parser keeps that limit. An admin can lower the setting at
runtime. A raised value is clamped to the boot value, so the number the console shows is the one in
force (§4.1). The body parser is sized whether media is on or off, so turning media on at runtime
works.

**A capability turned on at runtime has to work in full.** Three rules follow:

- A consumer that needs media asks whether media is on at each use. The place import that re-hosts
  photos is one such consumer.
- A periodic job starts at boot whatever the setting says and checks the capability on each tick.
  The mailbox and geocode expiry sweeps work this way.
- The nonce log and its sweep run on every server, so turning on a signed capability never leaves a
  route without replay protection.

## 4. Environment precedence

The environment supplies defaults. The `settings` table holds admin overrides and nothing else, so a
missing row means the environment decides:

| State          | The variable changes and the server restarts | Result                                                             |
| -------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| No override    | yes                                          | the new value takes effect                                         |
| Admin override | yes                                          | the override holds, and a deploy never reverts a deliberate choice |
| Admin reset    | not applicable                               | the row is deleted, and the setting follows the environment        |

A seed-only rule would make a variable an operator re-tunes in a compose file do nothing. A rule
where the environment always wins would lock every setting an operator put in a compose file. Reset
is the way back: without it one exploratory edit would detach a setting from the environment for
good.

The blocklist seeds its variable into its table, and settings don't. A blocklist row is the only
record that a DID is blocked, so the variable's entries are the data. A setting's variable is read
again on every boot, so a stored copy would only go stale.

### 4.1 When the rows and the environment disagree

Stored rows outlive the environment they were written against, so the two can describe a state
`loadConfig` could never produce.

**A prerequisite can go missing under a dependent.** `loadConfig` turns proposals on only when
places are on. The pair "proposals on and places off" therefore can't come from the environment.
Three paths reach it once overrides exist:

- an admin turns places and then proposals on, and later resets places;
- an operator turns places off in the compose file and redeploys over a proposals override;
- two admin writes interleave.

The server enforces each prerequisite twice, from one declaration. A write that would break one is
refused with a message naming the setting, because an admin is there to read it. The server coerces
the assembled configuration the way `loadConfig` coerces, so the forbidden pair is never served.
That holds whatever path produced the pair. A reset is never refused for the combination it leaves.

The dependent goes dormant. The row stays, and the value is off while the prerequisite is off. The
row applies again when the prerequisite returns. The server reports a dormant override at boot. The
admin read shows the stored value beside the value in force and names the reason. The reason
`prerequisite` means turn the capability on. The reason `ceiling` means raise the variable and
restart.

**A row can outlive the schema that accepted it.** A newer release's schema may refuse a stored
value. The server then logs the value, ignores it and falls back to the environment. The row isn't
deleted, so a rollback to the older release still finds it. Boot never writes to the table. A reset
is the one way an admin deletes such a row.

## 5. The live view and the admin ops

### 5.1 The live view

Every consumer reads one live `ServerConfig` instead of calling `loadConfig` itself. The live
configuration is provided as `SERVER_CONFIG`. The view has the same shape and type as the boot
result:

- runtime fields are accessors over the settings cache;
- deploy-time fields come from the boot snapshot;
- `capabilities` is computed on each read.

The rule that makes a change land is **hold the object, read at the point of use.** Each service
holds a narrowed slice of the view, built by `liveView` as accessors and never as copied values. The
per-DID rate limiters and the outbound HTTP clients hold their options objects and read the window,
the limit and the timeout on each check. An accessor chain has to stay lazy at every hop: one
constructor that copies a value into a field freezes it for the life of the process.

Two facts made this cheap. Every capability route exists whatever the toggle says and answers `404`
per request while its capability is off, so a toggle moves without remounting routes. The descriptor
is built and signed on each request from the view, so a new name or coverage is signed on the next
fetch.

A rate limiter reads its budget on each check, so a changed budget applies to the next check. The
limiter keeps the counts already in each window. Rebuilding the limiter would reset every window and
give a throttled sender a fresh budget.

### 5.2 The admin ops

| Op                     | Params                  | Does                                                           |
| ---------------------- | ----------------------- | -------------------------------------------------------------- |
| `admin.settings.get`   | none                    | reads the whole configuration                                  |
| `admin.settings.set`   | `{ settings, reason? }` | overrides one or more runtime settings, up to 100 in one write |
| `admin.settings.reset` | `{ keys, reason? }`     | drops overrides and hands the settings back to the environment |

All three answer with the whole configuration as a list of rows. Each editable and read-only field
has a row. The derived `capabilities` has none, since `admin.status` reports it:

| Field         | Meaning                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| `key`         | the `ServerConfig` field                                                         |
| `env`         | the variable that supplies it                                                    |
| `editable`    | whether an admin op can change it                                                |
| `provenance`  | `env` or `admin`: who set the value in force                                     |
| `value`       | the value in force; absent for a secret                                          |
| `configured`  | whether the variable is set in the environment                                   |
| `secret`      | `true` for a field reported only as set or unset                                 |
| `updatedBy`   | the admin who set the override, with `updatedAt`                                 |
| `envValue`    | what the environment supplies for a runtime setting, which a reset would restore |
| `storedValue` | the stored value when a rule holds it back, with `storedReason`                  |

- **Deploy-time fields are listed read-only** with their variable, so one screen answers both "what
  is this set to" and "why can't I change it here".
- **`editable` and `provenance` are separate.** A deploy-time field's value does come from the
  environment, so one three-valued field would make "you may not change this" and "nobody has
  changed this" the same word.
- **Secrets are never echoed.** A secret reports only set or unset. The secrets are `databaseUrl`,
  `mnemonic`, `keyFile`, `keyPassphrase` and the two S3 credentials. Secrecy is a required property
  of every deploy-time field, so a new field can't be added without someone deciding whether an
  admin may see it.
- **A set takes several keys** because the settings constrain each other. Turning places off means
  turning its dependants off in the same signed write. The server validates the whole patch against
  the configuration it would produce before storing any of it.
- **`null` sets a setting to no value**, which differs from a reset. An optional setting such as
  `contact` can then be emptied while the environment still sets it.
- **A multi-key write isn't atomic.** A failure part way leaves some rows written. The coercion in
  §4.1 keeps the served configuration valid, and the server logs which rows landed.
- **The response is rebuilt after every write.** The nonce memo records only the keys, so a replay
  is idempotent and still answers with the current configuration.

A refusal answers `400` with one zod issue per bad key, at the path of that key. Four refusals use
this shape:

- an unknown key;
- a deploy-time key;
- a value the schema refuses;
- a broken prerequisite.

The server refuses to turn `writeLocked` on while a place run is queued or running
([admin API](admin-api.md) §3).

## 7. Limits

- **`mediaMaxBytes` can only be lowered at runtime** (§3.4). Raising it takes a change to the
  environment and a restart.
- **One instance per database.** No change notice runs between processes.
- **The history of changes is the log.** The table records who holds each override now and when it
  was set, and the audit log records each change.
- **`corsOrigins` takes a deploy**, like the other access-control settings (§3.3).
- **Changing `placesCellPrecision` with places stored needs a rebuilt cell index**, and the server
  has no tool for it.
