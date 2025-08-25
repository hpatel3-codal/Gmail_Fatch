import "dotenv/config";
import { ImapFlow } from "imapflow";

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST ?? "imap.gmail.com",
    port: Number(process.env.IMAP_PORT ?? 993),
    secure: true,
    auth: {
      user: process.env.GMAIL_USER!,
      pass: (process.env.GMAIL_PASS ?? "").replace(/\s+/g, ""),
    },
    // logger: true, // temporary: see AUTH/SELECT/NO messages
  });

  try {
    await client.connect();
    const open = await client.mailboxOpen("INBOX");
    console.log("Connected. INBOX messages:", open.exists);
  } catch (e: any) {
    console.error("Connect failed:", e?.response || e?.message || e);
  } finally {
    await client.logout().catch(() => {});
  }
})();
