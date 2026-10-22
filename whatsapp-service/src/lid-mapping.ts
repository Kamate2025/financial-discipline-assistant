/** Identity helpers based on the fields and events exposed by Baileys 6.7.24. */

export interface LidMappingStore {
  getPhoneJid(lidJid: string): string | null;
  addPhoneNumberShare(lidJid: string, phoneJid: string): boolean;
}

export interface IncomingSenderKey {
  remoteJid?: unknown;
  remoteJidAlt?: unknown;
  participant?: unknown;
  participantAlt?: unknown;
  addressingMode?: unknown;
  senderPn?: unknown;
  senderLid?: unknown;
  participantPn?: unknown;
  participantLid?: unknown;
}

export interface SenderResolution {
  phoneJid: string | null;
  replyJid: string | null;
  isLid: boolean;
  alternatePhonePresent: boolean;
  mappingFound: boolean;
  mappingStoreAvailable: boolean;
  resolutionSource: "remote_phone_jid" | "sender_pn" | "alternate_phone_jid" | "phone_share_store" | null;
  reason: "resolved" | "unmapped_lid" | "unsupported_sender" | "group_or_broadcast";
}

export function normalizePhoneJid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\+?\d{7,20})(?::\d+)?@s\.whatsapp\.net$/);
  return match ? `${match[1].replace(/^\+/, "")}@s.whatsapp.net` : null;
}

export function normalizeLidJid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^\d+(?::\d+)?@lid$/.test(value) ? value.replace(/:\d+@/, "@") : null;
}

/**
 * Baileys v6 exposes direct PN metadata on WAMessageKey.senderPn and
 * chats.phoneNumberShare events. Numeric LID localparts are never identities.
 */
export class Baileys6LidMappingStore implements LidMappingStore {
  private readonly phoneByLid = new Map<string, string>();

  getPhoneJid(lidJid: string): string | null {
    const lid = normalizeLidJid(lidJid);
    return lid ? this.phoneByLid.get(lid) || null : null;
  }

  addPhoneNumberShare(lidJid: string, phoneJid: string): boolean {
    const lid = normalizeLidJid(lidJid);
    const phone = normalizePhoneJid(phoneJid);
    if (!lid || !phone) return false;
    const existing = this.phoneByLid.get(lid);
    if (existing && existing !== phone) return false;
    this.phoneByLid.set(lid, phone);
    return true;
  }
}

export function resolveIncomingSender(
  key: IncomingSenderKey | null | undefined,
  mappingStore?: LidMappingStore | null,
): SenderResolution {
  const mappingStoreAvailable = Boolean(mappingStore);
  const unresolved = (reason: SenderResolution["reason"], isLid = false, alternatePhonePresent = false): SenderResolution => ({
    phoneJid: null,
    replyJid: null,
    isLid,
    alternatePhonePresent,
    mappingFound: false,
    mappingStoreAvailable,
    resolutionSource: null,
    reason,
  });
  if (!key || typeof key !== "object") return unresolved("unsupported_sender");

  const remote = typeof key.remoteJid === "string" ? key.remoteJid : "";
  if (/@g\.us$|@broadcast$|@newsletter$/.test(remote)) return unresolved("group_or_broadcast");

  const remotePhone = normalizePhoneJid(key.remoteJid);
  if (remotePhone) {
    return {
      phoneJid: remotePhone, replyJid: remotePhone, isLid: false,
      alternatePhonePresent: false, mappingFound: true, mappingStoreAvailable,
      resolutionSource: "remote_phone_jid",
      reason: "resolved",
    };
  }

  const remoteLid = normalizeLidJid(key.remoteJid);
  if (!remoteLid) return unresolved("unsupported_sender");

  // senderPn is the supported v6 WAMessageKey field. remoteJidAlt is
  // accepted only as a validated runtime field because some v6 builds add it.
  const alternatePhone = normalizePhoneJid(key.senderPn) || normalizePhoneJid(key.remoteJidAlt);
  if (alternatePhone) {
    return {
      phoneJid: alternatePhone, replyJid: alternatePhone, isLid: true,
      alternatePhonePresent: true, mappingFound: true, mappingStoreAvailable,
      resolutionSource: normalizePhoneJid(key.senderPn) ? "sender_pn" : "alternate_phone_jid",
      reason: "resolved",
    };
  }

  const mappedPhone = mappingStore?.getPhoneJid(remoteLid) || null;
  if (mappedPhone && normalizePhoneJid(mappedPhone)) {
    return {
      phoneJid: normalizePhoneJid(mappedPhone), replyJid: remoteLid, isLid: true,
      alternatePhonePresent: false, mappingFound: true, mappingStoreAvailable,
      resolutionSource: "phone_share_store",
      reason: "resolved",
    };
  }
  return unresolved("unmapped_lid", true, Boolean(key.senderPn || key.remoteJidAlt));
}
