import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import type { Api } from "./api";
import type { Auth } from "../data/types";
export async function registerPasskey(api: Api) {
  const start = await api.post<{
    challenge_id: string;
    options: { publicKey: PublicKeyCredentialCreationOptionsJSON };
  }>("/api/passkeys/register/start", {});
  const credential = await startRegistration({
    optionsJSON: start.options.publicKey,
  });
  return api.post("/api/passkeys/register/finish", {
    challenge_id: start.challenge_id,
    credential,
  });
}
export async function authenticatePasskey(api: Api, username: string) {
  const start = await api.post<{
    challenge_id: string;
    options: { publicKey: PublicKeyCredentialRequestOptionsJSON };
  }>("/api/passkeys/login/start", { username });
  const credential = await startAuthentication({
    optionsJSON: start.options.publicKey,
  });
  return api.post<Auth>("/api/passkeys/login/finish", {
    challenge_id: start.challenge_id,
    credential,
    device_name: "Chriscord browser passkey",
  });
}
