// utils/gmailClient.ts
// Gmail IMAP client using imapflow + mailparser.
// Notes:
// - Use a Google App Password (NOT your normal Gmail password).
// - Enable IMAP in Gmail (Settings → See all settings → Forwarding and POP/IMAP).
// - Prefer running IMAP tests serially to avoid Gmail connection limits.

import "dotenv/config";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { Readable } from "stream";

// ---------- Types ----------

export type EmailFilter = {
  mailbox?: string; // default: "INBOX" (uppercase)
  unreadOnly?: boolean; // default: false
  fromContains?: string;
  subjectContains?: string;
  bodyIncludes?: string;
  sinceMs?: number; // e.g., 24 * 60 * 60_000 for last 24h
  limit?: number; // default: 20 (client-side)
  includeAttachments?: boolean; // default: false
  markSeen?: boolean; // default: false
  sortNewestFirst?: boolean; // default: true
};

export type EmailLite = {
  uid: number;
  date?: Date;
  from?: string;
  to?: string;                 // human-readable To header, e.g. "Name <a@b.com>, c@d.com"
  toAddresses?: string[];
  subject?: string;
  text?: string;
  htmlAsText?: string;
  snippet?: string;
  attachments?: {
    filename?: string;
    contentType?: string;
    size?: number;
    content?: Buffer; // populated when includeAttachments=true
  }[];
};

// ---------- Helpers ----------

function assertEnv() {
  const miss = ["GMAIL_USER", "GMAIL_PASS"].filter((k) => !process.env[k]);
  if (miss.length) {
    throw new Error(
      `Missing env: ${miss.join(", ")}.
Enable IMAP in Gmail and use a Google App Password (not your normal password).`
    );
  }
}

// App Passwords are often pasted with spaces; strip them defensively.
function normalizeAppPassword(p: string) {
  return p.replace(/\s+/g, "");
}

function buildClient() {
  assertEnv();
  const host = process.env.IMAP_HOST ?? "imap.gmail.com";
  const port = Number(process.env.IMAP_PORT ?? 993);
  const user = process.env.GMAIL_USER!;
  console.log("Using Gmail user:", user); // Log the user to confirm
  const pass = normalizeAppPassword(process.env.GMAIL_PASS!);

  return new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass },
    logger: false, // set true while diagnosing to see LOGIN/SELECT/SEARCH
  });
}

/** Buffer/Readable → Buffer */
async function toBuffer(input: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(input)) return input;
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Optional: list all available mailbox paths (labels) for diagnostics. */
export async function listMailboxes(): Promise<string[]> {
  const client = buildClient();
  await client.connect();
  const names: string[] = [];
  try {
    for await (const box of await client.list()) names.push(box.path);
    return names;
  } finally {
    await client.logout().catch(() => { });
  }
}

// ---------- Main API ----------

/**
 * Fetch a list of emails from Gmail based on filters.
 * Returns simplified EmailLite objects.
 */
