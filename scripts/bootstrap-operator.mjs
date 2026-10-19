/** One-time privileged onboarding. Does not send invitations or sign in as the user. */
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const username = process.argv[2];
if (!username || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username))
  throw new Error("Provide the approved first operator email as the argument.");
const directory = resolve(".private");
mkdirSync(directory, { recursive: true });
const stateFile = resolve(directory, "operator-bootstrap.json"),
  requestFile = resolve(directory, "operator-request.json");
function cli(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      "Privileged onboarding command failed; no secrets were printed. Inspect account readiness before retrying.",
    );
  return result.stdout.trim();
}
const pool = cli("terraform", [
  "-chdir=infra/project",
  "output",
  "-raw",
  "operator_pool_id",
]);
const url = cli("terraform", [
  "-chdir=infra/project",
  "output",
  "-raw",
  "console_url",
]);
const state = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, "utf8"))
  : {
      username,
      pool,
      password: `Aa9!${randomBytes(24).toString("base64url")}`,
      created: false,
      bound: false,
    };
if (state.username !== username || state.pool !== pool)
  throw new Error("Existing onboarding state belongs to a different identity.");
const save = () =>
  writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
save();
if (!state.created) {
  writeFileSync(
    requestFile,
    JSON.stringify({
      UserPoolId: pool,
      Username: username,
      TemporaryPassword: state.password,
      MessageAction: "SUPPRESS",
      UserAttributes: [{ Name: "email", Value: username }],
    }),
    { mode: 0o600 },
  );
  try {
    const user = JSON.parse(
      cli("aws", [
        "cognito-idp",
        "admin-create-user",
        "--cli-input-json",
        `file://${requestFile}`,
        "--region",
        "us-east-1",
        "--output",
        "json",
      ]),
    );
    state.subject = user.User.Attributes.find((x) => x.Name === "sub").Value;
    state.created = true;
    save();
    console.log("Operator identity created with invitation suppressed.");
  } finally {
    unlinkSync(requestFile);
  }
}
if (!state.bound) {
  const payload = resolve(directory, "operator-bind.json"),
    result = resolve(directory, "operator-bind-result.json");
  writeFileSync(
    payload,
    JSON.stringify({ operator: { subject: state.subject } }),
    { mode: 0o600 },
  );
  for (let attempt = 1; attempt <= 10; attempt++) {
    const response = JSON.parse(
      cli("aws", [
        "lambda",
        "invoke",
        "--function-name",
        "ilien-migrate",
        "--payload",
        `fileb://${payload}`,
        "--region",
        "us-east-1",
        "--output",
        "json",
        result,
      ]),
    );
    const data = JSON.parse(readFileSync(result, "utf8"));
    if (!response.FunctionError && data.schemaVersion >= 6) {
      state.bound = true;
      save();
      break;
    }
    if (
      !["DatabaseResumingException", "DatabaseUnavailableException"].includes(
        data.errorType,
      ) ||
      attempt === 10
    )
      throw new Error(
        "Operator membership initialization did not complete. Private result retained; do not rerun account creation.",
      );
    console.log("Database is resuming; retrying membership initialization.");
    await new Promise((resolve) => setTimeout(resolve, 30000));
  }
  unlinkSync(payload);
  unlinkSync(result);
}
writeFileSync(
  resolve(directory, "operator-first-login.txt"),
  `ILIEN first operator login\nURL: ${url}/\nUsername: ${username}\nTemporary password: ${state.password}\n\nChange the temporary password and enroll an authenticator app at first sign-in. No invitation email was sent. The temporary password expires after seven days. Keep this file private and remove it after successful sign-in. Never include it or operator-bootstrap.json in a context archive.\n`,
  { mode: 0o600 },
);
console.log(
  "Initial admin membership configured. Credentials saved to .private/operator-first-login.txt; no sign-in or application test performed.",
);
