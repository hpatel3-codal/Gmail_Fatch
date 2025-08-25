// utils/gmailHelpers.ts
import { fetchEmails } from "./gmailClient";

// normalize Gmail: strip + alias
const normalizeGmail = (addr: string) => {
  const lower = (addr || "").trim().toLowerCase();
  if (!lower.includes("@")) return lower;
  const [local, domain] = lower.split("@");
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return `${local.split("+")[0]}@${domain}`;
  }
  return lower;
};

// extract all URLs from text/HTML
function extractLinks(src: string): string[] {
  const urls = new Set<string>();
  const re = /\bhttps?:\/\/[^\s<>"')]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    urls.add(m[0].replace(/[),.;\]\>"']+$/g, "")); // strip common trailing chars
  }
  return [...urls];
}

type WaitOptions = {
  sinceMs?: number;
  unreadOnly?: boolean;
  limit?: number;
  mailbox?: string;
};

/**
 * Return the URL (not body) from the latest matching email.
 */
export async function waitAndExtractUrlByRecipient(
  recipientEmail: string,
  subjectKeyword: string,
  urlKeyword: string,
  timeoutSeconds = 60,
  pollIntervalMs = 3000,
  {
    sinceMs = 24 * 60 * 60 * 1000,
    unreadOnly = false,
    limit = 100,
    mailbox = "INBOX",
  }: WaitOptions = {}
): Promise<string> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const targetRecipient = normalizeGmail(recipientEmail);
  const subjectNeedle = subjectKeyword.toLowerCase();
  const urlNeedle = urlKeyword.toLowerCase();

  while (Date.now() < deadline) {
    const emails: any[] = await fetchEmails({
      mailbox,
      unreadOnly,
      sinceMs,
      limit,
      sortNewestFirst: true,
      subjectContains: subjectKeyword,
    });

    const candidates = emails.filter((e) => {
      const subjectOk = (e.subject ?? "").toLowerCase().includes(subjectNeedle);

      const toAddrs: string[] =
        e.toAddresses?.length
          ? e.toAddresses
          : (e.to as string | undefined)?.split(/[,\s]+/) || [];

      const allAddrs = toAddrs.map((a: string) => normalizeGmail(a));

      const toOk =
        allAddrs.includes(targetRecipient) ||
        (e.to ?? "").toLowerCase().includes(targetRecipient);

      return subjectOk && toOk;
    });

    if (candidates.length) {
      // Pick the latest strictly by received date
      const latest = [...candidates].sort((a, b) => {
        const ai = Number(a.internalDateMs ?? 0);
        const bi = Number(b.internalDateMs ?? 0);
        if (bi !== ai) return bi - ai;
        const ad = a.date ? new Date(a.date).getTime() : 0;
        const bd = b.date ? new Date(b.date).getTime() : 0;
        return bd - ad;
      })[0];

      const body =
        (latest.htmlAsText && String(latest.htmlAsText)) ||
        (latest.text && String(latest.text)) ||
        "";

      const links = extractLinks(body);
      const match = links.find((u) => u.toLowerCase().includes(urlNeedle));

      if (match) return match; // ✅ return URL only
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(
    `Timed out after ${timeoutSeconds}s: no URL containing "${urlKeyword}" found for "${recipientEmail}" with subject containing "${subjectKeyword}".`
  );
}