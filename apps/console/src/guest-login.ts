import { node } from "./journey.js";
export type GuestConfig = { username: string; password: string };
export function guestLogin(
  parent: HTMLElement,
  guest: GuestConfig,
  clientId: string,
  authenticated: (accessToken: string, expiresIn: number) => Promise<void>,
) {
  const section = node("section", "", "guest-login"),
    intro = node(
      "p",
      "Shared full-access workspace account. Choose it, then click Log in.",
      "muted",
    ),
    use = node("button", "Use guest account", "primary"),
    form = node("form"),
    email = node("input"),
    password = node("input"),
    eye = node("button", "👁"),
    feedback = node("p", "", "muted"),
    login = node("button", "Log in", "primary");
  use.type = "button";
  form.hidden = true;
  email.type = "email";
  email.autocomplete = "username";
  email.required = true;
  password.type = "password";
  password.autocomplete = "current-password";
  password.required = true;
  eye.type = "button";
  eye.setAttribute("aria-label", "Show password");
  eye.title = "Show password";
  eye.setAttribute("aria-pressed", "false");
  const line = node("div", "", "password-line");
  line.append(password, eye);
  const emailLabel = node("label", "Email"),
    passwordLabel = node("label", "Password");
  emailLabel.append(email);
  passwordLabel.append(line);
  const copies = node("div", "", "row");
  function copy(label: string, value: () => string) {
    const b = node("button", label);
    b.type = "button";
    b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(value());
        feedback.textContent = "Copied.";
      } catch {
        feedback.textContent =
          "Clipboard access is unavailable. Select and copy the field manually.";
      }
    };
    copies.append(b);
  }
  copy("Copy email", () => email.value);
  copy("Copy password", () => password.value);
  eye.onclick = () => {
    const visible = password.type === "password";
    password.type = visible ? "text" : "password";
    eye.setAttribute("aria-label", visible ? "Hide password" : "Show password");
    eye.title = visible ? "Hide password" : "Show password";
    eye.setAttribute("aria-pressed", String(visible));
  };
  use.onclick = () => {
    challenge = undefined;
    mfa.hidden = true;
    code.required = false;
    code.value = "";
    form.hidden = false;
    email.value = guest.username;
    password.value = guest.password;
    feedback.textContent = "Guest account selected. Click Log in to continue.";
    login.focus();
  };
  feedback.setAttribute("role", "status");
  login.type = "submit";
  const mfa = node("div"),
    code = node("input"),
    codeLabel = node("label", "Authenticator code");
  code.inputMode = "numeric";
  code.autocomplete = "one-time-code";
  code.pattern = "[0-9]{6}";
  code.maxLength = 6;
  codeLabel.append(code);
  mfa.append(codeLabel);
  mfa.hidden = true;
  let challenge: { session: string; username: string } | undefined;
  async function cognito(target: string, payload: unknown) {
    const response = await fetch(
      "https://cognito-idp.us-east-1.amazonaws.com/",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-amz-json-1.1",
          "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`,
        },
        body: JSON.stringify(payload),
        credentials: "omit",
        cache: "no-store",
      },
    );
    const data = await response.json();
    if (!response.ok) {
      const name = String(data.__type ?? "")
        .split("#")
        .pop();
      const messages: Record<string, string> = {
        NotAuthorizedException: "Email or password was not accepted.",
        UserNotFoundException: "Email or password was not accepted.",
        TooManyRequestsException:
          "Too many attempts. Please wait and try again.",
        CodeMismatchException:
          "The authenticator code was not accepted. Try the current code.",
        ExpiredCodeException:
          "The code expired. Enter the current authenticator code.",
        PasswordResetRequiredException:
          "This account needs a password reset. Use your own account sign-in or contact the administrator.",
      };
      throw new Error(
        messages[name ?? ""] ??
          "Sign-in could not complete. Please try again or use your own account sign-in.",
      );
    }
    return data;
  }
  form.onsubmit = (event) => {
    event.preventDefault();
    void (async () => {
      login.disabled = true;
      feedback.textContent = "Signing in…";
      try {
        const data = challenge
          ? await cognito("RespondToAuthChallenge", {
              ClientId: clientId,
              ChallengeName: "SOFTWARE_TOKEN_MFA",
              Session: challenge.session,
              ChallengeResponses: {
                USERNAME: challenge.username,
                SOFTWARE_TOKEN_MFA_CODE: code.value.trim(),
              },
            })
          : await cognito("InitiateAuth", {
              ClientId: clientId,
              AuthFlow: "USER_PASSWORD_AUTH",
              AuthParameters: {
                USERNAME: email.value.trim(),
                PASSWORD: password.value,
              },
            });
        if (data.AuthenticationResult?.AccessToken) {
          const result = data.AuthenticationResult;
          if (typeof result.ExpiresIn !== "number" || result.ExpiresIn <= 30)
            throw new Error("Sign-in response was incomplete. Please retry.");
          password.value = "";
          code.value = "";
          await authenticated(result.AccessToken, result.ExpiresIn);
          return;
        }
        if (data.ChallengeName === "SOFTWARE_TOKEN_MFA" && data.Session) {
          challenge = {
            session: data.Session,
            username:
              data.ChallengeParameters?.USER_ID_FOR_SRP ??
              data.ChallengeParameters?.USERNAME ??
              email.value.trim(),
          };
          mfa.hidden = false;
          code.required = true;
          code.focus();
          feedback.textContent =
            "Enter your authenticator code and click Log in.";
          return;
        }
        throw new Error(
          "This account needs an additional setup step. Use your own account sign-in to complete it.",
        );
      } catch (error) {
        feedback.textContent =
          error instanceof Error ? error.message : "Sign-in failed.";
      } finally {
        login.disabled = false;
      }
    })();
  };
  form.append(emailLabel, passwordLabel, copies, mfa, login, feedback);
  section.append(node("h2", "Guest access"), intro, use, form);
  parent.append(section);
}
