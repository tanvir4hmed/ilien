/** Explicit privileged setup of a separate shared account. Never sends an invitation. */
import { randomBytes } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const username = process.argv[2],
  publish = process.argv.includes("--publish-config");
if (!username || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username))
  throw new Error("Supply the owner-approved shared account email.");
const directory = resolve(".private");
mkdirSync(directory, { recursive: true });
const stateFile = resolve(directory, "shared-account.private.json"),
  request = resolve(directory, "shared-account-request.private.json"),
  resultFile = resolve(directory, "shared-account-result.private.json");
function cli(command, args, input) {
  const result = spawnSync(command, args, {
    input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `Shared account setup command failed (${command}); output suppressed to protect credentials.`,
    );
  return result.stdout.trim();
}
const pool = cli("terraform", [
  "-chdir=infra/project",
  "output",
  "-raw",
  "operator_pool_id",
]);
const state = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, "utf8"))
  : {
      username,
      pool,
      password: `Aa9!${randomBytes(20).toString("base64url")}`,
      created: false,
      permanent: false,
      bound: false,
    };
if (state.username !== username || state.pool !== pool)
  throw new Error(
    "Existing local setup belongs to a different shared account.",
  );
const save = () =>
  writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
save();
function requestCli(operation, body) {
  writeFileSync(request, JSON.stringify(body), { mode: 0o600 });
  try {
    return cli("aws", [
      "cognito-idp",
      operation,
      "--cli-input-json",
      `file://${request}`,
      "--region",
      "us-east-1",
      "--output",
      "json",
    ]);
  } finally {
    unlinkSync(request);
  }
}
if (!state.created) {
  const user = JSON.parse(
    requestCli("admin-create-user", {
      UserPoolId: pool,
      Username: username,
      TemporaryPassword: state.password,
      MessageAction: "SUPPRESS",
      UserAttributes: [{ Name: "email", Value: username }],
    }),
  );
  state.subject = user.User.Attributes.find((a) => a.Name === "sub").Value;
  state.created = true;
  save();
}
if (!state.permanent) {
  requestCli("admin-set-user-password", {
    UserPoolId: pool,
    Username: username,
    Password: state.password,
    Permanent: true,
  });
  state.permanent = true;
  save();
}
if (!state.bound) {
  writeFileSync(
    request,
    JSON.stringify({
      additionalOperator: { subject: state.subject, role: "admin" },
    }),
    { mode: 0o600 },
  );
  try {
    let success = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = JSON.parse(
        cli("aws", [
          "lambda",
          "invoke",
          "--function-name",
          "ilien-migrate",
          "--payload",
          `fileb://${request}`,
          "--region",
          "us-east-1",
          "--output",
          "json",
          resultFile,
        ]),
      );
      const body = JSON.parse(readFileSync(resultFile, "utf8"));
      if (!result.FunctionError && body.schemaVersion >= 6) {
        success = true;
        break;
      }
      if (
        !["DatabaseResumingException", "DatabaseUnavailableException"].includes(
          body.errorType,
        )
      )
        throw new Error(
          "Workspace membership setup failed; private result retained.",
        );
      await new Promise((r) => setTimeout(r, 30000));
    }
    if (!success)
      throw new Error(
        "Database is not ready. Resume this same setup after checking readiness.",
      );
    state.bound = true;
    save();
  } finally {
    unlinkSync(request);
  }
  if (existsSync(resultFile)) unlinkSync(resultFile);
}
if (publish) {
  cli("gh", [
    "variable",
    "set",
    "GUEST_USERNAME",
    "--env",
    "ilien",
    "--body",
    username,
  ]);
  cli(
    "gh",
    ["secret", "set", "GUEST_PASSWORD", "--env", "ilien"],
    state.password,
  );
  console.log(
    "Shared account configured; GitHub deployment inputs updated. Run delivery to publish the guest controls.",
  );
} else
  console.log(
    "Shared full-access account configured. No credentials printed or invitation sent.",
  );