export async function fetchEmails(filter: EmailFilter = {}): Promise<EmailLite[]> {
  const {
    mailbox = "INBOX", // must be uppercase for Gmail
    unreadOnly = false,
    fromContains,
    subjectContains,
    bodyIncludes,
    sinceMs,
    limit = 20,
    includeAttachments = false,
    markSeen = false,
    sortNewestFirst = true,
  } = filter;

  const client = buildClient();

  // Connect (surface clear tips if it fails)
  await client.connect().catch((err) => {
    const tips =
      "• Use a Google App Password and enable IMAP in Gmail settings.\n" +
      "• Ensure imap.gmail.com:993 is reachable from the runner.\n" +
      "• Run IMAP tests serially to avoid connection limits.";
    throw new Error(`IMAP connect failed: ${err?.message}\n${tips}`);
  });

  try {
    // Verify mailbox exists; avoids locale/case surprises.
    const available: string[] = [];
    for await (const box of await client.list()) available.push(box.path);
    if (!available.includes(mailbox)) {
      throw new Error(`Mailbox "${mailbox}" does not exist. Available: ${available.join(", ")}`);
    }

    // Open read-only unless we actually plan to markSeen
    await client.mailboxOpen(mailbox, { readOnly: !markSeen });

    // -------- Robust server-side search with retries --------
    const searchQuery: Record<string, any> = {};
    if (unreadOnly) searchQuery.seen = false;

    let sinceDate: Date | undefined;
    if (sinceMs) {
      sinceDate = new Date(Date.now() - sinceMs);
      // IMAP SINCE is date-based (ignores time); log to verify what we're sending
      searchQuery.since = sinceDate;
    }

    // Attempt 1: as requested
    let uids = await client.search(searchQuery, { uid: true });
    let uidsArr: number[] = Array.isArray(uids) ? uids : [];

    // Attempt 2: if nothing and we used SINCE, retry without SINCE
    if (uidsArr.length === 0 && sinceDate) {
      const retryNoSince: Record<string, any> = {};
      if (unreadOnly) retryNoSince.seen = false;

      const retryUids = await client.search(retryNoSince, { uid: true });
      const retryArr: number[] = Array.isArray(retryUids) ? retryUids : [];
      console.warn(
        `Retry w/o SINCE found ${retryArr.length} emails (unreadOnly=${unreadOnly}). ` +
        `SINCE may have excluded messages due to timezone/date semantics.`
      );

      if (retryArr.length > 0) uidsArr = retryArr;
    }

    // Attempt 3: if still nothing and unreadOnly was true, retry without unreadOnly
    if (uidsArr.length === 0 && unreadOnly) {
      const retryAll: Record<string, any> = {};
      const retryAllUids = await client.search(retryAll, { uid: true });
      const retryAllArr: number[] = Array.isArray(retryAllUids) ? retryAllUids : [];
      console.warn(
        `Retry w/o unreadOnly found ${retryAllArr.length} emails. ` +
        `Messages might already be marked as read.`
      );

      if (retryAllArr.length > 0) uidsArr = retryAllArr;
    }

    console.log(`Proceeding with ${uidsArr.length} UID(s) after retries.`);

    // Sort and limit client-side (fetch a bit extra to allow post-filtering)
    const ordered = (sortNewestFirst ? [...uidsArr].reverse() : uidsArr).slice(
      0,
      Math.max(limit * 3, limit)
    );

    const results: EmailLite[] = [];

    for (const uid of ordered) {
      try {
        // Fetch FULL raw message reliably via download('', { uid:true })
        const { content } = await client.download(uid, "", { uid: true });

        if (!content) {
          console.warn(`Skipping email with UID ${uid}: Content is null or undefined.`);
          continue;
        }

        const raw = await toBuffer(content);
        const parsed: any = await simpleParser(raw);

        const fromText = parsed.from?.text ?? "";
        const subject = parsed.subject ?? "";
        const bodyText = (parsed.text ?? parsed.htmlAsText ?? "").toString();
        const toText = parsed.to?.text ?? "";
        const toAddresses = Array.isArray(parsed.to?.value)
          ? parsed.to.value
            .map((v: any) => (v?.address ?? "").toString().trim())
            .filter(Boolean)
          : [];

        // Client-side filters
        const okFrom = fromContains
          ? fromText.toLowerCase().includes(fromContains.toLowerCase())
          : true;
        const okSubject = subjectContains
          ? subject.toLowerCase().includes(subjectContains.toLowerCase())
          : true;
        const okBody = bodyIncludes
          ? bodyText.toLowerCase().includes(bodyIncludes.toLowerCase())
          : true;
        if (!(okFrom && okSubject && okBody)) continue;

        const attachments = (parsed.attachments ?? []).map((a: any) => ({
          filename: a.filename,
          contentType: a.contentType,
          size: a.size,
          content: includeAttachments ? (a.content as Buffer) : undefined,
        }));

        if (markSeen) {
          // Safely attempt to add \Seen; Gmail sometimes delays flag updates.
          try {
            await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true } as any);
          } catch (e) {
            console.warn(`Could not mark UID ${uid} as \\Seen: ${String(e)}`);
          }
        }

        results.push({
          uid,
          date: parsed.date ?? undefined,
          from: fromText,
          to: toText,
          toAddresses,
          subject,
          text: parsed.text ?? undefined,
          htmlAsText: parsed.htmlAsText ?? undefined,
          snippet: bodyText.replace(/\s+/g, " ").trim().slice(0, 200),
          attachments,
        });

        if (results.length >= limit) break;
      } catch (err) {
        console.error(`Failed to process email with UID ${uid}: ${err}`);
      }
    }

    return results;
  } finally {
    // Gracefully handle logout failure
    await client.logout().catch(() => { });
  }
}
